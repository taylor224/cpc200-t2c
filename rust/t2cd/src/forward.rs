//! The forwarder. One UDP socket towards the clients (the car, phones on the hotspot — t2cd's nat
//! rule redirects their port-53 queries here), one towards the upstream resolvers.
//!
//! Decision per query:
//!   * table names (carplay.internal, setting.internal, the stock tespush names) → answered here;
//!   * any other name while the adapter has internet (a default route that is not wlan0, i.e. the
//!     Bluetooth PAN to the phone) → forwarded to the resolvers udhcpc wrote to /etc/resolv.conf,
//!     then 8.8.8.8 and 1.1.1.1 (always appended: the phone's resolver is slow and lossy over
//!     LTE + Bluetooth), id rewritten, the reply relayed. A resolver that stays silent for
//!     `timeout` is skipped for the next one and left out of the first try for 30 s; only when all
//!     are silent does the client get SERVFAIL;
//!   * while offline: a name with a label containing "tesla" is answered with the Tesla-UI
//!     address (TTL 0) — the stock trick that keeps the car's connectivity check happy
//!     (`/online/status.html` is served there) — and everything else gets REFUSED at once.
//!
//! Replies are accepted only from the resolver the query went to and only when their question
//! matches the pending one; ids are random. Queries are answered only for the hotspot subnet and
//! loopback (not an open resolver towards the PAN side). Persistent socket errors end the process
//! so the watchdog restarts it instead of leaving a live pid that answers nothing.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::dns;
use crate::log::Logger;

#[derive(Clone)]
pub struct Config {
    pub listen: SocketAddr,
    pub tesla_ip: Ipv4Addr,
    pub settings_ip: Ipv4Addr,
    /// explicit upstreams; empty = read /etc/resolv.conf
    pub upstreams: Vec<SocketAddr>,
    pub timeout: Duration,
    /// None = decide from the routing table; Some(v) = forced (tests, bench)
    pub force_online: Option<bool>,
    pub table_ttl: u32,
}

struct Pending {
    client: SocketAddr,
    orig_id: u16,
    query: Vec<u8>,
    /// resolvers in the order they are tried for this query
    order: Vec<SocketAddr>,
    tries: usize,
    deadline: Instant,
    name: String,
    qtype: u16,
}

struct Net {
    online: bool,
    upstreams: Vec<SocketAddr>,
    /// resolver → do not try it first before this instant
    penalty: HashMap<SocketAddr, Instant>,
    checked: Instant,
}

pub struct Forwarder {
    cfg: Config,
    log: Arc<Logger>,
    client_sock: UdpSocket,
    upstream_sock: UdpSocket,
    pending: Mutex<HashMap<u16, Pending>>,
    net: Mutex<Net>,
    rng: Mutex<u32>,
}

const MAX_PENDING: usize = 256;
const NET_RECHECK: Duration = Duration::from_secs(5);
const PENALTY: Duration = Duration::from_secs(30);
const MAX_SOCKET_ERRORS: u32 = 50;

fn parse_resolv_conf() -> Vec<SocketAddr> {
    let mut out = Vec::new();
    if let Ok(s) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in s.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            let mut it = line.split_whitespace();
            if it.next() == Some("nameserver") {
                // IPv4 only (the PAN is IPv4); never ourselves or the adapter's own fake resolver
                if let Some(ip) = it.next().and_then(|v| v.parse::<Ipv4Addr>().ok()) {
                    if ip.is_loopback()
                        || ip == Ipv4Addr::new(192, 168, 3, 1)
                        || ip == Ipv4Addr::new(101, 200, 208, 6)
                    {
                        continue;
                    }
                    let sa = SocketAddr::V4(SocketAddrV4::new(ip, 53));
                    if !out.contains(&sa) {
                        out.push(sa);
                    }
                }
            }
        }
    }
    out
}

/// A default route through something other than the hotspot interface = the phone's PAN is up.
fn default_route_up() -> Option<bool> {
    let s = std::fs::read_to_string("/proc/net/route").ok()?;
    for line in s.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 {
            continue;
        }
        let flags = u32::from_str_radix(f[3], 16).unwrap_or(0);
        if f[1] == "00000000" && flags & 0x2 != 0 && f[0] != "wlan0" && f[0] != "lo" {
            return Some(true);
        }
    }
    Some(false)
}

