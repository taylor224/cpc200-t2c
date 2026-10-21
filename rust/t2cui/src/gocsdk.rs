//! gocsdk glue: the Bluetooth daemon (`gocsdk -T/dev/ttyS3`) exposes a pty at /dev/goc_serial
//! speaking AT-style lines. Stock lylinkui's `lygoc` module (reverse-engineered 2026-10-19) uses
//! it for the phone's Bluetooth PAN -- the adapter's internet -- and for pairing commands:
//!
//!   -> AT#P0            at open (enable reports); AT#P1 after an `IS1` line
//!   <- IS0 / IS1 / IS2  Bluetooth link state: none / connecting / connected
//!   <- NC               PAN up: run `udhcpc -R -n -b -i bt-pan`, enable ip_forward, flush and
//!                       re-create the nat MASQUERADE out of bt-pan (t2cd re-adds its REDIRECT)
//!   <- ND               PAN "already connected"
//!   -> AT#NC<mac>       ask for the PAN when the phone is connected but no NC came (every 10 s)
//!   <- MX<flag><mac><name>  paired-device report: must be answered with AT#MH or gocsdk repeats
//!                       the whole status block without end (37k lines in 30 s, 2026-10-19)
//!   <- IA               -> AT#MM (stock's reply); IB / MM / MF / PO / JH / ER / IV / NS / NA / SA
//!                       other reports (counted, logged once in a while)
//!   -> AT#CD<mac> / AT#CC<mac>   disconnect / connect a phone (page buttons; forwarded as-is)
//!   -> AT#CV<mac>       forget a phone (gocsdk debonds it and rewrites bt_conf.ini; also takes
//!                       "" = every phone, or one digit = the 1-based index of its MX report, which
//!                       is what stock sends); answered with PR<status><mac>
//!   <- SV / SS          service lines of the connected phone, SV<addr:12><uuid> (its address)
//!
//! Only this process may read the pty (stock lylinkui is not running when t2cui is the UI).
//! lylinkapp keeps its own TCP channel to gocsdk for iAP, untouched.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::log::Logger;

pub const DEV: &str = "/dev/goc_serial";

/// musl/ARM `struct termios`: 4 flag words, c_line, c_cc[32], two speeds (60 bytes).
#[repr(C)]
struct Termios {
    c_iflag: u32,
    c_oflag: u32,
    c_cflag: u32,
    c_lflag: u32,
    c_line: u8,
    c_cc: [u8; 32],
    c_ispeed: u32,
    c_ospeed: u32,
}
const _: () = assert!(std::mem::size_of::<Termios>() == 60);

extern "C" {
    fn tcgetattr(fd: i32, t: *mut Termios) -> i32;
    fn tcsetattr(fd: i32, action: i32, t: *const Termios) -> i32;
    fn cfmakeraw(t: *mut Termios);
}

/// The pty slave comes up in cooked mode with ECHO: everything gocsdk writes to the master would
/// be echoed straight back to it as input, gocsdk answers that with "OK" and its status block, and
/// the loop never ends (1 500 lines/s, 2026-10-19). Raw mode, like stock lylinkui.
fn make_raw(fd: i32) -> bool {
    let mut t = Termios { c_iflag: 0, c_oflag: 0, c_cflag: 0, c_lflag: 0, c_line: 0, c_cc: [0; 32], c_ispeed: 0, c_ospeed: 0 };
    unsafe {
        if tcgetattr(fd, &mut t) != 0 {
            return false;
        }
        cfmakeraw(&mut t);
        tcsetattr(fd, 0, &t) == 0
    }
}

pub struct Gocsdk {
    log: Arc<Logger>,
    port: Mutex<Option<std::fs::File>>,
    pub bt_connected: AtomicBool,
    pub pan_up: AtomicBool,
    pub lines: AtomicU64,
    last_nc_req: Mutex<Option<Instant>>,
    pub last_line: Mutex<String>,
    counts: Mutex<std::collections::BTreeMap<String, u64>>,
    rate: Mutex<(Instant, u64)>,
    pub muted: AtomicBool,
    last_reply: Mutex<Option<Instant>>,
    last_p1: Mutex<Option<Instant>>,
    pub bt_on: AtomicBool,
    pub phone_name: Mutex<String>,
    /// address of the phone on Bluetooth (12 hex, from its SV/SS service lines; bt_conf.ini's
    /// lastaddr until one came): the status JSON's `bt`, which the car page matches against its
    /// paired list (stock sends the address there; a name never matched, so no phone was ever
    /// "Connected" on the page and Connect/Forget of a connected phone went astray -- issue #1)
    pub phone_mac: Mutex<String>,
    /// gocsdk answered a pair-list delete (PR line): the pages get the list again
    pub list_changed: AtomicBool,
}

