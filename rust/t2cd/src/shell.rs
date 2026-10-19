//! Debug shell: a root `/bin/sh` on a pseudo-terminal, served as raw bytes over TCP (default port
//! 2323) to the hotspot subnet -- and to the phone's personal-hotspot subnet over bt-pan, the way in
//! when the adapter's Wi-Fi is dead -- while `/mnt/UDISK/t2c_shell` exists. There is no telnet negotiation
//! and no SSH: the rootfs busybox has neither telnetd nor nc, and the hotspot password is the only
//! access control the adapter has anyway (the CGI already reboots, rewrites Wi-Fi and uploads
//! binaries). The client (tools/shell.py) puts its terminal in raw mode, sends an optional window
//! size header (`\x1dWS <rows> <cols>\n`, repeated on resize) and pipes bytes both ways. A first
//! chunk of `\x1dCMD <len>\n` + script instead runs the script with `/bin/sh -c` and no pty, and
//! ends with `\n\x1dRC <exit code>\n` (one-shot mode, `tools/shell.py -c`).
//!
//! The listener is opened when the flag appears and closed when it disappears (checked every 2 s);
//! sessions already open live on until their shell exits. At most MAX_SESSIONS at once. Closing the
//! socket hangs up the pty, which SIGHUPs the shell's session; anything still alive 2 s later is
//! killed.

pub const DEFAULT_PORT: u16 = 2323;
#[cfg(target_os = "linux")]
const MAX_SESSIONS: usize = 3;

