# Audit Log Viewer

> **Storage note:** BTP Admin stores audit log data in the CF app's local filesystem.
> The file system is limited (typically 10 GB disk quota shared with all other stored data).
> Full audit history for many subaccounts over multiple months can easily exceed this limit.
> The Audit Log Viewer is designed for **focused, temporary analysis** — enable it for a
> subaccount, retrieve the relevant time window, investigate, then disable if you no longer
> need ongoing collection. Use `MAX_AUDIT_LOG_STORAGE_DAYS` (see below) to bound how far
> back the retrieval window reaches.

---

## Overview

The Audit Log Viewer fetches event records from the **SAP Audit Log Management Service API**
(`auditlog/v2/auditlogrecords`) for selected subaccounts and stores them locally so you can
search, filter, and browse them without hitting the API on every query.

<!-- SCREENSHOT PLACEHOLDER: Audit Logs overview page showing the timeline bar chart
     (four stacked series per hour), subaccount filter chips, search bar, and latest entries table.
     Capture at /audit-logs after running a refresh for at least two subaccounts. -->

![Audit Log Overview](img/auditlog-overview-v1.9.png)

Four event categories are tracked:

| Category | Label | Colour |
|---|---|---|
| `audit.data-access` | Data Access | Blue |
| `audit.security-events` | Security | Amber |
| `audit.configuration` | Configuration | Purple |
| `audit.data-modification` | Modification | Green |

---

## Prerequisites

Each subaccount you want to collect audit logs for must have an **auditlog-management service
instance** (plan `default`) in one of its CF spaces.

BTP Admin discovers the instance automatically via the CF API using the CF service account
credentials (`CF_USERNAME` / `CF_PASSWORD`). It then locates or creates a service key:

1. If a service key named **`btp-admin-sk`** already exists → use it.
2. If other keys exist → use the first available.
3. If no keys exist → create `btp-admin-sk` automatically and use it.

The plan GUID is cached in `~/.ba/cf_login_tokens.json` (under each region) to avoid a CF API
round-trip on every refresh. Service key credentials are cached in
`~/.ba/auditlog-management-keys.json`, keyed by `{region}/{instanceId}`.

---

## Enabling Audit Log Collection

1. Open **Config → Subaccounts**.
2. Tick the **Aud** checkbox for each subaccount you want to collect logs for.
3. Save the configuration.

Once enabled, the subaccount appears in the Audit Log Viewer's refresh cycle and is visible on
the `/audit-logs` page.

<!-- SCREENSHOT PLACEHOLDER: Config → Subaccounts table with the "Aud" column highlighted.
     Show at least one row with the checkbox ticked.
     Capture at /config (Subaccounts tab). -->

---

## Running a Refresh

### All enabled subaccounts (global refresh)

Click **Refresh** on the Audit Logs overview page (`/audit-logs`). All enabled subaccounts are
fetched **in parallel**. A progress bar shows `Refreshing N/M — alias (page P · last-timestamp) · X.XX% · est. Y min`
as progress accumulates across all SAs. The bar turns green on completion and amber if there
were warnings (e.g. a missing service instance).

### Single subaccount (modal refresh)

Open a subaccount modal → **Audit Log** tab → click the **Refresh** icon button next to the
subaccount name. A thin progress bar below the toolbar shows percentage completion and an ETA
estimated from elapsed time and current progress percentage.

<!-- SCREENSHOT PLACEHOLDER: Subaccount modal Audit Log tab during a single-SA refresh.
     Show the progress bar partially filled, with page number and last-timestamp text.
     Capture while refresh is in progress. -->

![Audit Log Modal](img/auditlog-modal-v1.9.png)
---

## Architecture

```
┌─────────────────────────────────┐
│  AuditLogPage.tsx               │  /audit-logs overview
│  AuditLogTab.tsx                │  subaccount modal tab
└────────────┬────────────────────┘
             │ HTTP / SSE
             ▼
┌─────────────────────────────────┐
│  auditLog.ts route              │
│  GET /api/audit-log/stats       │  chart data (counts from filenames)
│  GET /api/audit-log/search      │  keyword search (reads file content)
│  GET /api/audit-log/records     │  paginated records for modal tab
│  POST /api/audit-log/refresh    │  global + single-SA refresh trigger
└────────────┬────────────────────┘
             │ calls
             ▼
┌─────────────────────────────────┐      ┌──────────────────────────────────┐
│  auditLogService.ts             │─────▶│  localStore/audit-log/           │
│  · getAuditLogCredentials()     │      │    {region}/{subdomain}/         │
│  · getAuditLogToken()           │      │      YYYY-MM-DDTHH_N_N_N_N.json  │
│  · refreshAuditLogs()           │      └──────────────────────────────────┘
│  · refreshSubaccountAuditLogs() │
│  · parseAndSaveRecords()        │
└────────────┬────────────────────┘
             │ HTTPS (Bearer, paginated)
             ▼
┌─────────────────────────────────┐
│  SAP Audit Log Management API   │
│  auditlog/v2/auditlogrecords    │
└─────────────────────────────────┘
```

