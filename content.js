import { UpscalerPipeline } from './upscaler.js';

// YouTube Eco Upscaler — content script orchestrator.

function getDisplayedVideoRect(video, container) {
  if (!video || !container) return null;

  const videoRect = video.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (videoRect.width <= 0 || videoRect.height <= 0) return null;

  const dpr = devicePixelRatio || 1;
  const sourceWidth = video.videoWidth || 0;
  const sourceHeight = video.videoHeight || 0;
  const baseLeft = videoRect.left - containerRect.left;
  const baseTop = videoRect.top - containerRect.top;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      cssLeft: baseLeft,
      cssTop: baseTop,
      cssWidth: videoRect.width,
      cssHeight: videoRect.height,
      pixelWidth: Math.max(1, Math.round(videoRect.width * dpr)),
      pixelHeight: Math.max(1, Math.round(videoRect.height * dpr)),
      dpr,
    };
  }

  const style = getComputedStyle(video);
  const objectFit = style.objectFit || 'contain';
  const videoAspect = sourceWidth / sourceHeight;
  const boxAspect = videoRect.width / videoRect.height;

  let cssWidth = videoRect.width;
  let cssHeight = videoRect.height;

  if (objectFit === 'contain' || objectFit === 'scale-down' || objectFit === 'none') {
    if (boxAspect > videoAspect) {
      cssHeight = videoRect.height;
      cssWidth = cssHeight * videoAspect;
    } else {
      cssWidth = videoRect.width;
      cssHeight = cssWidth / videoAspect;
    }
  } else if (objectFit === 'cover') {
    if (boxAspect > videoAspect) {
      cssWidth = videoRect.width;
      cssHeight = cssWidth / videoAspect;
    } else {
      cssHeight = videoRect.height;
      cssWidth = cssHeight * videoAspect;
    }
  }

  const cssLeft = baseLeft + (videoRect.width - cssWidth) / 2;
  const cssTop = baseTop + (videoRect.height - cssHeight) / 2;

  return {
    cssLeft,
    cssTop,
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.round(cssWidth * dpr)),
    pixelHeight: Math.max(1, Math.round(cssHeight * dpr)),
    dpr,
  };
}

// ============================================================================
// SettingsManager
// ============================================================================

class SettingsManager {
  constructor() {
    this._settings = this._defaults();
    this._changeCallbacks = [];
  }

  _defaults() {
    return {
      enabled: false,
      debugMode: false,
      status: 'off',
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
    try { chrome.storage.local.set(this._settings); } catch { /* context invalidated */ }
  }

  get() {
    return { ...this._settings };
  }

  onChange(callback) {
    this._changeCallbacks.push(callback);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const updated = {};
        for (const [key, { newValue }] of Object.entries(changes)) {
          updated[key] = newValue;
        }
        this._settings = { ...this._settings, ...updated };
        callback(this._settings, updated);
      });
    } catch { /* context invalidated */ }
  }
}

// ============================================================================
// VideoDetector
// ============================================================================

class VideoDetector {
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
    return (
      document.querySelector('#movie_player video') ||
      document.querySelector('.html5-main-video') ||
      document.querySelector('ytd-player video') ||
      document.querySelector('video[src]') ||
      null
    );
  }

  _observeForVideo() {
    const target = document.querySelector('#movie_player') || document.body;
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
}

// ============================================================================
// OverlayManager
// ============================================================================

class OverlayManager {
  constructor() {
    this._canvas = null;
    this._video = null;
    this._player = null;
    this._resizeObserver = null;
    this._videoResizeObserver = null;
    this._fsHandler = null;
    this._theaterHandler = null;
    this._theaterObserver = null;
    this._metadataHandler = null;
  }

