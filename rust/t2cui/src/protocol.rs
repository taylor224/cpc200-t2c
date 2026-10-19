//! The "tsl" WebSocket protocol between the Tesla-browser page (src/www/js/protocol.js) and the
//! adapter. Client -> server: `Int16 [length, type]` + payload. Server -> client: `Uint32 [length,
//! type]` + payload. Both little endian.

use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub enum ClientMsg {
    /// type 2: [w, h] + lang\0 + navigator-string\0
    Hello { w: u16, h: u16, lang: String, nav: String },
    /// type 1: [m, x, y]  m 0 down / 2 move / 1 up, x y in 0..1000
    Touch { m: i16, x: i16, y: i16 },
    /// type 3: [cmd]  0 video, 1/2 auto on/off, 5 bt list, 6 disconnect, 7 factory reset, 8 key frame, 9 QR
    Cmd(i16),
    /// type 7: [key, value]  1 night 2 pixel 3 driver 6 channel 7 lang 8 btnet 9 fps 10 online 11 mode
    SetKey { key: i16, value: i16 },
    /// type 8: [n]  day/night hint for the iPhone
    Night(i16),
    /// type 10: 12-byte car name + icon id
    Identity { name: Vec<u8>, icon: String },
    /// type 11: [w, h] + u8 mm_w + u8 mm_h (w == 0 clears)
    Override { w: u16, h: u16, mm_w: u8, mm_h: u8 },
    /// type 12: Uint32 [0x000C0004, counter]
    Ping(u32),
    /// type 13: [key, mod]
    Key { key: i16, modifier: i16 },
    /// type 4/5/6: bt connect / disconnect / forget (mac string); type 9: wifi password
    BtConnect(String),
    BtDisconnect(String),
    BtForget(String),
    WifiPsk(String),
    Unknown(u16, usize),
}

pub const CMD_VIDEO: i16 = 0;
pub const CMD_AUTO_ON: i16 = 1;
pub const CMD_AUTO_OFF: i16 = 2;
pub const CMD_BTLIST: i16 = 5;
pub const CMD_DISCONNECT: i16 = 6;
pub const CMD_FACTORY_RESET: i16 = 7;
pub const CMD_KEYFRAME: i16 = 8;
pub const CMD_QR: i16 = 9;

pub const KEY_NIGHT: i16 = 1;
pub const KEY_PIXEL: i16 = 2;
pub const KEY_DRIVER: i16 = 3;
pub const KEY_CHANNEL: i16 = 6;
pub const KEY_LANG: i16 = 7;
pub const KEY_BTNET: i16 = 8;
pub const KEY_FPS: i16 = 9;
pub const KEY_ONLINE: i16 = 10;
pub const KEY_MODE: i16 = 11;

// server -> client message types
pub const S_STATUS: u32 = 0;
pub const S_INIT: u32 = 1;
pub const S_BTLIST: u32 = 2;
pub const S_LINK: u32 = 3;
pub const S_FW: u32 = 4; // firmware progress {val, pong} while an uploaded image is being installed
pub const S_RELOAD: u32 = 5; // page reload request (stock: language change; here: after a mode key)
pub const S_VIDEO: u32 = 100;
pub const S_VIDEO_FIRST: u32 = 101;
pub const S_VIDEO_MID: u32 = 102;
pub const S_VIDEO_LAST: u32 = 103;
pub const S_QR: u32 = 300;

/// Payload sizes as the patched lylinkui sends them (patch 7): one WebSocket message up to 65280
/// bytes of video, type 100 whenever the unit plus its 4-byte length fits.
pub const VIDEO_PIECE: usize = 65280;
pub const VIDEO_SINGLE_MAX: usize = 65508;

fn i16_at(b: &[u8], i: usize) -> i16 {
    i16::from_le_bytes([b[i], b[i + 1]])
}
fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn cstr(b: &[u8]) -> (String, usize) {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    (String::from_utf8_lossy(&b[..end]).into_owned(), (end + 1).min(b.len()))
}

pub fn parse(data: &[u8]) -> Option<ClientMsg> {
    if data.len() < 4 {
        return None;
    }
    let len = u16_at(data, 0) as usize;
    let typ = u16_at(data, 2);
    let p = &data[4..];
    let p = &p[..len.min(p.len())];
    Some(match typ {
        12 => ClientMsg::Ping(if data.len() >= 8 { u32::from_le_bytes([data[4], data[5], data[6], data[7]]) } else { 0 }),
        1 if p.len() >= 6 => ClientMsg::Touch { m: i16_at(p, 0), x: i16_at(p, 2), y: i16_at(p, 4) },
        2 if p.len() >= 4 => {
            let (lang, n) = cstr(&p[4..]);
            let (nav, _) = cstr(&p[4 + n..]);
            ClientMsg::Hello { w: u16_at(p, 0), h: u16_at(p, 2), lang, nav }
        }
        3 if p.len() >= 2 => ClientMsg::Cmd(i16_at(p, 0)),
        7 if p.len() >= 4 => ClientMsg::SetKey { key: i16_at(p, 0), value: i16_at(p, 2) },
        8 if !p.is_empty() => ClientMsg::Night(if p.len() >= 2 { i16_at(p, 0) } else { p[0] as i16 }),
        10 if p.len() >= 12 => {
            let name: Vec<u8> = p[..12].iter().copied().take_while(|&c| c != 0).map(|c| if c == b'"' { b'\'' } else { c }).collect();
            ClientMsg::Identity { name, icon: String::from_utf8_lossy(&p[12..]).trim_end_matches('\0').to_string() }
        }
        11 if p.len() >= 6 => ClientMsg::Override { w: u16_at(p, 0), h: u16_at(p, 2), mm_w: p[4], mm_h: p[5] },
        13 if p.len() >= 4 => ClientMsg::Key { key: i16_at(p, 0), modifier: i16_at(p, 2) },
        4 => ClientMsg::BtConnect(cstr(p).0),
        5 => ClientMsg::BtDisconnect(cstr(p).0),
        6 => ClientMsg::BtForget(cstr(p).0),
        9 => ClientMsg::WifiPsk(cstr(p).0),
        t => ClientMsg::Unknown(t, p.len()),
    })
}

