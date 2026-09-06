'use strict';

const state = { range: '7d', zone: 'all', data: null, charts: [], controller: null, management: null, configDraft: null, logEntries: [], logTimezone: 'Europe/Berlin', expandedCycles: new Set() };
const adminMode = location.pathname === '/admin' || location.pathname.startsWith('/admin/');
const managementStorage = { open: 'irrigation-management-open', tab: 'irrigation-management-tab', draft: 'irrigation-management-config-draft' };
const colors = ['#63d690', '#65bfe7', '#f3bc67', '#c991e1', '#ff7b72', '#b9e76b', '#58d3c4', '#f49ac2'];
const ranges = ['24h', '7d', '30d', '90d', '1y'];
const $ = (selector) => document.querySelector(selector);

function value(v, digits = 1, suffix = '') { return v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(digits)}${suffix}`; }
function age(ms) {
  if (ms == null) return 'No data';
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
function secondsAge(seconds) { return seconds == null ? 'Never' : age(seconds * 1000); }
function dateTime(ms, zone) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(new Date(ms)); }

function logTime(entry, zone) {
  if (entry.timestamp_ms === null) return `controller +${(entry.clock_ms / 1000).toFixed(3)}s`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    hourCycle: 'h23', timeZoneName: 'short'
  }).formatToParts(new Date(entry.timestamp_ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond} ${parts.timeZoneName}`;
}

function groupLogCycles(entries) {
  const cycles = [];
  const occurrences = new Map();
  let bootPreamble = [];
  for (const entry of entries) {
    if (/^Wake cause\b/i.test(entry.message.trim())) {
      const base = `${entry.timestamp_ms ?? 'null'}:${entry.clock_ms}:${entry.message}`;
      const occurrence = occurrences.get(base) || 0;
      occurrences.set(base, occurrence + 1);
      cycles.push({ key: `${base}:${occurrence}`, entries: [entry, ...bootPreamble] });
      bootPreamble = [];
    } else if (/^Persistent (?:clock restored|state initialized)\b/i.test(entry.message.trim())) {
      // State restoration now happens before the wake-cause line so its timestamp
      // is correct. Hold that boot preamble for the cycle it starts instead of
      // displaying it as the final message of the preceding cycle.
      bootPreamble.push(entry);
    } else if (cycles.length) {
      // Do not discard an unexpected preamble if the firmware emits another line
      // before its wake-cause marker.
      cycles[cycles.length - 1].entries.push(...bootPreamble);
      bootPreamble = [];
      cycles[cycles.length - 1].entries.push(entry);
    }
  }
  return cycles;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hasWakeCauseZero(cycle) {
  return /^Wake cause\s*:\s*0\b/i.test(cycle.entries[0].message.trim());
}

function abnormalCycleReasons(cycles, index) {
  const cycle = cycles[index];
  if (index === cycles.length - 1) return [];
  const reasons = [];
  if (hasWakeCauseZero(cycle)) reasons.push('wake cause 0');
  const previousCounts = cycles.slice(0, index)
    .filter((item) => !hasWakeCauseZero(item))
    .slice(-10)
    .map((item) => item.entries.length);
  if (previousCounts.length) {
    const expectedCount = median(previousCounts);
    if (cycle.entries.length !== expectedCount) reasons.push(`message count differs from recent median (${expectedCount})`);
  }
  return reasons;
}

function renderLogs(entries, zone) {
  state.logEntries = Array.isArray(entries) ? entries : [];
  state.logTimezone = zone || 'Europe/Berlin';
  const container = $('#logs');
  const cycles = groupLogCycles(state.logEntries);
  const availableKeys = new Set(cycles.map((cycle) => cycle.key));
  for (const key of state.expandedCycles) if (!availableKeys.has(key)) state.expandedCycles.delete(key);
  container.replaceChildren();
  if (!cycles.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'log-placeholder';
    placeholder.textContent = 'No controller logs have been received yet.';
    container.append(placeholder);
  }
  for (const [cycleIndex, cycle] of cycles.entries()) {
    const expanded = state.expandedCycles.has(cycle.key);
    const abnormalReasons = abnormalCycleReasons(cycles, cycleIndex);
    const wrapper = document.createElement('section');
    wrapper.className = 'log-cycle';
    const detailsId = `log-cycle-${cycles.indexOf(cycle)}`;
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'log-cycle-summary';
    summary.classList.toggle('log-cycle-summary-abnormal', abnormalReasons.length > 0);
    if (abnormalReasons.length) summary.title = `Abnormal cycle: ${abnormalReasons.join('; ')}`;
    summary.dataset.cycleKey = cycle.key;
    summary.setAttribute('aria-expanded', String(expanded));
    summary.setAttribute('aria-controls', detailsId);
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `[${logTime(cycle.entries[0], state.logTimezone)}]`;
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = cycle.entries[0].message;
    const count = document.createElement('span');
    count.className = 'log-count';
    count.textContent = `${cycle.entries.length} ${cycle.entries.length === 1 ? 'message' : 'messages'}`;
    summary.append(time, message, count);
    const details = document.createElement('div');
    details.id = detailsId;
    details.className = 'log-detail';
    details.hidden = !expanded;
    for (const entry of cycle.entries.slice(1)) {
      const line = document.createElement('div');
      line.className = 'log-line';
      const lineTime = document.createElement('span');
      lineTime.className = 'log-time';
      lineTime.textContent = `[${logTime(entry, state.logTimezone)}]`;
      const lineMessage = document.createElement('span');
      lineMessage.className = 'log-message';
      lineMessage.textContent = entry.message;
      line.append(lineTime, lineMessage);
      details.append(line);
    }
    wrapper.append(summary, details);
    container.append(wrapper);
  }
  $('#collapse-logs').disabled = state.expandedCycles.size === 0;
}

function renderRanges() {
  $('#ranges').innerHTML = ranges.map((r) => `<button type="button" data-range="${r}" class="${r === state.range ? 'active' : ''}">${r}</button>`).join('');
}

function metric(label, main, note) { return `<article class="metric"><span class="metric-label">${label}</span><strong class="metric-value">${main}</strong><span class="metric-note">${note}</span></article>`; }

function weatherDescription(code) {
  const descriptions = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Light freezing drizzle', 57: 'Heavy freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Light snowfall', 73: 'Snowfall', 75: 'Heavy snowfall', 77: 'Snow grains',
    80: 'Light rain showers', 81: 'Rain showers', 82: 'Heavy rain showers',
    85: 'Light snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with light hail', 99: 'Thunderstorm with heavy hail'
  };
  return descriptions[Number(code)] || 'Unknown conditions';
}