impl Gocsdk {
    pub fn start(log: Arc<Logger>) -> Option<Arc<Gocsdk>> {
        if !std::path::Path::new(DEV).exists() {
            log.dbg("gocsdk: no /dev/goc_serial here");
            return None;
        }
        let g = Arc::new(Gocsdk {
            log,
            port: Mutex::new(None),
            bt_connected: AtomicBool::new(false),
            pan_up: AtomicBool::new(crate::wifi::running_cmd("udhcpc")),
            lines: AtomicU64::new(0),
            last_nc_req: Mutex::new(None),
            last_line: Mutex::new(String::new()),
            counts: Mutex::new(std::collections::BTreeMap::new()),
            rate: Mutex::new((Instant::now(), 0)),
            muted: AtomicBool::new(false),
            last_reply: Mutex::new(None),
            last_p1: Mutex::new(None),
            bt_on: AtomicBool::new(false),
            phone_name: Mutex::new(String::new()),
            phone_mac: Mutex::new(String::new()),
            list_changed: AtomicBool::new(false),
        });
        let reader = g.clone();
        std::thread::Builder::new().name("gocsdk".into()).spawn(move || reader.run()).ok()?;
        let pan = g.clone();
        std::thread::Builder::new().name("btpan".into()).spawn(move || pan.pan_loop()).ok()?;
        Some(g)
    }

    pub fn send(&self, cmd: &str) -> bool {
        let mut guard = self.port.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = guard.as_mut() {
            let line = format!("{}\r\n", cmd.trim_end_matches(['\r', '\n']));
            if f.write_all(line.as_bytes()).and_then(|_| f.flush()).is_ok() {
                self.log.dbg(&format!("gocsdk -> {}", cmd));
                return true;
            }
        }
        self.log.log(&format!("gocsdk: cannot send {} (port closed)", cmd));
        false
    }

