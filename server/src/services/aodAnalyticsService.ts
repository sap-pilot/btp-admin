import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { readSubaccounts } from './subaccountsService.js';
import { getLatestStats } from './appService.js';
import { emitImmediate } from './liveEvents.js';
import { logger } from '../logger.js';

const AOD_APPS_DIR = join(config.LOCAL_STORE_DIR, 'apps');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalyticsCity    { city: string; lat: number; lon: number; count: number; }
export interface AnalyticsRequest { ts: number; region: string; alias: string; subdomain: string; userId: string; appName?: string; spaceName?: string; appGuid?: string; }
export interface SubaccountAccess { region: string; subdomain: string; alias: string; appName: string; spaceName: string; lastAccessTs: number; appGuid?: string; }

export interface AnalyticsPayload {
  totalRequests:      number;
  uniqueUsers:        number;
  startedAppsGb:      number;
  startedAppsCount:   number;
  requestedAppsCount: number;
  latestRequestTs:    number;
  lastUpdated:        number;
  duration:           number;
  cities:             AnalyticsCity[];
  latestRequests:     AnalyticsRequest[];
  subaccountAccess:   SubaccountAccess[];
}

// ─── Caches ───────────────────────────────────────────────────────────────────

interface TimedMap<V> { map: Map<string, V>; ts: number; }
const ALIAS_TTL  = 60_000;
const APPMAP_TTL = 60_000;
const CACHE_TTL  = 30_000;

let aliasCache: TimedMap<string> | null = null;
const appMapCache = new Map<string, TimedMap<{ name: string; spaceName: string }>>();
const analyticsCache = new Map<number, { payload: AnalyticsPayload; ts: number }>();

// In-memory request log — populated at startup from all accesslog.csv files, updated on each AOD request
interface RequestEntry { ts: number; appKey: string; }
let requestLog: RequestEntry[] = [];
let globalLatestTs = 0;

function invalidateCache(): void { analyticsCache.clear(); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let val = ''; i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else val += line[i++];
      }
      fields.push(val);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

async function getAliasMap(): Promise<Map<string, string>> {
  if (aliasCache && Date.now() - aliasCache.ts < ALIAS_TTL) return aliasCache.map;
  const map = new Map<string, string>();
  try {
    const sas = await readSubaccounts();
    for (const sa of sas) map.set(`${sa.region}/${sa.subdomain}`, sa.alias ?? sa.subdomain);
  } catch { /* no-op */ }
  aliasCache = { map, ts: Date.now() };
  return map;
}

async function getAppMap(region: string, subdomain: string): Promise<Map<string, { name: string; spaceName: string }>> {
  const key = `${region}/${subdomain}`;
  const cached = appMapCache.get(key);
  if (cached && Date.now() - cached.ts < APPMAP_TTL) return cached.map;
  const map = new Map<string, { name: string; spaceName: string }>();
  try {
    const saDir = join(AOD_APPS_DIR, region, subdomain);
    // App JSON files are nested: saDir/{spaceName}/{appGuid}.json
    const spaceFolders = await readdir(saDir);
    for (const spaceFolder of spaceFolders) {
      try {
        const spaceDir = join(saDir, spaceFolder);
        const files    = await readdir(spaceDir);
        for (const f of files) {
          if (!f.endsWith('.json') || f.includes('.deleted')) continue;
          try {
            const d = JSON.parse(await readFile(join(spaceDir, f), 'utf-8')) as { guid?: string; name?: string; spaceName?: string };
            if (d.guid) map.set(d.guid, { name: d.name ?? '', spaceName: d.spaceName ?? '' });
          } catch { /* skip corrupted */ }
        }
      } catch { /* skip non-directory entries */ }
    }
  } catch { /* dir may not exist */ }
  appMapCache.set(key, { map, ts: Date.now() });
  return map;
}

// ─── CSV reader ───────────────────────────────────────────────────────────────

interface RawRow { ts: number; appId: string; city: string; lat: number; lon: number; userId: string; region: string; subdomain: string; }

async function readAccessLogs(durationHours: number): Promise<RawRow[]> {
  const cutoff = Math.floor(Date.now() / 1000) - durationHours * 3600;
  const rows: RawRow[] = [];

  let regions: string[];
  try { regions = await readdir(AOD_APPS_DIR); } catch { return rows; }

  for (const region of regions) {
    let subdomains: string[];
    try { subdomains = await readdir(join(AOD_APPS_DIR, region)); } catch { continue; }
    for (const subdomain of subdomains) {
      const csvPath = join(AOD_APPS_DIR, region, subdomain, 'accesslog.csv');
      let content: string;
      try { content = await readFile(csvPath, 'utf-8'); } catch { continue; }

      const lines = content.split('\n');
      let parsed  = false;
      const idx: Record<string, number> = {};
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!parsed) {
          parseCsvLine(trimmed).forEach((f, i) => { idx[f] = i; });
          parsed = true;
          continue;
        }
        const fields = parseCsvLine(trimmed);
        if (fields.length < 2) continue;
        const ts = Number(fields[idx['requestTime'] ?? 0] ?? 0);
        if (!ts || ts < cutoff) continue;
        rows.push({
          ts,
          appId:     fields[idx['appId']  ?? 2] ?? '',
          city:      fields[idx['city']   ?? 4] ?? '',
          lat:       Number(fields[idx['lat']    ?? 5] ?? 0),
          lon:       Number(fields[idx['lon']    ?? 6] ?? 0),
          userId:    fields[idx['userId'] ?? 7] ?? '',
          region,
          subdomain,
        });
      }
    }
  }
  return rows;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Scans all accesslog.csv files at startup to build the in-memory request log.
