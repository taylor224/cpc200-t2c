//! P2 shim: drive the vendor `liblylinkui.so` from Rust the way `lylinkui` does, log every event
//! the library delivers, count video units, relay nothing. Run on the adapter in place of
//! lylinkui (kill `tesla -s` first; the library spawns and supervises lylinkapp itself):
//!
//!   LD_LIBRARY_PATH=/mnt/customer/app/ui /tmp/lyshim [--w 768 --h 608 --mmw 149 --mmh 124]
//!       [--fps 0] [--pixel 0] [--fun 0x512] [--flags 0x2910] [--name Auto] [--secs 60]
//!
//! Structure and values from lylinkui's `func_13d4c` (NOTES › CarPlay session size) and the boot
//! log line `lylinkapi_start|24:fun:512, flags:2910`; the callback is `cb(type, int, ptr)` with
//! type 1..29 (lylinkui's dispatcher subtracts 1 and switches on 0..28); 15 = (len, unit).

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[repr(C)]
struct LyStart {
    width: u16,       // +0x00
    height: u16,      // +0x02
    pixel: u32,       // +0x04  g+0x45a (byte) -- preset 0..3?
    mode: u32,        // +0x08  2
    callback: Option<extern "C" fn(c_int, c_int, *mut c_void) -> c_int>, // +0x0c  cb(type, int, ptr)
    mm_w: u16,        // +0x10
    mm_h: u16,        // +0x12
    fps: u32,         // +0x14  g+0x450
    fun: u32,         // +0x18  0x512 when g+0x2f8 > 0 ("fun" in the log)
    name: [c_char; 32], // +0x1c  car icon name, "Auto" (g+0x46c), file app/Auto.png
    flags: u32,       // +0x3c  0x2910 (bit 7 would mean +0x44 is an os-ops table)
    r40: u32,         // +0x40
    os_ops: *mut c_void, // +0x44
    r48: u32,         // +0x48
}
const _: () = assert!(std::mem::size_of::<LyStart>() == 76);

#[link(name = "lylinkui")]
extern "C" {
    fn lylinkapi_start(p: *mut LyStart) -> c_int;
    fn lylinkapi_stop() -> c_int;
    fn lylinkapi_free(p: *mut c_void) -> c_int;
    fn lylinkapi_cmd(id: c_int) -> c_int;
    fn lylinkapi_wifi(p: *mut LyWifi) -> c_int;
    /// touch(0, m, x, y): m 0 down / 2 move / 1 up, x and y scaled 0..1000 (lylinkui: px*1000/w)
    fn lylinkapi_touch(zero: c_int, m: c_int, x: c_int, y: c_int) -> c_int;
    /// key(code, 0) then key(code, 1) is a press (lylinkui: 0x300, 0x600, 0x601)
    fn lylinkapi_key(code: c_int, updown: c_int) -> c_int;
}

extern "C" {
    fn sigaction(sig: c_int, act: *const SigAction, old: *mut SigAction) -> c_int;
    fn _exit(code: c_int) -> !;
    fn write(fd: c_int, buf: *const c_void, n: usize) -> isize;
}

/// `lylinkapi_wifi` argument, 196 bytes, as lylinkui's `func_152e4` builds it: type 6 = "here is the
/// hotspot", the wpa_ctrl socket path at +8 ("/var/run/hostapd/wlan0" -- the library's uiwif thread
/// polls it and logs "<path> not exists, try N" until hostapd is up), the SSID at +0x58, the
/// password at +0xa8 (lylinkui's default is 88888888), a callback pointer at +0xc0 that the
/// library stores at g+0x80 and calls with 1 later. The library strdup()s the strings, keeps the mode byte and forwards the struct to
/// lylinkapp with cmdsvr_sendWifi (the phone learns the hotspot through iAP from it).
#[repr(C)]
struct LyWifi {
    kind: u32,            // +0x00  6
    mode: u32,            // +0x04  0
    ctrl: [c_char; 80],   // +0x08  wpa_ctrl socket path, "/var/run/hostapd/wlan0" (lylinkui copies it from its config)
    ssid: [c_char; 80],   // +0x58  the hotspot name (forwarded to lylinkapp -> iAP -> iPhone)
    psk: [c_char; 24],    // +0xa8
    cb: Option<extern "C" fn(c_int) -> c_int>, // +0xc0
}
const _: () = assert!(std::mem::size_of::<LyWifi>() == 196);

