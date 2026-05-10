(() => {
  // shaders.js
  var VERT_SHADER_SRC = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;

  void main() {
    // Map clip-space [-1,1] to UV [0,1].
    // Y is flipped because WebGL texture origin is bottom-left; video frames are top-left.
    v_texCoord = vec2(
      (a_position.x + 1.0) * 0.5,
      (1.0 - a_position.y) * 0.5
    );
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;
  var FRAG_UNSHARP_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  uniform vec2 u_texelSize;
  uniform float u_strength;
  uniform float u_radius;

  varying vec2 v_texCoord;

  void main() {
    vec2 uv = v_texCoord;
    vec4 center = texture2D(u_texture, uv);

    vec2 off = u_texelSize * u_radius;
    vec4 blur = (
      texture2D(u_texture, uv + vec2(-off.x, -off.y)) +
      texture2D(u_texture, uv + vec2( off.x, -off.y)) +
      texture2D(u_texture, uv + vec2(-off.x,  off.y)) +
      texture2D(u_texture, uv + vec2( off.x,  off.y))
    ) * 0.25;

    vec4 sharpened = center + (center - blur) * u_strength;
    gl_FragColor = clamp(sharpened, 0.0, 1.0);
  }
`;
  var FRAG_SMOOTH_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  varying vec2 v_texCoord;

  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
  }
`;
  var FRAG_PASSTHROUGH_SRC = `
  precision mediump float;

  uniform sampler2D u_texture;
  varying vec2 v_texCoord;

  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
  }
`;

  // upscaler.js
  var UpscalerPipeline = class {
    constructor(canvas, video, settings) {
      this._canvas = canvas;
      this._video = video;
      this._settings = { mode: "balanced", ...settings };
      this._renderer = "none";
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
      console.warn("[EcoUpscaler] No rendering backend available.");
    }
    processFrame() {
      if (this._renderer === "webgl") return this._processFrameWebGL();
      if (this._renderer === "2d") return this._processFrame2D();
      return false;
    }
    updateSettings(settings) {
      this._settings = { ...this._settings, ...settings };
      if (this._renderer === "webgl") this._selectProgram();
    }
    destroy() {
      if (this._gl) {
        this._canvas.removeEventListener("webglcontextlost", this._contextLostBound);
        this._canvas.removeEventListener("webglcontextrestored", this._contextRestoredBound);
        const ext = this._gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
      this._gl = null;
      this._ctx2d = null;
      this._programs = {};
      this._quadBuffer = null;
      this._texture = null;
      this._textureFormat = null;
      this._activeProgram = null;
      this._renderer = "none";
    }
    getRendererType() {
      return this._renderer;
    }
    _initWebGL() {
      try {
        const gl = this._canvas.getContext("webgl", {
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          preserveDrawingBuffer: true,
          powerPreference: "low-power"
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
        this._canvas.addEventListener("webglcontextlost", this._contextLostBound, false);
        this._canvas.addEventListener("webglcontextrestored", this._contextRestoredBound, false);
        this._renderer = "webgl";
        console.log("[EcoUpscaler] WebGL active.");
        return true;
      } catch (e) {
        console.warn("[EcoUpscaler] WebGL init failed:", e.message);
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
        console.warn("[EcoUpscaler] Vert shader:", gl.getShaderInfoLog(vert));
        return null;
      }
      const frag = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(frag, fragSrc);
      gl.compileShader(frag);
      if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
        console.warn("[EcoUpscaler] Frag shader:", gl.getShaderInfoLog(frag));
        return null;
      }
      const program = gl.createProgram();
      gl.attachShader(program, vert);
      gl.attachShader(program, frag);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn("[EcoUpscaler] Program link:", gl.getProgramInfoLog(program));
        return null;
      }
      program.uTexture = gl.getUniformLocation(program, "u_texture");
      program.uTexelSize = gl.getUniformLocation(program, "u_texelSize");
      program.uStrength = gl.getUniformLocation(program, "u_strength");
      program.uRadius = gl.getUniformLocation(program, "u_radius");
      program.aPosition = gl.getAttribLocation(program, "a_position");
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
      this._textureFormat = gl.RGB;
    }
    _selectProgram() {
      this._activeProgram = this._programs.unsharp;
    }
    _getModeParams() {
      return { strength: 0.76, radius: 1.1 };
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
            this._video
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
        console.warn("[EcoUpscaler] WebGL frame error:", e.message);
        return false;
      }
    }
    _handleWebGLContextLost(e) {
      e.preventDefault();
      this._renderer = "none";
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
        this._ctx2d = this._canvas.getContext("2d");
        if (!this._ctx2d) return false;
        this._renderer = "2d";
        return true;
      } catch {
        return false;
      }
    }
    _processFrame2D() {
      const ctx = this._ctx2d;
      try {
        const mode = this._settings.mode;
        ctx.filter = mode === "sharp" ? "contrast(1.06) saturate(1.06)" : mode === "balanced" ? "contrast(1.03) saturate(1.04)" : "none";
        ctx.drawImage(this._video, 0, 0, this._canvas.width, this._canvas.height);
        ctx.filter = "none";
        return true;
      } catch (e) {
        console.warn("[EcoUpscaler] 2D frame error:", e.message);
        return false;
      }
    }
  };

  // ai-upscaler.js
  var MODEL_IN = 224;
  var MODEL_OUT = 672;
  var AI_INTERVAL_MS = 250;
  var AITileUpscaler = class {
    constructor(container, video) {
      this._container = container;
      this._video = video;
      this._canvas = null;
      this._ctx = null;
      this._session = null;
      this._inputDtype = "float32";
      this._ready = false;
      this._lastMs = 0;
      this._scratch = document.createElement("canvas");
      this._scratch2 = document.createElement("canvas");
      this._sctx = this._scratch.getContext("2d");
      this._sctx2 = this._scratch2.getContext("2d");
    }
    async init() {
      try {
        await this._initORT();
        this._createCanvas();
        this._ready = true;
        console.log("[EcoUpscaler] AI upscaler ready (full-frame mode).");
      } catch (e) {
        console.warn("[EcoUpscaler] AI upscaler unavailable:", e.message);
        this._ready = false;
      }
      return this._ready;
    }
    get isReady() {
      return this._ready;
    }
    async processFrame() {
      if (!this._ready) return;
      const now = performance.now();
      if (now - this._lastMs < AI_INTERVAL_MS) return;
      this._lastMs = now;
      const video = this._video;
      if (!video || video.paused || video.readyState < 2) return;
      this._syncSize();
      await this._enhanceFullFrame(video);
    }
    resize() {
      this._syncSize();
    }
    destroy() {
      this._ready = false;
      if (this._canvas) {
        this._canvas.remove();
        this._canvas = null;
      }
      if (this._session) {
        this._session.release?.();
        this._session = null;
      }
    }
    // ── private ────────────────────────────────────────────────────────────────
    async _initORT() {
      const ort = window.ort;
      if (!ort) throw new Error("window.ort not found \u2014 ensure lib/ort.min.js loads first");
      ort.env.wasm.wasmPaths = chrome.runtime.getURL("lib/");
      ort.env.wasm.numThreads = 1;
      const candidates = [
        { file: "models/super-resolution-fp16.onnx", dtype: "float16" },
        { file: "models/super-resolution-int8.onnx", dtype: "float32" },
        { file: "models/super-resolution-10.onnx", dtype: "float32" }
      ];
      let modelUrl = null;
      let dtype = "float32";
      for (const c of candidates) {
        const url = chrome.runtime.getURL(c.file);
        try {
          const res = await fetch(url, { method: "HEAD" });
          if (res.ok) {
            modelUrl = url;
            dtype = c.dtype;
            break;
          }
        } catch {
        }
      }
      if (!modelUrl) throw new Error("No model file found in models/");
      this._session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["webgl", "wasm"],
        graphOptimizationLevel: "all"
      });
      this._inputDtype = dtype;
      console.log(`[EcoUpscaler] Loaded ${modelUrl.split("/").pop()} (${dtype})`);
    }
    _createCanvas() {
      const canvas = document.createElement("canvas");
      canvas.id = "eco-ai-overlay";
      Object.assign(canvas.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "51"
      });
      this._container.appendChild(canvas);
      this._canvas = canvas;
      this._ctx = canvas.getContext("2d");
      this._syncSize();
    }
    _syncSize() {
      if (!this._canvas) return;
      const dpr = devicePixelRatio || 1;
      const w = Math.round(this._container.clientWidth * dpr);
      const h = Math.round(this._container.clientHeight * dpr);
      if (this._canvas.width !== w || this._canvas.height !== h) {
        this._canvas.width = w;
        this._canvas.height = h;
      }
    }
    async _enhanceFullFrame(video) {
      this._scratch.width = MODEL_IN;
      this._scratch.height = MODEL_IN;
      this._sctx.drawImage(video, 0, 0, MODEL_IN, MODEL_IN);
      const frameData = this._sctx.getImageData(0, 0, MODEL_IN, MODEL_IN).data;
      const luma = new Float32Array(MODEL_IN * MODEL_IN);
      for (let i = 0; i < MODEL_IN * MODEL_IN; i++) {
        luma[i] = (0.299 * frameData[i * 4] + 0.587 * frameData[i * 4 + 1] + 0.114 * frameData[i * 4 + 2]) / 255;
      }
      const ort = window.ort;
      let outLuma;
      try {
        let inputData = luma;
        let dtype = this._inputDtype ?? "float32";
        if (dtype === "float16") {
          if (typeof Float16Array !== "undefined") {
            inputData = new Float16Array(luma);
          } else {
            dtype = "float32";
          }
        }
        const feeds = { input: new ort.Tensor(dtype, inputData, [1, 1, MODEL_IN, MODEL_IN]) };
        const results = await this._session.run(feeds);
        outLuma = results[Object.keys(results)[0]].data;
      } catch (e) {
        console.warn("[EcoUpscaler] Inference error:", e.message);
        return;
      }
      this._scratch2.width = MODEL_OUT;
      this._scratch2.height = MODEL_OUT;
      this._sctx2.drawImage(video, 0, 0, MODEL_OUT, MODEL_OUT);
      const chromaData = this._sctx2.getImageData(0, 0, MODEL_OUT, MODEL_OUT).data;
      const outPixels = new Uint8ClampedArray(MODEL_OUT * MODEL_OUT * 4);
      for (let i = 0; i < MODEL_OUT * MODEL_OUT; i++) {
        const aiL = Math.max(0, Math.min(1, outLuma[i]));
        const origL = Math.max(
          1e-3,
          (0.299 * chromaData[i * 4] + 0.587 * chromaData[i * 4 + 1] + 0.114 * chromaData[i * 4 + 2]) / 255
        );
        const ratio = aiL / origL;
        outPixels[i * 4] = Math.min(255, chromaData[i * 4] * ratio);
        outPixels[i * 4 + 1] = Math.min(255, chromaData[i * 4 + 1] * ratio);
        outPixels[i * 4 + 2] = Math.min(255, chromaData[i * 4 + 2] * ratio);
        outPixels[i * 4 + 3] = 255;
      }
      this._scratch2.width = MODEL_OUT;
      this._scratch2.height = MODEL_OUT;
      this._sctx2.putImageData(new ImageData(outPixels, MODEL_OUT, MODEL_OUT), 0, 0);
      this._ctx.drawImage(this._scratch2, 0, 0, this._canvas.width, this._canvas.height);
    }
  };

  // content.js
  var SettingsManager = class {
    constructor() {
      this._settings = this._defaults();
      this._changeCallbacks = [];
    }
    _defaults() {
      return {
        enabled: false,
        debugMode: false,
        status: "off"
      };
    }
    async load() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(this._defaults(), (stored) => {
            this._settings = stored;
            resolve(this._settings);
          });
        } catch {
          resolve(this._defaults());
        }
      });
    }
    async save(partial) {
      this._settings = { ...this._settings, ...partial };
      try {
        chrome.storage.local.set(this._settings);
      } catch {
      }
    }
    get() {
      return { ...this._settings };
    }
    onChange(callback) {
      this._changeCallbacks.push(callback);
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local") return;
          const updated = {};
          for (const [key, { newValue }] of Object.entries(changes)) {
            updated[key] = newValue;
          }
          this._settings = { ...this._settings, ...updated };
          callback(this._settings, updated);
        });
      } catch {
      }
    }
  };
  var VideoDetector = class {
    constructor() {
      this._video = null;
      this._searchObserver = null;
      this._replacementObserver = null;
      this.onVideoFound = null;
      this.onVideoReplaced = null;
    }
    start() {
      const video = this._findVideo();
      if (video) {
        this._video = video;
        this._observeVideoReplacement(video);
        if (this.onVideoFound) this.onVideoFound(video);
      } else {
        this._observeForVideo();
      }
    }
    stop() {
      if (this._searchObserver) {
        this._searchObserver.disconnect();
        this._searchObserver = null;
      }
      if (this._replacementObserver) {
        this._replacementObserver.disconnect();
        this._replacementObserver = null;
      }
      this._video = null;
    }
    getVideo() {
      return this._video;
    }
    _findVideo() {
      return document.querySelector("#movie_player video") || document.querySelector(".html5-main-video") || document.querySelector("ytd-player video") || document.querySelector("video[src]") || null;
    }
    _observeForVideo() {
      const target = document.querySelector("#movie_player") || document.body;
      this._searchObserver = new MutationObserver(() => {
        const video = this._findVideo();
        if (video) {
          this._searchObserver.disconnect();
          this._searchObserver = null;
          this._video = video;
          this._observeVideoReplacement(video);
          if (this.onVideoFound) this.onVideoFound(video);
        }
      });
      this._searchObserver.observe(target, { childList: true, subtree: true });
    }
    _observeVideoReplacement(video) {
      const parent = video.parentElement;
      if (!parent) return;
      this._replacementObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.removedNodes) {
            if (node === video) {
              this._replacementObserver.disconnect();
              this._replacementObserver = null;
              setTimeout(() => {
                const newVideo = this._findVideo();
                if (newVideo && newVideo !== video) {
                  this._video = newVideo;
                  this._observeVideoReplacement(newVideo);
                  if (this.onVideoReplaced) this.onVideoReplaced(newVideo);
                }
              }, 100);
            }
          }
        }
      });
      this._replacementObserver.observe(parent, { childList: true });
    }
  };
  var OverlayManager = class {
    constructor() {
      this._canvas = null;
      this._video = null;
      this._player = null;
      this._resizeObserver = null;
      this._fsHandler = null;
      this._theaterObserver = null;
    }
    create(video) {
      this._video = video;
      this._player = document.querySelector("#movie_player") || video.parentElement;
      const canvas = document.createElement("canvas");
      canvas.id = "eco-upscaler-overlay";
      Object.assign(canvas.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "50",
        imageRendering: "auto"
      });
      this._player.appendChild(canvas);
      this._canvas = canvas;
      this._updateCanvasSize();
      this._startResizeObserver();
      this._handleFullscreen();
      this._handleTheaterMode();
      return canvas;
    }
    destroy() {
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
        this._resizeObserver = null;
      }
      if (this._theaterObserver) {
        this._theaterObserver.disconnect();
        this._theaterObserver = null;
      }
      if (this._fsHandler) {
        document.removeEventListener("fullscreenchange", this._fsHandler);
        this._fsHandler = null;
      }
      if (this._canvas) {
        this._canvas.remove();
        this._canvas = null;
      }
      this._video = null;
      this._player = null;
    }
    getCanvas() {
      return this._canvas;
    }
    setVisible(visible) {
      if (this._canvas) {
        this._canvas.style.display = visible ? "block" : "none";
      }
    }
    _updateCanvasSize() {
      const canvas = this._canvas;
      const container = this._player;
      if (!canvas || !container) return;
      const dpr = devicePixelRatio || 1;
      const inFS = !!document.fullscreenElement;
      const w = inFS ? window.innerWidth : container.clientWidth;
      const h = inFS ? window.innerHeight : container.clientHeight;
      if (w === 0 || h === 0) return;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
    }
    _startResizeObserver() {
      this._resizeObserver = new ResizeObserver(() => this._updateCanvasSize());
      this._resizeObserver.observe(this._player);
    }
    _handleFullscreen() {
      this._fsHandler = () => requestAnimationFrame(
        () => requestAnimationFrame(() => this._updateCanvasSize())
      );
      document.addEventListener("fullscreenchange", this._fsHandler);
    }
    _handleTheaterMode() {
      document.addEventListener("yt-set-theater-mode-enabled", () => {
        setTimeout(() => this._updateCanvasSize(), 50);
      });
      const app = document.querySelector("ytd-app");
      if (app) {
        this._theaterObserver = new MutationObserver(() => {
          setTimeout(() => this._updateCanvasSize(), 50);
        });
        this._theaterObserver.observe(app, { attributes: true, attributeFilter: ["theater"] });
      }
    }
  };
  var FrameProcessor = class {
    constructor() {
      this._running = false;
      this._video = null;
      this._pipeline = null;
      this._aiUpscaler = null;
      this._perfMonitor = null;
      this._rafId = null;
      this._useRVFC = false;
    }
    start(video, pipeline, perfMonitor, aiUpscaler = null) {
      this.stop();
      this._video = video;
      this._pipeline = pipeline;
      this._aiUpscaler = aiUpscaler;
      this._perfMonitor = perfMonitor;
      this._running = true;
      this._useRVFC = typeof video.requestVideoFrameCallback === "function";
      if (this._useRVFC) {
        this._rVFCLoop = this._rVFCLoop.bind(this);
        video.requestVideoFrameCallback(this._rVFCLoop);
      } else {
        this._rAFLoop = this._rAFLoop.bind(this);
        this._rafId = requestAnimationFrame(this._rAFLoop);
      }
    }
    stop() {
      this._running = false;
      if (this._rafId !== null) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
    }
    _rVFCLoop() {
      if (!this._running) return;
      this._processOneFrame();
      this._video.requestVideoFrameCallback(this._rVFCLoop);
    }
    _rAFLoop() {
      if (!this._running) return;
      this._processOneFrame();
      this._rafId = requestAnimationFrame(this._rAFLoop);
    }
    _processOneFrame() {
      const video = this._video;
      if (!video) return;
      if (document.hidden) return;
      if (video.paused || video.ended) return;
      if (video.readyState < 2) return;
      const t0 = performance.now();
      this._pipeline.processFrame();
      this._perfMonitor.recordFrame(performance.now() - t0);
      if (this._aiUpscaler) this._aiUpscaler.processFrame();
    }
  };
  var PerformanceMonitor = class {
    constructor() {
      this._frameTimes = new Float32Array(30);
      this._frameIndex = 0;
      this._frameCount = 0;
      this._degraded = false;
      this._onDegrade = null;
      this._onRecover = null;
      this._onDisable = null;
    }
    recordFrame(durationMs) {
      this._frameTimes[this._frameIndex % 30] = durationMs;
      this._frameIndex++;
      this._frameCount++;
      if (this._frameCount % 30 !== 0) return;
      const avg = this._frameTimes.reduce((a, b) => a + b, 0) / 30;
      const fps = avg > 0 ? 1e3 / avg : 60;
      if (fps < 10 && this._onDisable) {
        this._onDisable();
      } else if (fps < 20 && !this._degraded) {
        this._degraded = true;
        if (this._onDegrade) this._onDegrade(fps);
      } else if (fps >= 30 && this._degraded) {
        this._degraded = false;
        if (this._onRecover) this._onRecover(fps);
      }
    }
    getAverageFPS() {
      if (this._frameCount === 0) return 0;
      const count = Math.min(this._frameCount, 30);
      const slice = Array.from(this._frameTimes).slice(0, count);
      const avg = slice.reduce((a, b) => a + b, 0) / count;
      return avg > 0 ? Math.round(1e3 / avg) : 0;
    }
    onDegrade(cb) {
      this._onDegrade = cb;
    }
    onRecover(cb) {
      this._onRecover = cb;
    }
    onDisable(cb) {
      this._onDisable = cb;
    }
    reset() {
      this._frameTimes.fill(0);
      this._frameIndex = 0;
      this._frameCount = 0;
      this._degraded = false;
    }
  };
  var BackgroundQualityManager = class {
    constructor(settingsManager) {
      this._settingsManager = settingsManager;
      this._player = null;
      this._savedQuality = null;
      this._boundUpdate = this._update.bind(this);
    }
    start(player) {
      this._player = player;
      document.addEventListener("visibilitychange", this._boundUpdate);
      this._update();
    }
    stop() {
      document.removeEventListener("visibilitychange", this._boundUpdate);
      this._restore();
      this._player = null;
    }
    refresh() {
      this._update();
    }
    _update() {
      if (!this._settingsManager.get().enabled) {
        this._restore();
        return;
      }
      if (document.hidden) this._lower();
      else this._restore();
    }
    _lower() {
      const player = this._player || document.querySelector("#movie_player");
      if (!player) return;
      try {
        if (!this._savedQuality && typeof player.getPlaybackQuality === "function") {
          this._savedQuality = player.getPlaybackQuality();
        }
        if (typeof player.setPlaybackQualityRange === "function") player.setPlaybackQualityRange("tiny", "tiny");
        if (typeof player.setPlaybackQuality === "function") player.setPlaybackQuality("tiny");
      } catch {
      }
    }
    _restore() {
      const player = this._player || document.querySelector("#movie_player");
      if (!player || !this._savedQuality) return;
      try {
        if (typeof player.setPlaybackQualityRange === "function") player.setPlaybackQualityRange(this._savedQuality, this._savedQuality);
        if (typeof player.setPlaybackQuality === "function") player.setPlaybackQuality(this._savedQuality);
      } catch {
      }
      this._savedQuality = null;
    }
  };
  var _YT_BITRATE = {
    2160: { 30: 16, 60: 24 },
    1440: { 30: 8, 60: 13 },
    1080: { 30: 5, 60: 8 },
    720: { 30: 3, 60: 5 },
    480: { 30: 1.5, 60: 2.5 },
    360: { 30: 0.8, 60: 1.2 }
  };
  var _WH_PER_GB_FIXED = 2.5;
  var _WH_PER_GB_4G = 7;
  var _WH_PER_GB_3G = 18;
  var _WH_PER_GB_2G = 40;
  var _MAX_DECODE_W = 5;
  var _PX_4K = 3840 * 2160;
  function _whPerGb(connType, effectiveType) {
    if (connType === "wifi" || connType === "ethernet") return _WH_PER_GB_FIXED;
    if (connType === "cellular") {
      if (effectiveType === "4g") return _WH_PER_GB_4G;
      if (effectiveType === "3g") return _WH_PER_GB_3G;
      return _WH_PER_GB_2G;
    }
    if (effectiveType === "4g") return (_WH_PER_GB_FIXED + _WH_PER_GB_4G) / 2;
    if (effectiveType === "3g") return _WH_PER_GB_3G;
    return _WH_PER_GB_2G;
  }
  function _ytBitrate(height, fps) {
    const heights = [2160, 1440, 1080, 720, 480, 360];
    const h = heights.find((t) => height >= t) ?? 360;
    return _YT_BITRATE[h]?.[fps > 35 ? 60 : 30] ?? 5;
  }
  var _CO2_BY_ZONE = {
    "America/New_York": 380,
    "America/Chicago": 420,
    "America/Denver": 350,
    "America/Los_Angeles": 210,
    "America/Phoenix": 400,
    "America/Toronto": 130,
    "America/Vancouver": 25,
    "America/Sao_Paulo": 100,
    "America/Mexico_City": 450,
    "America/Lima": 290,
    "America/Bogota": 200,
    "America/Santiago": 240,
    "America/Buenos_Aires": 380,
    "Europe/London": 180,
    "Europe/Paris": 70,
    "Europe/Berlin": 360,
    "Europe/Amsterdam": 290,
    "Europe/Madrid": 160,
    "Europe/Rome": 230,
    "Europe/Warsaw": 650,
    "Europe/Stockholm": 40,
    "Europe/Oslo": 30,
    "Europe/Zurich": 90,
    "Europe/Helsinki": 90,
    "Europe/Vienna": 180,
    "Europe/Brussels": 150,
    "Europe/Copenhagen": 160,
    "Europe/Dublin": 280,
    "Europe/Lisbon": 170,
    "Europe/Prague": 430,
    "Europe/Budapest": 250,
    "Europe/Bucharest": 290,
    "Europe/Athens": 320,
    "Europe/Istanbul": 420,
    "Asia/Tokyo": 460,
    "Asia/Shanghai": 580,
    "Asia/Seoul": 400,
    "Asia/Kolkata": 640,
    "Asia/Singapore": 380,
    "Asia/Dubai": 400,
    "Asia/Hong_Kong": 580,
    "Asia/Taipei": 480,
    "Asia/Bangkok": 520,
    "Asia/Jakarta": 700,
    "Asia/Karachi": 380,
    "Asia/Dhaka": 540,
    "Australia/Sydney": 620,
    "Australia/Melbourne": 620,
    "Australia/Brisbane": 690,
    "Australia/Perth": 620,
    "Australia/Adelaide": 480,
    "Pacific/Auckland": 130,
    "Pacific/Honolulu": 700,
    "Africa/Johannesburg": 700,
    "Africa/Cairo": 460,
    "Africa/Lagos": 480,
    "Africa/Nairobi": 200
  };
  var _CO2_REGIONAL_AVG = {
    America: 350,
    Europe: 250,
    Asia: 500,
    Africa: 580,
    Australia: 620,
    Pacific: 400,
    Indian: 450,
    Atlantic: 350
  };
  var _CO2_GLOBAL_AVG = 450;
  function _getCarbonIntensity() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const exact = _CO2_BY_ZONE[tz];
      if (exact !== void 0) return exact;
      return _CO2_REGIONAL_AVG[tz.split("/")[0]] ?? _CO2_GLOBAL_AVG;
    } catch {
      return _CO2_GLOBAL_AVG;
    }
  }
  var _YT_QUALITY_HEIGHT = {
    highres: 4320,
    hd2160: 2160,
    hd1440: 1440,
    hd1080: 1080,
    hd720: 720,
    large: 480,
    medium: 360,
    small: 240,
    tiny: 144
  };
  function _getMaxAvailableHeight() {
    try {
      const player = document.querySelector("#movie_player");
      const levels = player?.getAvailableQualityLevels?.();
      if (Array.isArray(levels) && levels.length > 0) {
        let max = 0;
        for (const l of levels) {
          const h = _YT_QUALITY_HEIGHT[l];
          if (h && h > max) max = h;
        }
        if (max > 0) return Math.min(max, 2160);
      }
    } catch {
    }
    return 2160;
  }
  var EnergyTracker = class {
    constructor() {
      this._startMs = null;
      this._video = null;
      this._sessionWh = 0;
      this._totalWh = 0;
      this._currentRate = 0;
      this._interval = null;
      this._onUpdate = null;
      this._lastFrames = null;
      this._lastFrameMs = null;
      this._lastDecodedBytes = null;
      this._lastDecodedBytesMs = null;
      this._carbonIntensity = _getCarbonIntensity();
      this._referenceHeight = 2160;
    }
    async load() {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get({ ecoTotalWh: 0 }, (res) => {
            this._totalWh = typeof res.ecoTotalWh === "number" ? res.ecoTotalWh : 0;
            resolve();
          });
        } catch {
          resolve();
        }
      });
    }
    begin(video, onUpdate) {
      if (this._interval) return;
      this._video = video;
      this._onUpdate = onUpdate;
      this._startMs = Date.now();
      this._interval = setInterval(() => this._tick(), 1e4);
    }
    end() {
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
      }
      this._flush();
      this._startMs = null;
      this._video = null;
      this._persist();
      if (this._onUpdate) this._onUpdate();
    }
    destroy() {
      this.end();
      this._sessionWh = 0;
      this._currentRate = 0;
      this._onUpdate = null;
      this._lastFrames = null;
      this._lastFrameMs = null;
      this._lastDecodedBytes = null;
      this._lastDecodedBytesMs = null;
      this._referenceHeight = 2160;
    }
    // Returns a display string: rate line + lifetime line (newline-separated).
    formatDisplay() {
      const total = this._totalWh;
      const rate = this._currentRate;
      const ci = this._carbonIntensity;
      const refLabel = this._referenceHeight >= 2160 ? "4K" : `${this._referenceHeight}p`;
      const co2RateG = rate * ci / 1e3;
      const co2TotalG = total * ci / 1e3;
      const rateStr = rate >= 0.1 ? `~${rate.toFixed(1)} Wh/hr \xB7 ~${co2RateG.toFixed(0)}g CO\u2082/hr vs ${refLabel}` : null;
      let totalStr = null;
      if (total >= 0.05) {
        const whStr = total < 1e3 ? `${total.toFixed(1)} Wh` : `${(total / 1e3).toFixed(2)} kWh`;
        const co2Str = co2TotalG < 1e3 ? `${co2TotalG.toFixed(0)}g CO\u2082` : `${(co2TotalG / 1e3).toFixed(2)}kg CO\u2082`;
        totalStr = `${whStr} \xB7 ${co2Str} saved`;
      }
      if (!rateStr && !totalStr) return "";
      if (rateStr && totalStr) return `\u2193 ${rateStr}
${totalStr} lifetime`;
      return totalStr ?? rateStr;
    }
    _tick() {
      this._flush();
      if (this._onUpdate) this._onUpdate();
    }
    _flush() {
      if (!this._startMs) return;
      const now = Date.now();
      const hrs = (now - this._startMs) / 36e5;
      this._startMs = now;
      if (!this._video || this._video.paused || this._video.ended) return;
      const conn = navigator.connection;
      const connType = conn?.type ?? "unknown";
      const effectiveType = conn?.effectiveType ?? "4g";
      const height = this._video.videoHeight || 1080;
      const fps = this._measureFPS();
      const measuredMbps = this._measureActualBitrateMbps();
      const streamMbps = measuredMbps !== null ? measuredMbps : _ytBitrate(height, fps);
      const maxHeight = _getMaxAvailableHeight();
      this._referenceHeight = maxHeight;
      const ceilingMbps = _ytBitrate(maxHeight, fps);
      const deltaMbps = Math.max(0, ceilingMbps - streamMbps);
      const gbSaved = deltaMbps * 0.45 * hrs;
      const networkWh = gbSaved * _whPerGb(connType, effectiveType);
      const srcPx = (this._video.videoWidth || Math.round(height * 16 / 9)) * (this._video.videoHeight || height);
      const deviceWh = _MAX_DECODE_W * Math.max(0, 1 - srcPx / _PX_4K) * hrs;
      const wh = networkWh + deviceWh;
      this._currentRate = hrs > 0 ? wh / hrs : 0;
      this._sessionWh += wh;
      this._totalWh += wh;
    }
    // Measures actual compressed stream bitrate from bytes decoded since last tick.
    // Returns Mbps, or null if the property is unavailable (non-Chrome, or first tick).
    _measureActualBitrateMbps() {
      const bytes = this._video.webkitVideoDecodedByteCount;
      if (typeof bytes !== "number") return null;
      const now = performance.now();
      let mbps = null;
      if (this._lastDecodedBytes !== null && bytes >= this._lastDecodedBytes) {
        const db = bytes - this._lastDecodedBytes;
        const dt = (now - this._lastDecodedBytesMs) / 1e3;
        if (dt >= 2 && db >= 0) mbps = db * 8 / dt / 1e6;
      }
      this._lastDecodedBytes = bytes;
      this._lastDecodedBytesMs = now;
      return mbps;
    }
    _measureFPS() {
      const video = this._video;
      const q = video.getVideoPlaybackQuality?.();
      if (!q) return 30;
      const frames = q.totalVideoFrames;
      const now = performance.now();
      let fps = 30;
      if (this._lastFrames !== null && this._lastFrameMs !== null) {
        const df = frames - this._lastFrames;
        const dt = (now - this._lastFrameMs) / 1e3;
        if (dt > 0 && df > 0) fps = df / dt;
      }
      this._lastFrames = frames;
      this._lastFrameMs = now;
      return fps;
    }
    _persist() {
      try {
        chrome.storage.local.set({ ecoTotalWh: parseFloat(this._totalWh.toFixed(3)) });
      } catch {
      }
    }
  };
  var UIManager = class {
    constructor() {
      this._host = null;
      this._shadow = null;
      this._callbacks = {};
    }
    inject(anchorElement, settings, callbacks) {
      this._callbacks = callbacks;
      const host = document.createElement("div");
      host.id = "eco-upscaler-ui";
      Object.assign(host.style, {
        position: "absolute",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        pointerEvents: "none",
        zIndex: "2147483641"
      });
      anchorElement.style.position = anchorElement.style.position || "relative";
      anchorElement.appendChild(host);
      this._host = host;
      const shadow = host.attachShadow({ mode: "closed" });
      this._shadow = shadow;
      shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        #panel {
          position: absolute;
          top: 12px;
          right: 12px;
          pointer-events: auto;
          background: rgba(0, 0, 0, 0.82);
          color: #fff;
          border-radius: 10px;
          padding: 10px 14px;
          min-width: 168px;
          font-size: 12px;
          line-height: 1.5;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          z-index: 2147483641;
          user-select: none;
        }
        #panel.hidden { display: none; }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 6px;
        }
        .row:last-child { margin-bottom: 0; }
        label { color: #ccc; white-space: nowrap; }
        .switch {
          position: relative;
          width: 34px;
          height: 18px;
          flex-shrink: 0;
        }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider {
          position: absolute;
          inset: 0;
          background: #555;
          border-radius: 18px;
          cursor: pointer;
          transition: background 0.2s;
        }
        .slider:before {
          content: '';
          position: absolute;
          width: 12px;
          height: 12px;
          left: 3px;
          top: 3px;
          background: #fff;
          border-radius: 50%;
          transition: transform 0.2s;
        }
        input:checked + .slider { background: #4ade80; }
        input:checked + .slider:before { transform: translateX(16px); }
        #status-badge {
          font-size: 10px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 20px;
          background: #444;
          color: #aaa;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }
        #status-badge.active { background: #14532d; color: #4ade80; }
        #status-badge.degraded { background: #7c2d12; color: #fb923c; }
        #status-badge.disabled { background: #450a0a; color: #f87171; }
        #res { color: #666; font-size: 10px; text-align: right; }
        #energy {
          color: #4ade80;
          font-size: 10px;
          text-align: right;
          opacity: 0.75;
          margin-top: 4px;
          line-height: 1.4;
          white-space: pre-line;
        }
      </style>
      <div id="panel">
        <div class="row">
          <label>Eco Upscale</label>
          <label class="switch">
            <input type="checkbox" id="toggle" ${settings.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
        <div class="row">
          <label>Status</label>
          <span id="status-badge">Off</span>
        </div>
        <div id="res"></div>
        <div id="energy"></div>
      </div>
    `;
      shadow.getElementById("toggle").addEventListener("change", (e) => {
        if (this._callbacks.onToggle) this._callbacks.onToggle(e.target.checked);
      });
      this.updateStatus(settings.enabled ? "active" : "off");
    }
    remove() {
      if (this._host) {
        this._host.remove();
        this._host = null;
        this._shadow = null;
      }
    }
    updateStatus(status) {
      if (!this._shadow) return;
      const badge = this._shadow.getElementById("status-badge");
      if (!badge) return;
      const labels = { active: "Active", degraded: "Degraded", fallback: "Fallback", disabled: "Disabled", off: "Off" };
      badge.textContent = labels[status] ?? status;
      badge.className = status;
    }
    updateToggle(enabled) {
      if (!this._shadow) return;
      const toggle = this._shadow.getElementById("toggle");
      if (toggle) toggle.checked = enabled;
    }
    updateEnergy(text) {
      if (!this._shadow) return;
      const el = this._shadow.getElementById("energy");
      if (el) el.textContent = text || "";
    }
    updateResolution(width, height, rendererSuffix = "") {
      if (!this._shadow) return;
      const el = this._shadow.getElementById("res");
      if (!el) return;
      let label = "";
      if (height >= 2160) label = "4K";
      else if (height >= 1440) label = "1440p";
      else if (height >= 1080) label = "1080p";
      else if (height >= 720) label = "720p";
      else if (height > 0) label = `${height}p`;
      el.textContent = label ? `Source: ${label}${rendererSuffix}` : "";
    }
  };
  var _settingsManager = null;
  var _videoDetector = null;
  var _overlayManager = null;
  var _upscalerPipeline = null;
  var _frameProcessor = null;
  var _perfMonitor = null;
  var _backgroundQualityManager = null;
  var _aiUpscaler = null;
  var _energyTracker = null;
  var _uiManager = null;
  var _initialized = false;
  var _currentPath = "";
  async function init() {
    if (_initialized) return;
    try {
      chrome.storage.local.set({ onWatchPage: true });
    } catch {
    }
    const settings = _settingsManager.get();
    _videoDetector = new VideoDetector();
    _videoDetector.onVideoFound = (video) => _onVideoReady(video, settings);
    _videoDetector.onVideoReplaced = () => {
      cleanup();
      setTimeout(() => init(), 150);
    };
    _videoDetector.start();
  }
  async function _onVideoReady(video, settings) {
    if (_initialized) return;
    _initialized = true;
    _overlayManager = new OverlayManager();
    const canvas = _overlayManager.create(video);
    _upscalerPipeline = new UpscalerPipeline(canvas, video, settings);
    await _upscalerPipeline.init();
    _energyTracker = new EnergyTracker();
    await _energyTracker.load();
    const playerContainer = document.querySelector("#movie_player") || video.parentElement;
    if (playerContainer) {
      _aiUpscaler = new AITileUpscaler(playerContainer, video);
      await _aiUpscaler.init();
    }
    _overlayManager.setVisible(settings.enabled);
    _perfMonitor = new PerformanceMonitor();
    _perfMonitor.onDegrade(() => {
      _uiManager && _uiManager.updateStatus("degraded");
    });
    _perfMonitor.onDisable(() => {
      _settingsManager.save({ enabled: false, status: "disabled" });
      _frameProcessor && _frameProcessor.stop();
      _overlayManager && _overlayManager.setVisible(false);
      _uiManager && _uiManager.updateStatus("disabled");
      _uiManager && _uiManager.updateToggle(false);
    });
    _perfMonitor.onRecover(() => {
      _uiManager && _uiManager.updateStatus("active");
    });
    _frameProcessor = new FrameProcessor();
    if (settings.enabled) {
      _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
      _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
    }
    if (playerContainer) {
      _backgroundQualityManager = new BackgroundQualityManager(_settingsManager);
      _backgroundQualityManager.start(playerContainer);
      _uiManager = new UIManager();
      _uiManager.inject(playerContainer, settings, {
        onToggle: (enabled) => {
          _settingsManager.save({ enabled, status: enabled ? "active" : "off" });
          _overlayManager.setVisible(enabled);
          if (enabled) {
            _perfMonitor.reset();
            _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
            if (video.readyState >= 2) _upscalerPipeline.processFrame();
            _energyTracker && _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
          } else {
            _frameProcessor.stop();
            _energyTracker && _energyTracker.end();
            _uiManager.updateEnergy(_energyTracker ? _energyTracker.formatDisplay() : "");
          }
          _backgroundQualityManager && _backgroundQualityManager.refresh();
          _uiManager.updateStatus(enabled ? "active" : "off");
        }
      });
    }
    if (_uiManager && _energyTracker) {
      _uiManager.updateEnergy(_energyTracker.formatDisplay());
    }
    const rendererLabel = _upscalerPipeline.getRendererType() === "webgl" ? " \xB7 GL" : "";
    const showRes = () => {
      if (_uiManager) _uiManager.updateResolution(video.videoWidth, video.videoHeight, rendererLabel);
    };
    video.addEventListener("loadedmetadata", showRes);
    showRes();
    video.addEventListener("resize", () => {
      if (!_initialized) return;
      cleanup();
      setTimeout(() => init(), 150);
    });
    _settingsManager.onChange((all, changed) => {
      if (!_initialized) return;
      if ("enabled" in changed) {
        _overlayManager.setVisible(all.enabled);
        _uiManager && _uiManager.updateToggle(all.enabled);
        if (all.enabled) {
          _perfMonitor.reset();
          _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
          if (video.readyState >= 2) _upscalerPipeline.processFrame();
          _energyTracker && _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
        } else {
          _frameProcessor.stop();
          _energyTracker && _energyTracker.end();
          _uiManager && _uiManager.updateEnergy(_energyTracker ? _energyTracker.formatDisplay() : "");
        }
        _uiManager && _uiManager.updateStatus(all.enabled ? "active" : "off");
      }
    });
  }
  function cleanup() {
    if (!_initialized) return;
    _initialized = false;
    try {
      chrome.storage.local.set({ onWatchPage: false, status: "off" });
    } catch {
    }
    _frameProcessor && _frameProcessor.stop();
    _aiUpscaler && _aiUpscaler.destroy();
    _energyTracker && _energyTracker.destroy();
    _backgroundQualityManager && _backgroundQualityManager.stop();
    _uiManager && _uiManager.remove();
    _overlayManager && _overlayManager.destroy();
    _upscalerPipeline && _upscalerPipeline.destroy();
    _videoDetector && _videoDetector.stop();
    _frameProcessor = null;
    _aiUpscaler = null;
    _energyTracker = null;
    _backgroundQualityManager = null;
    _uiManager = null;
    _overlayManager = null;
    _upscalerPipeline = null;
    _videoDetector = null;
    _perfMonitor = null;
  }
  function onNavigate(path) {
    if (path === _currentPath) return;
    _currentPath = path;
    if (path.startsWith("/watch")) {
      init();
    } else {
      cleanup();
    }
  }
  function interceptNavigation() {
    const _origPush = history.pushState.bind(history);
    const _origReplace = history.replaceState.bind(history);
    const fireNav = () => onNavigate(location.pathname + location.search);
    history.pushState = function(...args) {
      _origPush(...args);
      fireNav();
    };
    history.replaceState = function(...args) {
      _origReplace(...args);
      fireNav();
    };
    window.addEventListener("popstate", fireNav);
    document.addEventListener("yt-navigate-finish", fireNav);
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(() => {
        const path = location.pathname + location.search;
        if (path !== _currentPath) onNavigate(path);
      }).observe(titleEl, { childList: true });
    }
  }
  async function bootstrap() {
    _settingsManager = new SettingsManager();
    await _settingsManager.load();
    interceptNavigation();
    onNavigate(location.pathname + location.search);
  }
  bootstrap();
})();