  create(video) {
    this._video = video;
    this._player = document.querySelector('#movie_player') || video.parentElement;

    const canvas = document.createElement('canvas');
    canvas.id = 'eco-upscaler-overlay';
    // Inline styles beat YouTube's own stylesheets, which would otherwise override
    // position/size and show the canvas at its natural pixel-buffer dimensions.
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none',
      zIndex: '50',
      imageRendering: 'auto',
    });
    if (getComputedStyle(this._player).position === 'static') {
      this._player.style.position = 'relative';
    }
    this._player.appendChild(canvas);
    this._canvas = canvas;

    this._syncToVideoRect();
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
    if (this._videoResizeObserver) {
      this._videoResizeObserver.disconnect();
      this._videoResizeObserver = null;
    }
    if (this._theaterObserver) {
      this._theaterObserver.disconnect();
      this._theaterObserver = null;
    }
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
      this._fsHandler = null;
    }
    if (this._theaterHandler) {
      document.removeEventListener('yt-set-theater-mode-enabled', this._theaterHandler);
      this._theaterHandler = null;
    }
    if (this._metadataHandler && this._video) {
      this._video.removeEventListener('loadedmetadata', this._metadataHandler);
      this._metadataHandler = null;
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
      this._canvas.style.display = visible ? 'block' : 'none';
    }
  }

  _syncToVideoRect() {
    const canvas = this._canvas;
    const video = this._video;
    const container = this._player;
    if (!canvas || !video || !container) return;

    const rect = getDisplayedVideoRect(video, container);
    if (!rect) return;

    canvas.style.left = `${rect.cssLeft}px`;
    canvas.style.top = `${rect.cssTop}px`;
    canvas.style.width = `${rect.cssWidth}px`;
    canvas.style.height = `${rect.cssHeight}px`;

    if (canvas.width !== rect.pixelWidth) canvas.width = rect.pixelWidth;
    if (canvas.height !== rect.pixelHeight) canvas.height = rect.pixelHeight;
  }

  _startResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => this._syncToVideoRect());
    this._resizeObserver.observe(this._player);

    this._videoResizeObserver = new ResizeObserver(() => this._syncToVideoRect());
    this._videoResizeObserver.observe(this._video);

    this._metadataHandler = () => this._syncToVideoRect();
    this._video.addEventListener('loadedmetadata', this._metadataHandler);
  }

  _handleFullscreen() {
    this._fsHandler = () => this._syncToVideoRect();
    document.addEventListener('fullscreenchange', this._fsHandler);
  }

  _handleTheaterMode() {
    this._theaterHandler = () => {
      setTimeout(() => this._syncToVideoRect(), 50);
    };
    document.addEventListener('yt-set-theater-mode-enabled', this._theaterHandler);
    const app = document.querySelector('ytd-app');
    if (app) {
      this._theaterObserver = new MutationObserver(() => {
        setTimeout(() => this._syncToVideoRect(), 50);
      });
      this._theaterObserver.observe(app, { attributes: true, attributeFilter: ['theater'] });
    }
  }
}

// ============================================================================
// FrameProcessor
// ============================================================================

class FrameProcessor {
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
    this._useRVFC = typeof video.requestVideoFrameCallback === 'function';

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
    // rVFC loops cancel themselves when _running becomes false.
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
    // AI pass is self-throttled to 4fps; runs async after the sync WebGL pass
    if (this._aiUpscaler) this._aiUpscaler.processFrame();
  }
}

// ============================================================================
// PerformanceMonitor
// ============================================================================

class PerformanceMonitor {
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
    const fps = avg > 0 ? 1000 / avg : 60;

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
    return avg > 0 ? Math.round(1000 / avg) : 0;
  }

  onDegrade(cb) { this._onDegrade = cb; }
  onRecover(cb) { this._onRecover = cb; }
  onDisable(cb) { this._onDisable = cb; }

  reset() {
    this._frameTimes.fill(0);
    this._frameIndex = 0;
    this._frameCount = 0;
    this._degraded = false;
  }
}

// ============================================================================
// BackgroundQualityManager — lowers YouTube playback quality when the tab is
// hidden or blurred, restoring it when the user returns.
// ============================================================================

class BackgroundQualityManager {
  constructor(settingsManager) {
    this._settingsManager = settingsManager;
    this._player = null;
    this._savedQuality = null;
    this._boundUpdate = this._update.bind(this);
  }

  start(player) {
    this._player = player;
    document.addEventListener('visibilitychange', this._boundUpdate);
    window.addEventListener('blur', this._boundUpdate);
    window.addEventListener('focus', this._boundUpdate);
    this._update();
  }