<!-- DIAGRAM PLACEHOLDER: Replace the ASCII diagram above with a rendered architecture diagram.
     Suggested tool: draw.io / Excalidraw.
     Show: user → AuditLogPage/AuditLogTab → auditLog.ts routes → auditLogService → local filesystem + SAP Audit Log Management API.
     Include the CF API credential discovery path (plan → instance → service key → UAA token). -->

---

## Storage Layout

Audit log files are stored under `{LOCAL_STORE_DIR}/audit-log/{region}/{subdomain}/`.

Each file covers one UTC hour and is named:

```
YYYY-MM-DDTHH_{da}_{se}_{cfg}_{dm}.json
```

where `da` / `se` / `cfg` / `dm` are the counts for data-access, security-events,
configuration, and data-modification events in that hour. The counts are embedded in the
filename so the overview chart can be rendered without reading every file.

Within each file, records are stored as a JSON array, one object per line, sorted by `time`.
If a refresh overlaps an existing hour file, records are merged (deduplicated by `uuid`) and
the filename is updated to reflect the new counts.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MAX_AUDIT_LOG_STORAGE_DAYS` | `90` | How many days back the retrieval window reaches when no existing data is found for a subaccount. On subsequent refreshes the window starts from the timestamp of the last saved record. Set lower to limit disk usage. |

Set variables in **Config → Settings → Variables** or in `config.json → variables`.

---

## Exporting

Click the **Download** (↓) icon button in the subaccount modal Audit Log tab toolbar to export
the currently filtered audit logs as a ZIP file.

The export uses the **From / To** date-time range and any **keywords** currently entered in the
search bar. The exported filename is `audit-log_{region}_{subdomain}.zip`.

### Without keywords

All matching audit log JSON files for the selected time range are packaged into the ZIP. Files
are matched by their UTC hour key (filename prefix), rounded inclusively — so a `From` of
`10:30` includes the `T10` file.

If the matched files total more than **1 GB** (indicating the ZIP would likely exceed 100 MB),
a warning appears:

> _"The selected time range covers N file(s) totalling X.X GB. The export ZIP may exceed
> 100 MB. Consider choosing a smaller time range or entering keywords to filter records."_

You can then **Cancel** and narrow the range, or click **Export anyway** to proceed.

### With keywords

When one or more keywords are entered, only the individual JSON records matching **all**
keywords (case-insensitive AND logic) are extracted from the matching files. The filtered
records are written to a single `audit-export-*.json` file (a valid JSON array), which is
then compressed into the ZIP. The 1 GB size check is skipped because keyword filtering
dramatically reduces the output size.

<!-- SCREENSHOT PLACEHOLDER: Subaccount modal Audit Log tab showing the Export warning banner
     (amber background) with "Export anyway" and "Cancel" buttons.
     Trigger by selecting a wide time range (e.g. 90 days) with no keywords and clicking Export. -->

---

## Searching

### Overview page (`/audit-logs`)

- **Keyword search** — type one or more words separated by spaces in the search box.
  All keywords must appear in a record (case-insensitive AND logic). Matches are highlighted
  in the results table.
- **Duration filter** — select 7 d / 30 d / 90 d to restrict the time window shown in the
  chart and the latest-entries table.
- **Category filter** — click the category chips (Data Access, Security, Config, Modification)
  to toggle visibility.
- **From / To** — use the date-time pickers to restrict to an exact range.

### Per-subaccount tab (modal)

- **Keyword search** — same AND logic as the overview page. Keywords are highlighted in the
  record list.
- **From / To date-time pickers** — restrict records to a custom time range. Both inputs are
  optional; leaving them blank retrieves all stored records for the subaccount.
- **Page size** — select 100 / 200 / 500 / 1 000 records per page. The selection persists in
  browser `localStorage` and is restored when the tab is reopened.
- **Expand a record** — click any row to expand it and see the full record detail including
  all technical fields (`uuid`, `time`, `category`, `orgId`, `spaceId`, `correlationId`, etc.)
  alongside the parsed message body. Click again to collapse.
- **URL sync** — when the subaccount modal is open the browser URL updates to
  `/audit-logs/{region}/{subdomain}[?q=keyword]`. Refreshing the page reopens the same
  subaccount and pre-fills the keyword. Closing the modal restores the overview URL
  (`/audit-logs[?q=...&duration=...]`).

<!-- SCREENSHOT PLACEHOLDER: Subaccount modal Audit Log tab with a search keyword entered,
     showing highlighted matches and one row expanded with full record detail.
     Capture at /config (any subaccount modal → Audit Log tab). -->

---

## Refresh Architecture

### Parallel global refresh

`refreshAuditLogs()` fetches all enabled subaccounts concurrently using `Promise.allSettled`.
Each SA has its own OAuth token obtained from its own UAA endpoint, so their requests are
independent and do not share a rate-limit envelope. If one SA hits HTTP 429 it backs off and
retries without affecting the others.

A shared in-memory `progressMap` (keyed by `{region}/{subdomain}`) tracks each SA's
`processedMinutes` and `totalMinutes`. After every page fetch the global pct is recalculated:

```
globalPct = sum(all SA processedMinutes) / sum(all SA totalMinutes) * 100
```

### Multi-segment fetch per subaccount

Before fetching, `buildSegments(dir)` inspects the existing hourly JSON files in the
subaccount's local store and divides time into segments that cover only the **gaps**:

1. **File discovery** — list files matching `YYYY-MM-DDTHH_*.json`, sort alphabetically
   (= chronological).
2. **Group detection** — files with consecutive hourKeys (gap ≤ 1 h) belong to the same group.
   A gap larger than 1 h starts a new group.
3. **Group boundaries** — the earliest and latest `"time"` fields are extracted from the first
   and last file in each group respectively (regex scan, no full JSON parse).
4. **Segment construction** — given groups G₁ … Gₙ and `maxStart = now − MAX_AUDIT_LOG_STORAGE_DAYS`:

   | Segment | startTs | endTs |
   |---|---|---|
   | Before G₁ | `maxStart` | `G₁.startTs` |
   | G₁ → G₂ | `G₁.endTs` | `G₂.startTs` |
   | … | … | … |
   | After Gₙ | `Gₙ.endTs` | `null` (open-ended) |

   Segments where `startTs ≥ endTs` are discarded. There is always at least one segment
   (the trailing open-ended one).

   If no files exist the single segment is `{ startTs: maxStart, endTs: null }`.

Segments are processed **sequentially** within each subaccount.  For each segment:
- A `time_from / time_to` URL is used for page 1 (SAP returns a preview of the most recent
  records; pct is suppressed on page 1 to avoid a false spike).
- Subsequent pages use the `handle` from the `paging` response header.
- The in-memory streaming buffer is flushed to disk at the end of every segment, preventing
  records from one segment bleeding into hour files that belong to an earlier gap.

### Progress calculation

After each page (page 2+ within a segment) the SA-level pct is calculated as:

```
processedMinutes = completedSegmentMinutes + (lastRecordTime − currentSegment.startTs)
totalMinutes     = Σ countMinutes(seg.startTs, seg.endTs ?? now)   [recalculated each time]
pct              = processedMinutes / totalMinutes × 100            [2 decimal places]
```

`totalMinutes` is **dynamic** because the last segment's `endTs` is `null` (open-ended = now
at calculation time). An ETA is displayed once pct ≥ 0.5%:

```
eta = elapsedTime / pct × 100 − elapsedTime
```

For the global refresh, the same formula applies across all SAs:

```
globalProcessedMinutes = Σ SA processedMinutes
globalTotalMinutes     = Σ SA totalMinutes        [recalculated each time]
globalPct              = globalProcessedMinutes / globalTotalMinutes × 100
```

### SSE event fields (new additions)

| Event | New fields |
|---|---|
| `audit-progress` (global) | `pct`, `processedMinutes`, `totalMinutes`, `eta` (seconds \| null), `lastTime` |
| `audit-sa-progress` (per-SA) | `processedMinutes`, `totalMinutes`, `eta` (seconds \| null) |

### Logging

After every API call the service emits a structured log:
- **DEBUG** (2xx) — `region/subdomain`, `page`, `lastTime`, `pct`, `processedMinutes`, `totalMinutes`, `durationMs`
- **WARN** (4xx) — `region/subdomain`, `status`, `durationMs`
- **ERROR** (5xx) — `region/subdomain`, `status`, `durationMs`

After `buildSegments` resolves, a DEBUG log lists all segments with UTC ISO `startTs` / `endTs`
for each subaccount.

---

## Tips and Limitations

- **Disk quota** — each hour file is typically 50–500 KB depending on event volume. A busy
  subaccount can generate hundreds of files per day. Monitor disk usage with
  `cf app btp-admin` and set `MAX_AUDIT_LOG_STORAGE_DAYS` conservatively.
- **Rate limits** — the Audit Log API enforces per-region rate limits. BTP Admin paginates
  with a short inter-page delay and retries on HTTP 429 with `Retry-After`.
- **Service key auto-creation** — if no service key exists, BTP Admin creates `btp-admin-sk`
  automatically. The key is reused on every subsequent refresh. If you delete it from the CF
  cockpit, it will be re-created on the next refresh.
- **Time zones** — all timestamps are stored and displayed in UTC. The From / To pickers
  accept local browser time and convert to UTC internally.
- **Sync** — audit log files are included in the remote sync batch (`audit-log/` prefix,
  priority 4 in the sync sequence) so a replica instance receives the same data.
