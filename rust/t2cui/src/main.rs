//! t2cui: the Tesla-browser UI server for the Carlinkit T2C adapter -- what `lylinkui` does,
//! in Rust: HTTP for the page, the "tsl" WebSocket protocol, settings, and the CarPlay session
//! through the vendor library (`vendor.rs`, adapter only) or a replayed H.264 file (`--mock`).
//!
//!   t2cui [--www DIR] [--port 80] [--bind 0.0.0.0] [--cfg /mnt/UDISK/lycfg.txt] [--log FILE]
//!         [--mock FILE.h264 [--mock-fps 30] [--mock-link-after 2]] [--debug]
//!
//! See docs/REWRITE-PLAN.md (P3) and rust/README.md.

mod config;
mod gocsdk;
mod http;
mod leds;
mod log;
mod mock;
mod picture;
mod protocol;
mod session;
mod sha1;
mod status;
#[cfg(all(target_os = "linux", target_arch = "arm"))]
mod vendor;
mod wifi;
mod ws;

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut www = PathBuf::from(if std::path::Path::new("/tmp/lylink/www").is_dir() { "/tmp/lylink/www" } else { "/mnt/customer/app/www" });
    let mut port: u16 = 80;
    // stock lylinkui listens on the Tesla-UI alias only (busybox httpd has 192.168.3.1:80)
    let on_device = std::path::Path::new("/tmp/lylink/www").is_dir();
    let mut bind = String::from(if on_device { "101.200.208.6" } else { "0.0.0.0" });
    let mut cfg_path = PathBuf::from("/mnt/UDISK/lycfg.txt");
    let mut log_path: Option<PathBuf> = None;
    let mut mock: Option<String> = None;
    let mut mock_fps = 30.0f64;
    let mut mock_link_after = 2.0f64;
    let mut debug = false;
    let mut fw_path = PathBuf::from("/tmp/update.img");
    let mut wifi_handoff = on_device; // write /tmp/hostapd.conf, start hostapd if needed, tell the library
    let mut bt_glue = on_device; // own /dev/goc_serial: Bluetooth PAN (internet through the phone)
    // a second listener reachable by plain IP (http://192.168.3.1:8080/): the Tesla-UI alias needs
    // the adapter's DNS or a route, which a Mac with a wired interface does not have
    let mut bind2 = if on_device { String::from("0.0.0.0:8080") } else { String::new() };
    while let Some(k) = args.next() {
        let mut val = || args.next().unwrap_or_default();
        match k.as_str() {
            "--www" => www = PathBuf::from(val()),
            "--port" => port = val().parse().unwrap_or(80),
            "--bind" => bind = val(),
            "--cfg" => cfg_path = PathBuf::from(val()),
            "--log" => log_path = Some(PathBuf::from(val())),
            "--mock" => mock = Some(val()),
            "--mock-fps" => mock_fps = val().parse().unwrap_or(30.0),
            "--mock-link-after" => mock_link_after = val().parse().unwrap_or(2.0),
            "--fw" => fw_path = PathBuf::from(val()),
            "--wifi-handoff" => wifi_handoff = val() != "0",
            "--gocsdk" => bt_glue = val() != "0",
            "--bind2" => bind2 = val(),
            "--debug" => debug = true,
            "-h" | "--help" => {
                eprintln!("t2cui [--www DIR] [--port 80] [--bind IP] [--cfg lycfg.txt] [--log FILE] [--mock FILE.h264 [--mock-fps N] [--mock-link-after S]] [--debug]");
                return;
            }
            _ => {
                eprintln!("unknown option {}", k);
                std::process::exit(2);
            }
        }
    }
    let log = Arc::new(log::Logger::new(log_path, debug));
    let cfg = config::Cfg::load(&cfg_path);
    let info = status::SysInfo::gather(&www);
    let (tx, rx) = session::event_channel();
    let backend: Box<dyn session::Backend> = match mock {
        Some(file) => match mock::MockBackend::new(tx, &file, mock_fps, mock_link_after) {
            Ok(b) => Box::new(b),
            Err(e) => {
                eprintln!("mock {}: {}", file, e);
                std::process::exit(1);
            }
        },
        None => {
            #[cfg(all(target_os = "linux", target_arch = "arm"))]
            {
                vendor::install_crash_reporter();
                Box::new(vendor::VendorBackend::new(tx))
            }
            #[cfg(not(all(target_os = "linux", target_arch = "arm")))]
            {
                drop(tx);
                eprintln!("no vendor library on this host: use --mock FILE.h264");
                std::process::exit(1);
            }
        }
    };
    let session = session::Session::new(log.clone(), backend, cfg, info);
    log.log(&format!("t2cui start: www={} cfg={} ssid={} bt={} sw={}", www.display(), cfg_path.display(), session.info.ssid, session.info.bt_name, session.info.sw));
    session::pump(session.clone(), rx);
    // the CarPlay session starts at once (a phone may connect before any page opens)
    session.apply_icon();
    session.start_session("boot");
    if wifi_handoff {
        session.wifi_handoff(false);
    }
    if bt_glue {
        if let Some(g) = gocsdk::Gocsdk::start(log.clone()) {
            *session.gocsdk.lock().unwrap_or_else(|e| e.into_inner()) = Some(g);
        }
    }
    let ticker = session.clone();
    std::thread::Builder::new()
        .name("tick".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            ticker.tick();
        })
        .expect("thread");
    // at boot the Tesla-UI alias and port 80 can still be busy for a moment (first start failed with
    // "Address in use" at 9 s uptime on 2026-10-19): retry for a minute before giving up
    let listener = {
        let mut tries = 0;
        loop {
            match TcpListener::bind((bind.as_str(), port)) {
                Ok(l) => break l,
                Err(e) => {
                    tries += 1;
                    if tries == 1 || tries % 10 == 0 {
                        log.log(&format!("bind {}:{}: {} (retrying)", bind, port, e));
                    }
                    if tries >= 60 {
                        log.log("bind failed for 60 s, giving up");
                        std::process::exit(1);
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    };
    log.log(&format!("listening on {}:{}", bind, port));
    if let Some(l) = leds::Leds::open() {
        *session.leds.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(l));
        log.log("leds: sysfs control (wifi/link/model)");
    }
    let http = Arc::new(http::Http { www, session, fw_path });
    if !bind2.is_empty() && bind2 != "0" {
        match TcpListener::bind(&bind2) {
            Ok(l2) => {
                log.log(&format!("listening on {} too", bind2));
                let h2 = http.clone();
                let _ = std::thread::Builder::new().name("http2".into()).spawn(move || h2.serve(l2));
            }
            Err(e) => log.log(&format!("bind {}: {} (second listener skipped)", bind2, e)),
        }
    }
    http.serve(listener);
}