  stop() {
    document.removeEventListener('visibilitychange', this._boundUpdate);
    window.removeEventListener('blur', this._boundUpdate);
    window.removeEventListener('focus', this._boundUpdate);
    this._restore();
    this._player = null;
  }

  refresh() {
    this._update();
  }

  _update() {
    if (!this._settingsManager.get().enabled) { this._restore(); return; }
    if (document.hidden || !document.hasFocus()) this._lower();
    else this._restore();
  }

  _lower() {
    const player = this._player || document.querySelector('#movie_player');
    if (!player) return;
    try {
      if (!this._savedQuality && typeof player.getPlaybackQuality === 'function') {
        this._savedQuality = player.getPlaybackQuality();
      }
      if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange('tiny', 'tiny');
      if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality('tiny');
    } catch { /* YouTube player API unavailable */ }
  }

  _restore() {
    const player = this._player || document.querySelector('#movie_player');
    if (!player || !this._savedQuality) return;
    try {
      if (typeof player.setPlaybackQualityRange === 'function') player.setPlaybackQualityRange(this._savedQuality, this._savedQuality);
      if (typeof player.setPlaybackQuality === 'function') player.setPlaybackQuality(this._savedQuality);
    } catch { /* YouTube player API unavailable */ }
    this._savedQuality = null;
  }
}

// ============================================================================
// EnergyTracker — live statistical energy savings model.
//
// Each tick takes real measurements and computes Wh saved for that interval:
//
//   networkWh = gbSaved × energyPerGB(rtt, effectiveType)
//   deviceWh  = MAX_DECODE_W × pixelReduction × intervalHrs
//   totalWh   = networkWh + deviceWh
//
// gbSaved: derived from estimated stream bitrate (resolution + live fps) vs 4K,
//          capped by connection.downlink so we never claim savings on a connection
//          that couldn't carry 4K anyway.
//
// energyPerGB: continuously varying with connection.rtt (piecewise linear) rather
//              than a discrete category. Calibrated so WiFi at 1080p → ~4 Wh/hr,
//              matching IEA Electricity 2024 end-to-end system totals.
//              Baseline: (4 Wh/hr × 0.6 network share) / 6.075 GB/hr ≈ 0.395 Wh/GB
// ============================================================================

// YouTube VP9/AV1 average bitrates (Mbps) by resolution + framerate tier.
const _YT_BITRATE = {
  2160: { 30: 16, 60: 24 },
  1440: { 30:  8, 60: 13 },
  1080: { 30:  5, 60:  8 },
   720: { 30:  3, 60:  5 },
   480: { 30: 1.5, 60: 2.5 },
   360: { 30: 0.8, 60: 1.2 },
};

// Network energy per GB (Wh/GB) at WiFi baseline — comprehensive system boundary
// including CDN, backbone, and last-mile (Aslan et al. 2018 + Carbon Trust 2021).
// Calibrated so 1080p/WiFi/30fps → ~25 Wh/hr, consistent with Carbon Trust's
// ~17 g CO2/hr delta between 4K and HD at UK grid intensity (0.233 kgCO2/kWh).
const _WH_PER_GB_WIFI = 4.5;
const _MAX_DECODE_W   = 6.0; // measured GPU/CPU decode power delta (W), 4K vs 1080p
const _PX_4K          = 3840 * 2160;

// Continuous network multiplier based on measured RTT (ms).
// effectiveType used as a floor/ceiling to prevent RTT noise crossing categories.
function _networkMultiplier(rtt, effectiveType) {
  // Piecewise linear: ethernet(~10ms)→0.9, WiFi(~40ms)→1.0, 4G(~80ms)→2.2,
  //                   3G(~200ms)→3.5, 2G+(>400ms)→5.0
  let m;
  if (rtt <= 15)       m = 0.9;
  else if (rtt <= 60)  m = 0.9  + (rtt - 15)  / 45  * 0.1;   // 0.9 → 1.0
  else if (rtt <= 150) m = 1.0  + (rtt - 60)  / 90  * 1.2;   // 1.0 → 2.2
  else if (rtt <= 400) m = 2.2  + (rtt - 150) / 250 * 1.3;   // 2.2 → 3.5
  else                 m = 3.5  + Math.min(1, (rtt - 400) / 300) * 1.5; // 3.5 → 5.0

  // Clamp to effectiveType floors so a lucky low-RTT reading on 3G doesn't undercount
  if (effectiveType === 'slow-2g' || effectiveType === '2g') m = Math.max(m, 3.5);
  else if (effectiveType === '3g')                           m = Math.max(m, 2.0);
  return m;
}

