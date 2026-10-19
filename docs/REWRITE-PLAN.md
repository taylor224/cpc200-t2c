# Replacing `lylinkui` with a Rust daemon — plan (2026-10-18)

`lylinkui` (`/tmp/lylink/tesla`, 120 KB, C++, libwebsockets 3.2) is the process between the car
browser and `lylinkapp` (the CarPlay stack). Every fix so far has been a binary patch (14 of them in
`tools/patch_lylinkui.py`): the access-unit leak, the blocking hand-off, the unbounded page queue,
8 KB WebSocket fragments, the session teardown on page close, the idle Wi‑Fi sleep, the DNS table.
What is still wrong needs more than patches: no DNS forwarding (`carplay.internal` fails on a car
that ignores DHCP DNS), no observability, TLS only through the stock certificate, a status thread
that stalls, MJPEG transcoding nobody uses. A rewrite is feasible; this is the shape of it.

## 1. What lylinkui actually does (inventory from the disassembly and the device logs)

Threads: lws service loop (HTTP + WebSocket, one thread), the vendor IPC/event path
(`lylinkapi_work`, delivers `LYLINK_*` events and video access units into the dispatcher
`0x14250`), status thread (status JSON + pong once a second), `ly_misc_thread` (LED ioctls,
idle countdown, online check, PAN monitor `btpan_run`), `dnsd` (UDP 53 fake resolver),
picture‑mode thread (`lylink_h264_*`: hardware H.264 decode + JPEG for `/video.jpg`).

Imports that matter (everything else is libc/libstdc++):

| from | symbols | role |
|---|---|---|
| `liblylinkui.so` (50 KB) | `lylinkapi_start/stop/work/cmd/key/touch/bt/wifi/record/free` (+ `hid/mouse/volume` unused) | the whole lylinkapp side: session start with size/fps/driver/night, commands (2 take screen, 3 untake, 12 restart hostapd …), input, Bluetooth ops, event callback, **and the lylinkapp process itself** (the lib imports `fork/execv/kill/waitpid`: it respawns lylinkapp on session restarts and after exits) |
| `liblylinkserver.so` (22 KB) / `liblylinkmw.so` (34 KB) | `cmdsvr_*`, `inputsvr_*`, `lylinksvr_*`, `lylink_createserver`, `lylinkos` | unix‑socket IPC server (`/tmp/lylinksvr` ↔ lylinkapp's `liblylinkclient.so`), the `lylinkos` lock singleton |
| `libwebsockets.so.15` (212 KB) + `libssl/libcrypto 1.1` | 20 `lws_*` calls | HTTP/HTTPS/WS server; libssl/libcrypto stay anyway (lylinkapp needs them) |
| `liblylinkav.so` (1.27 MB) | `lylink_h264_init/start/process/stop/exit` | picture mode (eyesee‑mpp hardware pipeline) — dropped |
| `liblymodel.so` | `ly_model_*` | cellular modem; T2C has none (`find model not N58`) — stubbed |
| `liblylinkpcm.so` | `pcmrecord_create/delete` | `/mic_test.pcm` for products with a microphone — dropped |
| `liblog.so` | `__android_log_print` | logcat — kept, so `t2c.cgi?a=log` stays useful |

Files and processes it owns: `/mnt/UDISK/lycfg.txt` (556 B settings, see NOTES), `/tmp/hostapd.conf`
(generated from `/etc/wifi/hostapd.conf`) + `system("hostapd -B …")`/`killall hostapd`/
`killall udhcpc`, `wpa_ctrl` to `/var/run/hostapd/wlan0` (channel, stations), `/tmp/lylink/www`
(static root, `index.in` → `index.html` templating at every hello), `/tmp/lylink/home.png` (car
icon), `/tmp/lylink_btpan`, `/dev/ly_misc_dev` ioctls (`0x4c01/02/10/80/81/82/83`: LEDs, update
flag), `/sys/class/misc/ly_misc_dev/ly/update`, the factory‑reset command, the firmware upload
(`POST /tsl/fw` → file → stock `update` daemon), the fake DNS table.

Wire protocols the page depends on: NOTES.md › *WebSocket protocol* (client types 1–13, server
types 0–5/100–103/300), `GET /tsl/bt`, `POST /tsl/fw`, `/online/status.html`, template tokens
`|NN`. The page (`src/www`) is already ours and needs no change for a compatible server.

## 2. Rust: yes, with one hard constraint

The rootfs is **musl** (`/lib/ld-musl-armhf.so.1`, Allwinner Tina/OpenWrt, kernel 4.9.118,
Cortex‑A7). Rust target `armv7-unknown-linux-musleabihf` exists. Two ways to talk to lylinkapp:

- **B1 — reuse the vendor libs through FFI** (recommended first). Link `liblylinkui.so` +
  `liblylinkserver.so` + `liblylinkmw.so` + `liblog.so` dynamically. Then the binary cannot be
  static: it must be a dynamic executable against the device's musl (`-C target-feature=-crt-static`,
  `--dynamic-linker=/lib/ld-musl-armhf.so.1`, link against a sysroot made of the device's
  `/lib/libc.so`, `libgcc_s`, `liblog.so` and `app/ui/*.so`). `cargo zigbuild` (zig as the cross
  linker) or `rust-lld` with that sysroot both work for this. ABI surface to get right: the
  `lylinkapi_start` parameter struct (built in `func_13d4c`: pixel size, mm size, fps, driver,
  night, flags at +0x3c, mode at +0x8), the event callback registration (`lylinksvr_set` via the
  start struct — to confirm), the event ids behind `LYLINK_VIDEO_START/STOP`, `PHONE_CONNECT/
  DISCONN`, `LINK_ESTABLISH/DISCONN`, `BT_GOCSDK`, `FOREGROUND/BACKGROUND`, and the video unit
  delivery (case 14 of the dispatcher: pointer + length, SPS/PPS cached by the receiver,
  `lylinkapi_free` for ownership).
