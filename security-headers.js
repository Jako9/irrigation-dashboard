'use strict';

const ENFORCED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const TRIAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'none'; worker-src 'none'";

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', ENFORCED_CSP);
  // Keep this report-only until browser and authenticated UI validation completes.
  res.setHeader('Content-Security-Policy-Report-Only', TRIAL_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

module.exports = { securityHeaders, ENFORCED_CSP, TRIAL_CSP };
