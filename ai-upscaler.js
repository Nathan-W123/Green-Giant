// AI face-tile enhancement layer.
// Loads a tiny SRCNN super-resolution model (super-resolution-10.onnx, ~234 KB)
// via ONNX Runtime Web (loaded separately as lib/ort.min.js).
// Detects faces with the browser-native FaceDetector API and runs the AI pass
// on those tiles only at 4 fps, composited onto a transparent 2D overlay canvas
// stacked above the WebGL unsharp-mask pass.

const MODEL_IN  = 224;   // model expects exactly 224×224 luma input
const MODEL_OUT = 672;   // model outputs 672×672 luma (3× scale)
const AI_INTERVAL_MS = 250; // 4 fps AI pass
const MAX_FACES = 3;
const FACE_PAD  = 0.18;  // fractional padding around detected bbox

export class AITileUpscaler {
  constructor(container, video) {
    this._container = container;
    this._video     = video;
    this._canvas    = null;
    this._ctx       = null;
    this._session    = null;
    this._inputDtype = 'float32';
    this._detector   = null;
    this._ready      = false;
    this._lastMs    = 0;
    // Scratch canvas for tile capture and color reconstruction
    this._scratch   = document.createElement('canvas');
    this._scratch2  = document.createElement('canvas');
    this._sctx      = this._scratch.getContext('2d');
    this._sctx2     = this._scratch2.getContext('2d');
  }

  async init() {
    try {
      await this._initORT();
      await this._initDetector();
      this._createCanvas();
      this._ready = true;
      console.log('[EcoUpscaler] AI tile upscaler ready.');
    } catch (e) {
      console.warn('[EcoUpscaler] AI upscaler unavailable:', e.message);
      this._ready = false;
    }
    return this._ready;
  }

  get isReady() { return this._ready; }

  async processFrame() {
    if (!this._ready) return;
    const now = performance.now();
    if (now - this._lastMs < AI_INTERVAL_MS) return;
    this._lastMs = now;

    const video = this._video;
    if (!video || video.paused || video.readyState < 2) return;

    let faces;
    try { faces = await this._detector.detect(video); }
    catch { return; }

    this._syncSize();
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    if (!faces.length) return;

    const scaleX = this._canvas.width  / video.videoWidth;
    const scaleY = this._canvas.height / video.videoHeight;

    for (const face of faces.slice(0, MAX_FACES)) {
      await this._enhanceFace(face.boundingBox, video, scaleX, scaleY);
    }
  }

  resize() { this._syncSize(); }

  destroy() {
    this._ready = false;
    if (this._canvas) { this._canvas.remove(); this._canvas = null; }
    if (this._session) { this._session.release?.(); this._session = null; }
    this._detector = null;
  }

  // ── private ────────────────────────────────────────────────────────────────