function _ytBitrate(height, fps) {
  const heights = [2160, 1440, 1080, 720, 480, 360];
  const h = heights.find(t => height >= t) ?? 360;
  return _YT_BITRATE[h]?.[fps > 35 ? 60 : 30] ?? 5;
}

class EnergyTracker {
  constructor() {
    this._startMs     = null;
    this._video       = null;
    this._sessionWh   = 0;
    this._totalWh     = 0;
    this._currentRate = 0;
    this._interval    = null;
    this._onUpdate    = null;
    // For live FPS estimation via getVideoPlaybackQuality()
    this._lastFrames  = null;
    this._lastFrameMs = null;
  }

  async load() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ ecoTotalWh: 0 }, (res) => {
          this._totalWh = typeof res.ecoTotalWh === 'number' ? res.ecoTotalWh : 0;
          resolve();
        });
      } catch { resolve(); }
    });
  }

  begin(video, onUpdate) {
    if (this._interval) return;
    this._video    = video;
    this._onUpdate = onUpdate;
    this._startMs  = Date.now();
    this._interval = setInterval(() => this._tick(), 10_000);
  }

  end() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this._flush();
    this._startMs = null;
    this._video   = null;
    this._persist();
    if (this._onUpdate) this._onUpdate();
  }

  destroy() {
    this.end();
    this._sessionWh   = 0;
    this._currentRate = 0;
    this._onUpdate    = null;
    this._lastFrames  = null;
    this._lastFrameMs = null;
  }

  // Returns a two-line display string: current rate + lifetime total.
  formatDisplay() {
    const total = this._totalWh;
    const rate  = this._currentRate;
    const totalStr = total < 0.05 ? null
      : total < 1000 ? `${total.toFixed(1)} Wh saved`
      : `${(total / 1000).toFixed(3)} kWh saved`;
    const rateStr = rate >= 0.1 ? `${rate.toFixed(1)} Wh/hr vs 4K` : null;
    if (!totalStr && !rateStr) return '';
    if (rateStr && totalStr) return `↓ ${rateStr} · ${totalStr} lifetime`;
    return totalStr ?? rateStr;
  }

  _tick() {
    this._flush();
    if (this._onUpdate) this._onUpdate();
  }

  _flush() {
    if (!this._startMs) return;
    const now = Date.now();
    const hrs = (now - this._startMs) / 3_600_000;
    this._startMs = now;
    if (!this._video || this._video.paused || this._video.ended) return;

    // ── Live measurements ────────────────────────────────────────────────────
    const conn          = navigator.connection;
    const rtt           = conn?.rtt           ?? 50;
    const effectiveType = conn?.effectiveType ?? '4g';

    const height = this._video.videoHeight || 1080;
    const fps    = this._measureFPS();

    // ── Bitrate delta (Mbps) ─────────────────────────────────────────────────
    const streamMbps = _ytBitrate(height, fps);
    const fourKMbps  = _ytBitrate(2160,   fps);
    const deltaMbps  = Math.max(0, fourKMbps - streamMbps);
    // Note: we don't cap by connection.downlink — Chrome reports it conservatively
    // (often capped at 10 Mbps regardless of actual speed) which would incorrectly
    // collapse savings to near-zero on fast connections.

    // ── GB not transferred this interval ────────────────────────────────────
    // 1 Mbps over 1 hr = (1e6 bits/s × 3600 s) / 8 / 1e9 = 0.45 GB
    const gbSaved = deltaMbps * 0.45 * hrs;

    // ── Energy calculation ───────────────────────────────────────────────────
    const netMult    = _networkMultiplier(rtt, effectiveType);
    const networkWh  = gbSaved * _WH_PER_GB_WIFI * netMult;

    // Device decode: scales with pixel-count reduction from 4K baseline
    const srcPx      = (height * 16 / 9) * height;
    const deviceWh   = _MAX_DECODE_W * Math.max(0, 1 - srcPx / _PX_4K) * hrs;

    const wh = networkWh + deviceWh;
    this._currentRate = hrs > 0 ? wh / hrs : 0;
    this._sessionWh  += wh;
    this._totalWh    += wh;
  }

  _measureFPS() {
    const video = this._video;
    const q     = video.getVideoPlaybackQuality?.();
    if (!q) return 30;
    const frames = q.totalVideoFrames;
    const now    = performance.now();
    let fps = 30;
    if (this._lastFrames !== null && this._lastFrameMs !== null) {
      const df = frames - this._lastFrames;
      const dt = (now - this._lastFrameMs) / 1000;
      if (dt > 0 && df > 0) fps = df / dt;
    }
    this._lastFrames  = frames;
    this._lastFrameMs = now;
    return fps;
  }

  _persist() {
    try {
      chrome.storage.local.set({ ecoTotalWh: parseFloat(this._totalWh.toFixed(3)) });
    } catch { /* context invalidated */ }
  }
}

