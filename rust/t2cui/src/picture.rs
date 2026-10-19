//! Picture mode (MJPEG over `/video.jpg`): the phone's H.264 is decoded and re-encoded as JPEG
//! by the V831 through the vendor's `liblylinkav.so` -- the five `lylink_h264_*` calls stock
//! lylinkui makes (0x19fd0, 0x145f0, 0x1498c, 0x146f0). The library owns an Allwinner MPP decoder
//! and JPEG encoder on a thread of its own and hands every finished JPEG to `cb(0, data, len)`
//! (liblylinkav 0x223f8); we keep the newest frame in a slot and the `/video.jpg` writers wait
//! for it, so a slow car browser costs frames, never memory.
//!
//! Loaded with dlopen on first use: the library drags libasound/libcdx_*/libion/libhwdisplay
//! along (LD_LIBRARY_PATH from lyLoadModule.sh points at /tmp/lylink/eyesee-mpp, t2cui inherits
//! it), and the Mac build has none of that -- picture mode then reads "not available" and the
//! session keeps H.264.
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::log::Logger;

extern "C" {
    fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(h: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlerror() -> *const c_char;
}
const RTLD_NOW: c_int = 2;
const LIB: &str = "liblylinkav.so";

type InitFn = unsafe extern "C" fn() -> c_int;
type StartFn = unsafe extern "C" fn(*mut StartArgs) -> c_int;
type ProcessFn = unsafe extern "C" fn(*const u8, c_int) -> c_int;
type StopFn = unsafe extern "C" fn() -> c_int;
type JpegCb = extern "C" fn(*mut c_void, *const u8, c_int);

/// `lylink_h264_start` argument, 24 bytes, filled like lylinkui 0x145b4..0x145ec: +0 input kind
/// (0 = H.264 access units, 1 = raw frames), +4/+6 input size, +8/+10 output size (height
/// 16-aligned), +0xc the JPEG callback. The library logs the five values at start.
#[repr(C)]
struct StartArgs {
    kind: u32,
    w: u16,
    h: u16,
    out_w: u16,
    out_h: u16,
    cb: Option<JpegCb>,
    pad: [u32; 2],
}

struct Lib {
    init: InitFn,
    start: StartFn,
    process: ProcessFn,
    stop: StopFn,
}

/// Newest JPEG from the library thread; `seq` grows by one per frame so a writer can tell a
/// frame it has already sent from a fresh one.
struct Slot {
    seq: u64,
    frame: Option<Arc<Vec<u8>>>,
    frames: u64,
    bytes: u64,
    last: Option<Instant>,
}

static SLOT: Mutex<Slot> = Mutex::new(Slot { seq: 0, frame: None, frames: 0, bytes: 0, last: None });
static SLOT_CV: Condvar = Condvar::new();

extern "C" fn on_jpeg(_ctx: *mut c_void, data: *const u8, len: c_int) {
    if data.is_null() || len <= 2 {
        return;
    }
    let v = unsafe { std::slice::from_raw_parts(data, len as usize) }.to_vec();
    let mut s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    s.seq += 1;
    s.frames += 1;
    s.bytes += v.len() as u64;
    s.last = Some(Instant::now());
    s.frame = Some(Arc::new(v));
    SLOT_CV.notify_all();
}

pub struct Picture {
    log: Arc<Logger>,
    lib: OnceLock<Option<Lib>>,
    /// start/stop are serialised: the event pump, the ticker and a `/video.jpg` writer can all
    /// decide to start it in the same instant, and the library refuses a second start with -1
    op: Mutex<()>,
    inited: AtomicBool,
    running: AtomicBool,
    size: Mutex<(u16, u16)>,
    fail_until: Mutex<Option<Instant>>,
    starts: AtomicU64,
    fed: AtomicU64,
}

impl Picture {
    pub fn new(log: Arc<Logger>) -> Picture {
        Picture {
            log,
            lib: OnceLock::new(),
            op: Mutex::new(()),
            inited: AtomicBool::new(false),
            running: AtomicBool::new(false),
            size: Mutex::new((0, 0)),
            fail_until: Mutex::new(None),
            starts: AtomicU64::new(0),
            fed: AtomicU64::new(0),
        }
    }

    fn lib(&self) -> Option<&Lib> {
        self.lib
            .get_or_init(|| {
                let path = CString::new(LIB).unwrap();
                let h = unsafe { dlopen(path.as_ptr(), RTLD_NOW) };
                if h.is_null() {
                    let err = unsafe { dlerror() };
                    let msg = if err.is_null() { String::from("dlopen failed") } else { unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned() };
                    self.log.log(&format!("picture mode unavailable: {}: {}", LIB, msg));
                    return None;
                }
                let sym = |name: &str| -> *mut c_void {
                    let c = CString::new(name).unwrap();
                    unsafe { dlsym(h, c.as_ptr()) }
                };
                let (i, s, p, t) = (sym("lylink_h264_init"), sym("lylink_h264_start"), sym("lylink_h264_process"), sym("lylink_h264_stop"));
                if i.is_null() || s.is_null() || p.is_null() || t.is_null() {
                    self.log.log(&format!("picture mode unavailable: {} lacks the lylink_h264_* entry points", LIB));
                    return None;
                }
                self.log.log(&format!("picture mode: {} loaded", LIB));
                Some(unsafe {
                    Lib {
                        init: std::mem::transmute::<*mut c_void, InitFn>(i),
                        start: std::mem::transmute::<*mut c_void, StartFn>(s),
                        process: std::mem::transmute::<*mut c_void, ProcessFn>(p),
                        stop: std::mem::transmute::<*mut c_void, StopFn>(t),
                    }
                })
            })
            .as_ref()
    }

    /// True once the vendor library could be loaded (tries on the first call).
    pub fn available(&self) -> bool {
        self.lib().is_some()
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    pub fn size(&self) -> (u16, u16) {
        *self.size.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// False for a while after a failed start, so a broken codec is not retried every tick.
    pub fn can_try(&self) -> bool {
        match *self.fail_until.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(t) => Instant::now() >= t,
            None => true,
        }
    }

    fn back_off(&self) {
        *self.fail_until.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + Duration::from_secs(30));
    }

    /// Start the decoder/encoder pair for a session of `w`x`h`; the JPEGs come out the same size
    /// (height rounded down to 16, as stock does). The library wants SPS/PPS and an IDR next.
    pub fn start(&self, w: u16, h: u16) -> bool {
        let Some(lib) = self.lib() else { return false };
        if w == 0 || h == 0 {
            return false;
        }
        let _op = self.op.lock().unwrap_or_else(|e| e.into_inner());
        if self.running() {
            if self.size() == (w, h) {
                return true; // another thread got here first
            }
            self.stop_locked();
        }
        if !self.inited.load(Ordering::Relaxed) {
            let rc = unsafe { (lib.init)() };
            if rc != 0 {
                self.log.log(&format!("picture mode: lylink_h264_init -> {}", rc));
                self.back_off();
                return false;
            }
            self.inited.store(true, Ordering::Relaxed);
        }
        let mut a = StartArgs { kind: 0, w, h, out_w: w, out_h: h & !15, cb: Some(on_jpeg), pad: [0; 2] };
        let rc = unsafe { (lib.start)(&mut a) };
        if rc != 0 {
            self.log.log(&format!("picture mode: lylink_h264_start {}x{} -> {}", w, h, rc));
            self.back_off();
            return false;
        }
        *self.size.lock().unwrap_or_else(|e| e.into_inner()) = (w, h);
        self.running.store(true, Ordering::Relaxed);
        self.starts.fetch_add(1, Ordering::Relaxed);
        true
    }

    pub fn stop(&self) {
        let _op = self.op.lock().unwrap_or_else(|e| e.into_inner());
        self.stop_locked();
    }

    fn stop_locked(&self) {
        if !self.running.swap(false, Ordering::Relaxed) {
            return;
        }
        if let Some(lib) = self.lib() {
            let rc = unsafe { (lib.stop)() };
            if rc != 0 {
                self.log.log(&format!("picture mode: lylink_h264_stop -> {}", rc));
            }
        }
        let mut s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        s.frame = None;
        SLOT_CV.notify_all();
    }

    /// One access unit (or the SPS/PPS prefix) for the decoder. Event-pump thread.
    pub fn feed(&self, unit: &[u8]) {
        if !self.running() || unit.len() <= 5 {
            return;
        }
        if let Some(lib) = self.lib() {
            let rc = unsafe { (lib.process)(unit.as_ptr(), unit.len() as c_int) };
            if rc != 0 {
                self.log.dbg(&format!("picture mode: lylink_h264_process {} B -> {}", unit.len(), rc));
            } else {
                self.fed.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// The next frame after `after` (its sequence number and bytes), or None after `timeout`.
    pub fn wait_frame(&self, after: u64, timeout: Duration) -> Option<(u64, Arc<Vec<u8>>)> {
        let deadline = Instant::now() + timeout;
        let mut s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if s.seq > after {
                if let Some(f) = &s.frame {
                    return Some((s.seq, f.clone()));
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let (g, _) = SLOT_CV.wait_timeout(s, deadline - now).unwrap_or_else(|e| e.into_inner());
            s = g;
        }
    }

    pub fn health_json(&self) -> String {
        let s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
        let (w, h) = self.size();
        format!(
            "{{\"available\": {}, \"running\": {}, \"size\": [{}, {}], \"starts\": {}, \"fed\": {}, \"frames\": {}, \"bytes\": {}, \"last_ms\": {}}}",
            self.lib.get().map(|l| l.is_some()).unwrap_or(false),
            self.running(),
            w,
            h,
            self.starts.load(Ordering::Relaxed),
            self.fed.load(Ordering::Relaxed),
            s.frames,
            s.bytes,
            s.last.map(|t| t.elapsed().as_millis() as i64).unwrap_or(-1)
        )
    }
}
