'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.DASHBOARD_PORT || 8071);
const DB_PATH = process.env.IRRIGATION_DB || '/mnt/usbdata/irrigation_data/irrigation.sqlite3';
const LOG_PATH = process.env.IRRIGATION_LOG || path.join(path.dirname(DB_PATH), 'log.txt');
const MANAGEMENT_DIR = process.env.IRRIGATION_MANAGEMENT_DIR || path.join(path.dirname(DB_PATH), 'management');
const COMMANDS_PATH = path.join(MANAGEMENT_DIR, 'commands.json');
const RUNTIME_CONFIG_PATH = path.join(MANAGEMENT_DIR, 'config.json');
const FIRMWARE_PATH = path.join(MANAGEMENT_DIR, 'firmware.bin');
const FIRMWARE_ROLLBACK_PATH = path.join(MANAGEMENT_DIR, 'firmware.rollback.bin');
const DASHBOARD_CONFIG_PATH = path.join(MANAGEMENT_DIR, 'dashboard-config.json');
const ADMIN_BACKUP_DIR = path.join(path.dirname(DB_PATH), 'admin-backups');
const MANAGEMENT_STATE_PATH = path.join(MANAGEMENT_DIR, 'management-state.json');
const MANAGEMENT_LOCK_PATH = path.join(MANAGEMENT_DIR, '.management.lock');
const MAX_COMMANDS = 16;
const MAX_FIRMWARE_BYTES = 0x1F0000;
const ADMIN_JSON_LIMIT = 128 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_BACKUP_MAX_BYTES = 20 * 1024 ** 3;
const ADMIN_BACKUP_POLICIES = {
  log: { maxAgeMs: 30 * DAY_MS, maxFiles: 10, matches: (name) => /^log-before-clear-.*\.txt$/.test(name) },
  database: { maxAgeMs: 180 * DAY_MS, maxFiles: 4, matches: (name) => /^database-.*\.sqlite3$/.test(name) },
  entry: { maxAgeMs: 30 * DAY_MS, maxFiles: 100, matches: (name) => /^entry-\d+-before-delete-.*\.json$/.test(name) }
};
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
let config = JSON.parse(fs.readFileSync(fs.existsSync(DASHBOARD_CONFIG_PATH) ? DASHBOARD_CONFIG_PATH : path.join(ROOT, 'config.json'), 'utf8'));
let expectedMs = Number(config.expectedIntervalMinutes || 60) * 60_000;
const CACHE_VERSION = 'fixed-ranges-watered-v3';
const ACCESS_TEAM_DOMAIN = String(process.env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
const ACCESS_AUD = String(process.env.CF_ACCESS_AUD || '').trim();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ACCESS_ISSUER = ACCESS_TEAM_DOMAIN ? `https://${ACCESS_TEAM_DOMAIN}` : '';
const ACCESS_JWKS_URL = ACCESS_TEAM_DOMAIN ? `${ACCESS_ISSUER}/cdn-cgi/access/certs` : '';
const accessConfigured = Boolean(ACCESS_TEAM_DOMAIN && ACCESS_AUD && ADMIN_EMAIL);
let accessKeys = { expiresAt: 0, keys: [] };
let adminBackupQueue = Promise.resolve();

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withManagementLock(task) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.promises.mkdir(MANAGEMENT_LOCK_PATH, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(MANAGEMENT_LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 30000) {
          const stale = `${MANAGEMENT_LOCK_PATH}.stale-${process.pid}-${Date.now()}`;
          await fs.promises.rename(MANAGEMENT_LOCK_PATH, stale);
          await fs.promises.rm(stale, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) { if (lockError.code === 'ENOENT') continue; }
      if (Date.now() >= deadline) throw Object.assign(new Error('Management files are busy'), { statusCode: 503 });
      await delay(30 + Math.floor(Math.random() * 40));
    }
  }
  try { return await task(); }
  finally { await fs.promises.rmdir(MANAGEMENT_LOCK_PATH).catch(() => undefined); }
}

async function atomicWrite(filePath, data) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.promises.unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') console.error('Temporary file cleanup failed:', error.message); });
  }
}

function withAdminBackupQueue(task) {
  const result = adminBackupQueue.then(task, task);
  adminBackupQueue = result.catch(() => undefined);
  return result;
}

async function pruneAdminBackups(protectedNames = new Set()) {
  let directoryEntries;
  try { directoryEntries = await fs.promises.readdir(ADMIN_BACKUP_DIR, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { deleted: 0, retainedBytes: 0 }; throw error; }
  const artifacts = [];
  for (const entry of directoryEntries) {
    if (!entry.isFile()) continue;
    const type = Object.keys(ADMIN_BACKUP_POLICIES).find((key) => ADMIN_BACKUP_POLICIES[key].matches(entry.name));
    if (!type) continue;
    const stat = await fs.promises.stat(path.join(ADMIN_BACKUP_DIR, entry.name));
    artifacts.push({ name: entry.name, type, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  const deleteNames = new Set();
  const now = Date.now();
  for (const [type, policy] of Object.entries(ADMIN_BACKUP_POLICIES)) {
    const sorted = artifacts.filter((artifact) => artifact.type === type).sort((a, b) => b.mtimeMs - a.mtimeMs);
    sorted.forEach((artifact, index) => {
      if (!protectedNames.has(artifact.name) && (index >= policy.maxFiles || now - artifact.mtimeMs > policy.maxAgeMs)) {
        deleteNames.add(artifact.name);
      }
    });
  }

  const retained = artifacts.filter((artifact) => !deleteNames.has(artifact.name));
  let retainedBytes = retained.reduce((total, artifact) => total + artifact.size, 0);
  for (const artifact of retained.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (retainedBytes <= ADMIN_BACKUP_MAX_BYTES) break;
    if (protectedNames.has(artifact.name)) continue;
    deleteNames.add(artifact.name);
    retainedBytes -= artifact.size;
  }
  for (const name of deleteNames) {
    await fs.promises.unlink(path.join(ADMIN_BACKUP_DIR, name)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { deleted: deleteNames.size, retainedBytes };
}

async function maintainAdminBackups(protectedNames = new Set()) {
  try { return await pruneAdminBackups(protectedNames); }
  catch (error) {
    console.error('Admin backup retention failed:', error.message);
    return { deleted: 0, retainedBytes: null };
  }
}

function receiveBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (!Number.isInteger(declared) || declared < 1 || declared > limit) {
      reject(Object.assign(new Error('Invalid Content-Length'), { statusCode: 413 })); return;
    }
    const chunks = []; let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 })); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => size === declared ? resolve(Buffer.concat(chunks)) : reject(Object.assign(new Error('Incomplete request body'), { statusCode: 400 })));
    req.on('error', reject);
  });
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function md5(data) { return crypto.createHash('md5').update(data).digest('hex'); }
function queueRevision(commands) { return `"${sha256(Buffer.from(JSON.stringify(commands)))}"`; }

