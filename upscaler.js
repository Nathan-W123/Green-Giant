import { render, ModeA, ModeAA, ModeC, ModeBB } from 'anime4k-webgpu';
import {
  VERT_SHADER_SRC,
  FRAG_UNSHARP_SRC,
  FRAG_SMOOTH_SRC,
  FRAG_PASSTHROUGH_SRC,
} from './shaders.js';

// UpscalerPipeline — three-tier rendering fallback:
//   1. Anime4K via WebGPU compute shaders (best quality, requires Chrome 113+)
//   2. Unsharp mask via WebGL fragment shader (good quality, wide support)
//   3. drawImage + CSS filter via 2D canvas (baseline, always works)
//
// Consumers call: await init(), processFrame(), updateSettings(), destroy().

export class UpscalerPipeline {
  constructor(canvas, video, settings) {
    this._canvas = canvas;
    this._video = video;
    this._settings = { mode: 'balanced', ...settings };
    this._renderer = 'none'; // 'anime4k' | 'webgl' | '2d' | 'none'

    // WebGL state
    this._gl = null;
    this._programs = {};
    this._quadBuffer = null;
    this._texture = null;
    this._activeProgram = null;

    // 2D state
    this._ctx2d = null;

    this._contextLostBound = this._handleWebGLContextLost.bind(this);
    this._contextRestoredBound = this._handleWebGLContextRestored.bind(this);
  }

  async init() {
    if (await this._initAnime4K()) return;
    if (this._initWebGL()) return;
    if (this._initCanvas2D()) return;
    console.warn('[EcoUpscaler] No rendering backend available.');
  }

  // processFrame() is called by FrameProcessor for the WebGL and 2D paths.
  // For the Anime4K path, render() drives its own internal loop — this is a no-op.
  processFrame() {
    if (this._renderer === 'anime4k') return true;
    if (this._renderer === 'webgl') return this._processFrameWebGL();
    if (this._renderer === '2d') return this._processFrame2D();
    return false;
  }

  updateSettings(settings) {
    this._settings = { ...this._settings, ...settings };
    // Anime4K: pipelineBuilder reads this._settings.mode on every frame automatically.
    // WebGL: switch the active shader program.
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
    this._activeProgram = null;
    this._renderer = 'none';
    // Anime4K's render() loop terminates naturally when the canvas is removed from DOM
    // by OverlayManager.destroy(), which invalidates the WebGPU canvas context.
  }

  getRendererType() {
    return this._renderer;
  }

  // ---------------------------------------------------------------------------
  // Tier 1: Anime4K via WebGPU
  // ---------------------------------------------------------------------------

  async _initAnime4K() {
    if (!navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      // Request device to confirm WebGPU is fully usable before committing the canvas context.
      await adapter.requestDevice();

      // render() configures the canvas as WebGPU and starts an internal frame loop.
      // The promise resolves once the loop is bound (quickly) — not when it ends.
      // pipelineBuilder is called every frame with the current video frame as inputTexture.
      await render({
        video: this._video,
        canvas: this._canvas,
        pipelineBuilder: (device, inputTexture) =>
          this._buildAnime4KPipeline(device, inputTexture),
      });

      this._renderer = 'anime4k';
      console.log('[EcoUpscaler] Anime4K WebGPU active.');
      return true;
    } catch (e) {
      console.warn('[EcoUpscaler] Anime4K/WebGPU unavailable:', e.message);
      return false;
    }
  }

