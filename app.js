const $ = selector => document.querySelector(selector);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let role = null;
let knownAlertIds = null;
let knownCamperReplies = null;
let replyPopupTimer = null;
const sosAlarmAudio = new Audio('/mobile/IOS_Emergency_Alert_Notification_-_Sound_Effect_HD.wav');
sosAlarmAudio.preload = 'auto';
sosAlarmAudio.volume = 0.9;
let sosAlarmActive = false;
let sosSoundEnabled = false;
let sosAlarmTimer = null;
let refreshTimer = null;
let cache = {};
let pointBDevice = null;
const POINT_B_DEVICE_STORAGE_KEY = 'campconnect-point-b-device-id';
// TODO(BLE_POINT_B_SETUP): Fill in the advertised device name, GATT service UUID,
// TX/RX characteristic UUIDs, and message framing from the ESP32 Point B firmware.
// Until these are supplied, this only confirms a BLE GATT connection; SOS/dashboard
// data continues to use the kiosk's local Wi-Fi/Ethernet API.
const POINT_B_DEVICE_NAME_PREFIX = 'ESP32';
const POINT_B_SERVICE_UUID = null;
const POINT_B_TX_CHARACTERISTIC_UUID = null;
const POINT_B_RX_CHARACTERISTIC_UUID = null;
try {
  if (localStorage.getItem('campconnect-sos-sound-armed') === '1') $('#enableSosAlerts').textContent = 'Tap to re-enable SOS sound';
} catch (_) { /* Sound can still be enabled for this page if storage is disabled. */ }

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal, ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Could not reach the kiosk (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.status) throw error;
    throw new Error(error.name === 'AbortError' ? 'The kiosk took too long to answer.' : 'Cannot reach the kiosk. Join the campsite Wi-Fi.');
  } finally { clearTimeout(timeout); }
}

function showMessage(message) { $('#appMessage').textContent = message; }

function setLink(status, responseMs = null) {
  cache.connectivity = status || null;
  const online = Boolean(status && status.phone_url && status.lan_ip);
  renderConnectionStatus();
  $('#statLink').textContent = online && Number.isFinite(responseMs) ? `${Math.round(responseMs)} ms` : online ? 'Connected' : 'Offline';
  renderDashboardMetric(status);
  return online;
}

function renderConnectionStatus() {
  const kioskOnline = Boolean(cache.connectivity && cache.connectivity.phone_url && cache.connectivity.lan_ip);
  const state = $('#linkState');
  if (pointBDevice && pointBDevice.gatt && pointBDevice.gatt.connected) {
    state.querySelector('span').textContent = `${pointBDevice.name || 'Point B'} · setup pending`;
    state.className = 'connection online';
    $('#connectPointB').textContent = 'Point B connected';
    $('#connectPointB').classList.add('enabled');
    return;
  }
  state.querySelector('span').textContent = kioskOnline ? `Local kiosk · ${cache.connectivity.lan_ip}` : 'Kiosk link unavailable';
  state.className = `connection ${kioskOnline ? 'online' : 'offline'}`;
  $('#connectPointB').textContent = 'Connect Point B';
  $('#connectPointB').classList.remove('enabled');
}

async function connectPointBDevice(device, showResult = true) {
  if (!device || !device.gatt) throw new Error('This device does not provide a Bluetooth LE connection.');
  pointBDevice = device;
  device.addEventListener('gattserverdisconnected', () => {
    if (pointBDevice === device) pointBDevice = null;
    renderConnectionStatus();
    if (showResult) showMessage('Point B Bluetooth disconnected. The dashboard is using the kiosk local network if available.');
  }, { once: true });
  await device.gatt.connect();
  pointBDevice = device;
  try { localStorage.setItem(POINT_B_DEVICE_STORAGE_KEY, device.id); } catch (_) { /* Pairing can still be used for this page session. */ }
  renderConnectionStatus();
  if (showResult) showMessage(`Bluetooth connected to ${device.name || 'Point B'}. LoRa messaging needs the ESP32 GATT details; dashboard data still uses the kiosk local network.`);
}