function validateCommands(commands) {
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) throw Object.assign(new Error('Command queue must contain at most 16 entries'), { statusCode: 400 });
  commands.forEach((command) => {
    if (!isObject(command) || typeof command.name !== 'string' || !command.name.trim() || !isObject(command.arguments)) {
      throw Object.assign(new Error('Each command needs a name and an arguments object'), { statusCode: 400 });
    }
  });
  return commands;
}

function validateRuntimeConfig(c) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!isObject(c) || c.schema_version !== 1) fail('schema_version must be 1');
  const integer = (key, min, max, source = c) => {
    if (!Number.isInteger(source[key]) || source[key] < min || source[key] > max) fail(`${key} must be an integer from ${min} to ${max}`);
  };
  integer('humidity_interval_s', 60, 86400); integer('sensor_samples', 1, 32);
  integer('sensor_sample_delay_ms', 0, 1000); integer('mux_settle_ms', 0, 1000);
  integer('valve_open_pulse_ms', 100, 60000); integer('valve_close_pulse_ms', 100, 60000);
  integer('watering_cooldown_s', 0, 604800); integer('load_startup_wait_ms', 0, 60000);
  integer('wifi_timeout_ms', 1000, 60000); integer('http_timeout_ms', 1000, 60000); integer('time_sync_timeout_ms', 1000, 60000);
  integer('sensor_valid_raw_min', 0, 4095); integer('sensor_valid_raw_max', 0, 4095);
  if (c.sensor_valid_raw_min >= c.sensor_valid_raw_max) fail('sensor_valid_raw_min must be below sensor_valid_raw_max');
  integer('minimum_battery_soc_percent', 0, 100);
  if (typeof c.timezone !== 'string' || !c.timezone.length || c.timezone.length > 96) fail('timezone is invalid');
  if (typeof c.ntp_server !== 'string' || !c.ntp_server.length || c.ntp_server.length > 128) fail('ntp_server is invalid');
  if (!isObject(c.weather) || !Number.isFinite(c.weather.latitude) || c.weather.latitude < -90 || c.weather.latitude > 90 || !Number.isFinite(c.weather.longitude) || c.weather.longitude < -180 || c.weather.longitude > 180) fail('weather coordinates are invalid');
  if (!Array.isArray(c.zones) || c.zones.length !== 5) fail('Exactly five zones are required');
  const seen = new Set();
  c.zones.forEach((zone) => {
    if (!isObject(zone)) fail('Each zone must be an object');
    integer('zone', 1, 5, zone); if (seen.has(zone.zone)) fail('Zone numbers must be unique'); seen.add(zone.zone);
    ['sensor_a_channel','sensor_b_channel','valve_open_channel','valve_close_channel'].forEach((key) => integer(key, 0, 15, zone));
    for (const sensorKey of ['sensor_a','sensor_b']) {
      const sensor = zone[sensorKey]; if (!isObject(sensor)) fail(`${sensorKey} is invalid`);
      integer('wet_raw', 0, 4095, sensor); integer('dry_raw', 0, 4095, sensor);
      if (sensor.wet_raw === sensor.dry_raw) fail(`${sensorKey} calibration endpoints must differ`);
    }
    if (!Number.isFinite(zone.watering_threshold) || zone.watering_threshold < 0 || zone.watering_threshold > 1) fail('watering_threshold must be from 0 to 1');
    if (typeof zone.enabled !== 'boolean') fail('enabled must be true or false');
    integer('watering_duration_s', 1, 86400, zone);
  });
  return c;
}

function validateDashboardConfig(value) {
  if (!isObject(value)) throw Object.assign(new Error('Website configuration must be an object'), { statusCode: 400 });
  const allowedRanges = new Set(['24h', '7d', '30d', '90d', '1y']);
  if (typeof value.timezone !== 'string' || !value.timezone.trim() || value.timezone.length > 96) throw Object.assign(new Error('Timezone is invalid'), { statusCode: 400 });
  if (!Number.isInteger(value.expectedIntervalMinutes) || value.expectedIntervalMinutes < 1 || value.expectedIntervalMinutes > 1440) throw Object.assign(new Error('Expected interval must be from 1 to 1440 minutes'), { statusCode: 400 });
  if (!allowedRanges.has(value.defaultRange)) throw Object.assign(new Error('Default range is invalid'), { statusCode: 400 });
  if (!isObject(value.zoneAliases)) throw Object.assign(new Error('Zone aliases must be an object'), { statusCode: 400 });
  for (const [zone, alias] of Object.entries(value.zoneAliases)) {
    if (!/^[1-5]$/.test(zone) || typeof alias !== 'string' || !alias.trim() || alias.length > 64) throw Object.assign(new Error('Zone aliases require zone numbers 1–5 and non-empty names'), { statusCode: 400 });
  }
  return { timezone: value.timezone.trim(), expectedIntervalMinutes: value.expectedIntervalMinutes, defaultRange: value.defaultRange, zoneAliases: Object.fromEntries(Object.entries(value.zoneAliases).map(([zone, alias]) => [zone, alias.trim()])) };
}

