#!/usr/bin/env python3
"""Interactive root shell on the adapter over t2cd's debug port (raw TCP, no telnet/SSH).

    tools/shell.py [HOST] [PORT]            default 192.168.3.1 2323
    tools/shell.py [HOST] --put FILE [NAME] copy FILE to /tmp/NAME on the adapter (mode 755, RAM only)
    tools/shell.py [HOST] -c 'SCRIPT'       run a script with /bin/sh -c (no pty), print its output,
                                            exit with its code; T2C_SHELL_TIMEOUT (s, default 60)

The adapter opens the port while /mnt/UDISK/t2c_shell exists:
    curl 'http://192.168.3.1/cgi-bin/t2c.cgi?a=flag&f=shell&v=1'   (v= empty closes it)
Window size is sent as a `\\x1dWS rows cols\\n` header and again on every resize. Ctrl-] quits.
"""
import os
import select
import signal
import socket
import sys
import termios
import tty

QUIT = b"\x1d"  # Ctrl-]


def winsize_header():
    try:
        sz = os.get_terminal_size(sys.stdin.fileno())
        return b"\x1dWS %d %d\n" % (sz.lines, sz.columns)
    except OSError:
        return b""


def run_once(sock, cmd):
    """Non-interactive: t2cd runs the script with `/bin/sh -c` (no pty, no line-length limit, no
    echo) and ends with `\x1dRC <code>`; we print the output and exit with that code."""
    data = cmd.encode()
    sock.sendall(b"\x1dCMD %d\n" % len(data) + data)
    buf = b""
    sock.settimeout(float(os.environ.get("T2C_SHELL_TIMEOUT", "60")))
    try:
        while True:
            d = sock.recv(65536)
            if not d:
                break
            buf += d
    except socket.timeout:
        sys.stderr.write("(timed out waiting for the command to finish)\n")
    rc = 1
    i = buf.rfind(b"\n\x1dRC ")
    if i >= 0:
        try:
            rc = int(buf[i + 5 :].split(b"\n", 1)[0])
        except ValueError:
            pass
        buf = buf[:i]
    sys.stdout.buffer.write(buf)
    sys.stdout.flush()
    sys.exit(rc)


def put_file(sock, local, name):
    """--put LOCAL [NAME]: store LOCAL as /tmp/NAME on the adapter (RAM only)."""
    data = open(local, "rb").read()
    sock.sendall(b"\x1dPUT %s %d\n" % (name.encode(), len(data)))
    sock.sendall(data)
    sock.settimeout(60)
    buf = b""
    try:
        while True:
            d = sock.recv(4096)
            if not d:
                break
            buf += d
    except socket.timeout:
        pass
    i = buf.rfind(b"\x1dRC ")
    rc = int(buf[i + 4 :].split(b"\n", 1)[0]) if i >= 0 else 1
    print("put /tmp/%s: %d bytes, rc %d" % (name, len(data), rc))
    sys.exit(rc)


def main():
    args = [a for a in sys.argv[1:]]
    cmd = None
    put = None
    if "--put" in args:
        i = args.index("--put")
        local = args[i + 1]
        name = args[i + 2] if len(args) > i + 2 and not args[i + 2].startswith("-") else os.path.basename(local)
        put = (local, name)
        del args[i : i + 2 + (1 if len(args) > i + 2 and not args[i + 2].startswith("-") else 0)]
    if "-c" in args:
        i = args.index("-c")
        cmd = args[i + 1]
        del args[i : i + 2]
    host = args[0] if args else os.environ.get("T2C_HOST", "192.168.3.1")
    port = int(args[1]) if len(args) > 1 else 2323
    try:
        sock = socket.create_connection((host, port), timeout=5)
    except OSError as e:
        sys.exit("cannot connect to %s:%d (%s) -- is the t2c_shell flag set? "
                 "curl 'http://%s/cgi-bin/t2c.cgi?a=flag&f=shell&v=1'" % (host, port, e, host))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    if put is not None:
        put_file(sock, put[0], put[1])
        return
    if cmd is not None:
        run_once(sock, cmd)
        return
    if not sys.stdin.isatty():
        sys.exit("stdin is not a terminal (use -c 'command')")
    sock.settimeout(None)
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    sock.sendall(winsize_header())
    resized = [False]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    print("connected to %s:%d  (Ctrl-] to quit)" % (host, port), file=sys.stderr)
    try:
        tty.setraw(fd)
        while True:
            try:
                r, _, _ = select.select([sock, fd], [], [], 0.5)
            except InterruptedError:
                r = []
            if resized[0]:
                resized[0] = False
                sock.sendall(winsize_header())
            if sock in r:
                d = sock.recv(4096)
                if not d:
                    break
                os.write(sys.stdout.fileno(), d)
            if fd in r:
                d = os.read(fd, 4096)
                if not d or QUIT in d:
                    break
                sock.sendall(d)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        sock.close()
        print("\ndisconnected", file=sys.stderr)


if __name__ == "__main__":
    main()
