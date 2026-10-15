/* H.264 decode worker: Annex-B access units in, pixels on an OffscreenCanvas out.
 *
 * Decoding uses FFmpeg's h264 decoder compiled to WebAssembly (h264dec.js / .wasm,
 * built by tools/build-h264dec.sh). The YUV 4:2:0 planes are uploaded as three
 * textures and converted to RGB in a WebGL shader, so the only per-frame CPU cost
 * besides the decoder is the texture upload.
 *
 * Flow control lives on the main thread: it posts one access unit at a time and waits
 * for 'done' before posting the next (newest wins, older ones are dropped there). A
 * worker cannot drop on its own — its message queue is only visible one message at a
 * time, so a backlog would just grow and add latency.
 *
 * Messages in : {id:'init', canvas, simd}   {id:'decode', data:ArrayBuffer, off, len, lost}   {id:'clear'}
 * Messages out: {id:'ready', gl2} {id:'done'} {id:'size',w,h} {id:'key'} {id:'needkey'} {id:'refresh'}
 *               {id:'stats', dec, ms, wait} {id:'error', message}
 *   needkey : decoding cannot start (or restart) until an IDR arrives
 *   refresh : decoding continues but a reference frame was lost; a new IDR would clean the picture
 */
'use strict';

var Module = null;
var gl = null, isGL2 = false, canvas = null;
var prog = null, tex = [], uMatrix = null, uOffset = null;
var glLost = false, lostTimer = 0;
var inPtr = 0, inCap = 0;
var waitKey = true;         // nothing decodable until an SPS/IDR shows up
var lostRef = false;        // a frame was skipped: references are broken until the next IDR
var refreshAsked = false;
var lastW = 0, lastH = 0, lastCs = -1, lastRange = -1;
var stats = { dec: 0, ms: 0, wait: 0 };
var packed = [null, null, null];

/* ------------------------------------------------------------------ WebGL */

function initGL(c) {
  canvas = c;
  var opts = { antialias: false, depth: false, alpha: false, preserveDrawingBuffer: false, desynchronized: true };
  gl = c.getContext('webgl2', opts);
  isGL2 = !!gl;
  if (!gl) gl = c.getContext('webgl', opts) || c.getContext('experimental-webgl', opts);
  if (!gl) throw new Error('no webgl');
  // The GPU process can go away under a long session (memory pressure, driver reset). Without
  // preventDefault the context is gone for good and every GL call turns into a silent no-op:
  // the picture freezes while the decoder keeps reporting frames. Allow a restore, rebuild the
  // GL state when it comes back, and give up (so the app falls back to MJPEG) if it never does.
  c.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    glLost = true;
    if (!lostTimer) lostTimer = setTimeout(function () { self.postMessage({ id: 'error', message: 'webgl context lost' }); }, 10000);
  });
  c.addEventListener('webglcontextrestored', function () {
    if (lostTimer) { clearTimeout(lostTimer); lostTimer = 0; }
    try {
      setupGL();
      glLost = false;
      self.postMessage({ id: 'refresh' });   // ask for a frame to repaint the (now black) canvas
    } catch (e) {
      self.postMessage({ id: 'error', message: 'webgl restore: ' + (e && e.message) });
    }
  });
  setupGL();
}

/** (Re)create program, quad and textures; valid for the current GL context only. */
function setupGL() {
  var vs = 'attribute vec2 p; varying vec2 t; void main(){ gl_Position = vec4(p,0.0,1.0); t = vec2((p.x+1.0)*0.5, (1.0-p.y)*0.5); }';
  var fs = 'precision mediump float; varying vec2 t; uniform sampler2D y; uniform sampler2D u; uniform sampler2D v;' +
    'uniform mat3 m; uniform vec3 o;' +
    'void main(){ vec3 yuv = vec3(texture2D(y,t).r, texture2D(u,t).r, texture2D(v,t).r) - o; gl_FragColor = vec4(m * yuv, 1.0); }';
  function sh(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var p = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(p);
  gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
  tex = [];
  ['y', 'u', 'v'].forEach(function (name, i) {
    var t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, name), i);
    tex.push(t);
  });
  uMatrix = gl.getUniformLocation(prog, 'm');
  uOffset = gl.getUniformLocation(prog, 'o');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  lastW = lastH = 0;            // viewport and canvas size are re-applied on the next frame
  lastCs = lastRange = -1;
  setColor(2, 1);
}

/* YUV -> RGB matrices (column-major for GLSL). cs: 1 = BT.709, else BT.601; range: 2 = full. */
function setColor(cs, range) {
  var full = range === 2;
  var kr = cs === 1 ? 0.2126 : 0.299, kb = cs === 1 ? 0.0722 : 0.114, kg = 1 - kr - kb;
  var ys = full ? 1.0 : 255 / 219, cs2 = full ? 1.0 : 255 / 224;
  var m = [
    ys, ys, ys,
    0, -cs2 * 2 * kb * (1 - kb) / kg, cs2 * 2 * (1 - kb),
    cs2 * 2 * (1 - kr), -cs2 * 2 * kr * (1 - kr) / kg, 0
  ];
  gl.uniformMatrix3fv(uMatrix, false, new Float32Array(m));
  gl.uniform3f(uOffset, full ? 0 : 16 / 255, 0.5, 0.5);
  lastCs = cs; lastRange = range;
}