function validateManualTelemetry(value) {
  const bad = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (!isObject(value) || !Number.isFinite(value.clock_s) || !Number.isFinite(value.next_humidity_s)) bad('Telemetry requires finite clock_s and next_humidity_s');
  if (!isObject(value.battery) || !isObject(value.weather) || !Array.isArray(value.zones) || value.zones.length < 1 || value.zones.length > 64) bad('Telemetry requires battery, weather, and zone data');
  const seen = new Set();
  for (const zone of value.zones) {
    if (!isObject(zone) || !Number.isInteger(zone.zone) || zone.zone < 1 || zone.zone > 255 || seen.has(zone.zone)) bad('Zone numbers must be unique positive integers');
    seen.add(zone.zone);
  }
  if (value.received_at_ms != null && (!Number.isInteger(value.received_at_ms) || value.received_at_ms < 0)) bad('received_at_ms is invalid');
  return value;
}

function confirmation(req, expected) {
  if (req.headers['x-confirm-action'] !== expected) throw Object.assign(new Error(`Confirmation '${expected}' is required`), { statusCode: 400 });
}

function timestampForFile() { return new Date().toISOString().replace(/[-:.]/g, ''); }

async function insertManualTelemetry(value) {
  const telemetry = validateManualTelemetry(value); const raw = JSON.stringify(telemetry); const receivedAt = telemetry.received_at_ms || Date.now();
  await dbExec('BEGIN IMMEDIATE');
  try {
    const post = await dbRun('INSERT INTO telemetry_posts(received_at_ms,source_ip,clock_s,next_humidity_s,raw_json,raw_bytes) VALUES(?,?,?,?,?,?)', [receivedAt, 'admin', telemetry.clock_s, telemetry.next_humidity_s, raw, Buffer.byteLength(raw)]);
    const b = telemetry.battery; await dbRun(`INSERT INTO battery_readings(post_id,valid,voltage_v,soc_percent,status_raw,stage_raw,charge_current_a,solar_voltage_v,solar_current_a,solar_power_w,load_state_raw,load_current_a,load_power_w,usb_state_raw,usb_voltage_v,internal_temperature_c,ambient_temperature_c,temperature_state_raw) VALUES(${Array(18).fill('?').join(',')})`, [post.lastID, b.valid, b.voltage_v, b.soc_percent, b.status_raw, b.stage_raw, b.charge_current_a, b.solar_voltage_v, b.solar_current_a, b.solar_power_w, b.load_state_raw, b.load_current_a, b.load_power_w, b.usb_state_raw, b.usb_voltage_v, b.internal_temperature_c, b.ambient_temperature_c, b.temperature_state_raw]);
    const w = telemetry.weather; await dbRun('INSERT INTO weather_readings(post_id,valid,temperature_c,weather_code,is_day) VALUES(?,?,?,?,?)', [post.lastID, w.valid, w.temperature_c, w.weather_code, w.is_day]);
    for (const z of telemetry.zones) await dbRun(`INSERT INTO zone_readings(post_id,zone,enabled,raw_a,raw_b,wetness_a,wetness_b,wetness,threshold,requested,cooldown_blocked,watering,has_been_watered,last_watered_s,close_deadline_s,status,watered) VALUES(${Array(17).fill('?').join(',')})`, [post.lastID, z.zone, z.enabled, z.raw_a, z.raw_b, z.wetness_a, z.wetness_b, z.wetness, z.threshold, z.requested, z.cooldown_blocked, z.watering, z.has_been_watered, z.last_watered_s, z.close_deadline_s, z.status, z.watered || false]);
    await dbExec('COMMIT'); cache.clear(); return post.lastID;
  } catch (error) { await dbExec('ROLLBACK').catch(() => undefined); throw error; }
}

function changedPaths(current, baseline, prefix = '') {
  if (JSON.stringify(current) === JSON.stringify(baseline)) return [];
  if (Array.isArray(current) && Array.isArray(baseline)) return current.flatMap((value, index) => changedPaths(value, baseline[index], `${prefix}[${index}]`));
  if (isObject(current) && isObject(baseline)) return [...new Set([...Object.keys(current), ...Object.keys(baseline)])].flatMap((key) => changedPaths(current[key], baseline[key], prefix ? `${prefix}.${key}` : key));
  return [prefix];
}

const ranges = Object.freeze({
  '24h': { ms: 24 * 3600_000, bucketMs: 3600_000 },
  '7d': { ms: 7 * 86400_000, bucketMs: 3600_000 },
  '30d': { ms: 30 * 86400_000, bucketMs: 3600_000 },
  '90d': { ms: 90 * 86400_000, bucketMs: 3 * 3600_000 },
  '1y': { ms: 366 * 86400_000, bucketMs: 12 * 3600_000 }
});

const staticFiles = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/app.css': ['app.css', 'text/css; charset=utf-8', 'no-cache'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon', 'public, max-age=31536000, immutable'],
  '/icons/favicon-32.png': ['icons/favicon-32.png', 'image/png', 'public, max-age=31536000, immutable'],
  '/icons/favicon-192.png': ['icons/favicon-192.png', 'image/png', 'public, max-age=31536000, immutable'],
  '/vendor/uPlot.iife.min.js': ['vendor/uPlot.iife.min.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
  '/vendor/uPlot.min.css': ['vendor/uPlot.min.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable']
});

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (error) => {
  if (error) console.error('Database open failed:', error.message);
});
db.configure('busyTimeout', 3000);
db.run('PRAGMA foreign_keys=ON');

function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve({ lastID: this.lastID, changes: this.changes }); }));
}
function dbExec(sql) { return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve())); }
function backupDatabase(filePath) {
  return new Promise((resolve, reject) => {
    const backup = db.backup(filePath);
    backup.step(-1, (stepError) => backup.finish((finishError) => {
      const error = stepError || finishError; error ? reject(error) : resolve();
    }));
  });
}

function bool(value) {
  return value == null ? null : Boolean(value);
}

