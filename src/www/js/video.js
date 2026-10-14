/* Video presenter for the CarPlay picture (MJPEG only).
 *
 * GET /video.jpg is a multipart/x-mixed-replace stream of JPEG frames produced by the
 * adapter's hardware encoder. It is consumed with a streaming fetch reader, each
 * frame is decoded off the main thread with createImageBitmap and painted on a 2D
 * canvas as soon as the bitmap is ready. Only the newest frame is ever decoded:
 * anything that arrives while a decode is in flight replaces the pending frame, so
 * latency never accumulates and the TCP stream never stalls the adapter.
 *
 * The canvas backing store always has the frame's own size; CSS object-fit does the
 * scaling on the GPU. Touch coordinates are mapped back through the same fit rule.
 * Browsers without streaming fetch / createImageBitmap fall back to a plain <img>.
 */
(function (global) {
  'use strict';

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  function VideoPresenter(opts) {
    this.canvas = opts.canvas;
    this.img = opts.img;
    this.statsEl = opts.statsEl;
    this.onMessage = opts.onMessage || function () {};
    this.fit = opts.fit || 'contain';
    this.mode = 'idle';           // 'mjpeg' | 'img' | 'idle'
    this.surface = 'canvas';
    this.frameW = 0; this.frameH = 0;
    this.ctx = null;
    this.abort = null;
    this.pending = null;          // newest undecoded JPEG bytes
    this.decoding = false;
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
    if (this.canvas) this.canvas.classList.toggle('hidden', which !== 'canvas');
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
    function findSOI(u8) { // FF D8 = start of JPEG
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
              if (buf.length > 65536) buf = new Uint8Array(0); // garbage guard
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

  /** Paint immediately: with a desynchronized context this reaches the display without
   *  waiting for the next animation frame, which saves up to one frame interval. */
  VideoPresenter.prototype.paint = function (bmp) {
    if (!this.ctx || this.mode !== 'mjpeg') { bmp.close(); return; }
    if (bmp.width !== this.canvas.width || bmp.height !== this.canvas.height) {
      this.canvas.width = bmp.width; this.canvas.height = bmp.height;
      this.frameW = bmp.width; this.frameH = bmp.height;
      this.onMessage('size', bmp.width, bmp.height);
    }
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();
    this.stats.painted++;
  };

  VideoPresenter.prototype.clear = function () {
    if (this.ctx && this.canvas.width) {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  };

  VideoPresenter.prototype.stop = function () {
    if (this.abort) { try { this.abort.abort(); } catch (e) { /* ignore */ } this.abort = null; }
    if (this.img && this.mode === 'img') { this.img.removeAttribute('src'); }
    this.pending = null; this.decoding = false;
    this.mode = 'idle';
    this.stats = this.resetStats();
  };

  /* --------------------------------------------------------------- mapping */

  /** Map a client point to CarPlay per-mille coordinates honouring object-fit. */
  VideoPresenter.prototype.toPerMille = function (clientX, clientY) {
    var el = this.surface === 'img' ? this.img : this.canvas;
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
