# Irrigation Dashboard

Browser dashboard for the
[Jako9 irrigation system](https://github.com/topics/jako9-irrigation). It shows
recent controller, battery, weather, and zone telemetry from SQLite. Its
separate admin area manages controller configuration, queued commands, OTA
firmware, logs, and telemetry retention.

Related repositories:

- [irrigation-firmware](https://github.com/Jako9/irrigation-firmware) measures
  the system and operates the valves.
- [irrigation-server](https://github.com/Jako9/irrigation-server) receives the
  firmware's HTTP requests and owns telemetry ingestion.

## How it works

The public dashboard is read-only. It queries the SQLite database created by
the irrigation server, groups history into bounded time buckets, and serves a
small JSON API plus local static assets. It does not expose raw telemetry
payloads or source addresses.

`/admin/` fails closed unless Cloudflare Access settings are present. The
application verifies the Access JWT signature, issuer, audience, expiry, and
exact administrator email before allowing management operations. Admin changes
are written atomically to the shared management directory; the irrigation
server subsequently delivers them to the ESP32.

```text
ESP32 firmware
    | authenticated telemetry/config/OTA HTTP
    v
Irrigation server ----> SQLite telemetry
    ^                         |
    | management files       | read/query
    +---------------- Irrigation dashboard
                              |
                              +--> authenticated /admin/ changes
```

## Repository layout

```text
.
|-- server.js                 HTTP API, authentication, and static server
|-- public/                   Browser UI and pinned local chart assets
|-- config.example.json       Safe display-configuration template
|-- access.env.example        Cloudflare Access template
|-- docs/operations.md        Deployment and operations guide
`-- deploy/systemd/           Generic Linux service unit
```

## Setup

### Requirements

- Node.js 18.20 or newer
- Either npm for a standalone installation or a compatible distribution
  package that provides the Node `sqlite3` module
- An irrigation-server SQLite database
- The server's management directory for admin functionality

Install the pinned dependency and create private configuration:

```bash
npm ci
cp config.example.json config.json
cp access.env.example access.env
```

On Debian-based systems, the distribution packages can be used instead of a
repository-local `node_modules` directory:

```bash
sudo apt install nodejs node-sqlite3
node -e "require('sqlite3')"
```

Choose one dependency method per host. When using the distribution module, do
not run `npm ci`; confirm that `require('sqlite3')` succeeds with the same Node
binary used by the service.

Edit `config.json`:

- `timezone`: IANA timezone used when displaying controller logs.
- `expectedIntervalMinutes`: normal interval between telemetry cycles.
- `defaultRange`: one of `24h`, `7d`, `30d`, `90d`, or `1y`.
- `zoneAliases`: optional display names keyed by numeric zone ID strings.

For a public read-only instance, leave `access.env` absent. The admin area will
return a service-unavailable response. To enable administration, create a
Cloudflare Access application and fill all three values in `access.env`.

Start locally with explicit paths:

```bash
export DASHBOARD_HOST='127.0.0.1'
export DASHBOARD_PORT='8071'
export IRRIGATION_DB='/var/lib/irrigation/irrigation.sqlite3'
export IRRIGATION_MANAGEMENT_DIR='/var/lib/irrigation/management'
export IRRIGATION_LOG='/var/lib/irrigation/irrigation.log'
npm start
```

Node does not automatically load `access.env` in this setup; systemd loads it through the
supplied `EnvironmentFile`. For a manual launch, export the three Access values
in the shell instead.

## Usage

Open `http://127.0.0.1:8071/` for the public dashboard. It loads on first open,
range or zone changes, and manual refresh; it does not continuously poll.

Public endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Dashboard UI |
| `GET` | `/api/v1/dashboard?range=7d&zone=all` | Aggregated telemetry |
| `GET` | `/api/v1/logs` | Sanitized controller logs |
| `GET` | `/healthz` | Process and telemetry freshness check |

The authenticated `/admin/` interface can update controller and display
configuration, queue commands, upload firmware, and remove selected logs or
telemetry. Destructive database operations create bounded private recovery
artifacts before deleting complete telemetry posts.

## Connection and startup order

1. Start the irrigation server with persistent data and management paths.
2. Confirm the firmware can post telemetry to it.
3. Start this dashboard with `IRRIGATION_DB` and
   `IRRIGATION_MANAGEMENT_DIR` pointing to the same locations.
4. Place the dashboard behind an authenticated reverse proxy or tunnel before
   enabling `/admin/` on an externally reachable deployment.

The dashboard must not write telemetry tables directly. The irrigation server
remains responsible for validation, ingestion, retention, and controller HTTP
responses.

## Deployment and checks

The unit under `deploy/systemd/` is a generic hardened template. Adapt its user
and paths, install the application under `/opt/irrigation-dashboard`, then
validate the unit before starting it. See [docs/operations.md](docs/operations.md)
for the complete checklist.

For a Git-based deployment, clone into a stable path and point
`WorkingDirectory` and `ExecStart` at that checkout. Keep the database,
management files, logs, firmware, backups, and Access EnvironmentFile outside
the checkout. If the checkout is below a home directory, use
`ProtectHome=read-only` (or another setting that permits reading the checkout)
instead of `ProtectHome=true`.

Adapt `User`, `Group`, `RequiresMountsFor`, `ReadWritePaths`, and the private
EnvironmentFile path before validating and enabling the unit. Enabling it makes
the dashboard start automatically after reboot:

```bash
sudo systemd-analyze verify /etc/systemd/system/irrigation-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now irrigation-dashboard.service
systemctl is-enabled irrigation-dashboard.service
systemctl is-active irrigation-dashboard.service
```

Start and verify the irrigation server before this dashboard. For updates,
pull only fast-forward changes, refresh dependencies only when manifests
changed, validate, and restart only the dashboard:

```bash
git pull --ff-only
# npm ci --omit=dev              # npm-managed installations only
node --check server.js
node --check public/app.js
sudo systemctl restart irrigation-dashboard.service
curl --fail http://127.0.0.1:8071/healthz
```

A pull does not reload the running Node process. For rollback, check out the
previously deployed commit, repeat the dependency and syntax checks, and
restart only this service. Preserve the former checkout and private
configuration until verification succeeds.

```bash
npm run check
curl --fail http://127.0.0.1:8071/healthz
```

## Repository safety

`access.env`, `config.json`, databases, logs, firmware, management state, and
backups are ignored. Keep real domains, email addresses, network addresses,
telemetry, and coordinates out of examples and documentation. Inspect staged
files with `git diff --cached` before publishing.