function freshness(receivedAt, now = Date.now()) {
  if (!receivedAt) return { state: 'missing', ageMs: null };
  const ageMs = now - receivedAt;
  if (ageMs < -300_000) return { state: 'clock-error', ageMs };
  if (ageMs <= expectedMs * 1.5) return { state: 'fresh', ageMs: Math.max(0, ageMs) };
  if (ageMs <= expectedMs * 2.5) return { state: 'delayed', ageMs };
  return { state: 'stale', ageMs };
}

const latestSql = `
  SELECT p.id, p.received_at_ms, p.clock_s, p.next_humidity_s,
    b.valid battery_valid, b.voltage_v, b.soc_percent, b.status_raw, b.stage_raw,
    b.charge_current_a, b.solar_voltage_v, b.solar_current_a, b.solar_power_w,
    b.load_state_raw, b.load_current_a, b.load_power_w, b.usb_state_raw,
    b.usb_voltage_v, b.internal_temperature_c, b.ambient_temperature_c,
    b.temperature_state_raw, w.valid weather_valid, w.temperature_c weather_temperature_c,
    w.weather_code, w.is_day
  FROM telemetry_posts p
  LEFT JOIN battery_readings b ON b.post_id = p.id
  LEFT JOIN weather_readings w ON w.post_id = p.id
  ORDER BY p.id DESC LIMIT 1`;

const historySql = `
  SELECT CAST((p.received_at_ms - ?) / ? AS INTEGER) bucket,
    MIN(p.received_at_ms) time_ms,
    AVG(b.soc_percent) soc_percent,
    AVG(b.voltage_v) voltage_v,
    AVG(b.solar_power_w) solar_power_w,
    AVG(b.load_power_w) load_power_w,
    AVG(b.internal_temperature_c) internal_temperature_c,
    AVG(b.ambient_temperature_c) ambient_temperature_c,
    AVG(w.temperature_c) weather_temperature_c
  FROM telemetry_posts p
  LEFT JOIN battery_readings b ON b.post_id = p.id
  LEFT JOIN weather_readings w ON w.post_id = p.id
  WHERE p.received_at_ms >= ? AND p.received_at_ms <= ?
  GROUP BY bucket ORDER BY bucket LIMIT 1100`;

const zoneHistorySql = `
  SELECT CAST((p.received_at_ms - ?) / ? AS INTEGER) bucket, z.zone,
    MIN(p.received_at_ms) time_ms,
    AVG(CASE WHEN z.wetness BETWEEN 0 AND 1 THEN z.wetness * 100 ELSE z.wetness END) wetness,
    MIN(CASE WHEN z.wetness BETWEEN 0 AND 1 THEN z.wetness * 100 ELSE z.wetness END) wetness_min,
    MAX(CASE WHEN z.wetness BETWEEN 0 AND 1 THEN z.wetness * 100 ELSE z.wetness END) wetness_max,
    AVG(CASE WHEN z.threshold BETWEEN 0 AND 1 THEN z.threshold * 100 ELSE z.threshold END) threshold,
    MAX(COALESCE(z.watering, 0)) watering,
    MAX(COALESCE(z.watered, 0)) watered
  FROM telemetry_posts p
  JOIN zone_readings z ON z.post_id = p.id
  WHERE p.received_at_ms >= ? AND p.received_at_ms <= ? AND (? IS NULL OR z.zone = ?)
  GROUP BY bucket, z.zone ORDER BY bucket, z.zone LIMIT 66000`;

function latestVersion() {
  return get('SELECT id, received_at_ms, (SELECT count(*) FROM telemetry_posts) row_count FROM telemetry_posts ORDER BY id DESC LIMIT 1');
}

function zoneName(zone) {
  const alias = config.zoneAliases && config.zoneAliases[String(zone)];
  return alias || `Zone ${zone}`;
}

function percent(value) {
  if (value == null) return null;
  return value >= 0 && value <= 1 ? value * 100 : value;
}

async function buildDashboard(rangeName, selectedZone) {
  const latest = await get(latestSql);
  if (!latest) {
    return { generatedAt: Date.now(), timezone: config.timezone, range: rangeName, selectedZone, freshness: freshness(null), latest: null, zones: [], history: [], zoneHistory: [] };
  }
  const zoneRows = await all('SELECT * FROM zone_readings WHERE post_id = ? ORDER BY zone LIMIT 64', [latest.id]);
  const range = ranges[rangeName];
  const to = latest.received_at_ms;
  const from = to - range.ms;
  const zoneParam = selectedZone === 'all' ? null : Number(selectedZone);
  const [history, zoneHistory] = await Promise.all([
    all(historySql, [from, range.bucketMs, from, to]),
    all(zoneHistorySql, [from, range.bucketMs, from, to, zoneParam, zoneParam])
  ]);
  const zones = zoneRows.map((z) => ({
    zone: z.zone, name: zoneName(z.zone), enabled: bool(z.enabled), rawA: z.raw_a, rawB: z.raw_b,
    wetnessA: percent(z.wetness_a), wetnessB: percent(z.wetness_b),
    wetness: percent(z.wetness), threshold: percent(z.threshold),
    requested: bool(z.requested), cooldownBlocked: bool(z.cooldown_blocked), watering: bool(z.watering),
    hasBeenWatered: bool(z.has_been_watered),
    lastWateredAgeSeconds: z.has_been_watered && z.last_watered_s != null ? Math.max(0, latest.clock_s - z.last_watered_s) : null,
    closeInSeconds: z.close_deadline_s > latest.clock_s ? z.close_deadline_s - latest.clock_s : null,
    status: z.status
  }));
  return {
    generatedAt: Date.now(), timezone: config.timezone, range: rangeName, selectedZone,
    rangeFrom: from, rangeTo: to,
    expectedIntervalMinutes: config.expectedIntervalMinutes,
    freshness: freshness(latest.received_at_ms),
    latest: {
      receivedAt: latest.received_at_ms,
      nextHumidityInSeconds: Math.max(0,
        (latest.next_humidity_s > latest.clock_s
          ? latest.next_humidity_s - latest.clock_s
          : expectedMs / 1000) - Math.max(0, Date.now() - latest.received_at_ms) / 1000),
      battery: {
        valid: bool(latest.battery_valid), voltageV: latest.voltage_v, socPercent: latest.soc_percent,
        statusRaw: latest.status_raw, stageRaw: latest.stage_raw, chargeCurrentA: latest.charge_current_a,
        solarVoltageV: latest.solar_voltage_v, solarCurrentA: latest.solar_current_a,
        solarPowerW: latest.solar_power_w, loadState: bool(latest.load_state_raw),
        loadCurrentA: latest.load_current_a, loadPowerW: latest.load_power_w,
        usbState: bool(latest.usb_state_raw), usbVoltageV: latest.usb_voltage_v,
        internalTemperatureC: latest.internal_temperature_c, ambientTemperatureC: latest.ambient_temperature_c,
        temperatureStateRaw: latest.temperature_state_raw
      },
      weather: { valid: bool(latest.weather_valid), temperatureC: latest.weather_temperature_c, weatherCode: latest.weather_code, isDay: bool(latest.is_day) }
    },
    zones, history, zoneHistory
  };
}

