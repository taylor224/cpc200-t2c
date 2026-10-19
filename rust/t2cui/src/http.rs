//! HTTP/1.1 front end: static files from the www directory (index.in rendered like lylinkui),
//! the few dynamic routes the page uses, and the WebSocket upgrade into the session. One thread
//! per connection (a car browser opens a handful), blocking I/O with timeouts, no allocation
//! surprises: a request line or header block over 16 KB is refused.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::session::Session;
use crate::ws;

pub struct Http {
    pub www: PathBuf,
    pub session: Arc<Session>,
    pub fw_path: PathBuf,
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(h, _)| h.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "pcm" | "bin" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

/// lylinkui's template engine (NOTES): every `|` starts a 4-character token `|NNN`, replaced by
/// line `(c[2]-'0')*10 + (c[3]-'0')` of lan/<n>.txt. Our index.in has no `|`; kept for fidelity.
pub fn render_index(www: &Path, lan: u8) -> Vec<u8> {
    let lan = lan.min(2);
    let lines: Vec<String> = std::fs::read_to_string(www.join("lan").join(format!("{}.txt", lan))).map(|s| s.lines().map(|l| l.to_string()).collect()).unwrap_or_default();
    let src = std::fs::read(www.join("index.in")).unwrap_or_default();
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        if src[i] == b'|' {
            if i + 3 < src.len() {
                let idx = (src[i + 2].wrapping_sub(b'0') as usize) * 10 + src[i + 3].wrapping_sub(b'0') as usize;
                if let Some(l) = lines.get(idx) {
                    out.extend_from_slice(l.as_bytes());
                }
            }
            i += 4;
        } else {
            out.push(src[i]);
            i += 1;
        }
    }
    out
}

fn respond(w: &mut impl Write, code: u16, ctype: &str, body: &[u8], extra: &str) -> io::Result<()> {
    let reason = match code {
        200 => "OK",
        101 => "Switching Protocols",
        404 => "Not Found",
        400 => "Bad Request",
        413 => "Payload Too Large",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let hdr = format!("HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Connection: keep-alive\r\n\r\n", code, reason, ctype, body.len(), extra);
    w.write_all(hdr.as_bytes())?;
    w.write_all(body)
}

fn read_request(r: &mut BufReader<TcpStream>) -> io::Result<Option<Request>> {
    let mut line = String::new();
    if r.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    if method.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad request line"));
    }
    let mut headers = Vec::new();
    let mut total = line.len();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h)? == 0 {
            return Ok(None);
        }
        total += h.len();
        if total > 16384 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "headers too long"));
        }
        let t = h.trim_end_matches(['\r', '\n']);
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
    if len > 24 * 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "body too large"));
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        r.read_exact(&mut body)?;
    }
    Ok(Some(Request { method, path, headers, body }))
}

