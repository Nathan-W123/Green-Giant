import { UpscalerPipeline } from './upscaler.js';

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
      mode: 'balanced',
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
            // Give YouTube a brief moment to insert the replacement video element.
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
    // Append canvas inside #movie_player so our z-index (1) sits in the same stacking
    // context as YouTube's controls (z-index 30+). CSS positions it via inset: 0.
    this._player = document.querySelector('#movie_player') || video.parentElement;

    const canvas = document.createElement('canvas');
    canvas.id = 'eco-upscaler-overlay';
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

  // Updates the canvas pixel buffer size to match the player's current display size.
  // CSS (position: absolute; inset: 0) handles visual sizing automatically.
  _updateCanvasSize() {
    const canvas = this._canvas;
    const container = this._player;
    if (!canvas || !container) return;

    const dpr = devicePixelRatio;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  _startResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => {
      this._updateCanvasSize();
    });
    this._resizeObserver.observe(this._player);
  }

  _handleFullscreen() {
    // Canvas is already inside #movie_player which becomes the fullscreen element,
    // so no reparenting is needed. Just sync the pixel buffer size.
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
    this._perfMonitor = null;
    this._rafId = null;
    this._useRVFC = false;
  }

  start(video, pipeline, perfMonitor) {
    this.stop();
    this._video = video;
    this._pipeline = pipeline;
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
    if (video.readyState < 2) return; // HAVE_CURRENT_DATA — no frame yet

    const t0 = performance.now();
    this._pipeline.processFrame();
    this._perfMonitor.recordFrame(performance.now() - t0);
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

    // Evaluate every 30 frames.
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
        .toggle-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
        }
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
        select {
          background: #333;
          color: #fff;
          border: 1px solid #555;
          border-radius: 4px;
          padding: 2px 4px;
          font-size: 11px;
          cursor: pointer;
        }
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
          <label>Mode</label>
          <select id="mode-select">
            <option value="smooth"  ${settings.mode === 'smooth'  ? 'selected' : ''}>Smooth</option>
            <option value="balanced"${settings.mode === 'balanced' ? 'selected' : ''}>Balanced</option>
            <option value="sharp"   ${settings.mode === 'sharp'   ? 'selected' : ''}>Sharp</option>
          </select>
        </div>
        <div class="row">
          <label>Status</label>
          <span id="status-badge">Off</span>
        </div>
        <div id="res"></div>
      </div>
    `;

    shadow.getElementById('toggle').addEventListener('change', (e) => {
      if (this._callbacks.onToggle) this._callbacks.onToggle(e.target.checked);
    });

    shadow.getElementById('mode-select').addEventListener('change', (e) => {
      if (this._callbacks.onModeChange) this._callbacks.onModeChange(e.target.value);
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

  updateMode(mode) {
    if (!this._shadow) return;
    const sel = this._shadow.getElementById('mode-select');
    if (sel) sel.value = mode;
  }

  updateToggle(enabled) {
    if (!this._shadow) return;
    const toggle = this._shadow.getElementById('toggle');
    if (toggle) toggle.checked = enabled;
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
let _uiManager = null;
let _initialized = false;
let _currentPath = '';

const MODE_ORDER = ['sharp', 'balanced', 'smooth'];

async function init() {
  if (_initialized) return;

  try { chrome.storage.local.set({ onWatchPage: true }); } catch { /* context invalidated */ }

  const settings = _settingsManager.get();

  // Find video element.
  _videoDetector = new VideoDetector();
  _videoDetector.onVideoFound = (video) => _onVideoReady(video, settings);
  _videoDetector.onVideoReplaced = (video) => {
    cleanup();
    setTimeout(() => init(), 150);
  };
  _videoDetector.start();
}

async function _onVideoReady(video, settings) {
  if (_initialized) return;
  _initialized = true;

  // Create overlay canvas.
  _overlayManager = new OverlayManager();
  const canvas = _overlayManager.create(video);

  // Build upscaler pipeline BEFORE hiding the canvas — Anime4K's render() internally
  // reads canvas dimensions to configure its WebGPU context. A display:none canvas
  // reports clientWidth/clientHeight of 0, producing a 0×0 render target.
  _upscalerPipeline = new UpscalerPipeline(canvas, video, settings);
  await _upscalerPipeline.init();

  // Hide canvas after pipeline is bound.
  _overlayManager.setVisible(settings.enabled);

  // Performance monitor with auto-downgrade wiring.
  _perfMonitor = new PerformanceMonitor();
  _perfMonitor.onDegrade((fps) => {
    const currentMode = _settingsManager.get().mode;
    const idx = MODE_ORDER.indexOf(currentMode);
    if (idx < MODE_ORDER.length - 1) {
      const nextMode = MODE_ORDER[idx + 1];
      _settingsManager.save({ mode: nextMode });
      _upscalerPipeline.updateSettings({ mode: nextMode });
      _uiManager && _uiManager.updateMode(nextMode);
      _uiManager && _uiManager.updateStatus('degraded');
    }
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

  // Start frame loop only if enabled and NOT using Anime4K.
  // Anime4K's render() drives its own internal loop — FrameProcessor is not needed.
  _frameProcessor = new FrameProcessor();
  const isAnime4K = _upscalerPipeline.getRendererType() === 'anime4k';
  if (settings.enabled && !isAnime4K) {
    _frameProcessor.start(video, _upscalerPipeline, _perfMonitor);
  }

  // Inject floating UI into the player container.
  const playerContainer = document.querySelector('#movie_player') || video.parentElement;
  if (playerContainer) {
    _uiManager = new UIManager();
    _uiManager.inject(playerContainer, settings, {
      onToggle: (enabled) => {
        _settingsManager.save({ enabled, status: enabled ? 'active' : 'off' });
        _overlayManager.setVisible(enabled);
        // Anime4K drives its own loop — just show/hide the canvas.
        // WebGL/2D need the FrameProcessor started/stopped explicitly.
        if (_upscalerPipeline.getRendererType() !== 'anime4k') {
          if (enabled) {
            _perfMonitor.reset();
            _frameProcessor.start(video, _upscalerPipeline, _perfMonitor);
          } else {
            _frameProcessor.stop();
          }
        }
        _uiManager.updateStatus(enabled ? 'active' : 'off');
      },
      onModeChange: (mode) => {
        _settingsManager.save({ mode });
        _upscalerPipeline.updateSettings({ mode });
      },
    });
  }


  // Show renderer type in resolution display (e.g. "Source: 1080p · AI").
  const rendererLabel = isAnime4K ? ' · AI' : (_upscalerPipeline.getRendererType() === 'webgl' ? ' · GL' : '');
  const showRes = () => {
    if (_uiManager) {
      _uiManager.updateResolution(video.videoWidth, video.videoHeight, rendererLabel);
    }
  };
  video.addEventListener('loadedmetadata', showRes);
  showRes();

  // React to settings changes from the popup.
  _settingsManager.onChange((all, changed) => {
    if (!_initialized) return;
    if ('enabled' in changed) {
      _overlayManager.setVisible(all.enabled);
      _uiManager && _uiManager.updateToggle(all.enabled);
      if (_upscalerPipeline.getRendererType() !== 'anime4k') {
        if (all.enabled) {
          _perfMonitor.reset();
          _frameProcessor.start(video, _upscalerPipeline, _perfMonitor);
        } else {
          _frameProcessor.stop();
        }
      }
      _uiManager && _uiManager.updateStatus(all.enabled ? 'active' : 'off');
    }
    if ('mode' in changed) {
      _upscalerPipeline.updateSettings({ mode: all.mode });
      _uiManager && _uiManager.updateMode(all.mode);
    }
  });
}

function cleanup() {
  if (!_initialized) return;
  _initialized = false;

  try { chrome.storage.local.set({ onWatchPage: false, status: 'off' }); } catch { /* context invalidated */ }

  _frameProcessor && _frameProcessor.stop();
  _uiManager && _uiManager.remove();
  _overlayManager && _overlayManager.destroy();
  _upscalerPipeline && _upscalerPipeline.destroy();
  _videoDetector && _videoDetector.stop();

  _frameProcessor = null;
  _uiManager = null;
  _overlayManager = null;
  _upscalerPipeline = null;
  _videoDetector = null;
  _perfMonitor = null;
}

function onNavigate(path) {
  // Deduplicate — YouTube's 3 navigation signals can all fire for the same event.
  if (path === _currentPath) return;
  _currentPath = path;

  if (path.startsWith('/watch')) {
    init();
  } else {
    cleanup();
  }
}

function interceptNavigation() {
  // Layer 1: monkey-patch pushState/replaceState.
  const _origPush = history.pushState.bind(history);
  const _origReplace = history.replaceState.bind(history);
  const fireNav = () => onNavigate(location.pathname + location.search);

  history.pushState = function (...args) {
    _origPush(...args);
    fireNav();
  };
  history.replaceState = function (...args) {
    _origReplace(...args);
    fireNav();
  };
  window.addEventListener('popstate', fireNav);

  // Layer 2: YouTube's own post-navigation event (fires after player DOM updates).
  document.addEventListener('yt-navigate-finish', fireNav);

  // Layer 3: MutationObserver on <title> as last-resort backup.
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

  // Check current page on initial load.
  onNavigate(location.pathname + location.search);
}

bootstrap();