const cache = new Map();
function putCache(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 32) cache.delete(cache.keys().next().value);
}

const rate = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = rate.get(ip);
  if (!entry || now - entry.since > 300_000) {
    rate.set(ip, { since: now, count: 1 });
    if (rate.size > 1000) for (const [key, value] of rate) if (now - value.since > 300_000) rate.delete(key);
    return false;
  }
  entry.count += 1;
  return entry.count > 120;
}

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

async function getAccessKeys() {
  const now = Date.now();
  if (accessKeys.keys.length && accessKeys.expiresAt > now) return accessKeys.keys;
  const response = await fetch(ACCESS_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Access key fetch failed (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload.keys) || !payload.keys.length) throw new Error('Access key response was empty');
  accessKeys = { keys: payload.keys, expiresAt: now + 60 * 60_000 };
  return accessKeys.keys;
}

async function authenticateAdmin(req) {
  if (!accessConfigured) return { status: 503, error: 'Admin authentication is not configured' };
  const token = String(req.headers['cf-access-jwt-assertion'] || '');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return { status: 401, error: 'Authentication required' };
  let header;
  let claims;
  try {
    header = decodeJwtPart(parts[0]);
    claims = decodeJwtPart(parts[1]);
  } catch {
    return { status: 401, error: 'Invalid authentication token' };
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { status: 401, error: 'Invalid authentication token' };
  try {
    const jwk = (await getAccessKeys()).find((key) => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk) return { status: 401, error: 'Unknown authentication key' };
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!valid) return { status: 401, error: 'Invalid authentication signature' };
  } catch (error) {
    console.error('Access token validation failed:', error.message);
    return { status: 503, error: 'Authentication temporarily unavailable' };
  }
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ACCESS_ISSUER || !audiences.includes(ACCESS_AUD) || !Number.isFinite(claims.exp) || claims.exp <= now || (Number.isFinite(claims.nbf) && claims.nbf > now + 30)) {
    return { status: 401, error: 'Expired or invalid authentication token' };
  }
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || email !== ADMIN_EMAIL) return { status: 403, error: 'Account is not authorized' };
  return { status: 200, identity: { email } };
}

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

