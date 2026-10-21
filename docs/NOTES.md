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

**Video write path** (`func_14150` → `callback_tsl` 0x16c6c): the IPC thread copies each access
unit into a malloc'd message and hands it over through a one‑entry queue (`g+0x260/0x264`),
waking the service thread with `lws_cancel_service_pt`; while the queue holds a message the
producer waits on a condvar, so at most one unit is in flight and one waiting. Stock
`LWS_CALLBACK_SERVER_WRITEABLE` sends the unit in 8168‑byte pieces (type 101/102/103, 100 only
when the whole unit fits), one `lws_write` + `lws_callback_on_writable` + poll() round each,
and `lws_issue_raw` caps a single send() at `pt_serv_buf_size` (4096: lylinkui sets neither
that nor the protocol's `tx_packet_size`), so even one piece takes two writes. A 25–40 KB
unit (6–10 Mbit/s at 30 fps) therefore cost ~10 send() calls, ~10 poll rounds and ~10 TLS
records on the single core, with the next unit blocked behind them. `tools/patch_lylinkui.py`
(patch 7, since 26101510) raises the piece to 65280 bytes, uses type 100 up to 65508 bytes
and sets `tsl.tx_packet_size = 65536`, so a unit normally goes out in one write; the
WebSocket header stays in its 4‑byte form and lws' buflist handles a partial TLS write
(server SSL has `SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER`, retry uses the same length). Not
yet verified on the adapter.

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
the requested pixel size. It does **not** derive a UI scale from the physical size: at
768×608 the physical size was varied from 60×48 to 255×202 mm (lylinkapp logged each as
`display physical`) and the decoded frames were pixel‑identical; and at 768, 1024, 1088 and
1184 px wide the CarPlay icons are always ~120 px (the @2x layout, more columns at larger
sizes). So on this adapter the UI only looks bigger or smaller through the picture being
enlarged more or less on the Tesla screen, and the page's *CarPlay UI size* scales the
session pixel count (×1.25 / ×1 / ×0.8 on top of the picture‑size preset; the mm sent are
just w/5.2, h/5.2). The session is
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

Restarts are expensive: lylinkui kills and respawns lylinkapp, the iPhone reconnects, the
Bluetooth PAN drops. About a dozen of them within six minutes (two size‑mapping runs) left the
hotspot unreachable for ~70 s (no ping, nothing on 80/443, single core at load > 2); it came
back by itself without a reboot. The page therefore spaces restarts at least 10 s apart and
carries out a request made inside that window when it ends, with the override sent last.

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

Not on the web path at all, and not on the CarPlay (Wi‑Fi) path either: the Tesla build of
`libcarplay.so` disables the session's audio output (`CPClientDisableAudioOutput … may be for
Tesla`, `not copy the audio format, for Tesla` in the device log; lylinkui's own audio
output stays `not init`), because the car accepts audio only over Bluetooth. Music and calls
go over the **Tesla's own Bluetooth pairing with the iPhone**, not through the adapter: the
adapter's stack (`gocsdk`/`libGbtsTask`, CSR‑Synergy based, firmware `GBTSD4.95G4.72`) has the
HF role towards phones (hundreds of `CsrBtHf*` handlers), A2DP and the PAN, but no hands‑free
gateway role at all (not one `CsrBtHfg*` profile handler, only two misnamed helpers), so the car
cannot connect to it as to a phone. The HFP link the adapter opens to the iPhone is part of the
wireless‑CarPlay handshake and is dropped afterwards (`CARPLAY_ON_DISCONNECT_HFP`), which is what
leaves the iPhone's call/Siri audio with the Tesla's link. (Earlier notes here assumed an
A2DP‑source/HFP‑AG bridge towards the car — corrected 2026‑10‑17.) The A2DP code is SBC only
(bitpool negotiated, `filter_sbc: … remoteMaxBitpool`; no AAC/aptX strings). Nothing in `app/`
changes codec or bitpool;
`/mnt/UDISK/bt_conf.ini` (131 bytes, `t2c.cgi?a=cat&f=bt_conf`) and `/etc/GocPcmConf.ini` are
the only configuration files it reads. `LYLINK_AUDIO_START/STOP` and `LYLINK_RECORD_*`
handlers exist in lylinkui for other products; `/mic_test.pcm` records from that path.
Keep the AP on 5 GHz: channel 6 (allowed by `t2c.cgi?a=channel`) would share the band with
the Bluetooth audio.

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

## Wi‑Fi link (RTL8821CS)

The adapter's radio is a Realtek RTL8821CS (SDIO, 1T1R 802.11a/b/g/n/ac, 20/40/80 MHz, VHT
MCS0–9 → 433 Mbit/s PHY at most). `modules/8821cs.ko` is loaded with `rtw_vht_enable=2` and
its compiled‑in defaults (read from `__param` relocations) already allow 80 MHz on 5 GHz
(`rtw_bw_mode`/`rtw_tx_bw_mode` 0x21, `rtw_vht_rx_mcs_map` 0xaaaa, `rtw_channel_plan` 0xff =
efuse). What limits the link is `/tmp/hostapd.conf`, which `save_hostapd_conf` (0x14ef0)
rewrites from the read‑only `/etc/wifi/hostapd.conf` (WIFIPATH is only a fallback when that
file is missing): `hw_mode=a`, `ieee80211n=1`, `ht_capab=[SHORT-GI-20][SHORT-GI-40][HT40+]`,
no `ieee80211ac`/`vht_oper_chwidth`, so the AP is 802.11n only. Worse, the `ht_capab` line is
copied unchanged except for channels 8–14, 48 and ≥162 (where lylinkui drops it), and
`HT40+` is not a valid pairing for the default channel 161 (its 40 MHz partner is 157, i.e.
`HT40-`), so the stock AP most likely runs at 20 MHz there (72 Mbit/s PHY; unverified — check
the channel width from a client, e.g. `wdutil info` on a Mac). Channels 36/44/149/157 are
valid `HT40+` primaries.

Since 26101510 `app/hostapd` (`src/app/hostapd`) wraps the daemon: lylinkui starts it with
`system("hostapd -B /tmp/hostapd.conf")` and `lyLink.sh` puts `/tmp/bin:$WORKDIR` first in
PATH, so the script runs instead and starts the first other `hostapd` on PATH. For channels
36–48 and 149–161 it writes `/tmp/hostapd-t2c.conf` with the right HT40 side plus
`ieee80211ac=1`, `vht_oper_chwidth=1`, `vht_oper_centr_freq_seg0_idx` 42/155 and
`vht_capab=[SHORT-GI-80]`; attempts go 80 MHz → 40 MHz → stock file. An attempt is dropped
when hostapd refuses the file or dies within 12 s (the HT40 scan verdict comes after `-B`
returned), and a background monitor restores the stock file when no client has shown up
within 5 minutes (a DHCP lease newer than the start, or a new wlan0 ARP neighbour), counting
a failure in `/mnt/UDISK/t2c_vht_fail`; two failures in a row keep the stock file until a
client is seen again. `/mnt/UDISK/t2c_vht_off` disables it; log in `/tmp/t2c_hostapd.log`.
The phone page's diagnostics expose the pieces: `t2c.cgi?a=cat&f=t2c_hostapd` (wrapper log with
hostapd's own messages), `hostapd_t2c` (the file the running daemon got), `vht_fail`,
`hostapd_caps` (`hostapd -v` and whether the rootfs binary contains the 11ac config keywords),
`wlan_ls` and `wlan_<name>` for `/proc/net/rtl8821cs/wlan0/<name>` (`all_sta_info`, `ap_info`,
`trx_info`, `rx_signal`, `tx_stat`: per-station rate, bandwidth, RSSI, retries), `hostapd_log`,
`wlan_params`.
The monitor stops a daemon by the PID taken from `ps`, never with `killall`/`pidof`: busybox
matches the comm name, and the comm of a `#!/bin/sh` script is the script's basename, so the
monitor itself is a process called `hostapd`. 26101511 had `killall hostapd` in the no‑client
path and killed itself before starting the stock daemon; on the bench that left the adapter
without Wi‑Fi until lylinkui relaunched hostapd hours later. Fixed in 26101512.

**lylinkui restarts hostapd on its own.** Its `ly_misc_thread` counts down 120 s after the
CarPlay video stops with no car display attached (`count down 112 … 16`), then runs
`system("killall hostapd")` (logged as `sleeping`), sleeps 60 s and launches hostapd again
(`wake up`); the phone connecting over Bluetooth while the AP is down (`carplay BT OK, checking
AP` → `ap still nok`) does the same. On the bench without the Tesla page the AP therefore cycles
~3 min on / 1 min off (the Mac roams away each time), and every relaunch re-enters the wrapper.
26101512's "client seen" test (a DHCP lease newer than the start, or a new ARP neighbour) could
not see stations that were already there, so each relaunch ended in "no client in 5 min" and a
failure count. Since 26101513 the test reads the driver's station table
(`/proc/net/rtl8821cs/wlan0/all_sta_info`, an entry with `aid=1..8`; complete ARP neighbours as
fallback) at check time. The rootfs hostapd has no `-f`; with `/mnt/UDISK/t2c_hostapd_debug`
present the wrapper runs it in the foreground with `-t -dd` and its output lands in
`/tmp/hostapd-t2c.log` (truncated per launch; `-dd` is chatty, so opt‑in only).
`/mnt/UDISK/t2c_country` (two letters) is written to the driver's `country_code` before each
launch. `t2c.cgi?a=flag&f={hostapd_debug,country,vht_off}&v=VALUE` creates these files (empty
value deletes), `a=cat&f=flags` lists them.

**What the 80 MHz attempt really gives (measured 2026‑10‑16).** The rootfs hostapd is
`v2.7-devel_rtw` (Realtek fork, 2020) and does everything right: with `ieee80211ac=1` it logs
`hw vht capab: 0x3c00122`, `Set freq 5805 (ht_enabled=1, vht_enabled=1, bandwidth=80 MHz,
cf1=5775)` and its beacon tail carries VHT Capabilities (191) and VHT Operation (192, width 1,
seg0 155). The rtl8821cs driver (v5.9.2_36984.20200615, module stripped) then brings the BSS up
as `wireless_mode=0x14(A/N)`, `cur_bwmode=1(40MHz)`, `vht_en=0` (`ap_info`) and the on‑air beacon
has no VHT element (a Mac associates as 802.11n/40 MHz). The chip reports `bw_cap: 20M 40M 80M`,
`proto_cap: b g n ac`; module parameters as loaded: `rtw_wireless_mode` 0x5F (includes AC),
`rtw_vht_enable` 1, `rtw_bw_mode` 0x21, `rtw_channel_plan` 255 (auto → `chplan:0x7F`,
`PLS regd:(null)`, `country_code unspecified`). Tried and rejected, each with a hostapd restart:
`country_code=KR` + `ieee80211d=1` in the file (hostapd goes through COUNTRY_UPDATE, the kernel
stays at country 00, plan unchanged), writing `KR` to `/proc/net/rtl8821cs/wlan0/country_code`
(reads back `unspecified`), `vht_capab=` empty, `vht_oper_chwidth=0` (hostapd refuses it with
seg0 set). `insmod … rtw_country_code=KR` via lyLoadModule.sh never reached the driver
(`/sys/module/8821cs/parameters/rtw_country_code` stayed 0xffff; either `/mnt/UDISK` is not
mounted when lyLoadModule.sh runs or the copy under `$WORKDIR=/mnt/UDISK/app` is the one that
runs) — inconclusive, not pursued further. The most likely gate is the driver's
`rtw_check_beacon_data` dropping the VHT elements when the regulatory entry is missing
(`RFCTL_REG_EN_11AC`), which no runtime knob reaches. Conclusion: **HT40 is the ceiling on this
adapter** (1x1, short GI → 150 Mbit/s PHY, up from 72 at 20 MHz). Since 26101516 the wrapper's
default order is 40 MHz → stock; `/mnt/UDISK/t2c_vht80` puts the 80 MHz file first again for
future experiments, and both channel pickers label 36–48/149–161 "40 MHz · recommended".
Experiment hooks kept: `t2c.cgi?a=cat&f=hostapd_log` (with `t2c_hostapd_debug`), `wlan_params`,
`a=wlanw&f=K&v=V` (`log_level`, `wlan0/country_code`, `wlan0/change_bss_chbw`),
`a=flag&f=N&v=V` (`hostapd_debug`, `country`, `vht_off`, `vht80`, `hostapd_extra` = extra
`key=value` lines for the 80/40 files), `a=hostapd_restart`.

**lylinkui leaks the video stream when no page is attached — fixed (patch 8, 26101520).** The
producer that hands each H.264 access unit from the IPC thread to the WebSocket thread
(`func_14150`: `malloc(len+152)`, `memcpy`, lock) checks `g+0x268` (a page is attached) and
`g+0x50` (video wanted). With a page and video on it parks the unit in the single slot `g+0x264`
(and blocks on the condvar while the slot is busy, so a slow page only stalls the IPC side); with
a page but video off it frees the unit; **with no page it unlocked and returned without freeing**
(`beq 0x141e8`). The phone keeps streaming for a while after the page goes (and after our
`LYLINK_PHONE_DISCONN`), so lylinkui grew at the video bit rate (0.4–0.5 MB/s) until the kernel's
OOM killer took it (`Out of memory: Kill process (tesla) … anon-rss:95108kB`), the supervisor
restarted it, the car page showed "waiting for iPhone" and the phone reconnected — on the bench
every 4–5 minutes, in the car whenever the Tesla page drops while CarPlay is up. Patch 8 turns the
branch into `beq 0x141bc` (the free path; the loop then returns at once because no page is
attached). Diagnosed with `t2c.cgi?a=top` (RSS 88.8 → 92.9 MB in 8 s) and dmesg.

**The leak, finally located (patches 8/9 were aimed at the wrong function).** `func_14150` is an
alternative hand-off that the dispatcher only installs as a pointer (`g+0x268`); the live path for
video data (callback case 14 in `func_14250`) is `0x1327c` (plain access unit) / `0x131dc` (unit
with the cached SPS/PPS prepended): `malloc(len+36)`, `memcpy`, then `bl 0x1317c`, the enqueue.
`0x1317c` reads `g+0x4c` (the page's connection) and **returns without freeing the node when it is
0**; otherwise it appends the node to a linked list (head `g+0x260`, tail `g+0x264`) that the
WebSocket thread drains one node per `LWS_CALLBACK_SERVER_WRITEABLE` (free at `0x18fc8`). The
list has no bound, so a page that is slower than the stream makes memory and latency grow
together — that is the "lag" mechanism, see below. Patch 10 (26101523) appends a 32‑byte
wrapper after the DNS names in the r-x segment padding and points both `bl 0x1317c` at it: it
checks `g+0x4c` first and tail-calls `free(node)` instead when no page is attached. **Verified on
the adapter (26101525):** with the phone streaming ~1 Mbit/s and no page, lylinkui stayed at
9156 kB VSZ / 95.4 MB available for two minutes (before: +0.3–0.5 MB/s, OOM kill every 4–5 min).

**Bounded queue (patch 11, 26101528).** The same wrapper now also bounds the list: before
enqueuing it walks the list from `g+0x260`; with 10 units already waiting (~330 ms at 30 fps) it
frees the new unit and enters *drop mode*: every following unit is freed until the next IDR
(the caller `0x131dc` is the IDR path, `0x1327c` the P path — two entry points tell them apart),
and a new zeroed word (`FLAG` at `DATA_VA + 0x89c`, the rw PT_LOAD's memsz grew by 4) is set to
1. The lws thread's writeable callback (its final `bl lws_callback_on_writable` at `0x18cbc` goes
through a hook) turns 1 into 2 and asks the phone for a key frame the way the page's cmd 8 does
(`lylinkapi_key(0x600, 0)` + `(0x600, 1)`), outside the producer's lock; the producer re-arms the
request every 64 dropped units. Two lessons from the bench: hooking the *end of the WRITEABLE
callback* (`0x18cbc`, 26101528) silently broke the page handshake (no link JSON, no video), while
wrapping the main loop's `lws_service()` call (`0x1a868`, 26101530) works — the request is now
issued there; and on the adapter's own menu stream (no phone session) the key request makes
lylinkapp stop the video, so the bound only applies while `g+0x30c` (phone attached, the
`phone` field of the link JSON) is set (26101531). **Real session check (26101531, Chrome page on the
Mac, iPhone CarPlay at 1616×912, phone uplink peaks ~9 Mbit/s):** lylinkui 9.4 → 10.0 MB VSZ in the
first 30 s, then flat for 3 minutes; 95 MB available throughout; one key-frame request in total (the
page's own at session start — the bound never had to drop, the page kept up); no OOM; CPU ~75 %
idle (lylinkui 1.8 %, Realtek threads ~4 %). Effect: a page that falls behind gets at most ~330 ms of backlog,
then a short freeze until the IDR, instead of ever-growing latency (and memory).

**Patch 8 alone did not stop the growth** (26101520: still +0.3 MB/s with the phone streaming and no
page), which re-reads as follows: `g+0x268` is "stream active" (set/cleared by the LYLINK_VIDEO
callbacks in `func_14250`), `g+0x50` is "a page asked for video" (cmd VIDEO). Stream active + no
page → the unit is freed and the IPC thread then **blocks on the condvar** until a page asks or
the stream stops; the IPC layer keeps queueing the phone's units inside the process meanwhile.
Patch 9 (26101521) turns that `bne` into a NOP so the thread frees the unit and returns at once
(frames are simply dropped while nobody watches; the page requests a key frame when it attaches).
While lylinkui was being OOM-killed every few minutes, the adapter's DNS (`dnsd` runs inside
lylinkui) and the PAN forwarding set-up (`btpan_ipForward`, also lylinkui) died with it, which is
why a Mac on the hotspot saw "no internet" although the Bluetooth PAN to the phone was up.
`t2c.cgi?a=cat&f=maps` summarises lylinkui's writable mappings (heap vs anonymous) for this.

**Where the time goes (profiled 2026‑10‑16 with `t2c.cgi?a=top`, phone video relayed to a fast
client at ~32 fps, ~1.8 Mbit/s):** the core is ~85 % idle. lylinkui 6.2–6.4 % (its lws/TLS thread
5.5 %), lylinkapp 2 % (the `AirPlayScreenRe` thread, real-time priority −61), Realtek driver
`RTW_RECV_THREAD` 2.6 % + `ksdioirqd/mmc0` 1.6 % + `RTWHALXT` 1 % + `RTW_XMIT_THREAD` 0.7 %, gocsdk
0.4 % (3–6 % only while Bluetooth is busy), everything else ~0. SDIO interrupts ~1 200/s. Memory
95 MB available without the leak. So CPU is not the latency source; the write path is: with the
stock 8 KB fragmentation the frame gaps at the client were p50 5–24 ms but **p95 125–152 ms, max
160–222 ms** (frames arrive in clumps, i.e. stutter), whereas with the one-message-per-unit patch
they were p50 25 ms / p95 52 ms / max 55 ms. That patch is therefore back on by default from
26101526 (its suspected leak was the no-page leak above, which starts at boot because the phone
begins streaming before any page attaches).

**26101526 verified on the bench:** phone sending ~1 Mbit/s with no page → lylinkui 9088 kB VSZ /
95.3 MB available flat for 90 s; a fast test client attached → still flat, one message per unit,
gaps p50 25 ms / p95 52–66 ms. But the adapter's own menu stream (what a page sees while no CarPlay
session is up: constant ~5.5 KB units at 32 fps from the adapter's H.264 encoder) showed sporadic
stalls of 0.26–2.3 s (7–35 per minute, varying run to run) with the core 90 % idle — not CPU; the
encoder/renderer or the Wi‑Fi link to the client are the candidates. Whether the relayed CarPlay
stream stalls the same way in the car is unmeasured: the page's stats overlay has no gap/jitter
metric yet (worth adding: max gap and count of gaps > 150 ms per second), and on the bench the
phone did not re-enter a session on request (`/tsl/bt` lists it, type‑4 connect sent, `phone`
stayed false).

**Write‑path patch withdrawn (2026‑10‑16 evening, re-enabled the same night — see above).** With the patch (26101510–26101518) and a real
CarPlay session (1552×944, ~2.5 Mbit/s) lylinkui's RSS grew at about the video bit rate
(88.8 → 92.9 MB in 8 s at 280 s uptime; `t2c.cgi?a=top` shows RSS) until
`Out of memory: Kill process (tesla) … anon-rss:95108kB` at 296 s; the supervisor restarted it
(`parse_exit … signal number = 9`), the car page showed "waiting for iPhone" and the session came
back, every few minutes. No OOM ever appeared in the 26101509 logs, so the leak is in the
patched path (most likely the type‑100 single‑message branch keeping each access unit, which
stock only used for units ≤ 8164 bytes; `callback_tsl|1735 … data->length:56594 while len:4096`
lines at session start show the large-message write being retried). `tools/patch_lylinkui.py`
keeps the patch behind `T2C_WS_PATCH=1` for further work; the shipped image uses the stock
fragmentation again (patched sha fd72e66a… with patch 8). Whether patch 7 leaked on its own or
only through the no-page path above is not settled (the OOM with the Mac page attached happened
with patch 7 and a page that was consuming at the stream rate).

**Write‑path patch verified on the adapter (2026‑10‑16, 26101513):** a TLS WebSocket test client
(hand‑rolled framing; Node's built‑in WebSocket rejects lws 3.2's handshake) saw exactly one
message per access unit (msgs/AU 1.00, largest message 64469 bytes, no drops) at ~33 fps of the
adapter's menu, 7–10 KB per AU, frame gaps p50 25 ms / p95 52 ms.
Channels 6 and 165 and anything else go through untouched. Whether the rootfs hostapd is
built with 11ac support, and whether the Realtek AP really runs 80 MHz, is still to be
verified on the adapter (the fallback exists for exactly that). The logic was exercised
offline with fake daemons (refusal, death after start, no client, failure count, pass‑through).
Both pages mark 36–48/149–161 as "80 MHz · recommended" and 165 as 20 MHz. The driver
exposes per‑station diagnostics under
`/proc/net/rtl8821cs/wlan0/` (`all_sta_info`, `trx_info`, `rx_signal`, `tx_stat`,
`rx_stat`, `survey_info`, `rate_ctl`, `bw_ctl`): RSSI, current tx rate/bandwidth and retry
ratio — the data that tells whether the radio or the adapter pipeline is the bottleneck.
The adapter's load of 2–2.8 with a modest CPU busy share means tasks are waiting in
uninterruptible sleep (the SDIO driver threads), not computing.

## USB device mode: CDC-ACM console and firmware upload over USB (26101722)

Found 2026-10-20 while trying to give the adapter a USB console: the vendor kernel has the sunxi
UDC (`/sys/class/udc/5100000.udc-controller`), libcomposite and the configfs gadget
(`/sys/kernel/config/usb_gadget/g1`, idVendor 0x1f3a / idProduct 0x1001, config `c.1`, no
functions) built in, and **exactly one function driver: `usb_f_acm`** (CDC-ACM serial; `mkdir
functions/acm.usb0` works, every other function name fails -- ecm, rndis, ncm, eem, serial, ffs,
mass_storage, hid, uac, uvc, mtp...). The OTG role switch `/sys/devices/platform/soc/usbc0/otg_role`
boots as `usb_host` and accepts `usb_device`. So no kernel module is needed for a console:
function + link into `c.1` + role + `echo 5100000.udc-controller > UDC` gives `/dev/ttyGS0`
(verified step by step with `tools/usb-ko/usbtest.sh`; the UDC reports `not attached` until a host
is on the cable). `rust/t2cd/src/usb.rs` does exactly that behind `/mnt/UDISK/t2c_usb`
(phone page `t2c.cgi?a=flag&f=usb&v=1`): gadget strings Carlinkit / T2C / <wlan0 mac>, acm
function, role, bind, then a root `/bin/sh -i` on `/dev/ttyGS0` (respawned when it exits);
removing the flag unbinds and returns the port to host mode. The port is also the adapter's
power input, so "plug into a laptop" means a reboot powered by the laptop -- the flag lives in
UDISK and survives that. macOS needs no driver: `/dev/cu.usbmodem<serial>`; `tools/usbserial.py`
(`ports`, `cmd '...'`, `shell`, `flash IMAGE`) finds the port by the T2C descriptor, runs
commands, or pushes an image: the shell is put in raw mode, `head -c SIZE > /tmp/update.tmp`
takes the bytes, md5 is compared, the file is renamed to `/tmp/update.img` (what the vendor
`index.cgi?id=upload` does; the updater watches that name) and `ly_update_status` is polled.
In a car the flag must stay off: the Tesla's USB port is a host and would see a CDC-ACM device.
26101723 adds the switches: phone page System card "USB console" (flag `usb`), CarPlay page
Settings › System "USB console" (page cmd 11/12 -> t2cui writes/removes the flag; `usb` in the
init JSON), and the watchdog's rescue: `/tmp/t2c_usb_rescue` (hostapd relaunched twice in a row,
hostapd given up, or the radio-hang detector) makes t2cd bring the console up until the next
reboot without touching the persistent flag. Still unverified from a laptop at the time of
writing: the UDC stayed "not attached" with the adapter on a USB-C hub (TI 0x451) -- cable
orientation / a USB-A-to-C cable are the next things to try; the DT says `usb_port_type = 1`
(host) with no VBUS/ID pins, so detection is purely the role switch plus the host's bus reset.
Register proof that the software side is complete (`tools/usb-ko/t2c_usbreg.c`, a module that
dumps the MUSB registers at 0x05100000 through `/proc/t2c_usbreg`; `/dev/mem` does not exist on
this kernel): with the flag on, POWER has soft_connect=1 (D+ pull-up) and hs_en=1, DEVCTL shows
b_device=1 session=1 vbus=3 (forced valid), ISCR ext_dp=1 force_vbus=3 force_id=3 and
vbus_valid_from_vbus=0 (the PHY's VBUS pin is not wired), and the UDC interrupt count never
moves -- no bus reset ever arrives. What remains is the cable/hub path or the connector itself.
PHY registers too (`t2c_usbreg2`): 0x410 PHYCTRL=0x20 (SIDDQ=0 powered, VBUSVLDEXT=1), 0x420
PHY-select=1 (PHY routed to the OTG controller, not ehci0/ohci0). Mac side: the USB-C port the
adapter sits on reports power state 2 (VBUS on, CC attached) and never a device; a known-good
data cable, both plug orientations, direct port, and (as far as tested) FEL (reset held while
plugging) showed nothing. Conclusion for this unit: D+/D- do not reach the connector -- USB
device mode is complete in software but unusable here. Left in: it is off by default.
Also learned: `usb_device`/`usb_host` under `/sys/devices/platform/soc/usbc0/` are *read*
triggers (their show handlers switch the hardware role; writing `otg_role` calls the same
functions), and reading them stops the manager's scan thread for good.

Kernel modules do load, with the right config. For anything beyond ACM (USB Ethernet =
`u_ether`+`usb_f_ecm`/`rndis`, FunctionFS for adb) the function drivers have to be cross-built
for this exact kernel; the recipe that got a module running (`hello.ko` printed from the kernel):
HandsomeMod/linux-allwinner-4.9 (4.9.118, `arch/arm/boot/dts/sun8iw19p1.dtsi`), Ubuntu 18.04
arm64 container with `gcc-arm-linux-gnueabihf` 7.5, `sun8iw19p1smp_defconfig` plus the fragment in
`tools/usb-ko/frag.cfg`: THUMB2_KERNEL=y (vermagic `4.9.118 preempt ARMv7 thumb2 p2v8`, `touch
.scmversion` so no `+`), KALLSYMS=n (no /proc/kallsyms), MODULE_UNLOAD=n (no refcnt attr),
MODULE_SRCVERSION_ALL=y, DEBUG_PREEMPT=n (the kernel exports no `preempt_count_add`), BUG=n (no
`warn_slowpath_*`), **DEBUG_MUTEXES=y** -- that one cost two power cycles: without it
`offsetof(struct module, init)` is 208 instead of the kernel's 216 (read from the vendor
`8821cs.ko`: its `.rel.gnu.linkonce.this_module` puts `init_module` at 0xd8), the kernel jumps
through garbage and hangs silently (sizeof stays 320 either way, 64-byte aligned). Also PM=n
(no /sys/power), CGROUPS/QUOTA/KEYS/SYSRQ/PERF/SECCOMP/STACKTRACE=n, NET_SCHED/XFRM/IP_MROUTE=y.
With that, `usb_f_acm/serial/fs`, `u_ether`, `usb_f_ecm/rndis/mass_storage` build and resolve
every import against the kernel's exports (`/tmp/t2c-kbuild/*.ko` on the build Mac, not shipped; recipe in `tools/usb-ko/`). Open before trusting
`u_ether`: the vendor driver's code shows `netdev_priv()` at 1088 (ours 1056) and `skb->data` at
180 (ours 164) -- `struct device`/`sk_buff` options still differ (candidates: NF_CONNTRACK +
BRIDGE_NETFILTER (+8 in skb), IOMMU/MSI fields in `struct device`). `panic_on_oops=1` before an
insmod test turns a hang into a 20 s reboot.

## USB device mode (adb) for bench work (2026-10-16, superseded above)

The adapter's USB port is dual-role: `/sys/devices/platform/soc/usbc0/otg_role` is `usb_host` at
boot (lyLink.sh runs `/bin/setusbconfig none`), there is a device controller
(`/sys/class/udc/5100000.udc-controller`), the legacy `/sys/class/android_usb/android0` gadget and
`/bin/adbd` (102 KB). `setusbconfig adb` fails on this kernel (its configfs route wants `ffs.adb` /
`mtp` / `mass_storage` function drivers that are not there, and `functionfs` cannot be mounted).
`app/t2c_usb.sh adb` (`t2c.cgi?a=usbmode&v=adb`, or at boot with `/mnt/UDISK/t2c_adb` =
`a=flag&f=adb&v=1`) tries the legacy gadget instead: role → `usb_device`, `android0` idVendor 18d1 /
idProduct 4ee7, `functions=adb`, `enable=1`, then starts adbd. `a=cat&f=usb` shows the state and
`/tmp/t2c_usb.log`. If it works, `adb forward tcp:8080 tcp:80` reaches the OTA page and t2c.cgi
without the Wi‑Fi hop (then `T2C_HOST=127.0.0.1:8080 tools/flash.sh …`). **Result (26101525):
dead end.** `otg_role` does switch to `usb_device`, but `android0` only has `state`/`subsystem`/
`uevent` (no `enable`/`functions`/`idVendor` — a stub), `/proc/filesystems` lists `configfs` but no
`functionfs`, and there are no `usb_f_*` function drivers, so adbd has nothing to bind to. The
role is restored with `t2c_usb.sh none`; leave `/mnt/UDISK/t2c_adb` unset. Confirmed with 26101527:
`/lib/modules/4.9.118` holds only `8821cs.ko`, `atm.ko`, `br2684.ko`, `crc-ccitt.ko`, `ecb.ko`;
`/sys/kernel/config/usb_gadget/g1` exists (libcomposite built in) but its `functions/` directory
is empty — no gadget function driver of any kind. `setusbconfig` is Tina's stock script
(ffs.adb / mtp / mass_storage via configfs) and cannot work on this kernel. What would work: a
UART console (`console=ttyS0,115200` on the kernel command line; pads inside the case), or
cross-building `usb_f_ecm.ko` (USB Ethernet, native on macOS) / `usb_f_fs.ko` (adb) for
4.9.118 sun8iw19p1 and loading them at run time only.

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
+0   u8  night (0..2 day variants, 3..5 = night on)   +1  u8 pixel (3 = auto)      +2  u8 driver
+3   u8  0x4d/0x64  +4 u8 0x3c/0x64 (unknown)          +5  u8 channel (0xff = default 149)
+6   u8  language (0 zh-CN, 1 zh-TW, 2 en, 0xff = auto) +7  u8 bt modem (btnet)
+8   char psk[12]        Wi‑Fi password, NUL‑terminated → at most 11 characters
+20  char name[12]       car name shown on iOS ("Auto")
+32  char icon[12]       car-app icon id (www/icon/<id>.png)
…    zeros
+548 u8 fps flag (page "smooth"), +550 u8 mode (1 = H.264 video), +552 u8 auto-connect, tail zeros
(re-read from the KEY handlers 2026-10-19: lycfg offset = lylinkui g offset − 0x458; the online-check
flag is RAM-only in stock)
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
answering table names while disabled, and — since 26101508 — answers every other name
with REFUSED while disabled instead of silence (the stock REFUSED builder at 0x20d18:
RCODE 5 into the header, the query sent back; it needs only r4/r5/r6, which the cave
leaves alone). The `tesla` catch‑all stays off in that state. The wire‑format names live in the zero
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

Resolver order: with the stock DHCP list (8.8.8.8 first) a client that asks the first
server and accepts its NXDOMAIN — macOS, glibc, the Tesla's Chromium — never sees the
adapter's answer while the phone has internet (`DNS_PROBE_FINISHED_NXDOMAIN` on the bench,
2026-10-15, with `dig @192.168.3.1 carplay.internal` answering fine). Since 26101508
`app/udhcpd.conf` lists the adapter first (`192.168.3.1 8.8.8.8 1.1.1.1`): table names are
answered at once, everything else gets REFUSED while the phone is online and the client
moves on to 8.8.8.8 (one local round trip). While the adapter's own online check fails the
stock `tesla` catch‑all answers first instead of last — the same fake connectivity the stock
design relies on, just without the public‑resolver timeouts before it.

