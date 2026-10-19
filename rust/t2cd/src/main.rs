//! t2cd — Carlinkit T2C sidecar. First job: a DNS forwarder for the car so `carplay.internal` /
//! `setting.internal` resolve whatever resolver the car picked (see forward.rs), plus the nat rule
//! that redirects the car's DNS here. Static musl binary, no dependencies; started by app/blink.sh
//! (an uploaded /tmp/t2cd (bench, gone at reboot) takes precedence over the one in the firmware), restarted by
//! app/t2c_watchdog.sh, which t2cd restarts in turn when it is missing.
//!
//!   t2cd [--port 5300] [--tesla-ip 101.200.208.6] [--settings-ip 192.168.3.1] [--upstream IP[:PORT]]...
//!        [--timeout-ms 2500] [--no-iptables] [--no-supervise] [--no-shell] [--shell-port 2323]
//!        [--online|--offline] [--log /tmp/t2cd.log] [--debug]
//!
//! /mnt/UDISK/t2c_dnsredir_off removes the nat rule (the forwarder keeps answering on its port);
//! /mnt/UDISK/t2c_dnsdebug logs every query; /mnt/UDISK/t2c_shell opens the debug shell (shell.rs,
//! tools/shell.py). A panic is logged with its location, then the
//! process aborts (panic = "abort") and the watchdog brings it back.

mod dns;
mod forward;
mod iptables;
mod log;
mod shell;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

const OFF_FLAG: &str = "/mnt/UDISK/t2c_dnsredir_off";
const DEBUG_FLAG: &str = "/mnt/UDISK/t2c_dnsdebug";
/// Bench builds may move the shell flag (T2CD_SHELL_FLAG=/path at compile time), e.g. onto a flag an
/// older firmware's CGI can already write.
const SHELL_FLAG: &str = match option_env!("T2CD_SHELL_FLAG") {
    Some(p) => p,
    None => "/mnt/UDISK/t2c_shell",
};
const WATCHDOG: &str = "/mnt/customer/app/t2c_watchdog.sh";

static LOG: OnceLock<Arc<log::Logger>> = OnceLock::new();

/// Name gocsdk was started with (`-N<name>`), needed to relaunch the watchdog with the same argument.
fn bt_name() -> Option<String> {
    let dir = std::fs::read_dir("/proc").ok()?;
    for e in dir.flatten() {
        let p = e.path();
        if !p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or(false)
        {
            continue;
        }
        if let Ok(cmd) = std::fs::read(p.join("cmdline")) {
            let parts: Vec<&[u8]> = cmd.split(|&b| b == 0).collect();
            if parts
                .first()
                .map(|a| a.ends_with(b"gocsdk"))
                .unwrap_or(false)
            {
                for a in &parts[1..] {
                    if a.starts_with(b"-N") {
                        return String::from_utf8(a[2..].to_vec()).ok();
                    }
                }
            }
        }
    }
    None
}

fn process_running(needle: &str) -> bool {
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for e in dir.flatten() {
            if let Ok(cmd) = std::fs::read(e.path().join("cmdline")) {
                if cmd.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                    return true;
                }
            }
        }
    }
    false
}