async function connectPointB() {
  if (!window.isSecureContext || !navigator.bluetooth) {
    showMessage('Bluetooth is unavailable in this browser or address. Use the kiosk local network; secure HTTPS and browser Bluetooth support are needed for Point B pairing.');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      ...(POINT_B_SERVICE_UUID ? { optionalServices: [POINT_B_SERVICE_UUID] } : {})
    });
    await connectPointBDevice(device);
  } catch (error) {
    if (error.name === 'NotFoundError' || error.name === 'NotAllowedError') {
      showMessage('No Point B device was selected. The kiosk local network remains the fallback.');
      return;
    }
    showMessage(`Point B Bluetooth was not connected: ${error.message}. The kiosk local network remains the fallback.`);
  }
}

async function reconnectGrantedPointB() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  let savedId = null;
  try { savedId = localStorage.getItem(POINT_B_DEVICE_STORAGE_KEY); } catch (_) { return; }
  if (!savedId) return;
  try {
    const devices = await navigator.bluetooth.getDevices();
    const device = devices.find(item => item.id === savedId && (!POINT_B_DEVICE_NAME_PREFIX || !item.name || item.name.startsWith(POINT_B_DEVICE_NAME_PREFIX)));
    if (device) await connectPointBDevice(device, false);
  } catch (_) { /* Permissions or browser support may be unavailable; use local network fallback. */ }
}

function renderDashboardMetric(status) {
  if (role === 'staff') {
    $('#statMetricIcon').textContent = '⚡';
    $('#statMetricLabel').textContent = 'CampConnect solar battery';
    const batteryAvailable = Boolean(status && status.lora_connected && status.battery_detected && Number.isFinite(status.battery_percent));
    $('#statRevenue').textContent = batteryAvailable ? `${status.battery_percent}%` : 'Unavailable';
  } else if (role === 'owner') {
    $('#statMetricIcon').textContent = '₱';
    $('#statMetricLabel').textContent = "Today's coin total";
  }
}

function countUp(element, to) {
  const from = Number(element.dataset.v || 0);
  element.dataset.v = to;
  if (reduce || from === to) { element.textContent = to; return; }
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / 600);
    element.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- Rendering (all read from the preloaded data) ---------- */
function playSosAlertSound() {
  if (!sosSoundEnabled) return;
  sosAlarmAudio.play().catch(() => {
    sosSoundEnabled = false;
    sosAlarmActive = false;
    sosAlarmAudio.loop = false;
    const button = $('#enableSosAlerts');
    button.textContent = 'Tap to enable SOS sound';
    button.setAttribute('aria-pressed', 'false');
    button.classList.remove('enabled');
    showMessage('SOS sound could not start. Tap the sound button again and check the device volume.');
  });
}

