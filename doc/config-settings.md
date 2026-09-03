# Config Page & Settings

The **Config page** (`/config`) is the central place to manage all BTP Admin configuration. It has four tabs:

> **Note on config files:** `subaccounts.json`, `tabs.json`, and `settings.json` are stored on the CF app's local filesystem under `${LOCAL_STORE_DIR}/conf/`. In most circumstances you do not need to edit these files directly — `subaccounts.json` is auto-populated via **Config → Subaccounts → Refresh** (which discovers all global accounts, subaccounts, orgs, and spaces the service account has Space Developer access to), and `tabs.json` / `settings.json` are fully managed through the Config UI. Direct file editing is only needed for development or troubleshooting.

| Tab | Description |
|-----|-------------|
| **Subaccounts** | Manage `subaccounts.json` — run Refresh from SAP BTP + CF API, drag-reorder, view subaccount detail modal with space IDs and cockpit links; SSE progress bar with dismiss button |
| **Tabs / Groups** | Manage `tabs.json` — section editors for `subaccountGroup`, `banner`, and `table` section types |
| **Settings** | Manage `settings.json` — cockpit IDP/host, main subscriptions, sidebar menus, AOD/job variables; drag-reorder menus; save-status banner |
| **Change Log** | Audit trail for all config writes |

A **Preview** toggle in the title bar opens a live home page preview panel alongside the config editor — reflects all unsaved draft changes in real time. The divider between config and preview is draggable.

An **Import** button replaces all three config files (`subaccounts.json`, `tabs.json`, `settings.json`) — keys absent from the import are cleared to empty/defaults; a confirmation dialog summarises what will be replaced before proceeding; every import is diffed against the previous state and appended to `changelog.md`.

---

## settings.json — Cockpit, subscriptions, and sidebar menus

**File location:** `${LOCAL_STORE_DIR}/conf/settings.json`  
(falls back to `server/config/default-settings.json` when not present)

Managed via **Config → Settings**.

```json
{
  "homepage": {
    "cockpit": { "idp": "sap.default", "host": "amer.cockpit.btp.cloud.sap" },
    "mainSubscriptions": [
      { "name": "SAP Business Application Studio", "alias": "BAS" },
      { "name": "SAP Integration Suite", "alias": "IS" }
    ]
  },
  "menus": [
    {
      "text": "Resources",
      "icon": "book-open-text",
      "submenus": [
        { "text": "SAP BTP What's New", "url": "https://help.sap.com/whats-new/...", "public": true }
      ]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `homepage.cockpit.idp` | SAP IAS identity provider alias used in cockpit deep-links (e.g. `sap.default`) |
| `homepage.cockpit.host` | Cockpit hostname (e.g. `amer.cockpit.btp.cloud.sap`) |
| `homepage.mainSubscriptions` | Ordered list of subscription rows shown on the Home page; subscriptions not in the list appear in a **More** dropdown per subaccount column; `alias` is the link label |
| `menus` | Sidebar link groups; `icon` is a Lucide icon name (kebab-case); `submenus[].public: true` shows the link to unauthenticated users |

---

## tabs.json — Tab and group layout

**File location:** `${LOCAL_STORE_DIR}/conf/tabs.json`

Maps subaccounts to homepage tabs and drives the Destination Overview, Role Collections Overview, and Users Overview tab/group layout. Managed via **Config → Tabs / Groups**.

```json
[
  {
    "tab": "Tab Name",
    "sections": [
      { "type": "subaccountGroup", "title": "Optional group heading", "groupId": "my-group" },
      { "type": "banner", "message": "**Note:** some *markdown* text", "backgroundColor": "blue" },
      { "type": "table", "title": "Optional table heading", "tableContent": [["Col A", "Col B"], ["val 1", "val 2"]] }
    ]
  }
]
```

**Section types:**

| `type` | Required fields | Notes |
|--------|-----------------|-------|
| `subaccountGroup` | `groupId` | Renders the subaccount columns whose `groupIds` CSV field contains this `groupId`; `title` is optional |
| `banner` | `message`, `backgroundColor` | `message` supports markdown (bold, italic, links); colors: `transparent` · `blue` · `green` · `yellow` · `red` · `purple` |
| `table` | `tableContent` (2D array) | First row is the header; cells support markdown (e.g. `[text](url)`); `title` is optional |

> **Migration:** existing files using the old `groups: [{groupId, groupTitle}]` format are automatically converted to `sections[]` of type `subaccountGroup` on next read — no manual migration needed.

---

## Variables — runtime overrides

**Config → Settings → Variables** lets admins set per-variable overrides stored in `${LOCAL_STORE_DIR}/conf/settings.json → variables`, which take the highest priority in the lookup chain (above env vars and `config.json`). Changes take effect immediately without restarting the app.

See [Development → Environment Variables](development.md#environment-variables) for the full list of supported variables and their descriptions.

---

## Subaccount feature flags

Feature flags are stored per subaccount in `subaccounts.json` and managed via **Config → Subaccounts**.

| Flag | Description |
|------|-------------|
| `manageDestinations` | Show the subaccount in the Destination Overview (`/destinations`) |
| `manageRoles` | Show the subaccount in Role Collections (`/role-collections`) and Users (`/users`) views |

**Space-level toggles** — in the Subaccount Detail modal → Overview tab → Spaces panel (requires admin role):

| Toggle | Effect |
|--------|--------|
| **Dest** | Includes this space's destination service instances in the Subaccount Destinations modal |
| **AOD** | Enables Application on Demand management for CF apps in this space |

---

## Shared auto-refresh variables

These variables control proactive refresh behaviour across Destinations, Role Collections, and Users:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_SUBACCOUNT_REFRESH_MINS` | `10` | When the Subaccount Destinations or Role Collections modal opens, auto-refresh if cached data is older than this threshold. Fractional values supported (e.g. `0.5` = 30 s). Set to `0` to disable. |
| `AUTO_GLOBAL_REFRESH_HRS` | `6` | When the Destination Overview, Role Collections Overview, or Users Overview page opens, auto-refresh all subaccounts if the last global refresh is older than this threshold. Fractional values supported. Set to `0` to disable. |

Both can be set as environment variables or in `config.json → variables`.

---

## Restricted subaccounts

The `RESTRICTED_SUBACCOUNT_IDS` variable completely blocks destination and AOD features for listed subaccounts.

```
RESTRICTED_SUBACCOUNT_IDS=abc-123-guid:prod-acct,def-456-guid:another-acct
```

Each entry is `{orgGuid}:{label}` — the label is for human reference and stripped during matching. Restricted subaccounts:
- Always have `manageDestinations` and `useAOD` forced to `false` in every API response regardless of stored config
- Are visually marked as **Restricted** in the Config → Subaccounts table, Subaccount Detail modal, and Home page column headers
- Have all CF service credential lookups rejected server-side

The variable can be set as an environment variable or in `config.json → variables`. It is read-only from the Settings panel (update via env var or config file).
