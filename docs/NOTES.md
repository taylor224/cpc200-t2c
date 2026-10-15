# T2C firmware notes (branch 1508, image 26090414.5.4)

Everything below was recovered from the shipped binaries (`app/lylinkui`,
`app/ui/liblylinkui.so`, `app/www`) with `llvm-objdump` and string cross‑references.

## Image container

```
<md5 of body>  update.swu\n          (45‑byte text line)
CPIO "newc with CRC" (magic 070702):  sw-description, customer, kernel, TRAILER!!!
```
`customer` is a squashfs 4.0 (xz, 256 KiB blocks, all files root 0755) mounted at
`/mnt/customer`. `kernel` is an unchanged uImage. `sw-description` (SWUpdate) writes
`kernel` to `/dev/by-name/boot` and `customer` to `/dev/by-name/customer`. No signature.

## Boot

`lyLink.sh` copies `app/www` to `/tmp/lylink/www` (tmpfs), `app/ui/*` to `/tmp/lylink/lib`,
starts `lylinkui` (`tesla`) which is the HTTPS/WS server (libwebsockets 3.2.2) for the
vhosts `tespush.com`, `tespush.cn`, `tslpush.com` and the LAN IP, plus `lylinkapp`
(CarPlay session), `gocsdk` (Bluetooth), `udhcpd`, and the OTA `httpd` for `ota/www`.

## Template engine (lylinkui `func_13ab8`)

At every WebSocket hello (and on language change) `index.in` is rendered to
`index.html`: `lan/<n>.txt` is split into lines (max 128), then **every `|` character**
in `index.in` starts a token; the index is `(c[2]-'0')*10 + (c[3]-'0')` (only the last two
digits of `|NNN` are used) and four characters are consumed. The new UI therefore
contains no `|` at all and does all translation client‑side. `n` is the language index
stored in `lycfg.txt`: 0 zh‑CN, 1 zh‑TW, 2 en. Setting key 7 with a value > 2 means
*auto*: `navigator.language` starting with `zh-CN` → 0, `zh` → 1, anything else → 2.
Korean/Japanese cannot be persisted on the device.

## WebSocket protocol (`callback_tsl`, subprotocol `tsl`)

Client → server, little‑endian `Int16 [length, type]` + payload:

| type | payload | meaning |
|---|---|---|
| 2 | `[w, h]` + `lang\0` + `userAgent-from-"Tesla"\0` | hello; sizes stored as `w/10`,`h/10` bytes |
| 1 | `[m, x, y]` | touch, `m` 0 down / 2 move / 1 up, `x,y` 0..1000 |
| 3 | `[cmd]` | 0 start video, 1/2 auto‑connect on/off, 5 bt list, 6 disconnect, 7 factory reset, 8 key frame, 9 QR |
| 7 | `[key, value]` | 1 night (0..2, +3 = on), 2 pixel (0 1376×1072, 1 800×800, 2 768×608, 3 auto), 3 driver, 6 wifi channel, 7 language, 8 bt modem (1/2), 9 fps flag, 10 online check, 11 mode (0 picture, 1 video) |
| 8 | `[n]` | day/night hint forwarded to the iPhone |
| 10 | 12‑byte car name + icon id | car identity shown on iOS |
| 11 | `[w, h]` + `u8 mm_w, u8 mm_h` | **session override** for the next CarPlay session (0 clears) |
| 12 | `Uint32 [0x000C0004, n]` | ping |
| 13 | `[key, mod]` | key event |
| 4/5/6/9 | string | bt connect / disconnect / forget / wifi password |

Server → client, `Uint32 [length, type]` + payload: 0 status JSON (`sys, exe, apn, sig,
csq, bt, pong`), 1 init JSON (all settings, `link`, `phone`, `SW`, `LY`, `HW`, …), 2 bt
list changed, 3 `{link, phone}`, 4 firmware status `{val, pong}`, 5 reload, 100 complete
H.264 access unit, 101/102/103 first/middle/last fragment, 300 QR text.

