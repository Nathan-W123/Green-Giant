// AI full-frame enhancement layer.
// Two-pass render: (1) draw the video at full canvas resolution so quality is
// preserved, then (2) composite a 224×224 luma-USM sharpening delta onto it
// using Canvas 'overlay' blend — edges sharpen, flat areas unchanged.
// Pure JS/Canvas 2D, no WASM. Runs at 4 fps.

const MODEL_IN       = 224;  // USM analysis resolution
const AI_INTERVAL_MS = 250;  // 4 fps

// 3×3 Gaussian kernel (sigma ≈ 0.85)
const GAUSS = [
  1 / 16, 2 / 16, 1 / 16,
  2 / 16, 4 / 16, 2 / 16,
  1 / 16, 2 / 16, 1 / 16,
];

export class AITileUpscaler {
  constructor(container, video) {
    this._container = container;
    this._video     = video;
    this._canvas    = null;
    this._ctx       = null;
    this._ready     = false;
    this._lastMs    = 0;
    this._scratch   = document.createElement('canvas');
    this._sctx      = this._scratch.getContext('2d', { willReadFrequently: true });
  }

  async init() {
    try {
      this._createCanvas();
      this._ready = true;
      console.log('[EcoUpscaler] AI upscaler ready (luma-USM overlay mode).');
      return true;
    } catch (e) {
      console.error('[EcoUpscaler] AI init failed:', e.message);
      this._ready = false;
      return false;
    }
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
    this._enhanceFullFrame(video);
  }

  resize() { this._syncSize(); }

  setVisible(visible) {
    if (!this._canvas) return;
    this._canvas.style.display = visible ? '' : 'none';
    if (!visible && this._ctx) {
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  destroy() {
    this._ready = false;
    if (this._canvas) { this._canvas.remove(); this._canvas = null; }
  }

  // ── private ────────────────────────────────────────────────────────────────

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

  _enhanceFullFrame(video) {
    const W = this._canvas.width;
    const H = this._canvas.height;
    const N = MODEL_IN;

    // ── Pass 1: Full-resolution base draw ────────────────────────────────────
    // Draw video at native canvas resolution so the AI overlay looks as good
    // as the WebGL canvas it covers. GPU-accelerated, negligible CPU cost.
    this._ctx.imageSmoothingEnabled = true;
    this._ctx.imageSmoothingQuality = 'high';
    this._ctx.drawImage(video, 0, 0, W, H);

    // ── Pass 2: USM delta at MODEL_IN, blended as overlay ────────────────────
    // Compute luma-space Gaussian unsharp mask at 224×224, encode the delta
    // as deviations from neutral gray (128). Blend with 'overlay' composite:
    // neutral gray (=128) has zero effect; values above/below 128 boost/reduce
    // local contrast at edges, leaving flat areas untouched.
    this._scratch.width  = N;
    this._scratch.height = N;
    this._sctx.drawImage(video, 0, 0, N, N);
    const src = this._sctx.getImageData(0, 0, N, N).data;

    const out = new Uint8ClampedArray(N * N * 4);
    const USM_STRENGTH = 0.7;

    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i  = (y * N + x) * 4;
        const origY = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];

        let blurY = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = Math.min(N - 1, Math.max(0, y + dy));
            const nx = Math.min(N - 1, Math.max(0, x + dx));
            const j  = (ny * N + nx) * 4;
            blurY += (0.299 * src[j] + 0.587 * src[j + 1] + 0.114 * src[j + 2]) * GAUSS[k++];
          }
        }

        const encoded = Math.min(255, Math.max(0, 128 + (origY - blurY) * USM_STRENGTH));
        out[i] = encoded; out[i + 1] = encoded; out[i + 2] = encoded; out[i + 3] = 255;
      }
    }

    this._sctx.putImageData(new ImageData(out, N, N), 0, 0);
    this._ctx.globalCompositeOperation = 'overlay';
    this._ctx.globalAlpha = 0.45;
    this._ctx.drawImage(this._scratch, 0, 0, W, H);
    this._ctx.globalCompositeOperation = 'source-over';
    this._ctx.globalAlpha = 1;
  }
}