- **B2 — fully static, no vendor code in-process.** The three vendor libs are tiny (106 KB
  together); their unix‑socket framing (`ch[n] cmd = m` + payload, `videocli_send` on channel 2,
  `cmdcli_*` on channel 0, input on another) can be reverse‑engineered completely, and lylinkapp
  supervision (fork/exec, relaunch on exit) is a few lines. Result: one static musl binary, zero ABI
  risk, dlopen not needed. More reverse engineering up front; cleaner forever after. Natural
  second step once B1 runs.

Size budget: the customer partition has 348 KB free in the current image; dropping `lylinkui`
(120 KB) and `libwebsockets.so.15` (212 KB) adds ~140 KB compressed. A Rust daemon with `std`
only, hand‑rolled HTTP/1.1 + WebSocket (RFC 6455: SHA‑1 + base64, ~150 lines), no tokio, no
serde, `opt-level = "z"`, LTO, `panic = "abort"`, stripped, lands around 400–700 KB, ~200–250 KB
after xz in squashfs. Fits. TLS (`rustls`) would add ~900 KB; plan without it (HTTP at
`http://101.200.208.6/` and `http://carplay.internal/`), add later if the HTTPS `tespush.com` entry
must survive.

Toolchain on the Mac today: rustup (stable aarch64‑apple‑darwin), no cross target installed, no
zig. Needed: `rustup target add armv7-unknown-linux-musleabihf`, `brew install zig` +
`cargo install cargo-zigbuild` (or `arm-none-linux-gnueabihf` binutils for lld), and the device
sysroot.

## 2b. Rust or C++?

Both cross‑compile through zig (`zig cc`/`zig c++ -target arm-linux-musleabihf` bundles musl and a
static libc++; Rust uses the same zig as its linker via cargo‑zigbuild), so the toolchain cost is
the same. What differs:

| | C++ | Rust |
|---|---|---|
| vendor FFI (`lylinkapi_*`, callbacks) | direct, write the headers from the disassembly | `extern "C"` + `unsafe` wrappers, or a 100‑line C shim built by the `cc` crate |
| keep libwebsockets 3.2 + libssl (TLS with the stock `tespush.com` cert) | yes, link the device's `.so` | no (an lws FFI is not worth it); HTTP only, or `rustls` (+900 KB) |
| binary size | 200–400 KB (C‑style C++, no iostream/exceptions, `-Os`, gc‑sections) | 400–700 KB |
| the bugs this project fought (leaked/unbounded/blocking hand‑off, use after close) | discipline (RAII, bounded queues, no raw lists) | the type system refuses most of them |
| crash on the device | SIGSEGV with no gdb, no `backtrace()` on musl: blind | panic message + file:line through the liblog hook; UB confined to the FFI layer |
| Mac‑side mock tests | cmake + a mock backend | `cargo test` + a mock backend |
| path to the fully static B2 build | fine | fine (and the natural end state) |

Decision: **Rust for the daemon**, with the vendor FFI behind a small C shim if the callback ABI
gets awkward. The reason is the device, not the language: iteration is a reboot per try with
logcat as the only debugger, and every lylinkui problem so far was memory or concurrency. C++ wins
only if keeping lws/TLS matters (it does not: the entry point becomes `http://101.200.208.6/` or
`http://tespush.com/`, which lylinkui already serves over plain HTTP) or if picture mode
(`liblylinkav`, a heavy C API) were to stay (it is dropped).

## 2c. Status (2026-10-18)