extern "C" fn wifi_cb(a: c_int) -> c_int {
    eprintln!("[{}] wifi callback({})", ts(), a);
    0
}

/// musl/ARM `struct sigaction`: handler, 128-byte mask, flags, restorer.
#[repr(C)]
struct SigAction {
    handler: usize,
    mask: [u32; 32],
    flags: c_int,
    restorer: usize,
}

/// Crash reporter: the vendor library runs on its own threads and a fault there kills the whole
/// process silently (busybox has no gdb, the kernel does not log user faults). Print the signal,
/// the fault address, pc/lr/sp from the ARM sigcontext and the mapping that holds pc, then exit.
extern "C" fn on_fault(sig: c_int, info: *mut c_void, uc: *mut c_void) {
    // siginfo_t: si_signo, si_errno, si_code, si_addr; ucontext_t: uc_flags, uc_link,
    // uc_stack(3 words), sigcontext { trap_no, error_code, oldmask, r0..r10, fp, ip, sp, lr, pc, cpsr, fault_address }
    let (addr, sp, lr, pc) = unsafe {
        let si = info as *const u32;
        let m = (uc as *const u32).add(5 + 3);
        (*si.add(3), *m.add(13), *m.add(14), *m.add(15))
    };
    let mut msg = format!("\n*** signal {} fault_addr={:#x} pc={:#x} lr={:#x} sp={:#x}\n", sig, addr, pc, lr, sp);
    if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
        for l in maps.lines() {
            let mut it = l.splitn(2, '-');
            let lo = u32::from_str_radix(it.next().unwrap_or(""), 16).unwrap_or(0);
            let hi = u32::from_str_radix(it.next().unwrap_or("").split(' ').next().unwrap_or(""), 16).unwrap_or(0);
            let hit = |x: u32| lo <= x && x < hi;
            if hit(pc) || hit(lr) || l.contains("lylink") || l.contains("lyshim") {
                let tag = if hit(pc) { format!(" <= pc+{:#x}", pc - lo) } else if hit(lr) { format!(" <= lr+{:#x}", lr - lo) } else { String::new() };
                msg.push_str(l);
                msg.push_str(&tag);
                msg.push('\n');
            }
        }
    }
    unsafe {
        write(2, msg.as_ptr() as *const c_void, msg.len());
        _exit(128 + sig);
    }
}

fn install_crash_reporter() {
    let act = SigAction { handler: on_fault as extern "C" fn(c_int, *mut c_void, *mut c_void) as usize, mask: [0; 32], flags: 4 /* SA_SIGINFO */, restorer: 0 };
    for sig in [11 /* SEGV */, 7 /* BUS */, 4 /* ILL */, 6 /* ABRT */, 8 /* FPE */] {
        unsafe {
            sigaction(sig, &act, std::ptr::null_mut());
        }
    }
}

/// ssid= and wpa_passphrase= from a hostapd.conf (lylinkui writes /tmp/hostapd.conf at boot).
fn hostapd_conf(path: &str) -> (String, String) {
    let txt = std::fs::read_to_string(path).unwrap_or_default();
    let get = |k: &str| txt.lines().find_map(|l| l.strip_prefix(k)).unwrap_or("").trim().to_string();
    (get("ssid="), get("wpa_passphrase="))
}

static COUNTS: [AtomicU64; 32] = [const { AtomicU64::new(0) }; 32];
static BYTES: AtomicU64 = AtomicU64::new(0);
static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn ts() -> String {
    let t = T0.get().map(|t| t.elapsed()).unwrap_or_default();
    format!("{:6.2}", t.as_secs_f64())
}

/// Event types as lylinkui's dispatcher (`func_14250`, jump table at 0x1426c, case = type - 1) names
/// them in its log strings. The library calls `cb(type, a1, a2)` with a1 an integer and a2 a
/// pointer: unit/spspps = (len, data); APP_VERSION = (errcode, "V2.xx.00"); LINK_* = (flag, 0).
fn name(t: c_int) -> &'static str {
    match t {
        1 => "LINK_ESTABLISH",
        2 => "LINK_DISCONN",
        3 => "PHONE_CONNECT",
        4 => "PHONE_DISCONN",
        5 => "FOREGROUND",
        6 => "BACKGROUND",
        7 => "VIDEO_START",
        8 => "VIDEO_STOP",
        9 => "AUDIO_START",
        10 => "AUDIO_STOP",
        11 => "RECORD_START",
        12 => "RECORD_STOP",
        13 => "RECORD_INIT",
        14 => "SPSPPS",
        15 => "VIDEO_UNIT",
        18 => "APP_VERSION",
        21..=24 => "BUF_FREE",
        27 => "BT_GOCSDK",
        29 => "TIME",
        16 | 25 | 28 => "nop",
        _ => "?",
    }
}