  // Called every frame by the anime4k-webgpu render loop.
  // Reading this._settings.mode here means live mode-switching is free — no restart needed.
  _buildAnime4KPipeline(device, inputTexture) {
    const mode = this._settings.mode;
    const base = {
      device,
      inputTexture,
      nativeDimensions: {
        width: this._video.videoWidth || this._canvas.width,
        height: this._video.videoHeight || this._canvas.height,
      },
      targetDimensions: {
        width: this._canvas.width,
        height: this._canvas.height,
      },
    };

    // Preset mapping for live-action YouTube content:
    //   smooth      → ModeC  (CNN upscale only, fastest, no artifact restoration)
    //   balanced    → ModeA  (Restore CNN + CNN upscale — recommended for YouTube)
    //   sharp       → ModeAA (stronger restore + upscale, more processing)
    //   experimental→ ModeBB (soft-restore variant, maximum quality attempt)
    switch (mode) {
      case 'smooth':       return [new ModeC(base)];
      case 'sharp':        return [new ModeAA(base)];
      case 'experimental': return [new ModeBB(base)];
      case 'balanced':
      default:             return [new ModeA(base)];
    }
  }

  // ---------------------------------------------------------------------------
  // Tier 2: WebGL unsharp mask (fallback when WebGPU unavailable)
  // ---------------------------------------------------------------------------

  _initWebGL() {
    try {
      const gl = this._canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) return false;

      this._gl = gl;

      const unsharp     = this._createShaderProgram(VERT_SHADER_SRC, FRAG_UNSHARP_SRC);
      const smooth      = this._createShaderProgram(VERT_SHADER_SRC, FRAG_SMOOTH_SRC);
      const passthrough = this._createShaderProgram(VERT_SHADER_SRC, FRAG_PASSTHROUGH_SRC);
      if (!unsharp || !smooth || !passthrough) { this._gl = null; return false; }

      this._programs = { unsharp, smooth, passthrough };
      this._buildFullscreenQuad();
      this._initTexture();
      this._selectProgram();

      this._canvas.addEventListener('webglcontextlost', this._contextLostBound, false);
      this._canvas.addEventListener('webglcontextrestored', this._contextRestoredBound, false);

      this._renderer = 'webgl';
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
    program.uTexture   = gl.getUniformLocation(program, 'u_texture');
    program.uTexelSize = gl.getUniformLocation(program, 'u_texelSize');
    program.uStrength  = gl.getUniformLocation(program, 'u_strength');
    program.uRadius    = gl.getUniformLocation(program, 'u_radius');
    program.aPosition  = gl.getAttribLocation(program, 'a_position');
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
    // CLAMP_TO_EDGE required for non-power-of-two video frame dimensions.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  _selectProgram() {
    const mode = this._settings.mode;
    this._activeProgram = mode === 'smooth' ? this._programs.smooth
      : mode === 'off' ? this._programs.passthrough
      : this._programs.unsharp;
  }

  _getModeParams(mode) {
    const params = {
      off:          { strength: 0.0, radius: 1.0 },
      smooth:       { strength: 0.0, radius: 1.0 },
      balanced:     { strength: 0.4, radius: 1.0 },
      sharp:        { strength: 0.8, radius: 1.2 },
      experimental: { strength: 1.0, radius: 1.5 },
    };
    return params[mode] ?? params.balanced;
  }

  _processFrameWebGL() {
    const gl = this._gl;
    if (!gl || gl.isContextLost()) return false;
    try {
      gl.viewport(0, 0, this._canvas.width, this._canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._video);

      const program = this._activeProgram;
      gl.useProgram(program);
      const { strength, radius } = this._getModeParams(this._settings.mode);
      gl.uniform1i(program.uTexture, 0);
      if (program.uTexelSize) gl.uniform2f(program.uTexelSize, 1 / this._canvas.width, 1 / this._canvas.height);
      if (program.uStrength)  gl.uniform1f(program.uStrength, strength);
      if (program.uRadius)    gl.uniform1f(program.uRadius, radius);

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
    this._initWebGL();
  }

  // ---------------------------------------------------------------------------
  // Tier 3: 2D canvas (last-resort fallback)
  // ---------------------------------------------------------------------------

  _initCanvas2D() {
    try {
      this._ctx2d = this._canvas.getContext('2d');
      if (!this._ctx2d) return false;
      this._renderer = '2d';
      return true;
    } catch (e) {
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
