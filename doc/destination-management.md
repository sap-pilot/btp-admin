# Destination Management

A cross-subaccount destination management view at `/destinations`. All subaccounts with `manageDestinations = true` appear as columns, grouped by the same tab/section structure as the Home page. Destinations are categorised into rows:

- **Generic** — `API_[S4|MDG]_[HTTP|RFC]_*`
- **Specific S/4** — other `API_*`
- **Workzone** — `cep-*-runtime`
- **OTHERS** — everything else

<!-- SCREENSHOT PLACEHOLDER: Destination Overview page — cross-subaccount matrix with destination rows grouped by category -->

---

## Features

1. **Destination Overview** — full matrix view; click any cell or subaccount header to open the Subaccount Destinations modal

2. **Refresh** — fetches all destination configurations from the SAP BTP Destination Service API for all managed subaccounts; credentials discovered via CF v3 by service plan GUID and cached in `~/.ba/destination-keys.json`; OAuth2 tokens cached in `~/.ba/destination-tokens.json`; changed destinations produce a field-level diff appended to `{name}.changelog.md`; removed destinations renamed to `{name}.deleted.json`; SSE progress bar shows per-subaccount progress; after each global refresh a `{LOCAL_STORE_DIR}/dest/changelog.md` is written; the file rotates to `changelog.yyyyMMdd-HHmmss.md` when it exceeds 2 MB

3. **Full-text search** — pressing Enter on the search input triggers a server-side scan of all `{LOCAL_STORE_DIR}/dest/` JSON files; results filter the tab/column/row view and highlight matched text; an active-filter chip shows the query and match count

4. **Subaccount Destinations modal** — opened from any destination cell, subaccount header, OTHERS button, or search result:
   - When the subaccount has `manageDest` spaces, the left panel splits into a collapsible space→instance tree (top) and flat destination list (bottom), both vertically resizable
   - Right panel has three deep-linkable tabs (`/destinations/:region/:subdomain/:name/history`, `/test`):
     - **Properties** — editable key/value table; sensitive fields (password, secret, credential) masked with a lock icon and eye-reveal toggle; toolbar: **Create**, **Import** (single or array JSON with pre-flight confirmation), **Export**, **Refresh**, **Select for Compare**, **Delete** (with confirmation), **Reset**, **Save**; inline save result banner (green auto-dismisses, error stays)
     - **History** — field-level diff log prepended on every save, import, and create; shows changed fields with before → after values and author identity
     - **Test** — live HTTP request builder: method selector, URL/path input, editable headers, body textarea; sends a real HTTP request through the destination; response panel shows status badge, duration, headers, and body; supports all auth types including `PrincipalPropagation` via `jwt-bearer` grant; all test state persists across tab switches

5. **Compare Destinations** (`Compare (N) ▾` split-button) — accumulates destinations from any subaccounts; clicking **Compare** opens a full-screen modal with all property keys as rows and one column per destination; differing rows highlighted in amber; cells are editable; per-column **Save** writes back and appends a diff to the destination's changelog

   <!-- SCREENSHOT PLACEHOLDER: Compare Destinations modal — side-by-side property comparison with diff highlighting -->

6. **Change History tab** (`/destinations/change-history`) — global `dest/changelog.md` with color-coded entries (green = created, amber = updated, red = deleted); archive file dropdown; live updates via SSE

---

## Import / Delete

**Import dialog** — pre-flight confirmation shows target scopes and uploaded destinations; sequential PUTs with live progress; completion shows success or error banner; all imports share one grouped changelog entry.

**Delete dialog** — confirmation lists all destinations to be deleted with full path; sequential DELETEs with live progress; each deleted destination gets a changelog entry; destination files renamed to `{name}.deleted.json`.

---

## Prerequisites

- The CF service account (`CF_USERNAME`) must have **Space Developer** on the subaccount's CF org spaces — destination service credentials are discovered via the CF v3 API
- `manageDestinations = true` must be set on the subaccount; individual spaces must have the **Dest** toggle enabled to include their service instances

See [Homepage → Prerequisites](homepage.md#prerequisites) for CF credential setup and [Config & Settings → Subaccount feature flags](config-settings.md#subaccount-feature-flags) for `manageDestinations` and space-level toggles.

---

## Auto-refresh

When the Destination Overview page opens, if the last global refresh is older than `AUTO_GLOBAL_REFRESH_HRS` (default 6 h), a background refresh runs automatically for all subaccounts.

When the Subaccount Destinations modal opens, if the cached data is older than `AUTO_SUBACCOUNT_REFRESH_MINS` (default 10 min), a per-subaccount refresh runs automatically.

Both thresholds can be set in `config.json → variables` or via **Config → Settings → Variables**. Set to `0` to disable.

---

## Remote sync

Destination data (`dest/`) is included in the remote sync manifest and propagated to consumer instances. See [Development → Remote Sync](development.md#remote-sync) for sync configuration.