function renderSummary(data) {
  const b = data.latest.battery;
  const w = data.latest.weather;
  const averageLoadW = b.loadPowerW == null ? null : Number(b.loadPowerW) * 40 / 3600;
  const elapsedMs = Math.max(0, Date.now() - data.latest.receivedAt);
  const intervalMs = Number(data.expectedIntervalMinutes || 60) * 60000;
  const nextSampleMinutes = Math.max(0, Math.round((intervalMs - elapsedMs) / 60000));
  $('#summary').innerHTML = [
    metric('Battery', value(b.socPercent, 0, '%'), value(b.voltageV, 2, ' V')),
    metric('Solar power', value(b.solarPowerW, 1, ' W'), `${value(b.solarVoltageV, 1, ' V')} · ${value(b.solarCurrentA, 2, ' A')}`),
    metric('Average load', value(averageLoadW, 2, ' W'), `Peak load ${value(b.loadPowerW, 1, ' W')}`),
    metric('Controller', value(b.internalTemperatureC, 1, '°'), `Ambient ${value(b.ambientTemperatureC, 1, '°')}`),
    metric('Weather', value(w.temperatureC, 1, '°'), w.valid ? `${weatherDescription(w.weatherCode)} · ${w.isDay ? 'Day' : 'Night'}` : 'Unavailable'),
    metric('Next sample', `${nextSampleMinutes} min`, 'Expected telemetry cycle')
  ].join('');
}

function renderZones(zones) {
  $('#zones').innerHTML = zones.length ? zones.map((z, index) => {
    const wet = z.wetness == null ? 0 : Math.max(0, Math.min(100, z.wetness));
    const threshold = z.threshold == null ? 0 : Math.max(0, Math.min(100, z.threshold));
    const stateName = !z.enabled ? 'Disabled' : z.watering ? 'Watering' : z.cooldownBlocked ? 'Cooldown' : (z.status || 'Ready');
    const stateClass = !z.enabled ? 'off' : z.watering ? 'watering' : '';
    const gradientId = `wetness-gradient-${index}`;
    return `<article class="zone-card"><div class="zone-top"><span class="zone-name">${escapeHtml(z.name)}</span><span class="zone-state ${stateClass}">${escapeHtml(stateName)}</span></div><div class="wetness">${value(z.wetness, 0, '%')} <small>wetness</small></div><svg class="meter" viewBox="0 0 100 7" preserveAspectRatio="none" role="img" aria-label="${value(z.wetness, 0, '%')} wetness; watering threshold ${value(z.threshold, 0, '%')}"><defs><linearGradient id="${gradientId}" x1="0" x2="1"><stop offset="0" stop-color="#f3bc67"></stop><stop offset="1" stop-color="#63d690"></stop></linearGradient></defs><rect class="meter-track" width="100" height="7" rx="3.5"></rect><rect class="meter-fill" width="${wet}" height="7" rx="3.5" fill="url(#${gradientId})"></rect><line class="threshold" x1="${threshold}" x2="${threshold}" y1="0" y2="7"></line></svg><div class="zone-meta"><span>Threshold ${value(z.threshold, 0, '%')}</span><span>Watered ${secondsAge(z.lastWateredAgeSeconds)}</span></div></article>`;
  }).join('') : '<p class="muted">No zone readings are available.</p>';
}

function escapeHtml(text) { const node = document.createElement('span'); node.textContent = String(text ?? ''); return node.innerHTML; }

function managementMessage(message, error = false) {
  const el = $('#management-message'); el.textContent = message; el.className = `management-message${error ? ' error-inline' : ''}`;
  if (!message) el.classList.add('hidden');
}

