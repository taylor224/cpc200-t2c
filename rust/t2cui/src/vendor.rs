//! The vendor CarPlay stack behind `Backend`: liblylinkui.so (+ server/mw/pcm/log) in-process,
//! exactly as the P2 shim (rust/lyshim) exercised it. Only built for the adapter (ARM Linux).

#![allow(non_camel_case_types)]

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};

use crate::session::{Backend, Event, SessionParams};

#[repr(C)]
struct LyStart {
    width: u16,
    height: u16,
    pixel: u32,
    mode: u32,
    callback: Option<extern "C" fn(c_int, c_int, *mut c_void) -> c_int>,
    mm_w: u16,
    mm_h: u16,
    fps: u32,
    fun: u32,
    name: [c_char; 32],
    flags: u32,
    r40: u32,
    os_ops: *mut c_void,
    r48: u32,
}
const _: () = assert!(std::mem::size_of::<LyStart>() == 76);

#[repr(C)]
struct LyWifi {
    kind: u32,            // 6 = hotspot credentials
    mode: u32,            // 0
    ctrl: [c_char; 80],   // +0x08 wpa_ctrl socket path "/var/run/hostapd/wlan0" (the library's uiwif thread polls it)
    ssid: [c_char; 80],   // +0x58 hotspot name (lylinkapp -> iAP -> iPhone)
    psk: [c_char; 24],    // +0xa8
    cb: Option<extern "C" fn(c_int) -> c_int>,
}
const _: () = assert!(std::mem::size_of::<LyWifi>() == 196);

#[link(name = "lylinkui")]
extern "C" {
    fn lylinkapi_start(p: *mut LyStart) -> c_int;
    fn lylinkapi_stop() -> c_int;
    fn lylinkapi_cmd(id: c_int) -> c_int;
    fn lylinkapi_wifi(p: *mut LyWifi) -> c_int;
    fn lylinkapi_touch(zero: c_int, m: c_int, x: c_int, y: c_int) -> c_int;
    fn lylinkapi_key(code: c_int, updown: c_int) -> c_int;
    fn lylinkapi_free(p: *mut c_void) -> c_int;
}

extern "C" {
    fn sigaction(sig: c_int, act: *const SigAction, old: *mut SigAction) -> c_int;
    fn _exit(code: c_int) -> !;
    fn write(fd: c_int, buf: *const c_void, n: usize) -> isize;
}

#[repr(C)]
struct SigAction {
    handler: usize,
    mask: [u32; 32],
    flags: c_int,
    restorer: usize,
}

static SENDER: OnceLock<Mutex<Sender<Event>>> = OnceLock::new();

fn send(ev: Event) {
    if let Some(m) = SENDER.get() {
        if let Ok(tx) = m.lock() {
            let _ = tx.send(ev);
        }
    }
}

fn cstr_at(p: *mut c_void) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(p as *const c_char) }.to_string_lossy().into_owned()
}

fn copy(p: *mut c_void, len: c_int) -> std::sync::Arc<Vec<u8>> {
    let n = len.max(0) as usize;
    let v = if p.is_null() || n == 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(p as *const u8, n) }.to_vec() };
    std::sync::Arc::new(v)
}

/// The library's IPC thread calls this: copy what we need into the event channel and return.
extern "C" fn cb(t: c_int, a1: c_int, a2: *mut c_void) -> c_int {
    match t {
        1 => send(Event::LinkUp),
        2 => send(Event::LinkDown),
        3 => send(Event::PhoneConnect(cstr_at(a2))),
        4 => send(Event::PhoneDisconnect),
        5 => send(Event::Foreground),
        6 => send(Event::Background),
        7 => {
            let (w, h) = if a2.is_null() {
                (0, 0)
            } else {
                let v = unsafe { *(a2 as *const u32) };
                ((v & 0xffff) as u16, (v >> 16) as u16)
            };
            send(Event::VideoStart(w, h));
        }
        8 => send(Event::VideoStop),
        14 => send(Event::SpsPps(copy(a2, a1))),
        15 => send(Event::Unit(copy(a2, a1))),
        18 => send(Event::AppVersion(cstr_at(a2))),
        21..=24 => {
            if !a2.is_null() {
                unsafe { lylinkapi_free(a2) };
            }
        }
        27 => {
            let n = a1.max(0) as usize;
            let s = if a2.is_null() { String::new() } else { String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(a2 as *const u8, n.min(512)) }).into_owned() };
            send(Event::Bt(s));
        }
        _ => send(Event::Other(t, a1)),
    }
    0
}

extern "C" fn wifi_cb(_a: c_int) -> c_int {
    0
}