// Called once from index.ts; subsequent updates come via recordAodRequest.
export async function initRequestLog(): Promise<void> {
  let regions: string[];
  try { regions = await readdir(AOD_APPS_DIR); } catch { return; }

  const perSaAppMaps = new Map<string, Map<string, { name: string; spaceName: string }>>();
  const entries: RequestEntry[] = [];
  let latestTs = 0;

  for (const region of regions) {
    let subdomains: string[];
    try { subdomains = await readdir(join(AOD_APPS_DIR, region)); } catch { continue; }
    for (const subdomain of subdomains) {
      const csvPath = join(AOD_APPS_DIR, region, subdomain, 'accesslog.csv');
      let content: string;
      try { content = await readFile(csvPath, 'utf-8'); } catch { continue; }

      const saKey = `${region}/${subdomain}`;
      let am = perSaAppMaps.get(saKey);
      if (!am) { am = await getAppMap(region, subdomain); perSaAppMaps.set(saKey, am); }

      const lines = content.split('\n');
      let parsed = false;
      const idx: Record<string, number> = {};
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!parsed) {
          parseCsvLine(trimmed).forEach((f, i) => { idx[f] = i; });
          parsed = true;
          continue;
        }
        const fields = parseCsvLine(trimmed);
        if (fields.length < 2) continue;
        const ts = Number(fields[idx['requestTime'] ?? 0] ?? 0);
        if (!ts) continue;
        const appId  = fields[idx['appId'] ?? 2] ?? '';
        const meta   = am.get(appId);
        const appKey = `${region}/${subdomain}/${meta?.spaceName ?? ''}/${meta?.name ?? appId}`;
        entries.push({ ts, appKey });
        if (ts > latestTs) latestTs = ts;
      }
    }
  }

  requestLog      = entries;
  globalLatestTs  = latestTs;
  logger.info({ entries: entries.length, latestTs }, 'analytics: request log initialized');
}

export async function getAnalytics(durationHours: number): Promise<AnalyticsPayload> {
  const hit = analyticsCache.get(durationHours);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.payload;

  const [rows, aliasMap, latestStats] = await Promise.all([
    readAccessLogs(durationHours),
    getAliasMap(),
    getLatestStats(true).catch(() => null),
  ]);

  const cityMap = new Map<string, AnalyticsCity>();
  const userSet = new Set<string>();
  const saAccessMap = new Map<string, { ts: number; appId: string }>();

  for (const row of rows) {
    if (row.userId) userSet.add(row.userId);

    if (row.lat !== 0 || row.lon !== 0) {
      const key = `${row.lat.toFixed(2)},${row.lon.toFixed(2)}`;
      const existing = cityMap.get(key);
      if (existing) existing.count++;
      else cityMap.set(key, { city: row.city || key, lat: row.lat, lon: row.lon, count: 1 });
    }

    const saKey = `${row.region}/${row.subdomain}`;
    const cur = saAccessMap.get(saKey);
    if (!cur || row.ts > cur.ts) saAccessMap.set(saKey, { ts: row.ts, appId: row.appId });
  }

  // Resolve latest requests (most recent 15)
  const sortedRows = [...rows].sort((a, b) => b.ts - a.ts).slice(0, 15);
  const perSaAppMaps = new Map<string, Map<string, { name: string; spaceName: string }>>();
  const latestRequests: AnalyticsRequest[] = await Promise.all(
    sortedRows.map(async (row) => {
      const saKey = `${row.region}/${row.subdomain}`;
      let am = perSaAppMaps.get(saKey);
      if (!am) { am = await getAppMap(row.region, row.subdomain); perSaAppMaps.set(saKey, am); }
      const meta = am.get(row.appId);
      return { ts: row.ts, region: row.region, alias: aliasMap.get(saKey) ?? row.subdomain, subdomain: row.subdomain, userId: row.userId, appName: meta?.name, spaceName: meta?.spaceName, appGuid: row.appId };
    }),
  );

  // Resolve subaccount last access
  const subaccountAccess: SubaccountAccess[] = await Promise.all(
    [...saAccessMap.entries()].map(async ([saKey, { ts, appId }]) => {
      const [region, subdomain] = saKey.split('/') as [string, string];
      let am = perSaAppMaps.get(saKey);
      if (!am) { am = await getAppMap(region, subdomain); perSaAppMaps.set(saKey, am); }
      const meta = am.get(appId);
      return { region, subdomain, alias: aliasMap.get(saKey) ?? subdomain, appName: meta?.name ?? '', spaceName: meta?.spaceName ?? '', lastAccessTs: ts, appGuid: appId };
    }),
  );
  subaccountAccess.sort((a, b) => b.lastAccessTs - a.lastAccessTs);

  const cutoffSecs = Math.floor(Date.now() / 1000) - durationHours * 3600;
  const requestedAppsSet = new Set(requestLog.filter(e => e.ts >= cutoffSecs).map(e => e.appKey));

  const payload: AnalyticsPayload = {
    totalRequests:      rows.length,
    uniqueUsers:        userSet.size,
    startedAppsGb:      latestStats ? Math.round(latestStats.sumStartedMB / 1024 * 10) / 10 : 0,
    startedAppsCount:   latestStats?.startedApps ?? 0,
    requestedAppsCount: requestedAppsSet.size,
    latestRequestTs:    globalLatestTs,
    lastUpdated:        Date.now(),
    duration:           durationHours,
    cities:             [...cityMap.values()].sort((a, b) => b.count - a.count),
    latestRequests,
    subaccountAccess,
  };

  analyticsCache.set(durationHours, { payload, ts: Date.now() });
  return payload;
}