async function managementRequest(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options });
  let payload = {}; try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function prettyLabel(key) { return key.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function dotPath(serverPath) { return serverPath.replace(/\[(\d+)\]/g, '.$1'); }
function getPath(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function setPath(object, path, value) { const parts = path.split('.'); const key = parts.pop(); const parent = parts.reduce((item, part) => item[part], object); parent[key] = value; }
function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function configField(path, value, pendingPaths) {
  const key = path.split('.').at(-1); const pending = pendingPaths.has(path); const disabled = path === 'schema_version';
  let input;
  if (typeof value === 'boolean') input = `<input data-config-path="${path}" type="checkbox" ${value ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`;
  else if (typeof value === 'number') {
    const step = key.includes('latitude') || key.includes('longitude') ? '0.000001' : ['watering_threshold', 'wetness_balance'].includes(key) ? '0.01' : '1';
    input = `<input data-config-path="${path}" type="number" step="${step}" ${['watering_threshold', 'wetness_balance'].includes(key) ? 'min="0" max="1"' : ''} value="${value}" ${disabled ? 'disabled' : ''}>`;
  } else input = `<input data-config-path="${path}" type="text" value="${escapeHtml(value)}" ${disabled ? 'disabled' : ''}>`;
  return `<label class="config-field${pending ? ' pending' : ''}" data-field-path="${path}"><span>${prettyLabel(key)}</span>${input}<small>${pending ? 'Awaiting controller download' : key === 'wetness_balance' ? '0 = driest; 0.5 = average; 1 = wettest' : key === 'watering_threshold' ? 'Minimum; temperature adds up to 20 percentage points' : '&nbsp;'}</small></label>`;
}

function renderConfig() {
  const m = state.management; const c = state.configDraft; if (!m || !c) return;
  c.zones.forEach((zone) => { if (zone.wetness_balance === undefined) zone.wetness_balance = [1, 4].includes(zone.zone) ? 0.8 : 0.5; });
  const pending = new Set(m.changedConfigPaths.map(dotPath));
  const globals = Object.keys(c).filter((key) => !['weather','zones'].includes(key));
  $('#management-config').innerHTML = `<div class="management-summary"><div><strong>${pending.size ? `${pending.size} changed parameter${pending.size === 1 ? '' : 's'}` : 'Configuration is current'}</strong><p class="muted">${pending.size ? 'Saved on the server and waiting for an ESP download.' : 'No configuration changes are pending delivery.'}</p></div><div class="summary-actions"><button id="undo-config" type="button" ${m.delivery.configCurrent ? 'disabled' : ''}>Undo pending changes</button><span class="status ${pending.size ? 'status-delayed' : ''}">${pending.size ? 'Pending' : 'Delivered'}</span></div></div>
    <form id="config-form"><section class="config-group"><h3>Controller</h3><div class="config-grid">${globals.map((key) => configField(key, c[key], pending)).join('')}</div></section>
    <section class="config-group"><h3>Weather & time</h3><div class="config-grid">${Object.keys(c.weather).map((key) => configField(`weather.${key}`, c.weather[key], pending)).join('')}</div></section>
    <section class="config-group"><h3>Zones</h3><div class="zone-config-grid">${c.zones.map((zone, index) => `<article class="zone-config"><h3>Zone ${zone.zone}</h3><div class="config-grid">${Object.keys(zone).flatMap((key) => {
      if (key === 'sensor_a' || key === 'sensor_b') return Object.keys(zone[key]).map((sub) => configField(`zones.${index}.${key}.${sub}`, zone[key][sub], pending));
      return [configField(`zones.${index}.${key}`, zone[key], pending)];
    }).join('')}</div></article>`).join('')}</div></section>
    <div class="sticky-actions"><span id="config-dirty-note" class="muted">No unsaved edits</span><button id="save-config" class="primary" type="submit" disabled>Save configuration</button></div></form>`;
  $('#config-form').addEventListener('input', configInput);
  $('#config-form').addEventListener('submit', saveConfig);
  $('#undo-config').addEventListener('click', undoConfig);
  const unsaved = !sameValue(state.configDraft, state.management.config);
  if (unsaved) {
    document.querySelectorAll('[data-config-path]').forEach((input) => {
      const draftValue = getPath(state.configDraft, input.dataset.configPath);
      const publishedValue = getPath(state.management.config, input.dataset.configPath);
      input.closest('.config-field').classList.toggle('unsaved', !sameValue(draftValue, publishedValue));
    });
    $('#save-config').disabled = false; $('#config-dirty-note').textContent = 'Unsaved changes';
  }
  $('#config-count').textContent = pending.size; $('#config-count').classList.toggle('hidden', pending.size === 0);
}

function configInput(event) {
  const input = event.target.closest('[data-config-path]'); if (!input) return;
  const original = getPath(state.management.config, input.dataset.configPath);
  const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
  setPath(state.configDraft, input.dataset.configPath, value);
  sessionStorage.setItem(managementStorage.draft, JSON.stringify({ revision: state.management.revisions.config, config: state.configDraft }));
  const unsaved = !sameValue(state.configDraft, state.management.config);
  input.closest('.config-field').classList.toggle('unsaved', !sameValue(value, original));
  $('#save-config').disabled = !unsaved; $('#config-dirty-note').textContent = unsaved ? 'Unsaved changes' : 'No unsaved edits';
}

async function saveConfig(event) {
  event.preventDefault(); managementMessage('Publishing configuration…'); $('#save-config').disabled = true;
  try {
    await managementRequest('/admin/api/management/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.management.revisions.config }, body: JSON.stringify(state.configDraft) });
    sessionStorage.removeItem(managementStorage.draft);
    await refreshManagement(); managementMessage('Configuration published. Waiting for the controller to download it.');
  } catch (error) { managementMessage(error.message, true); $('#save-config').disabled = false; }
}
async function undoConfig() {
  if (!confirm('Restore the last configuration delivered to the controller?')) return;
  try { await managementRequest('/admin/api/management/config/pending', { method: 'DELETE', headers: { 'If-Match': state.management.revisions.config } }); sessionStorage.removeItem(managementStorage.draft); await refreshManagement(); managementMessage('Pending ESP configuration changes were undone.'); }
  catch (error) { managementMessage(error.message, true); }
}

function renderCommands() {
  const m = state.management;
  $('#command-count').textContent = m.commands.length;
  $('#management-commands').innerHTML = `<div class="management-summary"><div><strong>${m.commands.length} of 16 queued</strong><p class="muted">Commands are delivered once, in this order. Current firmware logs them as unsupported.</p></div><button id="undo-commands" type="button" ${m.commands.length ? '' : 'disabled'}>Undo pending changes</button></div>
    <ol class="command-list">${m.commands.map((command, index) => `<li><div><strong>${escapeHtml(command.name)}</strong><code>${escapeHtml(JSON.stringify(command.arguments))}</code></div><div class="row-actions"><button data-move="up" data-index="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button data-move="down" data-index="${index}" ${index === m.commands.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button class="danger" data-delete-command="${index}">Delete</button></div></li>`).join('') || '<li class="empty-row">The command queue is empty.</li>'}</ol>
    <form id="command-form" class="command-form"><label><span>Command name</span><input id="command-name" required placeholder="future_command"></label><label><span>Arguments (JSON object)</span><textarea id="command-arguments" required rows="5">{}</textarea></label><button class="primary" type="submit" ${m.commands.length >= 16 ? 'disabled' : ''}>Add to queue</button></form>`;
  $('#command-form').addEventListener('submit', addCommand);
  $('#undo-commands').addEventListener('click', undoCommands);
}

async function undoCommands() {
  if (!confirm('Remove every command that is still waiting in the queue?')) return;
  return commandMutation('/admin/api/management/commands', { method: 'DELETE' });
}

async function commandMutation(path, options) {
  managementMessage('Updating command queue…');
  try {
    const result = await managementRequest(path, { ...options, headers: { ...(options.headers || {}), 'If-Match': state.management.revisions.commands } });
    state.management.commands = result.commands; state.management.revisions.commands = result.revision; renderCommands(); managementMessage('Command queue updated.');
  } catch (error) { managementMessage(error.message, true); if (/refresh/i.test(error.message)) await refreshManagement(); }
}
async function addCommand(event) {
  event.preventDefault(); let args;
  try { args = JSON.parse($('#command-arguments').value); if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error(); }
  catch { return managementMessage('Arguments must be a valid JSON object.', true); }
  return commandMutation('/admin/api/management/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#command-name').value, arguments: args }) });
}

function renderFirmware() {
  const f = state.management.firmware; const delivered = state.management.delivery.firmwareCurrent;
  $('#management-firmware').innerHTML = `<div class="firmware-card"><div><p class="eyebrow">PUBLISHED IMAGE</p><h3>${(f.size / 1024 / 1024).toFixed(2)} MiB</h3><code>${f.md5}</code><p class="muted">Updated ${dateTime(Date.parse(f.modifiedAt), state.data?.timezone || 'Europe/Berlin')} · ${delivered ? 'Downloaded by controller' : 'Awaiting controller download'}</p></div><button id="undo-firmware" type="button" ${delivered ? 'disabled' : ''}>Undo pending changes</button></div>
    <form id="firmware-form" class="upload-card"><label><span>ESP application image</span><input id="firmware-file" type="file" accept=".bin,application/octet-stream" required></label><p class="muted">Application binary only, maximum 1.94 MiB. Publishing makes it available on the next telemetry cycle.</p><button class="primary" type="submit">Upload firmware.bin</button></form>`;
  $('#firmware-form').addEventListener('submit', uploadFirmware);
  $('#undo-firmware').addEventListener('click', undoFirmware);
}
async function undoFirmware() {
  if (!confirm('Restore the last firmware image delivered to the controller?')) return;
  try { await managementRequest('/admin/api/management/firmware/pending', { method: 'DELETE', headers: { 'If-Match': state.management.revisions.firmware } }); await refreshManagement(); managementMessage('Pending firmware changes were undone.'); }
  catch (error) { managementMessage(error.message, true); }
}

function renderServerConfiguration(force = false) {
  const container = $('#management-server'); if (!force && container.dataset.rendered === 'true') return;
  const c = state.management.dashboardConfig; const aliases = c.zoneAliases || {};
  container.dataset.rendered = 'true';
  container.innerHTML = `<section class="config-group"><h3>Website settings</h3><form id="server-config-form"><div class="config-grid">
    <label class="config-field"><span>Timezone</span><input name="timezone" value="${escapeHtml(c.timezone)}" required></label>
    <label class="config-field"><span>Expected interval (minutes)</span><input name="expectedIntervalMinutes" type="number" min="1" max="1440" value="${c.expectedIntervalMinutes}" required></label>
    <label class="config-field"><span>Default history range</span><select name="defaultRange">${['24h','7d','30d','90d','1y'].map((range) => `<option ${range === c.defaultRange ? 'selected' : ''}>${range}</option>`).join('')}</select></label>
    ${[1,2,3,4,5].map((zone) => `<label class="config-field"><span>Zone ${zone} alias</span><input name="zoneAlias${zone}" maxlength="64" value="${escapeHtml(aliases[zone] || '')}" placeholder="Zone ${zone}"></label>`).join('')}
    </div><div class="sticky-actions"><span class="muted">Changes apply immediately.</span><button class="primary" type="submit">Save website settings</button></div></form></section>
    <section class="config-group danger-zone"><h3>Maintenance</h3><p class="muted">Every destructive action creates a private recovery backup first. Old recovery artifacts are pruned automatically.</p><div class="maintenance-actions"><button id="clear-logs" class="danger" type="button">Clear controller logs</button><button id="clear-database" class="danger" type="button">Clear entire database</button></div></section>
    <section class="config-group"><div class="section-heading compact"><div><h3>Database entries</h3><p id="database-count" class="muted">Loading…</p></div><button id="refresh-database" type="button">Refresh</button></div><div id="database-entries" class="database-table-wrap"></div><button id="database-more" class="hidden" type="button">Load older entries</button></section>
    <section class="config-group"><h3>Add telemetry entry</h3><form id="database-add-form"><label class="config-field"><span>Telemetry JSON</span><textarea id="database-entry-json" rows="14" spellcheck="false">${escapeHtml(JSON.stringify({ clock_s: 0, next_humidity_s: 3600, battery: { valid: false }, weather: { valid: false }, zones: [{ zone: 1, enabled: false, status: 'MANUAL' }] }, null, 2))}</textarea></label><button class="primary" type="submit">Add database entry</button></form></section>`;
  $('#server-config-form').addEventListener('submit', saveServerConfiguration);
  $('#clear-logs').addEventListener('click', clearLogs); $('#clear-database').addEventListener('click', clearDatabase);
  $('#refresh-database').addEventListener('click', () => loadDatabaseEntries(true)); $('#database-more').addEventListener('click', () => loadDatabaseEntries(false));
  $('#database-add-form').addEventListener('submit', addDatabaseEntry); loadDatabaseEntries(true);
}

async function saveServerConfiguration(event) {
  event.preventDefault(); const data = new FormData(event.currentTarget); const zoneAliases = {};
  for (let zone = 1; zone <= 5; zone++) { const alias = String(data.get(`zoneAlias${zone}`) || '').trim(); if (alias) zoneAliases[zone] = alias; }
  const next = { timezone: String(data.get('timezone')), expectedIntervalMinutes: Number(data.get('expectedIntervalMinutes')), defaultRange: String(data.get('defaultRange')), zoneAliases };
  managementMessage('Saving website settings…');
  try {
    const result = await managementRequest('/admin/api/management/dashboard-config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': state.management.revisions.dashboardConfig }, body: JSON.stringify(next) });
    state.management.dashboardConfig = result.config; state.management.revisions.dashboardConfig = result.revision; renderServerConfiguration(true); managementMessage('Website settings saved.');
  } catch (error) { managementMessage(error.message, true); }
}

function destructiveConfirmation(message, phrase) {
  if (!confirm(`${message}\n\nA recovery backup will be created first.`)) return false;
  return prompt(`Type ${phrase} to confirm:`) === phrase;
}
async function clearLogs() {
  if (!destructiveConfirmation('Clear all controller log output?', 'CLEAR LOGS')) return;
  try { const result = await managementRequest('/admin/api/server/logs', { method: 'DELETE', headers: { 'X-Confirm-Action': 'CLEAR LOGS' } }); $('#logs').textContent = 'No controller logs have been received yet.'; managementMessage(`Logs cleared. Backup: ${result.backup}`); }
  catch (error) { managementMessage(error.message, true); }
}
async function clearDatabase() {
  if (!destructiveConfirmation('Delete every telemetry entry from the database?', 'CLEAR DATABASE')) return;
  try { const result = await managementRequest('/admin/api/server/database', { method: 'DELETE', headers: { 'X-Confirm-Action': 'CLEAR DATABASE' } }); await loadDatabaseEntries(true); managementMessage(`Database cleared. Backup: ${result.backup}`); load(true); }
  catch (error) { managementMessage(error.message, true); }
}

async function loadDatabaseEntries(reset) {
  const currentRows = reset ? [] : (state.databaseEntries || []); const cursor = reset || !currentRows.length ? '' : `?before=${currentRows.at(-1).id}`;
  try {
    const result = await managementRequest(`/admin/api/server/database${cursor}`); state.databaseEntries = [...currentRows, ...result.entries]; state.databaseNext = result.nextBefore;
    $('#database-count').textContent = `${result.count} total telemetry entries`;
    $('#database-entries').innerHTML = `<table class="database-table"><thead><tr><th>ID</th><th>Received</th><th>Battery</th><th>Weather</th><th>Zones</th><th></th></tr></thead><tbody>${state.databaseEntries.map((row) => `<tr><td>${row.id}</td><td>${dateTime(row.received_at_ms, state.management.dashboardConfig.timezone)}</td><td>${value(row.soc_percent, 0, '%')}</td><td>${value(row.temperature_c, 1, '°')}</td><td>${row.zone_count}</td><td><button class="danger" type="button" data-delete-entry="${row.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">The database is empty.</td></tr>'}</tbody></table>`;
    $('#database-more').classList.toggle('hidden', !result.nextBefore);
  } catch (error) { managementMessage(error.message, true); }
}
async function addDatabaseEntry(event) {
  event.preventDefault(); let entry; try { entry = JSON.parse($('#database-entry-json').value); } catch { return managementMessage('Telemetry entry must be valid JSON.', true); }
  try { const result = await managementRequest('/admin/api/server/database/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }); await loadDatabaseEntries(true); managementMessage(`Database entry ${result.id} added.`); load(true); }
  catch (error) { managementMessage(error.message, true); }
}
async function deleteDatabaseEntry(id) {
  if (!destructiveConfirmation(`Delete telemetry entry ${id} and its related readings?`, 'DELETE ENTRY')) return;
  try { const result = await managementRequest(`/admin/api/server/database/entries/${id}`, { method: 'DELETE', headers: { 'X-Confirm-Action': 'DELETE ENTRY' } }); await loadDatabaseEntries(true); managementMessage(`Entry deleted. Backup: ${result.backup}`); load(true); }
  catch (error) { managementMessage(error.message, true); }
}
async function uploadFirmware(event) {
  event.preventDefault(); const file = $('#firmware-file').files[0]; if (!file) return;
  if (!confirm(`Replace firmware.bin with ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MiB)?`)) return;
  managementMessage('Uploading firmware…');
  try {
    await managementRequest('/admin/api/management/firmware', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': state.management.revisions.firmware }, body: file });
    await refreshManagement(); managementMessage('Firmware published successfully.');
  } catch (error) { managementMessage(error.message, true); }
}

async function refreshManagement() {
  const previousManagement = state.management; const previousDraft = state.configDraft;
  const hadUnsavedDraft = previousManagement && previousDraft && !sameValue(previousDraft, previousManagement.config);
  state.management = await managementRequest('/admin/api/management');
  if (hadUnsavedDraft && previousManagement.revisions.config === state.management.revisions.config) {
    state.configDraft = previousDraft;
  } else {
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(managementStorage.draft) || 'null'); } catch {}
    if (stored?.revision === state.management.revisions.config && stored.config) state.configDraft = stored.config;
    else { state.configDraft = structuredClone(state.management.config); sessionStorage.removeItem(managementStorage.draft); }
  }
  renderConfig(); renderCommands(); renderFirmware();
  renderServerConfiguration();
}

async function openManagement() {
  const dialog = $('#management-dialog'); sessionStorage.setItem(managementStorage.open, '1');
  if (!dialog.open) dialog.showModal(); managementMessage('Loading management state…');
  try { await refreshManagement(); managementMessage(''); } catch (error) { managementMessage(error.message, true); }
}

function closeManagement() {
  sessionStorage.removeItem(managementStorage.open);
  if ($('#management-dialog').open) $('#management-dialog').close();
}

async function initializeAdmin() {
  if (!adminMode) return;
  const response = await fetch('/admin/api/session', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Your authenticated admin session could not be verified.');
  const session = await response.json();
  $('#admin-link').classList.add('hidden');
  $('#admin-identity').textContent = session.email;
  $('#admin-identity').classList.remove('hidden');
  $('#logout-link').classList.remove('hidden');
  $('#admin-panel').classList.remove('hidden');
  $('#footer-copy').textContent = 'Authenticated administration · Telemetry remains read-only';
}
function destroyCharts() { state.charts.forEach((chart) => chart.destroy()); state.charts = []; }
function sizeFor(el) { return { width: Math.max(280, el.clientWidth), height: Math.max(230, Math.min(320, el.clientWidth * .38)) }; }
function wateringMarkerPlugin(markers) {
  return {
    hooks: {
      draw: [(chart) => {
        const { ctx, bbox } = chart;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
        ctx.clip();
        ctx.lineWidth = 3;
        markers.forEach((marker) => {
          if (!Number.isFinite(marker.time) || !Number.isFinite(marker.wetness)) return;
          const x = chart.valToPos(marker.time, 'x', true);
          const y = chart.valToPos(marker.wetness, 'y', true);
          ctx.strokeStyle = marker.color;
          ctx.beginPath();
          ctx.moveTo(x, y - 14);
          ctx.lineTo(x, y + 14);
          ctx.stroke();
        });
        ctx.restore();
      }]
    }
  };
}

function baseOptions(el, series, range, plugins = [], axes = [{}, {}]) {
  const size = sizeFor(el);
  return { ...size, cursor: { drag: { x: true, y: false } }, legend: { show: true }, scales: { x: { time: true, range } }, axes: [{ stroke: '#9ab2a3', grid: { stroke: 'rgba(164,211,183,.10)' } }, ...axes.slice(1).map((a) => ({ stroke: '#9ab2a3', grid: { stroke: 'rgba(164,211,183,.10)' }, ...a }))], series, plugins };
}
function plot(el, times, seriesDefs, values, range, plugins = []) {
  if (!times.length) { el.innerHTML = '<p class="muted">No readings in this range.</p>'; return; }
  const chart = new uPlot(baseOptions(el, [{}, ...seriesDefs], range, plugins), [times, ...values], el);
  state.charts.push(chart);
}

function renderCharts(data) {
  destroyCharts();
  const wetEl = $('#wetness-chart'); const powerEl = $('#power-chart'); const tempEl = $('#temperature-chart');
  [wetEl, powerEl, tempEl].forEach((el) => { el.innerHTML = ''; });
  const byZone = new Map();
  data.zoneHistory.forEach((row) => { if (!byZone.has(row.zone)) byZone.set(row.zone, []); byZone.get(row.zone).push(row); });
  const allTimes = [...new Set(data.zoneHistory.map((r) => Math.round(r.time_ms / 1000)))].sort((a, b) => a - b);
  const wetDefs = []; const wetValues = []; const wetMarkers = [];
  [...byZone.entries()].forEach(([zone, rows], index) => {
    const map = new Map(rows.map((r) => [Math.round(r.time_ms / 1000), r.wetness]));
    const thresholdMap = new Map(rows.map((r) => [Math.round(r.time_ms / 1000), r.threshold]));
    const name = data.zones.find((z) => z.zone === zone)?.name || `Zone ${zone}`;
    const color = colors[index % colors.length];
    wetDefs.push({ label: name, stroke: colors[index % colors.length], width: 2, spanGaps: false });
    wetValues.push(allTimes.map((t) => map.has(t) ? map.get(t) : null));
    wetDefs.push({ label: `${name} threshold`, stroke: colors[index % colors.length], width: 1, dash: [6, 4], spanGaps: false });
    wetValues.push(allTimes.map((t) => thresholdMap.has(t) ? thresholdMap.get(t) : null));
    rows.forEach((row) => {
      if (row.watered) wetMarkers.push({ time: Math.round(row.time_ms / 1000), wetness: row.wetness == null ? NaN : Number(row.wetness), color });
    });
  });
  const xRange = [Math.round(data.rangeFrom / 1000), Math.round(data.rangeTo / 1000)];
  const wetnessPlugins = ['24h', '7d', '30d'].includes(state.range) ? [wateringMarkerPlugin(wetMarkers)] : [];
  plot(wetEl, allTimes, wetDefs, wetValues, xRange, wetnessPlugins);
  const times = data.history.map((r) => Math.round(r.time_ms / 1000));
  plot(powerEl, times, [
    { label: 'Solar W', stroke: colors[2], width: 2 },
    { label: 'Load W', stroke: colors[1], width: 2 }
  ], [data.history.map((r) => r.solar_power_w), data.history.map((r) => r.load_power_w)], xRange);
  plot(tempEl, times, [
    { label: 'Ambient °C', stroke: colors[0], width: 2 },
    { label: 'Controller °C', stroke: colors[4], width: 2 },
    { label: 'Weather °C', stroke: colors[1], width: 2 }
  ], [data.history.map((r) => r.ambient_temperature_c), data.history.map((r) => r.internal_temperature_c), data.history.map((r) => r.weather_temperature_c)], xRange);
}

function render(data) {
  state.data = data;
  if (!data.latest) throw new Error('No telemetry has been recorded yet.');
  $('#updated').textContent = `Last reading ${dateTime(data.latest.receivedAt, data.timezone)} · ${age(Date.now() - data.latest.receivedAt)}`;
  const fresh = $('#freshness'); fresh.className = `status status-${data.freshness.state}`; fresh.textContent = data.freshness.state.replace('-', ' ');
  renderSummary(data); renderZones(data.zones);
  const select = $('#zone'); const current = state.zone;
  select.innerHTML = '<option value="all">All zones</option>' + data.zones.map((z) => `<option value="${z.zone}">${escapeHtml(z.name)}</option>`).join('');
  select.value = current;
  renderCharts(data);
}

async function load(force = false) {
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  $('#refresh').disabled = true; $('#error').classList.add('hidden');
  try {
    const [response, logResponse] = await Promise.all([
      fetch(`/api/v1/dashboard?range=${encodeURIComponent(state.range)}&zone=${encodeURIComponent(state.zone)}`, { cache: force ? 'no-cache' : 'default', signal: state.controller.signal }),
      fetch('/api/v1/logs', { cache: 'no-store', signal: state.controller.signal })
    ]);
    if (!response.ok) throw new Error(response.status === 429 ? 'Too many refreshes. Please wait a moment.' : 'Telemetry is temporarily unavailable.');
    const dashboardData = await response.json();
    if (logResponse.ok) {
      const logData = await logResponse.json();
      renderLogs(logData.logs, dashboardData.timezone);
    } else {
      $('#logs').textContent = 'Controller logs are temporarily unavailable.';
      state.expandedCycles.clear();
      $('#collapse-logs').disabled = true;
    }
    $('#logs').scrollTop = $('#logs').scrollHeight;
    render(dashboardData);
  } catch (error) {
    if (error.name !== 'AbortError') { $('#error').textContent = error.message; $('#error').classList.remove('hidden'); }
  } finally { $('#refresh').disabled = false; }
}

$('#open-management').addEventListener('click', openManagement);
$('#close-management').addEventListener('click', closeManagement);
$('#management-dialog').addEventListener('cancel', (event) => { event.preventDefault(); closeManagement(); });
$('#management-dialog').addEventListener('click', (event) => { if (event.target === $('#management-dialog')) closeManagement(); });
$('.management-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-management-tab]'); if (!button) return;
  sessionStorage.setItem(managementStorage.tab, button.dataset.managementTab);
  document.querySelectorAll('[data-management-tab]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.management-view').forEach((view) => view.classList.toggle('hidden', view.id !== `management-${button.dataset.managementTab}`));
});
$('#management-commands').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-delete-command]');
  if (remove) return commandMutation(`/admin/api/management/commands/${remove.dataset.deleteCommand}`, { method: 'DELETE' });
  const move = event.target.closest('[data-move]'); if (!move) return;
  const from = Number(move.dataset.index); const to = from + (move.dataset.move === 'up' ? -1 : 1);
  commandMutation('/admin/api/management/commands/reorder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
});
$('#management-server').addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-entry]'); if (button) deleteDatabaseEntry(Number(button.dataset.deleteEntry));
});
$('#ranges').addEventListener('click', (event) => { const button = event.target.closest('[data-range]'); if (!button) return; state.range = button.dataset.range; renderRanges(); load(); });
$('#zone').addEventListener('change', (event) => { state.zone = event.target.value; load(); });
$('#refresh').addEventListener('click', () => load(true));
$('#logs').addEventListener('click', (event) => {
  const summary = event.target.closest('.log-cycle-summary');
  if (!summary) return;
  const details = document.getElementById(summary.getAttribute('aria-controls'));
  const expanded = summary.getAttribute('aria-expanded') === 'true';
  summary.setAttribute('aria-expanded', String(!expanded));
  details.hidden = expanded;
  if (expanded) state.expandedCycles.delete(summary.dataset.cycleKey);
  else state.expandedCycles.add(summary.dataset.cycleKey);
  $('#collapse-logs').disabled = state.expandedCycles.size === 0;
});
$('#collapse-logs').addEventListener('click', () => {
  state.expandedCycles.clear();
  document.querySelectorAll('.log-cycle-summary[aria-expanded="true"]').forEach((summary) => summary.setAttribute('aria-expanded', 'false'));
  document.querySelectorAll('.log-detail').forEach((details) => { details.hidden = true; });
  $('#collapse-logs').disabled = true;
});
$('#logout-link').addEventListener('click', async (event) => {
  event.preventDefault();
  const link = event.currentTarget;
  link.setAttribute('aria-disabled', 'true');
  link.textContent = 'Logging out…';
  try {
    await fetch('/cdn-cgi/access/logout', { credentials: 'include', cache: 'no-store', redirect: 'manual' });
  } catch {
    // A manual cross-origin redirect can surface as a fetch error after the
    // application cookie has already been cleared by Cloudflare Access.
  } finally {
    location.replace('/');
  }
});
let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.data) renderCharts(state.data); }, 180); });
renderRanges();
initializeAdmin().then(async () => {
  await load();
  const savedTab = sessionStorage.getItem(managementStorage.tab);
  const tabButton = savedTab && document.querySelector(`[data-management-tab="${savedTab}"]`);
  if (tabButton) tabButton.click();
  if (adminMode && sessionStorage.getItem(managementStorage.open) === '1') await openManagement();
}).catch((error) => {
  $('#error').textContent = error.message;
  $('#error').classList.remove('hidden');
});
setInterval(() => {
  if (!state.data?.latest) return;
  $('#updated').textContent = `Last reading ${dateTime(state.data.latest.receivedAt, state.data.timezone)} · ${age(Date.now() - state.data.latest.receivedAt)}`;
  renderSummary(state.data);
}, 15000);
setInterval(() => {
  if (!$('#management-dialog').open || !state.management?.changedConfigPaths?.length) return;
  refreshManagement().catch((error) => managementMessage(error.message, true));
}, 10000);