extern "C" fn cb(t: c_int, a1: c_int, a2: *mut c_void) -> c_int {
    let i = (t.max(0) as usize).min(31);
    let n = COUNTS[i].fetch_add(1, Ordering::Relaxed) + 1;
    match t {
        14 | 15 => {
            // (len, data): H.264 access unit (15) or the SPS/PPS set (14); lylinkui copies the bytes
            // into its own queue (func_1327c: malloc+memcpy) and never frees `data` -- the library owns it
            let len = a1.max(0) as usize;
            if t == 15 {
                BYTES.fetch_add(len as u64, Ordering::Relaxed);
            }
            if t == 14 || n <= 3 || n % 300 == 0 {
                let head: Vec<u8> = if !a2.is_null() && len > 0 {
                    unsafe { std::slice::from_raw_parts(a2 as *const u8, len.min(8)).to_vec() }
                } else {
                    vec![]
                };
                eprintln!("[{}] {} #{} len={} head={:02x?}", ts(), name(t), n, len, head);
            }
            0
        }
        18 => {
            let ver = if a2.is_null() { String::new() } else { unsafe { CStr::from_ptr(a2 as *const c_char) }.to_string_lossy().into_owned() };
            eprintln!("[{}] event type=18 APP_VERSION errcode={} version={} #{}", ts(), a1, ver, n);
            0
        }
        21..=24 => {
            // lylinkui's handler is just lylinkapi_free(a2)
            if !a2.is_null() {
                unsafe { lylinkapi_free(a2) };
            }
            eprintln!("[{}] event type={} BUF_FREE a1={} freed {:p} #{}", ts(), t, a1, a2, n);
            0
        }
        _ => {
            // a2 may be a string (LINK_*/PHONE_* carry a name) or a small struct (VIDEO_START %dx%d)
            let text = if a2.is_null() {
                String::new()
            } else {
                let s = unsafe { std::slice::from_raw_parts(a2 as *const u8, 16) };
                let strlen = s.iter().position(|&b| b == 0).unwrap_or(16);
                if strlen > 0 && s[..strlen].iter().all(|&b| (0x20..0x7f).contains(&b)) {
                    format!("str={:?}", String::from_utf8_lossy(&s[..strlen]))
                } else {
                    let w: Vec<u32> = s.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                    format!("words={:x?}", w)
                }
            };
            eprintln!("[{}] event type={} {} a1={} #{} {}", ts(), t, name(t), a1, n, text);
            0
        }
    }
}

