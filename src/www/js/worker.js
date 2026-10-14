/* WebCodecs decode worker: receives Annex-B H.264 access units, decodes with
 * VideoDecoder and paints to an OffscreenCanvas (WebGL when available, 2D otherwise).
 */
importScripts('renderer.js');

var renderer = null;
var decoder = null;
var waitKeyFrame = true;
var canvas = null;
var lastW = 0, lastH = 0;

function createDecoder() {
  if (decoder) { try { decoder.close(); } catch (e) { /* ignore */ } }
  decoder = new VideoDecoder({
    output: function (frame) {
      var t0 = performance.now();
      if (frame.displayWidth !== lastW || frame.displayHeight !== lastH) {
        lastW = frame.displayWidth; lastH = frame.displayHeight;
        self.postMessage({ id: 'size', w: lastW, h: lastH });
      }
      renderer.render(frame);
      self.postMessage({ id: 'painted', n: 1, ms: performance.now() - t0 });
    },
    error: function (e) {
      self.postMessage({ id: 'error', message: String(e && e.message) });
      waitKeyFrame = true;
      createDecoder();
    }
  });
  decoder.configure({ codec: 'avc1.64001f', optimizeForLatency: true });
}

function init(c) {
  canvas = c;
  renderer = new TSLRenderer(canvas);
  createDecoder();
  waitKeyFrame = true;
}

function decode(data) {
  if (!decoder || decoder.state !== 'configured') return;
  var nal = data[4] & 0x1f;
  var isKey = nal === 7 || nal === 5;
  if (waitKeyFrame) {
    if (!isKey) { self.postMessage({ id: 'sps' }); return; }
    waitKeyFrame = false;
    self.postMessage({ id: 'key' });
  }
  try {
    decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: Math.round(performance.now() * 1000), data: data }));
  } catch (e) {
    self.postMessage({ id: 'error', message: String(e && e.message) });
    waitKeyFrame = true;
  }
}

self.addEventListener('message', function (event) {
  var d = event.data;
  switch (d.id) {
    case 'init': init(d.canvas); break;
    case 'decode': decode(d.data); break;
    case 'clear':
      if (renderer) renderer.clear();
      waitKeyFrame = true;
      break;
  }
});
