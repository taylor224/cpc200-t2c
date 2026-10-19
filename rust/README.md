# Rust on the adapter

`t2cd/` is the first Rust component on the T2C: a static ARMv7 musl binary, no dependencies, built
with nothing but the Rust toolchain:

```
rustup target add armv7-unknown-linux-musleabihf      # once
cd rust/t2cd
cargo test                                             # native, mock upstream resolvers
cargo build --release --target armv7-unknown-linux-musleabihf
```

`.cargo/config.toml` makes the cross build self-contained: rustc's bundled crt objects + `libc.a`
and `rust-lld` link it (no gcc, no zig, no sysroot). `tools/build.sh` picks the binary up from
`target/armv7-unknown-linux-musleabihf/release/t2cd` and ships it as `app/t2cd` (~450 KB, ~200 KB
in the squashfs); `app/blink.sh` starts it after gocsdk and `app/t2c_watchdog.sh` restarts it.

Bench loop without a flash: build, then from a machine on the adapter's Wi‑Fi

```
curl --data-binary @target/armv7-unknown-linux-musleabihf/release/t2cd 'http://192.168.3.1/cgi-bin/t2c.cgi?a=put&f=t2cd'
curl 'http://192.168.3.1/cgi-bin/t2c.cgi?a=t2cd_restart'
curl 'http://192.168.3.1/cgi-bin/t2c.cgi?a=cat&f=t2cd_log'
```

An uploaded `/tmp/t2cd` wins over the firmware's copy until `?a=unput&f=t2cd` or a reboot. It is
kept in RAM on purpose: the 1.8 MB jffs2 UDISK holds the Bluetooth pairing and the Wi-Fi config,
and filling it is how the adapter lost both on 2026-10-18.

Debug shell (the rootfs busybox has no telnetd/nc): set the flag, connect, remove the flag.

```
curl 'http://192.168.3.1/cgi-bin/t2c.cgi?a=flag&f=shell&v=1'
tools/shell.py                       # interactive root shell on a pty, Ctrl-] quits
tools/shell.py -c 'ps; free'         # one command, output, exit
curl 'http://192.168.3.1/cgi-bin/t2c.cgi?a=flag&f=shell&v='
```

Ports: DNS forwarder udp/5300 (5353 belongs to mdnsd), shell tcp/2323; `--no-shell`,
`--shell-port`. A bench build can key the shell on another flag file
(`T2CD_SHELL_FLAG=/mnt/UDISK/t2c_dnsdebug cargo build …`) when the firmware's CGI predates the
`shell` flag.

What `t2cd` does today is in `t2cd/src/main.rs` (DNS forwarder for the car + the nat REDIRECT
rule). The plan for the rest — replacing `lylinkui` itself — is `docs/REWRITE-PLAN.md`; the vendor
FFI step needs the device's rootfs for a dynamic-musl sysroot: `?a=rootfs` dumps it.

## Dynamic builds against the vendor libraries (`lyshim/`, the rewrite)

```
tools/mksysroot.sh                                     # rust/sysroot from build/rootfs + work/customer/app/ui (+ import stubs)
cd rust/lyshim && cargo build --release --target armv7-unknown-linux-musleabihf
rust/lyshim/run.sh 90                                  # push helper + shim, swap it in for lylinkui, collect the log, put lylinkui back
```

`run.sh` pushes `src/app/t2c_dev.sh` and the shim to /tmp, runs `t2c_dev.sh stop-ui`, the shim
(with its exit code), `start-app` (lylinkapp is started by lyLoadModule.sh, not by the library),
prints `/tmp/lyshim.log` plus the relevant logcat lines, then `stop-ui; start-ui` -- which restarts
hostapd, so rejoin the Wi-Fi afterwards. Never relaunch `tesla -s` by hand (empty `WIFI_NAME` =
nameless AP) and never `. /etc/profile` on the adapter (its last line boots a second vendor stack);
`t2c_dev.sh` replicates the exports instead.

`lyshim/.cargo/config.toml` is the recipe: `-C target-feature=-crt-static`, PIC, rust-lld with
rustc's own crt objects and `-lunwind`, `--dynamic-linker=/lib/ld-musl-armhf.so.1`, and
`-L native=rust/sysroot/{stub,lib,vendor}` **as rustc `-L` flags, not `-C link-arg=-L`**: rustc puts
its own self-contained musl directory (which holds a static `libc.a`) before any link-arg, and the
device's `libc.so` has no section headers so lld cannot read it -- together that silently linked a
second malloc into the binary, and the first `free()` of a chunk the vendor library had allocated
from `/lib/libc.so` tripped musl's `a_crash()` (SIGILL). `tools/mkstub.py` therefore builds
import-only `rust/sysroot/stub/{libc.so,libgcc_s.so.1}` with exactly the device's exports; check a
build with `llvm-readelf -d` (NEEDED must list `libc.so`) and `--dyn-syms` (no local `malloc`/`free`).

The shim installs a SIGSEGV/SIGBUS/SIGILL/SIGABRT reporter (`on_fault`) that prints the fault
address, pc/lr/sp and the `/proc/self/maps` line holding pc -- the kernel logs nothing for user
faults and busybox has no gdb. Keep it in the rewrite.

### What the vendor library expects (verified on the adapter, 2026-10-19)

- `lylinkapi_start(struct*)` (76 B, see `vendor.rs`): +0 w/h, **+4 driver side**, +8 mode 2,
  +0xc callback, +0x10 mm, **+0x14 night (0 / 2)**, +0x18 fun 0x512, +0x1c name[32], **+0x3c flags
  0x3910 standard / 0x2910 smooth frame rate**; it creates the unix-socket server;
  lylinkapp connects, gets the display config (cmd 0), sends cmd 8 = its version -> callback 18.