fn seed() -> u32 {
    let mut b = [0u8; 4];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    let s = u32::from_le_bytes(b)
        ^ (std::process::id().wrapping_mul(2654435761))
        ^ (Instant::now().elapsed().as_nanos() as u32);
    if s == 0 {
        0x9E3779B9
    } else {
        s
    }
}

impl Forwarder {
    pub fn bind(cfg: Config, log: Arc<Logger>) -> std::io::Result<Forwarder> {
        let client_sock = UdpSocket::bind(cfg.listen)?;
        let upstream_sock = UdpSocket::bind(("0.0.0.0", 0))?;
        upstream_sock.set_read_timeout(Some(Duration::from_millis(250)))?;
        let net = Net {
            online: cfg.force_online.unwrap_or(true),
            upstreams: cfg.upstreams.clone(),
            penalty: HashMap::new(),
            checked: Instant::now() - NET_RECHECK,
        };
        Ok(Forwarder {
            cfg,
            log,
            client_sock,
            upstream_sock,
            pending: Mutex::new(HashMap::new()),
            net: Mutex::new(net),
            rng: Mutex::new(seed()),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.client_sock.local_addr().unwrap_or(self.cfg.listen)
    }

    fn next_id(&self) -> u16 {
        let mut r = self.rng.lock().unwrap_or_else(|e| e.into_inner());
        // xorshift32
        let mut x = *r;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *r = x;
        (x >> 16) as u16
    }

    /// Only the hotspot subnet (same /24 as the settings address) and loopback are served.
    fn allowed(&self, from: SocketAddr) -> bool {
        match from.ip() {
            IpAddr::V4(ip) => {
                ip.is_loopback() || ip.octets()[..3] == self.cfg.settings_ip.octets()[..3]
            }
            IpAddr::V6(ip) => ip.is_loopback(),
        }
    }

    /// Online state and the resolvers to try, in order (penalised ones last). Cheap: the system is
    /// read every few seconds, outside the lock; logging happens outside the lock too.
    fn resolvers(&self) -> (bool, Vec<SocketAddr>) {
        let now = Instant::now();
        let refresh = self
            .net
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .checked
            .elapsed()
            >= NET_RECHECK;
        let mut messages: Vec<String> = Vec::new();
        if refresh {
            let ups = if self.cfg.upstreams.is_empty() {
                // the PAN's resolver (the iPhone's hotspot DNS proxy over LTE) often stays silent
                // for seconds: the public resolvers always follow it, so a silent PAN resolver means
                // a retry elsewhere instead of SERVFAIL (which Node's getaddrinfo turns into
                // ENOTFOUND -- "Claude Code does not work on the adapter's Wi-Fi", 2026-10-19)
                let mut v = parse_resolv_conf();
                for pubr in ["8.8.8.8:53", "1.1.1.1:53"] {
                    let a: SocketAddr = pubr.parse().unwrap();
                    if !v.contains(&a) {
                        v.push(a);
                    }
                }
                v
            } else {
                self.cfg.upstreams.clone()
            };
            let online = match self.cfg.force_online {
                Some(v) => v,
                None => default_route_up().unwrap_or(true), // no /proc (tests on a Mac): assume online
            };
            let mut n = self.net.lock().unwrap_or_else(|e| e.into_inner());
            n.checked = now;
            if online != n.online {
                messages.push(format!(
                    "{} (resolvers {:?})",
                    if online {
                        "online: forwarding"
                    } else {
                        "offline: table + tesla catch-all only"
                    },
                    ups
                ));
            }
            if ups != n.upstreams {
                messages.push(format!("resolvers {:?}", ups));
                n.penalty.clear();
            }
            n.online = online;
            n.upstreams = ups;
        }
        let (online, order) = {
            let n = self.net.lock().unwrap_or_else(|e| e.into_inner());
            let mut good: Vec<SocketAddr> = Vec::new();
            let mut bad: Vec<SocketAddr> = Vec::new();
            for u in &n.upstreams {
                if n.penalty.get(u).map(|t| *t > now).unwrap_or(false) {
                    bad.push(*u)
                } else {
                    good.push(*u)
                }
            }
            good.extend(bad);
            (n.online, good)
        };
        for m in messages {
            self.log.log(&m);
        }
        (online, order)
    }

    fn penalize(&self, server: SocketAddr) {
        let mut n = self.net.lock().unwrap_or_else(|e| e.into_inner());
        n.penalty.insert(server, Instant::now() + PENALTY);
        if n.penalty.len() > 16 {
            n.penalty.clear();
        }
    }

    fn table(&self, name: &str) -> Option<Ipv4Addr> {
        match name {
            "carplay.internal"
            | "www.carplay.internal"
            | "tespush.com"
            | "www.tespush.com"
            | "tespush.cn"
            | "www.tespush.cn" => Some(self.cfg.tesla_ip),
            "setting.internal" | "settings.internal" | "www.setting.internal" => {
                Some(self.cfg.settings_ip)
            }
            _ => None,
        }
    }

    fn send_client(&self, pkt: &[u8], to: SocketAddr) {
        if let Err(e) = self.client_sock.send_to(pkt, to) {
            self.log.dbg(&format!("send to {}: {}", to, e));
        }
    }

    fn handle_client(&self, pkt: &[u8], from: SocketAddr) {
        if !self.allowed(from) {
            self.log
                .dbg(&format!("{} ignored (outside the hotspot)", from));
            return;
        }
        let Some(q) = dns::parse_question(pkt) else {
            return;
        };
        if q.qclass != dns::CLASS_IN {
            self.send_client(&dns::build_error(pkt, &q, dns::RCODE_REFUSED), from);
            return;
        }
        if let Some(ip) = self.table(&q.name) {
            let ans = if q.qtype == dns::TYPE_A {
                Some(ip.octets())
            } else {
                None
            };
            self.log.dbg(&format!(
                "{} {} type {} -> table {}",
                from, q.name, q.qtype, ip
            ));
            self.send_client(&dns::build_answer(pkt, &q, ans, self.cfg.table_ttl), from);
            return;
        }
        let (online, order) = self.resolvers();
        if !online || order.is_empty() {
            if q.name.split('.').any(|l| l.contains("tesla")) {
                self.log
                    .dbg(&format!("{} {} -> offline tesla catch-all", from, q.name));
                let ans = if q.qtype == dns::TYPE_A {
                    Some(self.cfg.tesla_ip.octets())
                } else {
                    None
                };
                self.send_client(&dns::build_answer(pkt, &q, ans, 0), from);
            } else {
                self.log
                    .dbg(&format!("{} {} -> offline REFUSED", from, q.name));
                self.send_client(&dns::build_error(pkt, &q, dns::RCODE_REFUSED), from);
            }
            return;
        }
        let orig_id = dns::parse_header(pkt).map(|h| h.id).unwrap_or(0);
        let mut query = pkt.to_vec();
        let target = order[0];
        let id = {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            if p.len() >= MAX_PENDING {
                // drop the oldest instead of growing without bound
                if let Some(old) = p.iter().min_by_key(|(_, v)| v.deadline).map(|(k, _)| *k) {
                    p.remove(&old);
                }
            }
            let mut id = self.next_id();
            let mut guard = 0;
            while p.contains_key(&id) && guard < 64 {
                id = self.next_id();
                guard += 1;
            }
            dns::set_id(&mut query, id);
            p.insert(
                id,
                Pending {
                    client: from,
                    orig_id,
                    query: query.clone(),
                    order,
                    tries: 1,
                    deadline: Instant::now() + self.cfg.timeout,
                    name: q.name.clone(),
                    qtype: q.qtype,
                },
            );
            id
        };
        self.log.dbg(&format!(
            "{} {} type {} -> {} (id {})",
            from, q.name, q.qtype, target, id
        ));
        if let Err(e) = self.upstream_sock.send_to(&query, target) {
            self.log.log(&format!("send to {} failed: {}", target, e));
        }
    }

    fn handle_upstream(&self, pkt: &[u8], from: SocketAddr) {
        let Some(h) = dns::parse_header(pkt) else {
            return;
        };
        if h.flags & 0x8000 == 0 {
            return; // a query, not a reply
        }
        let question = dns::parse_question_any(pkt, &h);
        let p = {
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let Some(p) = map.get(&h.id) else { return };
            // the reply must come from a resolver this query went to and carry the same question
            let from_ok = p.order[..p.tries.min(p.order.len())].contains(&from);
            let q_ok = question
                .as_ref()
                .map(|q| q.name == p.name && q.qtype == p.qtype)
                .unwrap_or(false);
            if !from_ok || !q_ok {
                self.log.dbg(&format!(
                    "reply id {} from {} ignored (from_ok {} question_ok {})",
                    h.id, from, from_ok, q_ok
                ));
                return;
            }
            map.remove(&h.id).unwrap()
        };
        let mut reply = pkt.to_vec();
        dns::set_id(&mut reply, p.orig_id);
        self.log.dbg(&format!(
            "{} <- {} {} rcode {}",
            p.client,
            from,
            p.name,
            h.flags & 0xF
        ));
        self.send_client(&reply, p.client);
    }

    fn upstream_loop(self: Arc<Self>) {
        let mut buf = vec![0u8; 4096];
        let mut last_sweep = Instant::now();
        let mut errors: u32 = 0;
        loop {
            match self.upstream_sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    errors = 0;
                    self.handle_upstream(&buf[..n], from);
                }
                Err(e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {} // ICMP unreachable from a dead resolver
                Err(e) => {
                    errors += 1;
                    self.log.log(&format!("upstream recv: {} ({})", e, errors));
                    if errors >= MAX_SOCKET_ERRORS {
                        self.log
                            .log("upstream socket broken, exiting for the watchdog");
                        std::process::exit(3);
                    }
                    thread::sleep(Duration::from_millis(200));
                }
            }
            if last_sweep.elapsed() >= Duration::from_millis(250) {
                last_sweep = Instant::now();
                self.sweep();
            }
        }
    }

    /// Retry expired queries on the next resolver; give up with SERVFAIL after the last one.
    fn sweep(&self) {
        let now = Instant::now();
        let mut expired: Vec<(u16, Pending)> = Vec::new();
        {
            let mut p = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<u16> = p
                .iter()
                .filter(|(_, v)| v.deadline <= now)
                .map(|(k, _)| *k)
                .collect();
            for id in ids {
                if let Some(v) = p.remove(&id) {
                    expired.push((id, v));
                }
            }
        }
        for (id, mut p) in expired {
            if let Some(&silent) = p.order.get(p.tries - 1) {
                self.penalize(silent);
            }
            if p.tries < p.order.len() {
                let target = p.order[p.tries];
                p.tries += 1;
                p.deadline = now + self.cfg.timeout;
                self.log
                    .dbg(&format!("{} {} retry on {}", p.client, p.name, target));
                let _ = self.upstream_sock.send_to(&p.query, target);
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(id, p);
            } else {
                self.log.log(&format!(
                    "{} {}: no answer from {:?}, SERVFAIL",
                    p.client, p.name, p.order
                ));
                if let Some(q) = dns::parse_question(&p.query) {
                    let mut err = dns::build_error(&p.query, &q, dns::RCODE_SERVFAIL);
                    dns::set_id(&mut err, p.orig_id);
                    self.send_client(&err, p.client);
                }
            }
        }
    }

    /// Spawn the upstream thread and serve clients on the calling thread (never returns).
    pub fn serve(self: Arc<Self>) -> ! {
        let up = Arc::clone(&self);
        thread::Builder::new()
            .name("upstream".into())
            .spawn(move || up.upstream_loop())
            .expect("spawn");
        self.log.log(&format!(
            "dns forwarder on {} (tesla {} settings {})",
            self.local_addr(),
            self.cfg.tesla_ip,
            self.cfg.settings_ip
        ));
        let mut buf = vec![0u8; 4096];
        let mut errors: u32 = 0;
        loop {
            match self.client_sock.recv_from(&mut buf) {
                Ok((n, from)) => {
                    errors = 0;
                    self.handle_client(&buf[..n], from);
                }
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {}
                Err(e) => {
                    errors += 1;
                    self.log.log(&format!("client recv: {} ({})", e, errors));
                    if errors >= MAX_SOCKET_ERRORS {
                        self.log
                            .log("client socket broken, exiting for the watchdog");
                        std::process::exit(3);
                    }
                    thread::sleep(Duration::from_millis(200));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dns::{build_query, parse_header, TYPE_A};

    fn fake_upstream(answer: bool) -> SocketAddr {
        let s = UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = s.local_addr().unwrap();
        thread::spawn(move || {
            let mut b = [0u8; 1024];
            while let Ok((n, from)) = s.recv_from(&mut b) {
                if !answer {
                    continue;
                }
                let q = dns::parse_question(&b[..n]).unwrap();
                let a = dns::build_answer(&b[..n], &q, Some([1, 2, 3, 4]), 300);
                s.send_to(&a, from).unwrap();
            }
        });
        addr
    }

    fn start(upstreams: Vec<SocketAddr>, online: bool) -> SocketAddr {
        let cfg = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            tesla_ip: Ipv4Addr::new(101, 200, 208, 6),
            settings_ip: Ipv4Addr::new(192, 168, 3, 1),
            upstreams,
            timeout: Duration::from_millis(300),
            force_online: Some(online),
            table_ttl: 60,
        };
        let f = Arc::new(Forwarder::bind(cfg, Arc::new(Logger::new(None, false))).unwrap());
        let addr = f.local_addr();
        thread::spawn(move || f.serve());
        addr
    }

    fn ask(server: SocketAddr, name: &str) -> Vec<u8> {
        let c = UdpSocket::bind("127.0.0.1:0").unwrap();
        c.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        c.send_to(&build_query(0x5555, name, TYPE_A, true), server)
            .unwrap();
        let mut b = [0u8; 1024];
        let (n, _) = c.recv_from(&mut b).unwrap();
        b[..n].to_vec()
    }

    fn a_record(reply: &[u8]) -> Option<[u8; 4]> {
        let h = parse_header(reply).unwrap();
        let q = dns::parse_question_any(reply, &h).unwrap();
        if h.an == 0 {
            return None;
        }
        let ans = &reply[q.end..];
        Some([ans[12], ans[13], ans[14], ans[15]])
    }

    #[test]
    fn table_forward_and_servfail() {
        let good = fake_upstream(true);
        let dead = fake_upstream(false);
        let srv = start(vec![dead, good], true);
        let r = ask(srv, "carplay.internal");
        assert_eq!(parse_header(&r).unwrap().id, 0x5555);
        assert_eq!(a_record(&r), Some([101, 200, 208, 6]));
        assert_eq!(
            a_record(&ask(srv, "setting.internal")),
            Some([192, 168, 3, 1])
        );
        // forwarded: first upstream silent, second answers; the silent one is then penalised
        let t0 = Instant::now();
        let r = ask(srv, "example.com");
        assert_eq!(parse_header(&r).unwrap().id, 0x5555);
        assert_eq!(a_record(&r), Some([1, 2, 3, 4]));
        assert!(t0.elapsed() >= Duration::from_millis(250));
        let t1 = Instant::now();
        assert_eq!(a_record(&ask(srv, "example.net")), Some([1, 2, 3, 4]));
        assert!(
            t1.elapsed() < Duration::from_millis(250),
            "penalised resolver must not be tried first"
        );
        // only dead upstreams: SERVFAIL after the retries
        let srv2 = start(vec![dead], true);
        let r = ask(srv2, "example.org");
        assert_eq!(
            parse_header(&r).unwrap().flags & 0xF,
            dns::RCODE_SERVFAIL as u16
        );
    }

    #[test]
    fn offline_mode() {
        let srv = start(vec![], false);
        assert_eq!(
            a_record(&ask(srv, "carplay.internal")),
            Some([101, 200, 208, 6])
        );
        let r = ask(srv, "www.tesla.com");
        assert_eq!(a_record(&r), Some([101, 200, 208, 6]));
        let r = ask(srv, "example.com");
        assert_eq!(
            parse_header(&r).unwrap().flags & 0xF,
            dns::RCODE_REFUSED as u16
        );
    }

    #[test]
    fn spoofed_reply_is_ignored() {
        // an upstream that answers with a different question than asked
        let liar = UdpSocket::bind("127.0.0.1:0").unwrap();
        let liar_addr = liar.local_addr().unwrap();
        thread::spawn(move || {
            let mut b = [0u8; 1024];
            while let Ok((n, from)) = liar.recv_from(&mut b) {
                let h = parse_header(&b[..n]).unwrap();
                let mut forged = build_query(h.id, "evil.example", TYPE_A, false);
                forged[2] |= 0x80;
                liar.send_to(&forged, from).unwrap();
            }
        });
        let srv = start(vec![liar_addr], true);
        let r = ask(srv, "bank.example");
        assert_eq!(
            parse_header(&r).unwrap().flags & 0xF,
            dns::RCODE_SERVFAIL as u16
        );
    }
}
