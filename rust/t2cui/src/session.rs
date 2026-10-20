//! The adapter's state as the page sees it: link/phone, the connected pages, the video fan-out,
//! the settings, and the session (re)start rules (NOTES › CarPlay session size, › The session
//! survives the car browser, › One page at a time). The vendor library sits behind `Backend`;
//! `mock::MockBackend` replays a file on the Mac so the page tests run without an adapter.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Cfg;
use crate::log::Logger;
use crate::protocol::{self as p, ClientMsg, Unit};
use crate::status::SysInfo;

#[derive(Clone, Debug, PartialEq)]
pub struct SessionParams {
    pub w: u16,
    pub h: u16,
    pub mm_w: u16,
    pub mm_h: u16,
    /// FPS key 1 ("smooth") -> start-struct flags 0x2910, else 0x3910
    pub smooth: bool,
    /// night key > 2 -> start-struct +0x14 = 2
    pub night: bool,
    /// driver side (lycfg +2) -> start-struct +4
    pub driver: u32,
    pub pixel: u32,
    pub name: String,
}

/// What the vendor layer reports (types from lylinkui's dispatcher, see rust/README.md).
#[derive(Debug)]
#[allow(dead_code)]
pub enum Event {
    PhoneConnect(String),
    PhoneDisconnect,
    LinkUp,
    LinkDown,
    Foreground,
    Background,
    VideoStart(u16, u16),
    VideoStop,
    SpsPps(Unit),
    Unit(Unit),
    AppVersion(String),
    Bt(String),
    Other(i32, i32),
}

pub trait Backend: Send + Sync {
    fn start(&self, p: &SessionParams) -> i32;
    fn stop(&self);
    fn touch(&self, m: i32, x: i32, y: i32);
    /// a press: (code, 0) then (code, 1)
    fn key(&self, code: i32);
    fn keyframe(&self) {
        self.key(0x600);
    }
    /// vendor cmd 4: CarPlay draws again (page asked for video)
    fn untake_video(&self);
    /// vendor cmd 2: the adapter's own screen, stream off (no page, no phone)
    fn take_video(&self);
    /// vendor cmd 12: drop the lylinkapp link (phone disconnect)
    fn disconnect_phone(&self);
    fn wifi(&self, ssid: &str, psk: &str);
    fn night(&self, n: i32);
    fn bt(&self, op: &str, mac: &str);
    /// bench only: lylinkapi_cmd(id) as is
    fn raw_cmd(&self, _id: i32) {}
}

#[derive(Clone, Debug, Default)]
pub struct Hello {
    pub w: u16,
    pub h: u16,
    pub lang: String,
    pub nav: String,
}

/// One WebSocket page. Complete WebSocket frames go out through a bounded queue drained by the
/// connection's writer thread, so a slow car browser never blocks the status thread or the vendor
/// event pump.
pub struct Client {
    pub id: u32,
    tx: SyncSender<Vec<u8>>,
    pub pong: AtomicU32,
    pub video: AtomicBool,
    pub need_idr: AtomicBool,
    pub alive: AtomicBool,
    pub hello: Mutex<Option<Hello>>,
    pub peer: String,
    pub dropped: AtomicU64,
}

pub const CLIENT_QUEUE: usize = 16;