/// `Uint32 [length, type]` + payload.
pub fn message(typ: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&typ.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// An access unit as the page expects it: type 100 `[u32 len] + unit` when it fits, otherwise
/// 101 `[u32 total] + first piece`, 102 pieces, 103 last piece.
pub fn video_messages(unit: &[u8]) -> Vec<Vec<u8>> {
    let total = (unit.len() as u32).to_le_bytes();
    if unit.len() + 4 <= VIDEO_SINGLE_MAX {
        let mut p = Vec::with_capacity(unit.len() + 4);
        p.extend_from_slice(&total);
        p.extend_from_slice(unit);
        return vec![message(S_VIDEO, &p)];
    }
    let mut out = Vec::new();
    let first_len = VIDEO_PIECE - 4;
    let mut p = Vec::with_capacity(VIDEO_PIECE);
    p.extend_from_slice(&total);
    p.extend_from_slice(&unit[..first_len]);
    out.push(message(S_VIDEO_FIRST, &p));
    let rest = &unit[first_len..];
    let pieces: Vec<&[u8]> = rest.chunks(VIDEO_PIECE).collect();
    for (i, piece) in pieces.iter().enumerate() {
        let typ = if i + 1 == pieces.len() { S_VIDEO_LAST } else { S_VIDEO_MID };
        out.push(message(typ, piece));
    }
    out
}

/// Annex-B helpers for the video ring: does this access unit contain an IDR slice (NAL type 5)?
pub fn has_idr(unit: &[u8]) -> bool {
    nal_types(unit).any(|t| t == 5)
}
pub fn nal_types(unit: &[u8]) -> impl Iterator<Item = u8> + '_ {
    let mut i = 0usize;
    std::iter::from_fn(move || {
        while i + 3 < unit.len() {
            if unit[i] == 0 && unit[i + 1] == 0 && unit[i + 2] == 1 {
                let t = unit[i + 3] & 0x1f;
                i += 4;
                return Some(t);
            }
            i += 1;
        }
        None
    })
}

/// Byte offset of the start code of the first VCL NAL (slice), i.e. the end of the SPS/PPS/SEI prefix.
pub fn vcl_offset(unit: &[u8]) -> Option<usize> {
    let mut i = 0usize;
    while i + 3 < unit.len() {
        if unit[i] == 0 && unit[i + 1] == 0 && unit[i + 2] == 1 {
            let t = unit[i + 3] & 0x1f;
            if (1..=5).contains(&t) {
                return Some(if i > 0 && unit[i - 1] == 0 { i - 1 } else { i });
            }
            i += 4;
        } else {
            i += 1;
        }
    }
    None
}

pub type Unit = Arc<Vec<u8>>;

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
pub fn js(s: &str) -> String {
    json_str(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_hello_touch_ping() {
        let mut hello = vec![0u8; 4];
        let body = [0x10u8, 0x03, 0x59, 0x02]; // 784 x 601
        hello.extend_from_slice(&body);
        hello.extend_from_slice(b"ko-KR\0Tesla/2024\0");
        let n = (hello.len() - 4) as u16;
        hello[0..2].copy_from_slice(&n.to_le_bytes());
        hello[2..4].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(parse(&hello), Some(ClientMsg::Hello { w: 784, h: 601, lang: "ko-KR".into(), nav: "Tesla/2024".into() }));
        let touch: Vec<u8> = [6i16, 1, 0, 500, 600].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(parse(&touch), Some(ClientMsg::Touch { m: 0, x: 500, y: 600 }));
        let ping = [0x04u8, 0x00, 0x0c, 0x00, 7, 0, 0, 0];
        assert_eq!(parse(&ping), Some(ClientMsg::Ping(7)));
    }
    #[test]
    fn video_split() {
        let small = vec![0u8; 1000];
        let m = video_messages(&small);
        assert_eq!(m.len(), 1);
        assert_eq!(&m[0][4..8], &100u32.to_le_bytes());
        assert_eq!(m[0].len(), 8 + 4 + 1000);
        let big = vec![1u8; 150_000];
        let m = video_messages(&big);
        // first piece carries VIDEO_PIECE - 4 bytes, the rest VIDEO_PIECE each: 65276 + 65280 + 19444
        assert_eq!(m.len(), 3);
        let total: usize = m.iter().map(|x| x.len() - 8).sum::<usize>() - 4;
        assert_eq!(total, 150_000);
        assert_eq!(&m[0][4..8], &101u32.to_le_bytes());
        assert_eq!(&m[1][4..8], &102u32.to_le_bytes());
        assert_eq!(&m[2][4..8], &103u32.to_le_bytes());
        let idr = [0u8, 0, 0, 1, 0x27, 0, 0, 0, 1, 0x65, 0x88];
        assert!(has_idr(&idr));
        assert!(!has_idr(&[0, 0, 0, 1, 0x41, 0x9a]));
    }
}
