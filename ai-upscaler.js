// AI full-frame enhancement layer (test mode — no face detection).
// Runs SRCNN super-resolution on the entire video frame at 4 fps,
// composited onto a transparent 2D overlay canvas above the WebGL pass.

const MODEL_IN      = 224;  // model input size (224×224 luma)
const MODEL_OUT     = 672;  // model output size (672×672, 3× scale)
const AI_INTERVAL_MS = 250; // 4 fps

export class AITileUpscaler {
  constructor(container, video) {
    this._container  = container;
    this._video      = video;
    this._canvas     = null;
    this._ctx        = null;
    this._session    = null;
    this._inputDtype = 'float32';
    this._ready      = false;
    this._lastMs     = 0;
    this._scratch    = document.createElement('canvas');
    this._scratch2   = document.createElement('canvas');
    this._sctx       = this._scratch.getContext('2d');
    this._sctx2      = this._scratch2.getContext('2d');
  }

  async init() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this._initORT();
        this._createCanvas();
        this._ready = true;
        console.log('[EcoUpscaler] AI upscaler ready (full-frame mode).');
        return true;
      } catch (e) {
        console.warn(`[EcoUpscaler] AI init attempt ${attempt}/3 failed: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    console.error('[EcoUpscaler] AI upscaler permanently unavailable — check models/ and lib/ directories.');
    this._ready = false;
    return false;
  }

  get isReady() { return this._ready; }

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

  resize() { this._syncSize(); }

  destroy() {
    this._ready = false;
    if (this._canvas) { this._canvas.remove(); this._canvas = null; }
    if (this._session) { this._session.release?.(); this._session = null; }
  }

  // ── private ────────────────────────────────────────────────────────────────

  async _initORT() {
    const ort = window.ort;
    if (!ort) throw new Error('window.ort not found — ensure lib/ort.min.js loads first');

    // proxy=false: run WASM inference on the main thread (no ORT proxy worker).
    // numThreads=1: single-threaded — avoids SharedArrayBuffer requirement.
    // wasmPaths: explicit chrome-extension:// URL bypasses ORT's import.meta.url
    // URL detection, which is patched to location.href in the built lib/ort.min.js.
    ort.env.wasm.proxy      = false;
    ort.env.wasm.numThreads = 1;
    // ORT reads wasmPaths.wasm (not filename-keyed) to set its locateFile function,
    // which takes precedence over the import_meta.url-based URL detection.
    ort.env.wasm.wasmPaths  = {
      wasm: chrome.runtime.getURL('lib/ort-wasm-simd-threaded.wasm'),
    };

    const candidates = [
      { file: 'models/super-resolution-int8.onnx', dtype: 'float32' },
      { file: 'models/super-resolution-10.onnx',   dtype: 'float32' },
    ];

    let modelBytes = null;
    let dtype      = 'float32';
    let modelName  = '';
    for (const c of candidates) {
      try {
        const url = chrome.runtime.getURL(c.file);
        const res = await fetch(url);
        if (res.ok) {
          modelBytes = new Uint8Array(await res.arrayBuffer());
          dtype      = c.dtype;
          modelName  = c.file;
          break;
        }
      } catch (e) { console.warn(`[EcoUpscaler] fetch ${c.file}:`, e.message); }
    }
    if (!modelBytes) throw new Error('No model file found in models/');

    // Pass raw bytes — avoids chrome-extension:// URL resolution inside ORT loader.
    this._session = await ort.InferenceSession.create(modelBytes, {
      executionProviders:     ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this._inputDtype = dtype;
    console.log(`[EcoUpscaler] AI ready: ${modelName} (${(modelBytes.length / 1024).toFixed(0)} KB, ${dtype})`);
  }

  _createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.id = 'eco-ai-overlay';
    Object.assign(canvas.style, {
      position:      'absolute',
      top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex:        '51',
    });
    this._container.appendChild(canvas);
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');
    this._syncSize();
  }

  _syncSize() {
    if (!this._canvas) return;
    const dpr = devicePixelRatio || 1;
    const w   = Math.round(this._container.clientWidth  * dpr);
    const h   = Math.round(this._container.clientHeight * dpr);
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width  = w;
      this._canvas.height = h;
    }
  }

  async _enhanceFullFrame(video) {
    // ── 1. Capture entire frame at MODEL_IN × MODEL_IN ──────────────────────
    this._scratch.width  = MODEL_IN;
    this._scratch.height = MODEL_IN;
    this._sctx.drawImage(video, 0, 0, MODEL_IN, MODEL_IN);
    const frameData = this._sctx.getImageData(0, 0, MODEL_IN, MODEL_IN).data;

    // ── 2. Build luma tensor [1, 1, 224, 224] ───────────────────────────────
    const luma = new Float32Array(MODEL_IN * MODEL_IN);
    for (let i = 0; i < MODEL_IN * MODEL_IN; i++) {
      luma[i] = (0.299 * frameData[i*4] + 0.587 * frameData[i*4+1] + 0.114 * frameData[i*4+2]) / 255;
    }

    // ── 3. Run SRCNN ─────────────────────────────────────────────────────────
    const ort = window.ort;
    let outLuma;
    try {
      let inputData = luma;
      let dtype = this._inputDtype ?? 'float32';
      if (dtype === 'float16') {
        if (typeof Float16Array !== 'undefined') {
          inputData = new Float16Array(luma);
        } else {
          dtype = 'float32';
        }
      }
      const feeds   = { input: new ort.Tensor(dtype, inputData, [1, 1, MODEL_IN, MODEL_IN]) };
      const results = await this._session.run(feeds);
      outLuma = results[Object.keys(results)[0]].data;
    } catch (e) {
      console.warn('[EcoUpscaler] Inference error:', e.message);
      return;
    }

    // ── 4. Reconstruct color: AI luma + bilinear-upscaled chroma ────────────
    this._scratch2.width  = MODEL_OUT;
    this._scratch2.height = MODEL_OUT;
    this._sctx2.drawImage(video, 0, 0, MODEL_OUT, MODEL_OUT);
    const chromaData = this._sctx2.getImageData(0, 0, MODEL_OUT, MODEL_OUT).data;

    const outPixels = new Uint8ClampedArray(MODEL_OUT * MODEL_OUT * 4);
    for (let i = 0; i < MODEL_OUT * MODEL_OUT; i++) {
      const aiL   = Math.max(0, Math.min(1, outLuma[i]));
      const origL = Math.max(0.001,
        (0.299 * chromaData[i*4] + 0.587 * chromaData[i*4+1] + 0.114 * chromaData[i*4+2]) / 255
      );
      const ratio = aiL / origL;
      outPixels[i*4]   = Math.min(255, chromaData[i*4]   * ratio);
      outPixels[i*4+1] = Math.min(255, chromaData[i*4+1] * ratio);
      outPixels[i*4+2] = Math.min(255, chromaData[i*4+2] * ratio);
      outPixels[i*4+3] = 255;
    }

    // ── 5. Draw enhanced frame stretched to full overlay canvas ──────────────
    this._scratch2.width  = MODEL_OUT;
    this._scratch2.height = MODEL_OUT;
    this._sctx2.putImageData(new ImageData(outPixels, MODEL_OUT, MODEL_OUT), 0, 0);
    this._ctx.drawImage(this._scratch2, 0, 0, this._canvas.width, this._canvas.height);
  }
}
