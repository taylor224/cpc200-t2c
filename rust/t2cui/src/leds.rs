//! The three status LEDs: sysfs attributes of the ly_misc driver, value `0xRRGGBB` (mapped on the
//! bench with the user watching, 2026-10-19: `wifi_led` = the Wi-Fi LED, `link_led` = the device
//! LED, `model_led` = the antenna LED; 0x4000 green, 0x40 blue, 0x400000 red, 0 off; the value is
//! also the brightness). The power LED (`sys_led`) is left to the hardware. Stock shows Wi-Fi and
//! device green and the antenna blue while a phone is attached. The ioctls 0x4c00-0x4c02 that
//! lylinkui uses return 0 but change nothing visible on this unit -- sysfs it is.

use std::sync::Mutex;

pub const DIR: &str = "/sys/class/misc/ly_misc_dev/ly";
pub const GREEN: u32 = 0x4000;
pub const BLUE: u32 = 0x40;
#[allow(dead_code)]
pub const RED: u32 = 0x400000;
pub const OFF: u32 = 0;

pub struct Leds {
    last: Mutex<[Option<u32>; 3]>,
}

pub const NAMES: [&str; 3] = ["wifi_led", "link_led", "model_led"];

impl Leds {
    pub fn open() -> Option<Leds> {
        if !std::path::Path::new(DIR).join("wifi_led").exists() {
            return None;
        }
        Some(Leds { last: Mutex::new([None; 3]) })
    }

    pub fn set_raw(&self, name: &str, value: u32) -> bool {
        std::fs::write(format!("{}/{}", DIR, name), format!("0x{:x}\n", value)).is_ok()
    }

    /// Write only on change (the driver re-applies PWM on every write).
    pub fn set(&self, idx: usize, value: u32) {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if idx < 3 && last[idx] != Some(value) {
            if self.set_raw(NAMES[idx], value) {
                last[idx] = Some(value);
            }
        }
    }

    /// wifi: AP up; device: phone session; antenna: Bluetooth connected.
    pub fn apply(&self, ap_up: bool, phone_linked: bool, bt_connected: bool) {
        self.set(0, if ap_up { GREEN } else { OFF });
        self.set(1, if phone_linked { GREEN } else { OFF });
        self.set(2, if bt_connected { BLUE } else { OFF });
    }
}