- P0: `armv7-unknown-linux-musleabihf` installed; **static builds need no zig and no sysroot**
  (rustc's self-contained crt + `rust-lld`, see `rust/t2cd/.cargo/config.toml`). zig/cargo‑zigbuild
  and the rootfs dump (`t2c.cgi?a=rootfs`) are only needed for the dynamic B1 build. Deploy loop:
  `t2c.cgi?a=put&f=t2cd` + `?a=t2cd_restart` (no flash).
- P1: `rust/t2cd` written and unit/integration tested on the Mac (table answers, forwarding with
  retry, SERVFAIL, offline mode); cross build 448 KB static, 203 KB xz; shipped in 26101704 as
  `app/t2cd`, started by `blink.sh`, supervised by the watchdog. Not yet run on the adapter.
- P1 hardening (independent review + fuzz, 2026-10-18): every iptables call has a lock wait and a
  5 s kill timeout, only a missing target marks the kernel unsupported (transient failures retry);
  replies are accepted only from the resolver asked and only with the matching question, ids are
  random; a silent resolver is penalised for 30 s; queries from outside the hotspot /24 are ignored
  (no open resolver towards the PAN); persistent socket errors exit the process (the watchdog
  restarts it) instead of leaving a live useless pid; the logger never panics on I/O and rotates
  through a temp file; DNS labels are sanitised before logging; a panic hook logs file:line before
  the abort. Mutual supervision: the shell watchdog relaunches t2cd within 15 s, t2cd relaunches
  the watchdog within 60 s. Fuzzed natively with 60k packets (garbage, truncated, 70-label names,
  compression pointers): no crash, RSS flat.
- Debug access (2026-10-18, device-tested): the rootfs busybox has **no telnetd, nc, stty or
  getty** (applet list in NOTES), so `t2cd` serves the shell itself: `/mnt/UDISK/t2c_shell` →
  `/bin/sh -i` on a pty, raw bytes over tcp/2323, hotspot clients only, 3 sessions max, listener
  closed when the flag goes (`rust/t2cd/src/shell.rs`, client `tools/shell.py`, one-shot
  `tools/shell.py -c 'cmd'`). No SSH: there is no password to protect anyway (the CGI already
  reboots, rewrites Wi-Fi and uploads binaries over the same hotspot).
- Device run (2026-10-18, 26101703 + uploaded t2cd): first upload died at once — **udp/5353 is
  mdnsd's** (Bonjour for CarPlay), the bench never had it; the forwarder moved to **5300**. Then:
  REDIRECT rule kept, `carplay.internal`/`setting.internal` answered via port 53, upstream through
  the phone's PAN (example.com NOERROR, ~100 ms), AAAA → NOERROR/no data, 2 000 queries in 7 s
  (RSS 500 KB, 7 threads), flag `t2c_dnsredir_off` on/off removes/re-adds the rule within 20 s,
  the watchdog relaunched the dying first build and counted it (3 this hour), shell sessions
  open/close cleanly. Rootfs dumped (`build/rootfs/`, 3 MB squashfs, 490 inodes) → P0's sysroot
  input is in hand.
- 26101704 flashed 2026-10-18 (pairing and password untouched by the flash). First boot: the
  nat rule was flushed by lylinkapp 20 s after boot and re-added by the keeper, as designed.
- 26101705: radio-hang detector + evidence + guarded auto-reboot in the watchdog (NOTES › Radio
  hang), one-shot command mode in the debug shell (`\x1dCMD`, no pty, no 1 KB ash line limit,
  exit code) -- the deploy loop P2 needs.
- **P0 done, P2 under way (2026-10-19).** Dynamic musl Rust binaries build with nothing but
  rust-lld: `rust/lyshim/.cargo/config.toml` links `-crt-static`, PIC, against `rust/sysroot`
  (`tools/mksysroot.sh`: device `libc.so`/`liblog.so`/`libgcc_s`/`libstdc++` from the rootfs dump +
  `app/ui/*.so`), `--dynamic-linker=/lib/ld-musl-armhf.so.1`, and Rust's bundled `-lunwind`
  (the device libgcc_s carries no `_Unwind_*`). Deploy loop: `tools/shell.py --put FILE` → `/tmp/`,
  `app/t2c_dev.sh run /tmp/lyshim …` (26101706). A hello world ran on the adapter.
- **Picture mode (26101721, 2026-10-20).** The last stock feature the Rust UI lacked: MJPEG over
  `/video.jpg` through the vendor transcoder library (`liblylinkav.so`, `lylink_h264_*`), loaded
  with dlopen when the page asks for it. Bench: ~5 JPEG/s at 1376x1072, mode switches at run
  time in both directions without a session restart.
- **P5 default switch (26101719, 2026-10-19 night).** The Rust UI boots on every adapter;
  `/mnt/UDISK/t2c_ui_stock` (phone page System card "CarPlay screen", or
  `t2c.cgi?a=flag&f=ui_stock&v=1`) selects the vendor UI, the watchdog follows the same flag, a
  flash clears it. The vendor UI, lylinkui and the patcher stay in the image as the fallback until
  the car test passes; removing them is the next space win. Left: car test (bookmark
  `http://carplay.internal/`), night hint, `/tsl/fw` hand-off verification, `MX`/list queries.
- **P5 opt-in in the image (26101707, 2026-10-19 afternoon).** `app/t2cui` ships next to the stock
  UI; `/mnt/UDISK/t2c_ui_rust` makes lyLoadModule.sh start it instead of `tesla`, the watchdog
  relaunches it, the phone page toggles the flag and shows its log. Wi-Fi hand-off verified on the
  bench (the library's wpa_ctrl watcher attaches, lylinkapp logs `OnNotifyWifi ap ssid:
  'AutoKit_051E'`). Image size: 1 MB squashfs blocks (build.sh guard against the 0x640000 customer
  partition; 53 KB spare). Blocking a default switch (P4): the gocsdk module (`/dev/goc_serial`
  AT protocol: `AT#NC<mac>` -> `NC`/`IA`/`IB` lines -> udhcpc on bt-pan + MASQUERADE, `AT#CD`,
  `AT#CC<mac>`, `AT#P0/P1`, `AT#MM`, `AT#VE`, `AT#LS`; reply codes IS MM MF MX PO JH ER IV IA IB
  NC ND NS NA SA), LEDs (`/dev/ly_misc_dev` ioctls), `/tsl/fw` hand-off, night hint.
- **P3 server running on the adapter (2026-10-19 ~12:30).** `rust/t2cui` (HTTP/1.1, RFC 6455,
  the tsl protocol, lycfg.txt, session fan-out with per-page bounded queues and drop-until-IDR,
  `Backend` trait: `vendor.rs` on the adapter, `mock.rs` replaying an Annex-B file on the Mac;
  473 KB dynamic musl, std only). Mac: the real page in headless Chrome decodes the mock through
  it (`t2cui --www src/www --port 8791 --mock FILE.h264`). Adapter (`rust/t2cui/run.sh start`,
  0.0.0.0:8081 beside the stock phone-page httpd): the Mac's headless Chrome showed the iPhone's
  CarPlay home screen, the page's size override restarted the session at 752×464, a tap on the
  page opened an app (`inputcli_onrecv touch` in lylinkapp). Two findings on the way: the IDR a
  key-frame request produces arrives inside the type-14 SPS/PPS event (deliver it, keep only the
  parameter sets as codec config -- a parameter-sets-only message counts as a failed frame on the
  page and reads as "decoder too slow" after 5 s); PHONE_CONNECT (type 3) does not fire without
  the Bluetooth glue, so `phone` follows LINK_ESTABLISH for now. Still P3/P4: /tsl/fw hand-off
  to the stock updater, night hint to the phone, BT connect/disconnect/forget through gocsdk,
  hostapd.conf regeneration on channel/password change, LEDs, online check, PAN monitor, QR/lang
  details, a soak, then `tools/build.sh` integration behind a flag (P5).
- **P2 shim: the FFI is right (2026-10-19, rounds 2-7 on the adapter).** `rust/lyshim` started
  the vendor library, lylinkapp connected to it and an iPhone session ran through Rust:
  APP_VERSION → LINK_ESTABLISH → FOREGROUND → VIDEO_START 768×608 → SPSPPS (396 B) → 748 H.264
  access units / 5.5 MB in 150 s (static CarPlay screen; bursts of ~14 units/s on change), and
  `lylinkapi_stop` with a client attached is clean (BACKGROUND, LINK_DISCONN, VIDEO_STOP).
  `lylinkapi_key(1536)` reached the phone (new VIDEO_START + IDR at key-down). Two bugs on the
  way, both caught by the shim's own fault reporter: a second malloc linked in by accident (rustc's
  self-contained musl `libc.a` beat the device `libc.so`, which lld cannot read -- import stubs
  from `tools/mkstub.py` fix it, see rust/README.md) and the callback argument order. Corrected
  facts, replacing the paragraph below where they differ: the callback is `cb(type, int, ptr)`;
  type = lylinkui's jump-table index + 1 with 1 LINK_ESTABLISH, 2 LINK_DISCONN, 3 PHONE_CONNECT,
  4 PHONE_DISCONN, 5 FOREGROUND, 6 BACKGROUND, 7 VIDEO_START (ptr → {h<<16|w, flag, ptr, 1}),
  8 VIDEO_STOP, 9/10 AUDIO_START/STOP, 11/12 RECORD_START/STOP, 13 RECORD_INIT, 14 SPSPPS (len,
  data), **15 VIDEO_UNIT (len, data) -- the library owns the buffer, never free it** (lylinkui
  copies into its own queue), 18 APP_VERSION (errcode, "V2.00.00"), 21-24 `lylinkapi_free(ptr)`,
  27 BT_GOCSDK (len, str), 29 TIME. lylinkapp's version report (its cmd 8) is normal start-up, not
  an error. `lylinkapi_wifi` (196 B, type 6: ssid +8, psk +0xa8, callback +0xc0) hands the hotspot
  to the library, which forwards it to lylinkapp (iAP tells the phone) and starts a wpa_ctrl
  watcher thread. lylinkui's FOREGROUND handler answers with `lylinkapi_cmd(4)` (3 when g+0x31c
  is 0); the page's setting messages map to `lylinkapi_cmd(5)` and `(12)` (semantics: round 8).
  **Decision: B1** (vendor libs in-process) for P3/P4 -- the ABI is now known and exercised; B2
  stays the end state. Tooling that made this fast: `tools/elfsyms.py FILE logs DIS` (every
  `__android_log_print` call resolved to tag/function/line/format), `rust/lyshim/run.sh`.
