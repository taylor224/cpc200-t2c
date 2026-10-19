//! Tiny file logger: one line per event, the file is kept under 64 KB (the last 32 KB survive a
//! rotation). Never panics on I/O: a daemon with `panic = "abort"` must not die because stderr
//! went away or the flash is full. Without a path, lines go to stderr.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

pub struct Logger {
    path: Option<PathBuf>,
    file: Mutex<Option<File>>,
    pub debug: bool,
}

const CAP: u64 = 64 * 1024;
const KEEP: usize = 32 * 1024;

fn open_append(p: &PathBuf) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(p).ok()
}

impl Logger {
    pub fn new(path: Option<PathBuf>, debug: bool) -> Logger {
        let file = path.as_ref().and_then(open_append);
        Logger {
            path,
            file: Mutex::new(file),
            debug,
        }
    }

    fn stamp() -> String {
        // The adapter has no RTC: uptime is the useful clock, wall time only once the phone set it.
        let up = fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|s| s.split_whitespace().next().map(|v| v.to_string()))
            .unwrap_or_else(|| "-".to_string());
        let secs = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
        format!("{:02}:{:02}:{:02} up={}", h, m, s, up)
    }

    pub fn log(&self, msg: &str) {
        let line = format!("{} {}\n", Self::stamp(), msg);
        let Some(path) = self.path.as_ref() else {
            let _ = std::io::stderr().lock().write_all(line.as_bytes());
            return;
        };
        let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
        // deleted or replaced underneath us (log cleared by hand): start a new file
        if guard.is_none() || !path.exists() {
            *guard = open_append(path);
        }
        if let Some(f) = guard.as_mut() {
            let _ = f.write_all(line.as_bytes());
            if f.metadata().map(|m| m.len() > CAP).unwrap_or(false) {
                *guard = self.rotate(path);
            }
        }
    }

    pub fn dbg(&self, msg: &str) {
        if self.debug {
            self.log(msg);
        }
    }

    /// Keep the last KEEP bytes (from a line boundary) via a temp file + rename, reopen for append.
    fn rotate(&self, path: &PathBuf) -> Option<File> {
        if let Ok(data) = fs::read(path) {
            let start = if data.len() > KEEP {
                let cut = data.len() - KEEP;
                data[cut..]
                    .iter()
                    .position(|&b| b == b'\n')
                    .map(|i| cut + i + 1)
                    .unwrap_or(cut)
            } else {
                0
            };
            let tmp = path.with_extension("tmp");
            if fs::write(&tmp, &data[start..]).is_ok() && fs::rename(&tmp, path).is_ok() {
                return open_append(path);
            }
            let _ = fs::remove_file(&tmp);
        }
        // could not rotate (flash full?): truncate rather than grow without bound
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .ok()
    }
}