// Incrementally update all cached analytics payloads with one new request, then emit SSE.
// Called fire-and-forget from aodProxyHandler after each proxied request.
export function recordAodRequest(data: {
  region: string; subdomain: string; appId: string; userId: string;
  city: string; lat: number; lon: number; ts: number;
}): void {
  void (async () => {
    try {
      const [aliasMap, appMap] = await Promise.all([getAliasMap(), getAppMap(data.region, data.subdomain)]);
      const saKey  = `${data.region}/${data.subdomain}`;
      const alias  = aliasMap.get(saKey) ?? data.subdomain;
      const meta   = appMap.get(data.appId);
      const hasGeo = data.lat !== 0 || data.lon !== 0;
      const geoKey = hasGeo ? `${data.lat.toFixed(2)},${data.lon.toFixed(2)}` : null;

      const request: AnalyticsRequest = {
        ts:        data.ts,
        region:    data.region,
        alias,
        subdomain: data.subdomain,
        userId:    data.userId,
        appName:   meta?.name,
        spaceName: meta?.spaceName,
        appGuid:   data.appId,
      };

      // Update in-memory request log
      const appKey = `${data.region}/${data.subdomain}/${meta?.spaceName ?? ''}/${meta?.name ?? data.appId}`;
      requestLog.push({ ts: data.ts, appKey });
      if (data.ts > globalLatestTs) globalLatestTs = data.ts;

      // Incrementally update every cached payload — the new request is always within any window
      for (const entry of analyticsCache.values()) {
        const p = entry.payload;
        p.totalRequests++;
        p.lastUpdated    = Date.now();
        p.latestRequestTs = globalLatestTs;

        if (hasGeo && geoKey) {
          const c = p.cities.find(x => `${x.lat.toFixed(2)},${x.lon.toFixed(2)}` === geoKey);
          if (c) c.count++;
          else p.cities.push({ city: data.city || geoKey, lat: data.lat, lon: data.lon, count: 1 });
        }

        p.latestRequests = [request, ...p.latestRequests].slice(0, 15);

        const sa = p.subaccountAccess.find(a => a.region === data.region && a.subdomain === data.subdomain);
        if (sa) {
          sa.lastAccessTs = data.ts;
          sa.appGuid      = data.appId;
          if (meta?.name)      sa.appName   = meta.name;
          if (meta?.spaceName) sa.spaceName = meta.spaceName;
        } else {
          p.subaccountAccess.push({ region: data.region, subdomain: data.subdomain, alias, appName: meta?.name ?? '', spaceName: meta?.spaceName ?? '', lastAccessTs: data.ts, appGuid: data.appId });
          p.subaccountAccess.sort((a, b) => b.lastAccessTs - a.lastAccessTs);
        }
      }

      // Emit delta — client applies it to its local state
      const event: Record<string, unknown> = { type: 'analytics-update', request };
      if (hasGeo) event['city'] = { city: data.city || geoKey, lat: data.lat, lon: data.lon };
      event['subaccountUpdate'] = { region: data.region, subdomain: data.subdomain, alias, appName: meta?.name ?? '', spaceName: meta?.spaceName ?? '', lastAccessTs: data.ts, appGuid: data.appId };
      emitImmediate('aod-apps', event);
    } catch (err) {
      logger.warn({ err }, 'analytics: failed to update cache / emit SSE');
    }
  })();
}
