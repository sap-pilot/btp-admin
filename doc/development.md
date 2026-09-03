# Development & Deployment

---

## Local Development

### Prerequisites

- Node.js 20+
- npm 9+

### Install & run

```bash
# Install dependencies (also installs Chromium for browser checks via postinstall)
npm install

# Copy sample config and fill in real values
cp sample/config.json server/config.json

# Start both Vite dev server and Express concurrently
npm run dev
```

Open http://localhost:3000/

> **`PLAYWRIGHT_BROWSERS_PATH`**: `npm install` installs Chromium into `server/pw-browsers/` via the `postinstall` hook. `npm run dev` and `npm start` set `PLAYWRIGHT_BROWSERS_PATH=./pw-browsers` automatically. If you start the server directly outside an npm script, set the variable in your shell first:
> ```bash
> export PLAYWRIGHT_BROWSERS_PATH=$(pwd)/server/pw-browsers
> ```

### Iterating on frontend and backend separately

```bash
# Terminal 1 — Express with auto-restart on server file changes
npm run dev:server

# Terminal 2 — Vite rebuild on every client file change
npm run watch:client
```

### Available scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run Vite dev server + Express concurrently |
| `npm run dev:client` | Vite dev server only (default :5173) |
| `npm run dev:server` | Express with nodemon/tsx (default :3000) |
| `npm run watch:client` | Vite rebuild on file change (no dev server) |
| `npm run build` | Build MTA archive (`mbt build -p=cf`) |
| `npm run build:client` | Build React → `server/public/` |
| `npm run build:server` | Compile server TypeScript |
| `npm run start` | Run built Express (production mode) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run typecheck` | TypeScript type check (client + server) |
| `npm test` | Run tests |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port (Cloud Foundry sets this automatically) |
| `CONFIG_JSON` | — | Full config as a JSON string; takes priority over `CONFIG_FILE` |
| `CONFIG_FILE` | `./config.json` | Path to config JSON file (relative to `server/` working dir) |
| `LOCAL_STORE_DIR` | `./localStore` | Root for local file storage: `resp/`, `conf/`, `dest/`, `rcs/`, `users/` |
| `CF_USERNAME` | — | SAP BTP user email for CF API login and account discovery |
| `CF_PASSWORD` | — | SAP BTP user password |
| `SYNC_REMOTE` | — | Base URL of the producer BTP Status instance for remote sync |
| `SELF_URL` | auto | Base URL of this consumer instance for webhook registration. Auto-detected from `VCAP_APPLICATION.application_uris[0]` on CF. |
| `SYNC_REMOTE_BATCH_SIZE` | `200` | Files requested per batch-download call during sync |
| `SYNC_INTERVAL` | `300` | Fallback sync interval in seconds. If no webhook-triggered download completes within this window, the consumer fires a delta sync. Set to `0` to disable. |
| `SYNC_KEY` | — | Shared secret for HMAC authentication between sync peers. Strongly recommended when two instances are deployed. |
| `SYNC_PROTECTION_OFF` | — | When set, `GET /api/sync/browse` and `POST /api/sync/batch` skip all HMAC auth. Unset after initial sync. |
| `SYNC_NO_IP_PROTECTION` | `false` | Set to `true` to disable IP whitelisting for sync endpoints |
| `SYNC_WHITELIST_IPS` | — | Comma-separated extra IPs or CIDR blocks allowed on sync endpoints |
| `SYNC_INTERNAL_IP_WHITELIST` | `""` | CIDRs for internal network ranges always allowed. Default empty (CF provides real client IP via `x-cf-true-client-ip`). |
| `SYNC_EXCLUDES` | — | Comma-separated folders excluded from remote sync (e.g. `rcs,users`) |
| `MAX_RESPONSE_STORAGE_DAYS` | `3` | Days to retain response files. Housekeeping runs on startup then every 24 h. `0` = disable. Also controls the furthest date in the UI date range picker. |
| `REQUEST_TIMEOUT_MS` | `30000` | Default HTTP request timeout in ms for standard endpoint checks. Timed-out checks recorded as `504`. Per-endpoint `timeout` in `config.json` overrides this. |
| `AUTO_SUBACCOUNT_REFRESH_MINS` | `10` | Proactive per-subaccount refresh threshold when modal opens. `0` = disable. |
| `AUTO_GLOBAL_REFRESH_HRS` | `6` | Global auto-refresh threshold when Destination/RC Overview opens. `0` = disable. |
| `REFRESH_APPS_INTERVAL_HRS` | — | CF app scan interval in hours; saving restarts the scheduler |
| `STOP_APPS_UNUSED_AFTER_HRS` | `0` | Stop AOD-managed apps idle for this many hours. `0` = disabled. |
| `RESTRICTED_SUBACCOUNT_IDS` | — | Comma-separated org GUIDs to restrict. Format: `{guid}:{label},...` |
| `LOG_LEVEL` | `debug` | Pino log level: `trace`, `debug`, `info`, `warn`, `error` |

Most variables can also be set under `config.json → variables` or (for settable ones) via **Config → Settings → Variables** in the UI. Priority order: `settings.json → variables` → individual env var → `CONFIG_JSON → variables` → `config.json → variables`.

---

## Remote Sync

### Why two instances are recommended

BTP Admin persists all runtime data — destination snapshots, role collection data, user records, response history, and config files — in the CF app's **local filesystem** (`LOCAL_STORE_DIR`). Cloud Foundry containers are ephemeral: the filesystem is wiped on every restart or redeployment. Without a second instance, a routine deploy or a CF platform restart destroys all accumulated data.

The recommended setup is **two instances deployed in two different BTP regions**, one acting as the **producer** (primary) and one as the **consumer** (replica). The consumer mirrors the producer's data in real time, so restarting either instance individually is safe — it re-syncs from the other on startup. Never restart both at the same time.

### Sync setup

Cloud Foundry containers are ephemeral — local files are lost on restart. Remote Sync lets two BTP Status instances share history. The **producer** runs health checks; the **consumer** (replica) mirrors the producer's response files.

> **Warning:** Do not restart both instances at the same time — they will each find nothing to sync and all accumulated response files will be lost.

### How it works

Sync is **push-based**. The consumer registers a webhook with the producer, and the producer calls it after every health check.

**Consumer setup** (set both env vars on the replica):

```bash
SYNC_REMOTE=https://btp-status-prod.cfapps.eu10.hana.ondemand.com
SELF_URL=https://btp-status-replica.cfapps.eu10.hana.ondemand.com
```

**Startup flow:**
1. Consumer calls `GET /api/sync/browse?callback=<SELF_URL>/api/sync/trigger` on the producer — registers its webhook and gets the full file list with per-file mtimes
2. Compares against local `localStore/`
3. Downloads missing files via `POST /api/sync/batch` (ZIP batches, `SYNC_REMOTE_BATCH_SIZE` files per request)
4. Sets each file's local mtime to match the remote mtime
5. Deduplicates starred/unstarred pairs

**Push notification flow:**
1. Producer completes a check → calls all registered `callback` URLs (fire-and-forget)
2. Consumer's `/api/sync/trigger` is called
3. Consumer calls `GET /api/sync/browse?since=<lastBrowseTs>&callback=…`; downloads new files

**Interval fallback:** if the producer is restarted and its in-memory callback registry is reset, the consumer recovers automatically within `SYNC_INTERVAL` seconds by firing a delta sync.

### Sync Key

> **Warning:** Setting `SYNC_KEY` is strongly recommended. Without it, sync endpoints are open to any caller.

Set the same secret on both producer and consumer:

```json
{ "variables": { "SYNC_KEY": "your-secret-sync-key" } }
```

Every sync request carries `x-sync-ts` and `x-sync-sig: HMAC-SHA256(timestamp, SYNC_KEY)`. The server verifies the signature and rejects requests whose timestamp falls outside ±1 minute.

### Key rotation / temporary open access

To pull files from a producer whose `SYNC_KEY` no longer matches yours:

```bash
cf set-env btp-admin SYNC_PROTECTION_OFF true
cf restart btp-admin
# ... complete initial sync on the consumer ...
cf unset-env btp-admin SYNC_PROTECTION_OFF
cf restart btp-admin
```

### Sync IP Whitelisting

When `server/config/btp-endpoints.json` is present, sync endpoints (and the `/aod` proxy) reject requests from IPs not in SAP BTP's published egress ranges. The same file is bundled into the sidecar WAR at build time.

See [Security → `btp-endpoints.json`](security.md#btp-endpointsjson) for how to generate or update the file, and for the full IP filtering reference (variables, bypass flags, CIDR support).

---

## Authentication & Authorization

See [Security → Authentication & Authorization](security.md#authentication--authorization) for session cookie details, protected routes, role collections, and BTP XSUAA setup.

See [Security → API Endpoint Protection Overview](security.md#api-endpoint-protection-overview) for a full table of which endpoints are protected by which mechanism.

---

## Logging

The server uses [pino](https://getpino.io) with colorized pretty-print output.

| Level | When |
|-------|------|
| `INFO` | Startup · config source · incoming `/health/:name` requests · pass/fail result · manual test trigger |
| `DEBUG` | Outgoing HTTP method + URL · response status, time, body preview (first 300 chars) |
| `WARN` | Each failed condition — actual vs expected value |
| `ERROR` | Network/connection errors from fetch |

```
[10:02:31] INFO  (service=dcore-prod from=::1) Health check request received
[10:02:31] DEBUG (service=dcore-prod endpoint="Launch Redirect" method=GET url=https://…) Sending request
[10:02:32] DEBUG (service=dcore-prod endpoint="Launch Redirect" status=301 responseTime=743) Response received
[10:02:32] INFO  (service=dcore-prod) Health check passed
```

---

## Gzip Compression

All HTTP responses (API JSON, HTML, CSS, JavaScript) are automatically gzip-compressed using native `node:zlib` when the client sends `Accept-Encoding: gzip`. Binary image types are passed through uncompressed.

---

## Deployment (SAP BTP MTA)

### How it works

The app is packaged as an MTA archive and deployed to SAP BTP Cloud Foundry using two buildpacks in sequence:

1. **[apt-buildpack](https://github.com/cloudfoundry/apt-buildpack)** — reads `server/apt.yml` and installs shared system libraries that Playwright's Chromium requires on `cflinuxfs4`
2. **nodejs_buildpack** — installs production dependencies (Playwright downloads its self-contained Chromium binary at this point), compiles and runs the app

No Docker image management required.

### Prerequisites

```bash
npm install -g mbt                  # Cloud MTA Build Tool
cf install-plugin multiapps         # CF MTA plugin (once per CF CLI install)
```

### Build & deploy scripts

| Script | What it does |
|--------|-------------|
| `npm run build` | Build MTA archive — packages React build + compiled server into `mta_archives/btp-admin.mtar` |
| `npm run bd` | Build + standard deploy |
| `npm run bd-bg` | Build + blue-green deploy (zero-downtime) |
| `npm run deploy` | Standard deploy of an already-built `.mtar` |
| `npm run deploy-bg` | Blue-green deploy of an already-built `.mtar` |

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com
cf target -o <org> -s <space>

npm run bd       # build then standard deploy
npm run bd-bg    # build then blue-green deploy (recommended when Azure TM is connected)
```

> **Dependency install**: `npm ci` is omitted from `mta.yaml` to keep iterative MTA builds fast. Run `npm install` manually before the first build, and again whenever `package.json` changes.

> **Blue-green strategy** (`--strategy blue-green --skip-testing-phase`): starts a parallel "green" instance, waits for it to be healthy, routes traffic to it, then removes the old "blue" instance. Always use this when Azure Traffic Manager is connected — a standard deploy takes the app offline for 30–60 s, causing TM to fail over.

`keep-existing: env: true` in `mta.yaml` preserves existing environment variables set via `cf set-env` — runtime config is not wiped by a redeploy.

### Post-deploy config

**Option A — include the file** (simplest): place `server/config.json` in the repo before building the MTA.

**Option B — env var** (no file, suitable for secrets): set `CONFIG_JSON` via a `*.mtaext` extension descriptor:

```yaml
# config-dev.mtaext
_schema-version: "3.3"
extends: btp-admin
modules:
  - name: btp-admin
    properties:
      CONFIG_JSON: '{"services":[...]}'
```

Then deploy with: `cf deploy mta_archives/btp-admin.mtar -e config-dev.mtaext`

### Operations

```bash
cf mtas                               # list deployed MTAs
cf mta btp-admin                      # show modules and services
cf undeploy btp-admin                 # tear down

npm run logs           # tail live logs (filtered, pretty-printed Pino output)
npm run logs-idle      # tail the idle instance during blue-green deploy
npm run logs-recent    # print recent logs
```

---

## RFC Sidecar (OnPremise RFC Destinations)

The **Test** tab in the Subaccount Destinations modal supports live RFC calls for destinations with `Type=RFC`. RFC testing is handled by the `btp-admin-sidecar` module — a TomEE WAR deployed on `sap_java_buildpack_jakarta` that uses SAP JCo to execute RFC function calls.

**How it works:** When a user tests an RFC destination, `btp-admin` copies the destination into the bound `btp-admin-dest` service instance as an instance-level destination, then calls the sidecar's `POST /api/test-rfc` endpoint. The sidecar resolves the destination via `JCoDestinationManager` and executes the RFC call through the Cloud Connector.

**Supported auth types:** `BasicAuthentication` and `PrincipalPropagation`.

**Cloud Connector backend:** Must be **Protocol: RFC** (JCo uses RFC port 20001, not SOCKS5 port 20004).

### Rebuilding the sidecar WAR

The pre-built `sidecar/btp-admin-sidecar.war` is committed to the repository. You only need to rebuild if you modify `sidecar/SidecarServlet.java`.

1. Download **SAP JCo 3** (`sapjco3.jar`) from the [SAP JCo download page](https://support.sap.com/en/product/connectors/jco.html) (Linux/x86_64 package, SAP S-User required)
2. Place `sapjco3.jar` into `sidecar/`
3. Run:
   ```bash
   cd sidecar && ./build.sh
   ```

> `sidecar/sapjco3.jar` is in `.gitignore` — SAP JCo license prohibits redistribution. The `libsapjco3.so` native library is supplied by the buildpack at runtime.

---

## Debugging / Troubleshooting

### Capturing outgoing HTTP/HTTPS calls with mitmproxy

Node.js's native `fetch` (undici) intentionally ignores `HTTP_PROXY` / `HTTPS_PROXY`. To route through [mitmproxy](https://mitmproxy.org/):

**One-time setup**: start mitmproxy once to generate its CA cert at `~/.mitmproxy/mitmproxy-ca-cert.pem`.

```bash
export HTTPS_PROXY=http://127.0.0.1:9000
export NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
export NODE_OPTIONS="--require $(pwd)/scripts/dev-proxy.cjs"
npm run dev
```

| Variable | Purpose |
|----------|---------|
| `HTTPS_PROXY` | Proxy address read by `scripts/dev-proxy.cjs` |
| `NODE_EXTRA_CA_CERTS` | Adds the mitmproxy CA to Node's trusted CA list |
| `NODE_OPTIONS=--require` | Loads `scripts/dev-proxy.cjs` before the app starts, patching undici's global dispatcher |

Only the Express server process is intercepted — the Vite dev server does not make outbound API calls.
