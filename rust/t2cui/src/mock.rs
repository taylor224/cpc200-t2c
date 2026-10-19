//! A backend that replays an Annex-B H.264 file as if an iPhone were attached: the page tests on
//! the Mac (tools/cdp.py) run against the real server with it. Key-frame requests restart the
//! replay at its IDR; `--mock-link-after` delays the phone like a real connect.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::session::{Backend, Event, SessionParams};

pub struct MockBackend {
    tx: Sender<Event>,
    units: Arc<Vec<Arc<Vec<u8>>>>,
    fps: f64,
    link_after: f64,
    generation: Arc<AtomicU64>,
    keyreq: Arc<AtomicBool>,
    size: Mutex<(u16, u16)>,
}

/// Split Annex-B into access units: a VCL NAL whose first_mb_in_slice is 0 starts a new picture.
pub fn split_units(data: &[u8]) -> Vec<Vec<u8>> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut nals: Vec<&[u8]> = Vec::new();
    for (n, &st) in starts.iter().enumerate() {
        let mut end = if n + 1 < starts.len() { starts[n + 1] - 3 } else { data.len() };
        if end > st && data[end - 1] == 0 {
            end -= 1;
        }
        nals.push(&data[st..end]);
    }
    let mut units = Vec::new();
    let mut acc: Vec<u8> = Vec::new();
    let mut has_vcl = false;
    for u in nals {
        if u.is_empty() {
            continue;
        }
        let t = u[0] & 0x1f;
        let vcl = (1..=5).contains(&t);
        let first_mb0 = vcl && u.len() > 1 && (u[1] & 0x80) != 0;
        if vcl && has_vcl && first_mb0 {
            units.push(std::mem::take(&mut acc));
            has_vcl = false;
        }
        acc.extend_from_slice(&[0, 0, 0, 1]);
        acc.extend_from_slice(u);
        if vcl {
            has_vcl = true;
        }
    }
    if !acc.is_empty() {
        units.push(acc);
    }
    units
}

impl MockBackend {
    pub fn new(tx: Sender<Event>, file: &str, fps: f64, link_after: f64) -> std::io::Result<MockBackend> {
        let data = std::fs::read(file)?;
        let units: Vec<Arc<Vec<u8>>> = split_units(&data).into_iter().map(Arc::new).collect();
        if units.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "no access units"));
        }
        Ok(MockBackend {
            tx,
            units: Arc::new(units),
            fps,
            link_after,
            generation: Arc::new(AtomicU64::new(0)),
            keyreq: Arc::new(AtomicBool::new(false)),
            size: Mutex::new((768, 608)),
        })
    }
}

impl Backend for MockBackend {
    fn start(&self, p: &SessionParams) -> i32 {
        *self.size.lock().unwrap() = (p.w, p.h);
        // every start is a new generation; an older replay thread sees the change and quits (two
        // threads interleaving P-frames from different positions decode as garbage)
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, units, fps, link_after, generation, keyreq, size) = (self.tx.clone(), self.units.clone(), self.fps, self.link_after, self.generation.clone(), self.keyreq.clone(), *self.size.lock().unwrap());
        std::thread::spawn(move || {
            let alive = |g: &AtomicU64| g.load(Ordering::SeqCst) == gen;
            std::thread::sleep(Duration::from_millis(300));
            let _ = tx.send(Event::AppVersion("mock".into()));
            if link_after >= 0.0 {
                std::thread::sleep(Duration::from_secs_f64(link_after));
                if !alive(&generation) {
                    return;
                }
                let _ = tx.send(Event::PhoneConnect("Mock iPhone".into()));
                let _ = tx.send(Event::LinkUp);
                let _ = tx.send(Event::Foreground);
                std::thread::sleep(Duration::from_millis(500));
                let _ = tx.send(Event::VideoStart(size.0, size.1));
                // SPS/PPS prefix of the first unit as the codec-config event
                let first = &units[0];
                let mut cut = first.len();
                let mut i = 0;
                while i + 4 < first.len() {
                    if first[i] == 0 && first[i + 1] == 0 && first[i + 2] == 1 {
                        let t = first[i + 3] & 0x1f;
                        if (1..=5).contains(&t) {
                            cut = if i > 0 && first[i - 1] == 0 { i - 1 } else { i };
                            break;
                        }
                        i += 3;
                    } else {
                        i += 1;
                    }
                }
                let _ = tx.send(Event::SpsPps(Arc::new(first[..cut].to_vec())));
                let mut k = 0usize;
                let period = Duration::from_secs_f64(1.0 / fps.max(0.1));
                while alive(&generation) {
                    if keyreq.swap(false, Ordering::SeqCst) {
                        k = 0;
                    }
                    let _ = tx.send(Event::Unit(units[k % units.len()].clone()));
                    k += 1;
                    std::thread::sleep(period);
                }
                let _ = tx.send(Event::VideoStop);
                let _ = tx.send(Event::LinkDown);
            }
        });
        0
    }
    fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    fn touch(&self, m: i32, x: i32, y: i32) {
        eprintln!("mock touch {} {} {}", m, x, y);
    }
    fn key(&self, code: i32) {
        if code == 0x600 {
            self.keyreq.store(true, Ordering::SeqCst);
        } else {
            eprintln!("mock key {:#x}", code);
        }
    }
    fn untake_video(&self) {}
    fn take_video(&self) {}
    fn disconnect_phone(&self) {
        self.stop();
    }
    fn wifi(&self, ssid: &str, _psk: &str) {
        eprintln!("mock wifi {}", ssid);
    }
    fn night(&self, n: i32) {
        eprintln!("mock night {}", n);
    }
    fn bt(&self, op: &str, mac: &str) {
        eprintln!("mock bt {} {}", op, mac);
    }
}
