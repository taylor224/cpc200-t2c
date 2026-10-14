/* Video presenter for the CarPlay picture.
 *
 * Two transports are supported:
 *   - MJPEG   : GET /video.jpg (multipart/x-mixed-replace). Parsed with a streaming
 *               fetch reader, decoded off the main thread with createImageBitmap and
 *               painted on a 2D canvas inside requestAnimationFrame. Only the newest
 *               frame is decoded (stale frames are dropped) so latency never builds up.
 *               Falls back to a plain <img> when streaming fetch is unavailable.
 *   - H.264   : Annex-B frames from the WebSocket, decoded with WebCodecs when the
 *               browser provides it (a Worker + OffscreenCanvas + WebGL when possible).
 *
 * The canvas backing store always has the frame's own size; CSS object-fit does the
 * scaling on the GPU. Touch coordinates are mapped back through the same fit rule.
 */
(function (global) {
  'use strict';

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  function VideoPresenter(opts) {
    this.canvas = opts.canvas;            // 2D canvas: MJPEG and main-thread WebCodecs
    this.canvasWorker = opts.canvasWorker; // canvas transferred to the decode worker (one-way, permanent)
    this.img = opts.img;
    this.statsEl = opts.statsEl;
    this.onMessage = opts.onMessage || function () {};
    this.onKeyframeNeeded = opts.onKeyframeNeeded || function () {};
    this.fit = opts.fit || 'contain';
    this.mode = 'idle';           // 'mjpeg' | 'img' | 'webcodecs' | 'idle'
    this.frameW = 0; this.frameH = 0;
    this.ctx = null;
    this.worker = null;
    this.decoder = null;
    this.waitKey = true;
    this.abort = null;
    this.pending = null;          // latest undecoded JPEG bytes
    this.decoding = false;
    this.bitmap = null;           // latest decoded, not yet painted
    this.raf = 0;
    this.showStats = false;
    this.stats = this.resetStats();
    this.statsTimer = 0;
    this.setFit(this.fit);
  }

  VideoPresenter.prototype.resetStats = function () {
    return { rx: 0, painted: 0, dropped: 0, bytes: 0, decodeMs: 0, decodeN: 0, t0: now(), fps: 0, rxfps: 0, kbps: 0, dec: 0 };
  };

  VideoPresenter.prototype.setFit = function (fit) {
    this.fit = fit;
    var css = fit === 'cover' ? 'cover' : fit === 'stretch' ? 'fill' : 'contain';
    if (this.canvas) this.canvas.style.objectFit = css;
    if (this.canvasWorker) this.canvasWorker.style.objectFit = css;
    if (this.img) this.img.style.objectFit = css;
  };

  VideoPresenter.prototype.setStatsVisible = function (v) {
    var self = this;
    this.showStats = !!v;
    if (this.statsEl) this.statsEl.classList.toggle('hidden', !v);
    if (v && !this.statsTimer) {
      this.statsTimer = setInterval(function () { self.updateStats(); }, 1000);
    } else if (!v && this.statsTimer) {
      clearInterval(this.statsTimer); this.statsTimer = 0;
    }
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
        ' · ' + (I ? I.t('stat.dropped') : 'dropped') + ' ' + s.dropped +
        ' · ' + this.frameW + '×' + this.frameH + ' ' + this.mode;
    }
    s.rx = 0; s.painted = 0; s.bytes = 0; s.decodeMs = 0; s.decodeN = 0; s.t0 = t;
  };

  VideoPresenter.prototype.showSurface = function (which) {
    var self = this;
    [['canvas', this.canvas], ['worker', this.canvasWorker], ['img', this.img]].forEach(function (p) {
      if (p[1]) p[1].classList.toggle('hidden', p[0] !== which);
    });
    this.surface = which;
    void self;
  };

  /* ------------------------------------------------------------------ MJPEG */

  VideoPresenter.prototype.startMjpeg = function (url) {
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
        // Fall back to the <img> path; the browser handles reconnection itself.
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
    var need = -1;        // body bytes still needed, -1 while parsing headers
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
    function findSOI(u8) { // 0xFF 0xD8 start of JPEG
      for (var i = 0; i + 1 < u8.length; i++) if (u8[i] === 0xFF && u8[i + 1] === 0xD8) return i;
      return -1;
    }

    function pump() {
      return reader.read().then(function (res) {
        if (res.done || signal.aborted) return;
        buf = concat(buf, res.value);
        self.stats.bytes += res.value.length;
        for (;;) {
          if (need < 0) {
            var h = indexOfCRLFCRLF(buf, 0);
            if (h < 0) {
              if (buf.length > 65536) buf = new Uint8Array(0); // garbage guard
              break;
            }
            var head = td.decode(buf.subarray(0, h));
            var m = /content-length:\s*(\d+)/i.exec(head);
            buf = buf.subarray(h + 4);
            if (m) {
              need = parseInt(m[1], 10);
            } else {
              // No length: find next JPEG start and let the SOI scan handle it.
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
            // Length-less part: scan for EOI (FF D9).
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
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      .then(function (bmp) {
        self.stats.decodeMs += now() - t0; self.stats.decodeN++;
        if (self.bitmap) { self.bitmap.close(); self.stats.dropped++; }
        self.bitmap = bmp;
        self.schedulePaint();
      })
      .catch(function (e) { console.warn('jpeg decode', e && e.message); })
      .then(function () { self.decoding = false; self.decodeNext(); });
  };

  VideoPresenter.prototype.schedulePaint = function () {
    var self = this;
    if (this.raf) return;
    this.raf = requestAnimationFrame(function () { self.raf = 0; self.paint(); });
  };

  VideoPresenter.prototype.paint = function () {
    var bmp = this.bitmap;
    if (!bmp || !this.ctx) return;
    this.bitmap = null;
    if (bmp.width !== this.canvas.width || bmp.height !== this.canvas.height) {
      this.canvas.width = bmp.width; this.canvas.height = bmp.height;
      this.frameW = bmp.width; this.frameH = bmp.height;
      this.onMessage('size', bmp.width, bmp.height);
    }
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();
    this.stats.painted++;
  };

  /* ----------------------------------------------------------------- H.264 */

  VideoPresenter.supportsWebCodecs = function (codec) {
    codec = codec || 'avc1.64001f';
    if (typeof global.VideoDecoder !== 'function' || typeof global.EncodedVideoChunk !== 'function') {
      return Promise.resolve(false);
    }
    try {
      return VideoDecoder.isConfigSupported({ codec: codec }).then(function (r) { return !!(r && r.supported); })
        .catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  };

  VideoPresenter.prototype.startWebCodecs = function () {
    var self = this;
    this.stop();
    this.mode = 'webcodecs';
    this.waitKey = true;
    // A canvas can be transferred to a worker only once, so the worker (and its
    // canvas) live for the whole page; restarting just resets the decoder state.
    if (this.worker) {
      this.worker.postMessage({ id: 'clear' });
      this.showSurface('worker');
      return;
    }
    var canUseWorker = typeof global.Worker === 'function' && this.canvasWorker &&
      typeof this.canvasWorker.transferControlToOffscreen === 'function';
    if (canUseWorker) {
      try {
        var off = this.canvasWorker.transferControlToOffscreen();
        this.worker = new Worker('js/worker.js');
        this.worker.onmessage = function (ev) { self.onWorkerMessage(ev.data); };
        this.worker.onerror = function (e) { console.warn('worker', e && e.message); };
        this.worker.postMessage({ id: 'init', canvas: off }, [off]);
        this.showSurface('worker');
        return;
      } catch (e) {
        console.warn('worker path failed, decoding on main thread', e && e.message);
        this.worker = null;
      }
    }
    this.showSurface('canvas');
    this.ctx = this.ctx || this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.decoder = new VideoDecoder({
      output: function (frame) {
        if (frame.displayWidth !== self.canvas.width || frame.displayHeight !== self.canvas.height) {
          self.canvas.width = frame.displayWidth; self.canvas.height = frame.displayHeight;
          self.frameW = frame.displayWidth; self.frameH = frame.displayHeight;
          self.onMessage('size', self.frameW, self.frameH);
        }
        self.ctx.drawImage(frame, 0, 0);
        frame.close();
        self.stats.painted++;
      },
      error: function (e) { console.warn('decoder', e && e.message); self.waitKey = true; }
    });
    this.decoder.configure({ codec: 'avc1.64001f', optimizeForLatency: true });
  };

  VideoPresenter.prototype.onWorkerMessage = function (d) {
    if (!d) return;
    if (d.id === 'size') { this.frameW = d.w; this.frameH = d.h; this.onMessage('size', d.w, d.h); }
    else if (d.id === 'painted') { this.stats.painted += d.n || 1; this.stats.decodeMs += d.ms || 0; this.stats.decodeN += d.n || 1; }
    else if (d.id === 'sps') this.onKeyframeNeeded();
    else if (d.id === 'key') this.onMessage('key');
    else if (d.id === 'error') this.onMessage('error', d.message);
  };

  /** Feed one Annex-B access unit. */
  VideoPresenter.prototype.feedH264 = function (bytes) {
    this.stats.rx++; this.stats.bytes += bytes.byteLength;
    if (this.worker && this.mode === 'webcodecs') { this.worker.postMessage({ id: 'decode', data: bytes }, [bytes.buffer]); return; }
    if (!this.decoder) return;
    var nal = bytes[4] & 0x1f;
    if (this.waitKey) {
      if (nal !== 7 && nal !== 5) { this.onKeyframeNeeded(); return; }
      this.waitKey = false;
      this.onMessage('key');
    }
    try {
      var t0 = now();
      this.decoder.decode(new EncodedVideoChunk({ type: nal === 7 || nal === 5 ? 'key' : 'delta', timestamp: Math.round(t0 * 1000), data: bytes }));
      this.stats.decodeMs += now() - t0; this.stats.decodeN++;
    } catch (e) { console.warn('decode', e && e.message); this.waitKey = true; }
  };

  VideoPresenter.prototype.clear = function () {
    if (this.worker) this.worker.postMessage({ id: 'clear' });
    this.waitKey = true;
    if (this.ctx && this.canvas.width) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };

  VideoPresenter.prototype.stop = function () {
    if (this.abort) { try { this.abort.abort(); } catch (e) { /* ignore */ } this.abort = null; }
    if (this.img && this.mode === 'img') { this.img.removeAttribute('src'); }
    if (this.decoder) { try { this.decoder.close(); } catch (e) { /* ignore */ } this.decoder = null; }
    if (this.worker) { this.worker.postMessage({ id: 'clear' }); }
    if (this.bitmap) { this.bitmap.close(); this.bitmap = null; }
    this.pending = null; this.decoding = false;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.mode = 'idle';
    this.stats = this.resetStats();
  };

  /* --------------------------------------------------------------- mapping */

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