extern "C" fn on_fault(sig: c_int, info: *mut c_void, uc: *mut c_void) {
    let (addr, sp, lr, pc) = unsafe {
        let si = info as *const u32;
        let m = (uc as *const u32).add(8);
        (*si.add(3), *m.add(13), *m.add(14), *m.add(15))
    };
    let mut msg = format!("\n*** t2cui signal {} fault_addr={:#x} pc={:#x} lr={:#x} sp={:#x}\n", sig, addr, pc, lr, sp);
    if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
        for l in maps.lines() {
            let mut it = l.splitn(2, '-');
            let lo = u32::from_str_radix(it.next().unwrap_or(""), 16).unwrap_or(0);
            let hi = u32::from_str_radix(it.next().unwrap_or("").split(' ').next().unwrap_or(""), 16).unwrap_or(0);
            let hit = |x: u32| lo <= x && x < hi;
            if hit(pc) || hit(lr) {
                msg.push_str(l);
                msg.push_str(if hit(pc) { " <= pc\n" } else { " <= lr\n" });
            }
        }
    }
    unsafe {
        write(2, msg.as_ptr() as *const c_void, msg.len());
        let _ = std::fs::OpenOptions::new().create(true).append(true).open("/mnt/UDISK/t2c_crash.log").map(|mut f| std::io::Write::write_all(&mut f, msg.as_bytes()));
        _exit(128 + sig);
    }
}

pub fn install_crash_reporter() {
    let act = SigAction { handler: on_fault as extern "C" fn(c_int, *mut c_void, *mut c_void) as usize, mask: [0; 32], flags: 4, restorer: 0 };
    for sig in [11, 7, 4, 6, 8] {
        unsafe {
            sigaction(sig, &act, std::ptr::null_mut());
        }
    }
}

pub struct VendorBackend {
    started: Mutex<bool>,
}

impl VendorBackend {
    pub fn new(tx: Sender<Event>) -> VendorBackend {
        let _ = SENDER.set(Mutex::new(tx));
        VendorBackend { started: Mutex::new(false) }
    }
}

fn fill(dst: &mut [c_char], s: &str) {
    for (i, b) in s.bytes().take(dst.len() - 1).enumerate() {
        dst[i] = b as c_char;
    }
}

impl Backend for VendorBackend {
    fn start(&self, p: &SessionParams) -> i32 {
        // lylinkui func_13d4c: +4 = driver side (lycfg +2), +0x14 = night (0 day / 2 night),
        // flags 0x3910 standard frame rate / 0x2910 "smooth" (FPS key), fun 0x512
        let mut s = LyStart {
            width: p.w,
            height: p.h,
            pixel: p.driver,
            mode: 2,
            callback: Some(cb),
            mm_w: p.mm_w,
            mm_h: p.mm_h,
            fps: if p.night { 2 } else { 0 },
            fun: 0x512,
            name: [0; 32],
            flags: if p.smooth { 0x2910 } else { 0x3910 },
            r40: 0,
            os_ops: std::ptr::null_mut(),
            r48: 0,
        };
        fill(&mut s.name, if p.name.is_empty() { "Auto" } else { &p.name });
        let rc = unsafe { lylinkapi_start(&mut s) };
        *self.started.lock().unwrap_or_else(|e| e.into_inner()) = true;
        rc
    }
    fn stop(&self) {
        let mut g = self.started.lock().unwrap_or_else(|e| e.into_inner());
        if *g {
            // with no client attached lylinkapi_stop SIGILLs (shim round 1); the session layer only
            // restarts after a start, and lylinkapp reconnects within seconds, so this is the normal case
            unsafe { lylinkapi_stop() };
            *g = false;
        }
    }
    fn touch(&self, m: i32, x: i32, y: i32) {
        unsafe { lylinkapi_touch(0, m, x, y) };
    }
    fn key(&self, code: i32) {
        unsafe {
            lylinkapi_key(code, 0);
            std::thread::sleep(std::time::Duration::from_millis(30));
            lylinkapi_key(code, 1);
        }
    }
    fn untake_video(&self) {
        unsafe { lylinkapi_cmd(4) };
    }
    fn take_video(&self) {
        unsafe { lylinkapi_cmd(2) };
    }
    fn disconnect_phone(&self) {
        unsafe { lylinkapi_cmd(12) };
    }
    fn wifi(&self, ssid: &str, psk: &str) {
        let mut w = LyWifi { kind: 6, mode: 0, ctrl: [0; 80], ssid: [0; 80], psk: [0; 24], cb: Some(wifi_cb) };
        fill(&mut w.ctrl, "/var/run/hostapd/wlan0");
        fill(&mut w.ssid, ssid);
        fill(&mut w.psk, psk);
        unsafe { lylinkapi_wifi(&mut w) };
    }
    fn night(&self, _n: i32) {
        // stock KEY_NIGHT: besides the start-struct field (+0x14 = 2, applied by the restart the
        // session layer requests) it calls lylinkapi_cmd(5) so the running session learns it too
        unsafe { lylinkapi_cmd(5) };
    }
    fn bt(&self, _op: &str, _mac: &str) {
        // gocsdk commands go through gocsdk.rs
    }
    fn raw_cmd(&self, id: i32) {
        unsafe { lylinkapi_cmd(id) };
    }
}
