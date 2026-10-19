//! Just enough of RFC 1035/6891 for a forwarder: parse the header and the single question,
//! build an A answer, a NOERROR-without-data answer and an error reply. No name compression
//! in queries is assumed (clients never send it; a pointer stops the parse).

pub const TYPE_A: u16 = 1;
pub const TYPE_OPT: u16 = 41;
pub const CLASS_IN: u16 = 1;
pub const RCODE_SERVFAIL: u8 = 2;
pub const RCODE_REFUSED: u8 = 5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Header {
    pub id: u16,
    pub flags: u16,
    pub qd: u16,
    pub an: u16,
    pub ns: u16,
    pub ar: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Question {
    /// lower-case, dotted, no trailing dot
    pub name: String,
    pub qtype: u16,
    pub qclass: u16,
    /// offset just past the question (name + type + class)
    pub end: usize,
}

fn u16_at(p: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*p.get(i)?, *p.get(i + 1)?]))
}

pub fn parse_header(p: &[u8]) -> Option<Header> {
    if p.len() < 12 {
        return None;
    }
    Some(Header {
        id: u16_at(p, 0)?,
        flags: u16_at(p, 2)?,
        qd: u16_at(p, 4)?,
        an: u16_at(p, 6)?,
        ns: u16_at(p, 8)?,
        ar: u16_at(p, 10)?,
    })
}

/// The first question of a query. None when there is none, it is truncated, or it uses compression.
pub fn parse_question(p: &[u8]) -> Option<Question> {
    let h = parse_header(p)?;
    if h.flags & 0x8000 != 0 {
        return None; // not a query
    }
    parse_question_any(p, &h)
}

/// The question section of a query or a response (responses: to match a reply to its query).
pub fn parse_question_any(p: &[u8], h: &Header) -> Option<Question> {
    if h.qd < 1 {
        return None;
    }
    let mut i = 12usize;
    let mut labels: Vec<String> = Vec::new();
    loop {
        let len = *p.get(i)? as usize;
        if len == 0 {
            i += 1;
            break;
        }
        if len & 0xC0 != 0 {
            return None; // pointer or reserved
        }
        let label = p.get(i + 1..i + 1 + len)?;
        // lower-case; anything outside printable ASCII becomes '?' so a name can never forge a log line
        labels.push(
            label
                .iter()
                .map(|&b| {
                    if (0x21..=0x7E).contains(&b) {
                        (b as char).to_ascii_lowercase()
                    } else {
                        '?'
                    }
                })
                .collect(),
        );
        i += 1 + len;
        if labels.len() > 64 {
            return None;
        }
    }
    let qtype = u16_at(p, i)?;
    let qclass = u16_at(p, i + 2)?;
    Some(Question {
        name: labels.join("."),
        qtype,
        qclass,
        end: i + 4,
    })
}

/// The query carried an EDNS OPT record after the question (what macOS/iOS/glibc send).
pub fn query_has_opt(p: &[u8], q: &Question) -> bool {
    let Some(h) = parse_header(p) else {
        return false;
    };
    if h.ar == 0 {
        return false;
    }
    // OPT: root name (1 byte 0) + type 41
    p.get(q.end) == Some(&0) && u16_at(p, q.end + 1) == Some(TYPE_OPT)
}

fn reply_header(p: &[u8], q: &Question, rcode: u8, an: u16, opt: bool) -> Vec<u8> {
    let h = parse_header(p).unwrap_or(Header {
        id: 0,
        flags: 0,
        qd: 1,
        an: 0,
        ns: 0,
        ar: 0,
    });
    let mut out = Vec::with_capacity(q.end + 32);
    let flags: u16 = 0x8000 | (h.flags & 0x0100) | 0x0400 | 0x0080 | (rcode as u16 & 0xF); // QR, RD copied, AA, RA
    out.extend_from_slice(&h.id.to_be_bytes());
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&an.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&(if opt { 1u16 } else { 0 }).to_be_bytes());
    out.extend_from_slice(&p[12..q.end]);
    out
}

fn push_opt(out: &mut Vec<u8>) {
    out.push(0); // root name
    out.extend_from_slice(&TYPE_OPT.to_be_bytes());
    out.extend_from_slice(&1232u16.to_be_bytes()); // our UDP payload size
    out.extend_from_slice(&[0, 0, 0, 0]); // extended rcode, version, flags
    out.extend_from_slice(&0u16.to_be_bytes()); // no options
}