function syncSosAlarm(alerts) {
  const needsResponse = alerts.some(alert => alert.status !== 'Resolved' && !alert.responded_at);
  if (sosSoundEnabled && needsResponse && !sosAlarmActive) {
    sosAlarmActive = true;
    sosAlarmAudio.loop = true;
    playSosAlertSound();
  } else if ((!sosSoundEnabled || !needsResponse) && sosAlarmActive) {
    sosAlarmActive = false;
    sosAlarmAudio.loop = false;
    sosAlarmAudio.pause();
    sosAlarmAudio.currentTime = 0;
  }
}
function signalNewSos(alert) {
  if (!alert || !('Notification' in window) || !window.isSecureContext || Notification.permission !== 'granted' || !document.hidden) return;
  try { new Notification('CampConnect SOS alert', { body: `${alert.alert_type || 'Emergency'}${alert.details ? ` · ${alert.details}` : ''}`, tag: `campconnect-sos-${alert.id}`, renotify: true }); } catch (_) { /* Browser notifications may be unavailable. */ }
}
function showCamperReply(alert) {
  const popup = $('#camperReplyPopup');
  $('#camperReplyPopupText').textContent = alert.camper_reply_message || '';
  popup.hidden = false;
  clearTimeout(replyPopupTimer);
  replyPopupTimer = setTimeout(() => { popup.hidden = true; }, 10000);
}
function checkForCamperReplies(alerts) {
  if (knownCamperReplies === null) {
    const recent = alerts.filter(alert => alert.camper_reply_at && Date.now() - Date.parse(alert.camper_reply_at) <= 10000);
    if (recent.length) showCamperReply(recent[0]);
  } else {
    const fresh = alerts.filter(alert => alert.camper_reply_at && knownCamperReplies.get(alert.id) !== alert.camper_reply_at);
    if (fresh.length) showCamperReply(fresh[0]);
  }
  knownCamperReplies = new Map(alerts.map(alert => [alert.id, alert.camper_reply_at || null]));
}
function renderAlerts() {
  const alerts = cache.alerts || [];
  const openAlerts = alerts.filter(alert => alert.status !== 'Resolved');
  const fresh = knownAlertIds ? alerts.filter(alert => !knownAlertIds.has(alert.id)) : [];
  $('#newCount').textContent = `${openAlerts.length} open`;
  countUp($('#statAlerts'), openAlerts.length);
  if (fresh.length) {
    showMessage(`New emergency message: ${fresh[0].alert_type}`);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    signalNewSos(fresh[0]);
  }
  knownAlertIds = new Set(alerts.map(alert => alert.id));
  checkForCamperReplies(alerts);
  syncSosAlarm(alerts);
}

function validPoint(latitude, longitude) {
  return Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
    && latitude !== null && longitude !== null
    && Number(latitude) >= -90 && Number(latitude) <= 90
    && Number(longitude) >= -180 && Number(longitude) <= 180;
}