  async _initORT() {
    const ort = window.ort;
    if (!ort) throw new Error('window.ort not found — ensure lib/ort.min.js loads first');

    ort.env.wasm.wasmPaths  = chrome.runtime.getURL('lib/');
    ort.env.wasm.numThreads = 1; // avoids SharedArrayBuffer requirement

    // Prefer quantized models: FP16 (half bandwidth on WebGL) → INT8 (faster WASM)
    // → original FP32. Probed by HEAD request to avoid 404 errors.
    const candidates = [
      { file: 'models/super-resolution-fp16.onnx', dtype: 'float16' },
      { file: 'models/super-resolution-int8.onnx',  dtype: 'float32' }, // INT8 weights, FP32 I/O
      { file: 'models/super-resolution-10.onnx',    dtype: 'float32' },
    ];

    let modelUrl = null;
    let dtype    = 'float32';
    for (const c of candidates) {
      const url = chrome.runtime.getURL(c.file);
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) { modelUrl = url; dtype = c.dtype; break; }
      } catch { /* file absent */ }
    }
    if (!modelUrl) throw new Error('No model file found in models/');

    this._session   = await ort.InferenceSession.create(modelUrl, {
      executionProviders:     ['webgl', 'wasm'],
      graphOptimizationLevel: 'all',
    });
    this._inputDtype = dtype;
    console.log(`[EcoUpscaler] Loaded ${modelUrl.split('/').pop()} (${dtype})`);
  }

  async _initDetector() {
    if (!('FaceDetector' in window)) throw new Error('FaceDetector API not available');
    this._detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: MAX_FACES });
    // Warm up — first call is slow; do it on a tiny scratch canvas
    this._scratch.width = 4; this._scratch.height = 4;
    try { await this._detector.detect(this._scratch); } catch { /* ignore */ }
  }

  _createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.id = 'eco-ai-overlay';
    Object.assign(canvas.style, {
      position:      'absolute',
      top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex:        '51', // one above WebGL canvas (z-index 50)
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

  async _enhanceFace(bbox, video, scaleX, scaleY) {
    // Expand bbox with padding, clamped to video bounds
    const vw = video.videoWidth, vh = video.videoHeight;
    const px = bbox.width  * FACE_PAD;
    const py = bbox.height * FACE_PAD;
    const sx = Math.max(0, bbox.x - px);
    const sy = Math.max(0, bbox.y - py);
    const sw = Math.min(vw - sx, bbox.width  + 2 * px);
    const sh = Math.min(vh - sy, bbox.height + 2 * py);
    if (sw < 8 || sh < 8) return;

    // ── 1. Capture tile at MODEL_IN × MODEL_IN ──────────────────────────────
    this._scratch.width  = MODEL_IN;
    this._scratch.height = MODEL_IN;
    this._sctx.drawImage(video, sx, sy, sw, sh, 0, 0, MODEL_IN, MODEL_IN);
    const tileData = this._sctx.getImageData(0, 0, MODEL_IN, MODEL_IN).data;

    // ── 2. Build luma tensor [1, 1, 224, 224] ───────────────────────────────
    const luma = new Float32Array(MODEL_IN * MODEL_IN);
    for (let i = 0; i < MODEL_IN * MODEL_IN; i++) {
      luma[i] = (0.299 * tileData[i*4] + 0.587 * tileData[i*4+1] + 0.114 * tileData[i*4+2]) / 255;
    }

    // ── 3. Run SRCNN ─────────────────────────────────────────────────────────
    const ort = window.ort;
    let outLuma;
    try {
      // Use FP16 typed array when the loaded model expects half-precision weights.
      // Float16Array is supported in V8 (Chrome 114+); fall back to float32 if absent.
      let inputData = luma;
      let dtype = this._inputDtype ?? 'float32';
      if (dtype === 'float16') {
        if (typeof Float16Array !== 'undefined') {
          inputData = new Float16Array(luma);
        } else {
          dtype = 'float32'; // V8 too old — still works, just no bandwidth saving
        }
      }
      const feeds = { input: new ort.Tensor(dtype, inputData, [1, 1, MODEL_IN, MODEL_IN]) };
      const results = await this._session.run(feeds);
      outLuma = results[Object.keys(results)[0]].data;
    } catch (e) {
      console.warn('[EcoUpscaler] Inference error:', e.message);
      return;
    }

    // ── 4. Reconstruct color: AI luma + bilinear-upscaled chroma ─────────────
    // Capture original tile at MODEL_OUT × MODEL_OUT for chroma reference
    this._scratch2.width  = MODEL_OUT;
    this._scratch2.height = MODEL_OUT;
    this._sctx2.drawImage(video, sx, sy, sw, sh, 0, 0, MODEL_OUT, MODEL_OUT);
    const chromaData = this._sctx2.getImageData(0, 0, MODEL_OUT, MODEL_OUT).data;

    const outPixels = new Uint8ClampedArray(MODEL_OUT * MODEL_OUT * 4);
    for (let i = 0; i < MODEL_OUT * MODEL_OUT; i++) {
      const aiL   = Math.max(0, Math.min(1, outLuma[i]));
      const origL = Math.max(0.001,
        (0.299 * chromaData[i*4] + 0.587 * chromaData[i*4+1] + 0.114 * chromaData[i*4+2]) / 255
      );
      // Scale each RGB channel by the AI-predicted luma ratio (preserves hue/saturation)
      const ratio = aiL / origL;
      outPixels[i*4]   = Math.min(255, chromaData[i*4]   * ratio);
      outPixels[i*4+1] = Math.min(255, chromaData[i*4+1] * ratio);
      outPixels[i*4+2] = Math.min(255, chromaData[i*4+2] * ratio);
      outPixels[i*4+3] = 255;
    }

    // ── 5. Composite enhanced tile onto AI overlay canvas ────────────────────
    this._scratch2.width  = MODEL_OUT;
    this._scratch2.height = MODEL_OUT;
    this._sctx2.putImageData(new ImageData(outPixels, MODEL_OUT, MODEL_OUT), 0, 0);
    this._ctx.drawImage(
      this._scratch2,
      sx * scaleX, sy * scaleY,
      sw * scaleX, sh * scaleY
    );
  }
}
