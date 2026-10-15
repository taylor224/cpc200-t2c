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
phone connect; the web UI relies on this to apply the override.

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
single‑threaded, ~1.4 MB). `js/h264worker.js` feeds complete access units
(`AV_CODEC_FLAG_LOW_DELAY`, newest‑wins queue) and uploads the YUV planes to three
textures; BT.601/709 and range come from the SPS VUI. Threads are impossible because
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
