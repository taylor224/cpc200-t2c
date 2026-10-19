//! The hotspot: `/tmp/hostapd.conf` from the rootfs template with our ssid/channel/password (what
//! lylinkui's `save_hostapd_conf` does), starting the daemon when it is not running (through
//! `hostapd` on PATH, i.e. the HT40 wrapper app/hostapd on the adapter), restarting it after a
//! channel or password change. The vendor library also gets the credentials (`lylinkapi_wifi`)
//! so lylinkapp can tell the iPhone over iAP.

use std::fs;

pub const TEMPLATE: &str = "/etc/wifi/hostapd.conf";
pub const CONF: &str = "/tmp/hostapd.conf";

/// Render the config. Returns the text, or None when there is no template (Mac).
pub fn render(ssid: &str, channel: u8, psk: &str) -> Option<String> {
    let tpl = fs::read_to_string(TEMPLATE).ok()?;
    let mut out = String::with_capacity(tpl.len() + 64);
    // lycfg byte 5 is 0xff for "default" (the T2C default is 149; stock wrote 149 as 0xff), and the
    // phone page only offers 6/36-48/149-165: anything else falls back to the default
    let ch = if (1..=14).contains(&channel) || (36..=165).contains(&channel) { channel } else { 149 };
    for line in tpl.lines() {
        let l = if line.starts_with("ssid=") {
            format!("ssid={}", ssid)
        } else if line.starts_with("channel=") {
            format!("channel={}", ch)
        } else if line.starts_with("wpa_passphrase=") {
            format!("wpa_passphrase={}", psk)
        } else if line.starts_with("hw_mode=") {
            format!("hw_mode={}", if ch >= 36 { "a" } else { "g" })
        } else {
            line.to_string()
        };
        out.push_str(&l);
        out.push('\n');
    }
    Some(out)
}

/// Write the config if it differs. Returns Some(changed) or None without a template.
pub fn write_conf(ssid: &str, channel: u8, psk: &str) -> Option<bool> {
    let text = render(ssid, channel, psk)?;
    if fs::read_to_string(CONF).map(|cur| cur == text).unwrap_or(false) {
        return Some(false);
    }
    let tmp = format!("{}.tmp", CONF);
    if fs::write(&tmp, &text).is_err() || fs::rename(&tmp, CONF).is_err() {
        return None;
    }
    Some(true)
}

/// A real `hostapd ... -B /tmp/hostapd.conf` process (not the wrapper's monitor, not a shell).
pub fn running() -> bool {
    let Ok(rd) = fs::read_dir("/proc") else { return false };
    for e in rd.flatten() {
        let name = e.file_name();
        let Some(pid) = name.to_str() else { continue };
        if !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(cmd) = fs::read(format!("/proc/{}/cmdline", pid)) else { continue };
        let args: Vec<&[u8]> = cmd.split(|&b| b == 0).filter(|a| !a.is_empty()).collect();
        if args.len() >= 3 && args[0].ends_with(b"hostapd") && args.iter().any(|a| *a == b"-B") && args.iter().any(|a| a.starts_with(b"/tmp/hostapd")) {
            // the wrapper script runs as "sh app/hostapd" (args[0] is the shell); the daemon's argv[0] is hostapd
            if !args[0].ends_with(b"sh") {
                return true;
            }
        }
    }
    false
}

pub fn start() -> i32 {
    crate::status::sh(&format!("hostapd -B {} </dev/null >/dev/null 2>&1", CONF))
}

#[allow(dead_code)] // kept as the fallback when no vendor library restarts hostapd for us
pub fn restart() -> i32 {
    // the wrapper's monitor shares the comm name, killall takes both; the relaunch goes through the wrapper again
    crate::status::sh(&format!("killall hostapd 2>/dev/null; sleep 1; hostapd -B {} </dev/null >/dev/null 2>&1", CONF))
}

/// Is a process whose argv[0] ends with `name` running? (busybox pidof is fine too, but this needs no fork)
pub fn running_cmd(name: &str) -> bool {
    let Ok(rd) = fs::read_dir("/proc") else { return false };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().map(|s| s.to_string()) else { continue };
        if !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(cmd) = fs::read(format!("/proc/{}/cmdline", pid)) {
            if let Some(a0) = cmd.split(|&b| b == 0).next() {
                if a0.ends_with(name.as_bytes()) {
                    return true;
                }
            }
        }
    }
    false
}