function upload(i, ptr, stride, w, h) {
  var heap = Module.HEAPU8;
  gl.activeTexture(gl.TEXTURE0 + i);
  gl.bindTexture(gl.TEXTURE_2D, tex[i]);
  if (isGL2) {
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, heap.subarray(ptr, ptr + stride * h));
    return;
  }
  var src;
  if (stride === w) {
    src = heap.subarray(ptr, ptr + w * h);
  } else {
    if (!packed[i] || packed[i].length !== w * h) packed[i] = new Uint8Array(w * h);
    src = packed[i];
    for (var r = 0; r < h; r++) src.set(heap.subarray(ptr + r * stride, ptr + r * stride + w), r * w);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, src);
}

function draw() {
  var w = Module._dec_width(), h = Module._dec_height();
  if (!w || !h) return;
  if (glLost || gl.isContextLost()) return;
  if (w !== lastW || h !== lastH) {
    lastW = w; lastH = h;
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
    self.postMessage({ id: 'size', w: w, h: h });
  }
  var cs = Module._dec_colorspace(), range = Module._dec_color_range();
  if (Module._dec_format() === 12) range = 2;          // AV_PIX_FMT_YUVJ420P = full range
  if (cs !== lastCs || range !== lastRange) setColor(cs, range);
  upload(0, Module._dec_plane(0), Module._dec_stride(0), w, h);
  upload(1, Module._dec_plane(1), Module._dec_stride(1), w >> 1, h >> 1);
  upload(2, Module._dec_plane(2), Module._dec_stride(2), w >> 1, h >> 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/* ---------------------------------------------------------------- decode */

/** True when the access unit contains an SPS (7) or IDR slice (5). */
function hasKey(u8) {
  var n = u8.length;
  for (var i = 0; i + 3 < n; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) {
      var t = u8[i + 3] & 0x1f;
      if (t === 5 || t === 7) return true;
      i += 3;
    }
  }
  return false;
}

function decodeAU(u8, lost) {
  var key = hasKey(u8);
  if (key) { lostRef = false; refreshAsked = false; }
  else if (lost) lostRef = true;
  if (waitKey) {
    // Not a decoder problem: frames skipped here must not count as "too slow".
    if (!key) { stats.wait++; self.postMessage({ id: 'needkey' }); return; }
    Module._dec_flush();
  } else if (lostRef && !refreshAsked) {
    // Keep decoding (the picture moves, with artefacts) and ask once for a clean IDR;
    // the iPhone only sends one when asked.
    refreshAsked = true;
    self.postMessage({ id: 'refresh' });
  }
  if (u8.length > inCap) {
    if (inPtr) Module._free(inPtr);
    inCap = Math.max(u8.length * 2, 1 << 20);
    inPtr = Module._malloc(inCap);
  }
  Module.HEAPU8.set(u8, inPtr);
  var t0 = performance.now();
  var r = Module._dec_decode(inPtr, u8.length);
  if (r > 0) {
    draw();
    stats.ms += performance.now() - t0; stats.dec++;
    if (waitKey) { waitKey = false; self.postMessage({ id: 'key' }); }
  } else if (r < 0) {
    waitKey = true;
    self.postMessage({ id: 'needkey' });
  }
}

setInterval(function () {
  self.postMessage({ id: 'stats', dec: stats.dec, ms: stats.ms, wait: stats.wait });
  stats = { dec: 0, ms: 0, wait: 0 };
}, 1000);

self.onmessage = function (ev) {
  var d = ev.data;
  if (d.id === 'init') {
    if (!d.simd) { self.postMessage({ id: 'error', message: 'wasm simd unsupported' }); return; }
    try {
      initGL(d.canvas);
      importScripts('h264dec.js');
      // Fetch the module ourselves: the adapter's web server (libwebsockets 3.2) has no
      // MIME entry for .wasm and refuses unknown extensions, hence the .txt name.
      fetch('h264dec.wasm.txt', { cache: 'force-cache' }).then(function (r) {
        if (!r.ok) throw new Error('wasm http ' + r.status);
        return r.arrayBuffer();
      }).then(function (bin) {
        return createH264Dec({ wasmBinary: bin, locateFile: function (f) { return f; } });
      }).then(function (m) {
        Module = m;
        var r = Module._dec_init();
        if (r < 0) { self.postMessage({ id: 'error', message: 'dec_init ' + r }); return; }
        self.postMessage({ id: 'ready', gl2: isGL2 });
      }).catch(function (e) { self.postMessage({ id: 'error', message: 'wasm load: ' + (e && e.message) }); });
    } catch (e) {
      self.postMessage({ id: 'error', message: String(e && e.message) });
    }
  } else if (d.id === 'decode') {
    var off = d.off || 0, len = d.len === undefined ? d.data.byteLength - off : d.len;
    if (Module && len > 0) {
      try { decodeAU(new Uint8Array(d.data, off, len), !!d.lost); }
      catch (e) { self.postMessage({ id: 'error', message: String(e && e.message) }); }
    }
    self.postMessage({ id: 'done' });
  } else if (d.id === 'clear') {
    waitKey = true; lostRef = false; refreshAsked = false;
    lastW = lastH = 0;            // report the size of the next stream even if it is the same
    if (Module) Module._dec_flush();
    if (gl && !glLost && !gl.isContextLost()) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
  }
};
