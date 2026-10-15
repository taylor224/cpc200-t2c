/* WebSocket protocol client for the Carlinkit T2C "tsl" interface (lylinkui).
 *
 * Wire format (little endian):
 *   client -> server : Int16 header [length, type] followed by payload
 *     type 2  : hello   [w, h] + language\0 + navigator-string\0
 *     type 1  : touch   [m, x, y]    m: 0 down, 2 move, 1 up ; x,y in 0..1000
 *     type 3  : command [cmd]        see CMD below
 *     type 7  : setting [key, value] see KEY below
 *     type 8  : night   [n]          0 day / 1 night (forwarded to the iPhone)
 *     type 10 : car name (12 bytes) + icon id
 *     type 11 : session override [w, h] + u8 mm_w + u8 mm_h (0 width clears)
 *     type 12 : ping    Uint32 [0x000C0004, counter]
 *     type 13 : key     [key, mod]
 *     type 4/5/6/9 : string payload (bt connect / disconnect / forget / wifi psk)
 *   server -> client : Uint32 header [length, type] followed by payload
 *     (an access unit that cannot be reassembled is reported as 'videodrop' so the app can ask for a key frame)
 *     0   status JSON   1 init JSON   2 bt list changed   3 link JSON {link, phone}
 *     4   firmware status {val, pong}   5 reload   100 h264 access unit   101/102/103 fragments
 *     300 QR text
 */
