// admin.js — Reolink Viewer admin page

// ── Constants ─────────────────────────────────────────────────────────────────

const HUB_INFO_LABELS = {
  model:    'Model',
  detail:   'Type',
  firmVer:  'Firmware',
  hardVer:  'Hardware',
  buildDay: 'Build date',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function unwrapSingleKey(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj[keys[0]] === 'object' && obj[keys[0]] !== null) {
    return obj[keys[0]];
  }
  return obj;
}

function statusClass(device) {
  if (device.online !== 1) return 'offline';
  if (device.sleep === 1)  return 'sleeping';
  return 'online';
}

function statusLabel(device) {
  if (device.online !== 1) return 'Offline';
  if (device.sleep === 1)  return 'Sleeping';
  return 'Online';
}

// Format a Reolink time object as "Apr 20, 10:30:15"
function formatReolinkTime(t) {
  const d = new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date}, ${time}`;
}

// Duration in seconds between two Reolink time objects.
function reolinkDurationSec(start, end) {
  const s = new Date(start.year, start.mon - 1, start.day, start.hour, start.min, start.sec);
  const e = new Date(end.year,   end.mon - 1,   end.day,   end.hour,   end.min,   end.sec);
  return Math.max(0, Math.round((e - s) / 1000));
}

// Format seconds as "22s" or "1:04"
function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Format a file size (string or number of bytes) as "5.0 MB"
function formatSize(size) {
  const bytes = parseInt(size, 10);
  return isNaN(bytes) ? '' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Format a Reolink time object as YYYYMMDDHHmmss for the hub Playback endpoint.
function toHubTimestamp(t) {
  const pad = n => String(n).padStart(2, '0');
  return `${t.year}${pad(t.mon)}${pad(t.day)}${pad(t.hour)}${pad(t.min)}${pad(t.sec)}`;
}

// Return today's date as YYYY-MM-DD for <input type="date">.
function todayString() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Render functions ──────────────────────────────────────────────────────────

function renderHubInfo(data) {
  const info = unwrapSingleKey(data);
  const body = document.getElementById('hub-info-body');
  const entries = Object.entries(HUB_INFO_LABELS)
    .filter(([k]) => info[k] != null)
    .map(([k, label]) => `<dt>${label}</dt><dd>${info[k]}</dd>`)
    .join('');
  if (!entries) {
    body.innerHTML = '<span class="loading-text">No hub info returned.</span>';
    return;
  }
  body.innerHTML = `<dl class="info-grid">${entries}</dl>`;
}

function renderCameras(data) {
  const list = document.getElementById('cameras-list');
  const raw  = unwrapSingleKey(data);
  const devices = Array.isArray(raw) ? raw
    : Array.isArray(raw.status) ? raw.status
    : [];

  if (!devices.length) {
    list.innerHTML = '<span class="loading-text">No cameras found.</span>';
    return;
  }

  list.innerHTML = devices
    .filter(d => d.name)
    .map(d => {
      const cls   = statusClass(d);
      const label = statusLabel(d);
      const model = d.typeInfo ?? d.model ?? '';
      return `<div class="cam-row">
        <span class="status-dot ${cls}" title="${label}"></span>
        <span class="cam-name">${d.name}</span>
        <span class="cam-ch">ch${d.channel}</span>
        ${model ? `<span class="cam-model">${model}</span>` : ''}
      </div>`;
    })
    .join('');
}

// Populate the camera filter checkboxes in the Event History section.
function renderCameraCheckboxes(data) {
  const row  = document.getElementById('cameras-filter-row');
  const raw  = unwrapSingleKey(data);
  const devices = (Array.isArray(raw.status) ? raw.status : []).filter(d => d.name);

  if (!devices.length) { row.style.display = 'none'; return; }

  const label = document.createElement('span');
  label.className   = 'cameras-filter-label';
  label.textContent = 'Cameras:';
  row.appendChild(label);

  for (const d of devices) {
    const lbl = document.createElement('label');
    lbl.className = 'cam-checkbox-label';

    const cb = document.createElement('input');
    cb.type      = 'checkbox';
    cb.className = 'cam-checkbox';
    cb.value     = String(d.channel);
    cb.checked   = true;

    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(d.name));
    row.appendChild(lbl);
  }
}

const DETECT_LABELS = {
  people:  'People',
  vehicle: 'Vehicle',
  dog_cat: 'Animal',
  package: 'Package',
  face:    'Face',
};

// Mutable per-channel config state — updated in place as the user toggles settings.
const aiConfigs = new Map();

async function saveAiConfig(channel, config) {
  const res = await fetch(`/api/admin/ai-config/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function showAiError(channel, message) {
  const el = document.getElementById(`ai-error-${channel}`);
  if (!el) return;
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

async function toggleDetectType(btn) {
  const channel = parseInt(btn.dataset.channel, 10);
  const key     = btn.dataset.key;
  const config  = aiConfigs.get(channel);
  if (!config) return;

  const wasOn = config.AiDetectType[key] === 1;
  config.AiDetectType[key] = wasOn ? 0 : 1;
  btn.classList.toggle('on', !wasOn);
  btn.classList.toggle('off', wasOn);

  const allBadges = document.querySelectorAll(`.ai-detect-badge[data-channel="${channel}"]`);
  allBadges.forEach(b => { b.disabled = true; });
  showAiError(channel, '');

  try {
    await saveAiConfig(channel, config);
  } catch (err) {
    config.AiDetectType[key] = wasOn ? 1 : 0;
    btn.classList.toggle('on', wasOn);
    btn.classList.toggle('off', !wasOn);
    showAiError(channel, `Save failed: ${err.message}`);
  } finally {
    allBadges.forEach(b => { b.disabled = false; });
  }
}

async function toggleAiTrack(btn) {
  const channel = parseInt(btn.dataset.channel, 10);
  const config  = aiConfigs.get(channel);
  if (!config) return;

  const wasOn = config.aiTrack === 1;
  config.aiTrack = wasOn ? 0 : 1;
  btn.classList.toggle('on', !wasOn);
  btn.classList.toggle('off', wasOn);
  btn.textContent = wasOn ? 'Off' : 'On';

  const detailEl = document.getElementById(`ai-track-detail-${channel}`);
  if (detailEl) detailEl.style.display = wasOn ? 'none' : '';

  btn.disabled = true;
  showAiError(channel, '');

  try {
    await saveAiConfig(channel, config);
  } catch (err) {
    config.aiTrack = wasOn ? 1 : 0;
    btn.classList.toggle('on', wasOn);
    btn.classList.toggle('off', !wasOn);
    btn.textContent = wasOn ? 'On' : 'Off';
    if (detailEl) detailEl.style.display = wasOn ? '' : 'none';
    showAiError(channel, `Save failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderAiConfig(configs) {
  const list = document.getElementById('ai-config-list');

  if (!configs.length) {
    list.innerHTML = '<span class="loading-text">No cameras found.</span>';
    return;
  }

  aiConfigs.clear();
  for (const { channel, config } of configs) {
    if (config !== null) aiConfigs.set(channel, JSON.parse(JSON.stringify(config)));
  }

  list.innerHTML = configs.map(({ channel, channelName, config }) => {
    if (config === null) {
      return `<div class="ai-config-camera">
        <div class="section-label">${channelName}</div>
        <span class="error-text">Could not load config.</span>
      </div>`;
    }

    const detectType = config.AiDetectType ?? {};
    const badges = Object.entries(DETECT_LABELS)
      .map(([key, label]) => {
        const on = detectType[key] === 1;
        return `<button class="ai-detect-badge ${on ? 'on' : 'off'}" data-channel="${channel}" data-key="${key}">${label}</button>`;
      })
      .join('');

    const trackType = config.trackType ?? {};
    const tracked = Object.entries(DETECT_LABELS)
      .filter(([key]) => trackType[key] === 1)
      .map(([, label]) => label)
      .join(', ');
    let returnDetail = '';
    if (config.aiDisappearBackTime != null && config.aiStopBackTime != null) {
      returnDetail = ` · returns home ${config.aiDisappearBackTime}s after disappear, ${config.aiStopBackTime}s after stop`;
    }
    const trackDetail = (tracked ? ` — tracking: ${tracked}` : '') + returnDetail;
    const aiTrackOn = config.aiTrack === 1;
    const trackRow = `<div class="ai-track-row">Auto-track:
      <button class="ai-track-toggle ${aiTrackOn ? 'on' : 'off'}" data-channel="${channel}">${aiTrackOn ? 'On' : 'Off'}</button><span
        class="ai-track-detail" id="ai-track-detail-${channel}"${aiTrackOn ? '' : ' style="display:none"'}>${trackDetail}</span></div>`;

    return `<div class="ai-config-camera" data-channel="${channel}">
      <div class="section-label">${channelName}</div>
      <div class="ai-detect-badges">${badges}</div>
      ${trackRow}
      <div class="ai-save-error" id="ai-error-${channel}" style="display:none;"></div>
    </div>`;
  }).join('');

  list.querySelectorAll('.ai-detect-badge[data-channel]').forEach(btn => {
    btn.addEventListener('click', () => toggleDetectType(btn));
  });
  list.querySelectorAll('.ai-track-toggle[data-channel]').forEach(btn => {
    btn.addEventListener('click', () => toggleAiTrack(btn));
  });
}

function renderError(elementId, message) {
  document.getElementById(elementId).innerHTML =
    `<span class="error-text">${message}</span>`;
}

// ── Event history ─────────────────────────────────────────────────────────────

// Returns the comma-separated checked channel values, or null if all are checked
// (meaning "no filter needed"), or '' if none are checked.
function getCheckedChannels() {
  const all     = document.querySelectorAll('.cam-checkbox');
  const checked = document.querySelectorAll('.cam-checkbox:checked');
  if (all.length === 0 || all.length === checked.length) return null; // all → no filter
  if (checked.length === 0) return '';                                 // none → block request
  return [...checked].map(el => el.value).join(',');
}

// Active playback state — tracked so we can reset the previous item when a new
// Play button is clicked.
let activeEventBtn  = null;
let activeEventItem = null;

function playEvent(item, btn, event) {
  // Reset the previously active row.
  if (activeEventBtn) {
    activeEventBtn.textContent = 'Play';
    activeEventBtn.disabled    = false;
    activeEventBtn.classList.remove('active');
  }
  if (activeEventItem) activeEventItem.classList.remove('active');

  activeEventBtn  = btn;
  activeEventItem = item;
  btn.disabled    = true;
  btn.textContent = 'Loading…';
  btn.classList.add('active');
  item.classList.add('active');

  const url = `/api/playback/${event.channel}` +
    `?source=${encodeURIComponent(event.name)}` +
    `&start=${toHubTimestamp(event.StartTime)}&seek=0`;

  const player  = document.getElementById('event-player');
  const loading = document.getElementById('event-player-loading');
  const video   = document.getElementById('event-video');

  player.style.display  = 'block';
  loading.style.display = 'flex';
  video.style.display   = 'none';
  video.src = url;
  video.load();
  video.play().catch(() => {});

  player.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderEvents(events) {
  const list = document.getElementById('event-list');
  list.innerHTML = '';

  for (const e of events) {
    const duration = reolinkDurationSec(e.StartTime, e.EndTime);

    const item = document.createElement('div');
    item.className = 'event-item';
    item.innerHTML =
      `<span class="event-cam">${e.channelName}</span>` +
      `<span class="event-time">${formatReolinkTime(e.StartTime)}</span>` +
      `<span class="event-duration">${formatDuration(duration)}</span>` +
      `<span class="event-size">${formatSize(e.size)}</span>`;

    const btn = document.createElement('button');
    btn.className   = 'event-play-btn';
    btn.textContent = 'Play';
    btn.addEventListener('click', () => playEvent(item, btn, e));
    item.appendChild(btn);

    list.appendChild(item);
  }
}

async function loadEvents() {
  const start = document.getElementById('event-start').value;
  const end   = document.getElementById('event-end').value;
  if (!start || !end) return;

  const channels = getCheckedChannels();
  const status   = document.getElementById('event-status');
  const list     = document.getElementById('event-list');
  const btn      = document.getElementById('event-search-btn');

  if (channels === '') {
    status.textContent = 'Select at least one camera.';
    status.className   = 'event-status error-text';
    return;
  }

  status.textContent = 'Loading…';
  status.className   = 'event-status';
  list.innerHTML     = '';
  btn.disabled       = true;

  // Reset any active playback when performing a new search.
  activeEventBtn  = null;
  activeEventItem = null;
  const player = document.getElementById('event-player');
  const video  = document.getElementById('event-video');
  player.style.display = 'none';
  video.src = '';

  try {
    const params = new URLSearchParams({ start, end });
    if (channels !== null) params.set('channels', channels);

    const res = await fetch(`/api/admin/events?${params}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const { events } = await res.json();
    status.textContent = `${events.length} recording${events.length !== 1 ? 's' : ''} found`;
    renderEvents(events);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className   = 'event-status error-text';
  } finally {
    btn.disabled = false;
  }
}

// ── Video event handlers ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const video   = document.getElementById('event-video');
  const loading = document.getElementById('event-player-loading');

  video.addEventListener('playing', () => {
    loading.style.display = 'none';
    video.style.display   = 'block';
    if (activeEventBtn) activeEventBtn.disabled = false;
  });

  video.addEventListener('ended', () => {
    if (activeEventBtn) {
      activeEventBtn.textContent = 'Play';
      activeEventBtn.disabled    = false;
      activeEventBtn.classList.remove('active');
    }
    if (activeEventItem) activeEventItem.classList.remove('active');
    activeEventBtn  = null;
    activeEventItem = null;
  });

  video.addEventListener('error', () => {
    if (!activeEventBtn) return; // deliberate src clearance — not a real error
    loading.style.display = 'none';
    if (activeEventItem) activeEventItem.classList.remove('active');
    if (activeEventBtn) {
      activeEventBtn.textContent = 'Play';
      activeEventBtn.disabled    = false;
      activeEventBtn.classList.remove('active');
    }
    activeEventBtn  = null;
    activeEventItem = null;
    const statusEl = document.getElementById('event-status');
    statusEl.textContent = 'Playback failed — check the server log.';
    statusEl.className   = 'event-status error-text';
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const meResp = await fetch('/api/me');
  if (!meResp.ok) { window.location.replace('/login'); return; }
  const { role } = await meResp.json();
  if (role !== 'admin') { window.location.replace('/'); return; }

  document.getElementById('signout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.replace('/login');
  });

  // Default date range to today so the initial search is immediately useful.
  const today = todayString();
  document.getElementById('event-start').value = today;
  document.getElementById('event-end').value   = today;

  document.getElementById('event-search-btn').addEventListener('click', loadEvents);

  const [infoRes, devicesRes, aiConfigRes] = await Promise.allSettled([
    fetch('/api/device-info'),
    fetch('/api/devices'),
    fetch('/api/admin/ai-config'),
  ]);

  if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
    renderHubInfo(await infoRes.value.json());
  } else {
    renderError('hub-info-body', 'Could not load hub info.');
  }

  if (devicesRes.status === 'fulfilled' && devicesRes.value.ok) {
    const devicesData = await devicesRes.value.json();
    renderCameras(devicesData);
    renderCameraCheckboxes(devicesData);
  } else {
    renderError('cameras-list', 'Could not load camera list.');
  }

  if (aiConfigRes.status === 'fulfilled' && aiConfigRes.value.ok) {
    const { configs } = await aiConfigRes.value.json();
    renderAiConfig(configs);
  } else {
    renderError('ai-config-list', 'Could not load AI detection config.');
  }

  // Auto-search today's events once cameras are loaded and checkboxes are set.
  await loadEvents();
});
