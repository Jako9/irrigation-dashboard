const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf('function validateRuntimeConfig(');
const end = source.indexOf('function validateDashboardConfig(', start);
const validate = vm.runInNewContext(source.slice(start, end) + '\nvalidateRuntimeConfig', {
  isObject: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
});
const fixture = () => ({
  schema_version: 1, humidity_interval_s: 3600, sensor_samples: 5,
  sensor_sample_delay_ms: 50, mux_settle_ms: 5, valve_open_pulse_ms: 20000,
  valve_close_pulse_ms: 25000, watering_cooldown_s: 18000, load_startup_wait_ms: 5000,
  wifi_timeout_ms: 15000, http_timeout_ms: 10000, time_sync_timeout_ms: 5000,
  sensor_valid_raw_min: 500, sensor_valid_raw_max: 3000, minimum_battery_soc_percent: 25,
  timezone: 'UTC0', ntp_server: 'pool.ntp.org', weather: { latitude: 0, longitude: 0 },
  zones: Array.from({ length: 5 }, (_, i) => ({ zone: i + 1,
    sensor_a_channel: 0, sensor_b_channel: 1, valve_open_channel: 0, valve_close_channel: 1,
    sensor_a: { wet_raw: 500, dry_raw: 2200 }, sensor_b: { wet_raw: 500, dry_raw: 2200 },
    watering_threshold: 0.2, enabled: false, watering_duration_s: 2400,
  })),
});
test('accepts old configuration and balance endpoints/intermediate values', () => {
  validate(fixture());
  for (const balance of [0, 0.5, 0.8, 1]) {
    const c = fixture(); c.zones.forEach(z => z.wetness_balance = balance);
    assert.equal(validate(c).zones[0].wetness_balance, balance);
  }
});
test('rejects malformed or out-of-range balances', () => {
  for (const balance of [-0.01, 1.01, null, '0.5', true, NaN, Infinity]) {
    const c = fixture(); c.zones[0].wetness_balance = balance;
    assert.throws(() => validate(c), /wetness_balance/);
  }
});