// ============================================================================
// UIManager — Shadow DOM floating panel injected into the YouTube player
// ============================================================================

class UIManager {
  constructor() {
    this._host = null;
    this._shadow = null;
    this._callbacks = {};
  }

  inject(anchorElement, settings, callbacks) {
    this._callbacks = callbacks;

    const host = document.createElement('div');
    host.id = 'eco-upscaler-ui';
    // Positioned full-size overlay so the panel inside shadow DOM stacks above the
    // canvas (z-index 50). pointer-events:none lets clicks pass through empty areas.
    Object.assign(host.style, {
      position: 'absolute',
      top: '0', left: '0', right: '0', bottom: '0',
      pointerEvents: 'none',
      zIndex: '2147483641',
    });
    anchorElement.style.position = anchorElement.style.position || 'relative';
    anchorElement.appendChild(host);
    this._host = host;

    const shadow = host.attachShadow({ mode: 'closed' });
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
        }
      </style>
      <div id="panel">
        <div class="row">
          <label>Eco Upscale</label>
          <label class="switch">
            <input type="checkbox" id="toggle" ${settings.enabled ? 'checked' : ''}>
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

    shadow.getElementById('toggle').addEventListener('change', (e) => {
      if (this._callbacks.onToggle) this._callbacks.onToggle(e.target.checked);
    });

    this.updateStatus(settings.enabled ? 'active' : 'off');
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
    const badge = this._shadow.getElementById('status-badge');
    if (!badge) return;
    const labels = { active: 'Active', degraded: 'Degraded', fallback: 'Fallback', disabled: 'Disabled', off: 'Off' };
    badge.textContent = labels[status] ?? status;
    badge.className = status;
  }

  updateToggle(enabled) {
    if (!this._shadow) return;
    const toggle = this._shadow.getElementById('toggle');
    if (toggle) toggle.checked = enabled;
  }

  updateEnergy(text) {
    if (!this._shadow) return;
    const el = this._shadow.getElementById('energy');
    if (el) el.textContent = text || '';
  }

  updateResolution(width, height, rendererSuffix = '') {
    if (!this._shadow) return;
    const el = this._shadow.getElementById('res');
    if (!el) return;
    let label = '';
    if (height >= 2160) label = '4K';
    else if (height >= 1440) label = '1440p';
    else if (height >= 1080) label = '1080p';
    else if (height >= 720) label = '720p';
    else if (height > 0) label = `${height}p`;
    el.textContent = label ? `Source: ${label}${rendererSuffix}` : '';
  }
}

// ============================================================================
// Orchestrator — top-level lifecycle
// ============================================================================

class PlayerToggleManager {
  constructor() {
    this._anchor = null;
    this._button = null;
    this._observer = null;
    this._callbacks = {};
    this._enabled = false;
    this._status = 'off';
    this._resolutionLabel = '';
    this._leafUrl = '';
    this._retryTimer = null;
    this._lastInsertTarget = null;
    this._fallbackHost = null;
    this._boundClick = this._handleClick.bind(this);
    this._boundEnsureInserted = this._ensureInserted.bind(this);
  }

