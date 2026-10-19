//! `/mnt/UDISK/lycfg.txt`: lylinkui's 556-byte settings blob (NOTES › Settings file), read and
//! written whole so t2c.cgi and the stock binary keep understanding it. Layout as stock's KEY
//! handlers store it (lycfg offset = lylinkui g offset - 0x458): +0 night, +1 pixel, +2 driver,
//! +5 channel, +6 language (0xff = auto), +7 bt modem, +8 psk[12], +20 name[12], +32 icon[12],
//! +548 fps flag, +550 mode (1 = H.264), +552 auto-connect. The online-check flag is RAM-only in
//! stock; it lives in a small sidecar here (which a flash wipes, like every t2c_* file).

use std::fs;
use std::path::{Path, PathBuf};

pub const SIZE: usize = 556;

#[derive(Clone)]
pub struct Cfg {
    pub raw: [u8; SIZE],
    pub path: PathBuf,
    // sidecar (t2cui's own): the online-check flag (stock keeps it in RAM only)
    pub online: bool,
    pub side: PathBuf,
}

fn field_str(b: &[u8]) -> String {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).into_owned()
}

impl Cfg {
    pub fn defaults(path: &Path) -> Cfg {
        let mut raw = [0u8; SIZE];
        raw[0] = 0; // night: day
        raw[1] = 3; // pixel: auto
        raw[2] = 0; // driver
        raw[3] = 0x4d;
        raw[4] = 0x3c;
        raw[5] = 149; // channel
        raw[6] = 0xff; // language: auto
        raw[8..8 + 8].copy_from_slice(b"88888888");
        raw[20..24].copy_from_slice(b"Auto");
        raw[550] = 1; // mode: H.264 video
        raw[552] = 1; // auto-connect
        let side = path.with_file_name("t2c_ui.cfg");
        Cfg { raw, path: path.to_path_buf(), online: true, side }
    }

    pub fn load(path: &Path) -> Cfg {
        let mut c = Cfg::defaults(path);
        if let Ok(d) = fs::read(path) {
            if d.len() >= 548 {
                let n = d.len().min(SIZE);
                c.raw[..n].copy_from_slice(&d[..n]);
            }
        }
        if let Ok(s) = fs::read_to_string(&c.side) {
            for line in s.lines() {
                if let Some((k, v)) = line.split_once('=') {
                    match k.trim() {
                        "online" => c.online = v.trim() == "1",
                        _ => {}
                    }
                }
            }
        }
        c
    }

    pub fn save(&self) -> std::io::Result<()> {
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, self.raw)?;
        fs::rename(&tmp, &self.path)?;
        let side = format!("online={}\n", self.online as u8);
        let tmp = self.side.with_extension("tmp");
        fs::write(&tmp, side)?;
        fs::rename(&tmp, &self.side)
    }

    pub fn night(&self) -> u8 {
        self.raw[0]
    }
    pub fn set_night(&mut self, v: u8) {
        self.raw[0] = v;
    }
    pub fn pixel(&self) -> u8 {
        self.raw[1]
    }
    pub fn set_pixel(&mut self, v: u8) {
        self.raw[1] = v;
    }
    pub fn driver(&self) -> u8 {
        self.raw[2]
    }
    pub fn set_driver(&mut self, v: u8) {
        self.raw[2] = v;
    }
    pub fn channel(&self) -> u8 {
        self.raw[5]
    }
    pub fn set_channel(&mut self, v: u8) {
        self.raw[5] = v;
    }
    /// Language for the template engine / page hint: 0 zh-CN, 1 zh-TW, 2 en, 3 = auto (0xff in the file).
    pub fn lang(&self) -> u8 {
        if self.raw[6] > 2 { 3 } else { self.raw[6] }
    }
    pub fn set_lang(&mut self, v: u8) {
        self.raw[6] = if v > 2 { 0xff } else { v };
    }
    pub fn fps(&self) -> u8 {
        self.raw[548]
    }
    pub fn set_fps(&mut self, v: u8) {
        self.raw[548] = v;
    }
    pub fn psk(&self) -> String {
        field_str(&self.raw[8..20])
    }
    /// At most 11 characters, always NUL-terminated (the stock bug let 12 run into the name).
    pub fn set_psk(&mut self, s: &str) {
        let b = s.as_bytes();
        let n = b.len().min(11);
        self.raw[8..20].fill(0);
        self.raw[8..8 + n].copy_from_slice(&b[..n]);
    }
    pub fn name(&self) -> String {
        field_str(&self.raw[20..32])
    }
    pub fn set_name(&mut self, b: &[u8]) {
        let n = b.len().min(12);
        self.raw[20..32].fill(0);
        self.raw[20..20 + n].copy_from_slice(&b[..n]);
    }
    pub fn icon(&self) -> String {
        field_str(&self.raw[32..44])
    }
    pub fn set_icon(&mut self, s: &str) {
        let b = s.as_bytes();
        let n = b.len().min(12);
        self.raw[32..44].fill(0);
        self.raw[32..32 + n].copy_from_slice(&b[..n]);
    }
    /// Bluetooth modem (page key 8 sends 1 off / 2 on, stock stores the value as is at +7).
    pub fn btnet(&self) -> bool {
        self.raw[7] == 2
    }
    pub fn set_btnet(&mut self, v: bool) {
        self.raw[7] = if v { 2 } else { 1 };
    }
    pub fn mode(&self) -> u8 {
        self.raw[550]
    }
    /// Auto-connect (page CMD 1/2): stock keeps it at +552 (lylinkui g+0x680); 0 = off.
    pub fn auto(&self) -> bool {
        self.raw[552] != 0
    }
    pub fn set_auto(&mut self, v: bool) {
        self.raw[552] = v as u8;
    }
    pub fn set_mode(&mut self, v: u8) {
        self.raw[550] = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn psk_and_name_bounds() {
        let mut c = Cfg::defaults(Path::new("/tmp/x"));
        c.set_psk("twelve-chars");
        assert_eq!(c.psk(), "twelve-char");
        assert_eq!(c.name(), "Auto");
        c.set_name(b"My Tesla Car!!!");
        assert_eq!(c.name(), "My Tesla Car");
        assert_eq!(c.channel(), 149);
    }
}
