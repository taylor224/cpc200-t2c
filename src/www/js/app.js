/* Application controller for the T2C Tesla web UI. */
(function () {
  'use strict';

  var CONFIG = {
    // Firmware update server (<base>/<branch>/version.json). Fixed on purpose: the page
    // offers no way to install firmware from anywhere else.
    UPDATE_BASE_URL: 'https://raw.githubusercontent.com/taylor224/cpc200-t2c/main/updates',
    // Background update check: first this long after the page connects, then at this interval.
    UPDATE_FIRST_MS: 30000,
    UPDATE_CHECK_MS: 6 * 3600 * 1000,
    // CarPlay session size limits (the adapter's own "HD" preset is 1376x1072).
    MAX_SESSION_AREA: 1376 * 1072,
    MAX_W: 1920,
    MAX_H: 1200,
    // The iPhone draws CarPlay at a fixed pixel size whatever session size and physical size the
    // adapter reports (measured 640-1184 px wide, 60-255 mm: icons always ~120 px). The UI only
    // looks bigger or smaller on the Tesla screen through the picture being enlarged more or less,
    // so one setting — the quality level — sets sharpness, UI size and decoding cost together.
    // The top level uses the screen's own pixels (at least QUALITY_TOP_MIN x the browser size,
    // within the limits above); each level below is QUALITY_STEP x the width and the height
    // (0.72 x the pixels to decode). The physical size is just kept plausible.
    QUALITY: ['ultra', 'high', 'balanced', 'low', 'ultralow'],
    QUALITY_STEP: 0.85,
    QUALITY_TOP_MIN: 1.5,
    PX_PER_MM: 5.2,
    RESIZE_RELOAD_PX: 48,
    // Name of the car's own app in the CarPlay app grid (the adapter's built-in default is "Auto").
    CAR_NAME: 'Carlinkit'
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
    quality: loadQuality(),
    fit: store.get('fit', 'contain'),
    stats: store.get('stats', false),
    transport: store.get('transport', 'auto')
  };

  /** Session scale (session px per CSS px) of a quality level for a viewport. */
  function qualityScale(level, vw, vh) {
    var top = Math.max(window.devicePixelRatio || 1, CONFIG.QUALITY_TOP_MIN);
    top = Math.min(top, Math.sqrt(CONFIG.MAX_SESSION_AREA / (vw * vh)), CONFIG.MAX_W / vw, CONFIG.MAX_H / vh);
    return top * Math.pow(CONFIG.QUALITY_STEP, Math.max(0, CONFIG.QUALITY.indexOf(level)));
  }

  /* Builds up to 26101726 stored a picture size (sharp = screen pixels, balanced 1, saver 0.75,
   * low 0.6, device = the adapter's presets) and a separate UI size (small 1.25, normal 1,
   * large 0.8). Both become the one quality level whose session is closest to their product.
   * The old builds' "decoder too slow: Picture for a day" verdict is dropped with them. */
  function loadQuality() {
    var q = store.get('quality', null);
    if (CONFIG.QUALITY.indexOf(q) >= 0) return q;
    q = 'balanced';
    var res = store.get('res', null);
    if (res && res !== 'device') {
      var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
      var old = ({ sharp: qualityScale('ultra', vw, vh), balanced: 1, saver: 0.75, low: 0.6 })[res] || 1;
      old *= ({ small: 1.25, normal: 1, large: 0.8 })[store.get('uiScale', 'normal')] || 1;
      var best = Infinity;
      CONFIG.QUALITY.forEach(function (l) {
        var d = Math.abs(Math.log(old / qualityScale(l, vw, vh)));
        if (d < best) { best = d; q = l; }
      });
    }
    store.set('quality', q);
    store.set('h264slow', 0);
    try { localStorage.removeItem('t2c.res'); localStorage.removeItem('t2c.uiScale'); } catch (e) { /* ignore */ }
    return q;
  }

  var state = {
    init: null, link: -1, phone: false, linking: false, page: 'home',
    night: 0, isNight: 2, nightTimer: 0,
    channel: -1, chtmp: 255,
    icon: '', icons: {}, lyver: '',
    btconn: null, btdelay: null, btdel: null,
    pixel: 3, vid: false, fps: 0,
    carUi: false,          // iPhone asked for the car's own UI (Carlinkit app tapped in CarPlay)
    elsewhere: false,      // another page connected to the adapter and took over (retried by itself)
    updating: false, updateUrl: null, updateAvail: null, updateLogged: false,
    hasCell: true,
    sessWanted: null,      // session size this page asked for
    sessSig: '', sessRestartAt: 0, sessNew: false, sessMismatch: 0
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
  /* Several paths reload the page to re-apply a setting. Should one of them not converge
   * (a setting the adapter does not take, storage that does not persist), stop instead of
   * reloading forever: the history entry survives reloads and remembers the recent ones. */
  function reload() {
    var now = Date.now();
    var recent = ((history.state && history.state.t2cReloads) || []).filter(function (ts) { return now - ts < 60000; });
    if (recent.length >= 4) { console.warn('reload loop stopped'); toast(t('home.reload_loop'), 8000); return; }
    recent.push(now);
    try { history.replaceState({ t2cReloads: recent }, ''); } catch (e) { /* ignore */ }
    logEvent('reload');
    location.reload();
  }

  function requireLink() {
    if (link.open) return true;
    confirmReload(t('about.ws_lost'));
    return false;
  }

  /* ----------------------------------------------------------- event log */

  /* What happened in the car can be read afterwards: the last EVENTS_MAX connection, takeover,
   * step-down and session events stay in localStorage (About › Recent events). */
  var EVENTS_MAX = 80;
  function logEvent(kind, detail) {
    var list = store.get('events', []);
    if (!Array.isArray(list)) list = [];
    list.push({ t: Date.now(), k: kind, d: detail === undefined || detail === null ? '' : String(detail) });
    while (list.length > EVENTS_MAX) list.shift();
    store.set('events', list);
    var line = kind + (detail !== undefined && detail !== null && detail !== '' ? ' ' + detail : '');
    console.log('[t2c] ' + line);
    reportLine(line);
  }

  /* The same events, and the decoder's numbers once a minute, go to the adapter's log
   * (/tmp/t2cui.log, page message type 14) so a problem in the car can be read from the adapter
   * afterwards. Rust UI only (the init JSON says ui: "rust"; the vendor UI does not know the
   * message). Lines written while the socket is down wait for the next init, the newest 30. */
  var reportQueue = [];
  function reportLine(line) {
    if (line) { reportQueue.push(line); if (reportQueue.length > 30) reportQueue.shift(); }
    if (!link.open || !state.init) return;
    if (state.init.ui !== 'rust') { reportQueue = []; return; }
    while (reportQueue.length && link.sendLog(reportQueue[0])) reportQueue.shift();
  }

  var REPORT_EVERY = 60000;
  function reportVideo() {
    var r = presenter.takeReport();
    if (r.mode !== 'h264' || !r.rx || r.secs < 1 || state.link < 2) return;
    reportLine('stats ' + r.w + 'x' + r.h + ' ' + prefs.quality + (state.fps === 1 ? ' smooth' : '') + ' ' + Math.round(r.secs) + 's' +
      ' rx ' + (r.rx / r.secs).toFixed(1) + '/s dec ' + (r.dec / r.secs).toFixed(1) + '/s ' +
      (r.dec ? (r.ms / r.dec).toFixed(1) : '0') + ' ms (' + Math.round(r.ms / (r.secs * 10)) + '% busy)' +
      ' q<=' + r.qmax + ' behind ' + r.behind + 's dropped ' + r.dropped + ' slow ' + r.slow);
  }
  function eventsDialog() {
    var list = store.get('events', []);
    if (!Array.isArray(list)) list = [];
    var pre = document.createElement('pre'); pre.className = 'events';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    pre.textContent = list.length ? list.slice().reverse().map(function (e) {
      var d = new Date(e.t);
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '  ' + e.k + (e.d ? '  ' + e.d : '');
    }).join('\n') : t('about.events_none');
    dialog({ title: t('about.events'), content: pre,
      buttons: [{ label: t('about.events_clear'), onClick: function () { store.set('events', []); } }, { label: t('dlg.ok'), primary: true }] });
  }

  // The iPhone sends an IDR only when asked; at most one request a second, but a request
  // that arrives inside that second is sent when it is over, never dropped.
  var keyTimer = 0, keyPending = false;
  function requestKeyframe() {
    if (keyTimer) { keyPending = true; return; }
    keyPending = false;
    keyTimer = setTimeout(function () { keyTimer = 0; if (keyPending) requestKeyframe(); }, 1000);
    if (state.link > 1) link.cmd(CMD.KEYFRAME);
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

  var H264_ERROR_TTL = 3600 * 1000;       // a crash or a lost GPU context: try again in an hour

  var videoHeld = 0;    // transient decoder trouble: Picture for this session, Video retried later
  function wantVideo() {
    if (!VideoPresenter.canH264() || (presenter && presenter.broken) || videoHeld) return false;
    if (prefs.transport === 'video') return true;
    if (prefs.transport === 'picture') return false;
    var until = store.get('h264slow', 0);   // expiry; older builds stored the verdict time, long past
    return !(until && Date.now() < until);
  }

  /** Put the adapter in the transport mode we can render; restart the session when needed. */
  function applyTransport(userAction) {
    var want = wantVideo();
    if (!link.open) { state.vid = want; return; }
    if (state.vid !== want) {
      link.setKey(KEY.MODE, want ? 1 : 0);
      state.vid = want;
      // The adapter picks the pipeline when the iPhone's video starts: an active session has to be
      // restarted — unless applySession() is about to do that anyway by leaving Auto.
      var leavingAuto = state.pixel === 3 && !store.get('sessAuto', false);
      if ((state.link >= 1 || userAction) && !leavingAuto) restartSession();
    }
  }

  /* The browser cannot decode this many pixels per second (Ultra x Smooth on an Intel-era car, for
   * instance). Nothing is changed on the driver's behalf: a lower quality, frame rate or the
   * Picture transport each restart the CarPlay session (the picture drops out for seconds), and a
   * lower quality makes the CarPlay UI bigger. Up to 26101726 the page stepped Smooth down to
   * Standard and Sharp down to Balanced by itself, and a Wi-Fi burst from the iPhone was enough to
   * set it off — the driver saw "disconnects, then the screen is huge" (2026-10-23). Now the page
   * says so, at most every SLOW_HINT_GAP, and the adapter log gets the numbers (one event a
   * minute at most; the verdict repeats every 5 s while it lasts). */
  var SLOW_HINT_GAP = 600000, slowHintAt = 0;
  var SLOW_LOG_GAP = 60000, slowLogAt = 0, slowQuiet = 0;
  function videoSlow() {
    var now = Date.now(), ss = state.sessWanted;
    if (now - slowLogAt >= SLOW_LOG_GAP) {
      logEvent('slow', prefs.quality + (ss ? ' ' + ss.w + 'x' + ss.h : '') + (state.fps === 1 ? ' smooth' : '') +
        ' backlog ' + presenter.queue.length + (slowQuiet ? ' (+' + slowQuiet + ' since the last)' : ''));
      slowLogAt = now; slowQuiet = 0;
    } else slowQuiet++;
    if (now - slowHintAt < SLOW_HINT_GAP) return;
    slowHintAt = now;
    toast(t('video.slow'), 8000);
  }

  var transientFails = [];
  function h264Failed(reason, transient) {
    console.warn('h264 fallback:', reason, transient ? '(transient)' : '');
    if (transient) {
      // The browser is fine; the Wi-Fi was away while the decoder module loaded, the worker script
      // did not load, or the GPU context never came back. Rebuild the worker (fresh canvas) a few
      // times; only then show the picture over MJPEG — for a while, not for a day — and never
      // remember it as "this browser cannot decode video".
      var now = Date.now();
      transientFails = transientFails.filter(function (ts) { return now - ts < 600000; });
      transientFails.push(now);
      logEvent('decoder-transient', reason + ' (' + transientFails.length + ')');
      if (transientFails.length <= 3) {
        setTimeout(function () {
          if (state.link > 1 && state.vid && !presenter.worker && !presenter.broken && !document.hidden) presenter.startH264();
        }, 1500 * transientFails.length);
        return;
      }
      toast(t('video.transient'), 7000);
      clearTimeout(videoHeld);
      videoHeld = setTimeout(function () { videoHeld = 0; logEvent('decoder-retry', 'video again'); applyTransport(false); }, 600000);
      applyTransport(true);
      return;
    }
    logEvent('h264-fallback', reason);
    store.set('h264slow', Date.now() + H264_ERROR_TTL);
    toast(t('video.unsupported'), 5000);
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
    logEvent('link', state.link + ' -> ' + newLink + (state.phone ? ' phone' : ''));
    var prev = state.link;
    state.link = newLink;
    // 2 -> 1 while the phone stays connected means the user opened the Carlinkit app
    // inside CarPlay: the adapter stops the video and expects this page to show its menu.
    state.carUi = newLink === 1 && prev > 1;
    if (newLink > 1 && prev <= 1) state.sessNew = true;
    try {
      if (newLink > 1) {
        link.cmd(CMD.VIDEO);
        startVideo();
        // The decoder was just cleared and the adapter holds P-frames back until an IDR; on a
        // still CarPlay screen the phone sends nothing, so nobody would ask for one: back from
        // the page menu the car screen stayed black until the user swiped. (t2cui asks the
        // phone as well; the two requests fold into one.)
        if (state.vid) requestKeyframe();
      } else {
        if (prev > 1) { stopVideo(); showPage('home'); }
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

  var idleTimer = 0;
  function armIdle() {
    clearTimeout(idleTimer); idleTimer = 0;
    document.body.classList.remove('idle');
    // The waiting screen animates; parked for hours with no phone that is repaint work for nothing.
    if (state.link < 1 && !state.linking && !state.elsewhere) idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 120000);
  }

  function renderHomeStatus() {
    armIdle();
    var txt = $('home-status-text'), dot = $('home-dot'), spin = $('home-spinner');
    var open = $('btn-open-carplay'), steps = $('home-steps');
    spin.classList.add('hidden'); dot.classList.remove('hidden', 'on', 'ok');
    open.hidden = true; steps.classList.remove('hidden');
    $('btn-use-here').hidden = !state.elsewhere;
    if (state.elsewhere) {
      var secs = takeoverDeadline ? Math.max(0, Math.ceil((takeoverDeadline - Date.now()) / 1000)) : 0;
      txt.textContent = t('home.elsewhere') + (secs ? ' · ' + t('home.retry_in', { s: secs }) : '');
      spin.classList.remove('hidden'); dot.classList.add('hidden'); steps.classList.add('hidden');
    } else if (state.link > 1) {
      txt.textContent = t('home.connected'); dot.classList.add('ok'); open.hidden = false; steps.classList.add('hidden');
    } else if (state.link === 1 && state.carUi) {
      txt.textContent = t('home.car_ui'); dot.classList.add('ok'); open.hidden = false; steps.classList.add('hidden');
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
    var vw = window.innerWidth, vh = window.innerHeight;
    var s = qualityScale(prefs.quality, vw, vh);
    var w = Math.max(320, Math.round(vw * s / 16) * 16);
    var h = Math.max(240, Math.round(vh * s / 16) * 16);
    var mmw = w / CONFIG.PX_PER_MM, mmh = h / CONFIG.PX_PER_MM;
    if (mmw > 255 || mmh > 255) { var k2 = 255 / Math.max(mmw, mmh); mmw *= k2; mmh *= k2; }
    return { w: w, h: h, mmw: Math.round(mmw), mmh: Math.round(mmh) };
  }

  function sessionSignature(ss) {
    return [ss.w, ss.h, ss.mmw, ss.mmh].join('x');
  }

  function setPixel(p) {
    link.setKey(KEY.PIXEL, p); state.pixel = p;
    state.sessRestartAt = Date.now(); state.sessNew = false;
  }

  /** Restart the CarPlay session. lylinkui does that on any change of the pixel setting while a
   *  type-11 override keeps the size, so toggling between two presets is a plain restart. In the
   *  Auto flows (adapter presets, or firmware that ignores the override outside Auto) a reload
   *  does it through the hello instead.
   *  A restart kills and respawns lylinkapp and the iPhone reconnects: a dozen of them in a few
   *  minutes took the adapter's hotspot down for a minute (bench, 2026-10-15). Restarts are
   *  therefore at least RESTART_GAP apart; a request inside the gap is carried out when it ends,
   *  with whatever override was sent last. */
  var RESTART_GAP = 10000, restartTimer = 0;
  function restartSession() {
    var wait = RESTART_GAP - (Date.now() - state.sessRestartAt);
    if (wait > 0) {
      if (!restartTimer) restartTimer = setTimeout(function () { restartTimer = 0; restartSession(); }, wait);
      return;
    }
    if (store.get('sessAuto', false)) {
      state.sessRestartAt = Date.now();
      logEvent('restart', 'reload (auto flow)');
      setTimeout(reload, 400);
      return;
    }
    logEvent('restart', 'pixel ' + state.pixel + ' -> ' + (state.pixel === 0 ? 1 : 0));
    setPixel(state.pixel === 0 ? 1 : 0);
  }

  /** Push the session override to the adapter and make sure it takes effect. */
  function applySession(userAction) {
    var ss = computeSession();
    var sig = sessionSignature(ss);
    state.sessWanted = ss;
    $('session-info').textContent = ss.w + ' × ' + ss.h + ' · ' + ss.mmw + ' × ' + ss.mmh + ' mm';
    if (!link.open) return;
    var changed = sig !== state.sessSig;
    state.sessSig = sig;
    link.setSessionOverride(ss.w, ss.h, ss.mmw, ss.mmh);
    if (store.get('sessAuto', false)) {
      // Auto flow: every hello restarts the session (and the iPhone's Bluetooth PAN with it);
      // a changed override needs a reload to get one.
      if (state.pixel !== 3) { setPixel(3); session.set('sess', sig); }
      else if (session.get('sess') !== sig) { session.set('sess', sig); if (state.link >= 1 || userAction) restartSession(); }
    } else if (state.pixel === 3) {
      // Leave Auto. In Auto every hello — reconnect, reload, a second page — restarts the
      // CarPlay session. With a fixed preset it restarts only when asked, and the override
      // keeps its size; the change itself restarts the session once, override in place.
      setPixel(0);
    } else if (userAction && changed) {
      restartSession();
    }
    // Otherwise nothing: verifySession() restarts only if the picture that arrives has
    // another size than requested (the override is lost when the adapter reboots).
  }

  /** Called with the size of the picture that actually arrives. */
  function verifySession(w, h) {
    var ss = state.sessWanted;
    if (!ss || !link.open || store.get('sessAuto', false)) return;
    if (w === ss.w && h === ss.h) { state.sessMismatch = 0; return; }
    // Frames of the previous session can still arrive right after a restart request.
    if (!state.sessNew || Date.now() - state.sessRestartAt < 5000) return;
    state.sessMismatch++;
    console.warn('session is ' + w + 'x' + h + ', wanted ' + ss.w + 'x' + ss.h + ' (' + state.sessMismatch + ')');
    if (state.sessMismatch === 1) { link.setSessionOverride(ss.w, ss.h, ss.mmw, ss.mmh); restartSession(); }
    else if (state.sessMismatch === 2) {
      // This firmware does not honour the override with a fixed preset: back to the Auto flow.
      store.set('sessAuto', true); session.set('sess', sessionSignature(ss)); setPixel(3);
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

  /* 5 GHz channels with a valid HT40 partner: the firmware's hostapd wrapper runs them at 40 MHz
     (165 has none and stays at 20 MHz; the stock file left the default 161 at 20 MHz too). */
  var CH40 = [36, 40, 44, 48, 149, 153, 157, 161];
  function channelWidth(ch) { return ch < 15 ? '' : (CH40.indexOf(ch) >= 0 ? '40 MHz' : '20 MHz'); }
  function channelLabel(ch) {
    if (ch === 0) return t('wifi.band24') + ' · ' + t('wifi.auto');
    if (ch === 255) return t('wifi.band5') + ' · ' + t('wifi.auto');
    var w = channelWidth(ch);
    return (ch < 15 ? t('wifi.band24') : t('wifi.band5')) + ' · ' + ch + (w ? ' · ' + w : '');
  }

  function channelDialog() {
    if (!requireLink()) return;
    var band = state.channel < 15 ? 24 : 5;
    var chosen = state.channel;
    var content = document.createElement('div');
    var seg = document.createElement('div'); seg.className = 'seg';
    var list = document.createElement('div'); list.className = 'chlist';
    var legend = document.createElement('p'); legend.className = 'chlegend';
    function renderList() {
      list.innerHTML = '';
      var chans = band === 24 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [255, 36, 40, 44, 48, 149, 153, 157, 161, 165];
      chans.forEach(function (c) {
        var b = document.createElement('button');
        var rec = CH40.indexOf(c) >= 0;
        b.textContent = (c === 0 || c === 255) ? t('wifi.auto') : (rec ? '\u2605 ' : '') + c;
        var w = (c === 0 || c === 255) ? '' : channelWidth(c);
        if (w) { var sm = document.createElement('small'); sm.textContent = w; b.appendChild(sm); }
        b.classList.toggle('on', c === chosen);
        b.onclick = function () { chosen = c; renderList(); };
        list.appendChild(b);
      });
      legend.textContent = band === 5 ? '\u2605 ' + t('wifi.rec40') : '';
    }
    [[24, 'wifi.band24'], [5, 'wifi.band5']].forEach(function (pair) {
      var b = document.createElement('button'); b.textContent = t(pair[1]); b.classList.toggle('on', band === pair[0]);
      b.onclick = function () { band = pair[0]; chosen = band === 24 ? 0 : 255; qsa('button', seg).forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); renderList(); };
      seg.appendChild(b);
    });
    renderList();
    content.appendChild(seg); content.appendChild(list); content.appendChild(legend);
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
    // The adapter keeps the password in a 12-byte field and only terminates it when the
    // payload is 11 bytes or shorter, so 12 characters would run into the next field.
    var input = document.createElement('input'); input.className = 'field'; input.type = 'text'; input.maxLength = 11;
    input.placeholder = t('wifi.pw_new');
    var rule = document.createElement('p'); rule.className = 'muted small'; rule.style.marginTop = '0.5rem'; rule.textContent = t('wifi.pw_rule');
    content.appendChild(input); content.appendChild(rule);
    input.addEventListener('input', function () { input.value = input.value.replace(/[^A-Za-z0-9_]/g, ''); });
    dialog({
      title: t('wifi.pw_title'), text: t('wifi.pw_warn'), content: content,
      buttons: [{ label: t('dlg.cancel') }, { label: t('dlg.save'), primary: true, keep: true, onClick: function () {
        var v = input.value;
        if (v.length < 8 || v.length > 11) { input.focus(); return; }
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
    var name = nameEl.value || nameEl.placeholder || CONFIG.CAR_NAME;
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
    $('car-name').placeholder = custom ? state.icons[state.icon] : CONFIG.CAR_NAME;
  }

  /* ---------------------------------------------------- firmware update */

  function updateBase() { return CONFIG.UPDATE_BASE_URL; }

  // Versions compare by their date part (YYMMDDNN): appver "26101727.1508.1", tsl "26101727.5.4".
  function verNum(s) { return parseInt(String(s || '').substring(0, 8), 10) || 0; }

  // version.json -> the newer release, or null when this adapter is up to date
  function fetchUpdate() {
    return fetch(updateBase() + '/' + state.lyver + '/version.json?rand=' + Math.random(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('version.json ' + r.status); return r.json(); })
      .then(function (j) {
        var cur = verNum(state.init ? state.init.SW : '');
        return j.url && cur && verNum(j.tsl || j.appver) > cur ? j : null;
      });
  }

  // What changed since the running version: version.json lists the recent releases in
  // "history" (newest first, notes per language); files from older releases only have "msg".
  function releaseNotes(j) {
    var cur = verNum(state.init ? state.init.SW : ''), lang = I18N.current;
    var list = (j.history || []).filter(function (e) { return verNum(e.v) > cur; }).slice(0, 6);
    if (!list.length) list = [{ v: j.tsl || j.appver, notes: j.notes, msg: j.msg }];
    return list.map(function (e) {
      var n = e.notes || {};
      return { v: verNum(e.v), text: n[lang] || n[lang.split('-')[0]] || n.en || e.msg || '' };
    });
  }

  function showUpdate(j) {
    var v = verNum(j.tsl || j.appver);
    state.updateUrl = j.url;
    var box = document.createElement('div');
    var p = document.createElement('div'); p.className = 'dialog-text';
    p.textContent = t('about.new_version_v', { v: v, cur: verNum(state.init && state.init.SW) });
    box.appendChild(p);
    var notes = document.createElement('div'); notes.className = 'notes';
    releaseNotes(j).forEach(function (e) {
      var h = document.createElement('div'); h.className = 'notes-v'; h.textContent = String(e.v); notes.appendChild(h);
      var b = document.createElement('div'); b.className = 'notes-text'; b.textContent = e.text || t('about.notes_none'); notes.appendChild(b);
    });
    box.appendChild(notes);
    var hint = document.createElement('p'); hint.className = 'muted small'; hint.textContent = t('about.update_hint');
    box.appendChild(hint);
    dialog({ title: t('about.update'), content: box,
      buttons: [{ label: t('about.later') },
        { label: t('about.update_now'), primary: true, onClick: function () { if (!requireLink()) return; logEvent('update', 'start ' + v); startUpdate(); } }] });
  }

  function checkUpdate() {
    if (!requireLink()) return;
    var btn = $('btn-update'); btn.disabled = true;
    fetchUpdate()
      .then(function (j) { setUpdateAvail(j); if (j) showUpdate(j); else dialog({ text: t('about.latest') }); })
      .catch(function () { dialog({ text: t('about.check_fail') }); })
      .then(function () { btn.disabled = false; });
  }

  // Background check shortly after the page connects, then every UPDATE_CHECK_MS. A newer
  // release only shows a banner on the home screen; installing stays the user's choice.
  var updateTimer = null;
  function scheduleUpdateCheck() {
    if (updateTimer || !state.init || /test/.test(state.init.SW || '')) return;
    updateTimer = setTimeout(function run() {
      updateTimer = setTimeout(run, CONFIG.UPDATE_CHECK_MS);
      if (state.updating) return;
      fetchUpdate().then(setUpdateAvail).catch(function () { /* offline: next round */ });
    }, CONFIG.UPDATE_FIRST_MS);
  }

  function setUpdateAvail(j) {
    state.updateAvail = j || null;
    var v = j ? verNum(j.tsl || j.appver) : 0;
    $('home-update').classList.toggle('hidden', !j);
    $('home-update-text').textContent = j ? t('home.update_avail', { v: v }) : '';
    $('about-sw').textContent = ((state.init && state.init.SW) || '') + (j ? ' · ' + t('about.new_short', { v: v }) : '');
    if (j && !state.updateLogged) { state.updateLogged = true; logEvent('update', 'available ' + v); }
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

  // tools/build.sh stamps the firmware version into index.html. After a firmware update the car
  // browser can keep running the previous page (it only reconnects its WebSocket), so a page
  // whose stamp differs from the adapter's version loads the new one, once per version.
  var BUILD = (function () {
    var m = document.querySelector('meta[name="t2c-build"]'), v = m ? m.getAttribute('content') : '';
    return /^\d{8}\./.test(v) ? v : '';
  })();
  function reloadIfStale(sw) {
    if (!BUILD || !sw || sw === BUILD) return;
    try {
      if (sessionStorage.getItem('t2c.staleFor') === sw) return;
      sessionStorage.setItem('t2c.staleFor', sw);
    } catch (e) { return; }
    logEvent('stale page', BUILD + ' -> ' + sw);
    reload();
  }

  function onInit(j) {
    state.init = j;
    reloadIfStale(j.SW);
    state.lyver = (j.LY || '').split('.')[1] || '';
    state.channel = j.ch; state.chtmp = j.sh;
    state.pixel = j.pixel;
    state.fps = j.fps | 0;
    state.phone = !!j.phone;
    state.icon = j.icon || ''; state.icons = j.icons || {};
    state.night = j.night;
    logEvent('init', 'link ' + j.link + (j.phone ? ' phone' : '') + ' ' + (j.SW || ''));
    takeoverSettled();

    // language: server index is only a hint
    if (I18N.isAuto()) { I18N.init(j.lan); }
    renderLanguages();

    ['home-bt', 'dev-bt', 'bt-name'].forEach(function (id) { $(id).textContent = j.bt || ''; });
    $('wifi-ssid').textContent = j.ssid || '';
    $('wifi-psk').value = j.psk || '';
    $('wifi-ch').textContent = channelLabel(j.ch);
    $('auto').checked = !!j.auto;
    if ($('usb-sw')) $('usb-sw').checked = !!j.usb;
    $('night').checked = j.night > 2;
    segSet('seg-night', j.night > 2 ? j.night - 3 : j.night);
    $('online').checked = !!j.online;
    $('btnet').checked = !!j.btnet;
    segSet('seg-driver', j.driver);
    segSet('seg-fps', j.fps);
    // The adapter ships with the car name "Auto"; the car's own app is presented as Carlinkit.
    var stockName = !j.name || j.name === 'Auto';
    $('car-name').value = stockName ? '' : j.name;
    renderIcons();
    if (stockName) link.setCarIdentity(CONFIG.CAR_NAME, state.icon);
    $('about-model').textContent = j.SN || '';
    $('about-fw').textContent = j.SW || '';
    $('about-sw').textContent = j.SW || '';
    $('hw-short').textContent = parseHw(j);
    $('hw-full').textContent = j.HW || '';
    $('about-uuid').textContent = j.wifi || '';
    $('home-foot').textContent = (j.ssid ? j.ssid + ' · ' : '') + (j.SW || '');
    if (/test/.test(j.SW || '')) $('row-update').classList.add('hidden');
    setUpdateAvail(state.updateAvail);
    scheduleUpdateCheck();
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
    state.phone = !!j.phone;
    // The adapter can push {link,phone} before the init JSON; the transport (MJPEG vs
    // H.264) is only known after init, which calls switchVideo(j.link) itself.
    if (!state.init) return;
    if (state.linking) {
      if (j.link > 0 || !j.phone) setLinking(false);
    } else if (j.phone && j.link < 1) {
      setLinking(true);
    }
    switchVideo(j.link);
  }

  /** Another page (other browser, tab or device) now owns the adapter's connection — or lylinkui's
   *  status thread stalled while its HTTP side kept answering, which looks the same from here.
   *  Nothing to ask: the car screen takes the adapter back by itself after a pause that grows
   *  while the other page keeps winning (a forgotten tab on a phone), and only while this page is
   *  visible. Since the adapter neither restarts the CarPlay session on a hello nor stops it when a
   *  socket closes (26101701), a takeover costs the other page its picture and nothing else. */
  var TAKEOVER_WAIT = [3, 5, 10, 20, 30, 60];
  var takeoverTimer = 0, takeoverN = 0, takeoverDeadline = 0, takeoverTick = 0, stableTimer = 0;
  function onSuperseded() {
    logEvent('superseded', 'retry ' + (takeoverN + 1));
    if (state.updating) { updateFailed(); return; }
    clearTimeout(stableTimer); stableTimer = 0;
    state.elsewhere = true;
    switchVideo(-1);
    stopVideo(); showPage('home');
    scheduleTakeover();
  }
  function scheduleTakeover() {
    clearTimeout(takeoverTimer); clearInterval(takeoverTick);
    var wait = TAKEOVER_WAIT[Math.min(takeoverN, TAKEOVER_WAIT.length - 1)];
    takeoverDeadline = Date.now() + wait * 1000;
    renderHomeStatus();
    takeoverTick = setInterval(renderHomeStatus, 1000);
    takeoverTimer = setTimeout(function () {
      takeoverTimer = 0; clearInterval(takeoverTick); takeoverTick = 0; takeoverDeadline = 0;
      if (!state.elsewhere) return;
      if (document.hidden) { renderHomeStatus(); return; }    // retried when Tesla shows the page again
      takeover();
    }, wait * 1000);
  }
  function takeover() {
    clearTimeout(takeoverTimer); takeoverTimer = 0; clearInterval(takeoverTick); takeoverTick = 0; takeoverDeadline = 0;
    takeoverN++;
    logEvent('takeover', 'attempt ' + takeoverN);
    renderHomeStatus();
    link.connect();
  }
  /** A connection delivered its init JSON: the takeover is over; a minute of it resets the backoff. */
  function takeoverSettled() {
    if (state.elsewhere) { state.elsewhere = false; renderHomeStatus(); }
    clearTimeout(takeoverTimer); takeoverTimer = 0; clearInterval(takeoverTick); takeoverTick = 0; takeoverDeadline = 0;
    clearTimeout(stableTimer);
    stableTimer = setTimeout(function () { stableTimer = 0; takeoverN = 0; }, 60000);
  }

  /* ---------------------------------------------- background / foreground */

  /* Tesla hides the page when the browser is closed and shows it again when it is reopened. The
   * CarPlay session must survive that: with an iPhone attached the WebSocket stays open (the adapter
   * then changes nothing) and only decoding pauses; without one the socket is closed so the adapter
   * can stop its own menu stream. Coming back costs one key frame — no reload, no session restart,
   * no lost navigation route. Until 26101701 the page closed the socket (which made the adapter stop
   * the session) and reloaded itself on return (a second restart). */
  var resumeCheck = 0;
  function onHidden() {
    logEvent('hidden', 'link ' + state.link + (link.open ? '' : ' (not connected)'));
    clearTimeout(resumeCheck); resumeCheck = 0;
    if (presenter.mode === 'h264') presenter.pause(); else presenter.stop();
    if (!state.phone) link.close();          // no iPhone: let the adapter stop its menu stream
  }
  function onVisible() {
    logEvent('visible', 'link ' + state.link + (link.open ? '' : ' reconnect'));
    if (state.elsewhere) { takeover(); return; }
    if (!link.open) { link.connect(); return; }         // init JSON + switchVideo bring the picture back
    if (state.link > 1) {
      if (presenter.mode === 'h264') { presenter.resume(); requestKeyframe(); armResumeCheck(); }
      else startVideo();
    }
  }
  /** No frame within 5 s of coming back although the stream should run: reconnect instead of staring. */
  function armResumeCheck() {
    clearTimeout(resumeCheck);
    var before = presenter.rxTotal;
    resumeCheck = setTimeout(function () {
      resumeCheck = 0;
      if (document.hidden || state.link <= 1 || !link.open) return;
      if (presenter.rxTotal === before) { logEvent('resume-stall', 'no frames in 5 s, reconnecting'); link.drop(); }
    }, 5000);
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
    if (state.init) setUpdateAvail(state.updateAvail);
  }

  /* -------------------------------------------------------------- touch */

  function bindTouch() {
    var stage = $('stage');
    var down = false, pendingMove = null, raf = 0, lastMove = 0;
    // Moves go out right away (the iPhone derives scroll velocity from their timing);
    // only when two arrive within 4 ms is the second deferred to the next frame.
    var MOVE_GAP = 4;
    function flushMove() {
      raf = 0;
      if (pendingMove) { lastMove = performance.now(); link.sendTouch(2, pendingMove.x, pendingMove.y); pendingMove = null; }
    }
    function queueMove(p) {
      var now = performance.now();
      if (now - lastMove >= MOVE_GAP) { lastMove = now; pendingMove = null; link.sendTouch(2, p.x, p.y); return; }
      pendingMove = p;
      if (!raf) raf = requestAnimationFrame(flushMove);
    }
    function pos(e) { return presenter.toPerMille(e.clientX, e.clientY); }
    if (window.PointerEvent) {
      stage.addEventListener('pointerdown', function (e) {
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
        queueMove(p);
      });
      function up(e) {
        if (!down) return;
        down = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        if (pendingMove) { link.sendTouch(2, pendingMove.x, pendingMove.y); pendingMove = null; }
        var p = pos(e); if (p) link.sendTouch(1, p.x, p.y);
      }
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    } else {
      stage.addEventListener('touchstart', function (e) {
        var p = pos(e.touches[0]); if (!p) return; down = true; link.sendTouch(0, p.x, p.y); e.preventDefault();
      }, { passive: false });
      stage.addEventListener('touchmove', function (e) {
        if (!down) return; var p = pos(e.touches[0]); if (!p) return; queueMove(p);
      }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        if (!down) return; down = false; var p = pos(e.changedTouches[0]); if (p) link.sendTouch(1, p.x, p.y);
      });
      stage.addEventListener('mousedown', function (e) { var p = pos(e); if (!p) return; down = true; link.sendTouch(0, p.x, p.y); });
      stage.addEventListener('mousemove', function (e) { if (!down) return; var p = pos(e); if (p) queueMove(p); });
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
    $('btn-reload').onclick = function () { location.reload(); };
    $('btn-use-here').onclick = function () { if (state.elsewhere) takeover(); else location.reload(); };
    $('btn-events').onclick = eventsDialog;
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
    segBind('seg-quality', function (v) { prefs.quality = v; store.set('quality', v); store.set('sessAuto', false); logEvent('quality', v); applySession(true); });
    segBind('seg-fps', function (v) { if (!requireLink()) return false; state.fps = +v; logEvent('fps', v); link.setKey(KEY.FPS, +v); });
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
      if (+v === 0) { state.icon = ''; $('icon-grid').classList.add('hidden'); $('tesla-tm').classList.add('hidden'); $('car-name').placeholder = CONFIG.CAR_NAME; qsa('#icon-grid img').forEach(function (x) { x.classList.remove('on'); }); scheduleIdentity(); }
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
    $('home-update').onclick = function () { if (state.updateAvail && requireLink()) showUpdate(state.updateAvail); };
    try { localStorage.removeItem('t2c.updateUrl'); } catch (e) { /* older builds stored a server override */ }
    $('usb-sw').onchange = function () { logEvent('usb', this.checked ? 'on' : 'off'); link.cmd(this.checked ? CMD.USB_ON : CMD.USB_OFF); };
    $('btn-reboot').onclick = function () {
      if (!requireLink()) return;
      dialog({ title: t('home.reboot'), text: t('home.reboot_confirm'),
        buttons: [{ label: t('dlg.cancel') }, { label: t('home.reboot_btn'), danger: true, onClick: function () { logEvent('reboot', 'requested'); link.cmd(CMD.REBOOT); } }] });
    };
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
        if (Math.abs(window.innerWidth - h.w) < CONFIG.RESIZE_RELOAD_PX && Math.abs(window.innerHeight - h.h) < CONFIG.RESIZE_RELOAD_PX) return;
        // The layout follows the viewport on its own; only the CarPlay session size depends on
        // it. The Auto flows carry that size in the hello, so they still reload.
        if (store.get('sessAuto', false)) { reload(); return; }
        h.w = window.innerWidth; h.h = window.innerHeight;
        applySession(true);
      }, 1000);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) onHidden(); else onVisible();
    });
  }

  /* --------------------------------------------------------------- boot */

  function boot() {
    I18N.init();
    applyTheme();
    segSet('seg-theme', prefs.theme); segSet('seg-quality', prefs.quality); segSet('seg-fit', prefs.fit);
    segSet('seg-mode', prefs.transport);
    $('stats').checked = !!prefs.stats;

    presenter = new VideoPresenter({
      canvas: $('cp-canvas'), canvasWorker: $('cp-canvas-worker'), img: $('cp-img'), statsEl: $('stage-stats'), fit: prefs.fit,
      onMessage: function (kind, a, b) {
        if (kind === 'size') verifySession(a, b);
        else if (kind === 'needkey') {
          requestKeyframe();
          $('stage-msg').textContent = t('video.keyframe'); $('stage-msg').classList.remove('hidden');
        }
        else if (kind === 'refresh') requestKeyframe();
        else if (kind === 'key') $('stage-msg').classList.add('hidden');
        else if (kind === 'ready') { $('stage-msg').classList.add('hidden'); if (state.link > 1) requestKeyframe(); }
        else if (kind === 'loading') {
          logEvent('decoder-loading', 'attempt ' + a + ' ' + (b || ''));
          $('stage-msg').textContent = t('video.loading'); $('stage-msg').classList.remove('hidden');
        }
        else if (kind === 'slow') videoSlow();
        else if (kind === 'h264error') h264Failed(a, b);
      }
    });
    presenter.setStatsVisible(prefs.stats);
    bindUI();
    bindTouch();
    renderLanguages();
    renderHomeStatus();
    applySession(false);
    setInterval(reportVideo, REPORT_EVERY);

    link.on('init', onInit)
      .on('link', onLinkMsg)
      .on('status', function (j) { state.lastApn = j.apn; state.lastCsq = j.csq; state.lastSig = j.sig; btChanged(j.bt); if (state.link < 2) updateCell(j); })
      .on('btlist', function () { if (state.page === 'devices') updateBtList(); })
      .on('fw', onFwStatus)
      .on('reload', reload)
      .on('video', function (bytes) { if (state.link > 1) presenter.feedH264(bytes); })
      .on('videodrop', function () { presenter.noteDrop(); })
      .on('qr', function (text) {
        var qr = $('qr'); qr.innerHTML = '';
        try { new QRCode(qr, { text: text, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { qr.textContent = text; }
      })
      .on('pingtimeout', function () { logEvent('pingtimeout'); if (state.updating) updateFailed(); else if (state.link > 0) switchVideo(-1); })
      .on('superseded', onSuperseded)
      .on('close', function (code) { logEvent('close', code === undefined ? 'dropped' : code); switchVideo(-1); })
      .on('error', function () { logEvent('ws-error'); })
      .on('open', function () { logEvent('open'); });

    link.connect({ w: window.innerWidth, h: window.innerHeight, lang: navigator.language, nav: getTesla() });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