(function (global) {
  'use strict';

  var CMD = { VIDEO: 0, AUTO_ON: 1, AUTO_OFF: 2, BTLIST: 5, DISCONNECT: 6, FACTORY_RESET: 7, KEYFRAME: 8, QR: 9 };
  var KEY = { NIGHT: 1, PIXEL: 2, DRIVER: 3, CHANNEL: 6, LANG: 7, BTNET: 8, FPS: 9, ONLINE: 10, MODE: 11 };

  // Seconds of missing pongs before the link is probed (status JSON carries the pong once a second).
  var PONG_LATE = 5;

  var encoder = global.TextEncoder ? new TextEncoder() : null;
  function utf8(str) {
    if (encoder) return encoder.encode(str);
    var r = [];
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); r.push(c < 128 ? c : 88); }
    return new Uint8Array(r);
  }

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/';
  }

  function LinkClient() {
    this.ws = null;
    this.open = false;
    this.handlers = {};
    this.ping = 0;
    this.pong = 0;
    this.stale = false;    // pong overdue, probe running
    this.timer = 0;
    this.reconnectTimer = 0;
    this.h264 = null;
    this.h264off = 0;
    this.decoder = new TextDecoder('utf-8');
    this.hello = null; // {w, h, lang, nav}
  }

  LinkClient.prototype.on = function (ev, fn) {
    (this.handlers[ev] = this.handlers[ev] || []).push(fn);
    return this;
  };

  LinkClient.prototype.emit = function (ev) {
    var args = Array.prototype.slice.call(arguments, 1);
    var hs = this.handlers[ev] || [];
    for (var i = 0; i < hs.length; i++) {
      try { hs[i].apply(null, args); } catch (e) { console.error('handler ' + ev, e); }
    }
  };

  LinkClient.prototype.connect = function (hello) {
    var self = this;
    this.hello = hello || this.hello;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    var ws = this.ws = new WebSocket(wsUrl(), 'tsl');
    ws.binaryType = 'arraybuffer';
    var openTimeout = setTimeout(function () { try { ws.close(); } catch (e) { /* ignore */ } }, 3000);

    ws.onopen = function () {
      clearTimeout(openTimeout);
      self.open = true;
      self.ping = 0; self.pong = 0; self.stale = false;
      self.sendHello();
      self.timer = setInterval(function () { self.tick(); }, 1000);
      self.emit('open');
    };
    ws.onmessage = function (ev) { self.onMessage(ev.data); };
    ws.onclose = function (ev) {
      clearTimeout(openTimeout);
      self.cleanup();
      self.emit('close', ev.code);
      self.scheduleReconnect();
    };
    ws.onerror = function () {
      clearTimeout(openTimeout);
      self.cleanup();
      self.emit('error');
      self.scheduleReconnect();
    };
  };

  LinkClient.prototype.cleanup = function () {
    this.open = false;
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
    this.h264 = null;
  };

  LinkClient.prototype.close = function () {
    this.suspended = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = 0; }
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.cleanup();
  };

  LinkClient.prototype.scheduleReconnect = function () {
    var self = this;
    if (this.suspended || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = 0;
      if (!document.hidden && !self.suspended) self.connect();
      else self.scheduleReconnect();
    }, 1000);
  };

  LinkClient.prototype.tick = function () {
    if (!this.open) return;
    if (this.pong + PONG_LATE < this.ping && !this.stale) { this.stale = true; this.checkStale(); }
    this.raw(new Uint32Array([0x000C0004, this.ping]));
    this.ping++;
  };

  /* Pings go unanswered. lylinkui answers only the client that connected last (it keeps a
   * single "current" connection), so if its HTTP side still responds and the pongs stay
   * missing, another page has taken over. Reconnecting would take the adapter back,
   * restart the CarPlay session and make the other page do the same a few seconds later,
   * so stay disconnected and let the app ask the user. If HTTP is dead too, the link is
   * gone: drop the socket and reconnect. */
  LinkClient.prototype.checkStale = function () {
    var self = this, ws = this.ws;
    function current() { return ws === self.ws && self.open; }
    function behind() { return self.pong + PONG_LATE < self.ping; }
    var ctl = global.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 2500);
    fetch('/js/boot.js', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok; }, function () { return false; })
      .then(function (alive) {
        clearTimeout(timer);
        if (!current()) return;
        if (!alive) {
          if (!behind()) { self.stale = false; return; }
          self.emit('pingtimeout');
          self.drop();
          return;
        }
        // The adapter is up; a server that was only stalled answers the queued pings now.
        setTimeout(function () {
          if (!current()) return;
          self.stale = false;
          if (behind()) { self.close(); self.emit('superseded'); }
        }, 2000);
      });
  };

  /** Abandon the socket without waiting for its closing handshake, then reconnect. */
  LinkClient.prototype.drop = function () {
    var ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) { /* ignore */ }
    }
    this.cleanup();
    this.emit('close');
    this.scheduleReconnect();
  };

  LinkClient.prototype.raw = function (buf) {
    if (!this.open) return false;
    try { this.ws.send(buf); return true; } catch (e) { return false; }
  };

  LinkClient.prototype.sendHello = function () {
    var h = this.hello || {};
    var lang = String(h.lang || navigator.language || 'en').substring(0, 10);
    var nav = String(h.nav || '').substring(0, 120);
    var l = utf8(lang), n = utf8(nav);
    var hdr = new Int16Array([l.length + n.length + 6, 2, h.w | 0, h.h | 0]);
    var out = new Uint8Array(4 + hdr[0]);
    out.set(new Uint8Array(hdr.buffer), 0);
    var i = 8;
    out.set(l, i); i += l.length; out[i++] = 0;
    out.set(n, i); i += n.length; out[i++] = 0;
    this.raw(out);
  };

  LinkClient.prototype.sendTouch = function (m, x, y) {
    this.raw(new Int16Array([6, 1, m, x, y]));
  };

  LinkClient.prototype.sendKey = function (k, m) {
    this.raw(new Int16Array([4, 13, k, m | 0]));
  };

  LinkClient.prototype.cmd = function (c) {
    return this.raw(new Int16Array([2, 3, c]));
  };

  LinkClient.prototype.setKey = function (key, value) {
    return this.raw(new Int16Array([4, 7, key, value]));
  };

  LinkClient.prototype.setNight = function (n) {
    return this.raw(new Int16Array([2, 8, n ? 1 : 0]));
  };

  LinkClient.prototype.sendString = function (type, str) {
    var b = utf8(str);
    var hdr = new Int16Array([b.length, type]);
    var out = new Uint8Array(4 + b.length);
    out.set(new Uint8Array(hdr.buffer), 0);
    out.set(b, 4);
    return this.raw(out);
  };

  LinkClient.prototype.btConnect = function (mac) { return this.sendString(4, mac); };
  LinkClient.prototype.btDisconnect = function (mac) { return this.sendString(5, mac); };
  LinkClient.prototype.btForget = function (mac) { return this.sendString(6, mac); };
  LinkClient.prototype.setWifiPassword = function (psk) { return this.sendString(9, psk); };

  /** Car name (max 12 UTF-8 bytes) and icon id (ascii). */
  LinkClient.prototype.setCarIdentity = function (name, icon) {
    icon = icon || '';
    var nb = utf8(name);
    while (nb.length > 12) { name = name.substring(0, name.length - 1); nb = utf8(name); }
    var hdr = new Int16Array([12 + icon.length, 10]);
    var out = new Uint8Array(4 + hdr[0]);
    out.set(new Uint8Array(hdr.buffer), 0);
    out.set(nb, 4);
    for (var i = 0; i < icon.length; i++) out[16 + i] = icon.charCodeAt(i) & 0xff;
    return this.raw(out);
  };

  /** Override the CarPlay session size. w=0 clears the override. mm values are u8. */
  LinkClient.prototype.setSessionOverride = function (w, h, mmw, mmh) {
    var hdr = new Int16Array([6, 11, w | 0, h | 0]);
    var out = new Uint8Array(10);
    out.set(new Uint8Array(hdr.buffer), 0);
    out[8] = Math.max(0, Math.min(255, mmw | 0));
    out[9] = Math.max(0, Math.min(255, mmh | 0));
    return this.raw(out);
  };

  LinkClient.prototype.onMessage = function (data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 8) return;
    // Views, not copies: at 8 Mbit/s of video a slice per frame is megabytes of garbage a second.
    var hdr = new Uint32Array(data, 0, 2);
    var len = hdr[0], type = hdr[1];
    if (len !== data.byteLength - 8) {
      console.warn('bad frame', len, data.byteLength);
      try { this.ws.close(); } catch (e) { /* ignore */ }
      return;
    }
    var payload = new Uint8Array(data, 8);
    switch (type) {
      case 0: { var j = this.json(payload); if (!j) return; this.pong = j.pong; this.emit('status', j); break; }
      case 1: { var j1 = this.json(payload); if (!j1) return; this.emit('init', j1); break; }
      case 2: this.emit('btlist'); break;
      case 3: { var j3 = this.json(payload); if (!j3) return; this.emit('link', j3); break; }
      case 4: { var j4 = this.json(payload); if (!j4) return; this.pong = j4.pong; this.emit('fw', j4); break; }
      case 5: this.emit('reload'); break;
      case 100: {
        if (payload.byteLength < 4) { this.emit('videodrop'); break; }
        var l = new DataView(data).getUint32(8, true);
        if (l + 4 !== payload.byteLength) { console.warn('h264 single len', l, payload.byteLength); this.emit('videodrop'); break; }
        this.emit('video', new Uint8Array(data, 12));
        break;
      }
      case 101: {
        if (payload.byteLength < 4) { this.h264 = null; this.emit('videodrop'); break; }
        var total = new DataView(data).getUint32(8, true);
        if (this.h264) this.emit('videodrop');           // previous access unit never completed
        if (total > 4000000) { console.warn('h264 first too big', total); this.h264 = null; this.emit('videodrop'); break; }
        this.h264 = new Uint8Array(total);
        this.h264off = payload.byteLength - 4;
        if (this.h264off > total) { this.h264 = null; this.emit('videodrop'); break; }
        this.h264.set(new Uint8Array(data, 12), 0);
        break;
      }
      case 102: {
        if (!this.h264) break;
        if (this.h264off + payload.byteLength > this.h264.byteLength) { this.h264 = null; this.emit('videodrop'); break; }
        this.h264.set(payload, this.h264off);
        this.h264off += payload.byteLength;
        break;
      }
      case 103: {
        if (!this.h264) break;
        if (this.h264off + payload.byteLength > this.h264.byteLength) { this.h264 = null; this.emit('videodrop'); break; }
        this.h264.set(payload, this.h264off);
        this.h264off += payload.byteLength;
        var frame = this.h264; this.h264 = null;
        this.emit('video', frame);
        break;
      }
      case 300: this.emit('qr', this.decoder.decode(payload)); break;
      default: console.warn('unknown ws type', type); break;
    }
  };

  LinkClient.prototype.json = function (buf) {
    try { return JSON.parse(this.decoder.decode(buf)); } catch (e) { console.warn('bad json', e); return null; }
  };

  global.LinkClient = LinkClient;
  global.LinkClient.CMD = CMD;
  global.LinkClient.KEY = KEY;
})(window);
