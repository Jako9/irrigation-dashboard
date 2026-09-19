# Dashboard security review

## Origin changes

`security-headers.js` retains the existing enforced CSP, Referrer-Policy,
nosniff, framing protection, and Permissions-Policy. No CORS allowance was added.
The candidate policy is delivered as `Content-Security-Policy-Report-Only`:
default deny, same-origin scripts/styles/fonts/connections, same-origin and data
images, explicit object/base/framing denial, same-origin form submissions, and
no workers or manifests. Neither policy allows unsafe-inline or unsafe-eval.

All HTML scripts, styles, chart assets, and images are local. Amazon prices are
retrieved by the server, not the browser. External PayPal, Amazon, GitHub, and
Thingiverse links are ordinary navigations. The client has no WebSocket,
EventSource, worker, frame, external font, or popup authentication implementation.
Forms use JavaScript and same-origin APIs. Chart and slider scripts assign style
properties; validate their behavior in a browser before enforcing the candidate.
Report-only violations are visible in browser Console; no collector or new
public ingestion endpoint is provided. Promotion remains pending authenticated
browser validation, including the externally managed Access login flow.

COOP `same-origin` isolates the browsing context from cross-origin openers.
CORP `same-origin` prevents other origins from loading dashboard responses as
no-CORS subresources. The application has no popup/opener dependency or intended
cross-origin asset sharing, and embedding was already denied. COEP is omitted:
the dashboard uses no SharedArrayBuffer or other cross-origin isolation feature,
so its additional external-resource constraints have no demonstrated benefit.
See [MDN COEP guidance](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy).

HTTPS redirects and staged HSTS belong at the public edge. The origin remains
loopback HTTP behind the tunnel. It does not infer HTTPS from untrusted forwarded
headers or redirect the tunnel's HTTP connection. Public same-origin API URLs
inherit HTTPS once the page is opened over HTTPS. No cookies were added; scanner
cookie absence does not establish Access session security.

## Verification on 19 September 2026

- Before deployment: HTTP `/build/?security_probe=1` served application HTML
  with 200; HTTPS `/` returned 200 without HSTS. Enforced CSP used default-src
  self and lacked form-action.
- OpenSSL from the Pi reproduced edge TLS 1.0/1.1 acceptance and TLS 1.2 CBC
  (`ECDHE-ECDSA-AES128-SHA`). TLS 1.2 ChaCha20 and TLS 1.3 AES-GCM also succeeded.
- Six tests passed on local Node 24.19.0 and Pi Node 18.20.4. Real HTTP fixture
  tests verify headers on 200, 301, 400, 403, 404, 405, 429, and 503 responses,
  with no CORS opening or premature HSTS.
- Local and deployed SHA-256 hashes of server.js and security-headers.js matched.
- Public HTTPS `/`, `/about/`, `/build/`, dashboard API, logs API, and `/healthz`
  returned 200 with both CSP policies, COOP, and CORP. A missing route returned
  the application JSON 404 with the same policies. HTTP `/` and nested build
  query still returned 200; HSTS still absent, as expected pending edge changes.
- No physical control operations were performed. Browser/chart interaction and
  authenticated administration have not been verified; the trial is not enforced.
- Application HTML was verified on all three public pages, without a challenge
  body. Their referenced assets loaded successfully: seven on the dashboard,
  twelve on About, and six on Build. A cross-origin OPTIONS request to the
  dashboard API returned 405 without Access-Control-Allow-Origin, retaining
  the security policies.
- MDN scan returned C+/60, 10/12 passed; Security Headers automation was blocked
  by its own challenge; SSL Labs was started. Its first completed IPv6 endpoint
  (`2606:4700:3032:0:0:0:6815:563c`) received B; the other three endpoints were
  still processing or pending at the final check. Final edge scans remain pending.

## Deployment and rollback

The original deployed checkout was clean at commit
`886a8498a288a917d1893a11fe47ab8d4edf6570`. The existing server was backed up with
metadata preserved at
`/home/jako9/src/irrigation-dashboard/server.js.security-backup-20260919`.
The new module and its test were transferred before the updated server.
Only `irrigation-dashboard` was restarted. The dashboard, Pi-hole, nginx,
MariaDB, Redis, SSH, and Cloudflare Tunnel remained active. No packages,
databases, management files, shared services, or network configuration changed;
no reboot occurred. The deployed checkout contains these uncommitted changes.

To roll back this deployment, restore the backup over server.js with `cp -p`,
run `node --check server.js`, restart only `irrigation-dashboard`, and verify
`http://127.0.0.1:8071/healthz` and the public HTTPS endpoint. The unused module
and test may remain; they contain no data. Keep the backup until verification
completes. For future Git deployments, commit the server, new module, and test
together; deploying server.js alone would prevent startup.

Edge steps, staged HSTS, provider limitations, and final scanner instructions
are recorded in the workspace's `cloudflare.md`.

## Edge retest update — 19 September 2026

Minimum TLS 1.2 and initial HSTS `max-age=300` now pass externally. HSTS is
present once on representative pages, APIs, errors, and the Access redirect.
The HTTP redirect rule returns 308 but its Location is the literal Cloudflare
expression, producing an infinite redirect loop; it does not yet meet HTTPS
enforcement acceptance. Observatory improved to B/70 (scan 121920953). See
`cloudflare.md` for exact evidence and correction.

Final retest at approximately 02:06 CEST confirmed the redirect correction.
Representative root, nested, query-bearing API, health, missing, and admin paths
return 308 to the exact HTTPS path and query. Following a nested redirect reaches
the application without a loop. Observatory now reports A+/125 (scan 121921304),
and SSL Labs reports A without warnings on all four edge addresses. Initial HSTS
and minimum TLS remain correct. Interactive browser/CSP checks, timed HSTS
increases, and the challenge-protected Security Headers scan remain outstanding.
