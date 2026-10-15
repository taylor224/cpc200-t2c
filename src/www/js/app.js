/* Application controller for the T2C Tesla web UI. */
(function () {
  'use strict';

  var CONFIG = {
    // Firmware update server. The final location is not decided yet; override at
    // runtime with ?test=<url> in the page URL or the "Update server" field on the
    // About page (stored in localStorage key t2c.updateUrl).
    UPDATE_BASE_URL: 'https://cpbox.oss-cn-shenzhen.aliyuncs.com',
    // CarPlay session size limits (the adapter's own "HD" preset is 1376x1072).
    MAX_SESSION_AREA: 1376 * 1072,
    MAX_W: 1920,
    MAX_H: 1200,
    // CarPlay derives its UI scale from pixels-per-millimetre of the reported screen.
    PX_PER_MM: { small: 6.4, normal: 5.2, large: 4.2 },
    RESIZE_RELOAD_PX: 48
  };

  var CMD = LinkClient.CMD, KEY = LinkClient.KEY;
  var t = I18N.t;

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('t2c.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('t2c.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  var session = {
    get: function (k) { try { return sessionStorage.getItem('t2c.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem('t2c.' + k, v); } catch (e) { /* ignore */ } }
  };

  var prefs = {
    theme: store.get('theme', 'auto'),
    res: store.get('res', 'balanced'),
    uiScale: store.get('uiScale', 'normal'),
    fit: store.get('fit', 'contain'),
    stats: store.get('stats', false),
    transport: store.get('transport', 'auto'),
    updateUrl: store.get('updateUrl', '')
  };

  var state = {
    init: null, link: -1, phone: false, linking: false, page: 'home',
    night: 0, isNight: 2, nightTimer: 0,
    channel: -1, chtmp: 255,
    icon: '', icons: {}, lyver: '',
    btconn: null, btdelay: null, btdel: null,
    pixel: 3, vid: false,
    updating: false, updateUrl: null,
    hasCell: true
  };

  var link = new LinkClient();
  var presenter = null;

  /* ------------------------------------------------------------- helpers */

  function getTesla() {
    var u = navigator.userAgent, i = u.indexOf('Tesla');
    return i >= 0 ? u.substring(i) : 'null';
  }

  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.add('hidden'); }, ms || 2500);
  }

  function dialog(opts) {
    var box = $('dialog-box'), back = $('dialog');
    box.innerHTML = '';
    var body = document.createElement('div'); body.className = 'dialog-body';
    if (opts.title) { var h = document.createElement('div'); h.className = 'dialog-title'; h.textContent = opts.title; body.appendChild(h); }
    if (opts.text) { var p = document.createElement('div'); p.className = 'dialog-text'; p.textContent = opts.text; body.appendChild(p); }
    if (opts.content) body.appendChild(opts.content);
    box.appendChild(body);
    var actions = document.createElement('div'); actions.className = 'dialog-actions';
    (opts.buttons || [{ label: t('dlg.ok') }]).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn ' + (b.primary ? 'btn-primary' : b.danger ? 'btn-danger' : 'btn-secondary');
      btn.textContent = b.label;
      btn.onclick = function () { if (!b.keep) closeDialog(); if (b.onClick) b.onClick(); };
      actions.appendChild(btn);
    });
    box.appendChild(actions);
    back.classList.remove('hidden');
    return box;
  }
  function closeDialog() { $('dialog').classList.add('hidden'); }

  function confirmReload(text) {
    dialog({ text: text, buttons: [{ label: t('dlg.cancel') }, { label: t('dlg.reload'), primary: true, onClick: reload }] });
  }
  function reload() { location.reload(); }

  function requireLink() {
    if (link.open) return true;
    confirmReload(t('about.ws_lost'));
    return false;
  }

  function segSet(id, value) {
    qsa('#' + id + ' button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === String(value)); });
  }
  function segBind(id, fn) {
    qsa('#' + id + ' button').forEach(function (b) {
      b.onclick = function () {
        if (b.classList.contains('on')) return;
        var v = b.getAttribute('data-v');
        if (fn(v) !== false) segSet(id, v);
      };
    });
  }

  /* --------------------------------------------------------------- theme */

  function applyTheme() {
    var dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && isNightNow());
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  /* Night mode: value 0..2 schedule, +3 when night mode switch is on (device semantics). */
  function isNightNow() {
    var n = state.night;
    if (n > 2) return true;
    var h = new Date().getHours();
    if (n === 1) return h < 6 || h > 17;
    if (n === 2) return h < 7 || h > 18;
    return false;
  }

  function updateNight(h) {
    var n = 2, s = state.night;
    if (s === 0) n = 0;
    else if (s === 1) n = (h < 6 || h > 17) ? 1 : 0;
    else if (s === 2) n = (h < 7 || h > 18) ? 1 : 0;
    if (n !== state.isNight && n < 2) { state.isNight = n; link.setNight(n); }
    applyTheme();
  }

  function scheduleNightTick() {
    clearTimeout(state.nightTimer);
    var d = new Date();
    var secs = 3600 - d.getMinutes() * 60 - d.getSeconds() + 1;
    updateNight(d.getHours());
    state.nightTimer = setTimeout(function tick() {
      updateNight(new Date().getHours());
      state.nightTimer = setTimeout(tick, 3600000);
    }, secs * 1000);
  }

  /* --------------------------------------------------------- navigation */

  function showPage(name) {
    state.page = name;
    qsa('.nav-item').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-page') === name); });
    qsa('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + name); });
    $('main').scrollTop = 0;
    if (name === 'devices') updateBtList();
    if (name === 'home' || name === 'devices') renderConnecting();
  }

  function showStage(on) {
    $('stage').classList.toggle('hidden', !on);
    $('app').classList.toggle('hidden', on);
  }

  /* -------------------------------------------------------------- video */

  function startVideo() {
    showStage(true);
    $('stage-msg').classList.add('hidden');
    if (state.vid) presenter.startH264();
    else presenter.start('/video.jpg');
  }

  /* ------------------------------------------------------- transport */

  var H264_SLOW_TTL = 7 * 86400 * 1000;   // remember a too-slow verdict for a week

  function wantVideo() {
    if (!VideoPresenter.canH264()) return false;
    if (prefs.transport === 'video') return true;
    if (prefs.transport === 'picture') return false;
    var slow = store.get('h264slow', 0);
    return !(slow && Date.now() - slow < H264_SLOW_TTL);
  }

  /** Put the adapter in the transport mode we can render; restart the session when needed. */
  function applyTransport(userAction) {
    var want = wantVideo();
    if (!link.open) { state.vid = want; return; }
    if (state.vid !== want) {
      link.setKey(KEY.MODE, want ? 1 : 0);
      state.vid = want;
      // The adapter picks the pipeline when the iPhone's video starts, so an active
      // session has to be restarted: reloading in Auto picture-size mode does that.
      if (state.link >= 1 || userAction) { session.set('modeSig', want ? '1' : '0'); setTimeout(reload, 400); }
    }
  }

  function h264Failed(reason) {
    console.warn('h264 fallback:', reason);
    store.set('h264slow', Date.now());
    toast(t(reason === 'slow' ? 'video.slow' : 'video.unsupported'), 5000);
    if (prefs.transport === 'video') { prefs.transport = 'auto'; store.set('transport', 'auto'); segSet('seg-mode', 'auto'); }
    applyTransport(true);
  }

  function stopVideo() {
    presenter.stop();
    presenter.clear();
    showStage(false);
  }

  function switchVideo(newLink) {
    if (newLink === state.link) return;
    console.log('link ' + state.link + ' -> ' + newLink);
    var prev = state.link;
    state.link = newLink;
    try {
      if (newLink > 1) {
        link.cmd(CMD.VIDEO);
        startVideo();
      } else {
        if (prev > 1) stopVideo();
        if (newLink === 0) presenter.clear();
      }
    } catch (e) { console.error('video switch', e); }
    if (newLink < 1 && state.linking && prev > 0) setLinking(false);
    renderHomeStatus();
  }

  function setLinking(v) {
    state.linking = v;
    renderConnecting();
    renderHomeStatus();
  }

  function renderConnecting() {
    $('dev-connecting').classList.toggle('hidden', !state.linking);
  }

  function renderHomeStatus() {
    var txt = $('home-status-text'), dot = $('home-dot'), spin = $('home-spinner');
    var open = $('btn-open-carplay'), steps = $('home-steps');
    spin.classList.add('hidden'); dot.classList.remove('hidden', 'on', 'ok');
    open.hidden = true; steps.classList.remove('hidden');
    if (state.link > 1) {
      txt.textContent = t('home.connected'); dot.classList.add('ok'); open.hidden = false; steps.classList.add('hidden');
    } else if (state.link === 1) {
      txt.textContent = t('home.starting'); spin.classList.remove('hidden'); dot.classList.add('hidden'); open.hidden = false; steps.classList.add('hidden');
    } else if (state.linking) {
      txt.textContent = t('home.connecting'); spin.classList.remove('hidden'); dot.classList.add('hidden');
    } else {
      txt.textContent = t('home.waiting');
    }
  }

  /* ------------------------------------------------- CarPlay session size */

  function computeSession() {
    var dpr = window.devicePixelRatio || 1;
    var vw = window.innerWidth, vh = window.innerHeight;
    var s;
    switch (prefs.res) {
      case 'sharp': s = dpr; break;
      case 'saver': s = 0.75; break;
      case 'low': s = 0.6; break;
      case 'device': return null;
      default: s = 1;
    }
    var w = vw * s, h = vh * s;
    var area = w * h;
    if (area > CONFIG.MAX_SESSION_AREA) { var k = Math.sqrt(CONFIG.MAX_SESSION_AREA / area); w *= k; h *= k; }
    if (w > CONFIG.MAX_W) { h = h * CONFIG.MAX_W / w; w = CONFIG.MAX_W; }
    if (h > CONFIG.MAX_H) { w = w * CONFIG.MAX_H / h; h = CONFIG.MAX_H; }
    w = Math.max(320, Math.round(w / 16) * 16);
    h = Math.max(240, Math.round(h / 16) * 16);
    var ppm = CONFIG.PX_PER_MM[prefs.uiScale] || CONFIG.PX_PER_MM.normal;
    var mmw = w / ppm, mmh = h / ppm;
    if (mmw > 255 || mmh > 255) { var k2 = 255 / Math.max(mmw, mmh); mmw *= k2; mmh *= k2; }
    return { w: w, h: h, mmw: Math.round(mmw), mmh: Math.round(mmh) };
  }

  function sessionSignature(ss) {
    return ss ? [ss.w, ss.h, ss.mmw, ss.mmh].join('x') : 'device' + state.pixel;
  }

  /** Push the session override to the adapter and make sure it takes effect. */
  function applySession(userAction) {
    var ss = computeSession();
    var sig = sessionSignature(ss);
    $('session-info').textContent = ss ? (ss.w + ' × ' + ss.h + ' · ' + ss.mmw + ' × ' + ss.mmh + ' mm') : t('disp.res_device');
    $('row-pixel').classList.toggle('hidden', !!ss);
    $('row-uiscale').classList.toggle('hidden', !ss);
    if (!link.open) return;
    if (ss) {
      link.setSessionOverride(ss.w, ss.h, ss.mmw, ss.mmh);
      if (state.pixel !== 3) {
        // Switching the adapter to "Auto" restarts the CarPlay session with the override.
        link.setKey(KEY.PIXEL, 3); state.pixel = 3; segSet('seg-pixel', 3);
        session.set('sess', sig);
      } else if (session.get('sess') !== sig) {
        session.set('sess', sig);
        // The adapter restarts the session when this page (re)connects in Auto mode,
        // but the first connection of this load happened before the override arrived.
        if (state.link >= 1 || userAction) setTimeout(reload, 400);
      }
    } else {
      link.setSessionOverride(0, 0, 0, 0);
      session.set('sess', sig);
      if (userAction && state.link >= 1) setTimeout(reload, 400);
    }
  }

  /* --------------------------------------------------------- bluetooth */

  function btChanged(mac) {
    if (mac) {
      if (mac !== state.btconn) {
        state.btconn = mac;
        if (state.btdelay === mac) state.btdelay = null;
        if (state.page === 'devices') updateBtList();
      }
    } else if (state.btconn) {
      state.btconn = null;
      if (state.page === 'devices') updateBtList();
      if (state.btdelay) btConnect(state.btdelay);
      if (state.btdel) btForget(state.btdel);
    }
  }

  function btConnect(mac) {
    if (!state.btconn) link.btConnect(mac);
    else if (state.btconn !== mac) { state.btdelay = mac; link.btDisconnect(mac === state.btconn ? mac : state.btconn); }
    else state.btdelay = null;
  }
  function btDisconnect(mac) { if (state.btconn === mac) link.btDisconnect(mac); }
  function btForget(mac) {
    if (state.btconn === mac) { state.btdel = mac; link.btDisconnect(mac); }
    else { state.btdel = null; link.btForget(mac); setTimeout(updateBtList, 300); }
  }

  function updateBtList() {
    fetch('/tsl/bt', { cache: 'no-store' }).then(function (r) {
      if (r.status !== 200) throw new Error(r.statusText);
      return r.json();
    }).then(function (list) {
      var el = $('btlist'); el.innerHTML = '';
      if (!list || !list.length) {
        var e = document.createElement('div'); e.className = 'dev-empty'; e.textContent = t('dev.none'); el.appendChild(e); return;
      }
      list.forEach(function (entry) {
        var mac = entry.substr(1, 12), name = entry.substr(13) || mac;
        var row = document.createElement('div'); row.className = 'dev-item'; row.id = 'bt-' + mac;
        var nm = document.createElement('div'); nm.className = 'dev-name';
        var sp = document.createElement('span'); sp.textContent = name; nm.appendChild(sp);
        var isConn = state.btconn === mac;
        if (isConn) { var tag = document.createElement('span'); tag.className = 'dev-tag'; tag.textContent = t('dev.connected'); nm.appendChild(tag); }
        var act = document.createElement('div'); act.className = 'dev-actions';
        var b1 = document.createElement('button'); b1.className = 'btn btn-sm ' + (isConn ? 'btn-secondary' : 'btn-primary');
        b1.textContent = isConn ? t('dev.disconnect') : t('dev.connect');
        b1.onclick = function () { if (!requireLink()) return; isConn ? btDisconnect(mac) : btConnect(mac); };
        var b2 = document.createElement('button'); b2.className = 'btn btn-sm btn-secondary'; b2.textContent = t('dev.forget');
        b2.onclick = function () { if (!requireLink()) return; btForget(mac); };
        act.appendChild(b1); act.appendChild(b2);
        row.appendChild(nm); row.appendChild(act); el.appendChild(row);
      });
    }).catch(function (e) { console.warn('btlist', e && e.message); });
  }

  /* ---------------------------------------------------------- cellular */

  function parseHw(j) {
    var hw = (j.HW || '').split('-'), md = (j.MD || '').split('-');
    if (hw.length > 1 && md.length > 1) {
      var v = hw[hw.length - 2].split('_');
      $('imei').textContent = j.imei || ''; $('iccid').textContent = j.ccid || '';
      return [md[0], hw[1], v[v.length - 1], hw[hw.length - 1], md[1]].join('-');
    }
    state.hasCell = false;
    $('nav-cellular').classList.add('hidden');
    $('row-btnet').classList.add('hidden');
    return [md[0], 'BT', 'PanNet', md[1]].join('-');
  }

  function updateCell(j) {
    if (!state.hasCell) return;
    var apn = $('cell-apn');
    apn.textContent = (j.apn && j.apn.length) ? j.apn : t('cell.na');
    $('cell-dial').textContent = j.csq === 0 ? t('cell.not_connected') : t('cell.connected');
    var lvl = Math.max(0, Math.min(5, j.sig | 0));
    $('cell-bars').setAttribute('data-level', String(lvl));
    $('cell-csq').textContent = j.csq !== undefined ? ('CSQ ' + j.csq) : '';
  }

  /* ---------------------------------------------------------- wi-fi */

  function channelLabel(ch) {
    if (ch === 0) return t('wifi.band24') + ' · ' + t('wifi.auto');
    if (ch === 255) return t('wifi.band5') + ' · ' + t('wifi.auto');
    return (ch < 15 ? t('wifi.band24') : t('wifi.band5')) + ' · ' + ch;
  }

  function channelDialog() {
    if (!requireLink()) return;
    var band = state.channel < 15 ? 24 : 5;
    var chosen = state.channel;
    var content = document.createElement('div');
    var seg = document.createElement('div'); seg.className = 'seg';
    var list = document.createElement('div'); list.className = 'chlist';
    function renderList() {
      list.innerHTML = '';
      var chans = band === 24 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [255, 36, 40, 44, 48, 149, 153, 157, 161, 165];
      chans.forEach(function (c) {
        var b = document.createElement('button');
        b.textContent = (c === 0 || c === 255) ? t('wifi.auto') : String(c);
        b.classList.toggle('on', c === chosen);
        b.onclick = function () { chosen = c; renderList(); };
        list.appendChild(b);
      });
    }
    [[24, 'wifi.band24'], [5, 'wifi.band5']].forEach(function (pair) {
      var b = document.createElement('button'); b.textContent = t(pair[1]); b.classList.toggle('on', band === pair[0]);
      b.onclick = function () { band = pair[0]; chosen = band === 24 ? 0 : 255; qsa('button', seg).forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); renderList(); };
      seg.appendChild(b);
    });
    renderList();
    content.appendChild(seg); content.appendChild(list);
    dialog({
      title: t('wifi.channel'), content: content,
      buttons: [{ label: t('dlg.cancel') }, { label: t('dlg.save'), primary: true, onClick: function () {
        if (chosen !== state.channel) {
          state.channel = chosen; $('wifi-ch').textContent = channelLabel(chosen);
          link.setKey(KEY.CHANNEL, chosen);
          toast(t('wifi.channel_hint'));
          link.close(); setTimeout(reload, 4000);
        }
      } }]
    });
  }

  function passwordDialog() {
    if (!requireLink()) return;
    var content = document.createElement('div');
    var input = document.createElement('input'); input.className = 'field'; input.type = 'text'; input.maxLength = 12;
    input.placeholder = t('wifi.pw_new');
    var rule = document.createElement('p'); rule.className = 'muted small'; rule.style.marginTop = '0.5rem'; rule.textContent = t('wifi.pw_rule');
    content.appendChild(input); content.appendChild(rule);
    input.addEventListener('input', function () { input.value = input.value.replace(/[^A-Za-z0-9_]/g, ''); });
    dialog({
      title: t('wifi.pw_title'), text: t('wifi.pw_warn'), content: content,
      buttons: [{ label: t('dlg.cancel') }, { label: t('dlg.save'), primary: true, keep: true, onClick: function () {
        var v = input.value;
        if (v.length < 8) { input.focus(); return; }
        if (link.setWifiPassword(v)) {
          link.close();
          dialog({ text: t('wifi.pw_changed') + '\n' + v, buttons: [{ label: t('dlg.ok'), primary: true, onClick: reload }] });
        }
      } }]
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  /* ------------------------------------------------------- car identity */

  var identityTimer = 0;
  function scheduleIdentity() {
    clearTimeout(identityTimer);
    identityTimer = setTimeout(sendIdentity, 1500);
  }
  function sendIdentity() {
    var nameEl = $('car-name');
    var name = nameEl.value || nameEl.placeholder || 'Auto';
    link.setCarIdentity(name, state.icon);
  }

  function renderIcons() {
    var grid = $('icon-grid'); grid.innerHTML = '';
    Object.keys(state.icons).forEach(function (id) {
      var img = document.createElement('img');
      img.src = 'icon/' + id + '.png'; img.alt = state.icons[id]; img.title = state.icons[id];
      img.classList.toggle('on', state.icon === id);
      img.onclick = function () {
        if (!requireLink()) return;
        state.icon = id; qsa('img', grid).forEach(function (x) { x.classList.remove('on'); }); img.classList.add('on');
        $('car-name').placeholder = state.icons[id];
        $('tesla-tm').classList.toggle('hidden', !/tesla/i.test(state.icons[id]));
        scheduleIdentity();
      };
      grid.appendChild(img);
    });
    var custom = state.icon && state.icons[state.icon];
    segSet('seg-icon', custom ? 1 : 0);
    grid.classList.toggle('hidden', !custom);
    $('tesla-tm').classList.toggle('hidden', !(custom && /tesla/i.test(state.icons[state.icon])));
    $('car-name').placeholder = custom ? state.icons[state.icon] : 'Auto';
  }

  /* ---------------------------------------------------- firmware update */

  function updateBase() {
    var m = /[?&]test=([^#&]+)/.exec(location.href);
    if (m) return decodeURIComponent(m[1]).replace(/\/+$/, '');
    if (prefs.updateUrl) return prefs.updateUrl.replace(/\/+$/, '');
    return CONFIG.UPDATE_BASE_URL;
  }

  function checkUpdate() {
    if (!requireLink()) return;
    var btn = $('btn-update'); btn.disabled = true;
    fetch(updateBase() + '/' + state.lyver + '/version.json?rand=' + Math.random(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var cur = state.init ? state.init.SW : '';
        if (j.tsl && j.tsl > cur) {
          state.updateUrl = j.url;
          dialog({ title: t('about.new_version'), text: (j.tsl || '') + '\n' + (j.msg || ''),
            buttons: [{ label: t('dlg.cancel') }, { label: t('dlg.ok'), primary: true, onClick: startUpdate }] });
        } else {
          dialog({ text: t('about.latest') });
        }
      })
      .catch(function () { dialog({ text: t('about.update_fail') }); })
      .then(function () { btn.disabled = false; });
  }

  var progressBar = null, progressText = null;
  function setPct(p, label) {
    if (progressBar) progressBar.style.width = Math.max(0, Math.min(100, p)) + '%';
    if (progressText) progressText.textContent = (label ? label + ' · ' : '') + Math.floor(p) + '%';
  }

  function startUpdate() {
    state.updating = true;
    var content = document.createElement('div');
    progressText = document.createElement('div'); progressText.className = 'dialog-text';
    var bar = document.createElement('div'); bar.className = 'progress'; progressBar = document.createElement('i'); bar.appendChild(progressBar);
    var keep = document.createElement('p'); keep.className = 'muted small'; keep.style.marginTop = '0.75rem'; keep.textContent = t('about.keep_power');
    content.appendChild(progressText); content.appendChild(bar); content.appendChild(keep);
    dialog({ title: t('about.update'), content: content, buttons: [] });
    setPct(0, t('about.downloading'));
    downloadFirmware(state.updateUrl).then(uploadFirmware).catch(function (e) { console.warn(e); updateFailed(); });
  }

  function downloadFirmware(url) {
    return fetch(url + '?rand=' + Math.random()).then(function (r) {
      if (!r.ok || !r.body) throw new Error('download ' + r.status);
      var total = +r.headers.get('Content-Length') || 0;
      var reader = r.body.getReader(), chunks = [], loaded = 0;
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return;
          chunks.push(res.value); loaded += res.value.length;
          if (total) setPct(loaded * 70 / total, t('about.downloading'));
          return pump();
        });
      }
      return pump().then(function () {
        var out = new Uint8Array(loaded), off = 0;
        chunks.forEach(function (c) { out.set(c, off); off += c.length; });
        return out;
      });
    });
  }

  function uploadFirmware(bytes) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', function (e) { if (e.total) setPct(70 + e.loaded * 9 / e.total, t('about.installing')); });
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200) { setPct(80, t('about.installing')); state.link = 3; resolve(); }
        else reject(new Error('upload ' + xhr.status));
      };
      xhr.open('POST', '/tsl/fw');
      xhr.send(new Blob([bytes]));
    });
  }

  function updateFailed() {
    state.updating = false;
    dialog({ text: t('about.update_fail') });
  }

  function onFwStatus(j) {
    if (j.val > 0 && j.val < 3) {
      state.link++;
      if (state.link < 115) setPct(state.link / 6 + 80, t('about.installing'));
    } else if (j.val === 3) {
      state.updating = false;
      dialog({ text: t('about.update_ok'), buttons: [{ label: t('dlg.ok'), primary: true, onClick: reload }] });
      $('about-sw').textContent = '';
      state.link = 0;
    }
  }

  /* ---------------------------------------------------------- init JSON */

  function onInit(j) {
    state.init = j;
    state.lyver = (j.LY || '').split('.')[1] || '';
    state.channel = j.ch; state.chtmp = j.sh;
    state.pixel = j.pixel;
    state.icon = j.icon || ''; state.icons = j.icons || {};
    state.night = j.night;

    // language: server index is only a hint
    if (I18N.isAuto()) { I18N.init(j.lan); }
    renderLanguages();

    ['home-bt', 'dev-bt', 'bt-name'].forEach(function (id) { $(id).textContent = j.bt || ''; });
    $('wifi-ssid').textContent = j.ssid || '';
    $('wifi-psk').value = j.psk || '';
    $('wifi-ch').textContent = channelLabel(j.ch);
    $('auto').checked = !!j.auto;
    $('night').checked = j.night > 2;
    segSet('seg-night', j.night > 2 ? j.night - 3 : j.night);
    $('online').checked = !!j.online;
    $('btnet').checked = !!j.btnet;
    segSet('seg-pixel', j.pixel);
    segSet('seg-driver', j.driver);
    segSet('seg-fps', j.fps);
    $('car-name').value = j.name || '';
    renderIcons();
    $('about-model').textContent = j.SN || '';
    $('about-fw').textContent = j.SW || '';
    $('about-sw').textContent = j.SW || '';
    $('hw-short').textContent = parseHw(j);
    $('hw-full').textContent = j.HW || '';
    $('about-uuid').textContent = j.wifi || '';
    $('home-foot').textContent = (j.ssid ? j.ssid + ' · ' : '') + (j.SW || '');
    if (/test/.test(j.SW || '')) $('row-update').classList.add('hidden');
    $('backlist').classList.toggle('hidden', j.bl !== 1);

    scheduleNightTick();
    applyTheme();

    state.vid = !!j.vid;
    applyTransport(false);

    applySession(false);
    switchVideo(j.link);
    setLinking(!!j.phone && j.link < 1);
    if (j.link === 1) link.cmd(CMD.VIDEO);
  }

  function onLinkMsg(j) {
    // The adapter can push {link,phone} before the init JSON; the transport (MJPEG vs
    // H.264) is only known after init, which calls switchVideo(j.link) itself.
    if (!state.init) { state.phone = !!j.phone; return; }
    if (state.linking) {
      if (j.link > 0 || !j.phone) setLinking(false);
    } else if (j.phone && j.link < 1) {
      setLinking(true);
    }
    switchVideo(j.link);
  }

  /* ------------------------------------------------------- language UI */

  function renderLanguages() {
    var el = $('lang-list'); el.innerHTML = '';
    var auto = document.createElement('button'); auto.textContent = t('lang.auto') + ' · ' + I18N.NAMES[I18N.detect()];
    auto.classList.toggle('on', I18N.isAuto());
    auto.onclick = function () { I18N.setAuto(); if (link.open) link.setKey(KEY.LANG, 3); afterLanguageChange(); };
    el.appendChild(auto);
    I18N.LANGS.forEach(function (tag) {
      var b = document.createElement('button'); b.textContent = I18N.NAMES[tag];
      b.classList.toggle('on', !I18N.isAuto() && I18N.current === tag);
      b.onclick = function () { I18N.set(tag); if (link.open) link.setKey(KEY.LANG, I18N.toServerIndex(tag)); afterLanguageChange(); };
      el.appendChild(b);
    });
  }
  function afterLanguageChange() {
    renderLanguages(); renderHomeStatus();
    $('wifi-ch').textContent = channelLabel(state.channel);
    if (state.page === 'devices') updateBtList();
    applySession(false);
    if (state.init) updateCell({ apn: state.lastApn, csq: state.lastCsq, sig: state.lastSig });
  }

  /* -------------------------------------------------------------- touch */

  function bindTouch() {
    var stage = $('stage');
    var down = false, pendingMove = null, raf = 0;
    function flushMove() {
      raf = 0;
      if (pendingMove) { link.sendTouch(2, pendingMove.x, pendingMove.y); pendingMove = null; }
    }
    function pos(e) { return presenter.toPerMille(e.clientX, e.clientY); }
    if (window.PointerEvent) {
      stage.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.stage-settings')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        var p = pos(e); if (!p) return;
        down = true; pendingMove = null;
        try { stage.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
        link.sendTouch(0, p.x, p.y);
        e.preventDefault();
      });
      stage.addEventListener('pointermove', function (e) {
        if (!down) return;
        var p = pos(e); if (!p) return;
        pendingMove = p;
        if (!raf) raf = requestAnimationFrame(flushMove);
      });
      function up(e) {
        if (!down) return;
        down = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; pendingMove = null; }
        var p = pos(e); if (p) link.sendTouch(1, p.x, p.y);
      }
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    } else {
      stage.addEventListener('touchstart', function (e) {
        if (e.target.closest('.stage-settings')) return;
        var p = pos(e.touches[0]); if (!p) return; down = true; link.sendTouch(0, p.x, p.y); e.preventDefault();
      }, { passive: false });
      stage.addEventListener('touchmove', function (e) {
        if (!down) return; var p = pos(e.touches[0]); if (!p) return; pendingMove = p; if (!raf) raf = requestAnimationFrame(flushMove);
      }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        if (!down) return; down = false; var p = pos(e.changedTouches[0]); if (p) link.sendTouch(1, p.x, p.y);
      });
      stage.addEventListener('mousedown', function (e) { var p = pos(e); if (!p) return; down = true; link.sendTouch(0, p.x, p.y); });
      stage.addEventListener('mousemove', function (e) { if (!down) return; var p = pos(e); if (p) { pendingMove = p; if (!raf) raf = requestAnimationFrame(flushMove); } });
      stage.addEventListener('mouseup', function (e) { if (!down) return; down = false; var p = pos(e); if (p) link.sendTouch(1, p.x, p.y); });
    }
    stage.addEventListener('dragstart', function (e) { e.preventDefault(); });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ------------------------------------------------------------ bindings */

  function bindUI() {
    qsa('.nav-item').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); showPage(a.getAttribute('data-page')); });
    });
    $('btn-reload').onclick = reload;
    $('btn-stage-settings').onclick = function () {
      // Leave the picture, keep the CarPlay session; "Open CarPlay" brings it back.
      presenter.stop(); showStage(false); showPage('home');
      state.link = Math.min(state.link, 1); renderHomeStatus();
    };
    $('btn-open-carplay').onclick = function () { if (requireLink()) { state.link = Math.min(state.link, 1); link.cmd(CMD.VIDEO); } };
    $('btn-qr').onclick = function () {
      var card = $('qr-card');
      if (!card.classList.contains('hidden')) { card.classList.add('hidden'); $('btn-qr').textContent = t('home.show_qr'); return; }
      if (!requireLink()) return;
      $('qr').innerHTML = ''; card.classList.remove('hidden'); $('btn-qr').textContent = t('home.hide_qr');
      link.cmd(CMD.QR);
    };

    $('auto').onchange = function () { if (!requireLink()) { this.checked = !this.checked; return; } link.cmd(this.checked ? CMD.AUTO_ON : CMD.AUTO_OFF); };
    $('night').onchange = function () {
      if (!requireLink()) { this.checked = !this.checked; return; }
      state.night = this.checked ? (state.night % 3) + 3 : state.night % 3;
      if (state.night > 2 || state.night === 0) { state.isNight = state.night > 2 ? 1 : 0; link.setNight(state.night > 2); }
      link.setKey(KEY.NIGHT, state.night);
      scheduleNightTick();
    };
    segBind('seg-night', function (v) {
      if (!requireLink()) return false;
      state.night = (state.night > 2 ? 3 : 0) + (+v);
      link.setKey(KEY.NIGHT, state.night);
      state.isNight = 2; scheduleNightTick();
    });
    segBind('seg-theme', function (v) { prefs.theme = v; store.set('theme', v); applyTheme(); });
    segBind('seg-res', function (v) { prefs.res = v; store.set('res', v); applySession(true); });
    segBind('seg-pixel', function (v) {
      if (!requireLink()) return false;
      state.pixel = +v; link.setKey(KEY.PIXEL, +v); session.set('sess', sessionSignature(null));
    });
    segBind('seg-uiscale', function (v) { prefs.uiScale = v; store.set('uiScale', v); applySession(true); });
    segBind('seg-fps', function (v) { if (!requireLink()) return false; link.setKey(KEY.FPS, +v); });
    segBind('seg-fit', function (v) { prefs.fit = v; store.set('fit', v); presenter.setFit(v); });
    segBind('seg-mode', function (v) {
      if (v === 'video' && !VideoPresenter.canH264()) { toast(t('video.unsupported'), 4000); return false; }
      prefs.transport = v; store.set('transport', v);
      if (v !== 'auto') store.set('h264slow', 0);
      applyTransport(true);
    });
    $('stats').onchange = function () { prefs.stats = this.checked; store.set('stats', prefs.stats); presenter.setStatsVisible(prefs.stats); };
    $('online').onchange = function () { if (!requireLink()) { this.checked = !this.checked; return; } link.setKey(KEY.ONLINE, this.checked ? 1 : 0); };
    $('btnet').onchange = function () { if (!requireLink()) { this.checked = !this.checked; return; } link.setKey(KEY.BTNET, this.checked ? 2 : 1); };
    segBind('seg-driver', function (v) { if (!requireLink()) return false; link.setKey(KEY.DRIVER, +v); });
    segBind('seg-icon', function (v) {
      if (!requireLink()) return false;
      if (+v === 0) { state.icon = ''; $('icon-grid').classList.add('hidden'); $('tesla-tm').classList.add('hidden'); $('car-name').placeholder = 'Auto'; qsa('#icon-grid img').forEach(function (x) { x.classList.remove('on'); }); scheduleIdentity(); }
      else { $('icon-grid').classList.remove('hidden'); }
    });
    $('car-name').addEventListener('input', function () {
      var enc = new TextEncoder();
      while (enc.encode(this.value).length > 12) this.value = this.value.slice(0, -1);
    });
    $('car-name').addEventListener('change', function () { if (link.open) scheduleIdentity(); });

    $('btn-psk-show').onclick = function () {
      var f = $('wifi-psk'); var show = f.type === 'password';
      f.type = show ? 'text' : 'password'; this.textContent = show ? t('wifi.hide') : t('wifi.show');
    };
    $('btn-psk-change').onclick = passwordDialog;
    $('btn-channel').onclick = channelDialog;

    $('btn-update').onclick = checkUpdate;
    $('update-url').value = prefs.updateUrl || '';
    $('update-url').addEventListener('change', function () { prefs.updateUrl = this.value.trim(); store.set('updateUrl', prefs.updateUrl); });
    $('btn-reset').onclick = function () {
      if (!requireLink()) return;
      dialog({ title: t('about.reset'), text: t('about.reset_confirm'),
        buttons: [{ label: t('dlg.cancel') }, { label: t('about.reset_btn'), danger: true, onClick: function () { link.cmd(CMD.FACTORY_RESET); } }] });
    };
    // Double tap on the hardware row reveals the raw hardware string.
    $('about-hw').addEventListener('dblclick', function () { $('hw-short').classList.toggle('hidden'); $('hw-full').classList.toggle('hidden'); });

    window.addEventListener('resize', function () {
      clearTimeout(window.__rsz);
      window.__rsz = setTimeout(function () {
        var h = link.hello || {};
        if (Math.abs(window.innerWidth - h.w) >= CONFIG.RESIZE_RELOAD_PX || Math.abs(window.innerHeight - h.h) >= CONFIG.RESIZE_RELOAD_PX) reload();
      }, 1000);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { link.close(); presenter.stop(); }
      else reload();
    });
  }

  /* --------------------------------------------------------------- boot */

  function boot() {
    I18N.init();
    applyTheme();
    segSet('seg-theme', prefs.theme); segSet('seg-res', prefs.res); segSet('seg-uiscale', prefs.uiScale); segSet('seg-fit', prefs.fit);
    segSet('seg-mode', prefs.transport);
    $('stats').checked = !!prefs.stats;

    var keyTimer = 0;
    presenter = new VideoPresenter({
      canvas: $('cp-canvas'), canvasWorker: $('cp-canvas-worker'), img: $('cp-img'), statsEl: $('stage-stats'), fit: prefs.fit,
      onMessage: function (kind, a, b) {
        if (kind === 'size') $('session-info').textContent = a + ' × ' + b + ($('session-info').getAttribute('data-mm') || '');
        else if (kind === 'needkey') {
          if (!keyTimer) keyTimer = setTimeout(function () { keyTimer = 0; link.cmd(CMD.KEYFRAME); }, 1000);
          $('stage-msg').textContent = t('video.keyframe'); $('stage-msg').classList.remove('hidden');
        }
        else if (kind === 'key') $('stage-msg').classList.add('hidden');
        else if (kind === 'slow') h264Failed('slow');
        else if (kind === 'h264error') h264Failed(a);
      }
    });
    presenter.setStatsVisible(prefs.stats);
    bindUI();
    bindTouch();
    renderLanguages();
    renderHomeStatus();
    applySession(false);

    link.on('init', onInit)
      .on('link', onLinkMsg)
      .on('status', function (j) { state.lastApn = j.apn; state.lastCsq = j.csq; state.lastSig = j.sig; btChanged(j.bt); if (state.link < 2) updateCell(j); })
      .on('btlist', function () { if (state.page === 'devices') updateBtList(); })
      .on('fw', onFwStatus)
      .on('reload', reload)
      .on('video', function (bytes) { if (state.link > 1) presenter.feedH264(bytes); })
      .on('qr', function (text) {
        var qr = $('qr'); qr.innerHTML = '';
        try { new QRCode(qr, { text: text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { qr.textContent = text; }
      })
      .on('pingtimeout', function () { if (state.updating) updateFailed(); else if (state.link > 0) switchVideo(-1); })
      .on('close', function () { switchVideo(-1); })
      .on('open', function () { /* hello sent by client */ });

    link.connect({ w: window.innerWidth, h: window.innerHeight, lang: navigator.language, nav: getTesla() });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
