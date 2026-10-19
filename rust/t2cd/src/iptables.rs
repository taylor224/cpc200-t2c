//! Keeps the nat rule that sends the car's DNS to the forwarder. lylinkapp flushes the nat table
//! (`iptables -t nat -F`) whenever the Bluetooth PAN comes up, so the rule is checked every
//! 20 s and put back. Every iptables call runs with the xtables lock wait (`-w 2`, when this
//! iptables knows the option) and a 5 s kill timeout, so a stuck iptables can never stall the
//! keeper. Only an error that names the target/match as missing marks the kernel as
//! unsupported; everything else is retried.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::log::Logger;

pub struct Rule {
    pub port: u16,
    pub iface: String,
    wait_opt: bool,
}

pub enum Outcome {
    Ok,
    Fail(String),
    Timeout,
}

const CMD_TIMEOUT: Duration = Duration::from_secs(5);
pub const PERIOD: Duration = Duration::from_secs(20);

/// Run iptables with the given arguments, never longer than CMD_TIMEOUT.
pub fn run_iptables(args: &[String]) -> Outcome {
    let child = Command::new("iptables")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return Outcome::Fail(format!("spawn: {}", e)),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    use std::io::Read;
                    let _ = e.read_to_string(&mut err);
                }
                return if status.success() {
                    Outcome::Ok
                } else {
                    Outcome::Fail(err.trim().to_string())
                };
            }
            Ok(None) => {
                if start.elapsed() > CMD_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Outcome::Timeout;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Outcome::Fail(format!("wait: {}", e)),
        }
    }
}

impl Rule {
    pub fn new(port: u16, iface: &str) -> Rule {
        // does this iptables understand -w? (1.4.20+; the probe is a harmless list)
        let wait_opt = match run_iptables(&[
            "-w".into(),
            "2".into(),
            "-t".into(),
            "nat".into(),
            "-L".into(),
            "PREROUTING".into(),
            "-n".into(),
        ]) {
            Outcome::Fail(e)
                if e.contains("nknown")
                    || e.contains("nvalid")
                    || e.contains("unrecognized")
                    || e.contains("Bad argument") =>
            {
                false
            }
            _ => true,
        };
        Rule {
            port,
            iface: iface.to_string(),
            wait_opt,
        }
    }

    fn args(&self, op: &str) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        if self.wait_opt {
            v.push("-w".into());
            v.push("2".into());
        }
        v.extend(
            [
                "-t",
                "nat",
                op,
                "PREROUTING",
                "-i",
                &self.iface,
                "-p",
                "udp",
                "--dport",
                "53",
                "-j",
                "REDIRECT",
                "--to-ports",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        v.push(self.port.to_string());
        v
    }

    pub fn present(&self) -> Option<bool> {
        match run_iptables(&self.args("-C")) {
            Outcome::Ok => Some(true),
            Outcome::Fail(_) => Some(false),
            Outcome::Timeout => None,
        }
    }

    pub fn add(&self) -> Outcome {
        run_iptables(&self.args("-A"))
    }

    /// Remove every copy of the rule (a crashed previous instance may have left one).
    pub fn remove_all(&self) -> bool {
        for _ in 0..8 {
            match run_iptables(&self.args("-D")) {
                Outcome::Ok => continue,
                Outcome::Fail(_) => return true,
                Outcome::Timeout => return false,
            }
        }
        true
    }
}

fn unsupported_error(e: &str) -> bool {
    e.contains("No chain/target/match by that name")
        || e.contains("Couldn't load target")
        || e.contains("can't initialize iptables table")
        || e.contains("Table does not exist")
}

pub fn keeper(rule: Rule, off_flag: &'static str, log: Arc<Logger>) {
    thread::Builder::new().name("iptables".into()).spawn(move || {
        log.log(&format!("iptables keeper: udp/53 on {} -> port {} ({}-w)", rule.iface, rule.port, if rule.wait_opt { "with " } else { "no " }));
        let mut unsupported = false;
        let mut had_rule = false;
        let mut fails: u32 = 0;
        loop {
            let present = rule.present();
            if Path::new(off_flag).exists() {
                if present == Some(true) {
                    if rule.remove_all() { log.log("dns redirect rule removed (flag t2c_dnsredir_off)"); had_rule = false; }
                }
            } else if !unsupported && present == Some(false) {
                match rule.add() {
                    Outcome::Ok => {
                        log.log(if had_rule { "dns redirect rule was gone (nat flushed), re-added" } else { "dns redirect rule added: wlan0 udp/53 -> forwarder" });
                        had_rule = true;
                        fails = 0;
                    }
                    Outcome::Fail(e) if unsupported_error(&e) => {
                        log.log(&format!("iptables REDIRECT not available ({}): the car must use the DHCP resolver for *.internal", e));
                        unsupported = true;
                    }
                    Outcome::Fail(e) => {
                        fails += 1;
                        if fails == 1 || fails % 10 == 0 { log.log(&format!("iptables -A failed ({}), retrying: {}", fails, e)); }
                    }
                    Outcome::Timeout => {
                        fails += 1;
                        if fails == 1 || fails % 10 == 0 { log.log(&format!("iptables -A timed out ({}), retrying", fails)); }
                    }
                }
            } else if present == Some(true) {
                had_rule = true;
            }
            thread::sleep(PERIOD);
        }
    }).expect("spawn");
}
