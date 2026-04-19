// app.js — Reolink Viewer frontend

// How often to re-poll camera status (online/sleeping/offline).
// Keeps the status dots and labels accurate without reloading the page.
const STATUS_POLL_MS = 30_000;

const hubInfoList      = document.getElementById('hub-info-list');
const cameraNavList    = document.getElementById('camera-nav-list');
const statusBar        = document.getElementById('status-bar');
const camerasContainer = document.getElementById('cameras-container');

// Focus state — only one camera card is shown at a time
const cameras = new Map(); // channel → { device, card, startStream, stopStream }
let focusedChannel = null;

// Sidebar ordering — persisted in localStorage as a JSON array of channel numbers.
const CAMERA_ORDER_KEY = 'reolink-camera-order';

function getCameraOrder() {
  try {
    const raw = localStorage.getItem(CAMERA_ORDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveCameraOrder(order) {
  localStorage.setItem(CAMERA_ORDER_KEY, JSON.stringify(order));
}

const HUB_INFO_LABELS = {
  model:    'Model',
  detail:   'Type',
  firmVer:  'Firmware',
  hardVer:  'Hardware',
  buildDay: 'Build date',
};

// Format a Date for <input type="datetime-local"> which expects "YYYY-MM-DDTHH:MM" in local time.
function toLocalDatetimeValue(date) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// Format a Date as YYYYMMDDHHmmss in local time for the hub's Playback endpoint.
function toHubTimestamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// Convert a Reolink timestamp to a JS Date.
// The hub may return a Unix number, an ISO string, or an object { year, mon, day, hour, min, sec }.
function reolinkTimeToDate(t) {
  if (!t) return new Date(NaN);
  if (typeof t === 'number') return new Date(t * 1000);
  if (typeof t === 'string') return new Date(t);
  if (typeof t === 'object') {
    return new Date(t.year, (t.mon ?? t.month ?? 1) - 1, t.day, t.hour ?? 0, t.min ?? 0, t.sec ?? 0);
  }
  return new Date(NaN);
}

// Walk an object up to 3 levels deep and return the first Array value found.
// Used to extract a file list regardless of how the hub nests the Search response.
function findNestedArray(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) return val;
    const found = findNestedArray(val, depth + 1);
    if (found) return found;
  }
  return null;
}

// The Reolink API often nests its response under a single key (e.g. { DevInfo: {...} }).
// Unwrap it if present; otherwise return the object as-is.
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

function setStatus(message, isError = false) {
  statusBar.textContent = message;
  statusBar.className   = isError ? 'error' : '';
  statusBar.hidden      = false;
}

function clearStatus() {
  statusBar.hidden = true;
}

function buildNavItem(device) {
  const item = document.createElement('div');
  item.className = 'camera-nav-item';
  item.dataset.channel = String(device.channel);

  const header = document.createElement('div');
  header.className = 'nav-thumb-header';

  const dot = document.createElement('span');
  dot.className = `status-dot ${statusClass(device)}`;
  dot.id = `nav-dot-${device.channel}`;

  const name = document.createElement('span');
  name.className = 'nav-cam-name';
  name.textContent = device.name;

  const reorderBtns = document.createElement('div');
  reorderBtns.className = 'nav-reorder-btns';

  const upBtn = document.createElement('button');
  upBtn.className = 'reorder-btn';
  upBtn.title = 'Move up';
  upBtn.textContent = '▲';
  upBtn.id = `nav-up-${device.channel}`;
  upBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const order = getCameraOrder();
    const idx = order.indexOf(device.channel);
    if (idx <= 0) return;
    [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    saveCameraOrder(order);
    renderNavList(order);
  });

  const downBtn = document.createElement('button');
  downBtn.className = 'reorder-btn';
  downBtn.title = 'Move down';
  downBtn.textContent = '▼';
  downBtn.id = `nav-down-${device.channel}`;
  downBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const order = getCameraOrder();
    const idx = order.indexOf(device.channel);
    if (idx < 0 || idx >= order.length - 1) return;
    [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
    saveCameraOrder(order);
    renderNavList(order);
  });

  reorderBtns.appendChild(upBtn);
  reorderBtns.appendChild(downBtn);

  header.appendChild(dot);
  header.appendChild(name);
  header.appendChild(reorderBtns);

  const thumb = document.createElement('img');
  thumb.className = 'nav-thumb';
  thumb.alt = device.name;
  thumb.id = `nav-thumb-${device.channel}`;
  if (device.online === 1) {
    thumb.src = `/api/snapshot/${device.channel}?t=${Date.now()}`;
  }

  const timestamp = document.createElement('span');
  timestamp.className = 'nav-thumb-timestamp';
  timestamp.id = `nav-thumb-ts-${device.channel}`;

  item.appendChild(header);
  item.appendChild(thumb);
  item.appendChild(timestamp);

  item.addEventListener('click', () => focusCamera(device.channel));

  return item;
}

