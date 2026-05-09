// Popup controller — runs in the popup's isolated JS context.
// Communicates with the content script exclusively via chrome.storage.local.
// Content script writes { status, onWatchPage } on changes; popup writes { enabled, mode }.
// No "tabs" permission needed — we read onWatchPage from storage instead of tab.url.

const toggle = document.getElementById('popup-toggle');
const modeSelect = document.getElementById('popup-mode');
const statusBadge = document.getElementById('popup-status');
const hint = document.getElementById('popup-hint');

const STATUS_LABELS = {
  active: 'Active',
  degraded: 'Degraded',
  fallback: 'Fallback',
  disabled: 'Disabled',
  off: 'Off',
};

function applyState(stored) {
  toggle.checked = !!stored.enabled;
  modeSelect.value = stored.mode || 'balanced';

  const status = stored.status || (stored.enabled ? 'active' : 'off');
  statusBadge.textContent = STATUS_LABELS[status] ?? status;
  statusBadge.className = 'popup-status-badge ' + status;

  hint.style.display = stored.onWatchPage ? 'none' : 'block';
}

// Load current state from storage.
chrome.storage.local.get(
  { enabled: false, mode: 'balanced', status: 'off', onWatchPage: false },
  applyState
);

// Keep popup in sync if storage changes while it's open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(
    { enabled: false, mode: 'balanced', status: 'off', onWatchPage: false },
    applyState
  );
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});

modeSelect.addEventListener('change', () => {
  chrome.storage.local.set({ mode: modeSelect.value });
});
