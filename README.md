# Carlinkit T2C — Tesla web UI rebuild

Custom firmware build for the Carlinkit **T2C** (TesPush T2C, hardware branch `1508`) that
replaces the adapter's Tesla‑browser web interface. The device binaries are untouched;
only `app/www` inside the `customer` squashfs partition is rebuilt, so the phone‑facing
OTA page at `http://192.168.3.1/` (`ota/www`) stays exactly as shipped.

## Why

Tesla software 2026.26 moved the in‑car browser to Chromium 148 and changed its pixel
density (DPR 1.0 → 1.53, CSS viewport 1920×1200 → 1254×784, or 773×601 when docked next
to the map). The stock T2C page assumed a ≥1024 px wide layout, sized its video surface
from the browser's reported width, requested a square 800×800 CarPlay session in picture
mode and stretched it to the window. Results: the right side cut off, a distorted picture,
and a page reload loop on resize. Carlinkit has not shipped a fix.

## What changed

**Fit the Tesla browser**
- The layout is viewport‑driven; the root font size is derived from `devicePixelRatio`
  so the UI keeps the same physical size before and after the Tesla density change.
- The CarPlay session size is requested from the browser: *Balanced* (default) matches
  the browser viewport, *Sharp* matches physical pixels (1:1 on the Tesla screen),
  *Data saver* is 0.75×, *Device* restores the adapter's own HD/SD/Auto presets.
  The session always has the viewport's aspect ratio, so nothing is cropped or stretched.
- Picture fit (Fit / Fill / Stretch) is a user choice; touch coordinates are mapped
  through the same rule.

**Smoother, lower‑latency picture**
- MJPEG (`/video.jpg`) is consumed with a streaming `fetch` reader, decoded off the
  main thread with `createImageBitmap`, and painted inside `requestAnimationFrame`.
  Only the newest frame is decoded; stale frames are dropped, so latency never
  accumulates and the TCP stream never stalls the adapter.
- H.264 over WebSocket is used automatically when the browser provides WebCodecs
  (worker + OffscreenCanvas + WebGL). The Tesla browser currently lacks WebCodecs, so
  the adapter is switched to picture mode when needed instead of showing a black screen.
- Touch moves are coalesced per animation frame; pointer events with capture.
- A performance overlay (fps, bandwidth, decode time, dropped frames) can be toggled in
  Display settings.

**New interface** (per `DESIGN.md`, Tesla‑style)
- White canvas, Electric Blue accent, 4 px controls, 12 px surfaces, no shadows, plus a
  Carbon Dark theme that can follow the CarPlay night‑mode schedule.
- A pairing screen with the Bluetooth name, steps, status, and a QR card.
- Settings: Devices, Cellular, Wi‑Fi (password/channel), Bluetooth modem, Display,
  Language, System (car name/icon), About (update, factory reset, update server).

**Languages**: English, 简体中文, 繁體中文, 한국어, 日本語 (client‑side; the adapter can
only persist zh‑CN/zh‑TW/en, so the choice is kept in the browser's storage).

**Firmware update server**: `CONFIG.UPDATE_BASE_URL` in `src/www/js/app.js`. It can be
overridden at runtime with `?test=<url>` in the page URL or the *Update server* field on the
About page (the final location is still to be decided).

## Not changed / limitations

- **Audio and microphone are not routed through the browser.** CarPlay audio goes
  iPhone → T2C → Tesla over Bluetooth (A2DP for media, HFP for calls/Siri), and the car's
  microphone comes back over the same HFP link. The Tesla browser blocks `getUserMedia`
  at compile time, and the adapter firmware has no audio path over the WebSocket, so
  intermittent microphone drop‑outs are a Bluetooth stack issue inside the closed
  `gocsdk`/`libGbtsTask` binaries and cannot be fixed from the web UI.
- True low‑bandwidth video (H.264 at a few Mbit/s instead of MJPEG) needs an H.264
  decoder in the browser. WebCodecs is auto‑detected and used when Tesla enables it.
  A WebAssembly fallback decoder is possible but was not added (see `docs/NOTES.md`).

## Build

```
brew install squashfs            # unsquashfs / mksquashfs
cp /path/to/update.img .         # official 1508 image (test.img is also accepted)
python3 test/check.py            # static checks
tools/build.sh test.img build/T2C-tesla-ui.img
```

`tools/build.sh` unpacks the image (`md5 line + SWUpdate CPIO`), extracts the `customer`
squashfs, replaces `app/www`, repacks with the original parameters (xz, 256 KiB blocks,
root‑owned 0755) and verifies the result (`tools/verify.sh`).

## Flash

Join the adapter's Wi‑Fi (`TesPush_T2C_xxxx`) and upload the image to the OTA endpoint:

```
curl -v -F 'file=@build/T2C-tesla-ui.img;filename=update.img' \
     'http://192.168.3.1/cgi-bin/index.cgi?id=upload'
```

Expected reply: `{"code": 0, "msg": "upload successful"}`. Keep the adapter powered; it
reboots into recovery, writes `boot` + `customer`, and reboots again. Only use this on
firmware branch **1508** (`http://192.168.3.1/cgi-bin/index.cgi?id=host` shows the version).
Flashing can brick the adapter; there is no A/B fallback.

## Develop

```
python3 tools/devserver.py --frames /path/to/jpegs --link-after 4        # MJPEG mock
python3 tools/devserver.py --mode video --h264 stream.h264 --link-after 2  # H.264 mock
```

The simulator reproduces the adapter's templating, WebSocket protocol, `/video.jpg`
stream, Bluetooth list and firmware upload endpoints. `tools/cdp.py` drives a headless
Chrome for screenshots at Tesla viewports (`--metrics 773x601x1.53`).

## Layout

```
src/www/          new web UI (index.in, css/, js/, lan/, icon/, img/)
tools/swu.py      unpack / repack the .img container
tools/build.sh    full build pipeline     tools/verify.sh   image checks
tools/devserver.py  adapter simulator     tools/cdp.py      headless Chrome driver
test/check.py     static checks (tokens, ids, i18n parity, syntax, size)
docs/NOTES.md     reverse‑engineering notes (protocol, template engine, session sizing)
docs/original-www/  the stock web UI from firmware 26090414.5.4 for reference
```
