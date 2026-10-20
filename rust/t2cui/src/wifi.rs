//! The hotspot: `/tmp/hostapd.conf` from the rootfs template with our ssid/channel/password (what
//! lylinkui's `save_hostapd_conf` does), starting the daemon when it is not running (through
//! `hostapd` on PATH, i.e. the HT40 wrapper app/hostapd on the adapter), restarting it after a
//! channel or password change. The vendor library also gets the credentials (`lylinkapi_wifi`)
//! so lylinkapp can tell the iPhone over iAP.

use std::fs;

pub const TEMPLATE: &str = "/etc/wifi/hostapd.conf";
pub const CONF: &str = "/tmp/hostapd.conf";

/// lycfg byte 5 the way stock lylinkui's save_hostapd_conf (0x14ef0) reads it: 0 is "never set"
/// and becomes channel 6 (0x151f8 writes a literal '6': 2.4 GHz, hw_mode g), 0xff is "default"
/// and becomes 149 (0x15204). The phone page offers 6/36-48/149-165; anything else is treated as
/// the default too (stock would write the number as is and hostapd would refuse it).
pub fn stock_channel(raw: u8) -> u8 {
    match raw {
        0 => 6,
        0xff => 149,
        c if (1..=14).contains(&c) || (36..=165).contains(&c) => c,
        _ => 149,
    }
}

/// Stock drops the template's `ht_capab=` line for channels 8-14, 48 and >= 162
/// (0x1502c-0x1505c): `[HT40+]` has no partner there (165+4 does not exist) and this hostapd
/// does not fall back to 20 MHz on its own -- it dies after the 40 MHz scan.
pub fn stock_drops_ht_capab(ch: u8) -> bool {
    (8..=14).contains(&ch) || ch == 48 || ch >= 162
}

/// The config text from a template: ssid/channel/hw_mode/wpa_passphrase replaced, ht_capab
/// dropped by the stock rule -- or always with `plain`, the 20 MHz file of last resort.
pub fn render_with(tpl: &str, ssid: &str, raw_channel: u8, psk: &str, plain: bool) -> String {
    let ch = stock_channel(raw_channel);
    let drop_ht = plain || stock_drops_ht_capab(ch);
    let mut out = String::with_capacity(tpl.len() + 64);
    for line in tpl.lines() {
        let l = if line.starts_with("ssid=") {
            format!("ssid={}", ssid)
        } else if line.starts_with("channel=") {
            format!("channel={}", ch)
        } else if line.starts_with("wpa_passphrase=") {
            format!("wpa_passphrase={}", psk)
        } else if line.starts_with("hw_mode=") {
            format!("hw_mode={}", if ch > 14 { "a" } else { "g" })
        } else if drop_ht && line.starts_with("ht_capab=") {
            continue;
        } else {
            line.to_string()
        };
        out.push_str(&l);
        out.push('\n');
    }
    out
}

/// Write the config if it differs. Returns Some(changed) or None without a template.
pub fn write_conf(ssid: &str, channel: u8, psk: &str) -> Option<bool> {
    write_conf_opts(ssid, channel, psk, false)
}

/// `write_conf` with the choice of the plain (20 MHz) file.
pub fn write_conf_opts(ssid: &str, channel: u8, psk: &str, plain: bool) -> Option<bool> {
    let tpl = fs::read_to_string(TEMPLATE).ok()?;
    let text = render_with(&tpl, ssid, channel, psk, plain);
    if fs::read_to_string(CONF).map(|cur| cur == text).unwrap_or(false) {
        return Some(false);
    }
    let tmp = format!("{}.tmp", CONF);
    if fs::write(&tmp, &text).is_err() || fs::rename(&tmp, CONF).is_err() {
        return None;
    }
    Some(true)
}

/// `-B` returned, but the daemon can still refuse the channel after its 40 MHz scan: poll for it.
pub fn wait_running(secs: u64) -> bool {
    for _ in 0..secs {
        if running() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    running()
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

#[cfg(test)]
mod tests {
    use super::*;
    const TPL: &str = "interface=wlan0\nssid=smartLinkBox\nchannel=36\nwpa_passphrase=88888888\nhw_mode=a\nht_capab=[SHORT-GI-20][SHORT-GI-40][HT40+]\nmax_num_sta=8\n";

    fn line(conf: &str, key: &str) -> Option<String> {
        conf.lines().find(|l| l.starts_with(key)).map(|l| l.to_string())
    }

    #[test]
    fn stock_channel_rules() {
        assert_eq!(stock_channel(0), 6);
        assert_eq!(stock_channel(0xff), 149);
        assert_eq!(stock_channel(149), 149);
        assert_eq!(stock_channel(165), 165);
        assert_eq!(stock_channel(200), 149);
    }

    #[test]
    fn renders_like_stock() {
        let c = render_with(TPL, "AutoKit_051E", 0xff, "88888888", false);
        assert_eq!(line(&c, "ssid=").unwrap(), "ssid=AutoKit_051E");
        assert_eq!(line(&c, "channel=").unwrap(), "channel=149");
        assert_eq!(line(&c, "hw_mode=").unwrap(), "hw_mode=a");
        assert_eq!(line(&c, "wpa_passphrase=").unwrap(), "wpa_passphrase=88888888");
        assert!(line(&c, "ht_capab=").is_some(), "149 keeps HT40+");
        assert!(line(&c, "max_num_sta=").is_some());
        let c = render_with(TPL, "x", 0, "p", false);
        assert_eq!(line(&c, "channel=").unwrap(), "channel=6");
        assert_eq!(line(&c, "hw_mode=").unwrap(), "hw_mode=g");
        assert!(line(&c, "ht_capab=").is_some(), "6 keeps HT40+ like stock");
        for ch in [8u8, 14, 48, 165] {
            let c = render_with(TPL, "x", ch, "p", false);
            assert!(line(&c, "ht_capab=").is_none(), "stock drops ht_capab on {}", ch);
        }
        let c = render_with(TPL, "x", 149, "p", true);
        assert!(line(&c, "ht_capab=").is_none(), "plain file never carries HT40");
    }
}