**Still failing in the car (2026-10-17).** The dnsd side checks out: the table answer is header +
question + answer RR (the query's OPT record is not copied, ARCOUNT is 0 since 26101509), TTL 121,
uncompressed name. What the Tesla does with it is the open question — the stock design never needed
the car to use the adapter's DNS at all: `tespush.com` resolves publicly to 101.200.208.6, the same
address lyLoadModule.sh puts on `wlan0:0` (`ifconfig wlan0:0 101.200.208.6 netmask 255.255.255.255`),
so the car reaches lylinkui whichever resolver answered. A car that ignores the DHCP resolver list
(fixed public DNS, or Chromium's own resolver) gets NXDOMAIN for `carplay.internal` from 8.8.8.8 and
never asks the adapter. Two consequences, 26101703:

- The address that works regardless of DNS is **`http://101.200.208.6/`** — plain HTTP, lylinkui
  serves the UI and the WebSocket (`ws://`) for any host that is not `tespush.com`. This is also the
  answer to "can the WebSocket run without TLS": yes, by opening the page over HTTP; the page picks
  `ws://` for `http:` pages (`protocol.js`). On the adapter the TLS thread was ~5 % of the core at
  2 Mbit/s (`a=top`), so the gain is modest; the car side's TLS cost is negligible on its x86 CPU.
- The kernel (xz piggy found at 0x3be9 of the uImage, 4.4 MB vmlinux) has the `REDIRECT` and
  `MASQUERADE` targets but **no `string` match**, so "redirect only `.internal` queries to dnsd" is
  not possible, and redirecting *all* of the car's DNS to lylinkui's dnsd would kill the car's
  internet (dnsd cannot forward). Hence **`t2cd`** (`rust/t2cd`, 26101704): a static Rust DNS
  forwarder on UDP 5300 — table names answered locally (`carplay.internal`/`tespush.*` →
  101.200.208.6, `setting.internal` → 192.168.3.1), everything else forwarded to the resolvers
  udhcpc wrote to `/etc/resolv.conf` (8.8.8.8/1.1.1.1 fallback, 2.5 s per resolver, then SERVFAIL),
  and while the PAN default route is down the stock offline behaviour (`*tesla*` → 101.200.208.6
  TTL 0 for the car's connectivity check, REFUSED otherwise). It keeps the nat rule
  `PREROUTING -i wlan0 -p udp --dport 53 -j REDIRECT --to-ports 5300` (re-added after lylinkapp's
  nat flush) so the car's DNS lands there whatever resolver the car chose; lylinkui's dnsd still
  answers direct queries to 192.168.3.1:53. The watchdog restarts t2cd and removes the rule while it
  is not running. Flags: `t2c_dnsredir_off` (rule off, forwarder stays), `t2c_dnsdebug` (log every
  query to `/tmp/t2cd.log`), `t2c_shell` (debug shell, below). Diagnostics `t2cd`, `t2cd_log`,
  `iptables`. Device-tested 2026-10-18 on 26101703 with an uploaded build: the port had to move
  from 5353 (**mdnsd's**, Bonjour) to 5300; after that the rule, table answers, upstream via the
  phone's PAN, the flag toggle and the watchdog relaunch all behaved; 2 000 queries in 7 s at
  500 KB RSS. In the car still to be seen.
- **Debug shell.** The rootfs busybox (372 KB, Jul 2022) has these applets only: ash awk basename
  brctl cat chgrp chmod chown chroot clear cmp cp crond crontab cut date dd df dirname dmesg du echo
  env expr false fgrep find flock free fsync grep gzip head httpd id ifconfig init insmod kill
  killall less linuxrc ln lock login ls lsmod lsof lsusb md5sum mkdir mkfifo mknod mktemp mount mv
  netstat nice nslookup pgrep pidof ping pivot_root printf ps pwd readlink reboot reset rm rmdir
  rmmod route sed seq sh sha256sum sleep sort strings sync sysctl tail tee time top touch tr true
  udhcpc udhcpd umount uname uniq unzip usleep vi watchdog wc wget which yes — no telnetd, nc,
  stty, getty, ssh. So `t2cd` serves the shell: with `/mnt/UDISK/t2c_shell` present
  (`t2c.cgi?a=flag&f=shell&v=1`, `v=` removes it) it listens on tcp/2323 for hotspot clients
  only and gives each connection a root `/bin/sh -i` on a pty (raw bytes, no telnet negotiation,
  window size as a `\x1dWS rows cols` header, 3 sessions). Client: `tools/shell.py` (interactive,
  Ctrl-] quits) or `tools/shell.py -c 'ps; cat /proc/loadavg'`. Remove the flag after use.
  Hang-up (client gone) sends SIGHUP to the shell's group and, via `TIOCSIG`, to the pty's
  foreground group (vi/top run in their own group), SIGKILL after 2 s; a job left with `&` keeps
  the pty but not the session. Tested 2026-10-18: prompt, vi edit/`:wq`, resize, Ctrl-] with vi
  open — no leftover processes.

Checks for the car: type `http://carplay.internal/` (with the scheme; a bare `.internal` name is a
search in Chromium), then `http://101.200.208.6/`; from a laptop on the hotspot
`dig @192.168.3.1 carplay.internal` (expect 101.200.208.6, TTL 121) and `dig @192.168.3.1 example.com`
(expect REFUSED while the phone is online).

## Do not source /etc/profile on the adapter

The rootfs `/etc/profile` ends with `ly_boot.sh &`: every login shell *boots the vendor stack*.
Sourcing it from a bench script (to pick up `WIFI_NAME`, `BT_NAME`, `LY_VERSION`...) started a second
lylinkui/lylinkapp/gocsdk/hostapd on 2026-10-19 — the access point flapped every half minute with
no usable SSID until a power cycle. `app/t2c_dev.sh` reproduces the exports instead
(`fw_printenv custom_name`, the sysfs product number, `system.json` version) and is the only
sanctioned way to stop/start the UI stack by hand; launching `tesla -s` without `WIFI_NAME` writes an
empty `ssid=` into `/tmp/hostapd.conf` (same symptom).

## Radio hang: detection and auto-reboot (26101705)

On 2026-10-18 after ~2 h at the desk the adapter's Wi-Fi AP and Bluetooth disappeared together
while every LED stayed on (green/blue) -- the RTL8821CS is one combo chip (Wi-Fi over SDIO on
irq 305 `sunxi-mmc1`, BT over UART3 on irq 295), lylinkui never noticed, and nothing short of a
power cut brought it back. The cut then left the jffs2 UDISK unmountable, the boot scripts
reformatted it, and the Bluetooth pairing, the Wi-Fi password and the channel were gone. Whether
the root cause was the chip or the kernel is unproven (the pre-hang health log went with the
partition); this is the same shape as "Sharp + Smooth drops after 10-30 min and the phone cannot
rejoin" (Bluetooth gone too).

What 26101705 does about it (`src/app/t2c_watchdog.sh`):

- **Liveness probe every 30 s.** The driver's `/proc/net/rtl8821cs/wlan0/read_reg` reads a MAC
  register over the SDIO bus; the TSF timer (0x560, microseconds, runs while the AP is up:
  ~1,000,000 per second measured) must advance between probes while hostapd runs. A value that
  does not move, the driver's bus-error values (`eaeaeaea`/`ffffffff`), or a read that does not
  return in 8 s counts as bad; three in a row (90 s) = dead. (Idle interrupt rates with a phone
  connected: SDIO ~230/s, BT UART ~9/s -- too variable to use as the trigger, so they are only
  logged, `irq=mmc1/uart3` and `tsf=` in the health line.)
- **Evidence first:** `/mnt/UDISK/t2c_crash.log` (phone page diagnostic `crash`, kept under
  16 KB): the probe values, interrupt counters, last health lines, `dmesg` and logcat tails.
- **Then a clean `reboot`** (sync first; `reboot -f` and sysrq `b` as fallbacks if init hangs),
  at most 3 in a row (`/mnt/UDISK/t2c_crash_count`, reset after 30 min of health) so a chip that
  is dead at boot cannot loop forever. `t2c_autoreboot_off` keeps the evidence and skips the
  reboot. `/tmp/t2c_test_dead` fakes three bad probes (bench test of the whole path).
- `kernel.panic=20` so a kernel panic reboots instead of sitting on a frozen console.
- No hardware watchdog: the stock update flow `killall -9`s every app process before writing the
  customer partition, and an armed `/dev/watchdog` without a magic close would reboot the adapter
  mid-flash. Two `/dev/watchdog` devices exist (sunxi + AXP); nothing opens them.
- Bench uploads never touch UDISK any more (`put` -> `/tmp/t2cd`); the partition is 1.8 MB and
  holds the pairing.
- **A flash deletes our UDISK files.** After the 26101705 OTA the pairing (`bt_conf.ini`,
  `sc_db.db`) and `lycfg.txt` were still there, but `t2c_health.log`, `t2c_crash.log`,
  `t2c_crash_count` and the `t2c_shell` flag were gone (the stock update flow cleans the partition
  and keeps its own files). So flags such as `t2c_shell`/`t2c_autoreboot_off`/`t2c_vht80` have to
  be set again after every flash, and crash evidence must be read before flashing.

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
- 5‑minute soak of the page at 1184×912 (*High resolution*) with swipes: 6–10 Mbit/s, decode
  4.7–7.8 ms, 0 dropped, JS heap flat. Every action on the phone page that reboots or wipes
  the adapter (reset, reboot, channel, name, password, install) goes through the confirm box.
- The phone page shows memory *used* (`MemTotal − MemAvailable`) and a CPU busy share
  (`t2c.cgi?a=info` samples `/proc/stat` twice, 0.3 s apart, `cpu_pct`; `cgi` is 4). The
  adapter runs at load 2–2.8 on its single core while a session is up.

## The session survives the car browser (2026-10-17, 26101701)

What the stock pair did when the Tesla browser was closed and reopened (device log 2026-10-16, the
`unbind`/`closed` lines of `callback_tsl` and lylinkapp's `OnTakeVideo`): the page's WebSocket
closes → lylinkui (CLOSED of the current client, 0x19618) clears `g+0x4c` and calls
`lylinkapi_cmd(2)` → lylinkapp `OnTakeVideo` → libcarplay `TakeScreen`: CarPlay screen mode →
accessory, `LYLINK_VIDEO_STOP`, `_requestProcessTearDown`. The page then reloaded itself on
`visibilitychange` and sent cmd VIDEO at link 1, which goes through `lylinkapi_cmd(3)`
(`OnUntakeVideo` → `UntakeScreen`, a new screen setup) — the second "off/on" the user saw, and the
navigation app lost its route each time. Three lylinkui patches (`tools/patch_lylinkui.py` 12–14)
and a page change fix this:

- **CLOSED** (0x1965c): `lylinkapi_cmd(2)` only while no phone is attached (`g+0x30c == 0`, the
  adapter's own menu stream would otherwise keep encoding for nobody). With a phone the session runs
  on; the IPC thread frees the units (patch 10) until a page is back.
- **cmd VIDEO** (0x18214–0x1825c): link 1 → 3 as before (video requested), but link 2 stays 2 and the
  "untake" is skipped — a running stream only needs the key-frame request that follows.
- **ly_misc_thread** (0x16660): the idle sleep is gone. Stock: `r7` = 600 s after boot, 120 s after
  the last phone/page/video (`g+0x30c`, `g+0`, `g+0x318`, `g+0x314` all zero), then `killall hostapd`
  ("sleeping") and `sleep 1` in a loop until one of them is set again, then `lylinkapi_cmd(12)` ("wake
  up") relaunches hostapd. So the AP was deliberately off whenever the user had been away for two
  minutes, and only came back through the phone's Bluetooth connect → hostapd relaunch (wrapper) chain;
  a failure anywhere in that chain left the adapter without Wi-Fi until a power cycle — the "the
  adapter's Wi-Fi is off and nothing connects" report. The `bne` back to the countdown is now an
  unconditional branch: the counter wraps, the AP stays up.
- **Page**: on `visibilitychange` hidden the socket stays open while a phone is attached and only
  decoding pauses (`VideoPresenter.pause`, units dropped on arrival); without a phone the socket is
  closed so the adapter can stop its menu stream. On visible: key-frame request (worker `waitkey`:
  skip P-frames until the IDR, keep the last picture), or a plain reconnect if the socket is gone, and
  a 5 s check that frames actually arrive (else `drop()` + reconnect). No reload. Hidden pages also
  reconnect now (a hello costs nothing with pixel ≠ 3).
- **Takeover**: `superseded` no longer asks. The page retries by itself after 3, 5, 10, 20, 30, 60 s
  (backoff reset after a minute of stable connection), only while visible; the home screen shows the
  countdown and "Use this screen" retries at once. Two visible pages now alternate without a single
  CarPlay restart (verified against `devserver.py` with two headless Chromes); a hidden one never
  steals. The false-positive case (lylinkui's status thread stalls while HTTP answers) heals itself.

Bench (devserver 768×608 @ 30 fps, headless Chrome, `document.hidden` overridden): hidden with a
phone → socket kept, 0 fps/0 rx while hidden, back at 23 fps within one key frame; hidden without a
phone → close 1005, reconnect on visible. Device test pending (the adapter was not reachable).

## Decoder too slow: step down instead of MJPEG-for-a-week (26101701)

Sharp (1536×960 here) × Smooth (the adapter asks the iPhone for a higher frame rate; stock Standard
is already 40 fps in `ScreenPlayerSetParam`) is more pixels per second than an Intel-era car decodes in
WebAssembly. The old 'slow' verdict (40 % undecoded for 5 s, or a 15-unit backlog for 5 s) switched to
MJPEG for a week and restarted the session — on a drive this fired once the map started moving for
good, 10–30 min in, and MJPEG at that size means the adapter's own decode+JPEG path at full load.
Now `h264Failed('slow')` first sets the frame rate back to Standard (`KEY.FPS` 0, the adapter restarts
the session), on the next verdict the picture size Sharp → Balanced, and only then MJPEG, for a day.
Each step is a toast and an event. Bench: devserver at 400 units/s → 'slow' → `setkey fps 0`, then
`sharp → balanced`.

## Watchdog and health log (`src/app/t2c_watchdog.sh`, 26101701)

Started by `blink.sh` right after gocsdk (build hook). Every 15 s: gocsdk missing twice → `bt_rst`
+ relaunch as blink.sh did (without gocsdk the iPhone can never reconnect — wireless CarPlay starts
over Bluetooth); hostapd daemon missing three times while lylinkui runs → the wrapper is run again;
both at most 6/h, `/mnt/UDISK/t2c_watchdog_off` disables them. Health line once a minute to
`/tmp/t2c_health.log` (400 lines) and every 10 min to `/mnt/UDISK/t2c_health.log` (≤ 48 KB): uptime,
MemAvailable, load, `thermal_zone0`, pids of tesla/lylinkapp/gocsdk, hostapd, stations, wlan0/bt-pan
bytes, OOM count. Phone page diagnostics: `health`, `health_saved`, `watchdog`, `thermal`, `btaudio`
(logcat lines about SCO/WBS/HFP for the Siri microphone question). The wrapper now verifies the daemon
a second after `-B`, excludes shells and its own monitor from `ps` matches, kills a stale monitor pid
only when `/proc/<pid>/cmdline` is really the monitor, and retries the stock file three times instead
of exiting without an AP.

## Siri microphone (asked 2026-10-17; answered after reading libGbtsTask, 26101702)

The Tesla's microphone reaches the iPhone over the **Tesla's own Bluetooth HFP link to the iPhone**;
the adapter is not in that path. `libGbtsTask.so` (CSR Synergy) implements the hands‑free *unit*
role (towards phones: `CsrBtHf*`, `hfp_*`), A2DP and PAN, and has **no hands‑free gateway role**
(`CsrBtHfg*` handlers are absent; `CSR_BT_HFG_IFACEQUEUE` is just a queue id; the only "Hfg" code
is the misnamed `CsrBtHfgNumberOfXtraCodecsSupported`, used by the HF side's `AT+BAC` builder).
So the car switching into its phone‑call audio mode when Siri opens is the Tesla↔iPhone SCO link
(HFP is Bluetooth's only microphone path; A2DP is one‑way), and the **8 kHz narrowband (CVSD) is
negotiated between the Tesla and the iPhone** — a Tesla firmware matter, out of reach of this
firmware. Verification from the adapter: during Siri the `btaudio` diagnostic shows no SCO events
on the adapter at all.

For the record, the adapter's own HF role has dormant wideband code: the flag at `.bss` 0x3bba5c
(`hfp_get_sco_support_msbc`/`hfp_msbc_is_init`, setter never called anywhere) gates the 16 kHz
host path in `inComingBcspSound` (`gbts_apm_* (16000, …)`), the eSCO handling in
`dm_sync_acl_ready`, and `initInstanceData`'s HF features (`0x17f`, `| 0x80` codec negotiation
only when the flag is set); `sendCodecSupport` appends `,2` (mSBC) to `AT+BAC=1` from the codec
mask at instance+0x68. None of it matters for the Tesla path. The WebRTC audio‑processing module
in gocsdk (`apm_mic_in`, AGC + AECM) serves other Carlinkit products that have their own speaker
and microphone (`LYLINK_RECORD_*`, `/mic_test.pcm`).

## Wi‑Fi dropout is not "this browser cannot decode video" (26101702)

Three paths turned a lost connection into *Picture mode for an hour or a day*: the decode worker's
`fetch('h264dec.wasm.txt')` failing while the adapter was unreachable (the module loads when the
first session starts — i.e. right when the Tesla has just joined the adapter's Wi‑Fi), the worker
script itself not loading, and — found on the bench — frames queued while the module was still
loading counting as "undecoded" in the 'slow' verdict (40 % of the offered frames in a second,
five seconds in a row). Now: the worker retries the module fetch (2, 4, 8 … 30 s, 12 attempts; a
non‑200 answer counts as transient too — the file is part of this firmware) and reports
`loading` (the stage shows "loading the video decoder… waiting for the connection"); a failed
worker script or a GL context that never comes back is reported with `transient: true`; the
presenter ignores incoming units and stats until the worker is `ready` (the app then asks for a
key frame); a transient failure rebuilds the worker — a canvas can be transferred only once, so a
fresh canvas element replaces the old one — up to three times in ten minutes, after which Picture
is used for ten minutes and Video is tried again (`videoHeld`), never persisted. Only a module that
does not instantiate, no WebAssembly SIMD or no WebGL still means "cannot decode" (for a day). The
GL‑lost clock also no longer runs while the page is hidden (a hidden tab loses its GPU context
routinely). Bench: devserver `--wasm-fail 3` (503 ×3) → three retries, module at 14 s, key frame,
27 fps, no fallback, nothing persisted.

## Rust UI server bench (`rust/t2cui`, 2026-10-19)

The lylinkui replacement runs on the adapter beside the stock pieces for bench work:
`rust/t2cui/run.sh start` pushes `t2c_dev.sh` and the binary to /tmp, stops `tesla`, runs t2cui on
`0.0.0.0:8081` (stock binds `101.200.208.6:80`; busybox httpd has `192.168.3.1:80`) and starts
lylinkapp; `run.sh stop` puts lylinkui back (hostapd restarts, rejoin the Wi-Fi). Vendor facts that
matter for it are in rust/README.md (callback table, cmd ids, key 0x600 = key frame, the IDR
inside the type-14 event, the import stubs for the section-header-less device libs).

## DNS over the adapter: the phone's resolver is slow (2026-10-19)

"Claude Code does not work on the adapter's Wi-Fi, the browser does": every UDP/53 query from a
hotspot client is REDIRECTed to `t2cd`, which forwarded only to the resolver udhcpc got from the
iPhone's PAN (172.20.10.1). That resolver -- the phone's hotspot DNS proxy over LTE and Bluetooth --
regularly stays silent for seconds, so after the 2.5 s timeout t2cd answered SERVFAIL
(`api.anthropic.com: no answer from [172.20.10.1:53], SERVFAIL`, with Adobe, Datadog and Apple
names in the same second). Node's getaddrinfo turns SERVFAIL into ENOTFOUND/EAI_AGAIN and the CLI
fails; Chrome's own resolver retries and caches, so pages kept loading. Fix (t2cd, bench-tested,
ships from 26101707): 8.8.8.8 and 1.1.1.1 are always appended after the PAN resolver, so a silent
first server means a retry elsewhere, not SERVFAIL. Also measured on the hotspot: TLS handshake to
the API 3.4 s, upload 56 KB/s (~450 kbit/s) -- the PAN is slow, every Claude Code request carries
the whole conversation, expect long turns. TCP/53 is not forwarded yet (`connection refused`).

## Tesla "login page" warning = connman online check (fixed in 26101719)

The car checks connectivity the connman way: `GET /online/status.html` on a name the adapter's
forwarder answers with the UI address while offline (the `tesla` catch-all), and it expects the
response header `X-ConnMan-Status: online` (stock lylinkui sends exactly that). t2cui 26101709..18
answered 200 with an HTML body and no header, which connman reads as a captive portal, so the
Tesla showed "this network tried to show a login page that may require authentication, payment
or terms agreement" on every connection. 26101719 sends the header (`http.rs`).

## Picture mode (MJPEG) in the Rust UI (26101721)

Stock's picture path is five calls into `liblylinkav.so` (an Allwinner MPP build with the
`lylink_h264_*` wrapper on top): `lylink_h264_init()` (AW_MPI_SYS_Init), `lylink_h264_start(p)`
with a 24-byte struct {+0 input kind 0 = H.264, +4/+6 input w/h, +8/+10 output w/h (height
16-aligned), +0xc callback} that creates a VDEC channel (PT 96 = H.264), a VENC channel (PT 26 =
JPEG, output size, 30 fps) and a thread, `lylink_h264_process(data, len)` per access unit
(lylinkui 0x1498c, every type-15 unit while the mode byte is 0), `lylink_h264_stop()`,
`lylink_h264_exit()`. The thread copies each encoded stream (up to two packs) into one buffer and
calls `cb(0, data, len)` (liblylinkav 0x223f8); lylinkui's callback (0x14150) kept one frame in a
slot and blocked the thread until the page took it. The library's own dependencies
(libasound, libcdx_*, libion, libhwdisplay, libglog) live in `/tmp/lylink/eyesee-mpp` and
`LD_LIBRARY_PATH` from lyLoadModule.sh (`/tmp/lylink/lib:/tmp/lylink/eyesee-mpp:/mnt/customer/app:
/usr/lib/eyesee-mpp`) is inherited by t2cui.

`rust/t2cui/src/picture.rs` dlopens the library on first use (so the binary has no hard
dependency and the Mac build just reports "not available"), keeps the newest JPEG in a slot
(no back-pressure: a slow page skips frames), and `session.rs` runs the transcoder exactly while
lycfg +550 == 0 and the phone streams (`ensure_picture()` on video start, on the page's MODE key,
on `/video.jpg` and every tick; started late it gets the cached SPS/PPS and a key-frame request).
While it runs the access units go to the transcoder and not to the WebSocket. `/video.jpg` is the
stock `multipart/x-mixed-replace; boundary=CarPlayVideo` stream and ends when the mode goes back
to video. Measured on the bench (1376x1072 session): about 5 JPEG/s of ~94 KB each (the library
re-encodes at its own pace even when the picture is static, like stock), CPU unchanged on the
Rust side, the codec library logs `cedarc ... have no fullFrame` to stdout (it goes to /dev/null
in the firmware). The page's "auto" transport still prefers H.264 when the browser can decode it;
picture mode is what the page falls back to, or what the user picks.

## Car "no internet" on the hotspot = ip_forward never set (fixed in 26101719)

Found in the car 2026-10-19 night with DNS query logging (`t2c_dnsdebug`): the Tesla's online
check resolves `connman.vn.tesla.services` (CloudFront; plain HTTP `GET /online/status.html`,
200 with an empty HTML page, no `X-ConnMan-Status` header from the real server) every ~30 s and
the forwarder answered it correctly through the PAN, but `/proc/sys/net/ipv4/ip_forward` was 0:
t2cui's `pan_ip_forward()` ran stock's `echo 1 > /proc/sys/net/ipv4/ip_forward` through
`sh -c "... >/dev/null 2>&1"`, and with two stdout redirections the last one wins, so the file
was never written. Everything else of stock's PAN sequence (udhcpc, MASQUERADE, FORWARD ACCEPT) was
in place, DNS worked because t2cd queries upstream from the adapter itself, so the symptom was
"DNS fine, TCP from any hotspot client dead": the car reported no internet (and kept using LTE),
the Mac roamed off AutoKit every minute or two. 26101719 writes the file from Rust, logs
`gocsdk: ip_forward=1`, exposes `fwd` in `/health`, and the watchdog sets it back to 1 whenever
`/tmp/lylink_btpan` exists and it reads 0. Manual check: `cat /proc/sys/net/ipv4/ip_forward`.

Second finding the same night, with forwarding on: the PAN to the iPhone loses packets in bursts
(`ping 172.20.10.1` from the adapter: 11 of 20 lost, misses in runs of 5-6 s; one ~2 min window
where all three resolvers were silent and every hotspot client got SERVFAIL) while the CPU is 92 %
idle and gocsdk is quiet, so the car's online check through the PAN fails whenever a burst hits
and the car falls back to LTE (then the UI address is unreachable for it). 26101720 therefore
answers `connman.vn.tesla.services` from the table in both modes -- the stock experience, where the
catch-all was effectively always on -- so the car stays "online" on the hotspot regardless of the
PAN; the PAN burst loss itself (iPhone hotspot over Bluetooth, same under stock as far as known) is
open.

## Rust UI is the default (26101719); `/mnt/UDISK/t2c_ui_stock` brings the vendor UI back

From 26101719 `app/lyLoadModule.sh` starts `app/t2cui` on every adapter; the vendor `tesla -s`
runs only when `/mnt/UDISK/t2c_ui_stock` exists (phone page, System card: "CarPlay screen: New
UI / Vendor UI" sets the flag through `t2c.cgi?a=flag&f=ui_stock&v=1|` and reboots; the watchdog
follows the same flag). The old opt-in flag `t2c_ui_rust` is ignored (the CGI still accepts it so
an older phone page does not error). A flash clears both flags, so a freshly flashed adapter boots
the Rust UI. Verified on the bench 2026-10-19 night: 26101719 flashed over 26101718, no flags, the
Rust UI came up (see the release notes). Below: the history of the opt-in period.

## No Wi-Fi, no Wi-Fi LED after 26101719..23 on adapters with the default password (fixed in 26101724)

Reported 2026-10-20 by several owners who went 26101718 -> 26101723: the hotspot never appears and
the Wi-Fi LED stays off. The image was intact (md5 of the released file, kernel unchanged, squashfs
under the partition), the USB console code is inert at boot, and the vendor library never starts
hostapd by itself at boot (its only `system("hostapd -B")`, fn 0x1adc in liblylinkui, is reached
through cmd 12 alone). What broke was the Rust UI becoming the default in 26101719 combined with a
*settings interpretation* gap: t2cui read lycfg.txt with stock's layout but not with stock's rules.

**Stock never stores the default password.** `save_hostapd_conf` (lylinkui 0x14ef0) skips the
`wpa_passphrase=` replacement when lycfg +8 starts with 0 (0x15074-0x1508c) and keeps the
template's `wpa_passphrase=88888888`; `lylinkapi_wifi` gets a `strcpy("88888888")` for the same
case (0x153d8) -- the only reference to that literal in the binary. So every adapter whose owner
never changed the password has twelve zero bytes there, and `Cfg::load` copied them over t2cui's
defaults: `wifi.rs` wrote `wpa_passphrase=` empty, the rootfs hostapd refused the file ("invalid
WPA passphrase length 0 (expected 8..63)"), `-B` failed synchronously, the wrapper gave up after
four tries, t2cui logged the return code and moved on, the watchdog relaunched the same file six
times an hour, and the LED stayed off because t2cui lights it only while hostapd runs. Adapters with
a custom password (the bench unit) and adapters with no lycfg.txt at all (defaults) were fine, which
is why nothing showed on the bench. Other rules read from the same function and now mirrored in
`wifi.rs`: channel byte 0 -> `channel=6` + `hw_mode=g` (0x151f8 writes a literal '6'), 0xff -> 149
(0x15204), hw_mode `a` above 14 (0x15000), and the template's `ht_capab=` line dropped for channels
8-14, 48 and >= 162 (0x1502c-0x1505c; `[HT40+]` on 165 has no partner and this hostapd does not fall
back to 20 MHz, it dies after the scan). The physical key's long press (factory reset, `rm -rf
/mnt/UDISK/*`) also lives in lylinkui only; t2cui has the page command.

26101724: `Cfg::psk()` applies the default for an empty or short field (conf, lylinkapi_wifi, init
JSON and QR all go through it; `psk_raw()` shows the stored value), `wifi.rs` renders with the stock
rules, t2cui checks that the daemon is really up 6 s after `hostapd -B` and retries once with a plain
20 MHz file, and the watchdog gained an AP of last resort (60 s up, no daemon, the UI cannot fix it:
`/tmp/hostapd-wd.conf` from the template + lycfg.txt + WIFI_NAME, started through the wrapper's
pass-through) plus a vendor-UI fallback when t2cui dies twice in the first 15 minutes. Release test
from now on: zero the password field of lycfg.txt and boot.

**Adapters already on 26101719..23 with no Wi-Fi have no network path back.** The only automatic
way in is the USB console: the watchdog touches `/tmp/t2c_usb_rescue` at its second hostapd
relaunch (about 90 s after boot) and t2cd turns the port into a CDC-ACM device -- useful only on
units whose D+/D- reach the connector (not this bench unit). On such a console:
`touch /mnt/UDISK/t2c_ui_stock; reboot` (vendor UI, then update from the phone page) or write the
password into lycfg.txt at offset 8.

## Black car screen after the Carlinkit menu until a swipe (fixed in 26101725)

Reported 2026-10-20: open the Carlinkit app inside CarPlay (link 2 -> 1, the page shows its menu),
press "Open CarPlay", and the car screen stays black; the first swipe brings the picture back.
Cause: a key-frame request that nobody sent. On `CMD_VIDEO` t2cui marks the page `need_idr`,
asks the phone to draw again (cmd 4) and reports link 2; the fan-out then withholds P-frames
until an IDR and asks the phone for one **when the next P-frame arrives** (`deliver()`). The
page clears its decoder on the link change (`startH264` -> worker `clear`, `waitKey`) and asks
for a key frame only on worker `ready`, on `needkey` (a P-frame it cannot decode -- which the
adapter never sends it) and on `visibilitychange`. With CarPlay showing a still picture the
phone sends nothing at all, so neither side ever asked: no frames, black canvas. A swipe
changes the picture, P-frames flow, the fan-out asks, the IDR arrives (SPS/PPS glued in front),
the page decodes. Picture mode was never affected (`ensure_picture()` forces a request when the
transcoder restarts), and a moving map recovered on its own within the 2 s key-request gap.
Fix: t2cui asks the phone on `CMD_VIDEO` whenever a stream is running (`session.rs` `on_cmd`),
the page asks on every video (re)start in `switchVideo` (same as its visible path), and an IDR
on the fan-out clears a request queued behind the rate limit so the page's double ask (button
`CMD_VIDEO`, then the link-2 `CMD_VIDEO` + `CMD_KEYFRAME`) restarts the phone's encoder once,
not twice. The adapter log shows it: `page #N wants video (link 1)` is now followed by
`key frame requested` without waiting for a touch.

## Forget on the Devices page did nothing (GitHub issue #1, fixed in 26101726)

Reported 2026-10-20 on 26101725: a phone removed on the iPhone side stays in the car page's list
and the page's delete button does nothing, so re-pairing fails a few times until the stale bond
gives way. The list is gocsdk's `bt_conf.ini` (addrN/nameN, `pairlistindex`, `lastaddr`) and
only gocsdk edits it, so the adapter cannot know the iPhone forgot it; the button is the way out,
and it was broken. Read on 2026-10-21 (`llvm-objdump --triple=armv7-linux-gnueabihf`, PIC
string refs resolved as `ldr rX,[pc]` + `add rX,pc,rX`):

- **gocsdk** keeps a table of AT handlers (`at_funcs`, .data 0x92ad8, 118 entries). Entry 36 at
  0x16f40 is the one that calls `gap_debond_req` + `delete_pairlist_by_addr`: with an empty
  argument it debonds every entry (`read_pair_list_count` / `read_pair_list_by_index`), with a
  one-character argument it takes `atoi(arg) - 1` as the index (so **1-based**, a negative one
  is an error), otherwise `str_to_addr` (libGbtsTask: `strlen == 12` plain hex) and debonds that
  address; with no parseable address it falls back to the connected phone.
- **stock lylinkui** (0x184c0) answers the page's type-6 "forget" by looking the address up in
  the `MX<index:1><addr:12><name>` lines it got from `AT#MX` and sends `AT#CV` + that index
  character (`AT#CC`/`AT#CD`/`AT#CV` are the sibling connect/disconnect/forget commands).
- **t2cui 26101709..25** sent `AT#CV` + the phone's 0-based position in `bt_conf.ini`:
  `AT#CV0` for the first phone is the index error, `AT#CV1` would have removed the first phone
  whichever was asked. Fixed: `AT#CV<addr>`. gocsdk answers `PR<status><addr>` (seen on the
  bench with an unpaired address: `PR2001122334455` + `OK`, nothing deleted), rewrites
  `bt_conf.ini`, and t2cui sends the pages the list again on that line (and 2.5 s after the
  request regardless).
- **Second defect, same page:** the status JSON's `bt` carried the phone's *name* (`SA` line);
  stock carries the connected phone's *address*, which the page matches against its list for the
  "Connected" tag and for Connect/Disconnect/Forget of a connected phone (forget disconnects
  first, then forgets when `bt` goes empty). With a name there nothing matched: no phone was ever
  "Connected", Connect sent `AT#CD<name>` (dropped) and the forget-while-connected path never
  ran. Now `bt` = the address from the phone's `SV`/`SS` service lines (`SV<addr:12><uuid>`),
  `bt_conf.ini`'s `lastaddr` until one came, empty without a phone.

## Rust UI opt-in (`/mnt/UDISK/t2c_ui_rust`, 26101707 .. 26101718)

`app/lyLoadModule.sh` starts `app/t2cui --log /tmp/t2cui.log` instead of `/tmp/lylink/tesla -s`
when the flag exists (phone page: `t2c.cgi?a=flag&f=ui_rust&v=1`, `v=` clears; reboot to switch).
t2cui binds 101.200.208.6:80 like stock, serves `/tmp/lylink/www`, writes /tmp/hostapd.conf and
starts hostapd when missing, hands the credentials to the vendor library (lylinkapp -> iAP), and
runs the CarPlay session through liblylinkui in-process. The watchdog counts it as the UI
(`lylinkui_alive`, health `ui=`), relaunches it after two missing checks, and `?a=cat&f=t2cui`
shows its log. 26101711 also listens on `0.0.0.0:8080`, so `http://192.168.3.1:8080/` reaches the CarPlay page
from any hotspot client without the adapter's DNS (a Mac with a wired interface included); the
car-app icon in CarPlay arrives as vendor callback 19 (stock: icon id `sr..` -> Siri key 0x300,
otherwise page link 1 = the page's own menu, the phone keeps streaming), the page's "smooth" FPS is start-struct flags 0x2910 (standard 0x3910), night is +0x14 (0/2),
driver side +4, and picture mode (MJPEG) is refused with a page reload. 26101712: the page home has
"Restart adapter" (page cmd 10, Rust UI only), a car-identity change copies `www/icon/<id>.png` to
`/tmp/lylink/home.png` and restarts the session (how stock applies the icon), the phone page sends
a Tesla browser (`navigator.userAgent` contains "Tesla") to `http://192.168.3.1:8080/`. 26101715:
the page home is a big "Open CarPlay" button on top, status and steps, QR at the bottom; the
restart-adapter row sits at the bottom of the System page (the mic test page link is gone).
26101710: LEDs, Bluetooth glue and PAN are in, so the flag gives the complete boot experience
(verified cold boots: UI at 10 s, phone linked at 16 s, PAN at 21 s). Entry points are HTTP only
(`http://carplay.internal/`, `http://tespush.com/`, `http://101.200.208.6/`): stock answered
`https://tespush.com` on 443 with the vendor certificate and redirected http there; t2cui does
not, so a car bookmark on https must move to `http://carplay.internal/` before the default
switch. Known gaps in 26101707/08 while the flag was on: no Bluetooth PAN management (stock lylinkui's
gocsdk module runs `AT#NC` + udhcpc on bt-pan -> no internet through the phone, so the DNS
forwarder has only the public resolvers, unreachable), no LED control, no firmware hand-off from
the car page (the phone page still updates), night hint not forwarded. Images now use 1 MB
squashfs blocks (tools/build.sh, `T2C_SQFS_BLOCK`): the two Rust binaries pushed the 256 KB build
over the 0x640000 customer partition; build.sh refuses an image that does not fit. 26101708: 6,508,544 of 6,553,600 bytes -- 45 KB spare;
the next bytes have to come from merging t2cd into t2cui or trimming (t2cd stays static: its pty
shell uses `Command` with `pre_exec`, which the device musl's missing posix_spawn_*_addchdir_np
makes a dynamic link fail).

## LEDs (mapped on the bench 2026-10-19, user watching)

Sysfs, not ioctl: `/sys/class/misc/ly_misc_dev/ly/{wifi_led,link_led,model_led,sys_led}` take
`0xRRGGBB` (also the brightness): `wifi_led` = the Wi-Fi LED, `link_led` = the device LED,
`model_led` = the antenna LED, `sys_led` = power (hardware, 0x4000 at boot). 0x4000 green, 0x40
blue, 0x400000 red, 0 off; 0x2000/0x1000 dim green, 0x8000 bright. Stock with a phone attached:
Wi-Fi green, device green, antenna blue. lylinkui's ioctls 0x4c00-0x4c02 on `/dev/ly_misc_dev`
return 0 but change nothing visible on this unit; `0x4c10`/`0x4c80..83` carry a 56-byte key/power-
button struct ("powerkey do reboot", "count down", "enter test mode"); other codes: `0x701/0x702/
0x707` (crypto/IC check), `0x703` (`check_funcs`), `0x705` (`set_btpan_mode`), `0x720`
(`lycrypto_check`). t2cui (`leds.rs`): Wi-Fi green while hostapd runs, device green while a phone
session exists, antenna blue while gocsdk reports the phone connected; `GET /led?name=&v=0x..`
writes a raw value for bench checks.
