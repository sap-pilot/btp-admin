# Homepage

The BTP Admin **Homepage** (`/home`) is a configurable navigation hub for your SAP BTP landscape. Subaccounts are organised into tabs and group sections; each subaccount column renders service links resolved from named URL templates — Cockpit, Launchpad, BAS, Integration Suite, HANA Cloud, and more.

<!-- SCREENSHOT PLACEHOLDER: Homepage — full-page view showing tabs, subaccount columns, and service link rows -->
![BTP Admin Homepage](img/btp-admin-home-v1.2.1.png)

---

## Prerequisites

### CF service account

BTP Admin uses a CF service account to discover subaccounts, spaces, and service instances. Set the following in `server/config.json → variables` or via **Config → Settings → Variables**:

| Variable | Description |
|----------|-------------|
| `CF_USERNAME` | SAP BTP user email (e.g. `svc-btp-admin@your-org.com`) |
| `CF_PASSWORD` | Password for that user |
| `CF_REGIONS` | Comma-separated CF API regions to scan (e.g. `us10,eu10,ap10`) |

Without these credentials, the **Refresh** action in Config → Subaccounts cannot discover subaccounts from SAP BTP, and destination / role collection / user features will not be able to fetch data from the CF API.

> Set these variables in `server/config.json` before the first run, or enter them in **Config → Settings → Variables** after logging in as an admin:
> ```json
> {
>   "variables": {
>     "CF_USERNAME": "svc-btp-admin@your-org.com",
>     "CF_PASSWORD": "your-password",
>     "CF_REGIONS": "us10,eu10"
>   }
> }
> ```

### Space Developer role on all subaccounts

The CF service account (`CF_USERNAME`) must have the **Space Developer** role in every CF space of every subaccount it should manage. This is required for:

- **Homepage** — discovering which subscriptions and services are available in each subaccount
- **Destination Management** — reading and writing destination service credentials, discovering service instances and keys via the CF v3 API
- **Role Collections** — locating the `xsuaa/apiaccess` service instance and reading its service key
- **Users** — using the XSUAA credentials obtained via the service key above
- **Application on Demand** — starting and stopping CF apps via the CF v3 API

Without Space Developer on a space, the corresponding subaccount column will appear on the Homepage but destination, role collection, and user operations will fail with 403 errors from the CF API.

**Assign the role in BTP Cockpit:**  
Subaccount → Cloud Foundry → Spaces → `<space>` → Members → Add Member → Role: **Space Developer**

---

## How the homepage is configured

The homepage layout is driven by three config files managed through the **Config page** (`/config`):

| File | Location | Manages |
|------|----------|---------|
| `subaccounts.json` | `${LOCAL_STORE_DIR}/conf/subaccounts.json` | Which subaccounts appear, their display names, group membership, and feature flags (`manageDestinations`, `manageRoles`) |
| `tabs.json` | `${LOCAL_STORE_DIR}/conf/tabs.json` | Which tabs exist, which subaccount groups appear in each tab, and any banners or tables between groups |
| `settings.json` | `${LOCAL_STORE_DIR}/conf/settings.json` | Cockpit deep-link config, which subscription rows appear on the homepage, and sidebar menu links |

See [Config Page & Settings](config-settings.md) for the full schema of `settings.json` and `tabs.json`.

### Populating subaccounts via Refresh

Instead of editing `subaccounts.json` by hand, use the **Refresh** button in **Config → Subaccounts**:

1. Ensure `CF_USERNAME`, `CF_PASSWORD`, and `CF_REGIONS` are set (see Prerequisites above)
2. Open **Config → Subaccounts**
3. Click **Refresh** — the server calls the SAP BTP Accounts API and CF v3 API to discover all global accounts, subaccounts, orgs, and spaces in the configured regions
4. Discovered subaccounts appear in the table; drag to reorder, edit display names and group IDs inline, then save

### Cockpit deep-links

The **Cockpit** dropdown navigation tree is defined in `server/config/cockpit-menu.json` (committed to the repo). It supports `{placeholder}` substitution (`{cockpitRegion}`, `{globalAccountGUID}`, `{subaccountId}`, `{subdomain}`, `{orgId}`) and `repeatOn: "spaces"` expansion for per-space sub-menus.

Configure the cockpit hostname and IDP via **Config → Settings → Homepage**:

```json
{
  "homepage": {
    "cockpit": {
      "idp": "sap.default",
      "host": "amer.cockpit.btp.cloud.sap"
    }
  }
}
```

---

## Homepage features

- **Filter input** in the title bar — searches all subaccount fields and nested objects in real time with an inline `(X/Y)` counter; clears with the **×** button
- **Subaccount column headers** are clickable — opens the **Subaccount Detail modal** (with Open Cockpit dropdown when cockpit settings are configured)
- **Main subscriptions** — `settings.homepage.mainSubscriptions` controls which subscription rows appear directly on the home page; subscriptions present in the subaccount but not in the list appear in a **More** dropdown per column
- **Sidebar menus** — configurable link groups below the main nav; each menu entry has a text label, a Lucide icon, and submenus with optional `public: true` for unauthenticated visibility
- **Active tab in URL** — reflected as `/home/{tab}` for bookmarking and sharing
