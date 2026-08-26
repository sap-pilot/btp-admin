import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { readSubaccounts } from './subaccountsService.js';
import { getLatestStats } from './aodAppsService.js';
import { emitImmediate } from './liveEvents.js';
import { logger } from '../logger.js';

const AOD_APPS_DIR = join(config.LOCAL_STORE_DIR, 'apps');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnalyticsCity    { city: string; lat: number; lon: number; count: number; }
export interface AnalyticsRequest { ts: number; region: string; alias: string; subdomain: string; userId: string; appName?: string; spaceName?: string; }
export interface SubaccountAccess { region: string; subdomain: string; alias: string; appName: string; spaceName: string; lastAccessTs: number; }

export interface AnalyticsPayload {
  totalRequests:    number;
  uniqueUsers:      number;
  startedAppsGb:    number;
  startedAppsCount: number;
  lastUpdated:      number;
  duration:         number;
  cities:           AnalyticsCity[];
  latestRequests:   AnalyticsRequest[];
  subaccountAccess: SubaccountAccess[];
}

// ─── Caches ───────────────────────────────────────────────────────────────────

interface TimedMap<V> { map: Map<string, V>; ts: number; }
const ALIAS_TTL  = 60_000;
const APPMAP_TTL = 60_000;
const CACHE_TTL  = 30_000;

let aliasCache: TimedMap<string> | null = null;
const appMapCache = new Map<string, TimedMap<{ name: string; spaceName: string }>>();
const analyticsCache = new Map<number, { payload: AnalyticsPayload; ts: number }>();

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
    const dir   = join(AOD_APPS_DIR, region, subdomain);
    const files = await readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.deleted')) continue;
      try {
        const d = JSON.parse(await readFile(join(dir, f), 'utf-8')) as { guid?: string; name?: string; spaceName?: string };
        if (d.guid) map.set(d.guid, { name: d.name ?? '', spaceName: d.spaceName ?? '' });
      } catch { /* skip */ }
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
      return { ts: row.ts, region: row.region, alias: aliasMap.get(saKey) ?? row.subdomain, subdomain: row.subdomain, userId: row.userId, appName: meta?.name, spaceName: meta?.spaceName };
    }),
  );

  // Resolve subaccount last access
  const subaccountAccess: SubaccountAccess[] = await Promise.all(
    [...saAccessMap.entries()].map(async ([saKey, { ts, appId }]) => {
      const [region, subdomain] = saKey.split('/') as [string, string];
      let am = perSaAppMaps.get(saKey);
      if (!am) { am = await getAppMap(region, subdomain); perSaAppMaps.set(saKey, am); }
      const meta = am.get(appId);
      return { region, subdomain, alias: aliasMap.get(saKey) ?? subdomain, appName: meta?.name ?? '', spaceName: meta?.spaceName ?? '', lastAccessTs: ts };
    }),
  );
  subaccountAccess.sort((a, b) => b.lastAccessTs - a.lastAccessTs);

  const payload: AnalyticsPayload = {
    totalRequests:    rows.length,
    uniqueUsers:      userSet.size,
    startedAppsGb:    latestStats ? Math.round(latestStats.sumStartedMB / 1024 * 10) / 10 : 0,
    startedAppsCount: latestStats?.startedApps ?? 0,
    lastUpdated:      Date.now(),
    duration:         durationHours,
    cities:           [...cityMap.values()].sort((a, b) => b.count - a.count),
    latestRequests,
    subaccountAccess,
  };

  analyticsCache.set(durationHours, { payload, ts: Date.now() });
  return payload;
}

// Called from aodProxyHandler after each request — fire and forget
export function recordAodRequest(data: {
  region: string; subdomain: string; appId: string; userId: string;
  city: string; lat: number; lon: number; ts: number;
}): void {
  invalidateCache();
  void (async () => {
    try {
      const [aliasMap, appMap] = await Promise.all([getAliasMap(), getAppMap(data.region, data.subdomain)]);
      const saKey   = `${data.region}/${data.subdomain}`;
      const alias   = aliasMap.get(saKey) ?? data.subdomain;
      const meta    = appMap.get(data.appId);
      const event: Record<string, unknown> = {
        type: 'analytics-request',
        ts:        data.ts,
        region:    data.region,
        alias,
        subdomain: data.subdomain,
        userId:    data.userId,
        appName:   meta?.name ?? '',
        spaceName: meta?.spaceName ?? '',
      };
      emitImmediate('aod-apps', event);
    } catch (err) {
      logger.warn({ err }, 'analytics: failed to emit request event');
    }
  })();
}
