#!/usr/bin/env python3
"""Talk to the adapter over its USB serial console (flag t2c_usb: t2cd puts a CDC-ACM gadget on the
USB-C port with a root shell on /dev/ttyGS0). macOS shows it as /dev/cu.usbmodem*; no driver, no
Wi-Fi needed. Standard library only.

    tools/usbserial.py ports                      list candidate ports
    tools/usbserial.py cmd 'ps; free'             run a command, print its output
    tools/usbserial.py flash build/T2C-tesla-ui-26101722.img
                                                  push the image to /tmp/update.img and watch the updater
    tools/usbserial.py shell                      interactive shell (or just: screen /dev/cu.usbmodem* 115200)
    --port /dev/cu.usbmodemXXXX                   pick the port when several exist

How `flash` works: the console shell is switched to raw mode and `head -c SIZE > /tmp/update.tmp`
reads exactly the image bytes, md5sum is compared, the file is renamed to /tmp/update.img (the
vendor updater watches that name, as the OTA page's upload does), and ly_update_status is polled
until it reports done (3) or an error (>3). The adapter then reboots on its own.
"""
import glob
import hashlib
import os
import select
import sys
import termios
import time
import tty

PROMPT = b"]# "


def adapter_serials():
    """USB serial numbers of attached devices whose product name is the adapter's (macOS ioreg)."""
    import re
    import subprocess
    try:
        out = subprocess.run(["ioreg", "-p", "IOUSB", "-l", "-w0"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    found = []
    for block in re.split(r"\n(?=[\s|]*\+-o )", out):
        if re.search(r'"USB Product Name" = "T2C"', block) or re.search(r'"USB Vendor Name" = "Carlinkit"', block) or re.search(r'"USB Product Name" = "Tina"', block):
            m = re.search(r'"USB Serial Number" = "([^"]+)"', block)
            if m:
                found.append(m.group(1))
    return found


def find_port(explicit):
    if explicit:
        return explicit
    ports = sorted(glob.glob("/dev/cu.usbmodem*")) + sorted(glob.glob("/dev/ttyACM*"))
    if not ports:
        sys.exit("no USB serial port (is t2c_usb set and the adapter plugged into this computer?)")
    for serial in adapter_serials():
        for p in ports:
            if serial in p:
                return p
    if len(ports) > 1:
        sys.exit("several USB serial ports and none looks like the adapter; --port to choose: " + " ".join(ports))
    return ports[0]


class Console:
    def __init__(self, port):
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self.fd)
        tty.setraw(self.fd)
        attrs = termios.tcgetattr(self.fd)
        attrs[4] = attrs[5] = termios.B115200
        attrs[2] |= termios.CLOCAL | termios.CREAD
        termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        # back to blocking reads with our own timeouts via select
        flags = os.O_RDWR | os.O_NOCTTY
        os.set_blocking(self.fd, True)

    def read_until(self, marker, timeout):
        buf = b""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if r:
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    break
                buf += chunk
                if marker in buf:
                    return buf, True
        return buf, False

    def drain(self, secs=0.3):
        end = time.monotonic() + secs
        while time.monotonic() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                if not os.read(self.fd, 65536):
                    break

    def write(self, data):
        view = memoryview(data)
        while view:
            _, w, _ = select.select([], [self.fd], [], 5)
            if not w:
                raise TimeoutError("serial write stalled")
            n = os.write(self.fd, view[:4096])
            view = view[n:]

    def sync(self):
        """Get a fresh prompt (the shell may be mid-line from an earlier session)."""
        self.drain()
        self.write(b"\x03\n")
        out, ok = self.read_until(PROMPT, 3)
        if not ok:
            self.write(b"\n")
            out, ok = self.read_until(PROMPT, 3)
        if not ok:
            sys.exit("no shell prompt on the port (got %r)" % out[-80:])

    def cmd(self, command, timeout=30):
        """Run one command; returns its output without the echo and the next prompt."""
        marker = b"__T2C_%d__" % int(time.time() * 1000)
        line = command.encode() + b"; echo " + marker + b"\n"
        self.write(line)
        out, ok = self.read_until(marker + b"\r\n", timeout)
        if not ok:
            out, _ = self.read_until(marker, 2)
        text = out.decode("utf-8", "replace")
        # drop the echoed command line and everything from the marker on
        text = text.split(marker.decode(), 1)[0]
        if "\n" in text:
            text = text.split("\n", 1)[1]
        self.read_until(PROMPT, 2)
        return text.replace("\r\n", "\n").rstrip("\n")


def do_flash(con, path):
    data = open(path, "rb").read()
    size = len(data)
    md5 = hashlib.md5(data).hexdigest()
    print("image %s: %d bytes md5 %s" % (path, size, md5))
    print("adapter:", con.cmd("cat /tmp/t2c_version 2>/dev/null; grep -o 'appver[^,]*' /tmp/system.json 2>/dev/null | head -1; df /tmp | tail -1"))
    con.cmd("rm -f /tmp/update.tmp /tmp/update.img")
    # raw mode: no echo, no ^C, no CR/LF translation while the bytes stream in
    con.write(b"stty raw -echo; head -c %d > /tmp/update.tmp; stty sane; echo __RECV_DONE__\n" % size)
    time.sleep(0.5)
    t0 = time.monotonic()
    sent = 0
    for i in range(0, size, 65536):
        con.write(data[i:i + 65536])
        sent += min(65536, size - i)
        if sent % (1024 * 1024) < 65536:
            el = time.monotonic() - t0
            print("\r  sent %5.1f MB  %5.0f KB/s" % (sent / 1e6, sent / 1024 / max(el, 0.01)), end="", flush=True)
    out, ok = con.read_until(b"__RECV_DONE__", 120)
    print("\r  sent %.1f MB in %.0f s%s" % (size / 1e6, time.monotonic() - t0, "" if ok else "  (no completion marker)"))
    con.read_until(PROMPT, 3)
    got = con.cmd("md5sum /tmp/update.tmp | cut -d' ' -f1; stat -c %s /tmp/update.tmp 2>/dev/null || ls -l /tmp/update.tmp", 60)
    print("adapter has:", got.replace("\n", " "))
    if md5 not in got:
        sys.exit("md5 mismatch: not flashing")
    con.cmd("mv /tmp/update.tmp /tmp/update.img && sync")
    print("renamed to /tmp/update.img; the updater runs now (ly_update_status), watching:")
    last = None
    for _ in range(600):
        time.sleep(2)
        try:
            st = con.cmd("cat /sys/class/misc/ly_misc_dev/ly/update", 5)
        except Exception as e:  # the port vanishes when the adapter reboots
            print("\nport gone (%s): the adapter is rebooting into the new image" % e)
            return
        if st != last:
            print(" ", st)
            last = st
        if "=3" in st:
            print("done: written, the adapter reboots")
            return
        if st and st.rsplit("=", 1)[-1].strip().isdigit() and int(st.rsplit("=", 1)[-1]) > 3:
            sys.exit("updater reported an error: " + st)


def do_shell(con):
    print("interactive; Ctrl-] to quit")
    old = termios.tcgetattr(0)
    try:
        tty.setraw(0)
        con.write(b"\n")
        while True:
            r, _, _ = select.select([0, con.fd], [], [])
            if 0 in r:
                k = os.read(0, 1024)
                if b"\x1d" in k:
                    break
                con.write(k)
            if con.fd in r:
                d = os.read(con.fd, 65536)
                if not d:
                    break
                os.write(1, d)
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, old)
        print()


def main():
    args = sys.argv[1:]
    port = None
    if "--port" in args:
        i = args.index("--port")
        port = args[i + 1]
        del args[i:i + 2]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    if args[0] == "ports":
        ports = sorted(glob.glob("/dev/cu.usbmodem*")) + sorted(glob.glob("/dev/ttyACM*"))
        serials = adapter_serials()
        for p in ports:
            print(p, "<- adapter" if any(sn in p for sn in serials) else "")
        if not ports:
            print("none")
        return
    con = Console(find_port(port))
    con.sync()
    if args[0] == "cmd":
        print(con.cmd(" ".join(args[1:])))
    elif args[0] == "flash":
        do_flash(con, args[1])
    elif args[0] == "shell":
        do_shell(con)
    else:
        sys.exit("unknown action " + args[0])


if __name__ == "__main__":
    main()
