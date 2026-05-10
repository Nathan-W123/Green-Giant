import {
  VERT_SHADER_SRC,
  FRAG_UNSHARP_SRC,
  FRAG_SMOOTH_SRC,
  FRAG_PASSTHROUGH_SRC,
} from './shaders.js';

// UpscalerPipeline - low-power rendering path:
//   1. Single-pass WebGL shader using mediump math and an RGB8 video texture
//   2. drawImage + CSS filter via 2D canvas as the baseline fallback

export class UpscalerPipeline {
  constructor(canvas, video, settings) {
    this._canvas = canvas;
    this._video = video;
    this._settings = { mode: 'balanced', ...settings };
    this._renderer = 'none'; // 'webgl' | '2d' | 'none'

    this._gl = null;
    this._programs = {};
    this._quadBuffer = null;
    this._texture = null;
    this._textureFormat = null;
    this._activeProgram = null;

    this._ctx2d = null;

    this._contextLostBound = this._handleWebGLContextLost.bind(this);
    this._contextRestoredBound = this._handleWebGLContextRestored.bind(this);
  }

  async init() {
    if (this._initWebGL()) return;
    if (this._initCanvas2D()) return;
    console.warn('[EcoUpscaler] No rendering backend available.');
  }

  processFrame() {
    if (this._renderer === 'webgl') return this._processFrameWebGL();
    if (this._renderer === '2d') return this._processFrame2D();
    return false;
  }

  updateSettings(settings) {
    this._settings = { ...this._settings, ...settings };
    if (this._renderer === 'webgl') this._selectProgram();
  }

  destroy() {
    if (this._gl) {
      this._canvas.removeEventListener('webglcontextlost', this._contextLostBound);
      this._canvas.removeEventListener('webglcontextrestored', this._contextRestoredBound);
      const ext = this._gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    this._gl = null;
    this._ctx2d = null;
    this._programs = {};
    this._quadBuffer = null;
    this._texture = null;
    this._textureFormat = null;
    this._activeProgram = null;
    this._renderer = 'none';
  }

  getRendererType() {
    return this._renderer;
  }

  _initWebGL() {
    try {
      const gl = this._canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        powerPreference: 'low-power',
      });
      if (!gl) return false;

      this._gl = gl;

      const unsharp = this._createShaderProgram(VERT_SHADER_SRC, FRAG_UNSHARP_SRC);
      const smooth = this._createShaderProgram(VERT_SHADER_SRC, FRAG_SMOOTH_SRC);
      const passthrough = this._createShaderProgram(VERT_SHADER_SRC, FRAG_PASSTHROUGH_SRC);
      if (!unsharp || !smooth || !passthrough) {
        this._gl = null;
        return false;
      }

      this._programs = { unsharp, smooth, passthrough };
      this._buildFullscreenQuad();
      this._initTexture();
      this._selectProgram();

      this._canvas.addEventListener('webglcontextlost', this._contextLostBound, false);
      this._canvas.addEventListener('webglcontextrestored', this._contextRestoredBound, false);

      this._renderer = 'webgl';
      console.log('[EcoUpscaler] WebGL active.');
      return true;
    } catch (e) {
      console.warn('[EcoUpscaler] WebGL init failed:', e.message);
      this._gl = null;
      return false;
    }
  }

  _createShaderProgram(vertSrc, fragSrc) {
    const gl = this._gl;
    const vert = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
      console.warn('[EcoUpscaler] Vert shader:', gl.getShaderInfoLog(vert));
      return null;
    }

    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      console.warn('[EcoUpscaler] Frag shader:', gl.getShaderInfoLog(frag));
      return null;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[EcoUpscaler] Program link:', gl.getProgramInfoLog(program));
      return null;
    }

    program.uTexture = gl.getUniformLocation(program, 'u_texture');
    program.uTexelSize = gl.getUniformLocation(program, 'u_texelSize');
    program.uStrength = gl.getUniformLocation(program, 'u_strength');
    program.uRadius = gl.getUniformLocation(program, 'u_radius');
    program.aPosition = gl.getAttribLocation(program, 'a_position');
    return program;
  }

  _buildFullscreenQuad() {
    const gl = this._gl;
    const verts = new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]);
    this._quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  }

  _initTexture() {
    const gl = this._gl;
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Video does not need alpha. RGB8 reduces texture memory and bandwidth by
    // 25% versus RGBA8 while keeping 8-bit color samples.
    this._textureFormat = gl.RGB;
  }

  _selectProgram() {
    this._activeProgram = this._programs.unsharp;
  }

  _getModeParams() {
    return { strength: 0.95, radius: 1.25 };
  }

  _processFrameWebGL() {
    const gl = this._gl;
    if (!gl || gl.isContextLost()) return false;

    try {
      gl.viewport(0, 0, this._canvas.width, this._canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);

      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          this._textureFormat,
          this._textureFormat,
          gl.UNSIGNED_BYTE,
          this._video,
        );
      } catch {
        this._textureFormat = gl.RGBA;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._video);
      }

      const program = this._activeProgram;
      gl.useProgram(program);

      const { strength, radius } = this._getModeParams();
      gl.uniform1i(program.uTexture, 0);
      if (program.uTexelSize) gl.uniform2f(program.uTexelSize, 1 / this._canvas.width, 1 / this._canvas.height);
      if (program.uStrength) gl.uniform1f(program.uStrength, strength);
      if (program.uRadius) gl.uniform1f(program.uRadius, radius);

      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
      gl.enableVertexAttribArray(program.aPosition);
      gl.vertexAttribPointer(program.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    } catch (e) {
      console.warn('[EcoUpscaler] WebGL frame error:', e.message);
      return false;
    }
  }

  _handleWebGLContextLost(e) {
    e.preventDefault();
    this._renderer = 'none';
  }

  _handleWebGLContextRestored() {
    this._programs = {};
    this._quadBuffer = null;
    this._texture = null;
    this._textureFormat = null;
    this._initWebGL();
  }

  _initCanvas2D() {
    try {
      this._ctx2d = this._canvas.getContext('2d');
      if (!this._ctx2d) return false;
      this._renderer = '2d';
      return true;
    } catch {
      return false;
    }
  }

  _processFrame2D() {
    const ctx = this._ctx2d;
    try {
      const mode = this._settings.mode;
      ctx.filter = mode === 'sharp' ? 'contrast(1.06) saturate(1.06)'
        : mode === 'balanced' ? 'contrast(1.03) saturate(1.04)'
        : 'none';
      ctx.drawImage(this._video, 0, 0, this._canvas.width, this._canvas.height);
      ctx.filter = 'none';
      return true;
    } catch (e) {
      console.warn('[EcoUpscaler] 2D frame error:', e.message);
      return false;
    }
  }
}