// Re-render the sidebar nav list from an ordered array of channel numbers.
// Disables the ▲ button on the first entry and ▼ on the last.
function renderNavList(order) {
  cameraNavList.innerHTML = '';
  order.forEach((channel, idx) => {
    const cam = cameras.get(channel);
    if (!cam) return;
    const item = buildNavItem(cam.device);
    cameraNavList.appendChild(item);

    const upBtn   = document.getElementById(`nav-up-${channel}`);
    const downBtn = document.getElementById(`nav-down-${channel}`);
    if (upBtn)   upBtn.disabled   = idx === 0;
    if (downBtn) downBtn.disabled = idx === order.length - 1;

    // Restore active highlight if this camera is currently focused
    if (channel === focusedChannel) item.classList.add('active');
  });
}

function focusCamera(channel) {
  // Stop the stream on the card that is leaving focus
  if (focusedChannel !== null && focusedChannel !== channel) {
    const prev = cameras.get(focusedChannel);
    if (prev) prev.stopStream();
  }

  const cam = cameras.get(channel);
  if (!cam) return;

  // Swap the focused card into the main area
  camerasContainer.innerHTML = '';
  camerasContainer.appendChild(cam.card);

  // Highlight the active nav item
  document.querySelectorAll('.camera-nav-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.channel) === channel);
  });

  // Start live stream if camera is online
  if (cam.device.online === 1) {
    cam.startStream();
  }

  focusedChannel = channel;
}