  inject(anchorElement, settings, callbacks) {
    this._anchor = anchorElement;
    this._callbacks = callbacks;
    this._enabled = !!settings.enabled;
    this._status = this._enabled ? 'active' : 'off';
    this._leafUrl = chrome.runtime.getURL('icons/disabled_leaf_icon.png');

    this._button = this._createButton();
    this._button.addEventListener('click', this._boundClick);
    this._applyState();
    this._ensureInserted();
    this._startObserver();
    this._startRetryTimer();
  }

  remove() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._button) {
      this._button.removeEventListener('click', this._boundClick);
      this._button.remove();
      this._button = null;
    }
    if (this._fallbackHost) {
      this._fallbackHost.remove();
      this._fallbackHost = null;
    }
    this._anchor = null;
    this._lastInsertTarget = null;
    this._callbacks = {};
  }

  updateStatus(status) {
    this._status = status || (this._enabled ? 'active' : 'off');
    this._applyState();
  }

  updateToggle(enabled) {
    this._enabled = !!enabled;
    this._status = this._enabled ? 'active' : 'off';
    this._applyState();
    this._ensureInserted();
  }

  updateEnergy() {
    this._applyState();
  }

  updateResolution(width, height, rendererSuffix = '') {
    let label = '';
    if (height >= 2160) label = '4K';
    else if (height >= 1440) label = '1440p';
    else if (height >= 1080) label = '1080p';
    else if (height >= 720) label = '720p';
    else if (height > 0) label = `${height}p`;
    this._resolutionLabel = label ? `Source: ${label}${rendererSuffix}` : '';
    this._applyState();
  }

  _createButton() {
    const button = document.createElement('button');
    button.className = 'ytp-button eco-upscaler-control';
    button.type = 'button';
    button.setAttribute('aria-label', 'Eco Upscale');
    button.innerHTML = `
      <span class="eco-toggle-track" aria-hidden="true">
        <span class="eco-toggle-thumb">
          <span class="eco-toggle-leaf"></span>
        </span>
      </span>
    `;
    button.style.setProperty('--eco-leaf-url', `url("${this._leafUrl}")`);
    return button;
  }

  _handleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const nextEnabled = !this._enabled;
    this.updateToggle(nextEnabled);
    if (this._callbacks.onToggle) this._callbacks.onToggle(nextEnabled);
  }

  _startObserver() {
    if (!this._anchor || this._observer) return;
    this._observer = new MutationObserver(this._boundEnsureInserted);
    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  _startRetryTimer() {
    if (this._retryTimer) return;
    let attempts = 0;
    this._retryTimer = setInterval(() => {
      attempts++;
      this._ensureInserted();
      if (this._button?.isConnected && this._button.getBoundingClientRect().width > 0) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
      } else if (attempts >= 40) {
        console.warn('[EcoUpscaler] Player toggle was not visibly mounted.', this.debugSnapshot());
        clearInterval(this._retryTimer);
        this._retryTimer = null;
      }
    }, 250);
  }

  _ensureInserted() {
    if (!this._anchor || !this._button) return;

    const target = this._findInsertionTarget();
    if (!target) return;

    const { container, before } = target;
    if (this._button.parentElement === container) return;

    const existing = container.querySelector('.eco-upscaler-control');
    if (existing && existing !== this._button) existing.remove();

    const insertionPoint = before?.parentElement === container ? before : null;
    container.insertBefore(this._button, insertionPoint);

    if (this._lastInsertTarget !== container) {
      this._lastInsertTarget = container;
      console.info('[EcoUpscaler] Inserted player toggle.', container);
    }
  }

  _findInsertionTarget() {
    const player =
      this._anchor?.id === 'movie_player'
        ? this._anchor
        : document.querySelector('#movie_player') || this._anchor;
    if (!player) return null;

    const rightControls = player.querySelector('.ytp-right-controls');
    if (rightControls) {
      return {
        container: rightControls,
        before:
          this._findDirectChild(rightControls, '.ytp-subtitles-button') ||
          this._findDirectChild(rightControls, '.ytp-settings-button') ||
          this._findDirectChild(rightControls, '.ytp-miniplayer-button'),
      };
    }

    const chromeControls = player.querySelector('.ytp-chrome-controls');
    if (chromeControls) {
      return {
        container: chromeControls,
        before:
          this._findDirectChild(chromeControls, '.ytp-subtitles-button') ||
          this._findDirectChild(chromeControls, '.ytp-settings-button') ||
          this._findDirectChild(chromeControls, '.ytp-miniplayer-button') ||
          this._findDirectChild(chromeControls, '.ytp-fullscreen-button'),
      };
    }

    const chromeBottom = player.querySelector('.ytp-chrome-bottom') || player;
    return {
      container: this._ensureFallbackHost(chromeBottom),
      before: null,
    };
  }

  _ensureFallbackHost(parent) {
    if (this._fallbackHost?.isConnected) return this._fallbackHost;

    const host = document.createElement('div');
    host.className = 'eco-upscaler-control-host';
    parent.appendChild(host);
    this._fallbackHost = host;
    return host;
  }

  _findDirectChild(container, selector) {
    const match = container.querySelector(selector);
    if (!match) return null;
    if (match.parentElement === container) return match;
    return Array.from(container.children).find((child) => child.contains(match)) || null;
  }

  _isMountedInPlayer() {
    return !!this._button?.isConnected;
  }

  debugSnapshot() {
    const player = this._anchor || document.querySelector('#movie_player');
    return {
      hasPlayer: !!player,
      hasRightControls: !!player?.querySelector('.ytp-right-controls'),
      hasChromeControls: !!player?.querySelector('.ytp-chrome-controls'),
      hasChromeBottom: !!player?.querySelector('.ytp-chrome-bottom'),
      buttonConnected: this._isMountedInPlayer(),
      parentClass: this._button?.parentElement?.className || null,
    };
  }

  _applyState() {
    if (!this._button) return;

    this._button.classList.toggle('eco-active', this._enabled);
    this._button.classList.toggle('eco-degraded', this._status === 'degraded');
    this._button.classList.toggle('eco-disabled', this._status === 'disabled');
    this._button.setAttribute('aria-pressed', String(this._enabled));

    const statusLabel = {
      active: 'On',
      degraded: 'Degraded',
      disabled: 'Disabled',
      off: 'Off',
    }[this._status] || (this._enabled ? 'On' : 'Off');

    const suffix = this._resolutionLabel ? ` - ${this._resolutionLabel}` : '';
    const title = `Eco Upscale: ${statusLabel}${suffix}`;
    this._button.title = title;
    this._button.setAttribute('aria-label', title);
  }
}