    fn run(self: Arc<Self>) {
        loop {
            let f = match OpenOptions::new().read(true).write(true).open(DEV) {
                Ok(f) => f,
                Err(e) => {
                    self.log.log(&format!("gocsdk: open {}: {} (retry in 5 s)", DEV, e));
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
            };
            {
                use std::os::unix::io::AsRawFd;
                if !make_raw(f.as_raw_fd()) {
                    self.log.log("gocsdk: tcsetattr(raw) failed; not reading an echoing pty");
                    std::thread::sleep(Duration::from_secs(10));
                    continue;
                }
            }
            let Ok(w) = f.try_clone() else { continue };
            *self.port.lock().unwrap_or_else(|e| e.into_inner()) = Some(w);
            self.muted.store(false, Ordering::Relaxed);
            self.log.log("gocsdk: port open (raw)");
            self.send("AT#P0");
            let mut r = BufReader::new(f);
            let mut buf = String::new();
            loop {
                buf.clear();
                match r.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = buf.trim_end_matches(['\r', '\n']).trim_start_matches(['\r', '\n']).to_string();
                        if !line.is_empty() {
                            self.on_line(&line);
                        }
                    }
                    Err(e) => {
                        self.log.log(&format!("gocsdk: read: {}", e));
                        break;
                    }
                }
            }
            *self.port.lock().unwrap_or_else(|e| e.into_inner()) = None;
            self.log.log("gocsdk: port closed, reopening in 2 s");
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    fn on_line(&self, line: &str) {
        let n = self.lines.fetch_add(1, Ordering::Relaxed) + 1;
        *self.last_line.lock().unwrap_or_else(|e| e.into_inner()) = line.to_string();
        let code = &line[..line.len().min(2)];
        let arg = line.get(2..).unwrap_or("");
        {
            let mut c = self.counts.lock().unwrap_or_else(|e| e.into_inner());
            *c.entry(code.to_string()).or_insert(0) += 1;
        }
        // flood guard: more than 300 lines/s means the protocol is out of step (an unanswered
        // report); stop talking and say so once, instead of filling the log
        {
            let mut r = self.rate.lock().unwrap_or_else(|e| e.into_inner());
            if r.0.elapsed() >= Duration::from_secs(1) {
                if n - r.1 > 300 && !self.muted.swap(true, Ordering::Relaxed) {
                    self.log.log(&format!("gocsdk: {} lines/s -- muting replies (protocol out of step?) last={}", n - r.1, line));
                }
                *r = (Instant::now(), n);
            }
        }
        if self.muted.load(Ordering::Relaxed) {
            return;
        }
        match code {
            "IS" => match arg.chars().next() {
                // stock lygoc (re-read 2026-10-19): IS0 = Bluetooth off -> AT#P1 turns it on;
                // IS2 = on (then it sleeps a second); any other digit = not connected
                Some('0') => {
                    self.bt_connected.store(false, Ordering::Relaxed);
                    self.pan_up.store(false, Ordering::Relaxed);
                    let mut r = self.last_p1.lock().unwrap_or_else(|e| e.into_inner());
                    if r.map(|t| t.elapsed() >= Duration::from_secs(5)).unwrap_or(true) {
                        *r = Some(Instant::now());
                        self.log.log("gocsdk: IS0 (bluetooth off) -> AT#P1");
                        self.send("AT#P1");
                    }
                }
                Some('2') => {
                    if !self.bt_on.swap(true, Ordering::Relaxed) {
                        self.log.log("gocsdk: bluetooth on (IS2)");
                    }
                }
                _ => {
                    self.log.dbg(&format!("gocsdk: {}", line));
                    self.bt_connected.store(false, Ordering::Relaxed);
                    self.phone_mac.lock().unwrap_or_else(|e| e.into_inner()).clear();
                }
            },
            "SA" => {
                // the connecting phone's name (SA토뭉이폰2 on the bench)
                if !arg.is_empty() {
                    *self.phone_name.lock().unwrap_or_else(|e| e.into_inner()) = arg.to_string();
                }
                self.log.dbg(&format!("gocsdk: {}", line));
            }
            "CN" => {
                // a phone connected (seen on every connect, before the UUID/service lines); its
                // argument is not the address -- bt_conf.ini's lastaddr serves until SV/SS name it
                if !self.bt_connected.swap(true, Ordering::Relaxed) {
                    self.log.log(&format!("gocsdk: phone connected ({})", line));
                }
                let mut m = self.phone_mac.lock().unwrap_or_else(|e| e.into_inner());
                if m.len() != 12 {
                    *m = crate::status::bt_conf().last;
                }
            }
            "SV" | "SS" => {
                // service lines: SV<addr:12><uuid...> for the phone that connected (`get`, not
                // slicing: a multibyte character there would panic, and panic = abort)
                if let Some(addr) = arg.get(..12).filter(|h| h.chars().all(|c| c.is_ascii_hexdigit())) {
                    let addr = addr.to_uppercase();
                    let mut m = self.phone_mac.lock().unwrap_or_else(|e| e.into_inner());
                    if *m != addr {
                        self.log.log(&format!("gocsdk: phone address {} ({})", addr, code));
                        *m = addr;
                    }
                }
                self.log.dbg(&format!("gocsdk: {}", line));
            }
            "PR" => {
                // reply to AT#CV (pair-list delete): PR<status><addr>, bt_conf.ini rewritten by now
                self.log.log(&format!("gocsdk: {}", line));
                self.list_changed.store(true, Ordering::Relaxed);
            }
            "DR" => {
                if self.bt_connected.swap(false, Ordering::Relaxed) {
                    self.log.log(&format!("gocsdk: phone disconnected ({})", line));
                }
                self.pan_up.store(false, Ordering::Relaxed);
                self.phone_mac.lock().unwrap_or_else(|e| e.into_inner()).clear();
            }
            "NC" => {
                self.log.log(&format!("gocsdk: PAN up ({}), running udhcpc on bt-pan", line));
                self.pan_up.store(true, Ordering::Relaxed);
                self.bt_connected.store(true, Ordering::Relaxed);
                match pan_ip_forward() {
                    Ok(()) => self.log.log(&format!("gocsdk: ip_forward={}", if ip_forward_on() { 1 } else { 0 })),
                    Err(e) => self.log.log(&format!("gocsdk: ip_forward write failed: {}", e)),
                }
            }
            "ND" => {
                self.log.log(&format!("gocsdk: {} (PAN already connected)", line));
                self.pan_up.store(true, Ordering::Relaxed);
            }
            // stock answers IA with AT#MM (and MX with AT#MH only while a list query runs: not yet);
            // never more than once in 10 s, so a reply that provokes the same report cannot loop
            "IA" => {
                let mut r = self.last_reply.lock().unwrap_or_else(|e| e.into_inner());
                if r.map(|t| t.elapsed() >= Duration::from_secs(10)).unwrap_or(true) {
                    *r = Some(Instant::now());
                    self.log.log(&format!("gocsdk: {} -> AT#MM", line));
                    self.send("AT#MM");
                }
            }
            _ => {
                // other reports (CN DR FA PS RE SC UU OP ... around a phone connect): the first of
                // each code at info level, then debug, never more than a few per code
                let c = self.counts.lock().unwrap_or_else(|e| e.into_inner()).get(code).copied().unwrap_or(0);
                if c == 1 {
                    self.log.log(&format!("gocsdk: {}", line));
                } else if c <= 3 || c % 100 == 0 {
                    self.log.dbg(&format!("gocsdk: {} (#{})", line, c));
                }
            }
        }
    }

    /// Stock `gocsdk_run` reconnect + `btpan_run`: with no phone on Bluetooth, ask gocsdk to connect
    /// the last phone (`AT#CC<mac>`, then the other paired ones in turn) every 20 s; with a phone
    /// and no PAN, ask for the PAN (`AT#NC<mac>`) every ten seconds.
    fn pan_loop(self: Arc<Self>) {
        let mut round = 0usize;
        let mut last_cc: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_secs(5));
            if !self.bt_connected.load(Ordering::Relaxed) {
                if last_cc.map(|t| t.elapsed() < Duration::from_secs(20)).unwrap_or(false) {
                    continue;
                }
                let conf = crate::status::bt_conf();
                if conf.devices.is_empty() {
                    continue;
                }
                // the last connected phone first, then round-robin through the rest
                let mut order: Vec<String> = Vec::new();
                if conf.last.len() == 12 {
                    order.push(conf.last.clone());
                }
                for (a, _) in &conf.devices {
                    if !order.contains(a) {
                        order.push(a.clone());
                    }
                }
                let mac = order[round % order.len()].clone();
                round += 1;
                last_cc = Some(Instant::now());
                self.log.log(&format!("gocsdk: no phone, asking gocsdk to connect {} (AT#CC)", mac));
                self.send(&format!("AT#CC{}", mac));
                continue;
            }
            if self.pan_up.load(Ordering::Relaxed) {
                continue;
            }
            if crate::wifi::running_cmd("udhcpc") {
                self.pan_up.store(true, Ordering::Relaxed);
                continue;
            }
            let mac = crate::status::bt_conf().last;
            if mac.len() != 12 {
                self.log.dbg("gocsdk: PAN wanted but no last phone mac");
                continue;
            }
            let due = self.last_nc_req.lock().unwrap_or_else(|e| e.into_inner()).map(|t| t.elapsed() >= Duration::from_secs(10)).unwrap_or(true);
            if due {
                *self.last_nc_req.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                self.log.log(&format!("gocsdk: asking for the PAN (AT#NC{})", mac));
                self.send(&format!("AT#NC{}", mac));
            }
        }
    }

    pub fn health_json(&self) -> String {
        let counts: Vec<String> = self.counts.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| format!("\"{}\": {}", k, v)).collect();
        format!("{{\"on\": {}, \"bt\": {}, \"pan\": {}, \"fwd\": {}, \"lines\": {}, \"muted\": {}, \"codes\": {{{}}}, \"last\": {}}}", self.bt_on.load(Ordering::Relaxed), self.bt_connected.load(Ordering::Relaxed), self.pan_up.load(Ordering::Relaxed), ip_forward_on(), self.lines.load(Ordering::Relaxed), self.muted.load(Ordering::Relaxed), counts.join(", "), crate::protocol::js(&self.last_line.lock().unwrap_or_else(|e| e.into_inner())))
    }
}

