//! USB device mode, behind `/mnt/UDISK/t2c_usb`: the adapter's USB-C port becomes a CDC-ACM
//! serial device with a root shell on it, so a laptop plugged into the adapter gets a console
//! (`screen /dev/cu.usbmodem*`) and `tools/usbflash.py` can push a firmware image without Wi-Fi.
//!
//! What the vendor kernel (4.9.118, sun8iw19p1) offers, found 2026-10-20: the sunxi UDC and
//! libcomposite/configfs are built in, `usb_f_acm` is the *only* function driver built in (no
//! ffs/ecm/rndis/mass_storage, no module files), the OTG role is switched through
//! `/sys/devices/platform/soc/usbc0/otg_role` and boots as `usb_host`. So: no kernel module, just
//! configfs: `functions/acm.usb0`, a link into `configs/c.1`, the role, the UDC name -- and
//! `/dev/ttyGS0` appears; its open() blocks until a host has the port open.
//!
//! `/tmp/t2c_usb_rescue` (the watchdog writes it when hostapd will not stay up or the radio is
//! dead) enables the console until the next reboot without touching the persistent flag.
//!
//! The port is also the adapter's power input: in a car it is a USB host (the Tesla). With the flag
//! set the car would see a CDC-ACM device it ignores; the flag is for the bench, off by default.
#[cfg(target_os = "linux")]
mod imp {
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use crate::log::Logger;

    extern "C" {
        fn ioctl(fd: i32, req: i32, ...) -> i32;
        fn setsid() -> i32;
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const TIOCSCTTY: i32 = 0x540E;
    const SIGHUP: i32 = 1;

    const G: &str = "/sys/kernel/config/usb_gadget/g1";
    const ROLE: &str = "/sys/devices/platform/soc/usbc0/otg_role";
    const TTY: &str = "/dev/ttyGS0";
    /// The watchdog touches this when Wi-Fi will not come up: console until the next reboot.
    pub const RESCUE: &str = "/tmp/t2c_usb_rescue";

    fn w(path: &str, v: &str) -> std::io::Result<()> {
        fs::write(path, v)
    }

    fn udc_name() -> Option<String> {
        fs::read_dir("/sys/class/udc").ok()?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).next()
    }

    /// Build the gadget: acm function in config c.1, device role, bound to the UDC.
    fn up(log: &Logger) -> bool {
        if !Path::new(G).is_dir() {
            if let Err(e) = fs::create_dir_all(G) {
                log.log(&format!("usb: no configfs gadget dir ({}): {}", G, e));
                return false;
            }
            let _ = w(&format!("{}/idVendor", G), "0x1f3a");
            let _ = w(&format!("{}/idProduct", G), "0x1001");
        }
        let bound = fs::read_to_string(format!("{}/UDC", G)).map(|s| !s.trim().is_empty()).unwrap_or(false);
        if !bound {
            // strings are writable only while unbound; the vendor leaves "Allwinner"/"Tina"
            let _ = fs::create_dir_all(format!("{}/strings/0x409", G));
            let _ = w(&format!("{}/strings/0x409/manufacturer", G), "Carlinkit");
            let _ = w(&format!("{}/strings/0x409/product", G), "T2C");
            let mac = fs::read_to_string("/sys/class/net/wlan0/address").unwrap_or_default();
            let serial: String = mac.trim().chars().filter(|c| *c != ':').collect();
            if !serial.is_empty() {
                let _ = w(&format!("{}/strings/0x409/serialnumber", G), &serial);
            }
        }
        let f = format!("{}/functions/acm.usb0", G);
        if !Path::new(&f).is_dir() {
            if let Err(e) = fs::create_dir(&f) {
                log.log(&format!("usb: mkdir acm.usb0: {} (no acm function in this kernel?)", e));
                return false;
            }
        }
        let c = format!("{}/configs/c.1", G);
        if !Path::new(&c).is_dir() {
            let _ = fs::create_dir_all(format!("{}/strings/0x409", c));
            let _ = w(&format!("{}/strings/0x409/configuration", c), "acm");
        }
        let link = format!("{}/acm.usb0", c);
        if !Path::new(&link).exists() {
            if let Err(e) = std::os::unix::fs::symlink(&f, &link) {
                log.log(&format!("usb: link acm.usb0 into c.1: {}", e));
                return false;
            }
        }
        if let Err(e) = w(ROLE, "usb_device") {
            log.log(&format!("usb: otg_role usb_device: {}", e));
        }
        if !bound {
            let Some(udc) = udc_name() else {
                log.log("usb: no UDC in /sys/class/udc");
                return false;
            };
            if let Err(e) = w(&format!("{}/UDC", G), &udc) {
                log.log(&format!("usb: bind to {}: {}", udc, e));
                return false;
            }
            log.log(&format!("usb: CDC-ACM gadget bound to {} (role usb_device, shell on {})", udc, TTY));
        } else {
            log.log(&format!("usb: gadget already bound, role usb_device, shell on {}", TTY));
        }
        true
    }