/// `\x1dWS <rows> <cols>\n` at the start of `buf`: returns (rows, cols, header length).
fn parse_winsize(buf: &[u8]) -> Option<(u16, u16, usize)> {
    if !buf.starts_with(b"\x1dWS ") {
        return None;
    }
    let nl = buf.iter().position(|&b| b == b'\n')?;
    let line = std::str::from_utf8(&buf[4..nl]).ok()?;
    let mut it = line.split_whitespace();
    let rows: u16 = it.next()?.parse().ok()?;
    let cols: u16 = it.next()?.parse().ok()?;
    if rows == 0 || cols == 0 || rows > 500 || cols > 1000 {
        return None;
    }
    Some((rows, cols, nl + 1))
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{parse_winsize, MAX_SESSIONS};
    use crate::log::Logger;
    use std::ffi::CStr;
    use std::fs::File;
    use std::io::{ErrorKind, Read, Write};
    use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    extern "C" {
        fn posix_openpt(flags: i32) -> i32;
        fn grantpt(fd: i32) -> i32;
        fn unlockpt(fd: i32) -> i32;
        fn ptsname_r(fd: i32, buf: *mut u8, len: usize) -> i32;
        fn ioctl(fd: i32, req: i32, ...) -> i32;
        fn setsid() -> i32;
        fn kill(pid: i32, sig: i32) -> i32;
        fn poll(fds: *mut PollFd, nfds: u32, timeout: i32) -> i32;
    }
    #[repr(C)]
    struct PollFd {
        fd: i32,
        events: i16,
        revents: i16,
    }
    const POLLIN: i16 = 0x1;
    const POLLERR: i16 = 0x8;
    const POLLHUP: i16 = 0x10;
    /// Send a signal to the pty's foreground process group (vi/top run in their own group, so a
    /// signal to the shell's group alone does not reach them).
    const TIOCSIG: i32 = 0x4004_5436;
    const O_RDWR: i32 = 2;
    const O_NOCTTY: i32 = 0o400;
    const TIOCSCTTY: i32 = 0x540E;
    const TIOCSWINSZ: i32 = 0x5414;
    const SIGHUP: i32 = 1;
    const SIGKILL: i32 = 9;

    #[repr(C)]
    struct Winsize {
        row: u16,
        col: u16,
        x: u16,
        y: u16,
    }

    fn set_winsize(fd: i32, rows: u16, cols: u16) {
        let ws = Winsize {
            row: rows,
            col: cols,
            x: 0,
            y: 0,
        };
        unsafe {
            ioctl(fd, TIOCSWINSZ, &ws as *const Winsize);
        }
    }

    /// Open a pty pair: (master file, slave path).
    fn open_pty() -> std::io::Result<(File, String)> {
        let m = unsafe { posix_openpt(O_RDWR | O_NOCTTY) };
        if m < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let master = unsafe { File::from_raw_fd(m) };
        if unsafe { grantpt(m) } != 0 || unsafe { unlockpt(m) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut buf = [0u8; 64];
        if unsafe { ptsname_r(m, buf.as_mut_ptr(), buf.len()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let name = CStr::from_bytes_until_nul(&buf)
            .map_err(|_| std::io::Error::new(ErrorKind::Other, "ptsname"))?
            .to_string_lossy()
            .into_owned();
        Ok((master, name))
    }

    /// `\x1dCMD <len>\n` + len bytes: run them with `/bin/sh -c` (no pty, no line-length limit,
    /// output unechoed), then send `\n\x1dRC <code>\n` and close. Used by `tools/shell.py -c`.
    pub(super) fn parse_cmd_header(buf: &[u8]) -> Option<(usize, usize)> {
        if !buf.starts_with(b"\x1dCMD ") {
            return None;
        }
        let nl = buf.iter().position(|&b| b == b'\n')?;
        let len: usize = std::str::from_utf8(&buf[5..nl]).ok()?.trim().parse().ok()?;
        if len == 0 || len > 1 << 20 {
            return None;
        }
        Some((len, nl + 1))
    }

    /// `\x1dPUT <name> <len>\n` + bytes: store them as /tmp/<name> (mode 755), reply `\x1dRC 0\n`.
    /// Bench uploads of any binary without the CGI; /tmp only (RAM), never the jffs2 UDISK.
    pub(super) fn parse_put_header(buf: &[u8]) -> Option<(String, usize, usize)> {
        if !buf.starts_with(b"\x1dPUT ") {
            return None;
        }
        let nl = buf.iter().position(|&b| b == b'\n')?;
        let line = std::str::from_utf8(&buf[5..nl]).ok()?;
        let mut it = line.split_whitespace();
        let name = it.next()?;
        let len: usize = it.next()?.parse().ok()?;
        let ok_name = !name.is_empty()
            && name.len() <= 64
            && !name.starts_with('.')
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.');
        if !ok_name || len == 0 || len > 8 << 20 {
            return None;
        }
        Some((name.to_string(), len, nl + 1))
    }

    fn put_file(
        mut sock: TcpStream,
        peer: SocketAddr,
        name: &str,
        len: usize,
        mut have: Vec<u8>,
        log: Arc<Logger>,
    ) -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        sock.set_read_timeout(Some(Duration::from_secs(30)))?;
        let path = format!("/tmp/{}", name);
        let tmp = format!("/tmp/.{}.part", name);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(&tmp)?;
        have.truncate(len);
        f.write_all(&have)?;
        let mut got = have.len();
        let mut buf = [0u8; 65536];
        while got < len {
            let n = sock.read(&mut buf)?;
            if n == 0 {
                break;
            }
            let take = n.min(len - got);
            f.write_all(&buf[..take])?;
            got += take;
        }
        drop(f);
        let code = if got == len {
            std::fs::rename(&tmp, &path).map(|_| 0).unwrap_or(2)
        } else {
            let _ = std::fs::remove_file(&tmp);
            1
        };
        log.log(&format!(
            "debug shell: put {} from {}: {} of {} bytes, rc {}",
            path, peer, got, len, code
        ));
        let _ = sock.write_all(format!("\x1dRC {}\n", code).as_bytes());
        let _ = sock.shutdown(Shutdown::Both);
        Ok(())
    }

    fn run_once(
        mut sock: TcpStream,
        peer: SocketAddr,
        len: usize,
        mut have: Vec<u8>,
        log: Arc<Logger>,
    ) -> std::io::Result<()> {
        sock.set_read_timeout(Some(Duration::from_secs(10)))?;
        while have.len() < len {
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf)?;
            if n == 0 {
                break;
            }
            have.extend_from_slice(&buf[..n]);
        }
        have.truncate(len);
        let script = String::from_utf8_lossy(&have).into_owned();
        log.log(&format!(
            "debug shell: command from {} ({} bytes)",
            peer, len
        ));
        let out = Stdio::from(OwnedFd::from(sock.try_clone()?));
        let err = Stdio::from(OwnedFd::from(sock.try_clone()?));
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .env_clear()
            .env("HOME", "/")
            .env("PATH", "/mnt/customer/app:/usr/sbin:/usr/bin:/sbin:/bin")
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .status()?;
        let code = status.code().unwrap_or(-1);
        let _ = sock.write_all(format!("\n\x1dRC {}\n", code).as_bytes());
        let _ = sock.shutdown(Shutdown::Both);
        Ok(())
    }

    fn session(mut sock: TcpStream, peer: SocketAddr, log: Arc<Logger>) -> std::io::Result<()> {
        // peek at the first bytes: a command header means one-shot mode, anything else a pty shell
        sock.set_read_timeout(Some(Duration::from_millis(1500)))?;
        let mut first = Vec::new();
        {
            let mut buf = [0u8; 4096];
            match sock.read(&mut buf) {
                Ok(0) => return Ok(()),
                Ok(n) => first.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
                Err(e) => return Err(e),
            }
        }
        if let Some((len, used)) = parse_cmd_header(&first) {
            let rest = first[used..].to_vec();
            return run_once(sock, peer, len, rest, log);
        }
        if let Some((name, len, used)) = parse_put_header(&first) {
            let rest = first[used..].to_vec();
            return put_file(sock, peer, &name, len, rest, log);
        }
        let (master, slave_path) = open_pty()?;
        let mfd = master.as_raw_fd();
        set_winsize(mfd, 40, 160);
        let slave = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(O_NOCTTY)
            .open(&slave_path)?;
        // `cmd` must be dropped right after spawn: it owns the slave fds, and the pump thread only
        // sees EOF (EIO) on the master once every slave fd is closed, i.e. when the shell is gone.
        let mut child = {
            let mut cmd = Command::new("/bin/sh");
            cmd.arg("-i")
                .env_clear()
                .env("TERM", "vt100")
                .env("HOME", "/")
                .env("PS1", "[t2c \\w]# ")
                .env("PATH", "/mnt/customer/app:/usr/sbin:/usr/bin:/sbin:/bin")
                .current_dir("/")
                .stdin(Stdio::from(slave.try_clone()?))
                .stdout(Stdio::from(slave.try_clone()?))
                .stderr(Stdio::from(slave));
            unsafe {
                cmd.pre_exec(|| {
                    setsid();
                    ioctl(0, TIOCSCTTY, 0);
                    Ok(())
                });
            }
            cmd.spawn()?
        };
        let pid = child.id() as i32;
        log.log(&format!(
            "debug shell: session from {} (sh pid {})",
            peer, pid
        ));

        // socket -> pty (this thread); pty -> socket (helper). The helper polls with a timeout and
        // checks `done`, so the hang-up below can always join it.
        let done = Arc::new(AtomicBool::new(false));
        let done2 = Arc::clone(&done);
        let mut master_r = master.try_clone()?;
        let mut sock_w = sock.try_clone()?;
        let pump = thread::Builder::new()
            .name("shell-out".into())
            .spawn(move || {
                let mut buf = [0u8; 4096];
                let mut pfd = PollFd {
                    fd: master_r.as_raw_fd(),
                    events: POLLIN,
                    revents: 0,
                };
                loop {
                    if done2.load(Ordering::SeqCst) {
                        break;
                    }
                    pfd.revents = 0;
                    let n = unsafe { poll(&mut pfd, 1, 250) };
                    if n < 0 {
                        if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                            continue;
                        }
                        break;
                    }
                    if n == 0 {
                        continue;
                    }
                    if pfd.revents & POLLIN != 0 {
                        match master_r.read(&mut buf) {
                            Ok(0) => break,
                            Ok(k) => {
                                if sock_w.write_all(&buf[..k]).is_err() {
                                    break;
                                }
                                continue;
                            }
                            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                            Err(_) => break, // EIO once every slave fd is closed
                        }
                    }
                    if pfd.revents & (POLLHUP | POLLERR) != 0 {
                        break;
                    }
                }
                let _ = sock_w.shutdown(Shutdown::Both);
            })?;

        let mut master_w = master;
        let mut buf = [0u8; 4096];
        sock.set_read_timeout(None)?;
        if !first.is_empty() {
            let mut data = &first[..];
            while let Some((rows, cols, used)) = parse_winsize(data) {
                set_winsize(mfd, rows, cols);
                data = &data[used..];
            }
            if !data.is_empty() {
                let _ = master_w.write_all(data);
            }
        }
        loop {
            match sock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut data = &buf[..n];
                    // window-size headers may arrive at any time (resize), but only at a read boundary
                    while let Some((rows, cols, used)) = parse_winsize(data) {
                        set_winsize(mfd, rows, cols);
                        data = &data[used..];
                    }
                    if !data.is_empty() && master_w.write_all(data).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        // hang up: SIGHUP to the shell's group and to the pty's foreground group (vi, top, ...),
        // SIGKILL to both after 2 s, then release the master. Background jobs the user left with
        // `&` keep the slave open; the pump exits on `done` regardless.
        let _ = sock.shutdown(Shutdown::Both);
        unsafe {
            kill(-pid, SIGHUP);
            ioctl(mfd, TIOCSIG, SIGHUP);
        }
        let t0 = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if t0.elapsed() < Duration::from_secs(2) => {
                    thread::sleep(Duration::from_millis(100))
                }
                _ => {
                    unsafe {
                        kill(-pid, SIGKILL);
                        ioctl(mfd, TIOCSIG, SIGKILL);
                    }
                    let _ = child.wait();
                    break;
                }
            }
        }
        // give whatever the foreground job printed on its way out a moment to reach the pump
        thread::sleep(Duration::from_millis(100));
        done.store(true, Ordering::SeqCst);
        let _ = pump.join();
        drop(master_w);
        log.log(&format!("debug shell: session from {} ended", peer));
        Ok(())
    }

    /// Hotspot clients (same /24 as the settings address), loopback, and anyone on the same /24 as
    /// the local address the connection arrived on: that admits the phone's personal-hotspot side
    /// (bt-pan, 172.20.10.x), the one way in when the adapter's own Wi-Fi is dead but Bluetooth
    /// is up -- connect the laptop to the iPhone hotspot and use the adapter's PAN address.
    fn allowed(peer: SocketAddr, local: Option<SocketAddr>, subnet: Ipv4Addr) -> bool {
        match peer.ip() {
            IpAddr::V4(ip) => {
                if ip.is_loopback() || ip.octets()[..3] == subnet.octets()[..3] {
                    return true;
                }
                match local.map(|l| l.ip()) {
                    Some(IpAddr::V4(l)) => l.is_private() && l.octets()[..3] == ip.octets()[..3],
                    _ => false,
                }
            }
            IpAddr::V6(ip) => ip.is_loopback(),
        }
    }

    pub fn start(flag: &'static str, port: u16, subnet: Ipv4Addr, log: Arc<Logger>) {
        let active = Arc::new(AtomicUsize::new(0));
        thread::Builder::new()
            .name("shell".into())
            .spawn(move || {
                let mut listener: Option<TcpListener> = None;
                let mut bind_fail_logged = false;
                loop {
                    let want = Path::new(flag).exists();
                    match (&listener, want) {
                        (None, true) => match TcpListener::bind(SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port)) {
                            Ok(l) => {
                                let _ = l.set_nonblocking(true);
                                log.log(&format!("debug shell: listening on tcp/{} (flag t2c_shell; hotspot clients only)", port));
                                listener = Some(l);
                                bind_fail_logged = false;
                            }
                            Err(e) => {
                                if !bind_fail_logged {
                                    log.log(&format!("debug shell: cannot listen on tcp/{}: {}", port, e));
                                    bind_fail_logged = true;
                                }
                            }
                        },
                        (Some(_), false) => {
                            listener = None;
                            log.log("debug shell: flag removed, listener closed (open sessions stay)");
                        }
                        _ => {}
                    }
                    let Some(l) = listener.as_ref() else {
                        thread::sleep(Duration::from_secs(2));
                        continue;
                    };
                    // poll accept for ~2 s, then re-check the flag
                    let t0 = Instant::now();
                    while t0.elapsed() < Duration::from_secs(2) {
                        match l.accept() {
                            Ok((s, peer)) => {
                                if !allowed(peer, s.local_addr().ok(), subnet) {
                                    log.log(&format!("debug shell: refused {} (not on the hotspot or the PAN)", peer));
                                    drop(s);
                                    continue;
                                }
                                if active.load(Ordering::SeqCst) >= MAX_SESSIONS {
                                    log.log(&format!("debug shell: refused {} (too many sessions)", peer));
                                    drop(s);
                                    continue;
                                }
                                let _ = s.set_nonblocking(false);
                                let _ = s.set_nodelay(true);
                                active.fetch_add(1, Ordering::SeqCst);
                                let (log2, active2) = (Arc::clone(&log), Arc::clone(&active));
                                let r = thread::Builder::new().name("shell-session".into()).spawn(move || {
                                    if let Err(e) = session(s, peer, Arc::clone(&log2)) {
                                        log2.log(&format!("debug shell: session from {} failed: {}", peer, e));
                                    }
                                    active2.fetch_sub(1, Ordering::SeqCst);
                                });
                                if r.is_err() {
                                    active.fetch_sub(1, Ordering::SeqCst);
                                }
                            }
                            Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(200)),
                            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                            Err(_) => thread::sleep(Duration::from_millis(500)),
                        }
                    }
                }
            })
            .expect("spawn");
    }
}

