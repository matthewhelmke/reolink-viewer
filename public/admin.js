// admin.js — Reolink Viewer admin page

const HUB_INFO_LABELS = {
  model:    'Model',
  detail:   'Type',
  firmVer:  'Firmware',
  hardVer:  'Hardware',
  buildDay: 'Build date',
};

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
  const raw = unwrapSingleKey(data);
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

function renderAbility(data) {
  document.getElementById('ability-pre').textContent = JSON.stringify(data, null, 2);
}

function renderError(elementId, message) {
  document.getElementById(elementId).innerHTML =
    `<span class="error-text">${message}</span>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const meResp = await fetch('/api/me');
  if (!meResp.ok) { window.location.replace('/login'); return; }
  const { role } = await meResp.json();
  if (role !== 'admin') { window.location.replace('/'); return; }

  document.getElementById('signout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.replace('/login');
  });

  const [infoRes, devicesRes, abilityRes] = await Promise.allSettled([
    fetch('/api/device-info'),
    fetch('/api/devices'),
    fetch('/api/admin/ability'),
  ]);

  if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
    renderHubInfo(await infoRes.value.json());
  } else {
    renderError('hub-info-body', 'Could not load hub info.');
  }

  if (devicesRes.status === 'fulfilled' && devicesRes.value.ok) {
    renderCameras(await devicesRes.value.json());
  } else {
    renderError('cameras-list', 'Could not load camera list.');
  }

  if (abilityRes.status === 'fulfilled' && abilityRes.value.ok) {
    renderAbility(await abilityRes.value.json());
  } else {
    const msg = abilityRes.status === 'fulfilled'
      ? `Hub returned ${abilityRes.value.status}`
      : 'Could not load capabilities.';
    document.getElementById('ability-pre').innerHTML =
      `<span class="error-text">${msg}</span>`;
  }
});