    /// Tear the gadget down and give the port back to host mode (the stock boot state).
    fn down(log: &Logger) {
        let _ = w(&format!("{}/UDC", G), "");
        let _ = fs::remove_file(format!("{}/configs/c.1/acm.usb0", G));
        let _ = w(ROLE, "usb_host");
        log.log("usb: gadget unbound, role usb_host");
    }

    /// One shell on the serial port; returns when it exits (host closed the port or `exit`).
    fn shell_once(log: &Logger, child_pid: &Arc<std::sync::atomic::AtomicI32>) {
        // open() blocks until the host side opens the port; EAGAIN/ENXIO while not connected
        let tty = match fs::OpenOptions::new().read(true).write(true).open(TTY) {
            Ok(t) => t,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log.dbg(&format!("usb: open {}: {}", TTY, e));
                }
                thread::sleep(Duration::from_secs(1));
                return;
            }
        };
        let r = tty.try_clone();
        let o = tty.try_clone();
        let (Ok(r), Ok(o)) = (r, o) else { return };
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-i")
            .env_clear()
            .env("TERM", "vt100")
            .env("HOME", "/")
            .env("PS1", "[t2c usb \\w]# ")
            .env("PATH", "/mnt/customer/app:/usr/sbin:/usr/bin:/sbin:/bin")
            .current_dir("/")
            .stdin(Stdio::from(r))
            .stdout(Stdio::from(o))
            .stderr(Stdio::from(tty));
        unsafe {
            cmd.pre_exec(|| {
                setsid();
                ioctl(0, TIOCSCTTY, 0);
                Ok(())
            });
        }
        match cmd.spawn() {
            Ok(mut child) => {
                let pid = child.id() as i32;
                child_pid.store(pid, std::sync::atomic::Ordering::SeqCst);
                log.log(&format!("usb: host opened {}, shell pid {}", TTY, pid));
                let _ = child.wait();
                child_pid.store(0, std::sync::atomic::Ordering::SeqCst);
                log.log("usb: shell ended");
            }
            Err(e) => {
                log.log(&format!("usb: spawn sh: {}", e));
                thread::sleep(Duration::from_secs(2));
            }
        }
    }

    pub fn start(flag: &'static str, log: Arc<Logger>) {
        thread::Builder::new()
            .name("usb".into())
            .spawn(move || {
                let child_pid = Arc::new(std::sync::atomic::AtomicI32::new(0));
                let mut active = false;
                let mut shell: Option<thread::JoinHandle<()>> = None;
                let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
                loop {
                    let want = Path::new(flag).exists() || Path::new(RESCUE).exists();
                    if want && !active {
                        if up(&log) {
                            active = true;
                            stop.store(false, std::sync::atomic::Ordering::SeqCst);
                            let (l2, pid2, stop2) = (Arc::clone(&log), Arc::clone(&child_pid), Arc::clone(&stop));
                            shell = thread::Builder::new()
                                .name("usb-sh".into())
                                .spawn(move || {
                                    while !stop2.load(std::sync::atomic::Ordering::SeqCst) {
                                        shell_once(&l2, &pid2);
                                    }
                                })
                                .ok();
                        } else {
                            thread::sleep(Duration::from_secs(30));
                        }
                    } else if !want && active {
                        stop.store(true, std::sync::atomic::Ordering::SeqCst);
                        let pid = child_pid.load(std::sync::atomic::Ordering::SeqCst);
                        if pid > 0 {
                            unsafe {
                                kill(-pid, SIGHUP);
                                kill(pid, SIGHUP);
                            }
                        }
                        down(&log);
                        // the shell thread may sit in open(): it returns once the tty is gone
                        if let Some(h) = shell.take() {
                            let _ = h.join();
                        }
                        active = false;
                    }
                    thread::sleep(Duration::from_secs(2));
                }
            })
            .expect("usb thread");
    }
}

#[cfg(target_os = "linux")]
pub use imp::start;

#[cfg(not(target_os = "linux"))]
pub fn start(_flag: &'static str, log: std::sync::Arc<crate::log::Logger>) {
    log.log("usb: only built for Linux targets");
}
