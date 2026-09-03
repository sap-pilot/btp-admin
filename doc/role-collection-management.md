# Role Collection Management

A cross-subaccount role collection management view at `/role-collections`. All subaccounts with `manageRoles = true` appear in the overview table.

<!-- SCREENSHOT PLACEHOLDER: Role Collections Overview page — table listing subaccounts with role collection counts -->

---

## Features

1. **Role Collections Overview** — table with region, subdomain, and role collection count; **Browse** opens the per-subaccount modal; SSE progress bar tracks global refresh

2. **Refresh** — fetches all role collections from the XSUAA REST API (`/sap/rest/authorization/v2/rolecollections`); credentials discovered from an `xsuaa/apiaccess` service instance in the org via CF v3; keys cached in `~/.ba/xsuaa-keys.json`; tokens cached in `~/.ba/xsuaa-tokens.json`; changed role collections produce a diff appended to `{safeName}.changelog.md`; removed role collections renamed to `{safeName}.deleted.json`; global `{LOCAL_STORE_DIR}/rcs/changelog.md` updated after each run

3. **Subaccount Role Collections modal**:
   - Left panel: searchable list of all role collections
   - **Details tab** — role references table (template name, app ID, description)
   - **Users tab** — assigned users list with add-user form (email/ID + origin) and per-row remove; changes call the live XSUAA API
   - **Changelog tab** — field-level diff log for every refresh and save

4. **Change History tab** (`/role-collections/change-history`) — global `rcs/changelog.md` with color-coded entries (green = created, amber = updated, red = deleted); archive file dropdown; live updates via SSE

5. **Remote sync** — `rcs/` folder included in sync manifest; role collection data synced to consumer instances alongside destinations and config

---

## Prerequisites

- The CF service account (`CF_USERNAME`) must have **Space Developer** on the subaccount's CF org spaces — the server discovers the `xsuaa/apiaccess` service instance and its service key via the CF v3 API
- `manageRoles = true` must be set on the subaccount (via **Config → Subaccounts** or `subaccounts.json`)

See [Homepage → Prerequisites](homepage.md#prerequisites) for CF credential setup and [Config & Settings → Subaccount feature flags](config-settings.md#subaccount-feature-flags) for the `manageRoles` flag.

---

## Auto-refresh

When the Role Collections Overview page opens, if the last global refresh is older than `AUTO_GLOBAL_REFRESH_HRS` (default 6 h), a background refresh runs automatically for all subaccounts.

When the Subaccount Role Collections modal opens, if the cached data is older than `AUTO_SUBACCOUNT_REFRESH_MINS` (default 10 min), a per-subaccount refresh runs automatically.

Both thresholds can be set in `config.json → variables` or via **Config → Settings → Variables**. Set to `0` to disable.