/// Mutual supervision: the shell watchdog restarts t2cd; t2cd restarts the watchdog (rate-limited).
fn supervise(log: Arc<log::Logger>) {
    thread::Builder::new()
        .name("supervise".into())
        .spawn(move || {
            let mut relaunches: Vec<std::time::Instant> = Vec::new();
            loop {
                thread::sleep(Duration::from_secs(60));
                if !Path::new(WATCHDOG).exists() || process_running("t2c_watchdog.sh") {
                    continue;
                }
                let now = std::time::Instant::now();
                relaunches.retain(|t| now.duration_since(*t) < Duration::from_secs(3600));
                if relaunches.len() >= 6 {
                    continue;
                }
                let Some(name) = bt_name() else {
                    log.log("watchdog missing but gocsdk's name unknown: not relaunching it");
                    continue;
                };
                relaunches.push(now);
                log.log(&format!(
                    "watchdog missing, relaunching ({} this hour)",
                    relaunches.len()
                ));
                let _ = std::process::Command::new("/bin/sh")
                    .arg(WATCHDOG)
                    .arg(&name)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
        })
        .expect("spawn");
}

fn main() {
    let mut port: u16 = 5300;
    let mut tesla_ip = Ipv4Addr::new(101, 200, 208, 6);
    let mut settings_ip = Ipv4Addr::new(192, 168, 3, 1);
    let mut upstreams: Vec<SocketAddr> = Vec::new();
    let mut timeout = Duration::from_millis(2500);
    let mut use_iptables = true;
    let mut use_supervise = true;
    let mut use_shell = true;
    let mut shell_port: u16 = shell::DEFAULT_PORT;
    let mut force_online: Option<bool> = None;
    let mut logpath: Option<PathBuf> = Some(PathBuf::from("/tmp/t2cd.log"));
    let mut debug = Path::new(DEBUG_FLAG).exists();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || {
            args.next().unwrap_or_else(|| {
                eprintln!("missing value for {}", a);
                std::process::exit(2)
            })
        };
        match a.as_str() {
            "--port" => port = val().parse().expect("port"),
            "--tesla-ip" => tesla_ip = val().parse().expect("ip"),
            "--settings-ip" => settings_ip = val().parse().expect("ip"),
            "--upstream" => {
                let v = val();
                let sa: SocketAddr = if v.contains(':') {
                    v.parse().expect("ip:port")
                } else {
                    SocketAddr::new(v.parse::<Ipv4Addr>().expect("ip").into(), 53)
                };
                upstreams.push(sa);
            }
            "--timeout-ms" => timeout = Duration::from_millis(val().parse().expect("ms")),
            "--no-iptables" => use_iptables = false,
            "--no-supervise" => use_supervise = false,
            "--no-shell" => use_shell = false,
            "--shell-port" => shell_port = val().parse().expect("port"),
            "--online" => force_online = Some(true),
            "--offline" => force_online = Some(false),
            "--log" => {
                let v = val();
                logpath = if v == "-" {
                    None
                } else {
                    Some(PathBuf::from(v))
                };
            }
            "--debug" => debug = true,
            "-h" | "--help" => {
                eprintln!("see the comment at the top of main.rs");
                return;
            }
            other => {
                eprintln!("unknown option {}", other);
                std::process::exit(2);
            }
        }
    }
    let log = Arc::new(log::Logger::new(logpath, debug));
    let _ = LOG.set(Arc::clone(&log));
    std::panic::set_hook(Box::new(|info| {
        let msg = match info.payload().downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None => info
                .payload()
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "?".to_string()),
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        if let Some(l) = LOG.get() {
            l.log(&format!(
                "PANIC at {}: {} (aborting; the watchdog restarts t2cd)",
                loc, msg
            ));
        }
    }));
    log.log(&format!(
        "t2cd {} starting (pid {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    let cfg = forward::Config {
        listen: SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port),
        tesla_ip,
        settings_ip,
        upstreams,
        timeout,
        force_online,
        table_ttl: 60,
    };
    let fwd = match forward::Forwarder::bind(cfg, Arc::clone(&log)) {
        Ok(f) => Arc::new(f),
        Err(e) => {
            log.log(&format!("cannot bind udp port {}: {}", port, e));
            std::process::exit(1);
        }
    };
    if use_iptables {
        iptables::keeper(
            iptables::Rule::new(port, "wlan0"),
            OFF_FLAG,
            Arc::clone(&log),
        );
    }
    if use_supervise {
        supervise(Arc::clone(&log));
    }
    if use_shell {
        shell::start(SHELL_FLAG, shell_port, settings_ip, Arc::clone(&log));
    }
    fwd.serve()
}
