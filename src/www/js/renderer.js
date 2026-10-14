/* Minimal frame renderer for an OffscreenCanvas. Uses WebGL (2 or 1) to upload
 * the VideoFrame as a texture; falls back to a 2D context when WebGL is missing.
 * The canvas backing store is resized to the frame size so CSS object-fit can
 * scale it without distortion.
 */
class TSLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.ctx2d = null;
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false, desynchronized: true }) ||
      canvas.getContext('webgl', { antialias: false, depth: false, alpha: false, desynchronized: true });
    if (gl) {
      try { this.initGL(gl); this.gl = gl; } catch (e) { this.gl = null; }
    }
    if (!this.gl) this.ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }

  initGL(gl) {
    const vs = `attribute vec2 xy; varying highp vec2 uv;
      void main(void) { gl_Position = vec4(xy, 0.0, 1.0); uv = vec2((1.0 + xy.x) / 2.0, (1.0 - xy.y) / 2.0); }`;
    const fs = `varying highp vec2 uv; uniform sampler2D tex;
      void main(void) { gl_FragColor = texture2D(tex, uv); }`;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const xy = gl.getAttribLocation(prog, 'xy');
    gl.vertexAttribPointer(xy, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(xy);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  render(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    if (this.gl) {
      const gl = this.gl;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    } else if (this.ctx2d) {
      this.ctx2d.drawImage(frame, 0, 0);
    }
    frame.close();
  }

  clear() {
    if (this.gl) {
      this.gl.clearColor(0, 0, 0, 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    } else if (this.ctx2d && this.canvas.width) {
      this.ctx2d.fillStyle = '#000';
      this.ctx2d.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}
