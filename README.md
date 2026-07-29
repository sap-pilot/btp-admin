# BTP Admin

A lightweight, file-backed status page and admin dashboard for SAP BTP. Includes a health checker for Azure Traffic Manager integration, a service availability history view, and a configurable BTP Homepage that renders service links across subaccounts via a `homepage.json` descriptor.

![BTP Status Dashboard](doc/img/btp-status-compare.png)

## Workflow

Each BTP Status instance is deployed in a different region. A `browser-ias-login` endpoint performs a full headless login to SAP Workzone every few minutes, with automatic retries on transient failures. The result is exposed via `GET /health/:service` — returning `200 OK`, `200 Partial OK`, or `500 Service down` depending on whether all, some, or none of the recent checks passed.

Azure Traffic Manager polls these health endpoints from multiple PoPs. When all probes from a region consistently return `500`, Traffic Manager stops routing end-user traffic there and fails over to the healthy region. Once the degraded instance recovers and probes return `200`, Traffic Manager automatically restores it to rotation.

![BTP Status Workflow](doc/img/btp-status-workflow.png)

## Screenshots

**Overview** — landscape diagram with live service status and timeline dots

![BTP Status Overview](doc/img/overview-v0.12.png)

**Service detail** — uptime stats, response time chart, and full check history

![BTP Service History](doc/img/service-history-v0.12.png)

**Drill-down** — full request/response detail and screenshot from a past check

![BTP Service Screenshot](doc/img/service-screenshot-v0.12.png)

## Features

1. **Azure Traffic Manager probe endpoint** — `GET /health/{service}` returns a JSON summary of the latest check result per probe location, e.g. `{"status":"OK","locations":{"Ashburn":200,"Frankfurt":200}}`; evaluated from saved response files within `endpoint.interval × 2` seconds — no live network probe; returns `200 {"status":"OK"}` when all locations passed, `200 {"status":"Partial OK"}` when some are degraded, or `500 {"status":"Service down"}` when all failed; designed for Azure Traffic Manager probes running every 3–5 seconds from multiple PoPs; region is extracted from the request hostname (`cfapps.<region>.hana`) and matched against `endpoints[].region` so each deployed instance reports only its local endpoints

2. **Browser-based IAS login check** (`mode: browser-ias-login`) — headless Chromium fills the SAP IAS login form, waits for a CSS selector to confirm the post-login page loaded, and captures a screenshot; validates the full authentication flow end-to-end, not just HTTP reachability; screenshot is stored with the check record and visible in the history drill-down and Test popup

3. **Status timeline, history, and drill-down** — one color-coded timeline row per endpoint on the Overview page; each service is its own card with endpoint rows; each endpoint label links to the service detail page filtered by that endpoint, and an external link icon opens the endpoint URL in a new tab; per-service detail shows uptime %, a response time chart and a full history table with filters (endpoint, location, status, tag, date range); selecting an endpoint or location filter updates the response time chart to show only matching series (status filter does not affect the chart); endpoint, location, status, and tag filters are all persisted in the URL so they survive page refresh; clicking any dot opens a modal with the complete request/response/condition result and screenshot; starred rows can be filtered with **All tags → Starred**; stat card interactions: the entire card surface is clickable for **Completely Failed**, **Partially Failed**, **Total Checks**, and **Last Checked** on both pages; on Overview, **Completely Failed** / **Partially Failed** filters the service/endpoint list and persists `?status=failed` / `?status=partial` in the URL; on Service detail the same cards filter the history table; clicking an already-active card clears the filter; **Total Checks** always clears the status filter on both pages; the active filter card shows a subtle ring highlight regardless of how the filter was applied (card click, URL param, or table dropdown); navigation from Overview to Service detail preserves the active status filter — clicking a service name, endpoint, or dot while a filter is active forwards `?status=` to the Service detail URL so the history table is pre-filtered on arrival; the **← Overview** back button always returns to the Overview page with the previous filter restored; when XSUAA is enabled the detail endpoint requires authentication — unauthenticated users see a **Login** button in the modal and the full detail loads automatically after they log in

4. **Starred response files** — click the ⭐ button at the end of any history table row to star the record (any logged-in user when XSUAA is enabled; greyed-out with tooltip when not logged in); starring renames the response JSON and all sidecars (screenshot, console log, page source, retry files) to include `.starred.` in the filename, updates all internal cross-references atomically, and touches the file's mtime to now; starred files are retained by housekeeping indefinitely regardless of `MAX_RESPONSE_STORAGE_DAYS`, survive remote sync with mtime-based deduplication (if both starred and unstarred versions arrive on the consumer, the newer mtime wins), and are included in availability calculations alongside regular files; unstarring reverses all renames; a **Starred** option in the tag filter shows only starred rows (`?tag=starred`); an **All Time Starred** option in the time range selector issues `GET /api/history/:name?tag=starred`, which returns only starred files across all time with no time-range restriction (server-side filter — avoids sending large unfiltered result sets to the browser); every star/unstar action is logged at `INFO` level with the user identity and filename, and triggers `notifyCallbacks()` so consumer instances immediately pull the renamed file via the same push mechanism used after health checks

5. **Evaluation mode override** (`Always OK` / `Always Error`) — per-service toggle to force a service to report healthy or failing regardless of actual check results; use **Always Error** to deliberately route traffic away during a known incident or planned failover; use **Always OK** to restore a service to rotation after maintenance without waiting for checks to pass; changes take effect immediately across all execution paths (scheduled checks, `/health/:name`, Run Test)