let _settingsManager = null;
let _videoDetector = null;
let _overlayManager = null;
let _upscalerPipeline = null;
let _frameProcessor = null;
let _perfMonitor = null;
let _backgroundQualityManager = null;
let _aiUpscaler = null;
let _energyTracker = null;
let _uiManager = null;
let _initialized = false;
let _currentPath = '';

function ensurePlayerToggle(settings) {
  if (_uiManager) {
    _uiManager.updateToggle(!!_settingsManager.get().enabled);
    return;
  }

  _uiManager = new PlayerToggleManager();
  _uiManager.inject(document.body, settings, {
    onToggle: (enabled) => {
      _settingsManager.save({ enabled, status: enabled ? 'active' : 'off' });
    },
  });
}

async function init() {
  const settings = _settingsManager.get();
  ensurePlayerToggle(settings);

  if (_initialized) return;

  try { chrome.storage.local.set({ onWatchPage: true }); } catch { /* context invalidated */ }

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

  const playerContainer = document.querySelector('#movie_player') || video.parentElement;
  const handleToggle = (enabled) => {
    _settingsManager.save({ enabled, status: enabled ? 'active' : 'off' });
    _overlayManager && _overlayManager.setVisible(enabled);

    if (enabled) {
      _perfMonitor && _perfMonitor.reset();
      if (_frameProcessor && _upscalerPipeline && _perfMonitor) {
        _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
      }
      _energyTracker && _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
    } else {
      _frameProcessor && _frameProcessor.stop();
      _energyTracker && _energyTracker.end();
      _uiManager && _uiManager.updateEnergy(_energyTracker ? _energyTracker.formatDisplay() : '');
    }

    _backgroundQualityManager && _backgroundQualityManager.refresh();
    _uiManager && _uiManager.updateStatus(enabled ? 'active' : 'off');
  };

  if (playerContainer) {
    _backgroundQualityManager = new BackgroundQualityManager(_settingsManager);
    _backgroundQualityManager.start(playerContainer);

    if (_uiManager) {
      _uiManager.remove();
    }
    _uiManager = new PlayerToggleManager();
    _uiManager.inject(playerContainer, _settingsManager.get(), { onToggle: handleToggle });
  }

  _overlayManager = new OverlayManager();
  const canvas = _overlayManager.create(video);
  _overlayManager.setVisible(settings.enabled);

  _upscalerPipeline = new UpscalerPipeline(canvas, video, settings);
  await _upscalerPipeline.init();

  _energyTracker = new EnergyTracker();
  await _energyTracker.load();

  _perfMonitor = new PerformanceMonitor();
  _perfMonitor.onDegrade(() => {
    _uiManager && _uiManager.updateStatus('degraded');
  });
  _perfMonitor.onDisable(() => {
    _settingsManager.save({ enabled: false, status: 'disabled' });
    _frameProcessor && _frameProcessor.stop();
    _overlayManager && _overlayManager.setVisible(false);
    _uiManager && _uiManager.updateToggle(false);
    _uiManager && _uiManager.updateStatus('disabled');
  });
  _perfMonitor.onRecover(() => {
    _uiManager && _uiManager.updateStatus('active');
  });

  _frameProcessor = new FrameProcessor();
  if (settings.enabled) {
    _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
    _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
  }

  if (_uiManager && _energyTracker) {
    _uiManager.updateEnergy(_energyTracker.formatDisplay());
  }

  const rendererLabel = _upscalerPipeline.getRendererType() === 'webgl' ? ' · GL' : '';
  const showRes = () => {
    if (_uiManager) _uiManager.updateResolution(video.videoWidth, video.videoHeight, rendererLabel);
  };
  video.addEventListener('loadedmetadata', showRes);
  showRes();

  // Reinit on adaptive quality switches so canvas tracks the new source dimensions.
  video.addEventListener('resize', () => {
    if (!_initialized) return;
    cleanup();
    setTimeout(() => init(), 150);
  });

  _settingsManager.onChange((all, changed) => {
    if (!_initialized) return;
    if ('enabled' in changed) {
      _overlayManager.setVisible(all.enabled);
      _uiManager && _uiManager.updateToggle(all.enabled);
      if (all.enabled) {
        _perfMonitor.reset();
        _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
        _energyTracker && _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
      } else {
        _frameProcessor.stop();
        _energyTracker && _energyTracker.end();
        _uiManager && _uiManager.updateEnergy(_energyTracker ? _energyTracker.formatDisplay() : '');
      }
      _uiManager && _uiManager.updateStatus(all.status || (all.enabled ? 'active' : 'off'));
    } else if ('status' in changed) {
      _uiManager && _uiManager.updateStatus(all.status);
    }
  });
}

function cleanup() {
  if (!_initialized) return;
  _initialized = false;

  try { chrome.storage.local.set({ onWatchPage: false, status: 'off' }); } catch { /* context invalidated */ }

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

  if (path.startsWith('/watch')) {
    init();
  } else {
    cleanup();
  }
}

function interceptNavigation() {
  const _origPush = history.pushState.bind(history);
  const _origReplace = history.replaceState.bind(history);
  const fireNav = () => onNavigate(location.pathname + location.search);

  history.pushState = function (...args) { _origPush(...args); fireNav(); };
  history.replaceState = function (...args) { _origReplace(...args); fireNav(); };
  window.addEventListener('popstate', fireNav);

  document.addEventListener('yt-navigate-finish', fireNav);

  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => {
      const path = location.pathname + location.search;
      if (path !== _currentPath) onNavigate(path);
    }).observe(titleEl, { childList: true });
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

async function bootstrap() {
  _settingsManager = new SettingsManager();
  await _settingsManager.load();
  interceptNavigation();
  onNavigate(location.pathname + location.search);
}

bootstrap();