HTTP: `GET /video.jpg` = `multipart/x-mixed-replace; boundary=CarPlayVideo` (picture
mode only; a single‑slot queue with back‑pressure to the encoder thread), `GET /tsl/bt`
(JSON list of `<flag><12‑hex mac><name>`), `POST /tsl/fw` (image upload), `GET
/mic_test.pcm`, `GET /online/status.html`. Static files are served from `/tmp/lylink/www`
with libwebsockets' MIME table (svg/json/woff2 included).

## CarPlay session size (`func_13d4c` → `lylinkapi_start`)

| pixel | width×height | "physical" mm |
|---|---|---|
| 0 | 1376×1072 | 344×330 |
| 1 (HD) | 800×800 | 200×160 |
| 2 (SD) | 768×608 | 149×124 |
| 3 (Auto) | 800×800 in picture mode, 800×(800·h/w) in video mode | nav/5, clipped below the pixel size |

When a type‑11 override is present it replaces all of the above. The iPhone renders at
the requested pixel size and derives its UI scale from pixels‑per‑millimetre, which is
why the UI exposes *CarPlay UI size* (≈6.4 / 5.2 / 4.2 px/mm). The session is
(re)started on every hello when `pixel == 3`, on any pixel/driver/fps change, and on
phone connect.

Until 26101504 the page kept the adapter in Auto and reloaded itself to get a hello whenever
the override changed — which also meant that every reconnect, reload or second page restarted
the CarPlay session (and the iPhone's Bluetooth PAN with it, see below). Now the page sends
the override and then moves the pixel setting off Auto (3 → 0); from then on a restart is
only requested on purpose, by toggling the preset 0 ↔ 1 (`restartSession()` in `app.js`),
and a hello restarts nothing. The override itself lives in lylinkui's RAM, so after an adapter
reboot the first session can come up at the preset size; the page compares the size of the
picture that arrives with what it asked for (`verifySession()`), restarts once if they differ,
and if they still differ falls back to the old Auto flow (`localStorage t2c.sessAuto`, cleared
when the user changes the size settings).

Checked on the device (2026-10-15, direct WebSocket probe and the page itself): the override
is honoured with pixel 2, 0 and 3 alike; it survives in RAM across restarts and is applied on a
restart without a new hello; a hello with `link == 1` restarted nothing. The page at 773×601
produced a 768×608 session (`LYLINK_VIDEO_START 768x608`), switching to *Sharp* restarted it at
1184×912 with `CreateCarPlay display physical:228 * 175`, so the UI-size setting reaches the
iPhone too. Before this flow the device log showed sessions at 800×490 (the Auto formula from the
hello) next to a 1552×944 one (an override that did get applied), i.e. the old reload-for-a-hello
approach applied the override only sometimes — the user's "changing the size does nothing".

In picture mode the H.264 from the iPhone is decoded and re‑encoded as JPEG by the
Allwinner V831 hardware at the session size, then pushed over `/video.jpg`. Limits used
by the web UI: ≤ 1376×1072 pixels of area, 16‑aligned, mm ≤ 255.

## Audio

Not on the web path at all. `lylinkui` handles `LYLINK_AUDIO_START/STOP` and
`LYLINK_RECORD_*` by routing PCM to the Goodix Bluetooth chip (A2DP to the car, HFP
SCO from the car's microphone). `/mic_test.pcm` records a sample from that path.

## H.264 in the browser

Tesla pauses `<video>` elements while driving (OS level), so any decoder must paint a
canvas, and the Tesla browser has no WebCodecs. The iPhone's stream is High profile
(`avc1.64001f`, CABAC, no B‑frames). Widely used JS decoders are baseline‑only
(`tinyh264`, Broadway), so FFmpeg's h264 decoder is compiled to WebAssembly instead
(`tools/build-h264dec.sh`: `--disable-everything --enable-decoder=h264`, `-O3 -msimd128`,
single‑threaded, ~1.4 MB). `js/h264worker.js` decodes complete access units
(`AV_CODEC_FLAG_LOW_DELAY`) and uploads the YUV planes to three textures; BT.601/709 and
range come from the SPS VUI. Flow control is on the main thread (`video.js`): one access
unit is in flight and the rest wait in order; every unit is decoded, but when newer ones are
waiting the worker is asked to decode only (`draw: false`), so a burst costs decode time and
no latency. Nothing is dropped on purpose: a skipped P‑frame breaks the reference chain until
the next IDR (measured: 21–28 dB PSNR for hundreds of frames), and the iPhone sends an IDR only
on request (`CMD.KEYFRAME` — verified on the device: each request yields one, even on a static
screen). A first version that kept only the newest waiting unit dropped 11–28 frames in 20 s on
the real stream, because the adapter hands units over in bursts, and left the picture green
until the next IDR. The only drop left is a 3 s backlog (decoder hopeless); a backlog above 15
units for 5 s, or more than 40 % of the offered units undecoded, is the 'slow' verdict. The
WebGL context is allowed to be lost and restored (`webglcontextlost` + `preventDefault`); if
it does not come back in 10 s the app falls back to MJPEG for an hour. Threads are impossible because
the adapter's server cannot send COOP/COEP. libwebsockets 3.2 refuses unknown
extensions, so the module ships as `h264dec.wasm.txt` and is loaded via `wasmBinary`.

## Device log download (`ota/www/cgi-bin/index.cgi?id=logcat`)

The OTA CGI runs `(dmesg && logcat -v threadtime -d) | gzip -c > /tmp/log.gz` and
streams the file through a small obfuscation (`send_file`, 0x11a00): the 32‑bit
little‑endian file size is inserted after byte 819, then every 1024‑byte block is
XORed with the 14‑byte key `liaoyuan.tech\0` (index restarts per block).
`tools/logcat.py` undoes it. The kernel ring buffer is small and the LED driver logs
two lines per second, so the boot messages (partition table, `Memory:`) are gone
after roughly an hour of uptime; fetch the log within ~2 minutes of a power‑cycle.
`id=host` reports the firmware as `sys.appver` (e.g. `26020416.1508.1`).

The adapter is an Allwinner Tina board (`ARM OpenWrt Linux-4.9.118`, uImage load
`0x40008000`, SPI NOR only: the kernel carries the `sunxipart` parser and w25q/mx25
IDs for 16 and 32 MiB parts). The partition table lives in the sunxi MBR on the flash
itself, so it cannot be read from the update image. The OTA CGI's `id=set&wifi=N`
only changes the AP channel and restarts `lyhostapd`; nothing on the HTTP side
reboots the adapter without side effects. Open ports: 80 (OTA), 443 (Tesla UI), 7000
(AirPlay/CarPlay). No telnet, ssh, or adb.

## Real device (2026-10-15)

Flashed `build/T2C-tesla-ui.img` (customer squashfs 6,311,936 B) with `tools/flash.sh --yes`
over the `AutoKit_051E` hotspot. Timeline: upload accepted (`{"code": 0}`) → `id=host`
reports `update: 2` → after ~4.5 min the adapter drops off for ~25 s (recovery writes
boot + customer) → back with `appver 26090414.1508.1` and the new `app/www` served by
`lylinkui`. The phone‑facing OTA page at `http://192.168.3.1/` is byte‑identical.

Flash layout (w25q128, 16 MiB, from a fresh‑boot dmesg; RAM 128 MiB, 119,864 KiB free):

```
0x000000-0x060000 uboot      384 KiB
0x060000-0x0a0000 env        256 KiB
0x0a0000-0x2c0000 boot      2176 KiB   (kernel uImage 2,224,376 B — 3.8 KiB spare)
0x2c0000-0x4e0000 recovery  2176 KiB
0x4e0000-0x7e0000 rootfs    3072 KiB
0x7e0000-0xe20000 customer  6400 KiB   (squashfs 6,311,936 B — 236 KiB spare)
0xe20000-0xe30000 private     64 KiB
0xe30000-end      UDISK    ~1856 KiB   (declared larger than the chip; truncated)
```
`sw-description` has no `type`, so SWUpdate's raw handler writes `/dev/by-name/customer`
(`mtdblock5`); an image larger than 6,553,600 B would be cut off and corrupt the
partition. `tools/flash.sh` refuses to upload unless the sizes above are read from the
device log first.

Browser check against the real adapter (headless Chrome 155, 773×601 @ DPR 1.53, host
rule `tespush.com → 192.168.3.1`): the user's iPhone joined on its own; the H.264 worker
path was selected (`cp-canvas-worker` 768×608), the CarPlay home screen rendered
edge‑to‑edge, decode 2.3 ms per frame, 0 dropped. On a static screen the adapter sends
no frames (`rx 0`), so a throughput figure needs motion on the phone. One finding fixed
afterwards: the `{link,phone}` message can arrive before the init JSON, so the page briefly
started MJPEG (`video.jpg` 404) while the adapter was in H.264 mode (commit `3be0260`).
Note for testing from a Mac: `101.200.208.6` is routed to the internet, not the adapter;
use `--resolve tespush.com:443:192.168.3.1` or the AP address.

## Settings file `/mnt/UDISK/lycfg.txt` (lylinkui `lycfg_read/write`)

Binary, exactly 556 bytes, read and written whole (`fread/fwrite(…, 1, 556)`, a read
shorter than 548 bytes is rejected). Lives at `this+0x458` inside lylinkui's main object:

```
+0   u8  night            +1  u8 pixel (3 = auto)      +2  u8 driver
+3   u8  0x4d  +4 u8 0x3c (unknown)                    +5  u8 channel (161)
+6   u8  temp channel (0xff = none)                    +7  u8 0
+8   char psk[12]        Wi‑Fi password, NUL‑terminated → at most 11 characters
+20  char name[12]       car name shown on iOS ("Auto")
…    zeros
+548 u8 btnet, +549 0, +550 u8 mode (1 = H.264 video), tail zeros
```
The WebSocket type‑9 message does `memcpy(this+0x460, payload, len)` and only writes the
terminator when `len <= 11`; a 12‑byte password therefore runs into `name`. After storing
it lylinkui regenerates `/tmp/hostapd.conf` from `/etc/wifi/hostapd.conf` (replacing the
`ssid=`, `channel=`, `ht_capab=`, `wpa_passphrase=` lines), restarts hostapd and restarts
the CarPlay session. The SSID is `custom_name` from the U‑Boot env plus four hex digits and
is never stored. `t2c.cgi?a=wifi` rewrites the 12‑byte field in the file and reboots so
lylinkui reloads it (its in‑memory copy would otherwise overwrite the file later).

The phone page's helper CGI runs as root under busybox httpd; `reboot` works from there
(the adapter drops off after ~7 s). The Mac tends to roam away from `AutoKit_051E` while
the hotspot is down, hence the rejoin loop in `tools/flash.sh` (`T2C_SSID`/`T2C_PSK`).

## Update hosting (2026-10-15)

Both pages fetch `<base>/1508/version.json` and then `url` with a plain browser `fetch`,
so every hop needs `Access-Control-Allow-Origin`. raw.githubusercontent.com sends `*`
(cached ~5 min per path); GitHub release-asset downloads (`github.com/…/releases/download`
→ `release-assets.githubusercontent.com`) send none and are therefore unusable from the
page. Images for the updater live on the orphan `releases` branch (`1508/<file>.img`,
raw URL), release assets stay for manual download. `tools/release.sh` does the whole
cycle. The Mac's internet on the adapter's Wi‑Fi goes through the iPhone's Bluetooth PAN
(~40–70 KB/s, stalls); GitHub's asset upload endpoint times out on it unless the upload
is rate‑limited (`curl --limit-rate 45k` worked), git push over SSH was fine.

## Internet path (BT_Network hardware)

`lylinkapp` brings up a Bluetooth PAN client to the phone (`udhcpc -R -n -b -i bt-pan`),
enables forwarding and NATs the hotspot behind it (`iptables -t nat -A POSTROUTING -o
bt-pan -j MASQUERADE`). `app/udhcpd.conf` hands the Tesla (and the iPhone) `router
192.168.3.1` and DNS `8.8.8.8 114.114.114.114 192.168.3.1`, so once the car is on the
adapter's Wi‑Fi all of its traffic goes through the phone's Bluetooth PAN. Measured from a
Mac on the hotspot while an 8 MB download was running: 40–70 KB/s, RTT 350–2300 ms, 25 %
loss, DNS 300 ms; the adapter's own DNS (192.168.3.1) did not answer queries. The PAN
stack lives in the closed `gocsdk`/`lylinkapp` binaries (BT controller UART rate etc.);
nothing on the web side changes its speed. Levers that do exist: the `btnet` setting (type 7
key 8: 1 off / 2 on) and `app/udhcpd.conf` (router / DNS / static‑route options given to
the car) — both untested against Tesla's connectivity checks.

## Frame rate during motion (bench, 2026-10-15)

Synthetic 1.2 s swipes on the CarPlay home screen (headless Chrome at 773×601, H.264 path,
session 768×608): the adapter delivers 25–33 frames/s at 6–10 Mbit/s while the content
moves, decode 1.5–6 ms per frame, 0 dropped; painted ≈ received. The `fps` setting (type 7
key 9, "standard"/"smooth") made no measurable difference — the ~30 fps ceiling is the
encoded stream itself, so scrolling cannot look like a native 60 Hz screen. What the page
controls is touch timing: moves were coalesced to one per animation frame until 26101501;
since 26101502 they are forwarded as they arrive (iOS derives scroll velocity from them).

## Built-in DNS (`dnsd` in lylinkui): `carplay.internal`, `setting.internal`

`lylinkui` runs a tiny DNS responder on UDP 53 (`process_request` 0x20a90). Stock rules:
names from a static table at 0x3d0a8 (`tespush.cn`, `tespush.com`, `www.tespush.cn`,
`www.tespush.com`; `dnsd_init` uses 6 entries for branches 1508/1532/1552, two of them
duplicates, and only `tslbox.cn` otherwise) are answered with the Tesla‑UI address (TTL
121, read through GOT+0x260); any name with a label containing `tesla` is answered with the
same address (TTL 0, presumably the car's connectivity check while offline); the rest gets
REFUSED. `dnsd_disable(1)` is called once `data.carlinkit.com` resolves (phone internet
up); from then on every query is dropped.

`tools/patch_lylinkui.py` (applied by `tools/build.sh`, checked by `tools/verify.sh`)
puts `carplay.internal` and `setting.internal` into the two duplicate slots (2 and 5), keeps
answering table names while disabled, and leaves everything else exactly as before
(online: drop, including the `tesla` catch‑all). The wire‑format names live in the zero
padding after the r‑x segment (file 0x1c690, the segment's `p_filesz`/`p_memsz` grow from
0x1c68c to 0x1c6b4, still far below the data segment at 0x1cb40). The per‑query debug log
call is the code cave: one branch handles "no match while disabled → drop", a second one
replaces the answer's address with 192.168.3.1 when the question starts with `\x07s`
(only `setting.internal` in the table does; `r8` still points at the question there). The
script refuses any lylinkui other than SHA‑256 `37ce2c3a…` (26090414).

`setting.internal` → busybox httpd on 192.168.3.1:80 (ignores the Host header), the
settings page. `carplay.internal` → `101.200.208.6:80`, where lylinkui serves the UI and the
WebSocket over plain HTTP for any host name except `tespush.com` (301 to HTTPS). `.internal`
is reserved for private use (ICANN 2024) and is not HSTS‑preloaded; `.play`/`.app` are, and
names ending in a number are not URLs. Chromium treats an unknown suffix typed without a
scheme as a search, so type `http://` or a trailing slash the first time.

Open point: while the phone has internet, a client only gets these names if its resolver
asks the adapter (third DNS server in DHCP, after 8.8.8.8 and 114.114.114.114). A resolver
that sends to all servers at once (musl, connman's proxy) takes the adapter's answer, which
arrives first; one that asks 8.8.8.8 first and accepts its NXDOMAIN (glibc) does not. Offline
it always works. Moving 192.168.3.1 to the front of `app/udhcpd.conf` would fix that but
also routes every lookup of the car through the adapter first; that needs the online "drop"
turned into REFUSED, and leaves the `tesla` catch‑all in charge whenever the adapter's own
online check fails — not done without a test in the car.

## Device name (Bluetooth name, CarPlay car name)

- Bluetooth: `gocsdk -T/dev/ttyS3 -N$BT_NAME` in `app/blink.sh`; `BT_NAME` (like `WIFI_NAME`,
  the hotspot SSID that lylinkui copies to `this+0x3a8` and writes as `ssid=`) comes from the
  rootfs init, `AutoKit_051E` on the bench (`custom_name` + MAC suffix). `blink.sh` waits for
  `/mnt/UDISK` before starting gocsdk; the build inserts a hook there that replaces
  `BT_NAME` with `/mnt/UDISK/t2c_name` (filtered to `A-Za-z0-9 _.-`, 12 bytes) and quotes the
  argument. lylinkapp's own env reads are only `LOCAL_IP_ADDRESS` and `PRODUCT_NAME` (passed
  to the iAP2 init at 0x247e0); neither is touched.
- CarPlay car name: 12 bytes at offset 20 of `lycfg.txt` (`this+0x46c`), icon id at offset 32
  (`this+0x478`); the type‑10 WebSocket message (`callback_tsl` 0x1890c) copies both without a
  terminator and turns `"` into `'`. Default `Auto`.
- `t2c.cgi?a=name` writes both and reboots; `a=unname` deletes `t2c_name` (the phone page
  calls it before a factory reset). The SSID stays as it is, so the car's saved Wi‑Fi keeps
  working. Not yet verified on the device: whether gocsdk applies `-N` on every start and
  whether iOS refreshes a paired device's name without re‑pairing.

## Firmware update progress

Stock `index.cgi?id=host` reports `update`: 1–2 while the adapter checks/prepares an uploaded
image, 3 when done, above 3 a failure code (the stock page's `timer_8min` reads it this
way); during the recovery reboot the CGI does not answer. Bench timings: ~4.5 min
checking, ~30–60 s offline, back with the new `appver`. The settings page shows these as
stages (download and send measured, check and write/reboot from the timings, done from the
new version). The installer on github.io cannot read the adapter at all (HTTPS → HTTP is
mixed content, and `targetAddressSpace` is not available on iOS), so it shows the same
stages on a timer after the form is submitted, keeps them across a reload
(`sessionStorage`), and offers a stop button for a rejected upload.

## One page at a time (connect/disconnect loop, 2026-10-15)

`callback_tsl` stores every new WebSocket as the single current client (`str r11, [r3, #0x4c]`
at 0x17928, at connection time). The status JSON (and with it `pong`) and the ping handling
only serve that client; older connections stay open but get no pongs. Each hello also
restarts the CarPlay session while the size setting is Auto (`lylinkapi_start`, which kills
and respawns `lylinkapp`).

With two pages open (device log: a 1947×1185 `en-US` page and a 756×469 `ko-KR` page) the
older one missed its pongs, closed after ~4 s, reconnected 1 s later, sent a hello and took
the adapter back; then the other one did the same. Result: a CarPlay session restart every
~5 s (27 in 13 min), the page flipping between "connected" and "waiting for iPhone", and no
internet on the hotspot, because each `lylinkapp` exit also drops the iPhone's Bluetooth PAN
(`btpan not connect bt device` ~10 s later, reconnect + `udhcpc` ~20–30 s later). In the
4‑minute stretch without restarts the PAN stayed up.

Since 26101504 the page probes `/js/boot.js` when pongs stop. If HTTP answers and the pongs
are still missing 2 s later, another page owns the connection: the page stays disconnected
and offers "Use this screen" instead of reconnecting. If HTTP is dead too, it drops the
socket (no closing-handshake wait) and reconnects as before. `tools/devserver.py` now mimics
the single current client and the Auto-mode restart on hello, so the loop reproduces locally
with two headless Chromes (old UI: 8 restarts in 30 s; new: 1).

## Long sessions (audit 2026-10-15)

Soak on the bench (headless Chrome 155, 773×601 @ DPR 1.53, devserver H.264 mock 768×608 at
30 fps, 12 min): JS heap flat at 1.0–1.8 MB, DOM nodes ~920 and 81 listeners constant,
renderer RSS 181 → 182 MB, decode ~2.2 ms, 0 dropped. The steady state does not leak; what
could go wrong over a long drive were event paths, fixed after 26101504:

- The "decoder too slow" verdict (`video.js`, >40 % of frames undecoded for 5 s → MJPEG,
  remembered for a week) counted frames skipped while waiting for a key frame. With a mock
  that ignored key‑frame requests the page fell back within 5 s of connecting. Frames skipped
  for a missing IDR are now reported separately (`wait`) and do not count; the memory of a
  verdict is an expiry time, a week for *slow*, an hour for crashes and lost GPU contexts.
- No newest‑wins drop ever happened in the worker (see "H.264 in the browser"): a slow decoder
  accumulated latency without limit. Replaced by decode‑everything / draw‑the‑newest with a
  backlog limit; `devserver.py --burst 12` sends 12 access units at once every 5 s to exercise
  it (0 dropped), `--no-keyframes` makes the mock ignore key‑frame requests (the page must wait,
  not fall back). Key‑frame requests are rate‑limited to one a second but never dropped.
- WebGL context loss in the worker was unhandled: the picture would freeze while the stats
  kept reporting decoded frames, with no way out short of a reload.
- Reloads are guarded: more than four within a minute (a setting the adapter does not take,
  storage that does not persist) stop with a message instead of looping. User‑triggered reloads
  bypass the guard. Resizes re‑apply the session size instead of reloading.
- Pong tolerance before probing the link went from 3 s to 5 s (short status stalls on the
  adapter are not a takeover).
- The waiting screen's animation pauses after two minutes without a phone.
- Still open: `superseded` can in principle be a false positive if lylinkui's status thread
  stalls while HTTP keeps answering (recovery is the "Use this screen" button); whether the
  Tesla keyboard changes `innerHeight` (which would re‑apply the session size while typing a
  name) has not been checked in the car.

## Car's own app in CarPlay, resolver list (2026-10-15)

- The icon of the car's app in the CarPlay grid is `/tmp/lylink/home.png`, which lylinkui copies
  from `app/www/icon/<id>.png` when an icon id is set and from `/mnt/customer/app/Auto.png`
  otherwise (`CPClientSetOemIconsPath`, `picSize :180`). The name is the 12‑byte car name
  (`Auto` by default, a string inside lylinkui with no slack to patch). The build replaces
  `Auto.png` with `src/www/icon/ck00.png` (gear + car, 180×180) and the page sends the identity
  `Carlinkit` once when the adapter still reports `Auto`; lylinkui stores it (the next init JSON
  reports it) and the iPhone showed "Carlinkit" under the icon.
- `app/www/icon.json` is the list the init JSON's `icons` comes from; it was missing from the
  rebuilt page, so the icon picker was empty on the device.
- `app/udhcpd.conf` hands the car `8.8.8.8 1.1.1.1 192.168.3.1` instead of
  `8.8.8.8 114.114.114.114 192.168.3.1`. Measured through the adapter from Korea: 8.8.8.8
  120–270 ms, 114.114.114.114 220–320 ms, 1.1.1.1 80–90 ms, the adapter itself times out
  (while the phone has internet it drops every query that is not in its table). Turning that
  drop into REFUSED would let a resolver fail over at once, but the stock REFUSED path sits
  behind the `tesla` catch‑all, so it needs its own cave — not done.
- The phone page shows memory *used* (`MemTotal − MemAvailable`) and a CPU busy share
  (`t2c.cgi?a=info` samples `/proc/stat` twice, 0.3 s apart, `cpu_pct`; `cgi` is 4). The
  adapter runs at load 2–2.8 on its single core while a session is up.
