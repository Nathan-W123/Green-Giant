// Popup controller - read-only dashboard backed by chrome.storage.local.

const LEAFLET_MS = 10.5 * 60 * 1000;

const scoreEl = document.getElementById('leaflet-score');
const deltaEl = document.getElementById('leaflet-delta');
const playbackEl = document.getElementById('leaflet-playback');
const taskPill = document.getElementById('task-pill');
const taskText = document.getElementById('task-text');
const taskYoutube = document.getElementById('task-youtube');

function leafletsFromMs(ms) {
  return Math.max(0, Math.floor((Number(ms) || 0) / LEAFLET_MS));
}

function hoursLabel(ms) {
  const hours = Math.max(0, Math.round((Number(ms) || 0) / 3_600_000));
  return `~${hours}hrs greener playback`;
}

function applyState(stored) {
  const totalMs = stored.ggTotalPlaybackMs || 0;
  const sessionMs = stored.ggSessionPlaybackMs || 0;
  const task = stored.greenGiantTask || {};
  const enabled = !!stored.enabled;
  const taskActive = task.state === 'active' && enabled;

  scoreEl.textContent = String(leafletsFromMs(totalMs));
  deltaEl.textContent = `+${leafletsFromMs(sessionMs)}`;
  playbackEl.textContent = hoursLabel(totalMs);

  taskPill.className = `task-pill ${taskActive ? 'active' : 'idle'}`;
  taskText.textContent = taskActive
    ? `${task.sourceLabel || 'video'} \u2192 ${task.targetLabel || '4k'}`
    : 'Just chilling';
  taskYoutube.style.display = taskActive ? 'inline-block' : 'none';
}

const storageDefaults = {
  enabled: false,
  status: 'off',
  ggTotalPlaybackMs: 0,
  ggSessionPlaybackMs: 0,
  greenGiantTask: { state: 'idle' },
};

chrome.storage.local.get(storageDefaults, applyState);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(storageDefaults, applyState);
});