function distanceMeters(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const lat1 = radians(Number(a.latitude));
  const lat2 = radians(Number(b.latitude));
  const dLat = lat2 - lat1;
  const dLon = radians(Number(b.longitude) - Number(a.longitude));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function formatPoint(point) {
  return `${Number(point.latitude).toFixed(6)}, ${Number(point.longitude).toFixed(6)}`;
}

function formatDistance(meters) {
  return meters < 1000 ? `about ${Math.round(meters)} m` : `about ${(meters / 1000).toFixed(2)} km`;
}

function formatMoment(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function responseDurationForAlert(alert) {
  const start = Date.parse(alert.sent_at || alert.created_at || '');
  const end = Date.parse(alert.responded_at || alert.resolved_at || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Not recorded';
  let seconds = Math.floor((end - start) / 1000);
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  if (hours) return `${hours} hr ${minutes} min${seconds ? ` ${seconds} sec` : ''}`;
  if (minutes) return `${minutes} min${seconds ? ` ${seconds} sec` : ''}`;
  return `${seconds} sec`;
}
function trackingForAlert(alert) {
  const connectivity = cache.connectivity || {};
  const createdAt = formatMoment(alert.created_at);
  const sentAt = formatMoment(alert.sent_at);
  const matchingTelemetry = connectivity.responder_alert_id === alert.id;
  const pointA = validPoint(alert.latitude, alert.longitude)
    ? { latitude: alert.latitude, longitude: alert.longitude, accuracy: alert.gps_accuracy_m, source: 'SOS location' }
    : connectivity.gps_fix && validPoint(connectivity.latitude, connectivity.longitude)
      ? { latitude: connectivity.latitude, longitude: connectivity.longitude, accuracy: connectivity.gps_accuracy_m, source: 'Kiosk GPS' }
      : null;
  const pointB = validPoint(alert.responder_latitude, alert.responder_longitude)
    ? { latitude: alert.responder_latitude, longitude: alert.responder_longitude, accuracy: alert.responder_accuracy_m }
    : matchingTelemetry && validPoint(connectivity.responder_latitude, connectivity.responder_longitude)
      ? { latitude: connectivity.responder_latitude, longitude: connectivity.responder_longitude, accuracy: connectivity.responder_accuracy_m }
      : null;
  const responderName = alert.responder_username || (matchingTelemetry ? connectivity.responder_username : null) || alert.resolved_by;
  const responderRole = alert.responder_role || (matchingTelemetry ? connectivity.responder_role : null) || alert.resolved_role;
  const sentMoment = sentAt || createdAt;
  return {
    createdAt, sentAt: sentMoment,
    respondedAt: formatMoment(alert.responded_at),
    resolvedAt: formatMoment(alert.resolved_at),
    responderName, responderRole, matchingTelemetry, pointA, pointB,
    pointAUpdated: pointA ? pointA.source === 'SOS location' ? createdAt : formatMoment(connectivity.gps_updated_at) : null,
    pointBUpdated: pointB ? formatMoment(alert.responder_location_at) || (matchingTelemetry ? formatMoment(connectivity.responder_updated_at) : null) : null,
    distance: pointA && pointB ? formatDistance(distanceMeters(pointA, pointB)) : null,
    pointAText: pointA ? `${formatPoint(pointA)}${pointA.accuracy != null ? ` · ±${pointA.accuracy} m` : ''}` : 'GPS fix unavailable',
    pointBText: pointB ? `${formatPoint(pointB)}${pointB.accuracy != null ? ` · ±${pointB.accuracy} m` : ''}` : 'GPS fix unavailable',
    responderText: responderName
      ? `${responderName}${responderRole ? ` · ${responderRole === 'owner' ? 'Owner' : 'Staff'}` : ''}`
      : responderRole ? `${responderRole === 'owner' ? 'Owner' : 'Staff'} · name not provided` : 'Not reported'
  };
}

function renderEmergencyStatus() {
  const alerts = cache.alerts || [];
  const current = alerts.filter(alert => alert.status !== 'Resolved').sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const respondingCount = current.filter(alert => alert.status === 'Responder en route').length;
  countUp($('#statResponders'), respondingCount);
  $('#alerts').innerHTML = current.length ? current.map((alert, index) => {
    const tracking = trackingForAlert(alert);
    const respondedAt = tracking.respondedAt ? `Response received ${escapeHtml(tracking.respondedAt)}` : '';
    const sentLabel = alert.status === 'Queued for LoRa' && !alert.sent_at
      ? 'SOS queued'
      : alert.status === 'LoRa send failed' && !alert.sent_at ? 'LoRa delivery failed' : 'SOS sent';
    const statusLabel = alert.status === 'New' ? 'SOS received' : alert.status;
    const respondAction = alert.responder_message
      ? '<button class="respond" type="button" disabled>Responded</button>'
      : `<button class="respond" data-respond="${escapeHtml(alert.id)}" type="button">Respond</button>`;
    const handleAction = role === 'owner' ? `<button class="resolve" data-resolve="${escapeHtml(alert.id)}" type="button">Mark handled</button>` : '';
    return `<article class="response-card active" style="--n:${index}">
      <div class="response-head"><div><span class="response-kicker">${alert.is_demo ? 'Demo · ' : 'CURRENT SOS'}</span><h3>${escapeHtml(alert.alert_type)}</h3></div><span class="response-state">${escapeHtml(statusLabel)}</span></div>
      <p class="response-message">${escapeHtml(alert.details || 'No location or details provided.')}</p>
      <div class="response-timeline"><span>${sentLabel}</span><time>${escapeHtml(tracking.sentAt || 'Time unavailable')}</time></div>
      <div class="responder-row"><span class="responder-avatar">${tracking.responderRole === 'owner' ? 'O' : tracking.responderRole === 'staff' || tracking.responderName ? 'S' : '…'}</span><div><small>RESPONDER</small><b>${escapeHtml(tracking.responderText)}</b>${respondedAt ? `<time>${respondedAt}</time>` : ''}</div></div>
      <div class="location-pair"><div class="location-point"><small>POINT A · KIOSK</small><b>${escapeHtml(tracking.pointAText)}</b>${tracking.pointAUpdated ? `<time class="location-updated">GPS fix ${escapeHtml(tracking.pointAUpdated)}</time>` : ''}</div><div class="location-point"><small>POINT B · RESPONDER</small><b>${escapeHtml(tracking.pointBText)}</b>${tracking.pointBUpdated ? `<time class="location-updated">Updated ${escapeHtml(tracking.pointBUpdated)}</time>` : ''}</div></div>
      <div class="distance-line"><span>STRAIGHT-LINE DISTANCE</span><b>${tracking.distance || 'Unavailable until both GPS fixes arrive'}</b></div>
      <p class="gps-note">GPS distance is an estimate; accuracy depends on both GPS modules. ${tracking.pointB && (alert.responder_source === 'LoRa' || tracking.matchingTelemetry) ? 'Responder point received over LoRa.' : ''}</p>
      <div class="current-actions">${respondAction}${handleAction}</div>
    </article>`;
  }).join('') : '<p class="empty">No active SOS. New emergency alerts will appear here.</p>';
}

let archiveDefaultYear = new Date().getFullYear();
function renderPastSos() {
  const resolved = (cache.alerts || []).filter(alert => alert.status === 'Resolved');
  const select = $('#archiveYear');
  const currentYear = new Date().getFullYear();
  const rolledOver = currentYear !== archiveDefaultYear;
  archiveDefaultYear = currentYear;
  const years = [...new Set([currentYear, ...resolved.map(alert => new Date(alert.created_at).getFullYear()).filter(Number.isFinite)])].sort((a, b) => b - a);
  const previousYear = Number(select.value);
  const selectedYear = !rolledOver && years.includes(previousYear) ? previousYear : currentYear;
  select.innerHTML = years.map(year => `<option value="${year}" ${year === selectedYear ? 'selected' : ''}>${year}</option>`).join('');
  const rows = resolved.filter(alert => new Date(alert.created_at).getFullYear() === selectedYear);
  $('#pastSosCount').textContent = `${rows.length} ${rows.length === 1 ? 'record' : 'records'}`;
  $('#exportPastSos').disabled = rows.length === 0;
  $('#pastSosRows').innerHTML = rows.length ? rows.map(alert => {
    const tracking = trackingForAlert(alert);
    const responder = alert.responder_username || alert.resolved_by;
    const responderRole = alert.responder_role || alert.resolved_role;
    const responderText = responder ? `${responder}${responderRole ? ` · ${responderRole === 'owner' ? 'Owner' : 'Staff'}` : ''}` : 'Not recorded';
    const title = `${alert.is_demo ? 'Demo · ' : ''}${alert.alert_type}`;
    return `<tr><td><strong>${escapeHtml(title)}</strong><small>${escapeHtml(alert.details || 'No details provided.')}</small></td><td>${escapeHtml(tracking.sentAt || 'Not recorded')}</td><td>${escapeHtml(alert.status)}</td><td>${escapeHtml(responderText)}</td><td>${escapeHtml(tracking.respondedAt || 'Not recorded')}</td><td>${escapeHtml(tracking.resolvedAt || 'Not recorded')}</td><td>${escapeHtml(responseDurationForAlert(alert))}</td></tr>`;
  }).join('') : '<tr><td class="archive-empty" colspan="7">No past SOS records for this year.</td></tr>';
}

function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[\u0000-\u0020]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportPastSos() {
  const year = Number($('#archiveYear').value);
  const rows = (cache.alerts || []).filter(alert => alert.status === 'Resolved' && new Date(alert.created_at).getFullYear() === year);
  if (!rows.length) return;
  const columns = ['SOS type', 'Details', 'Sent at', 'Status', 'Responder', 'Responder role', 'Response received', 'Resolved at', 'Time to response'];
  const csvRows = rows.map(alert => {
    const tracking = trackingForAlert(alert);
    return [alert.alert_type, alert.details, tracking.sentAt, alert.status, alert.responder_username || alert.resolved_by, alert.responder_role || alert.resolved_role, tracking.respondedAt, tracking.resolvedAt, responseDurationForAlert(alert)];
  });
  const csv = '\ufeff' + [columns, ...csvRows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const filename = `campconnect-past-sos-${year}.csv`;
  if (window.AndroidDownloads && typeof window.AndroidDownloads.saveTextFile === 'function') {
    window.AndroidDownloads.saveTextFile(filename, csv);
    showMessage('SOS archive saved to the phone Downloads folder.');
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderReports() {
  if (role !== 'owner') return;
  const reports = cache.reports || [];
  $('#reports').innerHTML = reports.length ? reports.map((file, index) => `<a class="report-card" style="--n:${index}" href="/api/owner/reports/file/${encodeURIComponent(file.name)}"><span>${escapeHtml(file.name)}<small>${(file.bytes / 1024).toFixed(1)} KB · Saved on kiosk</small></span><span class="download">Download ↓</span></a>`).join('') : '<p class="empty">No report files on the kiosk.</p>';
}

function restartTick() {
  const bar = $('#tick');
  bar.classList.remove('run');
  void bar.offsetWidth;
  bar.classList.add('run');
}

/* ---------- Live data loaders ---------- */
const load = {
  alerts: async () => { cache.alerts = (await api('/api/mobile/alerts')).alerts || []; return `${cache.alerts.length} loaded`; },
  revenue: async () => {
  if (role !== 'owner') { cache.revenue = null; return 'Not shown'; }
    try {
      const data = await api('/api/owner/mobile-revenue');
      cache.revenue = data.available ? data.revenue_php : null;
      $('#statRevenue').textContent = data.available
        ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(cache.revenue || 0)
        : 'Unavailable';
      return data.available ? 'Updated' : 'Unavailable';
    } catch (_) {
      cache.revenue = null;
      $('#statRevenue').textContent = 'Unavailable';
      return 'Unavailable';
    }
  },
  reports: async () => {
    if (role !== 'owner') return 'Owner only';
    cache.reports = (await api('/api/owner/reports')).reports || [];
    return `${cache.reports.length} files`;
  }
};

/* ---------- Preloader: every step is a real check ---------- */
const stepInterface = { label: 'Camp interface', run: async () => { await Promise.race([document.fonts ? document.fonts.ready : null, wait(1200)]); return 'Ready'; } };
const stepKiosk = { label: 'Kiosk link', run: async () => {
  const startedAt = performance.now();
  const status = await api('/api/connectivity/status');
  if (!setLink(status, performance.now() - startedAt)) throw new Error('The kiosk phone link is unavailable. Join the campsite network.');
  return status.lan_ip;
} };
const stepAccount = { label: 'Sign-in', run: async () => {
  try { cache.user = await api('/api/me'); role = cache.user.role; return 'Signed in'; }
  catch (error) { if (!error.status) throw error; cache.user = null; role = null; return 'Ready to sign in'; }
} };
const liveStep = (label, loader) => ({ label, run: async () => cache.user ? loader() : 'After sign-in' });
const liveSteps = [liveStep('Emergency messages and status', load.alerts), liveStep('Report files', load.reports), liveStep('Daily coin total', load.revenue)];

function setProgress(fraction) {
  $('#boot').style.setProperty('--p', fraction);
  $('#bootPct').textContent = `${Math.round(fraction * 100)}%`;
}
function paintStep(index, state, note) {
  const item = $('#bootSteps').children[index];
  item.dataset.s = state;
  item.querySelector('em').textContent = note || '';
}

async function preload(title, steps) {
  const boot = $('#boot');
  document.body.classList.add('booting');
  boot.hidden = false;
  boot.classList.remove('done', 'failed');
  $('#bootTitle').textContent = title;
  while (true) {
    $('#bootSteps').innerHTML = steps.map((step, index) => `<li data-s="wait" style="--k:${index}"><i></i><span>${step.label}</span><em></em></li>`).join('');
    $('#bootRetry').hidden = true;
    boot.classList.remove('failed');
    $('#bootMsg').textContent = 'Checking that everything works…';
    setProgress(0);
    let problem = null;
    for (let index = 0; index < steps.length; index++) {
      paintStep(index, 'run');
      try {
        const [note] = await Promise.all([steps[index].run(), wait(reduce ? 0 : 380)]);
        paintStep(index, 'ok', note);
        setProgress((index + 1) / steps.length);
      } catch (error) { paintStep(index, 'fail', error.message); problem = error; break; }
    }
    if (!problem) return true;
    boot.classList.add('failed');
    $('#bootMsg').textContent = 'Something is not working yet.';
    $('#bootRetry').hidden = false;
    const choice = await new Promise(resolve => { $('#bootAgain').onclick = () => resolve('retry'); $('#bootSkip').onclick = () => resolve('skip'); });
    if (choice === 'skip') return false;
  }
}

async function dismissBoot() {
  $('#bootMsg').textContent = 'All set. Welcome to camp!';
  await wait(reduce ? 0 : 600);
  $('#boot').classList.add('done');
  document.body.classList.remove('booting');
  setTimeout(() => { $('#boot').hidden = true; }, reduce ? 0 : 850);
}

/* ---------- Screens ---------- */
function showLogin() {
  clearInterval(refreshTimer);
  role = null;
  $('#appPanel').hidden = true;
  $('#loginPanel').hidden = false;
}

function enterApp() {
  const user = cache.user;
  role = user.role;
  $('#accountLabel').textContent = `Signed in as ${user.username} · ${role}`;
  renderDashboardMetric(cache.connectivity);
  $('#loginPanel').hidden = true;
  $('#reportsPanel').hidden = role !== 'owner';
  $('#appPanel').hidden = false;
  knownAlertIds = null;
  renderAlerts(); renderEmergencyStatus(); renderPastSos(); renderReports();
  showMessage('Connected to the kiosk. Emergency updates refresh every 2.5 seconds.');
  const panel = $('#appPanel');
  panel.classList.remove('enter'); void panel.offsetWidth; panel.classList.add('enter');
  restartTick();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, 2500);
}

async function refreshAll() {
  try {
    const startedAt = performance.now();
    const status = await api('/api/connectivity/status');
    if (!setLink(status, performance.now() - startedAt)) showMessage('The kiosk phone link is unavailable. Check that the kiosk and phone share the campsite network.');
  } catch (_) { setLink(null); $('#linkState span').textContent = 'Kiosk unreachable'; }
  try {
    await Promise.all([load.alerts(), load.reports(), load.revenue()]);
    renderAlerts(); renderEmergencyStatus(); renderPastSos(); renderReports();
    if ($('#linkState').classList.contains('online')) showMessage('Connected to the kiosk. Emergency updates refresh every 2.5 seconds.');
    restartTick();
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.message.includes('Sign in')) { showLogin(); return; }
    showMessage(error.message);
  }
}

/* ---------- Events ---------- */
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type=submit]');
  $('#loginError').textContent = '';
  const form = new FormData(event.currentTarget);
  button.disabled = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ role: form.get('role'), username: form.get('username'), password: form.get('password') }) });
  } catch (error) { $('#loginError').textContent = error.message; button.disabled = false; return; }
  button.disabled = false;
  await preload('Opening your camp', [stepAccount, ...liveSteps]);
  if (cache.user) enterApp(); else showLogin();
  await dismissBoot();
});