- Vendor API as reverse-engineered so far (`tools/elfsyms.py` names the PLT slots in llvm-objdump
  listings): `liblylinkui.so` exports `lylinkapi_{start,stop,free,cmd,key,touch,mouse,hid,bt,wifi,
  volume,record,work}`; `lylinkapi_start(struct *p)` takes 76 bytes — +0 w u16, +2 h u16,
  +4 pixel (g+0x45a, 0), +8 mode = 2, +0xc event callback, +0x10/+0x12 mm w/h, +0x14 (g+0x450,
  0), +0x18 "fun" = 0x512, +0x1c char[32] car-icon name ("Auto" → app/Auto.png), +0x3c flags =
  0x2910 (bit 7 would make +0x44 an os-ops table for `lylinkos_set`). The callback is
  `int cb(int type, void *data, int len)`, type 1..29 = lylinkui's dispatcher case + 1: 2
  LINK_ESTABLISH, 3 LINK_DISCONN, 4 PHONE_CONNECT, 5 PHONE_DISCONN, 6 FOREGROUND, 7 BACKGROUND,
  8 VIDEO_START (w×h), 9 VIDEO_STOP, 10/11 AUDIO_START/STOP, 12/13 RECORD_START/STOP, 14
  RECORD_INIT (Hz/bits/channels), **15 video unit** (data + len, `lylinkapi_free` it), 18 data
  with a length, 20/26/27 Bluetooth/gocsdk strings. The library creates the unix-socket server
  (`lylink_createserver`) and its exec helper runs `hostapd -B /tmp/hostapd.conf`; **lylinkapp is
  started by lyLoadModule.sh** (`env LOCAL_IP_ADDRESS=$IPADDR $WORKDIR/lylinkapp &`), not by the
  library, and connects to that socket. Shim run 1: `lylinkapi_start` → 0, server created, no
  events because lylinkapp had been killed with lylinkui; `lylinkapi_stop` without a client
  crashed (SIGILL) — kill instead for now.
