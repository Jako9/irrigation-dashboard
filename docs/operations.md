# Operations guide

This guide describes a generic Linux deployment. Substitute a dedicated local
service account and persistent paths appropriate for the host. Do not copy real
credentials, addresses, or private telemetry into the repository.

## Install

1. Install Node.js 20.17 or newer.
2. Place the repository at `/opt/irrigation-dashboard`.
3. Run `npm ci --omit=dev` in that directory.
4. Copy `config.example.json` to `config.json` and adjust display-only values.
5. Create `/etc/irrigation-dashboard.env` from `access.env.example` when the
   admin area will be enabled; restrict it to the service account.
6. Adapt and install `deploy/systemd/irrigation-dashboard.service`.

The service needs read access to the irrigation SQLite database and log. Admin
features additionally need narrowly scoped write access to the management and
backup directories. Avoid broad recursive permission changes on shared data.

## Validate and start

```bash
cd /opt/irrigation-dashboard
npm run check
sudo systemd-analyze verify /etc/systemd/system/irrigation-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now irrigation-dashboard.service
```

Verify the listener and public routes:

```bash
systemctl is-enabled irrigation-dashboard.service
systemctl is-active irrigation-dashboard.service
curl --fail http://127.0.0.1:8071/healthz
curl --fail 'http://127.0.0.1:8071/api/v1/dashboard?range=7d&zone=all'
```

Expected behavior:

- The dashboard binds only to its configured interface and port.
- Public API responses omit raw payloads, source addresses, credentials, and
  filesystem paths.
- `/admin/` fails closed when Access configuration is missing or invalid.
- New server telemetry becomes visible without restarting the dashboard.

## Configuration changes

`config.json` is read at startup. After editing it, syntax-check the application
and restart only the dashboard service. Static files do not require a restart.

The admin area writes controller configuration, command, firmware, and state
files atomically. Database and log deletion operations first create private,
bounded recovery artifacts. Ensure the backup directory remains on persistent
storage and is excluded from Git and public file serving.

## Troubleshooting

Check the service, storage, and loopback endpoint before inspecting external
proxy or tunnel configuration:

```bash
systemctl status irrigation-dashboard.service --no-pager
journalctl -u irrigation-dashboard.service --no-pager -n 100
curl -v http://127.0.0.1:8071/healthz
```

Do not reboot the host or restart unrelated services merely to diagnose this
application. Back up an existing target file before deployment replacement and
verify the replacement before restarting only this service.
