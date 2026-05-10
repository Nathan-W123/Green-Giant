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
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;

    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  _startResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => this._updateCanvasSize());
    this._resizeObserver.observe(this._player);
  }

  _handleFullscreen() {
    this._fsHandler = () => this._updateCanvasSize();
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
// EnergyTracker — dynamic statistical energy savings model.
//
// Sources blended into the lookup table:
//   • IEA "Electricity 2024" — device decode power by resolution tier
//   • Carbon Trust "Streaming" (2021) — end-to-end network + CDN energy
//   • Malmodin & Lundén (2018) — energy intensity per GB by access type
//
// Model structure (Wh/hr saved vs streaming the same content at native 4K):
//   savings = device_savings(sourceHeight) + network_savings(bitrateDelta, connType)
//
// Network savings: Δbitrate (Mbps) × 0.45 GB/Mbps/hr × kWh_per_GB × 1000
//   kWh/GB: ethernet 0.04, wifi 0.08, 4g 0.24, 3g 0.40, 2g 0.60, unknown 0.10
// Device savings: linear with pixel-count reduction from 4K baseline (≈8 W max delta)
//
// Both are pre-computed into _SAVINGS_TABLE for O(1) lookup per tick.
// ============================================================================

const _SAVINGS_TABLE = (() => {
  // YouTube average bitrates (Mbps) per height tier
  const BITRATE = { 2160: 20, 1440: 12, 1080: 6.5, 720: 3.5, 480: 2, 360: 1, 0: 6.5 };

  // Network energy intensity (kWh per GB transferred), includes last-mile + CDN
  const KWH_PER_GB = { ethernet: 0.04, wifi: 0.08, '4g': 0.24, cellular: 0.24, '3g': 0.40, '2g': 0.60, unknown: 0.10 };

  // Max additional GPU/CPU decode power for 4K vs minimal (W)
  const MAX_DECODE_W = 8;
  const PX_4K = 3840 * 2160;

  const heights = [2160, 1440, 1080, 720, 480, 360, 0];
  const connTypes = Object.keys(KWH_PER_GB);
  const table = {};

  for (const h of heights) {
    table[h] = {};
    const bitrateDelta = Math.max(0, BITRATE[2160] - (BITRATE[h] ?? BITRATE[0]));
    const gbPerHr = bitrateDelta * 0.45; // 1 Mbps × 3600s / 8 / 1000 ≈ 0.45 GB/hr

    // Pixel-count ratio vs 4K; assume 16:9 source
    const srcPx = h > 0 ? (h * 16 / 9) * h : (1080 * 16 / 9) * 1080;
    const decodeWhPerHr = MAX_DECODE_W * Math.max(0, 1 - srcPx / PX_4K);

    for (const c of connTypes) {
      const networkWhPerHr = gbPerHr * (KWH_PER_GB[c] ?? KWH_PER_GB.unknown) * 1000;
      table[h][c] = parseFloat((networkWhPerHr + decodeWhPerHr).toFixed(2));
    }
  }
  return table;
})();

function _lookupRate(videoHeight, connType) {
  const heights = [2160, 1440, 1080, 720, 480, 360];
  const h = heights.find(t => videoHeight >= t) ?? 0;
  const row = _SAVINGS_TABLE[h] ?? _SAVINGS_TABLE[0];
  return row[connType] ?? row.unknown;
}

function _connectionType() {
  const conn = navigator.connection;
  if (!conn) return 'unknown';
  // effectiveType ('slow-2g','2g','3g','4g') takes precedence over type
  const et = conn.effectiveType;
  if (et === '4g') return '4g';
  if (et === '3g') return '3g';
  if (et === '2g' || et === 'slow-2g') return '2g';
  const t = conn.type;
  if (t === 'ethernet') return 'ethernet';
  if (t === 'wifi') return 'wifi';
  if (t === 'cellular') return 'cellular';
  return 'unknown';
}

class EnergyTracker {
  constructor() {
    this._startMs  = null;
    this._video    = null;
    this._sessionWh = 0;
    this._totalWh  = 0;
    this._currentRate = 0; // Wh/hr, updated each flush
    this._interval = null;
    this._onUpdate = null;
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
    this._sessionWh  = 0;
    this._currentRate = 0;
    this._onUpdate   = null;
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
    // Only count time while the video is actually playing
    if (!this._video || this._video.paused || this._video.ended) return;
    const height   = this._video.videoHeight || 1080;
    const connType = _connectionType();
    this._currentRate = _lookupRate(height, connType);
    const wh = hrs * this._currentRate;
    this._sessionWh += wh;
    this._totalWh   += wh;
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
  if (playerContainer) {
    _aiUpscaler = new AITileUpscaler(playerContainer, video);
    await _aiUpscaler.init(); // fails silently if FaceDetector/ONNX unavailable
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