impl Client {
    /// true if queued; false = queue full (frame dropped) or client gone
    pub fn send(&self, frame: Vec<u8>) -> bool {
        match self.tx.try_send(frame) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
            Err(TrySendError::Disconnected(_)) => {
                self.alive.store(false, Ordering::Relaxed);
                false
            }
        }
    }
    /// A tsl message, framed for the wire.
    pub fn msg(&self, typ: u32, payload: &[u8]) -> bool {
        self.send(crate::ws::frame(crate::ws::OP_BINARY, &p::message(typ, payload)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Override {
    pub w: u16,
    pub h: u16,
    pub mm_w: u8,
    pub mm_h: u8,
}

pub struct State {
    pub link: u8,
    pub phone: bool,
    pub phone_name: String,
    pub video: (u16, u16),
    pub clients: Vec<Arc<Client>>,
    pub current: Option<u32>,
    next_id: u32,
    pub override_: Option<Override>,
    pub codec: Option<Unit>,
    pub last_hello: Option<Hello>,
    pub last_keyreq: Option<Instant>,
    pub keyreq_pending: bool,
    pub last_restart: Option<Instant>,
    pub restart_pending: Option<&'static str>,
    pub running: Option<SessionParams>,
    pub app_version: String,
    pub recent: VecDeque<String>,
}

pub struct Session {
    pub log: Arc<Logger>,
    pub backend: Box<dyn Backend>,
    pub cfg: Mutex<Cfg>,
    pub st: Mutex<State>,
    pub info: SysInfo,
    pub units: AtomicU64,
    pub bytes: AtomicU64,
    pub keyreqs: AtomicU64,
    pub started: Instant,
    pub gocsdk: Mutex<Option<Arc<crate::gocsdk::Gocsdk>>>,
    pub leds: Mutex<Option<Arc<crate::leds::Leds>>>,
    /// MJPEG transcoder (vendor liblylinkav), used while the page's transport is "picture"
    pub picture: crate::picture::Picture,
    ap_up: AtomicBool,
    pub fw_pending: AtomicBool,
}

/// The t2cd USB console flag (usb.rs there): the page toggles it, t2cd polls it.
pub const USB_FLAG: &str = "/mnt/UDISK/t2c_usb";
pub fn usb_flag() -> bool {
    std::path::Path::new(USB_FLAG).exists()
}

pub const RESTART_GAP: Duration = Duration::from_secs(10);
pub const KEYREQ_GAP: Duration = Duration::from_millis(2000);

impl Session {
    pub fn new(log: Arc<Logger>, backend: Box<dyn Backend>, cfg: Cfg, info: SysInfo) -> Arc<Session> {
        Arc::new(Session {
            log: log.clone(),
            backend,
            cfg: Mutex::new(cfg),
            st: Mutex::new(State {
                link: 0,
                phone: false,
                phone_name: String::new(),
                video: (0, 0),
                clients: Vec::new(),
                current: None,
                next_id: 1,
                override_: None,
                codec: None,
                last_hello: None,
                last_keyreq: None,
                keyreq_pending: false,
                last_restart: None,
                restart_pending: None,
                running: None,
                app_version: String::new(),
                recent: VecDeque::new(),
            }),
            info,
            units: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            keyreqs: AtomicU64::new(0),
            started: Instant::now(),
            gocsdk: Mutex::new(None),
            leds: Mutex::new(None),
            picture: crate::picture::Picture::new(log),
            ap_up: AtomicBool::new(false),
            fw_pending: AtomicBool::new(false),
        })
    }

    fn note(&self, s: String) {
        self.log.log(&s);
        let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        if st.recent.len() >= 64 {
            st.recent.pop_front();
        }
        st.recent.push_back(s);
    }

    // ------------------------------------------------------------------ session parameters
    /// NOTES › CarPlay session size: preset by `pixel`, auto from the hello, override wins.
    pub fn params(&self) -> SessionParams {
        let cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
        let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        let (mut w, mut h, mut mm_w, mut mm_h) = match cfg.pixel() {
            0 => (1376u16, 1072u16, 344u16, 330u16),
            1 => (800, 800, 200, 160),
            2 => (768, 608, 149, 124),
            _ => {
                let (hw, hh) = st.last_hello.as_ref().map(|x| (x.w, x.h)).unwrap_or((800, 800));
                let hh = if hw > 0 { ((800u32 * hh as u32) / hw as u32) as u16 } else { 800 };
                let hh = (hh.max(400) / 16) * 16;
                (800, hh.min(800), 160, (160u32 * hh as u32 / 800) as u16)
            }
        };
        if let Some(o) = st.override_ {
            if o.w > 0 && o.h > 0 {
                w = o.w;
                h = o.h;
                mm_w = o.mm_w as u16;
                mm_h = o.mm_h as u16;
            }
        }
        SessionParams { w, h, mm_w, mm_h, smooth: cfg.fps() != 0, night: cfg.night() > 2, driver: cfg.driver() as u32, pixel: cfg.pixel() as u32, name: cfg.name() }
    }

    pub fn start_session(&self, reason: &str) {
        let params = self.params();
        self.note(format!("session start ({}): {}x{} {}x{}mm smooth={} night={} driver={} name={:?}", reason, params.w, params.h, params.mm_w, params.mm_h, params.smooth, params.night, params.driver, params.name));
        let rc = self.backend.start(&params);
        let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        st.running = Some(params);
        st.last_restart = Some(Instant::now());
        st.restart_pending = None;
        if rc != 0 {
            self.log.log(&format!("backend start -> {}", rc));
        }
    }

    /// Restarts are expensive (lylinkapp respawns, the iPhone reconnects, the PAN drops): at most
    /// one per RESTART_GAP, a request inside the window is carried out when it ends.
    pub fn request_restart(&self, reason: &'static str) {
        let due = {
            let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            match st.last_restart {
                Some(t) if t.elapsed() < RESTART_GAP => {
                    st.restart_pending = Some(reason);
                    false
                }
                _ => true,
            }
        };
        if due {
            self.restart_now(reason);
        } else {
            self.note(format!("restart ({}) deferred", reason));
        }
    }

    fn restart_now(&self, reason: &str) {
        self.note(format!("session restart ({})", reason));
        self.backend.stop();
        self.start_session(reason);
    }

    // ------------------------------------------------------------------ car app icon
    /// The icon the phone shows for the car's own app: stock copies `www/icon/<id>.png` to
    /// `/tmp/lylink/home.png` (lylinkapp's SetOEMIconsPath) and falls back to app/Auto.png.
    pub fn apply_icon(&self) {
        let icon = self.cfg.lock().unwrap_or_else(|e| e.into_inner()).icon();
        let www = std::path::Path::new("/tmp/lylink/www");
        if !www.is_dir() {
            return;
        }
        let mut src = www.join("icon").join(format!("{}.png", icon));
        if icon.is_empty() || !src.is_file() {
            src = std::path::PathBuf::from("/mnt/customer/app/Auto.png");
        }
        match std::fs::copy(&src, "/tmp/lylink/home.png") {
            Ok(n) => self.log.log(&format!("car icon: {} -> /tmp/lylink/home.png ({} bytes)", src.display(), n)),
            Err(e) => self.log.log(&format!("car icon: copy {}: {}", src.display(), e)),
        }
    }

    /// Bench routes (/cmd, /led) answer only while the debug shell flag file exists.
    pub fn debug_allowed(&self) -> bool {
        std::path::Path::new("/mnt/UDISK/t2c_shell").exists() || !std::path::Path::new("/mnt/UDISK").is_dir()
    }

    // ------------------------------------------------------------------ hotspot
    /// /tmp/hostapd.conf from the template, hostapd started if missing (or restarted when
    /// `restart`), the credentials to the vendor library (lylinkapp -> iAP -> iPhone).
    pub fn wifi_handoff(&self, restart: bool) {
        let (channel, psk, psk_unset) = {
            let cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
            (cfg.channel(), cfg.psk(), cfg.psk_raw().len() < 8)
        };
        let ssid = self.info.ssid.clone();
        if ssid.is_empty() {
            self.log.log("wifi: no ssid (WIFI_NAME unset and no /tmp/hostapd.conf): hostapd left alone");
            return;
        }
        if psk_unset {
            self.note("wifi: password field unset in lycfg.txt, the stock default applies".to_string());
        }
        match crate::wifi::write_conf(&ssid, channel, &psk) {
            None => self.log.dbg("wifi: no hostapd template here"),
            Some(changed) => {
                let running = crate::wifi::running();
                self.note(format!("wifi: conf {} ch {} (lycfg {}) hostapd {}", if changed { "written" } else { "unchanged" }, crate::wifi::stock_channel(channel), channel, if running { "running" } else { "not running" }));
                if restart && running {
                    // stock KEY_CHANNEL: save_hostapd_conf + lylinkapi_cmd(12) -> the library's own
                    // hostapd relaunch (killall + `hostapd -B`, through the wrapper on PATH)
                    self.note("wifi: hostapd restart through the library (cmd 12)".to_string());
                    self.backend.raw_cmd(12);
                } else if !running {
                    self.start_hostapd(&ssid, channel, &psk);
                }
            }
        }
        self.backend.wifi(&ssid, &psk);
    }

    /// `hostapd -B` through the wrapper, then a check: the daemon can refuse the file (`-B` returns
    /// non-zero) or die after its 40 MHz scan (channel 165 with `[HT40+]`, 26101719..23 wrote
    /// that), and nothing used to notice. One retry with the plain 20 MHz file; after that the
    /// watchdog's AP of last resort takes over. An AP the car can see beats a perfect one nobody
    /// can reach.
    fn start_hostapd(&self, ssid: &str, channel: u8, psk: &str) {
        let rc = crate::wifi::start();
        self.note(format!("wifi: hostapd started -> {}", rc));
        let (log, ssid, psk) = (self.log.clone(), ssid.to_string(), psk.to_string());
        let _ = std::thread::Builder::new().name("wifi-check".into()).spawn(move || {
            if rc == 0 && crate::wifi::wait_running(6) {
                return;
            }
            log.log(&format!("wifi: hostapd not running after start (rc {}): retrying with the plain 20 MHz file", rc));
            match crate::wifi::write_conf_opts(&ssid, channel, &psk, true) {
                None => log.log("wifi: no hostapd template here"),
                Some(_) => {
                    let rc2 = crate::wifi::start();
                    let ok = rc2 == 0 && crate::wifi::wait_running(6);
                    log.log(&format!("wifi: plain-file start -> {} ({})", rc2, if ok { "running" } else { "still not running; the watchdog takes over" }));
                }
            }
        });
    }

    // ------------------------------------------------------------------ clients
    pub fn attach(&self, peer: String) -> (Arc<Client>, Receiver<Vec<u8>>) {
        let (tx, rx) = sync_channel(CLIENT_QUEUE);
        let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        let id = st.next_id;
        st.next_id += 1;
        let c = Arc::new(Client {
            id,
            tx,
            pong: AtomicU32::new(0),
            video: AtomicBool::new(false),
            need_idr: AtomicBool::new(true),
            alive: AtomicBool::new(true),
            hello: Mutex::new(None),
            peer,
            dropped: AtomicU64::new(0),
        });
        st.clients.push(c.clone());
        drop(st);
        self.note(format!("page #{} connected ({})", c.id, c.peer));
        (c, rx)
    }

    pub fn detach(&self, c: &Arc<Client>) {
        c.alive.store(false, Ordering::Relaxed);
        let (phone, pages_left) = {
            let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            st.clients.retain(|x| x.id != c.id);
            if st.current == Some(c.id) {
                st.current = None;
            }
            (st.phone, st.clients.iter().filter(|x| x.video.load(Ordering::Relaxed)).count())
        };
        self.note(format!("page #{} gone (video pages left {}, phone {})", c.id, pages_left, phone));
        // NOTES › The session survives the car browser: with a phone attached the stream runs on
        // (units are dropped here until a page is back); without one the adapter's menu stream
        // would encode for nobody, so take the screen.
        if pages_left == 0 && !phone {
            self.backend.take_video();
        }
    }

    fn clients(&self) -> Vec<Arc<Client>> {
        self.st.lock().unwrap_or_else(|e| e.into_inner()).clients.clone()
    }

    pub fn broadcast(&self, typ: u32, payload: &[u8]) {
        for c in self.clients() {
            c.msg(typ, payload);
        }
    }

    fn link_json(&self) -> String {
        let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        format!("{{\"link\": {}, \"phone\": {}}}", st.link, st.phone)
    }

    fn set_link(&self, link: u8) {
        let changed = {
            let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            let c = st.link != link;
            st.link = link;
            c
        };
        if changed {
            let j = self.link_json();
            self.note(format!("link {}", j));
            self.broadcast(p::S_LINK, j.as_bytes());
        }
    }

    fn set_phone(&self, phone: bool, name: &str) {
        let changed = {
            let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            let c = st.phone != phone;
            st.phone = phone;
            if phone {
                st.phone_name = name.to_string();
            }
            c
        };
        if changed {
            let j = self.link_json();
            self.note(format!("phone {} {}", phone, name));
            self.broadcast(p::S_LINK, j.as_bytes());
        }
    }

    // ------------------------------------------------------------------ vendor events
    pub fn on_event(&self, ev: Event) {
        match ev {
            Event::PhoneConnect(name) => self.set_phone(true, &name),
            Event::PhoneDisconnect => {
                self.set_phone(false, "");
            }
            Event::LinkUp => {
                // PHONE_CONNECT (type 3) never fired on the adapter; the established link is the phone
                let name = self.gocsdk.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|g| g.phone_name.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or_default();
                self.set_phone(true, if name.is_empty() { "iPhone" } else { &name });
                self.set_link(1);
            }
            Event::LinkDown => {
                self.set_link(0);
                self.set_phone(false, "");
                self.stop_picture("link down");
            }
            Event::Foreground => {
                // stock lylinkui only reacts to FOREGROUND/BACKGROUND for link type 8 (cmd 3 / cmd 2);
                // for the iPhone's type 1 link it just logs them -- so do we (the car-app switch is
                // being traced here, 2026-10-19 evening)
                self.note("FOREGROUND".to_string());
            }
            Event::Background => self.note("BACKGROUND".to_string()),
            Event::VideoStart(w, h) => {
                let changed = {
                    let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
                    let c = st.video != (w, h) || st.link < 2;
                    st.video = (w, h);
                    c
                };
                // the phone's encoder restarts on every key-frame request: log size changes only
                if changed {
                    self.note(format!("video start {}x{}", w, h));
                } else {
                    self.log.dbg(&format!("video (re)start {}x{}", w, h));
                }
                for c in self.clients() {
                    c.need_idr.store(true, Ordering::Relaxed);
                }
                self.set_link(2);
                if self.picture.running() && self.picture.size() != (w, h) {
                    self.picture.stop();
                }
                self.ensure_picture();
            }
            Event::VideoStop => {
                self.note("video stop".to_string());
                if self.st.lock().unwrap_or_else(|e| e.into_inner()).link >= 2 {
                    self.set_link(1);
                }
                self.stop_picture("video stop");
            }
            Event::SpsPps(u) => {
                // type 14 carries the parameter sets -- and after a key-frame request the whole IDR
                // access unit behind them (30 KB in the device logs). Keep the SPS/PPS prefix as the
                // codec config and deliver the unit if there is a picture in it.
                let prefix = p::vcl_offset(&u).map(|off| std::sync::Arc::new(u[..off].to_vec())).unwrap_or_else(|| u.clone());
                self.st.lock().unwrap_or_else(|e| e.into_inner()).codec = Some(prefix);
                self.picture.feed(&u);
                if p::has_idr(&u) {
                    self.units.fetch_add(1, Ordering::Relaxed);
                    self.bytes.fetch_add(u.len() as u64, Ordering::Relaxed);
                    self.deliver(&u, false);
                }
            }
            Event::Unit(u) => {
                self.units.fetch_add(1, Ordering::Relaxed);
                self.bytes.fetch_add(u.len() as u64, Ordering::Relaxed);
                self.picture.feed(&u);
                self.deliver(&u, false);
            }
            Event::AppVersion(v) => {
                self.st.lock().unwrap_or_else(|e| e.into_inner()).app_version = v.clone();
                self.note(format!("lylinkapp {}", v));
            }
            Event::Bt(s) => self.note(format!("bt: {}", s)),
            Event::Other(19, _) => {
                // the user tapped the car's own app icon in CarPlay (lylinkui type-19 handler): with
                // the "sr.." icon the car app is a Siri button (key 0x300); otherwise the page link
                // drops to 1 and the page shows its own menu -- the phone keeps the session
                let siri = self.cfg.lock().unwrap_or_else(|e| e.into_inner()).icon().starts_with("sr");
                if siri {
                    self.note("car app tapped: Siri key".to_string());
                    self.backend.key(0x300);
                } else if self.st.lock().unwrap_or_else(|e| e.into_inner()).link >= 2 {
                    self.note("car app tapped: page menu (link 1)".to_string());
                    self.set_link(1);
                }
            }
            Event::Other(t, a) => self.note(format!("event {} a1={}", t, a)),
        }
    }

    /// Video fan-out (event-pump thread): never blocks. A page whose queue is full loses the unit
    /// and waits for the next IDR (drop-until-IDR), which we ask the phone for. A page that is
    /// (re)starting gets the cached SPS/PPS glued in front of its first IDR when the unit lacks
    /// them -- never as a message of its own: the page's decoder reports a picture-less access unit
    /// as a failed frame and five seconds of those read as "decoder too slow".
    fn deliver(&self, unit: &Unit, is_codec: bool) {
        if is_codec {
            return;
        }
        // picture mode: the units go to the transcoder (stock lylinkui 0x1498c), the page reads
        // /video.jpg; nothing on the WebSocket
        if self.picture.running() {
            return;
        }
        let idr = p::has_idr(unit);
        if !idr {
            let mut want_key = false;
            for c in self.clients() {
                if !c.video.load(Ordering::Relaxed) || !c.alive.load(Ordering::Relaxed) {
                    continue;
                }
                if c.need_idr.load(Ordering::Relaxed) {
                    want_key = true;
                    continue;
                }
                for m in p::video_messages(unit) {
                    if !c.send(crate::ws::frame(crate::ws::OP_BINARY, &m)) {
                        c.need_idr.store(true, Ordering::Relaxed);
                        want_key = true;
                        break;
                    }
                }
            }
            if want_key {
                self.request_keyframe(false);
            }
            return;
        }
        // an IDR: build the "with headers" variant once if the unit has no SPS of its own
        let has_sps = p::nal_types(unit).any(|t| t == 7);
        let codec = self.st.lock().unwrap_or_else(|e| e.into_inner()).codec.clone();
        let with_headers: Option<Vec<u8>> = match (has_sps, codec) {
            (false, Some(cc)) => {
                let mut v = Vec::with_capacity(cc.len() + unit.len());
                v.extend_from_slice(&cc);
                v.extend_from_slice(unit);
                Some(v)
            }
            _ => None,
        };
        let plain = p::video_messages(unit);
        let headed = with_headers.as_ref().map(|v| p::video_messages(v));
        let mut want_key = false;
        for c in self.clients() {
            if !c.video.load(Ordering::Relaxed) || !c.alive.load(Ordering::Relaxed) {
                continue;
            }
            let fresh = c.need_idr.swap(false, Ordering::Relaxed);
            let msgs = if fresh { headed.as_ref().unwrap_or(&plain) } else { &plain };
            for m in msgs {
                if !c.send(crate::ws::frame(crate::ws::OP_BINARY, m)) {
                    c.need_idr.store(true, Ordering::Relaxed);
                    want_key = true;
                    break;
                }
            }
        }
        if want_key {
            self.request_keyframe(false);
        }
    }

    // ------------------------------------------------------------------ picture mode
    /// Run the MJPEG transcoder exactly while the transport is "picture" (lycfg +550 = 0) and the
    /// phone streams; started late (a page can switch modes mid-session), it gets the cached
    /// SPS/PPS and a key-frame request so the decoder has a picture within a second.
    pub fn ensure_picture(&self) {
        let (mode, link, video, codec) = {
            let cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
            let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            (cfg.mode(), st.link, st.video, st.codec.clone())
        };
        let want = mode == 0 && link >= 2 && video.0 > 0 && video.1 > 0;
        if want && !self.picture.running() {
            if !self.picture.can_try() || !self.picture.available() {
                return;
            }
            if self.picture.start(video.0, video.1) {
                self.note(format!("picture mode: transcoder started {}x{}", video.0, video.1));
                if let Some(c) = codec {
                    self.picture.feed(&c);
                }
                self.request_keyframe(true);
            }
        } else if !want && self.picture.running() {
            self.stop_picture(if mode != 0 { "video mode" } else { "no video" });
        }
    }

    fn stop_picture(&self, why: &str) {
        if self.picture.running() {
            self.picture.stop();
            self.note(format!("picture mode: transcoder stopped ({})", why));
        }
    }

    /// Rate-limited to one a second but never dropped (the ticker sends a pending one).
    pub fn request_keyframe(&self, force: bool) {
        let send = {
            let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            match st.last_keyreq {
                Some(t) if !force && t.elapsed() < KEYREQ_GAP => {
                    st.keyreq_pending = true;
                    false
                }
                _ => {
                    st.last_keyreq = Some(Instant::now());
                    st.keyreq_pending = false;
                    true
                }
            }
        };
        if send {
            self.keyreqs.fetch_add(1, Ordering::Relaxed);
            self.log.dbg("key frame requested");
            self.backend.keyframe();
        }
    }

    // ------------------------------------------------------------------ page messages
    pub fn on_message(&self, c: &Arc<Client>, data: &[u8]) {
        let Some(m) = p::parse(data) else { return };
        match m {
            ClientMsg::Ping(n) => c.pong.store(n, Ordering::Relaxed),
            ClientMsg::Hello { w, h, lang, nav } => {
                let hello = Hello { w, h, lang, nav };
                self.note(format!("page #{} hello {}x{} {} {:?}", c.id, w, h, hello.lang, hello.nav));
                *c.hello.lock().unwrap_or_else(|e| e.into_inner()) = Some(hello.clone());
                {
                    let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
                    st.current = Some(c.id);
                    st.last_hello = Some(hello);
                }
                let init = self.init_json();
                c.msg(p::S_INIT, init.as_bytes());
                // a hello restarts nothing (26101701 behaviour); the first session starts here
                if self.st.lock().unwrap_or_else(|e| e.into_inner()).running.is_none() {
                    self.start_session("first hello");
                }
            }
            ClientMsg::Touch { m, x, y } => {
                // the page sends 0..1000; the library wants session pixels (lylinkui: x * W / 1000)
                let (w, h) = {
                    let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
                    if st.video.0 > 0 && st.video.1 > 0 {
                        st.video
                    } else {
                        st.running.as_ref().map(|r| (r.w, r.h)).unwrap_or((768, 608))
                    }
                };
                let px = (x.clamp(0, 1000) as i32 * w as i32) / 1000;
                let py = (y.clamp(0, 1000) as i32 * h as i32) / 1000;
                self.backend.touch(m as i32, px, py);
            }
            ClientMsg::Key { key, .. } => self.backend.key(key as i32),
            ClientMsg::Cmd(cmd) => self.on_cmd(c, cmd),
            ClientMsg::SetKey { key, value } => self.on_setkey(c, key, value),
            ClientMsg::Night(n) => self.backend.night(n as i32),
            ClientMsg::Identity { name, icon } => {
                let changed = {
                    let mut cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
                    let c = cfg.name().as_bytes() != name.as_slice() || cfg.icon() != icon;
                    cfg.set_name(&name);
                    cfg.set_icon(&icon);
                    let _ = cfg.save();
                    c
                };
                self.log.log(&format!("car identity {:?} icon {:?} (changed {})", String::from_utf8_lossy(&name), icon, changed));
                if changed {
                    self.apply_icon();
                    // the phone reads name and icon when the session starts
                    self.request_restart("car identity");
                }
            }
            ClientMsg::Override { w, h, mm_w, mm_h } => {
                let o = if w == 0 { None } else { Some(Override { w, h, mm_w, mm_h }) };
                self.st.lock().unwrap_or_else(|e| e.into_inner()).override_ = o;
                self.note(format!("session override {:?}", o));
            }
            ClientMsg::BtConnect(mac) => self.bt_op("connect", &mac),
            ClientMsg::BtDisconnect(mac) => self.bt_op("disconnect", &mac),
            ClientMsg::BtForget(mac) => {
                self.bt_op("forget", &mac);
                self.broadcast(p::S_BTLIST, b"");
            }
            ClientMsg::WifiPsk(psk) => {
                {
                    let mut cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
                    cfg.set_psk(&psk);
                    let _ = cfg.save();
                }
                self.note("wifi password changed".to_string());
                // stock: new hostapd.conf, hostapd restart, CarPlay session restart
                self.wifi_handoff(true);
                self.request_restart("wifi password");
            }
            ClientMsg::Unknown(t, n) => self.log.dbg(&format!("page #{} unknown type {} ({} B)", c.id, t, n)),
        }
    }

    /// Page Bluetooth buttons. Stock lylinkui sends gocsdk `AT#CC<mac>` / `AT#CD<mac>` (connect /
    /// disconnect); "forget" has no verified command yet and is only logged.
    fn bt_op(&self, op: &str, mac: &str) {
        let mac: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_uppercase();
        self.note(format!("bt {} {}", op, mac));
        let g = self.gocsdk.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match (g, op) {
            (Some(g), "connect") if mac.len() == 12 => {
                g.send(&format!("AT#CC{}", mac));
            }
            (Some(g), "disconnect") if mac.len() == 12 => {
                g.send(&format!("AT#CD{}", mac));
            }
            (Some(g), "forget") if mac.len() == 12 => {
                // stock sends AT#CV<n> with the phone's index in gocsdk's list (bt_conf.ini addrN)
                let conf = crate::status::bt_conf();
                match conf.devices.iter().position(|(a, _)| *a == mac) {
                    Some(n) => {
                        g.send(&format!("AT#CV{}", n));
                    }
                    None => self.log.log(&format!("bt forget: {} not in bt_conf.ini", mac)),
                }
            }
            _ => self.backend.bt(op, &mac),
        }
    }

    fn on_cmd(&self, c: &Arc<Client>, cmd: i16) {
        match cmd {
            p::CMD_VIDEO => {
                c.video.store(true, Ordering::Relaxed);
                c.need_idr.store(true, Ordering::Relaxed);
                let (link, streaming) = {
                    let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
                    (st.link, st.video.0 > 0)
                };
                self.log.dbg(&format!("page #{} wants video (link {})", c.id, link));
                if link == 1 {
                    // back from the page menu (or the first page after boot): stock's patched flow
                    // moves the link to "video requested" and asks the phone to draw again
                    self.backend.untake_video();
                    if streaming {
                        self.set_link(2);
                    }
                }
                // the page follows up with CMD_KEYFRAME itself; the fan-out asks again if P-frames
                // keep arriving (each request restarts the phone's encoder: VIDEO_START + IDR)
            }
            p::CMD_AUTO_ON | p::CMD_AUTO_OFF => {
                let mut cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
                cfg.set_auto(cmd == p::CMD_AUTO_ON);
                let _ = cfg.save();
            }
            p::CMD_BTLIST => self.broadcast(p::S_BTLIST, b""),
            p::CMD_DISCONNECT => {
                self.note("page asked to disconnect the phone".to_string());
                self.backend.disconnect_phone();
            }
            p::CMD_FACTORY_RESET => {
                // stock (lylinkui 0x181ac): lycfg_delete, `rm -rf /mnt/UDISK/*`, sync, reboot -- pairings,
                // settings and every t2c_* flag go (the adapter comes back on the stock UI)
                self.note("FACTORY RESET: wiping /mnt/UDISK and rebooting".to_string());
                std::thread::spawn(|| crate::status::sh("rm -rf /mnt/UDISK/*; sync; sleep 1; reboot"));
            }
            p::CMD_KEYFRAME => self.request_keyframe(false),
            p::CMD_USB_ON | p::CMD_USB_OFF => {
                let on = cmd == p::CMD_USB_ON;
                let r = if on {
                    std::fs::write(USB_FLAG, "1\n")
                } else {
                    match std::fs::remove_file(USB_FLAG) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                        _ => Ok(()),
                    }
                };
                match r {
                    Ok(()) => self.note(format!("USB console {} (page #{})", if on { "on" } else { "off" }, c.id)),
                    Err(e) => self.log.log(&format!("USB console flag: {}", e)),
                }
            }
            10 => {
                // page home "Restart adapter" (Rust UI only)
                self.note(format!("page #{} asked for a reboot", c.id));
                crate::status::reboot();
            }
            p::CMD_QR => {
                let psk = self.cfg.lock().unwrap_or_else(|e| e.into_inner()).psk();
                let qr = format!("WIFI:T:WPA;S:{};P:{};;", self.info.ssid, psk);
                c.msg(p::S_QR, qr.as_bytes());
            }
            other => self.log.log(&format!("page #{} unknown cmd {}", c.id, other)),
        }
    }

    fn on_setkey(&self, _c: &Arc<Client>, key: i16, value: i16) {
        let v = value as i32;
        let mut restart: Option<&'static str> = None;
        let mut reload = false;
        let mut mode_changed = false;
        {
            let mut cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
            match key {
                p::KEY_NIGHT => {
                    // value 0..2 = day variants, 3..5 = night on; the phone takes it from the start
                    // struct (+0x14 = 2 when on), so a change of on/off restarts the session
                    let was = cfg.night() > 2;
                    cfg.set_night(v.clamp(0, 5) as u8);
                    if was != (v > 2) {
                        restart = Some("night");
                    }
                    self.backend.night(if v > 2 { 1 } else { 0 });
                }
                p::KEY_PIXEL => {
                    if cfg.pixel() as i32 != v {
                        cfg.set_pixel(v.clamp(0, 3) as u8);
                        restart = Some("pixel");
                    }
                }
                p::KEY_DRIVER => {
                    if cfg.driver() as i32 != v {
                        cfg.set_driver(v.clamp(0, 1) as u8);
                        restart = Some("driver");
                    }
                }
                p::KEY_CHANNEL => {
                    if cfg.channel() as i32 != v {
                        cfg.set_channel(v.clamp(0, 255) as u8);
                        restart = Some("channel");
                    }
                }
                p::KEY_LANG => cfg.set_lang(v.clamp(0, 3) as u8),
                p::KEY_BTNET => cfg.set_btnet(v == 2),
                p::KEY_FPS => {
                    if cfg.fps() as i32 != v {
                        cfg.set_fps(v.clamp(0, 1) as u8);
                        restart = Some("fps");
                    }
                }
                p::KEY_ONLINE => cfg.online = v != 0,
                p::KEY_MODE => {
                    // 0 = picture (MJPEG over /video.jpg, the vendor transcoder), 1 = video (H.264
                    // on the WebSocket). The pipeline switches at once; the page restarts the
                    // session on its own like it did with stock.
                    let want: u8 = if v == 0 { 0 } else { 1 };
                    if want == 0 && !self.picture.available() {
                        cfg.set_mode(1);
                        self.log.log("picture mode requested: liblylinkav not available, page reloaded in video mode");
                        reload = true;
                    } else if cfg.mode() != want {
                        cfg.set_mode(want);
                        mode_changed = true;
                    }
                }
                _ => {}
            }
            let _ = cfg.save();
        }
        self.log.log(&format!("setting key {} = {}", key, v));
        if mode_changed {
            self.ensure_picture();
        }
        if reload {
            _c.msg(p::S_RELOAD, b"");
        }
        if restart == Some("channel") {
            self.wifi_handoff(true);
        }
        if let Some(r) = restart {
            self.request_restart(r);
        }
    }

    // ------------------------------------------------------------------ JSON
    pub fn init_json(&self) -> String {
        let cfg = self.cfg.lock().unwrap_or_else(|e| e.into_inner());
        let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        let i = &self.info;
        let auto = cfg.auto();
        format!(
            "{{\"link\": {}, \"phone\": {}, \"bt\": {}, \"auto\": {}, \"ssid\": {}, \"psk\": {}, \"ch\": {}, \"sh\": {}, \"night\": {}, \"pixel\": {}, \"driver\": {}, \"fps\": {}, \"vid\": {}, \"icons\": {}, \"icon\": {}, \"name\": {}, \"lan\": {}, \"SN\": \"TesPush_T2C\", \"SW\": {}, \"LY\": {}, \"HW\": {}, \"MD\": {}, \"imei\": \"\", \"ccid\": \"\", \"btnet\": {}, \"wifi\": {}, \"bl\": 0, \"online\": {}, \"usb\": {}}}",
            st.link, st.phone, p::js(&i.bt_name), auto, p::js(&i.ssid), p::js(&cfg.psk()), cfg.channel(),
            0, cfg.night(), cfg.pixel(), cfg.driver(), cfg.fps(),
            cfg.mode() == 1, i.icons, p::js(&cfg.icon()), p::js(&cfg.name()), cfg.lang(), p::js(&i.sw), p::js(&i.ly), p::js(&i.hw), p::js(&i.md),
            cfg.btnet(), p::js(&i.wifi_mac), cfg.online, usb_flag()
        )
    }

    pub fn status_json(&self, pong: u32) -> String {
        let (sys, exe) = crate::status::cpu_and_uptime();
        let bt = self.st.lock().unwrap_or_else(|e| e.into_inner()).phone_name.clone();
        format!("{{\"sys\": {}, \"exe\": {}, \"apn\": \"\", \"sig\": 0, \"csq\": 0, \"bt\": {}, \"pong\": {}}}", sys, exe, p::js(&bt), pong)
    }

    /// Once a second: status (and the pong) to the newest page only, like stock; deferred key-frame
    /// requests and restarts; dead clients dropped.
    pub fn tick(&self) {
        let (current, pending_key, pending_restart) = {
            let mut st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            st.clients.retain(|c| c.alive.load(Ordering::Relaxed));
            let cur = st.current.and_then(|id| st.clients.iter().find(|c| c.id == id).cloned());
            let pk = st.keyreq_pending && st.last_keyreq.map(|t| t.elapsed() >= KEYREQ_GAP).unwrap_or(true);
            let pr = match (st.restart_pending, st.last_restart) {
                (Some(r), Some(t)) if t.elapsed() >= RESTART_GAP => Some(r),
                (Some(r), None) => Some(r),
                _ => None,
            };
            (cur, pk, pr)
        };
        if let Some(c) = current {
            let pong = c.pong.load(Ordering::Relaxed);
            let j = self.status_json(pong);
            c.msg(p::S_STATUS, j.as_bytes());
            if self.fw_pending.load(Ordering::Relaxed) {
                // stock: `{"val": %s, "pong": %u}` while the updater works; the page shows the stages
                let val = crate::status::update_status();
                c.msg(p::S_FW, format!("{{\"val\": {}, \"pong\": {}}}", val, pong).as_bytes());
                if val >= 3 {
                    self.note(format!("firmware update status {} (done or failed): reporting stops", val));
                    self.fw_pending.store(false, Ordering::Relaxed);
                }
            }
        }
        if pending_key {
            self.request_keyframe(true);
        }
        if let Some(r) = pending_restart {
            self.restart_now(r);
        }
        self.ensure_picture();
        self.leds_tick();
    }

    /// LEDs follow the state once a second: Wi-Fi = hostapd running (checked every 10 s), device =
    /// phone session, antenna = Bluetooth connected (gocsdk `CN`/`DR`).
    fn leds_tick(&self) {
        let leds = self.leds.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(l) = leds else { return };
        if self.started.elapsed().as_secs() % 10 == 0 || !self.ap_up.load(Ordering::Relaxed) {
            self.ap_up.store(crate::wifi::running(), Ordering::Relaxed);
        }
        let (link, phone) = {
            let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
            (st.link, st.phone)
        };
        let bt = self.gocsdk.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|g| g.bt_connected.load(Ordering::Relaxed)).unwrap_or(phone);
        l.apply(self.ap_up.load(Ordering::Relaxed), link >= 1 || phone, bt);
    }

    /// Bench aid: a raw `lylinkapi_cmd(id)` / key / take / untake through the backend.
    pub fn debug_cmd(&self, what: &str, n: i32) -> String {
        match what {
            "take" => {
                self.backend.take_video();
                "take_video (cmd 2)".into()
            }
            "untake" => {
                self.backend.untake_video();
                "untake_video (cmd 4)".into()
            }
            "key" => {
                self.backend.key(n);
                format!("key {:#x}", n)
            }
            "cmd" => {
                self.backend.raw_cmd(n);
                format!("lylinkapi_cmd({})", n)
            }
            _ => "unknown".into(),
        }
    }

    pub fn health_json(&self) -> String {
        let st = self.st.lock().unwrap_or_else(|e| e.into_inner());
        let pages: Vec<String> = st
            .clients
            .iter()
            .map(|c| format!("{{\"id\": {}, \"peer\": {}, \"video\": {}, \"pong\": {}, \"dropped\": {}, \"current\": {}}}", c.id, p::js(&c.peer), c.video.load(Ordering::Relaxed), c.pong.load(Ordering::Relaxed), c.dropped.load(Ordering::Relaxed), st.current == Some(c.id)))
            .collect();
        let recent: Vec<String> = st.recent.iter().map(|s| p::js(s)).collect();
        let bt = self.gocsdk.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|g| g.health_json()).unwrap_or_else(|| "null".into());
        format!(
            "{{\"gocsdk\": {}, \"picture\": {}, \"mode\": {}, \"up\": {}, \"link\": {}, \"phone\": {}, \"phone_name\": {}, \"video\": [{}, {}], \"units\": {}, \"bytes\": {}, \"keyreqs\": {}, \"app\": {}, \"session\": {}, \"override\": {}, \"pages\": [{}], \"recent\": [{}]}}",
            bt, self.picture.health_json(), self.cfg.lock().unwrap_or_else(|e| e.into_inner()).mode(), self.started.elapsed().as_secs(), st.link, st.phone, p::js(&st.phone_name), st.video.0, st.video.1, self.units.load(Ordering::Relaxed), self.bytes.load(Ordering::Relaxed), self.keyreqs.load(Ordering::Relaxed), p::js(&st.app_version),
            st.running.as_ref().map(|r| format!("\"{}x{}\"", r.w, r.h)).unwrap_or_else(|| "null".into()),
            st.override_.map(|o| format!("\"{}x{}\"", o.w, o.h)).unwrap_or_else(|| "null".into()),
            pages.join(", "), recent.join(", ")
        )
    }
}

/// Backend → session event pump (a thread so the vendor callback only ever does a channel send).
pub fn pump(session: Arc<Session>, rx: Receiver<Event>) {
    std::thread::Builder::new()
        .name("events".into())
        .spawn(move || {
            for ev in rx {
                session.on_event(ev);
            }
        })
        .expect("thread");
}

pub fn event_channel() -> (Sender<Event>, Receiver<Event>) {
    std::sync::mpsc::channel()
}
