/* Video presenter for the CarPlay picture. Two transports:
 *
 *  MJPEG  GET /video.jpg (multipart/x-mixed-replace) consumed with a streaming fetch
 *         reader, decoded off the main thread with createImageBitmap and painted on a
 *         2D canvas the moment the bitmap is ready. Only the newest frame is decoded;
 *         stale frames are dropped, so latency never accumulates.
 *
 *  H.264  The adapter forwards the iPhone's H.264 stream over the WebSocket. Frames
 *         are decoded in a Web Worker by FFmpeg compiled to WebAssembly and painted
 *         through WebGL on an OffscreenCanvas (js/h264worker.js). 3–5× less bandwidth
 *         than MJPEG and no transcoding inside the adapter. Every access unit is
 *         decoded (a skipped one breaks the reference chain until the next IDR, and the
 *         iPhone sends those rarely); when several are waiting, only the newest is
 *         drawn, so a burst costs decode time but no latency. If the backlog keeps
 *         growing the decoder cannot keep up: 'slow' is reported and the app falls
 *         back to MJPEG.
 *
 * Canvas backing stores always have the frame's own size; CSS object-fit does the
 * scaling. Touch coordinates are mapped back through the same fit rule.
 */
(function (global) {
  'use strict';

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  function VideoPresenter(opts) {
    this.canvas = opts.canvas;              // 2D canvas for MJPEG
    this.canvasWorker = opts.canvasWorker;  // transferred (once, permanently) to the H.264 worker
    this.img = opts.img;
    this.statsEl = opts.statsEl;
    this.onMessage = opts.onMessage || function () {};
    this.fit = opts.fit || 'contain';
    this.mode = 'idle';           // 'mjpeg' | 'img' | 'h264' | 'idle'
    this.surface = 'canvas';
    this.frameW = 0; this.frameH = 0;
    this.ctx = null;
    this.abort = null;
    this.pending = null;          // MJPEG: newest undecoded JPEG
    this.decoding = false;        // MJPEG: createImageBitmap running
    this.queue = [];              // H.264: access units waiting for the worker, oldest first
    this.inflight = false;        // H.264: access unit posted, 'done' not yet received
    this.lost = false;            // H.264: a frame was dropped since the last one posted
    this.worker = null; this.workerReady = false;
    this.broken = false;          // the worker failed; its canvas cannot be handed to a new one, so H.264 is out until reload
    this.slowSeconds = 0;
    this.rxSec = 0;               // H.264 frames received since the worker's last stats report
    this.showStats = false;
    this.stats = this.resetStats();
    this.statsTimer = 0;
    this.setFit(this.fit);
  }

  /* ------------------------------------------------------------ capability */

  VideoPresenter.canH264 = function () {
    return typeof global.WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function' &&
      typeof global.Worker === 'function' && typeof global.OffscreenCanvas === 'function' &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
  };

  /** WebAssembly SIMD feature test (module with a single v128 op). */
  VideoPresenter.wasmSimd = function () {
    try {
      return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) { return false; }
  };

  /* --------------------------------------------------------------- common */

  VideoPresenter.prototype.resetStats = function () {
    return { rx: 0, painted: 0, dropped: 0, skipped: 0, bytes: 0, decodeMs: 0, decodeN: 0, t0: now(), fps: 0, rxfps: 0, kbps: 0, dec: 0 };
  };

  VideoPresenter.prototype.setFit = function (fit) {
    this.fit = fit;
    var css = fit === 'cover' ? 'cover' : fit === 'stretch' ? 'fill' : 'contain';
    [this.canvas, this.canvasWorker, this.img].forEach(function (el) { if (el) el.style.objectFit = css; });
  };

  VideoPresenter.prototype.setStatsVisible = function (v) {
    var self = this;
    this.showStats = !!v;
    if (this.statsEl) this.statsEl.classList.toggle('hidden', !v);
    if (v && !this.statsTimer) this.statsTimer = setInterval(function () { self.updateStats(); }, 1000);
    else if (!v && this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = 0; }
  };

  VideoPresenter.prototype.updateStats = function () {
    var s = this.stats, t = now(), dt = (t - s.t0) / 1000;
    if (dt <= 0) return;
    s.fps = s.painted / dt; s.rxfps = s.rx / dt; s.kbps = (s.bytes * 8 / 1000) / dt;
    s.dec = s.decodeN ? s.decodeMs / s.decodeN : 0;
    if (this.statsEl) {
      var I = global.I18N;
      this.statsEl.textContent =
        s.fps.toFixed(1) + ' ' + (I ? I.t('stat.fps') : 'fps') +
        ' · rx ' + s.rxfps.toFixed(1) +
        ' · ' + Math.round(s.kbps) + ' ' + (I ? I.t('stat.kbps') : 'kbit/s') +
        ' · ' + (I ? I.t('stat.decode') : 'decode') + ' ' + s.dec.toFixed(1) + ' ms' +
        ' · ' + (I ? I.t('stat.dropped') : 'dropped') + ' ' + s.dropped + (s.skipped ? '+' + s.skipped : '') +
        ' · ' + this.frameW + '×' + this.frameH + ' ' + this.mode;
    }
    s.rx = 0; s.painted = 0; s.skipped = 0; s.bytes = 0; s.decodeMs = 0; s.decodeN = 0; s.t0 = t;
  };

  VideoPresenter.prototype.showSurface = function (which) {
    if (this.canvas) this.canvas.classList.toggle('hidden', which !== 'canvas');
    if (this.canvasWorker) this.canvasWorker.classList.toggle('hidden', which !== 'worker');
    if (this.img) this.img.classList.toggle('hidden', which !== 'img');
    this.surface = which;
  };

  /* ------------------------------------------------------------------ MJPEG */

  VideoPresenter.prototype.start = function (url) {
    var self = this;
    this.stop();
    this.mode = 'mjpeg';
    var streaming = !!(global.fetch && global.ReadableStream && global.createImageBitmap && global.AbortController);
    if (!streaming) return this.startImg(url);
    this.showSurface('canvas');
    this.ctx = this.ctx || this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.abort = new AbortController();
    var signal = this.abort.signal;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    fetch(url + sep + 't=' + Date.now(), { cache: 'no-store', signal: signal })
      .then(function (r) {
        if (!r.ok || !r.body) throw new Error('mjpeg http ' + r.status);
        return self.readMultipart(r.body.getReader(), signal);
      })
      .catch(function (e) {
        if (signal.aborted) return;
        console.warn('mjpeg stream ended', e && e.message);
        self.onMessage('ended');
        if (self.mode === 'mjpeg') self.startImg(url);
      });
  };

  VideoPresenter.prototype.startImg = function (url) {
    this.mode = 'img';
    if (!this.img) return;
    this.showSurface('img');
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    this.img.src = url + sep + 't=' + Date.now();
  };

  /** Parse "--boundary\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>" repeatedly. */
  VideoPresenter.prototype.readMultipart = function (reader, signal) {
    var self = this;
    var buf = new Uint8Array(0);
    var need = -1;        // body bytes still needed, -1 while parsing headers, -2 length-less part
    var td = new TextDecoder('latin1');

    function concat(a, b) {
      if (a.length === 0) return b;
      var c = new Uint8Array(a.length + b.length);
      c.set(a, 0); c.set(b, a.length);
      return c;
    }
    function indexOfCRLFCRLF(u8, from) {
      for (var i = from; i + 3 < u8.length; i++) {
        if (u8[i] === 13 && u8[i + 1] === 10 && u8[i + 2] === 13 && u8[i + 3] === 10) return i;
      }
      return -1;
    }
    function findSOI(u8) {
      for (var i = 0; i + 1 < u8.length; i++) if (u8[i] === 0xFF && u8[i + 1] === 0xD8) return i;
      return -1;
    }

    function pump() {
      return reader.read().then(function (res) {
        if (res.done || signal.aborted) return;
        buf = concat(buf, res.value);
        self.stats.bytes += res.value.length;
        for (;;) {
          if (need === -1) {
            var h = indexOfCRLFCRLF(buf, 0);
            if (h < 0) {
              if (buf.length > 65536) buf = new Uint8Array(0);
              break;
            }
            var head = td.decode(buf.subarray(0, h));
            var m = /content-length:\s*(\d+)/i.exec(head);
            buf = buf.subarray(h + 4);
            if (m) {
              need = parseInt(m[1], 10);
            } else {
              var s = findSOI(buf);
              if (s < 0) break;
              buf = buf.subarray(s);
              need = -2;
            }
          }
          if (need >= 0) {
            if (buf.length < need) break;
            var frame = buf.slice(0, need);
            buf = buf.subarray(need);
            need = -1;
            self.pushJpeg(frame);
          } else if (need === -2) {
            var e = -1;
            for (var i = 2; i + 1 < buf.length; i++) if (buf[i] === 0xFF && buf[i + 1] === 0xD9) { e = i + 2; break; }
            if (e < 0) break;
            var f2 = buf.slice(0, e);
            buf = buf.subarray(e);
            need = -1;
            self.pushJpeg(f2);
          }
        }
        return pump();
      });
    }
    return pump();
  };

  VideoPresenter.prototype.pushJpeg = function (bytes) {
    this.stats.rx++;
    if (this.pending) this.stats.dropped++;
    this.pending = bytes;
    this.decodeNext();
  };

  VideoPresenter.prototype.decodeNext = function () {
    var self = this;
    if (this.decoding || !this.pending) return;
    var bytes = this.pending; this.pending = null;
    this.decoding = true;
    var t0 = now();
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      .then(function (bmp) {
        self.stats.decodeMs += now() - t0; self.stats.decodeN++;
        self.paint(bmp);
      })
      .catch(function (e) { console.warn('jpeg decode', e && e.message); })
      .then(function () { self.decoding = false; self.decodeNext(); });
  };

  VideoPresenter.prototype.paint = function (bmp) {
    if (!this.ctx || this.mode !== 'mjpeg') { bmp.close(); return; }
    if (bmp.width !== this.frameW || bmp.height !== this.frameH) {
      this.canvas.width = bmp.width; this.canvas.height = bmp.height;
      this.frameW = bmp.width; this.frameH = bmp.height;
      this.onMessage('size', bmp.width, bmp.height);
    }
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();
    this.stats.painted++;
  };

  /* ------------------------------------------------------------------ H.264 */

  VideoPresenter.prototype.startH264 = function () {
    var self = this;
    this.stop();
    this.mode = 'h264';
    this.slowSeconds = 0; this.rxSec = 0;
    this.showSurface('worker');
    if (this.worker) { this.worker.postMessage({ id: 'clear' }); return; }
    try {
      var off = this.canvasWorker.transferControlToOffscreen();
      this.worker = new Worker('js/h264worker.js');
      this.worker.onmessage = function (ev) { self.onWorkerMessage(ev.data); };
      this.worker.onerror = function (e) { self.broken = true; self.onMessage('h264error', String(e && e.message)); };
      var simd = VideoPresenter.wasmSimd();
      try { if (localStorage.getItem('t2c.nosimd') === '1') simd = false; } catch (e) { /* ignore */ }
      this.worker.postMessage({ id: 'init', canvas: off, simd: simd }, [off]);
    } catch (e) {
      this.worker = null; this.broken = true;
      this.onMessage('h264error', String(e && e.message));
    }
  };

  VideoPresenter.prototype.onWorkerMessage = function (d) {
    if (!d) return;
    switch (d.id) {
      case 'ready': this.workerReady = true; this.onMessage('ready', d.gl2); break;
      case 'done': this.inflight = false; this.postNext(); break;
      case 'size': this.frameW = d.w; this.frameH = d.h; this.onMessage('size', d.w, d.h); break;
      case 'key': this.onMessage('key'); break;
      case 'needkey': this.onMessage('needkey'); break;
      case 'refresh': this.onMessage('refresh'); break;
      case 'error': this.broken = true; this.onMessage('h264error', d.message); break;
      case 'stats': {
        if (this.mode !== 'h264') { this.rxSec = 0; break; }
        this.stats.painted += d.dec; this.stats.decodeMs += d.ms; this.stats.decodeN += d.dec;
        // Decoder cannot keep up: more than 40 % of the frames it was offered went undecoded
        // for 5 s. Frames skipped while waiting for a key frame are the stream's fault, not
        // the decoder's, and do not count.
        var offered = this.rxSec - d.wait;
        this.rxSec = 0;
        var behind = this.queue.length > VideoPresenter.H264_LATE;
        if (behind || (offered >= 12 && d.dec < offered * 0.6)) { if (++this.slowSeconds >= 5) { this.slowSeconds = 0; this.onMessage('slow'); } }
        else this.slowSeconds = 0;
        break;
      }
    }
  };

  /* Backlog that means the decoder is hopelessly behind (3 s at 30 fps): the queue is thrown
   * away so memory stays bounded; the picture is broken until an IDR anyway and the 'slow'
   * verdict follows. A backlog above H264_LATE for 5 s counts as slow as well. */
  VideoPresenter.H264_GIVEUP = 90;
  VideoPresenter.H264_LATE = 15;

  /** Feed one Annex-B access unit (Uint8Array, ownership transferred). */
  VideoPresenter.prototype.feedH264 = function (u8) {
    if (this.mode !== 'h264' || !this.worker) return;
    this.stats.rx++; this.stats.bytes += u8.byteLength; this.rxSec++;
    this.queue.push(u8);
    if (this.queue.length > VideoPresenter.H264_GIVEUP) {
      this.stats.dropped += this.queue.length; this.queue = []; this.lost = true;
      this.onMessage('refresh');
    }
    this.postNext();
  };

  /** The stream lost an access unit before it reached us (reassembly failure). */
  VideoPresenter.prototype.noteDrop = function () {
    if (this.mode !== 'h264') return;
    this.stats.dropped++; this.lost = true;
  };

  VideoPresenter.prototype.postNext = function () {
    if (this.inflight || !this.queue.length || !this.worker) return;
    var u8 = this.queue.shift();
    this.inflight = true;
    var lost = this.lost; this.lost = false;
    // Newer frames waiting: decode this one for its references only, the newest gets drawn.
    var draw = this.queue.length === 0;
    if (!draw) this.stats.skipped++;
    // The buffer is ours (fresh from the WebSocket or assembled here): hand it over instead of copying.
    this.worker.postMessage({ id: 'decode', data: u8.buffer, off: u8.byteOffset, len: u8.byteLength, lost: lost, draw: draw }, [u8.buffer]);
  };

  /* ----------------------------------------------------------------- misc */

  VideoPresenter.prototype.clear = function () {
    if (this.ctx && this.canvas.width) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this.worker) this.worker.postMessage({ id: 'clear' });
  };

  VideoPresenter.prototype.stop = function () {
    if (this.abort) { try { this.abort.abort(); } catch (e) { /* ignore */ } this.abort = null; }
    if (this.img && this.mode === 'img') { this.img.removeAttribute('src'); }
    if (this.worker && this.mode === 'h264') this.worker.postMessage({ id: 'clear' });
    this.pending = null; this.decoding = false; this.queue = []; this.lost = false;
    this.frameW = 0; this.frameH = 0;     // the next stream reports its size again
    this.mode = 'idle';
    this.stats = this.resetStats();
  };

  /** Map a client point to CarPlay per-mille coordinates honouring object-fit. */
  VideoPresenter.prototype.toPerMille = function (clientX, clientY) {
    var el = this.surface === 'img' ? this.img : this.surface === 'worker' ? this.canvasWorker : this.canvas;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    var fw = this.frameW || (el.naturalWidth || el.width) || r.width;
    var fh = this.frameH || (el.naturalHeight || el.height) || r.height;
    var dx = r.left, dy = r.top, dw = r.width, dh = r.height;
    if (this.fit !== 'stretch' && fw > 0 && fh > 0) {
      var s = this.fit === 'cover' ? Math.max(r.width / fw, r.height / fh) : Math.min(r.width / fw, r.height / fh);
      dw = fw * s; dh = fh * s;
      dx = r.left + (r.width - dw) / 2; dy = r.top + (r.height - dh) / 2;
    }
    var x = (clientX - dx) * 1000 / dw;
    var y = (clientY - dy) * 1000 / dh;
    x = Math.max(0, Math.min(1000, x)); y = Math.max(0, Math.min(1000, y));
    return { x: Math.round(x), y: Math.round(y) };
  };

  global.VideoPresenter = VideoPresenter;
})(window);