$('#connectPointB').addEventListener('click', connectPointB);
$('#linkState').addEventListener('click', () => {
  if (window.KioskAddress && typeof window.KioskAddress.edit === 'function') {
    window.KioskAddress.edit();
    return;
  }
  const current = cache.connectivity && cache.connectivity.phone_url
    ? new URL(cache.connectivity.phone_url).origin
    : window.location.origin;
  const input = window.prompt('Enter the kiosk IP address or local URL:', current);
  if (input === null || !input.trim()) return;
  try {
    const candidate = /^https?:\/\//i.test(input.trim()) ? new URL(input.trim()) : new URL(`http://${input.trim()}`);
    if (!['http:', 'https:'].includes(candidate.protocol) || !candidate.hostname) throw new Error();
    window.location.href = `${candidate.origin}/mobile/`;
  } catch (_) {
    showMessage('Enter a valid kiosk IP address, such as 192.168.1.13:5000.');
  }
});

$('#signOut').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* The local session may already have expired. */ }
  cache = {};
  showLogin();
  $('#loginForm').reset();
  $('#loginError').textContent = '';
});

$('#alerts').addEventListener('click', async event => {
  const respondButton = event.target.closest('[data-respond]');
  if (respondButton && !respondButton.disabled) {
    const alert = (cache.alerts || []).find(item => item.id === respondButton.dataset.respond);
    if (!alert) return;
    $('#responseAlertId').value = alert.id;
    $('#responseMessage').value = 'SOS Received. Help is on the way.';
    $('#responseMessageCount').textContent = `${[...$('#responseMessage').value].length} / 100 characters`;
    $('#responseMessageError').textContent = '';
    $('#responseCompose').showModal();
    setTimeout(() => $('#responseMessage').focus(), 80);
    return;
  }
  const resolveButton = event.target.closest('[data-resolve]');
  if (!resolveButton) return;
  resolveButton.disabled = true;
  try {
    await api(`/api/mobile/alerts/${encodeURIComponent(resolveButton.dataset.resolve)}/resolve`, { method: 'POST', body: '{}' });
    await load.alerts();
    renderAlerts(); renderEmergencyStatus(); renderPastSos();
  } catch (error) { resolveButton.disabled = false; showMessage(error.message); }
});

