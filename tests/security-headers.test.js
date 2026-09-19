'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { securityHeaders, ENFORCED_CSP, TRIAL_CSP } = require('../security-headers');

test('security policies survive success, redirect and error responses without opening CORS', async () => {
  const server = http.createServer((req, res) => {
    securityHeaders(res);
    res.writeHead(Number(req.url.slice(1)), { 'Content-Type': 'text/plain' });
    res.end('fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const status of [200, 301, 400, 403, 404, 405, 429, 503]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/${status}`, { redirect: 'manual' });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('content-security-policy'), ENFORCED_CSP);
      assert.equal(response.headers.get('content-security-policy-report-only'), TRIAL_CSP);
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('strict-transport-security'), null);
      await response.text();
    }
    for (const policy of [ENFORCED_CSP, TRIAL_CSP]) assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
