# Application on Demand (AOD)

The **Application on Demand** feature manages CF apps running in your BTP spaces. It scans for apps bound to Destination or other service instances, surfaces their status in the **Apps** tab (`/apps`), and can automatically stop idle apps after a configured inactivity threshold — reducing unnecessary CF runtime costs.

<!-- SCREENSHOT PLACEHOLDER: Apps overview page — list of CF apps across subaccounts with status, space, and last-activity info -->

<!-- SCREENSHOT PLACEHOLDER: Subaccount modal — Apps tab showing space-level app list with start/stop controls -->

Work-Zone Apps Usage Analytis after enabling AOD: <br />
![Status Page](img/ba-appspage-v1.8.png)

---

## Architecture

AOD works by **intercepting every Fiori / Work Zone request** to a managed CF app at the BTP Destination layer — before the request ever reaches the app itself. This lets the proxy ensure the app is running and record the access, without requiring any changes to the app or the front-end.

### Destination swap

When a destination refresh runs for a space with AOD enabled, `destinationService` inspects every destination whose `URL` points to a `*.cfapps.<region>.hana.ondemand.com` address:

1. **Original destination** (`-srv` or any CF-backed destination):
   ```
   URL = https://my-fiori-app.cfapps.eu10.hana.ondemand.com
   ```

2. **After AOD install** — the `URL` is replaced with the AOD proxy endpoint, and the original app URL, app GUID, region, and subdomain are stored as additional destination headers:
   ```
   URL                       = https://btp-admin.cfapps.eu10.hana.ondemand.com/aod
   URL.headers.x-aod-app-url = https://my-fiori-app.cfapps.eu10.hana.ondemand.com
   URL.headers.x-aod-app-id  = <CF app GUID>
   URL.headers.x-aod-region  = eu10
   URL.headers.x-aod-subdomain = <subaccount subdomain>
   ```

When BTP Destination Service resolves the destination, it injects those headers into every outgoing request. The app and the Fiori shell need no changes — only the destination record is modified.

When AOD is disabled for a space, the next destination refresh reverts the `URL` back to the original app URL and removes the `x-aod-*` headers.

### Request flow

```
Fiori / Work Zone (browser)
        │
        │  HTTP request to -srv destination
        ▼
BTP Destination Service
        │  resolves destination → URL = /aod endpoint
        │  injects x-aod-app-url, x-aod-app-id, x-aod-region, x-aod-subdomain headers
        ▼
AOD proxy  (/aod/* on btp-admin)
        │
        ├─ [1] Check app health  GET https://my-fiori-app.cfapps.eu10.hana.ondemand.com/
        │         CF GoRouter returns 502/503 or x-cf-routererror header → app is down
        │
        ├─ [2] (if down) Start app  POST CF v3 API /v3/apps/{guid}/actions/start
        │         Poll every 3 s (up to 30 s) until app responds
        │
        ├─ [3] Proxy request  forward original method + headers + body to app URL
        │
        ├─ [4] Track access
        │         ├─ appendCsvLog → LOCAL_STORE_DIR/apps/{region}/{subdomain}/accesslog.csv
        │         ├─ recordAodRequest → in-memory analytics ring buffer
        │         └─ touchAppLastAccessed → updates idle timer for auto-stop
        │
        └─ [5] Return upstream response to Fiori / Work Zone
```

<!-- DIAGRAM PLACEHOLDER
Generate an architecture diagram for the AOD (Application on Demand) feature of the btp-admin BTP status app.

The diagram should show these components and flows:

Components:
- "User / Browser" (Fiori Launchpad or SAP Work Zone)
- "BTP Destination Service" (SAP-managed, injects headers)
- "AOD Proxy" (Express route /aod on btp-admin CF app)
- "CF App (e.g. Fiori -srv)" (the managed target app, may be STOPPED)
- "CF API (v3)" (used to start the app)
- "Analytics Store" (LOCAL_STORE_DIR/apps — CSV access log + in-memory ring buffer)
- "Auto-stop Scheduler" (periodic idle check, stops apps unused > threshold)

Flows (numbered):
1. User sends request → BTP Destination Service (resolved via -srv destination)
2. Destination Service swaps URL to AOD proxy, injects x-aod-app-url / x-aod-app-id / x-aod-region / x-aod-subdomain headers
3. AOD Proxy checks CF App health (HTTP GET to app origin)
4a. [App UP] Proxy forwards request to CF App → returns response to User
4b. [App DOWN] AOD Proxy calls CF API to start app, polls until ready, then proxies request
5. AOD Proxy writes access log + analytics + updates idle timer
6. Auto-stop Scheduler reads idle timers, stops apps unused > STOP_APPS_UNUSED_AFTER_HRS via CF API

Style: clean cloud/enterprise architecture diagram, left-to-right or top-to-bottom flow, clearly separate the "request path" from the "background/scheduled path", use different arrow styles for normal requests vs. startup flow. Suitable for a product documentation page.
-->

### Analytics and idle detection

Every request through the proxy records:

- **CSV access log** — per-subaccount file at `LOCAL_STORE_DIR/apps/{region}/{subdomain}/accesslog.csv`; rotated at 2 MB; columns: `requestTime`, `url`, `appId`, `clientIp`, `country`, `countryCode`, `city`, `lat`, `lon`, `userId`, `startupMs`, `totalResponseMs`
- **In-memory analytics ring** — powers the Apps page charts (top apps, top users, hourly request timeline)
- **Last-accessed timestamp** — updated per request; read by the auto-stop scheduler to determine idle age

The caller's geographic location is resolved from the `X-Forwarded-For` header via ip-api.com (cached per /24 subnet) so geo analytics reflect the real user location even when the destination service acts as an intermediary.

---

## Features

- **Apps Overview** (`/apps`) — cross-subaccount view of CF apps across all spaces with `manageDest = true` or `useAOD = true`; shows app name, state (STARTED / STOPPED), space, last activity time, and bound services
- **AOD checkbox per space** — in the Subaccount Detail modal → Overview tab, each space has an **AOD** toggle that controls whether automatic app management is active for that space
- **Auto-stop idle apps** — when `STOP_APPS_UNUSED_AFTER_HRS` is set, the server periodically checks for AOD-managed apps that have been idle longer than the threshold and stops them via the CF API; this keeps dormant apps from consuming quota
- **CF app scan** — the `REFRESH_APPS_INTERVAL_HRS` interval controls how often the server re-scans CF for app state changes; saving the interval in the Variables settings panel restarts the scheduler immediately

---

## Configuration

AOD is configured through space-level toggles in the Subaccount Detail modal and through runtime variables:

### Enabling AOD per space

1. Open the **Config** page (`/config`)
2. Select a subaccount, open its detail modal
3. In the **Overview** tab → Spaces panel, click **Edit**
4. Enable the **AOD** checkbox for one or more spaces
5. Click **Save** — a prompt will appear asking whether to refresh destination data for the updated spaces

### AOD config hierarchy

AOD settings are merged from three sources in priority order (highest wins):

| Priority | Source | How to change |
|----------|--------|---------------|
| 3 — highest | `settings.json → aod` | Config page → AOD settings panel (persisted to `settings.json`) |
| 2 | `CONFIG_JSON → aod` | BTP Cockpit → app → **User Provided Variables**, or `cf set-env btp-admin CONFIG_JSON '{...}'` |
| 1 — lowest | `config.json → aod` | Edit `config.json` and redeploy the MTA |

`settings.json → aod` values are applied only when non-empty; a missing or empty field falls through to the lower-priority source.

### Runtime variables

Set these in `config.json → variables`, as individual environment variables, or via **Config → Settings → Variables**:

| Variable | Default | Description |
|----------|---------|-------------|
| `REFRESH_APPS_INTERVAL_HRS` | — | CF app scan interval in hours. Saving a new value via the Variables settings panel restarts the scheduler immediately. |
| `STOP_APPS_UNUSED_AFTER_HRS` | `0` | Stop AOD-managed apps that have been idle for this many hours. `0` = disabled. |

### Excluding apps from auto-stop

Some apps should never be stopped automatically (e.g. always-on middleware, job schedulers, admin tools). Add them to the `excludeApps` list via the Config page AOD settings panel (persisted to `settings.json → aod`), or in `config.json → aod` / `CONFIG_JSON → aod` for deploy-time defaults:

```json
{
  "aod": {
    "excludeApps": [
      "btp-admin*",
      "*jobscheduler*",
      "my-exact-app-name"
    ]
  }
}
```

Each entry is matched case-insensitively against the app **name** and **GUID**. `*` is a wildcard:

| Pattern | Matches |
|---------|---------|
| `btp-admin*` | Any app whose name starts with `btp-admin` |
| `*jobscheduler*` | Any app whose name contains `jobscheduler` |
| `my-exact-app-name` | Only the app with exactly that name |
| `dc07e659-88ee-*` | An app by partial GUID prefix |

The config is read fresh on each auto-stop cycle, so changes take effect without a restart.

### Restricted subaccounts

AOD is forcibly disabled for subaccounts listed in `RESTRICTED_SUBACCOUNT_IDS`. The `useAOD` flag is always returned as `false` for restricted subaccounts regardless of stored config. See [Destination Management](destination-management.md#restricted-subaccounts) for details.

---

## How auto-stop works

1. The scheduler fires every `REFRESH_APPS_INTERVAL_HRS` hours
2. For each space with `aod = true`, the server fetches the current app list from the CF v3 API
3. Apps that have been in `STOPPED` state — or have had no incoming HTTP requests — for longer than `STOP_APPS_UNUSED_AFTER_HRS` hours are stopped via `POST /v3/actions/stop`
4. Apps matching any pattern in `excludeApps` (by name or GUID) are skipped
5. The action is logged and reflected in the next Apps Overview refresh

> Apps that are already stopped are skipped. Only apps in spaces with the AOD toggle enabled are considered.