$('#responseMessage').addEventListener('input', event => {
  const length = [...event.currentTarget.value].length;
  $('#responseMessageCount').textContent = `${length} / 100 characters`;
});
$('#closeResponseCompose').addEventListener('click', () => $('#responseCompose').close());
$('#cancelResponseCompose').addEventListener('click', () => $('#responseCompose').close());
$('#responseMessageForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#responseMessage').value.trim();
  const send = $('#sendResponseMessage');
  if (!message || [...message].length > 100) { $('#responseMessageError').textContent = 'Keep your message between 1 and 100 characters.'; return; }
  send.disabled = true;
  send.textContent = 'Sending…';
  try {
    await api(`/api/mobile/alerts/${encodeURIComponent($('#responseAlertId').value)}/respond`, { method: 'POST', body: JSON.stringify({ message }) });
    $('#responseCompose').close();
    await load.alerts();
    renderAlerts(); renderEmergencyStatus(); renderPastSos();
    showMessage('Your message was sent to Point A.');
  } catch (error) { $('#responseMessageError').textContent = error.message; }
  finally { send.disabled = false; send.textContent = 'Send response'; }
});
$('#enableSosAlerts').addEventListener('click', async event => {
  const button = event.currentTarget;
  sosSoundEnabled = true;
  syncSosAlarm(cache.alerts || []);
  if (!sosAlarmActive) playSosAlertSound();
  if ('Notification' in window && window.isSecureContext && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (_) { /* The repeating sound does not depend on notifications. */ }
  }
  button.textContent = 'SOS sound enabled';
  button.setAttribute('aria-pressed', 'true');
  button.classList.add('enabled');
  try { localStorage.setItem('campconnect-sos-sound-armed', '1'); } catch (_) { /* Sound stays enabled until this page closes. */ }
  showMessage('SOS alarm will repeat until an owner or staff member responds.');
});
$('#archiveYear').addEventListener('change', renderPastSos);
$('#exportPastSos').addEventListener('click', exportPastSos);

/* ---------- Start ---------- */
(async function start() {
  await preload('Setting up camp', [stepInterface, stepKiosk, stepAccount, ...liveSteps]);
  await reconnectGrantedPointB();
  if (cache.user) enterApp(); else showLogin();
  await dismissBoot();
})();