fn main() {
    let mut a = std::env::args().skip(1);
    let (mut w, mut h, mut mmw, mut mmh) = (768u16, 608u16, 149u16, 124u16);
    let (mut fps, mut pixel, mut fun, mut flags, mut secs) = (0u32, 0u32, 0x512u32, 0x2910u32, 60u64);
    let mut path = String::from("Auto");
    let (mut ssid, mut psk, mut wifi) = (String::new(), String::new(), true);
    let mut conf = String::from("/tmp/hostapd.conf");
    let mut acts: Vec<(u64, String)> = Vec::new(); // --act SEC:touch:X:Y | SEC:key:CODE | SEC:cmd:ID
    while let Some(k) = a.next() {
        let v = a.next().unwrap_or_default();
        let num = |s: &str| -> u64 {
            if let Some(x) = s.strip_prefix("0x") { u64::from_str_radix(x, 16).unwrap_or(0) } else { s.parse().unwrap_or(0) }
        };
        match k.as_str() {
            "--w" => w = num(&v) as u16,
            "--h" => h = num(&v) as u16,
            "--mmw" => mmw = num(&v) as u16,
            "--mmh" => mmh = num(&v) as u16,
            "--fps" => fps = num(&v) as u32,
            "--pixel" => pixel = num(&v) as u32,
            "--fun" => fun = num(&v) as u32,
            "--flags" => flags = num(&v) as u32,
            "--secs" => secs = num(&v),
            "--name" => path = v,
            "--ssid" => ssid = v,
            "--psk" => psk = v,
            "--hostapd-conf" => conf = v,
            "--wifi" => wifi = num(&v) != 0,
            "--act" => {
                let (sec, rest) = v.split_once(':').unwrap_or(("0", ""));
                acts.push((num(sec), rest.to_string()));
            }
            _ => {
                eprintln!("unknown option {}", k);
                std::process::exit(2);
            }
        }
    }
    let _ = T0.set(Instant::now());
    install_crash_reporter();
    let mut p = LyStart {
        width: w, height: h, pixel, mode: 2, callback: Some(cb), mm_w: mmw, mm_h: mmh, fps, fun,
        name: [0; 32], flags, r40: 0, os_ops: std::ptr::null_mut(), r48: 0,
    };
    for (i, b) in path.bytes().take(31).enumerate() {
        p.name[i] = b as c_char;
    }
    eprintln!("[{}] lylinkapi_start {}x{} {}x{}mm fps={} pixel={} fun={:#x} flags={:#x} name={}", ts(), w, h, mmw, mmh, fps, pixel, fun, flags, path);
    let rc = unsafe { lylinkapi_start(&mut p) };
    eprintln!("[{}] lylinkapi_start -> {}", ts(), rc);
    if wifi {
        let (cs, cp) = hostapd_conf(&conf);
        if ssid.is_empty() {
            ssid = cs;
        }
        if psk.is_empty() {
            psk = cp;
        }
        let mut wf = LyWifi { kind: 6, mode: 0, ctrl: [0; 80], ssid: [0; 80], psk: [0; 24], cb: Some(wifi_cb) };
        for (i, b) in b"/var/run/hostapd/wlan0".iter().enumerate() {
            wf.ctrl[i] = *b as c_char;
        }
        for (i, b) in ssid.bytes().take(79).enumerate() {
            wf.ssid[i] = b as c_char;
        }
        for (i, b) in psk.bytes().take(23).enumerate() {
            wf.psk[i] = b as c_char;
        }
        let rc = unsafe { lylinkapi_wifi(&mut wf) };
        eprintln!("[{}] lylinkapi_wifi ssid={:?} psk_len={} -> {}", ts(), ssid, psk.len(), rc);
    }
    let end = Instant::now() + Duration::from_secs(secs);
    let mut last = 0u64;
    acts.sort();
    let mut next_act = 0usize;
    while Instant::now() < end {
        let tick = Instant::now() + Duration::from_secs(5);
        while Instant::now() < tick {
            if let Some((sec, what)) = acts.get(next_act) {
                if T0.get().map(|t| t.elapsed().as_secs()).unwrap_or(0) >= *sec {
                    let f: Vec<&str> = what.split(':').collect();
                    let num = |i: usize| f.get(i).and_then(|s| if let Some(x) = s.strip_prefix("0x") { i64::from_str_radix(x, 16).ok() } else { s.parse::<i64>().ok() }).unwrap_or(0) as c_int;
                    let rc = unsafe {
                        match f[0] {
                            "touch" => {
                                let r = lylinkapi_touch(0, 0, num(1), num(2));
                                std::thread::sleep(Duration::from_millis(80));
                                lylinkapi_touch(0, 1, num(1), num(2));
                                r
                            }
                            "key" => {
                                let r = lylinkapi_key(num(1), 0);
                                std::thread::sleep(Duration::from_millis(80));
                                lylinkapi_key(num(1), 1);
                                r
                            }
                            "cmd" => lylinkapi_cmd(num(1)),
                            _ => -99,
                        }
                    };
                    eprintln!("[{}] act {} -> {}", ts(), what, rc);
                    next_act += 1;
                    continue;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let units = COUNTS[15].load(Ordering::Relaxed);
        let others: Vec<String> = (0..32).filter(|&i| i != 15 && COUNTS[i].load(Ordering::Relaxed) > 0).map(|i| format!("{}:{}", i, COUNTS[i].load(Ordering::Relaxed))).collect();
        eprintln!("[{}] units={} (+{} in 5 s, {} KB total) events {}", ts(), units, units - last, BYTES.load(Ordering::Relaxed) / 1024, others.join(" "));
        last = units;
    }
    eprintln!("[{}] lylinkapi_stop", ts());
    let rc = unsafe { lylinkapi_stop() };
    eprintln!("[{}] lylinkapi_stop -> {}; cmd ids used by lylinkui: 2,3,12 (not sent)", ts(), rc);
}