- Next: shim run 2 with lylinkapp (`t2c_dev.sh stop-ui; run /tmp/lyshim &; start-app`), expect
  PHONE_CONNECT → LINK_ESTABLISH → VIDEO_START 768×608 → units at ~30/s; then the
  `lylinkapi_*` call side (touch/key/cmd ids) and P3. `carplay.internal` from the car browser
  still needs a drive.

## 3. Phases

**P0 — toolchain and a fast deploy loop (1–2 days).**
Dump the rootfs once (`t2c.cgi?a=rootfs` reads `/dev/mtdblock4`, 3 MB squashfs — done 2026-10-18, `build/rootfs/`) →
sysroot with `libc.so`, `liblog.so`, `libgcc_s`, `libstdc++`, and the busybox applet list. Build a
dynamic musl hello world, run it on the adapter through a bench‑only hook: `/mnt/UDISK/t2c_ui_bin`
(uploaded with a new `t2c.cgi?a=put` guarded by a flag) is started by `lyLoadModule.sh` instead of
`/tmp/lylink/tesla` when present; `/mnt/UDISK/t2c_ui_stock` forces the stock binary. Iteration
becomes upload + `a=reboot` (40 s) instead of a 5‑minute flash. Verification: hello world logs to
logcat via `__android_log_print`.

**P1 — sidecar `t2cd`, static Rust, no vendor FFI (3–5 days; ships on its own).**
DNS forwarder on 192.168.3.1:5300 (table: `carplay.internal` → 101.200.208.6, `setting.internal`
→ 192.168.3.1; everything else forwarded to the PAN's resolver from `/etc/resolv.conf`, 8.8.8.8
fallback, 2 s timeout, in‑flight table keyed by id+client) + the nat REDIRECT of UDP/53 from
wlan0 to 5300 (the kernel has `REDIRECT`; no `string` match, so all car DNS is intercepted, which
is fine once we forward). Port of `t2c_watchdog.sh` (gocsdk/hostapd relaunch, health log) and of
the hostapd wrapper's HT40 logic. This proves the toolchain and the deploy loop with zero ABI
exposure and fixes `carplay.internal` even if the rest is never built.