6. **Landscape diagram with live status** — tabbed Mermaid flowchart diagrams on the Overview page showing service topology; diagram nodes are coloured by live health status and are clickable links to the service detail page; nodes in `service.endpoint` format (e.g. `wz-us10.Workzone-Login`) show per-endpoint status and link directly to that endpoint's filtered view; compose diagrams at [mermaid.live](https://mermaid.live/); active tab is persisted in the URL hash for easy sharing

7. **File-based storage — no database** — every check result is saved as a plain JSON file under `./response/`; no database, message broker, or external service required; XSUAA is optional and used only for authentication; the response directory is the only persistent state

7. **Full authentication enforcement** — when XSUAA is bound, every `/api/*` endpoint requires a valid session; unauthenticated browsers land on a minimal login gate (app title, site switcher, theme toggle, **Welcome, click here to login** button, and a report-an-issue link) rather than seeing any data; the site switcher is fully functional before login — backed by the always-public `GET /api/info` — so users can switch to another region if they lack access to the current one; exceptions: `/health` is always public (Azure Traffic Manager probes), `/api/me` and `/api/info` are always public, and HMAC-signed peer-sync requests bypass session auth so the two-instance sync continues to work regardless of user login state

8. **Push-based two-instance sync for CF file persistence** — Cloud Foundry containers are ephemeral and lose local files on restart; the consumer instance sets `SYNC_REMOTE` + `SELF_URL` to point at the producer; on startup it downloads all existing files and registers itself as a webhook consumer; when the producer completes a health check it calls all registered `/api/download-trigger` webhooks; the consumer fetches only the delta (`GET /api/browse?since=<ms>`) and downloads new files via `POST /api/batch-download`; see [Remote Sync](#remote-sync)

9. **BTP Homepage** — a configurable navigation hub at `/home` driven by `server/homepage.json` (or `HOMEPAGE_JSON` env var); organize your BTP subaccounts into tabs and directories; one column per subaccount, one row per service; a **Cockpit** row provides deep dropdown navigation with per-space sub-menus; other service rows resolve URLs from named templates with `{placeholder}` substitution; sidebar `menus` groups (e.g. Security, Resources) are filtered per `restricted` flag — unauthenticated users see only unrestricted items; copy `sample/homepage.json` as a starting point; the active tab is reflected in the URL as `/home/{tab}` so links can be bookmarked or shared; an **Edit** (pencil) button in the topbar (visible to logged-in users, enabled for `BTP_Admin` role only) opens an in-app JSON editor with live preview and change history — edits are saved to `{RESPONSE_DIR}/homepage.json` and immediately applied

10. **Minimal server dependencies** — production runtime requires only Express (HTTP), Pino (logging), and Playwright (browser checks); all HTTP requests, crypto, gzip compression, and ZIP packaging use native Node.js APIs — no axios, no ORM, no utility libraries

10. **Live updates via Server-Sent Events** — the Overview and service detail pages update automatically when new check results arrive; the server pushes SSE `update` events through `GET /api/events` after every scheduled check, manual Run Test, or remote sync; the browser fetches only the delta (`?since=<ms>`) and merges new files into the current view without a full reload; live updates are scoped per service on the detail page (`?service=<name>`) and disabled in Date Range mode; the **Last Checked** stat card on both pages shows the time of the most recent data refresh in `HH:mm:ss` (24-hour) format, updates on every full load and live delta merge, and doubles as a sync shortcut — clicking it when authenticated triggers an immediate sync

11. **Modern, fast React UI** — built with shadcn/ui + Tailwind CSS; initial JS bundle ~55 kB gzip (lazy-loaded pages, Mermaid deferred); dark theme; mobile-responsive with hamburger menu; shared date range picker with localStorage persistence across pages

> Also supports: HTTP health checks with [Gatus](https://github.com/TwiN/gatus#conditions)-style conditions (`[STATUS]`, `[BODY]`, `[HEADER.*]`, `[RESPONSE_TIME]`, `len()`, `pat()`); variable substitution in `config.json`; `/dummy` URL to skip checks; auto-run schedule selector; site switcher for multi-region deployments; SAP BTP Cloud Foundry MTA deployment

## Quick Start

### Prerequisites

- Node.js 20+
- npm 9+

### Development

```bash
# 1. Install dependencies
npm install

# 2. Copy sample config and fill in real values
cp sample/config.json server/config.json
# Edit server/config.json with your real service endpoints and credentials

# 3. (Optional) Set up the homepage
cp sample/homepage.json server/homepage.json
# Edit server/homepage.json with your BTP global accounts and services

# 4. Build client once, then start Express (serves UI + API on :3000)
npm run dev
```

Open http://localhost:3000/status

When iterating on the frontend, rebuild the client in a second terminal while the server keeps running:

```bash
# Terminal 1 — Express with auto-restart on server file changes
npm run dev:server

# Terminal 2 — Vite rebuild on every client file change
npm run watch:client
```

### Production Build

```bash
npm run build   # builds React → server/public/, then compiles server TypeScript
npm start       # runs Express on PORT (default 3000)
```

Open http://localhost:3000/overview

## Configuration

The server resolves configuration in this priority order:

1. **`CONFIG_JSON` env var** — JSON string with the full config (useful for BTP env properties, no file needed)
2. **`CONFIG_FILE` env var / default** — path to a JSON file (default: `./config.json` relative to the `server/` working directory, i.e. `server/config.json` from the repo root)

Create `server/config.json` (copy `sample/config.json` and fill in real values):

```json
{
  "variables": {
    "MONITOR_USERNAME": "monitor@example.com",
    "MONITOR_PASSWORD": "your-monitor-password",
    "SYNC_KEY": "your-secret-sync-key"
  },
  "landscapes": [
    {
      "name": "production",
      "diagram": "flowchart LR\n    User --> my-service"
    }
  ],
  "services": [
    {
      "group": "WorkZone",
      "name": "my-service",
      "enabled": true,
      "landscapes": ["production"],
      "interval": 900,
      "endpoints": [
        {
          "name": "Health Check",
          "url": "https://my-service.example.com/health",
          "method": "GET",
          "conditions": [
            "[STATUS] == 200",
            "[RESPONSE_TIME] < 3000"
          ]
        },
        {
          "mode": "browser-ias-login",
          "name": "Login Check",
          "url": "https://my-service.example.com/login",
          "username": "{{MONITOR_USERNAME}}",
          "password": "{{MONITOR_PASSWORD}}",
          "waitForSelector": "#app-title",
          "timeout": 30000
        }
      ]
    }
  ]
}
```

### Config Fields

**Top-level**

| Field | Type | Description |
|-------|------|-------------|
| `variables` | object | Key→value map; `{{key}}` placeholders in endpoint fields are substituted at startup |
| `landscapes` | array | List of landscape definitions for the Overview diagram tabs |
| `landscapes[].name` | string | Landscape identifier (shown as tab label) |
| `landscapes[].diagram` | string | Mermaid diagram source. Nodes whose ID matches a service `name` are coloured by status and link to the service detail page. Nodes in `service.endpoint` format (e.g. `wz-us10.Workzone-Login`) show the per-endpoint status and link directly to that endpoint's filtered view (`/service/wz-us10?endpoint=Workzone-Login`). |
| `sites` | array | List of deployed instances for the site-switcher dropdown (optional; dropdown hidden when fewer than 2 entries) |
| `sites[].name` | string | Display name for the site (e.g. `"Ashburn"`, `"Frankfurt"`) |
| `sites[].url` | string | Base URL of that deployed instance (e.g. `"https://btp-status-ashburn.cfapps.us10.hana.ondemand.com"`); the current site is matched by comparing the browser's `window.location.origin` against the configured URL's origin |
| `sites[].legacyUrls` | string[] | Optional list of previous/alternative URLs for this site; also checked against `window.location.origin` when matching the current site (useful after a CF app rename or route migration) |
| `services` | array | List of service configs |

- Tip: compose landscape diagrams at [mermaid.live](https://mermaid.live/)

**Per service**

| Field | Type | Description |
|-------|------|-------------|
| `group` | string | Group name for dashboard grouping |
| `name` | string | Unique service identifier (used in URLs and diagram node matching) |
| `enabled` | boolean | Set `false` to exclude from checks |
| `interval` | number | Fallback auto-check interval in seconds (service-level); overridden per endpoint via `endpoints[].interval`; `0` or omitted disables automatic checks for endpoints that don't set their own |
| `homepage` | string | Optional homepage URL shown as ↗ link on the dashboard |
| `landscapes` | string[] | Landscape names this service belongs to (for tab filtering and availability badge) |

**Per endpoint**

| Field | Type | Description |
|-------|------|-------------|
| `endpoints[].name` | string | Display name for this endpoint (use lowercase-dash names, e.g. `"api-portal"`) |
| `endpoints[].url` | string | URL to probe; set to `/dummy` to skip the check and always record `200 OK` |
| `endpoints[].method` | string | HTTP method (`GET`, `POST`, etc.) |
| `endpoints[].headers` | object | Request headers; `{{variable}}` placeholders are substituted |
| `endpoints[].body` | string\|null | Request body; `{{variable}}` placeholders are substituted |
| `endpoints[].conditions` | string[] | Conditions to validate (Gatus syntax) |
| `endpoints[].mode` | string | `browser-ias-login` to use headless Chromium instead of an HTTP request |
| `endpoints[].username` | string | IAS username; `{{variable}}` substitution supported |
| `endpoints[].password` | string | IAS password; `{{variable}}` substitution supported |
| `endpoints[].waitForSelector` | string | CSS selector to wait for after login (browser-ias-login only) |
| `endpoints[].timeout` | number | Request timeout in **seconds**. For HTTP checks, overrides `REQUEST_TIMEOUT_MS`; a timed-out check is recorded as `504`. For `browser-ias-login`, sets the overall browser session timeout (default `30`s). |
| `endpoints[].interval` | number | Per-endpoint auto-check interval in seconds; takes precedence over the service-level `interval`. |
| `endpoints[].retry` | number | Optional. Maximum number of retry attempts on failure. When set, a failed check is automatically re-attempted up to this many times before the final result is saved. |
| `endpoints[].retryDelay` | number | Optional. Seconds to wait between retry attempts (default `0`). |
| `endpoints[].region` | string | Optional. BTP region code (e.g. `"us10"`, `"us20"`, `"eu10"`). When set, this endpoint is only checked when the request hostname matches `cfapps.<region>.hana` (extracted from `x-forwarded-host` or `Host`). Used for multi-region deployments where each btp-status instance should only probe its local endpoints. Scheduler and manual "Run Test" always run all endpoints regardless of region. |

### Condition Syntax

Conditions follow [Gatus](https://github.com/TwiN/gatus#conditions) syntax:

| Condition | Description | Example |
|-----------|-------------|---------|
| `[STATUS] == 200` | HTTP status code | `[STATUS] == 301` |
| `[RESPONSE_TIME] < 500` | Response time in ms | `[RESPONSE_TIME] < 2000` |
| `[BODY] == "text"` | Body equals string | `[BODY] == "OK"` |
| `[BODY].key == "value"` | JSON body field (dot-path) | `[BODY].status == "healthy"` |
| `[HEADER.name] == "value"` | Response header value | `[HEADER.content-type] == "application/json"` |
| `len([BODY].arr) > 0` | Array/object length | `len([BODY].items) > 0` |
| `[BODY] == pat(*glob*)` | Glob/regex pattern match | `[BODY] == pat(*authentication*)` |

Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`

### Browser-based IAS Login Check

Set `mode: "browser-ias-login"` on an endpoint to use a headless Chromium session instead of a plain HTTP request:

```json
{
  "mode": "browser-ias-login",
  "name": "workzone-login",
  "url": "https://<tenant>.launchpad.cfapps.<region>.hana.ondemand.com/site/<site>?sap_idp=<idp>",
  "username": "monitor@example.com",
  "password": "secret",
  "waitForSelector": "#shellAppTitle",
  "timeout": 30,
  "interval": 900,
  "retry": 2,
  "retryDelay": 30
}
```

The check flow:
1. Launch headless Chromium, navigate to `url` (which triggers the IAS redirect)
2. Fill `#j_username`, click `#next-button`
3. Fill `#j_password`, click `#logOnFormSubmit`
4. Wait for the CSS selector `waitForSelector` to appear in the DOM — success if found before `timeout`, failure otherwise
5. Capture a screenshot and collect all browser console messages regardless of outcome
6. Dump the current page HTML source
7. Save three sidecar files alongside the JSON record:
   - `…_{status}.png` — screenshot
   - `…_{status}_console.log` — timestamped browser console output (log, error, warning, etc.)
   - `…_{status}_content.html` — raw HTML source of the page at check completion

The **Response Detail** modal shows four tabs for browser checks (tabs appear only when the corresponding file exists):

| Tab | Content |
|-----|---------|
| **Overview** | Check metadata, result message, conditions table (default) |
| **Screenshot** | Full-page screenshot |
| **Console** | Timestamped browser console messages (useful for JS errors and blank-screen failures) |
| **Page Source** | Raw HTML of the page (useful for inspecting what was rendered during a failed login) |

All three sidecar files are included in remote sync and pruned by the housekeeping scheduler alongside their JSON counterpart.

> **Chromium setup (local dev)**: run `npx playwright install chromium` once after `npm install`.  
> On SAP BTP Cloud Foundry, Google Chrome is installed automatically via the apt-buildpack — no manual step required (see [BTP deployment notes](#deployment-sap-btp-mta)).

### Automatic Checks

When `interval` is set on an endpoint (or at the service level as a fallback), the server runs a health check for that endpoint every `interval` seconds — no external scheduler or cron job required. Each endpoint is scheduled independently, so different endpoints in the same service can run at different frequencies.

- If a check is already running when the next interval fires, that tick is **skipped** (no pile-up).
- Errors inside a check are caught and logged; the timer continues unaffected.
- All timers are released with `unref()` so they do not block graceful process shutdown.
- On `SIGTERM` / `SIGINT` the scheduler stops cleanly before the HTTP server closes.

### Retry Behavior

When `retry` is set on an endpoint, a failed check is automatically re-attempted:

1. Initial check runs normally; if it fails and `retry > 0`, retry attempts begin.
2. Each retry waits `retryDelay` seconds, then re-runs the full check.
3. Each retry result is saved as a sidecar file (e.g. `…_500.retry.json`, `…_500.retry.png`) linked from the main record's `retryFiles` field.
4. If **any** retry succeeds, the main result file is saved with status `400` (**Partially Failed**) — the endpoint is up, but required retries.
5. If **all** retries also fail, the main result is `500` / `504` (**Completely Failed**).
6. Retry files are excluded from the history list and timeline dots. The **Response Detail** modal shows a **Retries** tab when `retryFiles` is non-empty, with an expandable condition table for each attempt.

The Overview and Service detail pages show separate **Completely Failed** (500/503/504, red) and **Partially Failed** (400, orange) stat cards.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health/:name` | Returns latest saved check result (no live probe): `200 OK`, `200 Partially OK`, or `500 service down`; region-filtered by request hostname; designed for Azure Traffic Manager probes |
| `GET /overview` | Overview dashboard UI |
| `GET /service/:name` | Service detail UI — history timeline, drill-down, "Run Test" button |
| `GET /api/services` | List all services (JSON) |
| `GET /api/check/:name` | Run health check, return structured JSON with per-endpoint request/response/conditions (used by Test popup) |
| `GET /api/overview?hours=24` | Overview data for all services (JSON); also accepts `?from=YYYY-MM-DD&until=YYYY-MM-DD` for date range queries |
| `GET /api/history/:name?hours=24` | History file list for a service (JSON); also accepts `?from=YYYY-MM-DD&until=YYYY-MM-DD` for date range queries |
| `GET /api/history/:name/:filename` | Full request/response detail for one check (JSON) |
| `GET /api/info` | Server capabilities: `{ syncRemote, city, sites, maxStorageDays }` |
| `GET /api/eval-mode/:name` | Current evaluation mode: `{ mode: "condition" \| "alwaysok" \| "alwayserror" }` |
| `POST /api/eval-mode/:name` | Set evaluation mode (JSON body `{ "mode": "..." }`); resets to `condition` on server restart |
| `GET /api/schedule/:name` | Current effective interval in seconds: `{ intervalSeconds }` |
| `POST /api/schedule/:name` | Set schedule override (JSON body `{ "intervalSeconds": N }`); `0` disables autorun; resets on server restart |
| `POST /api/sync` | Trigger an on-demand remote sync; returns `{ ok, files, transferredMB, decompressedMB, elapsedSec }` or `{ ok: false, busy: true }` if a sync is already running |
| `GET /api/browse` | List all response files grouped by service folder: `{ folders: { name: [filename, ...] } }` |
| `GET /api/download?path=folder/file.json` | Download a single response file (path restricted to `response/` directory) |
| `GET /api/homepage` | Current homepage data (JSON); `restricted` items filtered by auth state |
| `GET /api/homepage/raw` | Raw homepage JSON (admin only) |
| `GET /api/homepage/changelog` | Homepage change history markdown (admin only) |
| `POST /api/homepage/save` | Save edited homepage JSON (admin only); appends diff to changelog and notifies consumer instances |

### Evaluation Mode & Schedule

On any service's detail page (`/service/:name`), two selectors in the header control the service without restarting the server:

**Evaluation Mode** — how check results are interpreted:

| Mode | `/health/:name` | Saved status | Timeline dot |
|------|----------------|-------------|--------------|
| **Condition Based** (green, default) | Latest file result: `200 OK` / `200 Partially OK` / `500` | `200` or `500` | Green / Red |
| **Always OK** (dark green) | Always `200 OK` regardless of file results | `203` | Dark green |
| **Always Error** (dark red) | Always `500` regardless of file results | `503` | Dark red |

A confirmation dialog appears before applying Always OK or Always Error. Both modes honour the evaluation setting for all execution paths (scheduled checks, manual `/health/:name`, Run Test).

**Schedule** — auto-run interval:

| Option | Effect |
|--------|--------|
| Every 5 / 10 / 15 / 30 min / 1 hour | Reschedules the service immediately; overrides `config.json` interval |
| Disable autorun | Stops scheduled checks; only manual `/health/:name` or Run Test will record results |

All overrides are in-memory and reset to their `config.json` defaults on server restart.

### Azure Traffic Manager

Point your Traffic Manager HTTP probe at:

```
GET https://<your-app>/health/<service-name>
```

The probe reads saved response files and replies in milliseconds — no live network request is made. Safe to call at 3–5 s intervals from multiple Traffic Manager PoPs.

**Time window**: for each endpoint, files within `[now − endpoint.interval × 2, now]` are considered. This ensures the probe reflects recent check results without stale data from much older runs.

**Region filtering**: the incoming request hostname (`cfapps.<region>.hana`) is matched against `endpoints[].region`. Endpoints with no `region` are always included. Each deployed btp-status instance therefore reports only the health of its own region's endpoints.

**Location grouping**: from the qualifying files, the latest check result per probe location (city stamped in the filename) is collected. The overall response is determined by aggregating across all locations.

**Response body** is JSON:

| HTTP | Body | Meaning |
|------|------|---------|
| `200` | `{"status":"OK","locations":{"Ashburn":200,…}}` | Latest result from every location is `200`/`203` |
| `200` | `{"status":"Partial OK","locations":{"Ashburn":200,"Frankfurt":400,…}}` | At least one location is non-200 (e.g. `400` Partially Failed) but not all are down |
| `500` | `{"status":"Service down","locations":{"Ashburn":500,…}}` | Every location's latest result is `500`/`503`/`504` |
| `200` | `{"status":"OK","locations":{},"note":"no recent data"}` | No files in the time window — treated as healthy |

**Evaluation mode** takes precedence: `alwaysok` → `200 {"status":"OK","locations":[]}`, `alwayserror` → `500 {"status":"Service down","locations":[]}`.

**Run Test / Test All** always run a live probe against all endpoints regardless of region, so you can verify any endpoint from any location manually.

## Authentication and Authorization

By default the app runs without authentication — all endpoints and admin controls are publicly accessible. When a **XSUAA** service binding is present (`VCAP_SERVICES` contains an `xsuaa` entry), the app switches into authenticated mode automatically.

### How It Works

Authentication follows the **OAuth2 Authorization Code flow** via a browser popup — no `@sap/approuter` dependency. Everything is implemented with `node:crypto` and the Node.js standard library.

1. The user clicks the person icon (top-right of any page).
2. A popup opens `/login`, which immediately redirects to the XSUAA authorize URL.
3. After the user authenticates, XSUAA redirects to `/login/callback?code=…`.
4. The server exchanges the code for a JWT, verifies the RS256 signature against the `verificationkey` from the XSUAA binding, and extracts `firstName`, `isAdmin`, `sub`, and `exp`.
5. A signed session cookie (`btpauth`) is set: `base64url(JSON payload) + "." + HMAC-SHA256(payload, clientSecret)`.
6. The popup posts `{ type: "login", user: { firstName, isAdmin } }` back to the main window via `window.opener.postMessage` and closes itself — no page reload required.

Logout follows the same popup pattern: the server clears the cookie and posts `{ type: "logout" }`.

### Session Cookie

| Property | Value |
|----------|-------|
| Name | `btpauth` |
| Signing | HMAC-SHA256 (key = XSUAA `clientsecret`); verified on every protected request using `timingSafeEqual` |
| HttpOnly | Yes — not accessible from JavaScript |
| Secure | Yes when running on BTP (`VCAP_APPLICATION` is present); omitted for local HTTP dev |
| SameSite | Lax |
| Max-Age | Derived from the JWT `exp` claim |

### Admin Role

The **BTP Status Admin** role collection grants write access to evaluation mode and schedule overrides. It is created automatically on first deploy (defined in `xs-security.json` via `role-collections`). To activate it:

1. In BTP Cockpit → Security → Role Collections, find **BTP Status Admin** (auto-created by the deployment).
2. Assign it to the relevant users or user groups.

### Protected Routes

| Route | Guard | Description |
|-------|-------|-------------|
| `GET /api/check/:name` | Auth required | Run health check (used by Test All / Run Test) |
| `POST /api/sync` | Auth required | Trigger on-demand remote sync |
| `GET /api/download-trigger` | Sync auth | Webhook called by the producer; triggers delta download from `SYNC_REMOTE` |
| `POST /api/eval-mode/:name` | Admin required | Change evaluation mode |
| `POST /api/schedule/:name` | Admin required | Change schedule override |

All other routes (read-only data, static assets) are public regardless of auth state.

### UI Behaviour

| Auth State | Test All / Sync / Run Test | Eval Mode / Schedule selectors |
|-----------|---------------------------|-------------------------------|
| XSUAA not configured | Visible and active | Visible and active |
| Logged out | Hidden | Hidden |
| Logged in (no admin role) | Visible and active | Visible but disabled |
| Logged in (admin role) | Visible and active | Visible and active |

### BTP Setup

Add an XSUAA resource to `mta.yaml` (already included) and `xs-security.json` (already included in the repo). On first deploy with the XSUAA resource, BTP provisions the service instance automatically.

```yaml
# mta.yaml — resources section
resources:
  - name: btp-status-xsuaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json
      config:
        xsappname: btp-status
```

After deployment, the `VCAP_SERVICES` environment variable injected by BTP will contain the XSUAA credentials, and the app will enable authentication automatically.

### Local Development (No Auth)

When `VCAP_SERVICES` is not set (local dev), all auth middleware passes through — no login is required and all controls remain fully active. This is the default for `npm run dev`.

## Response File Storage

Each health check saves a file at:

```
./response/{service-name}/yyyyMMdd-HHmmss_{endpointSlug}_{city}_{responseTimeMs}_{200|203|400|500|503|504}.json
```

- **Timestamp**: UTC (`yyyyMMdd-HHmmss`)
- **endpointSlug**: endpoint `name` from config with non-alphanumeric chars replaced by dashes
- **city**: full city name from `ip-api.com` with spaces replaced by dashes (e.g. `Frankfurt-am-Main`); resolved once at startup; `unknown` if lookup fails or times out
- **responseTimeMs**: integer milliseconds, no suffix
- **Status codes**: `200` = genuine pass, `203` = pass under Always OK, `400` = initial failure but retry succeeded (Partially Failed), `500` = genuine fail, `503` = fail under Always Error, `504` = timeout

Old-format files (`yyyyMMdd-HHmmss_{index}_{ms}ms_{status}.json`, local-timezone timestamp) are still read and displayed correctly alongside new-format files.

File content:
```json
{
  "request": { "url": "...", "method": "GET", "headers": {}, "body": null },
  "response": { "status": 200, "headers": {}, "body": "..." },
  "timestamp": "2026-06-16T10:00:00.000Z",
  "responseTime": 342,
  "endpointIndex": 0,
  "endpointName": "Health Check",
  "conditions": [
    { "condition": "[STATUS] == 200", "passed": true, "actual": "200", "expected": "== 200" }
  ],
  "overallStatus": 200
}
```

## Logging

The server uses [pino](https://getpino.io) with colorized pretty-print output.

| Level | When |
|-------|------|
| `INFO` | Server startup · config source (file vs env var) · incoming `/health/:name` requests · pass/fail result · manual test trigger |
| `DEBUG` | Outgoing HTTP method + URL · response status, time, body preview (first 300 chars) |
| `WARN` | Each failed condition — shows actual vs expected value (yellow) |
| `ERROR` | Network/connection errors from fetch (red, full error object + stack) |

```
[10:02:31] INFO  (service=dcore-prod from=::1) Health check request received
[10:02:31] DEBUG (service=dcore-prod endpoint="Launch Redirect" method=GET url=https://…) Sending request
[10:02:32] DEBUG (service=dcore-prod endpoint="Launch Redirect" status=301 responseTime=743) Response received
[10:02:32] INFO  (service=dcore-prod) Health check passed
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port (Cloud Foundry sets this automatically) |
| `CONFIG_JSON` | — | Full config as a JSON string; takes priority over `CONFIG_FILE` (ideal for BTP env properties) |
| `CONFIG_FILE` | `./config.json` | Path to config JSON file (relative to `server/` working dir; resolved as `server/config.json` from repo root) |
| `RESPONSE_DIR` | `./response` | Directory for response file storage |
| `SYNC_REMOTE` | — | Base URL of the producer BTP Status instance (e.g. `https://btp-status-prod.cfapps.eu10.hana.ondemand.com`). On startup the consumer downloads all existing files and registers itself as a webhook consumer. Subsequent updates arrive via push (`/api/download-trigger`). |
| `SELF_URL` | auto | Base URL of this (consumer) instance used when registering the `/api/download-trigger` webhook with the producer. Auto-detected from `VCAP_APPLICATION.application_uris[0]` in Cloud Foundry. Set explicitly if auto-detection is unavailable (e.g. local development). |
| `SYNC_REMOTE_BATCH_SIZE` | `200` | Number of files requested per `POST /api/batch-download` call during sync. The sync job tries the batch endpoint first; if the remote does not support it, it falls back to individual `GET /api/download` requests with concurrency 10. |
| `SYNC_INTERVAL` | `300` | Fallback sync interval in seconds. If no webhook-triggered download completes within this window (e.g. because the producer was restarted and lost its registered callbacks), the consumer triggers a delta sync automatically using `GET /api/browse?since=<lastBrowseTs>`. Set to `0` to disable the fallback. |
| `MAX_RESPONSE_STORAGE_DAYS` | `7` | Response files (JSON + PNG) older than this many days are automatically deleted. Housekeeping runs once on startup then every 24 hours. Set to `0` to disable. Also controls the furthest date selectable in the UI's Date Range picker. |
| `REQUEST_TIMEOUT_MS` | `30000` | Default HTTP request timeout in milliseconds for standard endpoint checks. A check that exceeds this limit is recorded with status `504` and the response filename ends in `_504.json`. Per-endpoint `timeout` in `config.json` overrides this value for that endpoint only. |
| `SYNC_PROTECTION_OFF` | — | When set to any non-empty value (e.g. `true`, `1`), `GET /api/browse` and `POST /api/batch-download` skip all authentication. Useful for key rotation or bootstrapping a backup instance. Unset after the initial sync completes. |
| `LOG_LEVEL` | `debug` | Pino log level: `trace`, `debug`, `info`, `warn`, `error` |

## Remote Sync

Cloud Foundry containers are ephemeral — local files are lost on restart. Remote Sync lets two BTP Status instances share history. The **producer** runs health checks; the **consumer** (replica) downloads and mirrors the producer's response files.

> [!WARNING]
> Do not restart both instances at the same time — they will each find nothing to sync from the other and all accumulated response files will be lost.

### How it works

Sync is **push-based**. The consumer registers a webhook with the producer once, and the producer calls it after every health check.

**Consumer setup** (set both env vars on the replica instance):

```bash
SYNC_REMOTE=https://btp-status-prod.cfapps.eu10.hana.ondemand.com
SELF_URL=https://btp-status-replica.cfapps.eu10.hana.ondemand.com
```

**Startup flow:**
1. Consumer calls `GET /api/browse?callback=<SELF_URL>/api/download-trigger` on the producer  
   — registers the consumer's webhook with the producer and gets the full file list with per-file mtimes
2. Compares against local `./response/` directory
3. Downloads all missing files via `POST /api/batch-download` (ZIP batches, `SYNC_REMOTE_BATCH_SIZE` files per request)  
   — falls back to individual `GET /api/download?path=…` (concurrency 10) if the remote does not support batch
4. Sets each downloaded file's local mtime to match the remote mtime (from the browse response)
5. Deduplicates starred/unstarred pairs: for files differing only by `.starred.`, deletes the one with the older mtime

**Push notification flow (after each health check on the producer):**
1. Producer completes a check and calls all registered `callback` URLs (fire-and-forget)
2. Consumer's `GET /api/download-trigger` is called (authenticated with the shared sync key)
3. Consumer calls `GET /api/browse?since=<lastBrowseTs>&callback=<SELF_URL>/api/download-trigger` — the `since` filter is now applied by file mtime (not filename timestamp), so star/unstar renames appear in the delta even though the filename date prefix stays the same
4. Downloads new files, restores remote mtimes, and deduplicates starred/unstarred pairs (step 4–5 above)

Only one download runs at a time. A second trigger that arrives while a download is running is queued; further arrivals are dropped (the queued one will catch up on all new files).

**Interval fallback:** if the producer is restarted, its in-memory callback registry is reset and push notifications stop. The consumer recovers automatically: if no webhook-triggered download completes within `SYNC_INTERVAL` seconds (default 300 s), the consumer fires a delta sync using `GET /api/browse?since=<lastBrowseTs>&callback=<SELF_URL>/api/download-trigger`, which both picks up missed files and re-registers the consumer's webhook with the restarted producer.

**`SELF_URL`** is auto-detected from `VCAP_APPLICATION.application_uris[0]` in Cloud Foundry. Set it explicitly in other environments or if auto-detection is unavailable.

### Sync Key (optional)

> [!WARNING]
> Configuring `SYNC_KEY` is strongly recommended whenever two instances are deployed. Without it, `/api/browse`, `/api/download`, `/api/batch-download`, and `/api/download-trigger` are open to any caller who can reach the app. If `SYNC_KEY` is set to an empty string (either in the `SYNC_KEY` environment variable or in `config.json → variables`), the key is treated as absent and the endpoints remain unprotected.

To authenticate sync requests between instances, set a shared secret on **both** the producer and consumer:

```jsonc
// config.json
{
  "variables": {
    "SYNC_KEY": "your-secret-sync-key"
  }
}
```

Or via environment variable (takes precedence over `config.json`):

```bash
SYNC_KEY=your-secret-sync-key npm start
```

The key is **never transmitted in plaintext**. Instead, every sync request carries two headers:
- `x-sync-ts` — the sender's current Unix timestamp in seconds
- `x-sync-sig` — `HMAC-SHA256(timestamp, SYNC_KEY)` as a hex digest

The server verifies the signature with `timingSafeEqual` and rejects requests whose timestamp falls outside a ±1-minute window, preventing replay attacks.

When a sync key is configured:
- `GET /api/browse`, `GET /api/download`, `POST /api/batch-download`, and `GET /api/download-trigger` all require either valid HMAC signature headers **or** a valid XSUAA session cookie
- The sync client automatically signs all requests to the remote (browse, download, and callback notifications)
- If the remote rejects the signature with `401`, the entire sync is aborted immediately with an explanatory error
- Requests with neither a valid signature nor a session receive `401 Unauthorized`
- Requests from loopback (`127.0.0.1`, `::1`) are always allowed for local development

Both instances must use the same key. If XSUAA is configured, authenticated browser users can also access the sync endpoints without a key.

### Key rotation / temporary open access (`SYNC_PROTECTION_OFF`)

If you need to pull files from a producer whose `SYNC_KEY` no longer matches yours (e.g. after rotating the key on the producer, or when bootstrapping a backup instance from a third server), set `SYNC_PROTECTION_OFF` on the **producer** temporarily:

```bash
SYNC_PROTECTION_OFF=true cf set-env btp-status-producer SYNC_PROTECTION_OFF true
cf restart btp-status-producer
```

While active, `GET /api/browse` and `POST /api/batch-download` on that instance accept requests from any caller with no authentication. `GET /api/download`, `GET /api/download-trigger`, and all other endpoints remain protected by the usual auth. A `WARN` log line is emitted at startup when the flag is on.

> [!WARNING]
> Unset `SYNC_PROTECTION_OFF` and restart the producer as soon as the consumer has finished its initial sync.

## Gzip Compression

All HTTP responses — API JSON, HTML, CSS, JavaScript — are automatically gzip-compressed using native `node:zlib` when the client sends `Accept-Encoding: gzip`. Binary image types (JPEG, PNG, GIF, etc.) are passed through uncompressed. No additional dependency is required.

## Deployment (SAP BTP MTA)

### How it works

The app is packaged as an MTA archive and deployed to SAP BTP Cloud Foundry using two buildpacks in sequence:

1. **[apt-buildpack](https://github.com/cloudfoundry/apt-buildpack)** — reads `server/apt.yml` and installs the shared system libraries that Playwright's Chromium requires on the minimal `cflinuxfs4` stack (`libnss3`, `libatk1.0-0`, `libgbm1`, etc.).
2. **nodejs_buildpack** — installs production dependencies (Playwright's npm install hook downloads its self-contained Chromium binary at this point), compiles and runs the app.

This means no Docker image management is required. Playwright's bundled Chromium is downloaded during CF staging and is available when the app starts.

### Prerequisites

```bash
npm install -g mbt                  # Cloud MTA Build Tool
cf install-plugin multiapps         # CF MTA plugin (once per CF CLI install)
```

### Build & Deploy

```bash
# Log in
cf login -a https://api.cf.<region>.hana.ondemand.com
cf target -o <org> -s <space>
```

> **Dependency install (once, or after `package.json` / `package-lock.json` changes)**
> `npm ci` is intentionally omitted from `mta.yaml` to keep iterative MTA builds fast — running it on every `mbt build` adds ~1–2 minutes even when nothing in `package.json` has changed.
> Run it manually before your first build, and again whenever you add, remove, or update a dependency:
>
> ```bash
> npm install       # or: npm ci
> ```

| Script | What it does |
|--------|-------------|
| `npm run bd` | Build MTA archive + standard deploy (full pipeline) |
| `npm run bd-bg` | Build MTA archive + blue-green deploy (full pipeline, zero-downtime) |
| `npm run deploy` | Standard deploy of an already-built `.mtar` (skips `mbt build`) |
| `npm run deploy-bg` | Blue-green deploy of an already-built `.mtar` (skips `mbt build`) |

```bash
# Full pipeline: build then deploy
npm run bd       # standard deploy
npm run bd-bg    # blue-green deploy (zero-downtime)

# Redeploy an existing archive without rebuilding
npm run deploy      # standard
npm run deploy-bg   # blue-green
```

**Blue-green strategy** (`--strategy blue-green --skip-testing-phase`) starts a parallel "green" instance, waits for it to be healthy, routes traffic to it, then removes the old "blue" instance — minimising downtime during deploys.

> **When Azure Traffic Manager is connected, always use `npm run deploy-bg` (blue-green).** A standard deploy takes the app offline for 30–60 seconds during restaging; Traffic Manager will detect the `500` responses, exhaust its retries, and fail over to the other region. Blue-green avoids this by keeping the current instance live until the new one is healthy and traffic has been re-routed.

`keep-existing: env: true` in `mta.yaml` instructs the MTA deployer to **preserve existing environment variables** (e.g. `CONFIG_JSON`, `SYNC_REMOTE`) on the app during deployment, so runtime config set via `cf set-env` is not wiped by a redeploy.

### Post-deploy config

Two options for providing the service config on BTP:

**Option A — include the file** (simplest): place `server/config.json` in the repo before building the MTA. It will be bundled into the deployed module.

**Option B — env var** (no file, suitable for secrets/dynamic configs): set `CONFIG_JSON` to the full config JSON string in the MTA environment properties or via a `*.mtaext` extension descriptor:

```yaml
# config-dev.mtaext
_schema-version: "3.3"
extends: btp-status
modules:
  - name: btp-status
    properties:
      CONFIG_JSON: '{"services":[...]}'
```

Then deploy with: `cf deploy mta_archives/btp-status_0.1.0.mtar -e config-dev.mtaext`

### Operations

```bash
cf mtas                               # list deployed MTAs
cf mta btp-status                     # show modules/services
cf logs btp-status --recent       # recent logs
cf undeploy btp-status                # tear down
```