function createCameraCard(device) {
  let streamMode = null; // null | 'low' | 'high'

  const card = document.createElement('div');
  card.className = 'camera-card';
  card.id = `camera-${device.channel}`;

  // Header
  const header = document.createElement('div');
  header.className = 'camera-card-header';

  const dot = document.createElement('span');
  dot.className = `status-dot ${statusClass(device)}`;
  dot.id = `card-dot-${device.channel}`;

  const heading = document.createElement('h2');
  heading.textContent = device.name;

  header.appendChild(dot);
  header.appendChild(heading);

  // Live pane
  const livePaneEl = document.createElement('div');
  livePaneEl.className = 'live-pane';

  // — Video panel —
  const videoPanel = document.createElement('div');
  videoPanel.className = 'video-panel';

  const videoContainer = document.createElement('div');
  videoContainer.className = 'video-container';

  const img = document.createElement('img');
  img.className = 'live-img';
  img.alt = `${device.name} live feed`;

  const liveVideo = document.createElement('video');
  liveVideo.className = 'live-video';

  const liveLoading = document.createElement('div');
  liveLoading.className = 'playback-loading'; // reuse existing spinner style
  liveLoading.style.display = 'none';
  liveLoading.innerHTML = '<span class="loading-spinner"></span>Connecting\u2026';

  const placeholder = document.createElement('div');
  placeholder.className = 'video-placeholder';
  placeholder.innerHTML =
    '<div class="placeholder-icon"></div>' +
    '<span class="placeholder-label">No feed active</span>';

  videoContainer.appendChild(liveLoading);
  videoContainer.appendChild(img);
  videoContainer.appendChild(liveVideo);
  videoContainer.appendChild(placeholder);

  const controls = document.createElement('div');
  controls.className = 'video-controls';

  const modeGroup = document.createElement('div');
  modeGroup.className = 'mode-btn-group';

  const lowBtn = document.createElement('button');
  lowBtn.className = 'mode-btn';
  lowBtn.id = `live-low-${device.channel}`;
  lowBtn.textContent = 'Low quality';
  lowBtn.disabled = device.online !== 1;

  const highBtn = document.createElement('button');
  highBtn.className = 'mode-btn';
  highBtn.id = `live-high-${device.channel}`;
  highBtn.textContent = 'High quality';
  highBtn.disabled = device.online !== 1;

  const stopBtn = document.createElement('button');
  stopBtn.className = 'mode-btn stop';
  stopBtn.textContent = 'Stop';
  stopBtn.disabled = true; // enabled once a stream is active

  modeGroup.appendChild(lowBtn);
  modeGroup.appendChild(highBtn);
  modeGroup.appendChild(stopBtn);

  const info = document.createElement('p');
  info.className = 'stream-info';
  info.textContent = 'Select Low or High quality to start the live feed.';

  controls.appendChild(modeGroup);
  controls.appendChild(info);

  videoPanel.appendChild(videoContainer);
  videoPanel.appendChild(controls);

  // — Details panel —
  const details = document.createElement('div');
  details.className = 'details-panel';

  const detailsLabel = document.createElement('p');
  detailsLabel.className = 'section-label';
  detailsLabel.textContent = 'Camera details';

  const dl = document.createElement('dl');
  const rows = [
    ['Channel', device.channel],
    ['Status',  statusLabel(device)],
    ['UID',     device.uid],
  ];
  for (const [label, value] of rows) {
    if (value === null || value === undefined) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    if (label === 'Status') dd.id = `status-dd-${device.channel}`;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  details.appendChild(detailsLabel);
  details.appendChild(dl);

  // — Assemble live pane —
  livePaneEl.appendChild(videoPanel);
  livePaneEl.appendChild(details);

  // — Tab bar —
  const tabs = document.createElement('div');
  tabs.className = 'card-tabs';

  const liveTab = document.createElement('button');
  liveTab.className = 'tab-btn active';
  liveTab.textContent = 'Live';

  const recTab = document.createElement('button');
  recTab.className = 'tab-btn';
  recTab.textContent = 'Recordings';

  liveTab.addEventListener('click', () => {
    liveTab.classList.add('active');
    recTab.classList.remove('active');
    livePaneEl.style.display = 'flex';
    recPaneEl.style.display = 'none';
  });

  recTab.addEventListener('click', () => {
    recTab.classList.add('active');
    liveTab.classList.remove('active');
    livePaneEl.style.display = 'none';
    recPaneEl.style.display = 'flex';
  });

  tabs.appendChild(liveTab);
  tabs.appendChild(recTab);

  // — Recordings pane —
  const recPaneEl = document.createElement('div');
  recPaneEl.className = 'recordings-pane';
  recPaneEl.style.display = 'none';

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recBar = document.createElement('div');
  recBar.className = 'rec-search-bar';

  const startLabel = document.createElement('label');
  startLabel.textContent = 'From';
  const startInput = document.createElement('input');
  startInput.type = 'datetime-local';
  startInput.className = 'datetime-input';
  startInput.value = toLocalDatetimeValue(dayAgo);

  const endLabel = document.createElement('label');
  endLabel.textContent = 'To';
  const endInput = document.createElement('input');
  endInput.type = 'datetime-local';
  endInput.className = 'datetime-input';
  endInput.value = toLocalDatetimeValue(now);

  const recSearchBtn = document.createElement('button');
  recSearchBtn.className = 'search-btn';
  recSearchBtn.textContent = 'Search';

  recBar.appendChild(startLabel);
  recBar.appendChild(startInput);
  recBar.appendChild(endLabel);
  recBar.appendChild(endInput);
  recBar.appendChild(recSearchBtn);

  const recStatusMsg = document.createElement('p');
  recStatusMsg.className = 'rec-status';

  const recList = document.createElement('div');
  recList.className = 'recordings-list';

  const playbackLoading = document.createElement('div');
  playbackLoading.className = 'playback-loading';
  playbackLoading.style.display = 'none';
  playbackLoading.innerHTML = '<span class="loading-spinner"></span>Loading recording\u2026';

  const playbackVideo = document.createElement('video');
  playbackVideo.className = 'playback-video';
  playbackVideo.controls = true;
  playbackVideo.style.display = 'none';

  // Per-card state tracking which play button and recording label are active.
  let activePlayBtn = null;
  let activeFileLabel = '';

  playbackVideo.addEventListener('playing', () => {
    playbackLoading.style.display = 'none';
    playbackVideo.style.display = 'block';
    recStatusMsg.textContent = `Playing: ${activeFileLabel}`;
    recStatusMsg.className = 'rec-status';
    if (activePlayBtn) { activePlayBtn.disabled = false; activePlayBtn.textContent = 'Play'; }
  });
  playbackVideo.addEventListener('waiting', () => {
    recStatusMsg.textContent = `Buffering\u2026 ${activeFileLabel}`;
  });
  playbackVideo.addEventListener('ended', () => {
    recStatusMsg.textContent = `Finished: ${activeFileLabel}`;
    if (activePlayBtn) { activePlayBtn.disabled = false; activePlayBtn.textContent = 'Play'; }
  });
  playbackVideo.addEventListener('error', () => {
    if (!activePlayBtn) return; // deliberate src clearance — not a real error
    playbackLoading.style.display = 'none';
    recStatusMsg.textContent = 'Playback failed \u2014 check the server log.';
    recStatusMsg.className = 'rec-status error';
    activePlayBtn.disabled = false;
    activePlayBtn.textContent = 'Play';
    activePlayBtn = null;
  });

  recPaneEl.appendChild(playbackLoading); // loading indicator — shown while video is fetching
  recPaneEl.appendChild(playbackVideo);  // video — shown once playing starts
  recPaneEl.appendChild(recBar);
  recPaneEl.appendChild(recStatusMsg);
  recPaneEl.appendChild(recList);

  recSearchBtn.addEventListener('click', async () => {
    const startISO = new Date(startInput.value).toISOString();
    const endISO   = new Date(endInput.value).toISOString();

    recStatusMsg.textContent = 'Searching\u2026';
    recStatusMsg.className = 'rec-status';
    recList.innerHTML = '';
    recSearchBtn.disabled = true;
    activePlayBtn = null; // prevent error handler from firing on deliberate src clear
    playbackLoading.style.display = 'none';
    playbackVideo.style.display = 'none';
    playbackVideo.src = '';

    try {
      const resp = await fetch(
        `/api/recordings/${device.channel}` +
        `?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`
      );
      const data = await resp.json();

      if (!resp.ok) {
        const codeNote = data.code != null ? ` (code ${data.code})` : '';
        recStatusMsg.textContent = `Error: ${data.error ?? resp.statusText}${codeNote}`;
        recStatusMsg.className = 'rec-status error';
        return;
      }

      // Log raw response so we can inspect the exact structure during testing.
      console.log(`[recordings ch${device.channel}] raw response:`, data);

      const files = Array.isArray(data)
        ? data
        : Array.isArray(data.files)
          ? data.files
          : findNestedArray(data) ?? [];

      if (files.length === 0) {
        recStatusMsg.textContent = 'No recordings found in this time range.';
        return;
      }

      recStatusMsg.textContent = `${files.length} recording${files.length !== 1 ? 's' : ''} found.`;

      for (const file of files) {
        const fileStart = reolinkTimeToDate(file.start ?? file.StartTime);
        const fileEnd   = reolinkTimeToDate(file.end   ?? file.EndTime);
        const fileName  = file.name ?? file.FileName ?? file.fileName ?? '';

        const item = document.createElement('div');
        item.className = 'recording-item';

        const fmt = d => isNaN(d)
          ? '?'
          : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const timeSpan = document.createElement('span');
        timeSpan.className = 'recording-time';
        timeSpan.textContent = `${fmt(fileStart)} \u2013 ${fmt(fileEnd)}`;

        const durSpan = document.createElement('span');
        durSpan.className = 'recording-duration';
        if (!isNaN(fileStart) && !isNaN(fileEnd)) {
          const durSec = Math.round((fileEnd - fileStart) / 1000);
          const mm = Math.floor(durSec / 60);
          const ss = durSec % 60;
          durSpan.textContent = mm > 0 ? `${mm}m ${ss}s` : `${ss}s`;
        }

        const playBtn = document.createElement('button');
        playBtn.className = 'play-btn';
        playBtn.textContent = 'Play';
        playBtn.title = fileName || 'No filename in response';
        playBtn.disabled = !fileName;
        playBtn.addEventListener('click', () => {
          const start = toHubTimestamp(fileStart);
          const url = `/api/playback/${device.channel}` +
            `?source=${encodeURIComponent(fileName)}&start=${start}&seek=0`;

          // Reset the previously active play button if switching recordings.
          if (activePlayBtn && activePlayBtn !== playBtn) {
            activePlayBtn.disabled = false;
            activePlayBtn.textContent = 'Play';
          }
          activePlayBtn   = playBtn;
          activeFileLabel = `${fmt(fileStart)} \u2013 ${fmt(fileEnd)}`;

          playBtn.disabled = true;
          playBtn.textContent = '\u2026';
          recStatusMsg.textContent = `Loading: ${activeFileLabel}\u2026`;
          recStatusMsg.className = 'rec-status';

          // Show loading indicator; keep video hidden until the playing event fires.
          // Stream the fragmented MP4 directly — video starts playing after the
          // first keyframe fragment arrives (~1–2 s) instead of waiting for the
          // full download. play() is called from the user-gesture context so the
          // browser's autoplay policy allows it.
          playbackLoading.style.display = 'flex';
          playbackVideo.style.display = 'none';
          playbackVideo.src = url;
          playbackVideo.load();
          playbackVideo.play().catch(() => {});
        });

        const meta = document.createElement('div');
        meta.className = 'recording-meta';
        meta.appendChild(timeSpan);
        meta.appendChild(durSpan);

        item.appendChild(meta);
        item.appendChild(playBtn);
        recList.appendChild(item);
      }
    } catch (e) {
      recStatusMsg.textContent = `Search failed: ${e instanceof Error ? e.message : String(e)}`;
      recStatusMsg.className = 'rec-status error';
    } finally {
      recSearchBtn.disabled = false;
    }
  });

  // — Assemble card —
  card.appendChild(header);
  card.appendChild(tabs);
  card.appendChild(livePaneEl);
  card.appendChild(recPaneEl);

  // — Stream controls —
  function setModeButtons(mode) {
    lowBtn.classList.toggle('active', mode === 'low');
    highBtn.classList.toggle('active', mode === 'high');
    stopBtn.disabled = mode === null;
  }

  function startStream(mode = 'low') {
    stopStream(); // clean up any existing stream first
    streamMode = mode;
    placeholder.style.display = 'none';
    stopBtn.disabled = false;

    if (mode === 'low') {
      img.style.display = 'block';
      img.src = `/api/live/${device.channel}`;
      info.textContent = 'Low quality \u2014 MJPEG snapshots at 1\u20132 fps. First frame may take a few seconds.';
    } else {
      liveLoading.style.display = 'flex';
      liveVideo.src = `/api/rtsp/${device.channel}`;
      liveVideo.play().catch(() => {});
      info.textContent = 'High quality \u2014 RTSP stream via FFmpeg. Connecting\u2026';
    }
    setModeButtons(mode);
  }

  function stopStream() {
    if (streamMode === null) return;
    img.src = '';
    img.style.display = 'none';
    liveVideo.src = '';
    liveVideo.style.display = 'none';
    liveLoading.style.display = 'none';
    placeholder.style.display = '';
    info.textContent = 'Select Low or High quality to start the live feed.';
    streamMode = null;
    setModeButtons(null);
  }

  liveVideo.addEventListener('playing', () => {
    liveLoading.style.display = 'none';
    liveVideo.style.display = 'block';
    info.textContent = 'High quality \u2014 RTSP stream via FFmpeg.';
  });

  liveVideo.addEventListener('error', () => {
    if (streamMode === 'high') {
      stopStream();
      setStatus(`High quality feed failed for ${device.name}. Check server log.`, true);
    }
  });

  lowBtn.addEventListener('click',  () => startStream('low'));
  highBtn.addEventListener('click', () => startStream('high'));
  stopBtn.addEventListener('click', () => stopStream());

  // If the MJPEG stream breaks mid-view, recover gracefully.
  img.addEventListener('error', () => {
    if (streamMode === 'low') {
      stopStream();
      setStatus(`Low quality feed lost for ${device.name}. Click Low quality to retry.`, true);
    }
  });

  return { card, startStream, stopStream };
}

async function loadHubInfo() {
  try {
    const response = await fetch('/api/device-info');
    const data = await response.json();

    if (!response.ok) {
      setStatus(`Hub info unavailable: ${data.error ?? response.statusText}`, true);
      return;
    }

    const info = unwrapSingleKey(data);
    hubInfoList.innerHTML = '';
    for (const [key, label] of Object.entries(HUB_INFO_LABELS)) {
      const value = info[key];
      if (value === null || value === undefined) continue;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      hubInfoList.appendChild(dt);
      hubInfoList.appendChild(dd);
    }
  } catch (error) {
    setStatus(`Failed to load hub info: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function loadCameras() {
  try {
    const response = await fetch('/api/devices');
    const data = await response.json();

    if (!response.ok) {
      setStatus(`Cameras unavailable: ${data.error ?? response.statusText}`, true);
      return;
    }

    // The response may be a direct array or an object containing an array (e.g. { status: [...] }).
    // Find the first array value regardless of nesting key name.
    const deviceArray = Array.isArray(data)
      ? data
      : Object.values(data).find(Array.isArray) ?? [];

    const named = deviceArray.filter(d => d.name);

    camerasContainer.innerHTML = '';
    cameraNavList.innerHTML = '';
    cameras.clear();
    focusedChannel = null;

    // Build camera cards (order-independent)
    for (const device of named) {
      const { card, startStream, stopStream } = createCameraCard(device);
      cameras.set(device.channel, { device, card, startStream, stopStream });
    }

    // Merge stored order with live channel list:
    // - Known channels appear in stored order
    // - New channels (not in stored order) are appended at the end
    const storedOrder = getCameraOrder();
    const allChannels = named.map(d => d.channel);
    const knownInOrder = storedOrder.filter(ch => allChannels.includes(ch));
    const newChannels  = allChannels.filter(ch => !storedOrder.includes(ch));
    const order = [...knownInOrder, ...newChannels];
    saveCameraOrder(order);
    renderNavList(order);

    if (order.length > 0) {
      focusCamera(order[0]);
    }

    clearStatus();
  } catch (error) {
    setStatus(`Failed to load cameras: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

// Re-poll device status and update status dots + labels in place.
// Cards and streams are left untouched — only the status indicators change.
async function refreshCameraStatuses() {
  try {
    const response = await fetch('/api/devices');
    if (!response.ok) return; // Silently skip failed polls

    const data = await response.json();
    const deviceArray = Array.isArray(data)
      ? data
      : Object.values(data).find(Array.isArray) ?? [];

    for (const device of deviceArray) {
      if (!device.name) continue;

      const cardDot  = document.getElementById(`card-dot-${device.channel}`);
      const navDot   = document.getElementById(`nav-dot-${device.channel}`);
      const statusDd = document.getElementById(`status-dd-${device.channel}`);
      const lowBtn   = document.getElementById(`live-low-${device.channel}`);
      const highBtn  = document.getElementById(`live-high-${device.channel}`);

      const cls   = statusClass(device);
      const label = statusLabel(device);

      if (cardDot)  cardDot.className  = `status-dot ${cls}`;
      if (navDot)   navDot.className   = `status-dot ${cls}`;
      if (statusDd) statusDd.textContent = label;
      if (lowBtn)   lowBtn.disabled    = device.online !== 1;
      if (highBtn)  highBtn.disabled   = device.online !== 1;

      // Refresh the sidebar snapshot thumbnail every poll cycle
      const thumb = document.getElementById(`nav-thumb-${device.channel}`);
      if (thumb && device.online === 1) {
        thumb.src = `/api/snapshot/${device.channel}?t=${Date.now()}`;
        const ts = document.getElementById(`nav-thumb-ts-${device.channel}`);
        if (ts) {
          const now = new Date();
          ts.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        }
      }
    }
  } catch {
    // Network hiccup — ignore and wait for next poll
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Verify session before doing anything — redirect to login if not authenticated.
  const meResp = await fetch('/api/me');
  if (!meResp.ok) {
    window.location.replace('/login');
    return;
  }
  const { role } = await meResp.json();

  if (role === 'admin') {
    const adminLink = document.createElement('a');
    adminLink.href = '/admin';
    adminLink.textContent = 'Admin';
    adminLink.style.cssText =
      'display:block;margin-bottom:0.45rem;padding:0.35rem 0.75rem;' +
      'border:1px solid var(--border);border-radius:5px;' +
      'color:var(--text-muted);font-size:0.75rem;font-weight:600;' +
      'text-decoration:none;text-align:center;transition:border-color 0.12s,color 0.12s;';
    adminLink.addEventListener('mouseenter', () => {
      adminLink.style.borderColor = 'var(--accent)';
      adminLink.style.color = 'var(--accent)';
    });
    adminLink.addEventListener('mouseleave', () => {
      adminLink.style.borderColor = 'var(--border)';
      adminLink.style.color = 'var(--text-muted)';
    });
    const footer = document.getElementById('sidebar-footer');
    footer.insertBefore(adminLink, footer.firstChild);
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.replace('/login');
  });

  setStatus('Loading\u2026');
  await Promise.all([loadHubInfo(), loadCameras()]);
  setInterval(refreshCameraStatuses, STATUS_POLL_MS);
});