- Callback is `cb(type, int, ptr)`: 1 LINK_ESTABLISH (flag) .. 6 BACKGROUND, 7 VIDEO_START (ptr to
  dims), 13 RECORD_INIT, 14 SPSPPS (len, data), 15 VIDEO_UNIT (len, data -- the library owns the
  buffer, do **not** free it; lylinkui copies), 18 APP_VERSION (errcode, "V2.xx.00"), 21-24 =
  `lylinkapi_free(ptr)`, 27 BT_GOCSDK (len, str), 29 TIME (ptr to i64). Full table from lylinkui's
  dispatcher jump table at 0x1426c.
- `lylinkapi_wifi(196 B struct)` type 6 hands the hotspot (ssid +8, psk +0xa8, callback +0xc0) to
  the library, which forwards it to lylinkapp (iAP tells the phone) and runs a wpa_ctrl watcher.
- `lylinkapi_stop()` is clean when a client is connected (fires LINK_DISCONN); with no client it
  SIGILLs (seen in round 1).

## `t2cui/` -- the UI server (P3, in progress)

What `lylinkui` does, in Rust: HTTP for the page (static files from the www dir, `index.in`
rendered like stock, `/tsl/bt`, `/tsl/fw`, `/online/status.html`, `/health`), the tsl WebSocket
protocol (`protocol.rs` mirrors `src/www/js/protocol.js`), settings in the 556-byte `lycfg.txt`
(`config.rs`, plus a small sidecar for auto/fps/online), and the session logic (`session.rs`:
link/phone state, newest page gets the status+pong, per-page bounded queues, drop-until-IDR with
rate-limited key-frame requests, restarts spaced 10 s apart, override/preset size rules). The
CarPlay side is a `Backend`: `vendor.rs` (liblylinkui in-process, adapter only) or `mock.rs`
(replays an Annex-B file; `ffmpeg -f lavfi -i testsrc2=size=768x608:rate=30 -t 20 -c:v libx264
-g 30 -bf 0 -bsf:v h264_mp4toannexb -f h264 sample.h264` makes one).

```
cd rust/t2cui && cargo test && cargo build --release          # Mac build, unit tests
target/release/t2cui --www ../../src/www --port 8791 --cfg /tmp/lycfg.txt --mock sample.h264 --debug
cargo build --release --target armv7-unknown-linux-musleabihf   # adapter build (473 KB)
rust/t2cui/run.sh start | log | stop                           # bench loop on the adapter (port 8081)
```

`gocsdk.rs` owns `/dev/goc_serial` (the Bluetooth daemon's AT pty) the way stock lylinkui's lygoc
module did: Bluetooth link state, `NC` -> udhcpc on bt-pan + MASQUERADE (the adapter's internet
through the phone), `AT#NC<mac>` requests, `AT#CC/CD<mac>` for the page's connect/disconnect
buttons. Caveat learned the hard way: gocsdk answers every command with its whole status block, and the
block contains `IS1`/`MX` lines that stock lylinkui answers (`AT#P1`, `AT#MH`) under conditions not
decoded yet -- answering them unconditionally loops at 1 400 lines/s, so t2cui only sends `AT#P0`
at open, `AT#P1` when `IS0` says Bluetooth is off (the trigger stock uses; `IS1` is not it),
`AT#MM` for `IA` (rate-limited), stock's reconnect `AT#CC<mac>` while no phone is connected (`CN`
/ `DR` track that), `AT#NC<mac>` for the PAN, and the page's `AT#CC`/`AT#CD`; it mutes itself
above 300 lines/s. `wifi.rs` writes /tmp/hostapd.conf from the rootfs template and starts hostapd when it
is missing. Both are on by default on the adapter (`--gocsdk 0`, `--wifi-handoff 0` for bench runs
next to stock pieces).

Status 2026-10-19 night: **the default UI since 26101719** (lyLoadModule.sh starts it instead of
`tesla` unless `/mnt/UDISK/t2c_ui_stock` exists; the watchdog relaunches it; the phone page's
System card switches `t2c.cgi?a=flag&f=ui_stock&v=1|` and reboots). 26101709..18 shipped it
behind the opt-in flag `/mnt/UDISK/t2c_ui_rust`, now ignored. On the
bench it does the whole boot job: hostapd.conf + hostapd, credentials to the phone through the
library, Bluetooth on (`IS0` -> `AT#P1`), reconnect (`AT#CC`), CarPlay session, PAN (`AT#NC` ->
udhcpc + MASQUERADE), the page with video and touch. 26101712 adds the page's "Restart adapter" (cmd 10), car identity (icon copied to
/tmp/lylink/home.png + session restart), the phone's name from gocsdk, bench routes only with the
shell flag, the phone page sending a Tesla browser to :8080, and the corrected start struct
(driver / night / FPS flags). 26101711 adds the LEDs (`leds.rs`, sysfs
`0xRRGGBB`), touch scaled to session pixels, a plain-IP listener (`http://192.168.3.1:8080/`),
the car-app icon switch (vendor event 19 -> page menu, back via cmd VIDEO -> untake), smooth FPS
= 2 in the start struct, picture mode refused with a page reload, and bench routes (`/health`,
`/cmd?take|untake|key=|cmd=`, `/led?name=&v=`). Not done: the night hint, the car-page firmware
hand-off is written like stock but unverified, `MX`/list queries, a long soak and the car. The
vendor UI stays in the image as the fallback until the car test; dropping it (and the patcher)
frees the squashfs space t2cd+t2cui need.
