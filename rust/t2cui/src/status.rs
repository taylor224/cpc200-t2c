//! Values for the init/status JSON and a few system actions. Everything here degrades to empty
//! strings or zeros off the adapter so the Mac build runs.

use std::fs;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Clone, Debug, Default)]
pub struct SysInfo {
    pub ssid: String,
    pub bt_name: String,
    pub sw: String,
    pub ly: String,
    pub hw: String,
    pub md: String,
    pub wifi_mac: String,
    pub icons: String,
}

fn hostapd_field(key: &str) -> String {
    let txt = fs::read_to_string("/tmp/hostapd.conf").unwrap_or_default();
    txt.lines().find_map(|l| l.strip_prefix(key)).unwrap_or("").trim().to_string()
}

/// The version string in /mnt/customer/app/system.json (the boot scripts take the 12th
/// quote-separated field; any value shaped like 26101706.1508.1 is it).
fn system_version() -> String {
    let txt = fs::read_to_string("/mnt/customer/app/system.json").unwrap_or_default();
    txt.split('"')
        .find(|s| {
            let parts: Vec<&str> = s.split('.').collect();
            parts.len() == 3 && parts[0].len() == 8 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
        .unwrap_or("")
        .to_string()
}

/// `{"tsl0": "Tesla", ...}` from www/icon.json (shipped with the page), else from the icon dir.
fn icons_json(www: &std::path::Path) -> String {
    if let Ok(s) = fs::read_to_string(www.join("icon.json")) {
        let t = s.trim();
        if t.starts_with('{') {
            return t.to_string();
        }
    }
    let mut names: Vec<String> = fs::read_dir(www.join("icon"))
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".png")).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    names.sort();
    format!("{{{}}}", names.iter().map(|n| format!("\"{}\": \"{}\"", n, n)).collect::<Vec<_>>().join(", "))
}

impl SysInfo {
    pub fn gather(www: &std::path::Path) -> SysInfo {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let mut ssid = env("WIFI_NAME");
        if ssid.is_empty() {
            ssid = hostapd_field("ssid=");
        }
        let mut bt_name = fs::read_to_string("/mnt/UDISK/t2c_name").map(|s| s.trim().to_string()).unwrap_or_default();
        if bt_name.is_empty() {
            bt_name = env("BT_NAME");
        }
        if bt_name.is_empty() {
            bt_name = ssid.clone();
        }
        let sw = system_version();
        let mut ly = env("LY_VERSION");
        if ly.is_empty() {
            ly = sw.clone();
        }
        let hw = fs::read_to_string("/tmp/ota/www/hw.json").map(|s| s.trim().to_string()).unwrap_or_default();
        let wifi_mac = fs::read_to_string("/sys/class/net/wlan0/address").map(|s| s.trim().replace(':', "")).unwrap_or_default();
        SysInfo { ssid, bt_name, sw, ly, hw, md: "TesPush-T2C".into(), wifi_mac, icons: icons_json(www) }
    }
}

static CPU: Mutex<Option<(Instant, u64, u64)>> = Mutex::new(None);

/// (cpu busy % since the last call, uptime seconds) for the status JSON's sys/exe slots.
pub fn cpu_and_uptime() -> (u32, u64) {
    let up = fs::read_to_string("/proc/uptime").ok().and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok())).unwrap_or(0.0) as u64;
    let stat = fs::read_to_string("/proc/stat").unwrap_or_default();
    let mut busy = 0u32;
    if let Some(line) = stat.lines().next() {
        let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 4 {
            let total: u64 = v.iter().sum();
            let idle = v[3] + v.get(4).copied().unwrap_or(0);
            let mut g = CPU.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((_, t0, i0)) = *g {
                let dt = total.saturating_sub(t0);
                if dt > 0 {
                    busy = (100 * dt.saturating_sub(idle.saturating_sub(i0)) / dt) as u32;
                }
            }
            *g = Some((Instant::now(), total, idle));
        }
    }
    (busy, up)
}

extern "C" {
    fn system(cmd: *const std::ffi::c_char) -> std::ffi::c_int;
}

/// `std::process::Command` pulls posix_spawn_file_actions_addchdir_np into the link, which the
/// adapter's musl does not have; the few shell commands we run go through system(3).
pub fn sh(cmd: &str) -> i32 {
    let Ok(c) = std::ffi::CString::new(cmd) else { return -1 };
    unsafe { system(c.as_ptr()) }
}

pub fn reboot() {
    std::thread::spawn(|| sh("sync; sleep 1; reboot"));
}

/// gocsdk's pairing file `/mnt/UDISK/bt_conf.ini`: `addrN=`/`nameN=` pairs, `lastaddr=`,
/// `autoconnect=`. Stock lylinkui asks gocsdk over its command channel; until P4 wires that up
/// the file is the source.
#[allow(dead_code)] // autoconnect is reported in /health only; the page flag lives in lycfg byte 552
pub struct BtConf {
    pub devices: Vec<(String, String)>,
    pub last: String,
    pub autoconnect: bool,
}

pub fn bt_conf() -> BtConf {
    let txt = fs::read_to_string("/mnt/UDISK/bt_conf.ini").unwrap_or_default();
    let mut addrs: Vec<(usize, String)> = Vec::new();
    let mut names: Vec<(usize, String)> = Vec::new();
    let mut last = String::new();
    let mut autoconnect = false;
    for line in txt.lines() {
        let Some((k, v)) = line.trim().split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim());
        if let Some(n) = k.strip_prefix("addr").and_then(|n| n.parse::<usize>().ok()) {
            addrs.push((n, v.to_uppercase()));
        } else if let Some(n) = k.strip_prefix("name").and_then(|n| n.parse::<usize>().ok()) {
            names.push((n, v.to_string()));
        } else if k == "lastaddr" {
            last = v.to_uppercase();
        } else if k == "autoconnect" {
            autoconnect = v == "1";
        }
    }
    let mut devices = Vec::new();
    for (n, a) in addrs {
        if a.len() == 12 {
            let name = names.iter().find(|(m, _)| *m == n).map(|(_, s)| s.clone()).unwrap_or_default();
            devices.push((a, name));
        }
    }
    BtConf { devices, last, autoconnect }
}

/// GET /tsl/bt: `<flag><12-hex mac><name>` strings, flag 1 for the phone gocsdk connected last.
pub fn bt_list() -> String {
    let c = bt_conf();
    let items: Vec<String> = c.devices.iter().map(|(a, n)| crate::protocol::js(&format!("{}{}{}", if *a == c.last { 1 } else { 0 }, a, n))).collect();
    format!("[{}]", items.join(","))
}

/// POST /tsl/fw stored /tmp/update.img the way stock does (tmp + rename); the stock updater picks
/// the file up on its own and reports through `ly_update_status` (sysfs), which the page gets as
/// type-4 `{val, pong}` messages from the ticker while an update is pending.
pub fn firmware_received(session: &crate::session::Session, path: &std::path::Path) {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    session.log.log(&format!("firmware image stored: {} ({} bytes); reporting ly_update_status to the page", path.display(), size));
    session.fw_pending.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// `ly_update_status=N` from the misc driver: 0 idle, 1-2 checking/writing, 3 done, >3 failure code.
pub fn update_status() -> i32 {
    let s = fs::read_to_string("/sys/class/misc/ly_misc_dev/ly/update").unwrap_or_default();
    s.trim().rsplit('=').next().and_then(|v| v.trim().parse().ok()).unwrap_or(0)
}