async function apiDashboard(req, res, url) {
  const rangeName = url.searchParams.get('range') || config.defaultRange || '30d';
  const selectedZone = url.searchParams.get('zone') || 'all';
  if (!ranges[rangeName] || !(selectedZone === 'all' || /^[1-9][0-9]{0,2}$/.test(selectedZone))) {
    return json(res, 400, { error: 'Invalid range or zone' }, { 'Cache-Control': 'no-store' });
  }
  const version = await latestVersion();
  const marker = version ? `${version.id}-${version.received_at_ms}-${version.row_count}` : 'empty';
  const key = `${CACHE_VERSION}:${rangeName}:${selectedZone}:${marker}`;
  const etag = `"${crypto.createHash('sha256').update(key + JSON.stringify(config)).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=60' });
    return res.end();
  }
  let payload = cache.get(key);
  if (!payload) {
    payload = await buildDashboard(rangeName, selectedZone);
    putCache(key, payload);
  }
  return json(res, 200, payload, { ETag: etag, 'Cache-Control': 'public, max-age=300, stale-while-revalidate=60' });
}

function apiLogs(res) {
  let contents = '';
  try { contents = fs.readFileSync(LOG_PATH, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const logs = contents.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !Number.isSafeInteger(entry.clock_ms) || entry.clock_ms < 0 ||
          (entry.timestamp_ms !== null && (!Number.isSafeInteger(entry.timestamp_ms) || entry.timestamp_ms < 0)) ||
          typeof entry.message !== 'string') return [];
      return [{ clock_ms: entry.clock_ms, timestamp_ms: entry.timestamp_ms, message: entry.message }];
    } catch (_) { return []; }
  });
  return json(res, 200, { logs }, { 'Cache-Control': 'no-store' });
}

async function readManagement() {
  return withManagementLock(async () => {
    const [configBytes, commandsBytes, firmwareBytes, firmwareStat] = await Promise.all([
      fs.promises.readFile(RUNTIME_CONFIG_PATH), fs.promises.readFile(COMMANDS_PATH),
      fs.promises.readFile(FIRMWARE_PATH), fs.promises.stat(FIRMWARE_PATH)
    ]);
    const runtimeConfig = validateRuntimeConfig(JSON.parse(configBytes.toString('utf8')));
    const commands = validateCommands(JSON.parse(commandsBytes.toString('utf8')));
    let managementState = {};
    try { managementState = JSON.parse(await fs.promises.readFile(MANAGEMENT_STATE_PATH, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const configHash = sha256(configBytes);
    const baseline = managementState.config?.snapshot || runtimeConfig;
    return {
      dashboardConfig: config,
      config: runtimeConfig,
      changedConfigPaths: changedPaths(runtimeConfig, baseline),
      delivery: {
        configSha256: managementState.config?.sha256 || configHash,
        configServedAt: managementState.config?.served_at || null,
        configCurrent: !managementState.config || managementState.config.sha256 === configHash,
        firmwareMd5: managementState.firmware?.md5 || null,
        firmwareServedAt: managementState.firmware?.served_at || null,
        firmwareCurrent: !managementState.firmware || managementState.firmware.md5 === md5(firmwareBytes)
      },
      commands,
      firmware: { size: firmwareBytes.length, md5: md5(firmwareBytes), modifiedAt: firmwareStat.mtime.toISOString() },
      revisions: { config: `"${configHash}"`, commands: queueRevision(commands), firmware: `"${md5(firmwareBytes)}"`, dashboardConfig: `"${sha256(Buffer.from(JSON.stringify(config)))}"` }
    };
  });
}

function requireRevision(req, actual) {
  if (req.headers['if-match'] !== actual) throw Object.assign(new Error('Management data changed; refresh and try again'), { statusCode: 409 });
}

async function apiManagement(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/admin/api/management') {
    return json(res, 200, await readManagement(), { 'Cache-Control': 'no-store' });
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return json(res, 403, { error: 'Cross-site write denied' }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT' && url.pathname === '/admin/api/management/config') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
    const next = validateRuntimeConfig(JSON.parse((await receiveBody(req, ADMIN_JSON_LIMIT)).toString('utf8')));
    const result = await withManagementLock(async () => {
      const previousBytes = await fs.promises.readFile(RUNTIME_CONFIG_PATH);
      requireRevision(req, `"${sha256(previousBytes)}"`);
      let managementState = {}; try { managementState = JSON.parse(await fs.promises.readFile(MANAGEMENT_STATE_PATH, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let stateChanged = false;
      if (!managementState.config) {
        managementState.config = { sha256: sha256(previousBytes), served_at: null, snapshot: JSON.parse(previousBytes.toString('utf8')), bytes_base64: previousBytes.toString('base64') }; stateChanged = true;
      } else if (managementState.config.sha256 === sha256(previousBytes) && !managementState.config.bytes_base64) {
        managementState.config.bytes_base64 = previousBytes.toString('base64'); stateChanged = true;
      }
      if (stateChanged) await atomicWrite(MANAGEMENT_STATE_PATH, `${JSON.stringify(managementState, null, 2)}\n`);
      const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
      await atomicWrite(RUNTIME_CONFIG_PATH, bytes);
      return { sha256: sha256(bytes), revision: `"${sha256(bytes)}"` };
    });
    return json(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'DELETE' && url.pathname === '/admin/api/management/config/pending') {
    const result = await withManagementLock(async () => {
      const currentBytes = await fs.promises.readFile(RUNTIME_CONFIG_PATH); requireRevision(req, `"${sha256(currentBytes)}"`);
      let managementState; try { managementState = JSON.parse(await fs.promises.readFile(MANAGEMENT_STATE_PATH, 'utf8')); } catch { managementState = {}; }
      if (!managementState.config?.snapshot) throw Object.assign(new Error('No delivered configuration is available to restore'), { statusCode: 409 });
      const restored = validateRuntimeConfig(managementState.config.snapshot); const hasExactBytes = Boolean(managementState.config.bytes_base64);
      const bytes = hasExactBytes ? Buffer.from(managementState.config.bytes_base64, 'base64') : Buffer.from(`${JSON.stringify(restored, null, 2)}\n`);
      if (hasExactBytes && sha256(bytes) !== managementState.config.sha256) throw Object.assign(new Error('The delivered configuration backup is invalid'), { statusCode: 409 });
      if (!hasExactBytes) {
        managementState.config.sha256 = sha256(bytes); managementState.config.bytes_base64 = bytes.toString('base64');
        await atomicWrite(MANAGEMENT_STATE_PATH, `${JSON.stringify(managementState, null, 2)}\n`);
      }
      await atomicWrite(RUNTIME_CONFIG_PATH, bytes);
      return { sha256: sha256(bytes), revision: `"${sha256(bytes)}"` };
    });
    return json(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT' && url.pathname === '/admin/api/management/dashboard-config') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
    requireRevision(req, `"${sha256(Buffer.from(JSON.stringify(config)))}"`);
    const next = validateDashboardConfig(JSON.parse((await receiveBody(req, ADMIN_JSON_LIMIT)).toString('utf8')));
    await withManagementLock(() => atomicWrite(DASHBOARD_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`));
    config = next; expectedMs = Number(config.expectedIntervalMinutes) * 60_000; cache.clear();
    return json(res, 200, { ok: true, config, revision: `"${sha256(Buffer.from(JSON.stringify(config)))}"` }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/management/commands') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
    const command = JSON.parse((await receiveBody(req, ADMIN_JSON_LIMIT)).toString('utf8'));
    validateCommands([command]); command.name = command.name.trim();
    const result = await withManagementLock(async () => {
      const commands = validateCommands(JSON.parse(await fs.promises.readFile(COMMANDS_PATH, 'utf8')));
      requireRevision(req, queueRevision(commands));
      if (commands.length >= MAX_COMMANDS) throw Object.assign(new Error('The command queue is full'), { statusCode: 400 });
      commands.push(command); await atomicWrite(COMMANDS_PATH, `${JSON.stringify(commands, null, 2)}\n`);
      return { commands, revision: queueRevision(commands) };
    });
    return json(res, 200, result, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'DELETE' && url.pathname === '/admin/api/management/commands') {
    const result = await withManagementLock(async () => {
      const commands = validateCommands(JSON.parse(await fs.promises.readFile(COMMANDS_PATH, 'utf8'))); requireRevision(req, queueRevision(commands));
      const empty = []; await atomicWrite(COMMANDS_PATH, '[]\n'); return { commands: empty, revision: queueRevision(empty) };
    });
    return json(res, 200, result, { 'Cache-Control': 'no-store' });
  }
  const deleteMatch = url.pathname.match(/^\/admin\/api\/management\/commands\/(\d+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const result = await withManagementLock(async () => {
      const commands = validateCommands(JSON.parse(await fs.promises.readFile(COMMANDS_PATH, 'utf8')));
      requireRevision(req, queueRevision(commands));
      const index = Number(deleteMatch[1]);
      if (index >= commands.length) throw Object.assign(new Error('Command no longer exists'), { statusCode: 409 });
      commands.splice(index, 1); await atomicWrite(COMMANDS_PATH, `${JSON.stringify(commands, null, 2)}\n`);
      return { commands, revision: queueRevision(commands) };
    });
    return json(res, 200, result, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT' && url.pathname === '/admin/api/management/commands/reorder') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
    const move = JSON.parse((await receiveBody(req, ADMIN_JSON_LIMIT)).toString('utf8'));
    const result = await withManagementLock(async () => {
      const commands = validateCommands(JSON.parse(await fs.promises.readFile(COMMANDS_PATH, 'utf8')));
      requireRevision(req, queueRevision(commands));
      if (!Number.isInteger(move.from) || !Number.isInteger(move.to) || move.from < 0 || move.to < 0 || move.from >= commands.length || move.to >= commands.length) throw Object.assign(new Error('Invalid queue position'), { statusCode: 400 });
      const [command] = commands.splice(move.from, 1); commands.splice(move.to, 0, command);
      await atomicWrite(COMMANDS_PATH, `${JSON.stringify(commands, null, 2)}\n`);
      return { commands, revision: queueRevision(commands) };
    });
    return json(res, 200, result, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'PUT' && url.pathname === '/admin/api/management/firmware') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/octet-stream')) throw Object.assign(new Error('Content-Type must be application/octet-stream'), { statusCode: 415 });
    const bytes = await receiveBody(req, MAX_FIRMWARE_BYTES);
    if (bytes[0] !== 0xE9) throw Object.assign(new Error('This is not an ESP application image'), { statusCode: 400 });
    const result = await withManagementLock(async () => {
      const current = await fs.promises.readFile(FIRMWARE_PATH); requireRevision(req, `"${md5(current)}"`);
      let managementState = {}; try { managementState = JSON.parse(await fs.promises.readFile(MANAGEMENT_STATE_PATH, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!managementState.firmware) {
        managementState.firmware = { md5: md5(current), size: current.length, served_at: null };
        await atomicWrite(MANAGEMENT_STATE_PATH, `${JSON.stringify(managementState, null, 2)}\n`);
      }
      if (md5(current) === managementState.firmware.md5) await atomicWrite(FIRMWARE_ROLLBACK_PATH, current);
      await atomicWrite(FIRMWARE_PATH, bytes);
      return { size: bytes.length, md5: md5(bytes), revision: `"${md5(bytes)}"` };
    });
    return json(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'DELETE' && url.pathname === '/admin/api/management/firmware/pending') {
    const result = await withManagementLock(async () => {
      const current = await fs.promises.readFile(FIRMWARE_PATH); requireRevision(req, `"${md5(current)}"`);
      let managementState; try { managementState = JSON.parse(await fs.promises.readFile(MANAGEMENT_STATE_PATH, 'utf8')); } catch { managementState = {}; }
      if (!managementState.firmware || md5(current) === managementState.firmware.md5) throw Object.assign(new Error('No firmware change is pending'), { statusCode: 409 });
      const rollback = await fs.promises.readFile(FIRMWARE_ROLLBACK_PATH);
      if (md5(rollback) !== managementState.firmware.md5) throw Object.assign(new Error('The delivered firmware rollback image is unavailable'), { statusCode: 409 });
      await atomicWrite(FIRMWARE_PATH, rollback); return { size: rollback.length, md5: md5(rollback), revision: `"${md5(rollback)}"` };
    });
    return json(res, 200, { ok: true, ...result }, { 'Cache-Control': 'no-store' });
  }
  return json(res, 404, { error: 'Admin endpoint not found' }, { 'Cache-Control': 'no-store' });
}

async function apiServerAdmin(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/admin/api/server/database') {
    const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) throw Object.assign(new Error('Invalid database cursor'), { statusCode: 400 });
    const entries = await all(`SELECT p.id,p.received_at_ms,p.clock_s,p.next_humidity_s,b.soc_percent,w.temperature_c,(SELECT count(*) FROM zone_readings z WHERE z.post_id=p.id) zone_count FROM telemetry_posts p LEFT JOIN battery_readings b ON b.post_id=p.id LEFT JOIN weather_readings w ON w.post_id=p.id WHERE p.id < ? ORDER BY p.id DESC LIMIT 50`, [before]);
    const count = await get('SELECT count(*) count FROM telemetry_posts');
    return json(res, 200, { entries, count: count.count, nextBefore: entries.length === 50 ? entries.at(-1).id : null }, { 'Cache-Control': 'no-store' });
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') throw Object.assign(new Error('Cross-site write denied'), { statusCode: 403 });
  if (req.method === 'DELETE' && url.pathname === '/admin/api/server/logs') {
    confirmation(req, 'CLEAR LOGS');
    const backupName = await withAdminBackupQueue(async () => {
      await fs.promises.mkdir(ADMIN_BACKUP_DIR, { recursive: true, mode: 0o700 });
      await maintainAdminBackups();
      const name = `log-before-clear-${timestampForFile()}.txt`; const backupPath = path.join(ADMIN_BACKUP_DIR, name);
      await fs.promises.rename(LOG_PATH, backupPath); await fs.promises.chmod(backupPath, 0o600);
      try {
        const freshLog = await fs.promises.open(LOG_PATH, 'ax', 0o640); await freshLog.close(); await fs.promises.chmod(LOG_PATH, 0o640);
      } catch (error) {
        await fs.promises.unlink(LOG_PATH).catch((unlinkError) => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
        await fs.promises.rename(backupPath, LOG_PATH).catch(() => undefined);
        throw error;
      }
      await maintainAdminBackups(new Set([name]));
      return name;
    });
    return json(res, 200, { ok: true, backup: backupName }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'DELETE' && url.pathname === '/admin/api/server/database') {
    confirmation(req, 'CLEAR DATABASE');
    const backupName = await withAdminBackupQueue(async () => {
      await fs.promises.mkdir(ADMIN_BACKUP_DIR, { recursive: true, mode: 0o700 });
      await maintainAdminBackups();
      const name = `database-before-clear-${timestampForFile()}.sqlite3`; const backupPath = path.join(ADMIN_BACKUP_DIR, name);
      await backupDatabase(backupPath); await fs.promises.chmod(backupPath, 0o600);
      await dbExec('BEGIN IMMEDIATE');
      try { await dbRun('DELETE FROM telemetry_posts'); await dbRun("DELETE FROM sqlite_sequence WHERE name='telemetry_posts'"); await dbExec('COMMIT'); }
      catch (error) { await dbExec('ROLLBACK').catch(() => undefined); throw error; }
      cache.clear(); await maintainAdminBackups(new Set([name]));
      return name;
    });
    return json(res, 200, { ok: true, backup: backupName }, { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/server/database/entries') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Content-Type must be application/json'), { statusCode: 415 });
    const id = await insertManualTelemetry(JSON.parse((await receiveBody(req, ADMIN_JSON_LIMIT)).toString('utf8')));
    return json(res, 201, { ok: true, id }, { 'Cache-Control': 'no-store' });
  }
  const match = url.pathname.match(/^\/admin\/api\/server\/database\/entries\/(\d+)$/);
  if (req.method === 'DELETE' && match) {
    confirmation(req, 'DELETE ENTRY'); const id = Number(match[1]);
    const backupName = await withAdminBackupQueue(async () => {
      const post = await get('SELECT * FROM telemetry_posts WHERE id=?', [id]); if (!post) throw Object.assign(new Error('Database entry not found'), { statusCode: 404 });
      const [battery, weather, zones] = await Promise.all([get('SELECT * FROM battery_readings WHERE post_id=?', [id]), get('SELECT * FROM weather_readings WHERE post_id=?', [id]), all('SELECT * FROM zone_readings WHERE post_id=? ORDER BY zone', [id])]);
      await fs.promises.mkdir(ADMIN_BACKUP_DIR, { recursive: true, mode: 0o700 }); await maintainAdminBackups();
      const name = `entry-${id}-before-delete-${timestampForFile()}.json`;
      await atomicWrite(path.join(ADMIN_BACKUP_DIR, name), `${JSON.stringify({ post, battery, weather, zones }, null, 2)}\n`);
      await dbRun('DELETE FROM telemetry_posts WHERE id=?', [id]); cache.clear();
      await maintainAdminBackups(new Set([name]));
      return name;
    });
    return json(res, 200, { ok: true, backup: backupName }, { 'Cache-Control': 'no-store' });
  }
  return json(res, 404, { error: 'Admin endpoint not found' }, { 'Cache-Control': 'no-store' });
}

function serveStatic(req, res, pathname) {
  const item = staticFiles[pathname];
  if (!item) return false;
  const body = fs.readFileSync(path.join(PUBLIC, item[0]));
  res.writeHead(200, { 'Content-Type': item[1], 'Content-Length': body.length, 'Cache-Control': item[2] });
  if (req.method === 'HEAD') res.end(); else res.end(body);
  return true;
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  if ((req.url || '').length > 2048) return json(res, 414, { error: 'Request too long' }, { 'Cache-Control': 'no-store' });
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown').slice(0, 80);
  if (rateLimited(ip)) return json(res, 429, { error: 'Too many requests' }, { 'Retry-After': '300', 'Cache-Control': 'no-store' });
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const auth = await authenticateAdmin(req);
      if (auth.status !== 200) return json(res, auth.status, { error: auth.error }, { 'Cache-Control': 'no-store' });
      if (url.pathname === '/admin/api/session') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET', 'Cache-Control': 'no-store' });
        return json(res, 200, { authenticated: true, email: auth.identity.email }, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/admin/api/management' || url.pathname.startsWith('/admin/api/management/')) {
        return await apiManagement(req, res, url);
      }
      if (url.pathname === '/admin/api/server' || url.pathname.startsWith('/admin/api/server/')) {
        return await apiServerAdmin(req, res, url);
      }
      if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin/index.html') {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
        const body = fs.readFileSync(path.join(PUBLIC, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') res.end(); else res.end(body);
        return;
      }
      return json(res, 404, { error: 'Admin endpoint not found' }, { 'Cache-Control': 'no-store' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    if (url.pathname === '/api/v1/dashboard') return await apiDashboard(req, res, url);
    if (url.pathname === '/api/v1/logs') return apiLogs(res);
    if (url.pathname === '/healthz') {
      const version = await latestVersion();
      return json(res, 200, { status: 'ok', telemetryAgeMs: version ? Math.max(0, Date.now() - version.received_at_ms) : null }, { 'Cache-Control': 'no-store' });
    }
    if (serveStatic(req, res, url.pathname)) return;
    return json(res, 404, { error: 'Not found' }, { 'Cache-Control': 'no-store' });
  } catch (error) {
    console.error('Request failed:', error.message);
    const status = error.statusCode || (error instanceof SyntaxError ? 400 : 503);
    return json(res, status, { error: status === 503 ? 'Management temporarily unavailable' : error.message }, { 'Cache-Control': 'no-store' });
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.listen(PORT, HOST, () => {
  console.log(`Irrigation dashboard listening on http://${HOST}:${PORT}`);
  withAdminBackupQueue(() => maintainAdminBackups()).then((result) => {
    if (result.deleted) console.log(`Admin backup retention removed ${result.deleted} expired artifact(s)`);
  });
});

function shutdown() {
  server.close(() => db.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