**P2 — vendor API reverse engineering + `vendor.rs` (about a week).**
From `func_13d4c` (start struct), the dispatcher `0x14250` (event ids, unit delivery), the WS
handlers (`lylinkapi_touch(0, m, x, y)` with 0..1000 scaling, `lylinkapi_key(0x600/0x601, …)`,
`lylinkapi_bt(op, mac)`, `lylinkapi_wifi`, `lylinkapi_cmd` ids), `lylinkapi_free` ownership.
Deliverable: a Rust *shim* binary that only initialises the lib, logs every event, counts units and
relays nothing — run on the device in place of lylinkui with a phone attached. When the shim sees
`PHONE_CONNECT → LINK_ESTABLISH → VIDEO_START 1552x944` and units at the right rate, the FFI is
right. Also decide B1 vs B2 here (B2 if the socket framing turns out trivial).

**P3 — the server (1–2 weeks).**
HTTP/1.1 (static files with the lws MIME set incl. `.wasm.txt`, `/tsl/bt`, `/tsl/fw` upload,
`/online/status.html`, `index.in` templating), WebSocket with the `tsl` subprotocol and every
message type the page sends/expects, status/init/link JSON identical to stock (`t2c.cgi` and the
phone page read the same files), settings in the 556‑byte `lycfg.txt` format, session logic as the
page expects (type‑11 override, restart only on preset/fps/driver change or on request, hello never
restarts, closed socket never stops a session with a phone attached), video path = bounded ring
(10 units, drop‑until‑IDR, key‑frame request), one message per unit, last‑client‑wins without
restarts, no blocking anywhere on the IPC thread. Testable on the Mac first: the vendor layer sits
behind a trait (`LinkBackend`), with a mock that replays an Annex‑B file — the existing
`tools/cdp.py` page tests run against the Rust server exactly as against `devserver.py`.

**P4 — system glue (about a week).**
hostapd.conf generation + launch (the wrapper's logic moves in‑process), `wpa_ctrl` station list,
LED ioctls, online check (sets the DNS forwarder's state instead of silencing it), PAN monitor,
factory reset, firmware upload → stock `update` daemon, car icon, QR text, language, `/dev/ly_misc_dev`
update flag, logcat logging, a `/health` JSON (what the watchdog logs now) and a `/events` ring.
Picture mode stays dropped (`/video.jpg` 404; the page's MJPEG fallback only matters for browsers
without WebAssembly SIMD, i.e. none of the Tesla builds that run this UI).

**P5 — cutover and soak (about a week).**
Build ships both binaries for a release or two: Rust by default, stock behind
`/mnt/UDISK/t2c_ui_stock`. Car checks: browser close/open, phone reconnect, 30‑min Sharp drive,
update from the phone page, factory reset, Wi‑Fi password/channel change. Then delete the patcher.

## 4. Risks

- **ABI of the vendor structs** (B1): wrong field offsets crash lylinkapp, not just us; mitigated by
  the P2 shim and by B2 as the fallback.
- **musl dynamic linking from macOS**: expect a day of linker fiddling; mitigated by P0 being first.
- **Space**: 348 KB + 140 KB; a rustls build does not fit without dropping something else
  (candidates: the stock `ota/www` leftovers under `/usr/ota` are rootfs and untouchable; the
  decoder `.wasm.txt` is 1.4 MB uncompressed but already xz‑tight).
- **lylinkapp expectations** of the server side (ping cadence `lylinkcli_ping`, channel semantics,
  who owns `/tmp/lylinkcli`): only B2 carries this risk; B1 inherits the vendor code.
- **Unknown unknowns in the misc thread** (ioctl sequences for LEDs/power, the update handshake):
  copy the stock sequences verbatim from the disassembly, keep the stock binary selectable.

## 5. Effort

P0 1–2 d · P1 3–5 d · P2 ~5 d · P3 7–10 d · P4 ~5 d · P5 ~5 d → roughly five to six weeks of
part‑time work, three if focused; P1 alone pays for itself (DNS, watchdog) in under a week.