/// NOERROR with one A record (or none when `ip` is None, e.g. for AAAA of a table name).
pub fn build_answer(p: &[u8], q: &Question, ip: Option<[u8; 4]>, ttl: u32) -> Vec<u8> {
    let opt = query_has_opt(p, q);
    let mut out = reply_header(p, q, 0, if ip.is_some() { 1 } else { 0 }, opt);
    if let Some(ip) = ip {
        out.extend_from_slice(&[0xC0, 0x0C]); // pointer to the question name
        out.extend_from_slice(&TYPE_A.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&ttl.to_be_bytes());
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&ip);
    }
    if opt {
        push_opt(&mut out);
    }
    out
}

pub fn build_error(p: &[u8], q: &Question, rcode: u8) -> Vec<u8> {
    let opt = query_has_opt(p, q);
    let mut out = reply_header(p, q, rcode, 0, opt);
    if opt {
        push_opt(&mut out);
    }
    out
}

/// Overwrite the transaction id in place.
pub fn set_id(p: &mut [u8], id: u16) {
    if p.len() >= 2 {
        p[0..2].copy_from_slice(&id.to_be_bytes());
    }
}

#[cfg(test)]
pub fn build_query(id: u16, name: &str, qtype: u16, opt: bool) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x0100u16.to_be_bytes()); // RD
    out.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, if opt { 1 } else { 0 }]);
    for label in name.split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    if opt {
        push_opt(&mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_answers() {
        let q = build_query(0x1234, "CarPlay.Internal", TYPE_A, true);
        let qs = parse_question(&q).unwrap();
        assert_eq!(qs.name, "carplay.internal");
        assert_eq!(qs.qtype, TYPE_A);
        assert!(query_has_opt(&q, &qs));
        let a = build_answer(&q, &qs, Some([101, 200, 208, 6]), 60);
        let h = parse_header(&a).unwrap();
        assert_eq!(h.id, 0x1234);
        assert_eq!(h.flags & 0x8000, 0x8000);
        assert_eq!(h.flags & 0xF, 0);
        assert_eq!((h.qd, h.an, h.ns, h.ar), (1, 1, 0, 1));
        // question copied verbatim, answer follows
        assert_eq!(&a[12..qs.end], &q[12..qs.end]);
        let ans = &a[qs.end..];
        assert_eq!(&ans[..2], &[0xC0, 0x0C]);
        assert_eq!(&ans[10..12], &[0, 4]);
        assert_eq!(&ans[12..16], &[101, 200, 208, 6]);
        assert_eq!(ans[16], 0); // OPT root
        assert_eq!(&ans[17..19], &[0, 41]);
        assert_eq!(a.len(), qs.end + 16 + 11);
    }

    #[test]
    fn errors_and_no_data() {
        let q = build_query(7, "example.com", TYPE_A, false);
        let qs = parse_question(&q).unwrap();
        let r = build_error(&q, &qs, RCODE_REFUSED);
        let h = parse_header(&r).unwrap();
        assert_eq!(h.flags & 0xF, 5);
        assert_eq!((h.an, h.ar), (0, 0));
        assert_eq!(r.len(), qs.end);
        let nd = build_answer(&q, &qs, None, 60);
        assert_eq!(parse_header(&nd).unwrap().an, 0);
        assert_eq!(nd.len(), qs.end);
    }

    #[test]
    fn sanitizes_labels() {
        let mut q = build_query(1, "ab.internal", TYPE_A, false);
        q[13] = b'\n';
        q[14] = 0x80;
        assert_eq!(parse_question(&q).unwrap().name, "??.internal");
        let h = parse_header(&q).unwrap();
        q[2] |= 0x80;
        assert!(parse_question(&q).is_none());
        assert_eq!(parse_question_any(&q, &h).unwrap().name, "??.internal");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_question(&[0u8; 5]).is_none());
        let mut q = build_query(1, "a.b", TYPE_A, false);
        q[2] |= 0x80; // a response, not a query
        assert!(parse_question(&q).is_none());
        let mut c = build_query(1, "a.b", TYPE_A, false);
        c[12] = 0xC0; // compression pointer in a query name
        assert!(parse_question(&c).is_none());
    }
}