/// Stock `btpan_ipForward`, verbatim: DHCP on bt-pan, forwarding, nat out of bt-pan. The nat
/// flush drops t2cd's udp/53 REDIRECT too; its keeper puts it back within 20 s.
pub fn pan_ip_forward() -> std::io::Result<()> {
    for cmd in [
        "killall udhcpc",
        "udhcpc -R -n -b -i bt-pan",
        "iptables -F",
        "iptables -t nat -F",
        "iptables -P INPUT ACCEPT",
        "iptables -P FORWARD ACCEPT",
        "iptables -t nat -A POSTROUTING -o bt-pan -j MASQUERADE",
    ] {
        crate::status::sh(&format!("{} >/dev/null 2>&1", cmd));
    }
    // written directly: `echo 1 > ip_forward >/dev/null` through sh leaves the file untouched (the
    // last redirection wins), which is how 26101709..19 left the hotspot without internet.
    let r = std::fs::write(IP_FORWARD, "1\n");
    crate::status::sh("touch /tmp/lylink_btpan");
    r
}

const IP_FORWARD: &str = "/proc/sys/net/ipv4/ip_forward";

/// True when the kernel forwards (the car's and the phone's internet through the PAN).
pub fn ip_forward_on() -> bool {
    std::fs::read_to_string(IP_FORWARD).map(|s| s.trim() == "1").unwrap_or(false)
}