impl Http {
    pub fn serve(self: Arc<Self>, listener: TcpListener) {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let me = self.clone();
            let _ = std::thread::Builder::new().name("http".into()).spawn(move || me.connection(stream));
        }
    }

    fn connection(&self, stream: TcpStream) {
        let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_nodelay(true);
        let Ok(wstream) = stream.try_clone() else { return };
        let mut r = BufReader::with_capacity(16384, stream);
        let mut w = io::BufWriter::new(wstream);
        for _ in 0..200 {
            let req = match read_request(&mut r) {
                Ok(Some(q)) => q,
                Ok(None) => return,
                Err(e) => {
                    // idle keep-alive connections end in a read timeout: not worth a line
                    if !matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset) {
                        self.session.log.dbg(&format!("http {}: {}", peer, e));
                    }
                    return;
                }
            };
            if req.header("Upgrade").map(|u| u.eq_ignore_ascii_case("websocket")).unwrap_or(false) {
                self.websocket(req, r, w, peer);
                return;
            }
            let keep = !req.header("Connection").map(|c| c.eq_ignore_ascii_case("close")).unwrap_or(false);
            if self.route(&req, &mut w).and_then(|_| w.flush()).is_err() || !keep {
                return;
            }
        }
    }

    fn route(&self, req: &Request, w: &mut impl Write) -> io::Result<()> {
        let path = req.path.split('?').next().unwrap_or("/");
        let dynamic = "Cache-Control: no-store\r\n";
        match (req.method.as_str(), path) {
            ("GET", "/") | ("GET", "/index.html") => {
                let lan = self.session.cfg.lock().unwrap_or_else(|e| e.into_inner()).lang();
                let body = render_index(&self.www, lan);
                respond(w, 200, "text/html; charset=utf-8", &body, dynamic)
            }
            ("GET", "/tsl/bt") => respond(w, 200, "application/json", crate::status::bt_list().as_bytes(), dynamic),
            // Tesla's connman online check: it wants `X-ConnMan-Status: online` on this URL (stock
            // lylinkui sends it); a 200 without the header reads as a captive portal ("this network
            // tried to show a login page") in the car.
            ("GET", "/online/status.html") => respond(w, 200, "text/plain", b"online", "X-ConnMan-Status: online\r\nCache-Control: no-store\r\n"),
            ("GET", "/health") => respond(w, 200, "application/json", self.session.health_json().as_bytes(), dynamic),
            ("GET", "/cmd") | ("GET", "/led") if !self.session.debug_allowed() => respond(w, 404, "text/plain", b"not found", dynamic),
            ("GET", "/cmd") => {
                // bench aid: /cmd?take=1 | ?untake=1 | ?key=0x600 | ?cmd=N  (vendor calls, logged)
                let q = req.path.split_once('?').map(|x| x.1).unwrap_or("");
                let (k, v) = q.split_once('=').unwrap_or((q, "0"));
                let n = i32::from_str_radix(v.trim_start_matches("0x"), if v.starts_with("0x") { 16 } else { 10 }).unwrap_or(0);
                let msg = self.session.debug_cmd(k, n);
                self.session.log.log(&format!("debug: {}", msg));
                respond(w, 200, "text/plain", msg.as_bytes(), dynamic)
            }
            ("GET", "/led") => {
                // bench aid: /led?name=wifi_led|link_led|model_led&v=0xRRGGBB (raw write, the policy
                // in session.tick overrides it within a second unless the state is the same)
                let q = req.path.split_once('?').map(|x| x.1).unwrap_or("");
                let get = |k: &str| q.split('&').find_map(|kv| kv.strip_prefix(k).and_then(|v| v.strip_prefix('=')).map(|v| v.to_string()));
                let leds = self.session.leds.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let Some(l) = leds else { return respond(w, 404, "text/plain", b"no led sysfs", dynamic) };
                let name = get("name").unwrap_or_else(|| "model_led".into());
                let v = get("v").map(|v| u32::from_str_radix(v.trim_start_matches("0x"), 16).unwrap_or(0)).unwrap_or(0);
                let ok = l.set_raw(&name, v);
                let msg = format!("{} = {:#x} -> {}", name, v, ok);
                self.session.log.log(&msg);
                respond(w, 200, "text/plain", msg.as_bytes(), dynamic)
            }
            ("GET", "/video.jpg") | ("GET", "/mic_test.pcm") => respond(w, 404, "text/plain", b"not available", dynamic),
            ("POST", "/tsl/fw") => {
                // stock lylinkui streams the upload to /tmp/update.tmp and renames it to
                // /tmp/update.img when complete (callback_tsl 1595); the stock updater picks that up
                self.session.log.log(&format!("firmware upload {} bytes -> {}", req.body.len(), self.fw_path.display()));
                let tmp = self.fw_path.with_extension("tmp");
                let ok = std::fs::write(&tmp, &req.body).is_ok() && std::fs::rename(&tmp, &self.fw_path).is_ok();
                if ok {
                    crate::status::firmware_received(&self.session, &self.fw_path);
                }
                respond(w, 200, "application/json", if ok { b"{\"ok\":1}" } else { b"{\"ok\":0}" }, dynamic)
            }
            ("GET", _) => {
                let rel = path.trim_start_matches('/');
                if rel.split('/').any(|seg| seg == ".." || seg.is_empty()) {
                    return respond(w, 404, "text/plain", b"not found", dynamic);
                }
                let fs = self.www.join(rel);
                match std::fs::read(&fs) {
                    Ok(body) => respond(w, 200, mime(&fs), &body, "Cache-Control: no-cache\r\n"),
                    Err(_) => respond(w, 404, "text/plain", b"not found", dynamic),
                }
            }
            _ => respond(w, 405, "text/plain", b"nope", dynamic),
        }
    }

    fn websocket(&self, req: Request, mut r: BufReader<TcpStream>, mut w: io::BufWriter<TcpStream>, peer: String) {
        let key = req.header("Sec-WebSocket-Key").unwrap_or("").to_string();
        let proto = req.header("Sec-WebSocket-Protocol").map(|p| p.contains("tsl")).unwrap_or(false);
        let accept = ws::accept_key(&key);
        let hdr = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n{}\r\n", accept, if proto { "Sec-WebSocket-Protocol: tsl\r\n" } else { "" });
        if w.write_all(hdr.as_bytes()).and_then(|_| w.flush()).is_err() {
            return;
        }
        let _ = r.get_ref().set_read_timeout(Some(Duration::from_secs(30)));
        let (client, rx) = self.session.attach(peer);
        // writer: drains the client's queue; the reader loop below owns the socket's read half
        let writer_client = client.clone();
        let writer = std::thread::Builder::new()
            .name(format!("ws-w{}", client.id))
            .spawn(move || {
                for frame in rx {
                    if frame.is_empty() {
                        break;
                    }
                    if w.write_all(&frame).and_then(|_| w.flush()).is_err() {
                        writer_client.alive.store(false, Ordering::Relaxed);
                        break;
                    }
                }
                let _ = w.flush();
            })
            .ok();
        loop {
            match ws::read_message(&mut r) {
                Ok(Some((op, data))) => match op {
                    ws::OP_BINARY | ws::OP_TEXT => self.session.on_message(&client, &data),
                    ws::OP_PING => {
                        client.send(ws::frame(ws::OP_PONG, &data));
                    }
                    ws::OP_CLOSE => break,
                    _ => {}
                },
                Ok(None) => break,
                Err(e) => {
                    if e.kind() != io::ErrorKind::WouldBlock && e.kind() != io::ErrorKind::TimedOut {
                        self.session.log.dbg(&format!("ws #{}: {}", client.id, e));
                        break;
                    }
                    if !client.alive.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
            if !client.alive.load(Ordering::Relaxed) {
                break;
            }
        }
        self.session.detach(&client);
        client.send(Vec::new()); // wake the writer so it exits
        let _ = r.get_ref().shutdown(std::net::Shutdown::Both);
        if let Some(t) = writer {
            let _ = t.join();
        }
    }
}
