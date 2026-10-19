//! RFC 6455 server-side framing: the handshake accept key, reading masked client frames (with
//! fragmentation and control frames), writing unmasked frames. No extensions, no compression.

use std::io::{self, Read, Write};

use crate::sha1;

pub const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
pub const OP_TEXT: u8 = 1;
pub const OP_BINARY: u8 = 2;
pub const OP_CLOSE: u8 = 8;
pub const OP_PING: u8 = 9;
pub const OP_PONG: u8 = 10;
/// Largest client message we accept (the page sends tiny messages; a firmware image goes over HTTP).
const MAX_MSG: usize = 1 << 20;

pub fn accept_key(client_key: &str) -> String {
    let mut s = client_key.trim().as_bytes().to_vec();
    s.extend_from_slice(GUID.as_bytes());
    sha1::base64(&sha1::sha1(&s))
}

/// A complete frame for the wire. Payloads stay below 65536 for video (see protocol::video_frames),
/// so the 2-byte length form is the common case; the 8-byte form is still handled.
pub fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let n = payload.len();
    let mut out = Vec::with_capacity(n + 10);
    out.push(0x80 | (opcode & 0x0f));
    if n < 126 {
        out.push(n as u8);
    } else if n < 65536 {
        out.push(126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

fn read_exact_or_eof<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => return Ok(false),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

/// One complete message (fragments joined). Control frames are returned as they come. `None` = EOF.
pub fn read_message<R: Read>(r: &mut R) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut assembled: Vec<u8> = Vec::new();
    let mut first_op = 0u8;
    loop {
        let mut h = [0u8; 2];
        if !read_exact_or_eof(r, &mut h)? {
            return Ok(None);
        }
        let fin = h[0] & 0x80 != 0;
        let op = h[0] & 0x0f;
        let masked = h[1] & 0x80 != 0;
        let mut len = (h[1] & 0x7f) as usize;
        if len == 126 {
            let mut b = [0u8; 2];
            if !read_exact_or_eof(r, &mut b)? {
                return Ok(None);
            }
            len = u16::from_be_bytes(b) as usize;
        } else if len == 127 {
            let mut b = [0u8; 8];
            if !read_exact_or_eof(r, &mut b)? {
                return Ok(None);
            }
            let v = u64::from_be_bytes(b);
            if v > MAX_MSG as u64 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
            }
            len = v as usize;
        }
        if len > MAX_MSG || assembled.len() + len > MAX_MSG {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
        }
        let mut mask = [0u8; 4];
        if masked && !read_exact_or_eof(r, &mut mask)? {
            return Ok(None);
        }
        let mut data = vec![0u8; len];
        if len > 0 && !read_exact_or_eof(r, &mut data)? {
            return Ok(None);
        }
        if masked {
            for (i, b) in data.iter_mut().enumerate() {
                *b ^= mask[i & 3];
            }
        }
        if op >= 8 {
            // control frames are never fragmented and may interleave a fragmented message
            return Ok(Some((op, data)));
        }
        if op != 0 {
            first_op = op;
            assembled = data;
        } else {
            assembled.extend_from_slice(&data);
        }
        if fin {
            return Ok(Some((first_op, assembled)));
        }
    }
}

#[allow(dead_code)]
pub fn write_all<W: Write>(w: &mut W, opcode: u8, payload: &[u8]) -> io::Result<()> {
    w.write_all(&frame(opcode, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_masked() {
        // client frame: FIN+binary, masked, 5 bytes
        let payload = b"hello";
        let mask = [1u8, 2, 3, 4];
        let mut wire = vec![0x82, 0x80 | 5];
        wire.extend_from_slice(&mask);
        wire.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i & 3]));
        let mut cur = std::io::Cursor::new(wire);
        let (op, data) = read_message(&mut cur).unwrap().unwrap();
        assert_eq!((op, data.as_slice()), (OP_BINARY, &payload[..]));
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        let f = frame(OP_BINARY, &[0u8; 70000]);
        assert_eq!(&f[..2], &[0x82, 127]);
    }
}