#[cfg(target_os = "linux")]
pub use imp::start;

#[cfg(not(target_os = "linux"))]
pub fn start(
    _flag: &'static str,
    _port: u16,
    _subnet: std::net::Ipv4Addr,
    log: std::sync::Arc<crate::log::Logger>,
) {
    log.log("debug shell: only built for Linux targets");
}

#[cfg(test)]
mod tests {
    use super::parse_winsize;
    #[cfg(target_os = "linux")]
    #[test]
    fn cmd_header() {
        use super::imp::parse_cmd_header;
        assert_eq!(parse_cmd_header(b"\x1dCMD 5\nls -l"), Some((5, 7)));
        assert_eq!(parse_cmd_header(b"\x1dWS 1 1\n"), None);
        assert_eq!(parse_cmd_header(b"\x1dCMD 0\n"), None);
        use super::imp::parse_put_header;
        assert_eq!(
            parse_put_header(b"\x1dPUT lyshim 12\nabc"),
            Some(("lyshim".to_string(), 12, 15))
        );
        assert_eq!(parse_put_header(b"\x1dPUT ../x 12\n"), None);
        assert_eq!(parse_put_header(b"\x1dPUT .hidden 12\n"), None);
    }
    #[test]
    fn winsize_header() {
        assert_eq!(parse_winsize(b"\x1dWS 50 200\nls\n"), Some((50, 200, 11)));
        assert_eq!(parse_winsize(b"ls\n"), None);
        assert_eq!(parse_winsize(b"\x1dWS 0 200\n"), None);
        assert_eq!(parse_winsize(b"\x1dWS 50"), None);
    }
}
