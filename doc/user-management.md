# User Management

A cross-subaccount user management view at `/users`. All subaccounts with `manageRoles = true` appear, grouped by the same tab/section structure as the Home page. Each subaccount column shows the 16 most-recently-logged-on users (email + last logon time).

<!-- SCREENSHOT PLACEHOLDER: Users Overview page — cross-subaccount view with recently logged-on users per column -->

---

## Features

1. **Users Overview** — cross-subaccount view; global **Refresh** with SSE progress bar; **Change History** tab showing `users/changelog.md`; live updates via SSE; auto global refresh on page open when stale

2. **Refresh** — fetches all XSUAA users via SCIM API (`count=500`, paginated via `startIndex`); records sharing the same `origin + email` key but with different internal IDs are deduplicated before storage (latest `meta.lastModified` wins); changed user records produce a field-level diff (ignoring `passwordLastModified`, `previousLogonTime`, `lastLogonTime`) appended to `{email}.changelog.md`; removed users renamed to `{email}.deleted.json`; global `users/changelog.md` updated after each run (rotates at 2 MB)

3. **Subaccount Users modal**:
   - Left panel: filter input + scrollable user list (sorted by last logon time descending)
   - **User Detail tab** — all XSUAA user attributes (ID, username, name, emails, active, verified, origin, zone ID, group count, logon timestamps, meta dates)
   - **Global Access tab** — collapsible tree of every subaccount where this user appears, with their group assignments (`value / display / type`); all rows expanded by default
   - **Change History tab** — per-user field-level diff log for every refresh; `+` lines green, `-` lines red
   - **Export** — downloads the full stored user JSON as `{region}_{subdomain}_{origin}_{email}.json`
   - **Refresh** — per-subaccount refresh with inline progress banner (auto-dismisses after 3 s on success)

4. **Full-text search** (`/api/users/search?q=`) — server-side scan of all user JSON files; matches `userName`, `emails[].value`, `name.givenName`, `name.familyName`, `origin`, `groups[].display`

5. **Remote sync** — `users/` folder included in sync manifest; `globalUsersRefreshTs` restored at startup by parsing the topmost header in `users/changelog.md`

---

## Prerequisites

- The CF service account (`CF_USERNAME`) must have **Space Developer** on the subaccount's CF org spaces — the server reuses the same `xsuaa/apiaccess` service key discovered for role collections
- `manageRoles = true` must be set on the subaccount (shared with Role Collections)

See [Homepage → Prerequisites](homepage.md#prerequisites) for CF credential setup and [Config & Settings → Subaccount feature flags](config-settings.md#subaccount-feature-flags) for the `manageRoles` flag.

---

## Auto-refresh

When the Users Overview page opens, if the last global refresh is older than `AUTO_GLOBAL_REFRESH_HRS` (default 6 h), a background refresh runs automatically for all subaccounts.

Both thresholds can be set in `config.json → variables` or via **Config → Settings → Variables**. Set to `0` to disable.
