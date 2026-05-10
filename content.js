import { UpscalerPipeline } from './upscaler.js';
import { AITileUpscaler } from './ai-upscaler.js';

// YouTube Eco Upscaler — content script orchestrator.

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
    this._fsHandler = null;
    this._theaterObserver = null;
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
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '50',
      imageRendering: 'auto',
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
      document.removeEventListener('fullscreenchange', this._fsHandler);
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
      this._canvas.style.display = visible ? 'block' : 'none';
    }
  }

  _updateCanvasSize() {
    const canvas = this._canvas;
    const container = this._player;
    if (!canvas || !container) return;

    const dpr = devicePixelRatio || 1;
    // In fullscreen the container's clientWidth can lag behind the actual viewport
    // during the transition; window.innerWidth/Height is always current.
    const inFS = !!document.fullscreenElement;
    const w = inFS ? window.innerWidth  : container.clientWidth;
    const h = inFS ? window.innerHeight : container.clientHeight;
    if (w === 0 || h === 0) return;

    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width  = pw;
      canvas.height = ph;
    }
  }

  _startResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => this._updateCanvasSize());
    this._resizeObserver.observe(this._player);
  }

  _handleFullscreen() {
    // Double-rAF: fullscreenchange fires before the browser has finished
    // reflowing the new viewport size; two animation frames guarantee layout settled.
    this._fsHandler = () => requestAnimationFrame(() =>
      requestAnimationFrame(() => this._updateCanvasSize())
    );
    document.addEventListener('fullscreenchange', this._fsHandler);
  }

  _handleTheaterMode() {
    document.addEventListener('yt-set-theater-mode-enabled', () => {
      setTimeout(() => this._updateCanvasSize(), 50);
    });
    const app = document.querySelector('ytd-app');
    if (app) {
      this._theaterObserver = new MutationObserver(() => {
        setTimeout(() => this._updateCanvasSize(), 50);
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
    this._update();
  }

  stop() {
    document.removeEventListener('visibilitychange', this._boundUpdate);
    this._restore();
    this._player = null;
  }

  refresh() {
    this._update();
  }

  _update() {
    if (!this._settingsManager.get().enabled) { this._restore(); return; }
    if (document.hidden) this._lower();
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
//   streamMbps  = video.webkitVideoDecodedByteCount diff (actual) OR table fallback
//   ceilingMbps = table lookup for highest quality YouTube offered (getAvailableQualityLevels)
//   gbSaved     = (ceilingMbps - streamMbps) × 0.45 GB/Mbps/hr × intervalHrs
//   networkWh   = gbSaved × _whPerGb(connection.type, connection.effectiveType)
//   deviceWh    = _MAX_DECODE_W × (1 - srcPixels / _PX_4K) × intervalHrs
//   totalWh     = networkWh + deviceWh
//   co2g        = totalWh × _getCarbonIntensity() / 1000
//
// Sources: IEA 2024 (fixed networks), Malmodin & Lundén 2020 (mobile ratio),
//          IEA 2022 grid carbon intensity by country.
// ============================================================================

// YouTube VP9/AV1 average bitrates (Mbps) by resolution + framerate tier.
// Used for 4K counterfactual (always) and current stream (when
// webkitVideoDecodedByteCount is unavailable).
const _YT_BITRATE = {
  2160: { 30: 16, 60: 24 },
  1440: { 30:  8, 60: 13 },
  1080: { 30:  5, 60:  8 },
   720: { 30:  3, 60:  5 },
   480: { 30: 1.5, 60: 2.5 },
   360: { 30: 0.8, 60: 1.2 },
};

// Wh per GB by connection medium (IEA 2024 + Malmodin 2020 marginal estimates).
// Fixed (WiFi/ethernet): ~2.5 Wh/GB. Mobile LTE uses ~3× more per GB; 3G/2G more still.
const _WH_PER_GB_FIXED    = 2.5;
const _WH_PER_GB_4G       = 7.0;
const _WH_PER_GB_3G       = 18.0;
const _WH_PER_GB_2G       = 40.0;
const _MAX_DECODE_W       = 5.0;  // hardware+software mix decode power delta (W), 4K vs 1080p
const _PX_4K              = 3840 * 2160;

// Return Wh/GB based on connection.type and connection.effectiveType.
// connection.type ('wifi','ethernet','cellular','unknown') is more reliable than
// effectiveType alone, which can't distinguish WiFi from LTE on its own.
function _whPerGb(connType, effectiveType) {
  if (connType === 'wifi' || connType === 'ethernet') return _WH_PER_GB_FIXED;
  if (connType === 'cellular') {
    if (effectiveType === '4g')               return _WH_PER_GB_4G;
    if (effectiveType === '3g')               return _WH_PER_GB_3G;
    return _WH_PER_GB_2G;
  }
  // Unknown medium: effectiveType gives the best available signal.
  // '4g' could be LTE or WiFi — use midpoint between fixed and 4G.
  if (effectiveType === '4g')                 return (_WH_PER_GB_FIXED + _WH_PER_GB_4G) / 2;
  if (effectiveType === '3g')                 return _WH_PER_GB_3G;
  return _WH_PER_GB_2G;
}

function _ytBitrate(height, fps) {
  const heights = [2160, 1440, 1080, 720, 480, 360];
  const h = heights.find(t => height >= t) ?? 360;
  return _YT_BITRATE[h]?.[fps > 35 ? 60 : 30] ?? 5;
}

// ── Grid carbon intensity by IANA timezone (IEA 2022 annual avg gCO2/kWh) ────
const _CO2_BY_ZONE = {
  'America/New_York': 380,  'America/Chicago': 420,    'America/Denver': 350,
  'America/Los_Angeles': 210, 'America/Phoenix': 400,  'America/Toronto': 130,
  'America/Vancouver': 25,  'America/Sao_Paulo': 100,  'America/Mexico_City': 450,
  'America/Lima': 290,      'America/Bogota': 200,      'America/Santiago': 240,
  'America/Buenos_Aires': 380,
  'Europe/London': 180,     'Europe/Paris': 70,         'Europe/Berlin': 360,
  'Europe/Amsterdam': 290,  'Europe/Madrid': 160,       'Europe/Rome': 230,
  'Europe/Warsaw': 650,     'Europe/Stockholm': 40,     'Europe/Oslo': 30,
  'Europe/Zurich': 90,      'Europe/Helsinki': 90,      'Europe/Vienna': 180,
  'Europe/Brussels': 150,   'Europe/Copenhagen': 160,   'Europe/Dublin': 280,
  'Europe/Lisbon': 170,     'Europe/Prague': 430,       'Europe/Budapest': 250,
  'Europe/Bucharest': 290,  'Europe/Athens': 320,       'Europe/Istanbul': 420,
  'Asia/Tokyo': 460,        'Asia/Shanghai': 580,       'Asia/Seoul': 400,
  'Asia/Kolkata': 640,      'Asia/Singapore': 380,      'Asia/Dubai': 400,
  'Asia/Hong_Kong': 580,    'Asia/Taipei': 480,         'Asia/Bangkok': 520,
  'Asia/Jakarta': 700,      'Asia/Karachi': 380,        'Asia/Dhaka': 540,
  'Australia/Sydney': 620,  'Australia/Melbourne': 620, 'Australia/Brisbane': 690,
  'Australia/Perth': 620,   'Australia/Adelaide': 480,
  'Pacific/Auckland': 130,  'Pacific/Honolulu': 700,
  'Africa/Johannesburg': 700, 'Africa/Cairo': 460,      'Africa/Lagos': 480,
  'Africa/Nairobi': 200,
};
const _CO2_REGIONAL_AVG = {
  America: 350, Europe: 250, Asia: 500, Africa: 580,
  Australia: 620, Pacific: 400, Indian: 450, Atlantic: 350,
};
const _CO2_GLOBAL_AVG = 450;

function _getCarbonIntensity() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const exact = _CO2_BY_ZONE[tz];
    if (exact !== undefined) return exact;
    return _CO2_REGIONAL_AVG[tz.split('/')[0]] ?? _CO2_GLOBAL_AVG;
  } catch { return _CO2_GLOBAL_AVG; }
}

// YouTube player quality label → display height in pixels.
const _YT_QUALITY_HEIGHT = {
  highres: 4320, hd2160: 2160, hd1440: 1440,
  hd1080: 1080,  hd720: 720,   large: 480,
  medium: 360,   small: 240,   tiny: 144,
};

// Returns the tallest quality YouTube offered for this video (capped at 2160).
// If the player API is unavailable, assumes 4K was available (conservative).
function _getMaxAvailableHeight() {
  try {
    const player = document.querySelector('#movie_player');
    const levels = player?.getAvailableQualityLevels?.();
    if (Array.isArray(levels) && levels.length > 0) {
      let max = 0;
      for (const l of levels) {
        const h = _YT_QUALITY_HEIGHT[l];
        if (h && h > max) max = h;
      }
      if (max > 0) return Math.min(max, 2160);
    }
  } catch { /* player not ready */ }
  return 2160;
}

class EnergyTracker {
  constructor() {
    this._startMs          = null;
    this._video            = null;
    this._sessionWh        = 0;
    this._totalWh          = 0;
    this._currentRate      = 0;
    this._interval         = null;
    this._onUpdate         = null;
    // FPS estimation via getVideoPlaybackQuality()
    this._lastFrames       = null;
    this._lastFrameMs      = null;
    // Actual bitrate measurement via webkitVideoDecodedByteCount
    this._lastDecodedBytes   = null;
    this._lastDecodedBytesMs = null;
    // Carbon intensity for this session (gCO2/kWh) derived from timezone
    this._carbonIntensity  = _getCarbonIntensity();
    // Highest quality YouTube offered — updated each flush
    this._referenceHeight  = 2160;
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
    this._sessionWh          = 0;
    this._currentRate        = 0;
    this._onUpdate           = null;
    this._lastFrames         = null;
    this._lastFrameMs        = null;
    this._lastDecodedBytes   = null;
    this._lastDecodedBytesMs = null;
    this._referenceHeight    = 2160;
  }

  // Returns a display string: rate line + lifetime line (newline-separated).
  formatDisplay() {
    const total    = this._totalWh;
    const rate     = this._currentRate;
    const ci       = this._carbonIntensity;        // gCO2/kWh
    const refLabel = this._referenceHeight >= 2160 ? '4K' : `${this._referenceHeight}p`;

    // CO2 conversions
    const co2RateG  = rate  * ci / 1000;           // gCO2/hr
    const co2TotalG = total * ci / 1000;            // gCO2 lifetime

    const rateStr = rate >= 0.1
      ? `~${rate.toFixed(1)} Wh/hr · ~${co2RateG.toFixed(0)}g CO₂/hr vs ${refLabel}`
      : null;

    let totalStr = null;
    if (total >= 0.05) {
      const whStr  = total < 1000 ? `${total.toFixed(1)} Wh` : `${(total / 1000).toFixed(2)} kWh`;
      const co2Str = co2TotalG < 1000
        ? `${co2TotalG.toFixed(0)}g CO₂`
        : `${(co2TotalG / 1000).toFixed(2)}kg CO₂`;
      totalStr = `${whStr} · ${co2Str} saved`;
    }

    if (!rateStr && !totalStr) return '';
    if (rateStr && totalStr)   return `↓ ${rateStr}\n${totalStr} lifetime`;
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

    // ── Connection type (more reliable than RTT for energy lookup) ───────────
    const conn          = navigator.connection;
    const connType      = conn?.type          ?? 'unknown';   // 'wifi','ethernet','cellular',…
    const effectiveType = conn?.effectiveType ?? '4g';

    // ── Stream bitrate: actual measurement first, table fallback ─────────────
    const height       = this._video.videoHeight || 1080;
    const fps          = this._measureFPS();
    const measuredMbps = this._measureActualBitrateMbps();
    const streamMbps   = measuredMbps !== null ? measuredMbps : _ytBitrate(height, fps);

    // Use highest quality YouTube actually offered — not assumed to be 4K.
    const maxHeight    = _getMaxAvailableHeight();
    this._referenceHeight = maxHeight;
    const ceilingMbps  = _ytBitrate(maxHeight, fps);
    const deltaMbps    = Math.max(0, ceilingMbps - streamMbps);

    // ── GB not transferred this interval ─────────────────────────────────────
    // 1 Mbps for 1 hr = (1e6 b/s × 3600 s) / 8 / 1e9 = 0.45 GB
    const gbSaved   = deltaMbps * 0.45 * hrs;

    // ── Network energy: connection-type-specific Wh/GB ───────────────────────
    const networkWh = gbSaved * _whPerGb(connType, effectiveType);

    // ── Device decode energy: actual pixel count, not assumed 16:9 ──────────
    const srcPx   = (this._video.videoWidth  || Math.round(height * 16 / 9))
                  * (this._video.videoHeight || height);
    const deviceWh = _MAX_DECODE_W * Math.max(0, 1 - srcPx / _PX_4K) * hrs;

    const wh = networkWh + deviceWh;
    this._currentRate = hrs > 0 ? wh / hrs : 0;
    this._sessionWh  += wh;
    this._totalWh    += wh;
  }

  // Measures actual compressed stream bitrate from bytes decoded since last tick.
  // Returns Mbps, or null if the property is unavailable (non-Chrome, or first tick).
  _measureActualBitrateMbps() {
    const bytes = this._video.webkitVideoDecodedByteCount;
    if (typeof bytes !== 'number') return null;
    const now = performance.now();
    let mbps = null;
    if (this._lastDecodedBytes !== null && bytes >= this._lastDecodedBytes) {
      const db = bytes - this._lastDecodedBytes;
      const dt = (now - this._lastDecodedBytesMs) / 1000;
      // Require at least 2s between samples to smooth burstiness
      if (dt >= 2 && db >= 0) mbps = (db * 8) / dt / 1e6;
    }
    this._lastDecodedBytes   = bytes;
    this._lastDecodedBytesMs = now;
    return mbps;
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
        #ai-badge {
          font-size: 10px;
          font-weight: 600;
          padding: 2px 7px;
          border-radius: 20px;
          background: #444;
          color: #aaa;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }
        #ai-badge.on  { background: #14532d; color: #4ade80; }
        #ai-badge.off { background: #450a0a; color: #f87171; }
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
            <input type="checkbox" id="toggle" ${settings.enabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div class="row">
          <label>Status</label>
          <span id="status-badge">Off</span>
        </div>
        <div class="row">
          <label>AI</label>
          <span id="ai-badge">—</span>
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

  updateAIStatus(ready) {
    if (!this._shadow) return;
    const badge = this._shadow.getElementById('ai-badge');
    if (!badge) return;
    badge.textContent = ready ? 'Active' : 'Off';
    badge.className   = ready ? 'on' : 'off';
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

async function init() {
  if (_initialized) return;

  try { chrome.storage.local.set({ onWatchPage: true }); } catch { /* context invalidated */ }

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

  const playerContainer = document.querySelector('#movie_player') || video.parentElement;
  let aiReady = false;
  if (playerContainer) {
    _aiUpscaler = new AITileUpscaler(playerContainer, video);
    aiReady = await _aiUpscaler.init();
  }

  _overlayManager.setVisible(settings.enabled);

  _perfMonitor = new PerformanceMonitor();
  _perfMonitor.onDegrade(() => {
    _uiManager && _uiManager.updateStatus('degraded');
  });
  _perfMonitor.onDisable(() => {
    _settingsManager.save({ enabled: false, status: 'disabled' });
    _frameProcessor && _frameProcessor.stop();
    _overlayManager && _overlayManager.setVisible(false);
    _uiManager && _uiManager.updateStatus('disabled');
    _uiManager && _uiManager.updateToggle(false);
  });
  _perfMonitor.onRecover(() => {
    _uiManager && _uiManager.updateStatus('active');
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
        _settingsManager.save({ enabled, status: enabled ? 'active' : 'off' });
        _overlayManager.setVisible(enabled);
        if (enabled) {
          _perfMonitor.reset();
          _frameProcessor.start(video, _upscalerPipeline, _perfMonitor, _aiUpscaler);
          // Force-render immediately so a paused video shows the enhanced frame
          // rather than leftover canvas content from a previous session.
          if (video.readyState >= 2) _upscalerPipeline.processFrame();
          _energyTracker && _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
        } else {
          _frameProcessor.stop();
          _energyTracker && _energyTracker.end();
          _uiManager.updateEnergy(_energyTracker ? _energyTracker.formatDisplay() : '');
        }
        _backgroundQualityManager && _backgroundQualityManager.refresh();
        _uiManager.updateStatus(enabled ? 'active' : 'off');
      },
    });
  }

  if (_uiManager && _energyTracker) {
    _uiManager.updateEnergy(_energyTracker.formatDisplay());
  }
  if (_uiManager) _uiManager.updateAIStatus(aiReady);

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
        if (video.readyState >= 2) _upscalerPipeline.processFrame();
        _energyTracker && _energyTracker.begin(video, () => _uiManager && _uiManager.updateEnergy(_energyTracker.formatDisplay()));
      } else {
        _frameProcessor.stop();
        _energyTracker && _energyTracker.end();
        _uiManager && _uiManager.updateEnergy(_energyTracker ? _energyTracker.formatDisplay() : '');
      }
      _uiManager && _uiManager.updateStatus(all.enabled ? 'active' : 'off');
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
