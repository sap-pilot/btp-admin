import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
import { config } from '../config.js';
import { logger } from '../logger.js';
import { readSubaccounts } from './subaccountsService.js';
import { getOrRefreshToken } from './cfLoginService.js';
import { readAodConfig } from './aodConfigService.js';
import { emitImmediate } from './liveEvents.js';

const APPS_DIR = join(config.LOCAL_STORE_DIR, 'apps');
const STATS_ROTATE_BYTES = 2 * 1024 * 1024;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let refreshRunning = false;
let topAppsCache:   SubaccountTopApps[] | null = null;

export function isRefreshRunning(): boolean  { return refreshRunning; }
export function getCachedTopApps(): SubaccountTopApps[] { return topAppsCache ?? []; }
export function invalidateTopAppsCache(): void { topAppsCache = null; }

export async function refreshTopAppsAndNotify(): Promise<void> {
  try { topAppsCache = await buildTopApps(); } catch { /* keep stale */ }
  emitImmediate('aod-apps', { type: 'app-state-changed' });
}

export async function updateAppFileState(guid: string, region: string, subdomain: string, newState: string): Promise<void> {
  const filePath = await findAppFile(guid, region, subdomain);
  if (!filePath) return;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const obj = JSON.parse(raw) as AppFile;
    obj.state = newState;
    await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err, guid, region, subdomain }, 'AOD: failed to update app state in JSON');
  }
}

// ─── CF API helpers ───────────────────────────────────────────────────────────

async function cfGet(region: string, path: string): Promise<unknown> {
  const token = await getOrRefreshToken(region);
  const url   = `${token.api_url}${path}`;
  const res   = await fetch(url, {
    headers: { Authorization: `${token.token_type} ${token.access_token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CF API ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function cfGetAll<T>(region: string, basePath: string): Promise<T[]> {
  const results: T[] = [];
  let nextPath: string | null = basePath;
  while (nextPath) {
    const data = await cfGet(region, nextPath) as {
      resources: T[];
      pagination?: { next?: { href?: string } | null };
    };
    results.push(...data.resources);
    const href = data.pagination?.next?.href;
    if (!href) break;
    const u = new URL(href);
    nextPath = u.pathname + u.search;
  }
  return results;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CfApp {
  guid:          string;
  name:          string;
  state:         string;
  relationships: { space: { data: { guid: string } } };
}

interface CfProcess {
  type:          string;
  instances:     number;
  memory_in_mb:  number;
  disk_in_mb:    number;
  relationships: { app: { data: { guid: string } } };
}

interface CfRoute {
  url:          string;
  destinations?: Array<{ app: { guid: string } }>;
}

export interface AppFileData {
  guid:          string;
  name:          string;
  state:         string;
  spaceGuid:     string;
  region:        string;
  subdomain:     string;
  spaceName:     string;
  process?:      { type: string; instances: number; memory_in_mb: number; disk_in_mb: number };
  aod?:          boolean;
  urls?:         string[];
  lastUpdated:   number;
  lastAccessed?: number;
}
type AppFile = AppFileData;

export interface StatsRow {
  timestamp:    number;
  startedApps:  number;
  stoppedApps:  number;
  sumStartedMB: number;
  sumStoppedMB: number;
}

// ─── Stats CSV ────────────────────────────────────────────────────────────────

function sanitizeName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_');
}

const STATS_HEADER = '"timestamp","startedApps","stoppedApps","sumStartedMB","sumStoppedMB"\n';

async function appendStatsFile(filename: string, row: StatsRow): Promise<void> {
  const filePath = join(APPS_DIR, filename);
  await mkdir(APPS_DIR, { recursive: true });

  try {
    const info = await stat(filePath);
    if (info.size >= STATS_ROTATE_BYTES) {
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const rotated = filename.replace(/\.csv$/, `.${dateStr}.csv`);
      await rename(filePath, join(APPS_DIR, rotated));
    }
  } catch { /* file may not exist yet */ }

  let needsHeader = false;
  try { await stat(filePath); } catch { needsHeader = true; }

  const line = `${row.timestamp},${row.startedApps},${row.stoppedApps},${row.sumStartedMB},${row.sumStoppedMB}\n`;
  await appendFile(filePath, needsHeader ? STATS_HEADER + line : line, 'utf-8');
}

function parseStatsLine(line: string): StatsRow | null {
  if (!line || /^["t]/.test(line)) return null;
  const parts = line.split(',');
  if (parts.length < 5) return null;
  const ts = Number(parts[0]);
  if (isNaN(ts) || ts <= 0) return null;
  return {
    timestamp:    ts,
    startedApps:  Number(parts[1]) || 0,
    stoppedApps:  Number(parts[2]) || 0,
    sumStartedMB: Number(parts[3]) || 0,
    sumStoppedMB: Number(parts[4]) || 0,
  };
}

function statsFilename(aodOnly: boolean): string {
  return aodOnly ? 'aod-stats.csv' : 'stats.csv';
}

export async function getStatsData(fromSecs: number, toSecs: number, aodOnly = false): Promise<StatsRow[]> {
  const filePath = join(APPS_DIR, statsFilename(aodOnly));
  let raw = '';
  try { raw = await readFile(filePath, 'utf-8'); } catch { return []; }

  const rows: StatsRow[] = [];
  for (const line of raw.split('\n')) {
    const row = parseStatsLine(line);
    if (row && row.timestamp >= fromSecs && row.timestamp <= toSecs) rows.push(row);
  }
  return rows;
}

export async function getLatestStats(aodOnly = false): Promise<StatsRow | null> {
  const filePath = join(APPS_DIR, statsFilename(aodOnly));
  let raw = '';
  try { raw = await readFile(filePath, 'utf-8'); } catch { return null; }

  let latest: StatsRow | null = null;
  for (const line of raw.split('\n')) {
    const row = parseStatsLine(line);
    if (row && (!latest || row.timestamp > latest.timestamp)) latest = row;
  }
  return latest;
}

// ─── Top apps per subaccount ─────────────────────────────────────────────────

export interface AppTopEntry {
  guid:         string;
  name:         string;
  spaceName:    string;
  memoryMB:     number;
  state?:       string;
  aod?:         boolean;
  lastAccessed?: number;
}

export interface SubaccountTopApps {
  region:         string;
  subdomain:      string;
  subaccountName: string;
  alias:          string;
  apps:           AppTopEntry[];
}

async function buildTopApps(): Promise<SubaccountTopApps[]> {
  const subaccounts = await readSubaccounts();
  const result: SubaccountTopApps[] = [];

  for (const sa of subaccounts) {
    if (sa.restricted) continue;
    const saDir = join(APPS_DIR, sa.region, sa.subdomain);
    const apps: AppTopEntry[] = [];

    try {
      const spaces = await readdir(saDir);
      for (const spaceFolder of spaces) {
        const spaceDir = join(saDir, spaceFolder);
        try {
          const files = await readdir(spaceDir);
          for (const file of files) {
            if (!file.endsWith('.json') || file.endsWith('.deleted.json')) continue;
            try {
              const raw = await readFile(join(spaceDir, file), 'utf-8');
              const app = JSON.parse(raw) as AppFile;
              // Include started apps always; include stopped apps only when they have AOD enabled
              if (app.state !== 'STARTED' && !app.aod) continue;
              const memoryMB = (app.process?.instances ?? 1) * (app.process?.memory_in_mb ?? 0);
              apps.push({ guid: app.guid, name: app.name, spaceName: app.spaceName, memoryMB, state: app.state, aod: app.aod, lastAccessed: (app as AppFileData).lastAccessed });
            } catch { /* skip corrupted file */ }
          }
        } catch { /* skip unreadable space dir */ }
      }
    } catch { /* dir not yet created */ }

    apps.sort((a, b) => b.memoryMB - a.memoryMB);
    result.push({
      region:         sa.region,
      subdomain:      sa.subdomain,
      subaccountName: sa.subaccountName,
      alias:          sa.alias,
      apps,
    });
  }

  return result;
}

async function doRefreshTopAppsCache(): Promise<void> {
  try { topAppsCache = await buildTopApps(); } catch { /* keep stale */ }
}

export async function getTopAppsPerSubaccount(): Promise<SubaccountTopApps[]> {
  if (topAppsCache !== null) return topAppsCache;
  topAppsCache = await buildTopApps();
  return topAppsCache;
}

export async function getSubaccountApps(region: string, subdomain: string): Promise<AppFileData[]> {
  const saDir = join(APPS_DIR, region, subdomain);
  const apps: AppFileData[] = [];
  try {
    const spaces = await readdir(saDir);
    for (const spaceFolder of spaces) {
      const spaceDir = join(saDir, spaceFolder);
      try {
        const files = await readdir(spaceDir);
        for (const file of files) {
          if (!file.endsWith('.json') || file.endsWith('.deleted.json')) continue;
          try {
            const raw = await readFile(join(spaceDir, file), 'utf-8');
            apps.push(JSON.parse(raw) as AppFileData);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* dir not yet created */ }
  return apps;
}

export async function searchApps(keyword: string): Promise<SubaccountTopApps[]> {
  let matchedPaths: string[] = [];
  try {
    const { stdout } = await execFileAsync('grep', ['-rl', '--include=*.json', '--', keyword, APPS_DIR]);
    matchedPaths = stdout.trim().split('\n').filter(p =>
      p && p.endsWith('.json') && !p.endsWith('.deleted.json') &&
      // only app files: APPS_DIR/{region}/{subdomain}/{space}/{guid}.json  (depth 4)
      p.slice(APPS_DIR.length).split('/').length === 5,
    );
  } catch { return []; }

  const subaccounts = await readSubaccounts();
  const saLookup = new Map(subaccounts.filter(sa => !sa.restricted).map(sa => [`${sa.region}/${sa.subdomain}`, sa]));
  const byKey = new Map<string, { region: string; subdomain: string; subaccountName: string; alias: string; apps: AppTopEntry[] }>();

  for (const filePath of matchedPaths) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const app = JSON.parse(raw) as AppFileData;
      const key = `${app.region}/${app.subdomain}`;
      const sa  = saLookup.get(key);
      if (!sa) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { region: sa.region, subdomain: sa.subdomain, subaccountName: sa.subaccountName, alias: sa.alias, apps: [] };
        byKey.set(key, entry);
      }
      const memoryMB = (app.process?.instances ?? 1) * (app.process?.memory_in_mb ?? 0);
      entry.apps.push({ guid: app.guid, name: app.name, spaceName: app.spaceName, memoryMB, state: app.state, aod: app.aod, lastAccessed: app.lastAccessed });
    } catch { /* skip */ }
  }

  return [...byKey.values()];
}

// ─── App file helpers ──────────────────────────────────────────────────────────

// Find appGuid.json under APPS_DIR/region/subdomain/*/
async function findAppFile(appGuid: string, region: string, subdomain: string): Promise<string | null> {
  const searchDir = join(APPS_DIR, region, subdomain);
  const target    = `${appGuid}.json`;
  try {
    const spaces = await readdir(searchDir);
    for (const space of spaces) {
      const candidate = join(searchDir, space, target);
      try { await stat(candidate); return candidate; } catch { /* not here */ }
    }
  } catch { /* dir not yet created */ }
  return null;
}

// Update appGuid.json->urls and ->aod after a destination AOD install/uninstall.
export async function updateAppFileAod(
  appGuid:      string,
  region:       string,
  subdomain:    string,
  destUrl:      string,
  aodInstalled: boolean,
): Promise<void> {
  if (!appGuid || !destUrl) return;
  const filePath = await findAppFile(appGuid, region, subdomain);
  if (!filePath) return;
  try {
    const raw      = await readFile(filePath, 'utf-8');
    const obj      = JSON.parse(raw) as AppFile;
    const curUrls  = obj.urls ?? [];
    if (aodInstalled) {
      obj.urls = curUrls.includes(destUrl) ? curUrls : [...curUrls, destUrl];
      obj.aod  = true;
    } else {
      obj.urls = curUrls.filter(u => u !== destUrl);
      obj.aod  = obj.urls.length > 0;
    }
    await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
    logger.debug({ appGuid, aodInstalled, destUrl }, 'AOD: app JSON updated');
  } catch (err) {
    logger.warn({ err, appGuid, region, subdomain }, 'AOD: failed to update app JSON');
  }
}

// Update lastAccessed timestamp in appGuid.json — called fire-and-forget on each AOD proxy hit.
export async function touchAppLastAccessed(appGuid: string, region: string, subdomain: string, ts: number): Promise<void> {
  const filePath = await findAppFile(appGuid, region, subdomain);
  if (!filePath) return;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const obj = JSON.parse(raw) as AppFileData;
    obj.lastAccessed = ts;
    await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
    topAppsCache = null; // invalidate so next fetch picks up the new timestamp
  } catch (err) {
    logger.warn({ err, appGuid, region, subdomain }, 'AOD: failed to touch lastAccessed');
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

export async function scanApps(): Promise<void> {
  if (refreshRunning) {
    logger.warn('AOD apps scan already in progress, skipping');
    return;
  }
  refreshRunning = true;
  emitImmediate('aod-apps', { type: 'refresh-start', ts: Date.now() });
  logger.info('AOD apps scan started');

  try {
    const subaccounts = await readSubaccounts();

    // Build space map: spaceGuid → { region, subdomain, spaceName }
    // Include ALL spaces from non-restricted subaccounts that have CF orgs
    const spaceMap = new Map<string, { region: string; subdomain: string; spaceName: string }>();
    for (const sa of subaccounts) {
      if (sa.restricted) continue;
      for (const sp of sa.org?.spaces ?? []) {
        spaceMap.set(sp.spaceId, { region: sa.region, subdomain: sa.subdomain, spaceName: sp.spaceName });
      }
    }

    if (spaceMap.size === 0) {
      logger.info('AOD apps scan: no CF spaces found');
      emitImmediate('aod-apps', { type: 'refresh-done', ts: Date.now(), allStats: null, aodStats: null });
      return;
    }

    // Pre-scan existing .json files per space for deletion tracking
    const existingBySpace = new Map<string, Set<string>>();
    for (const [spaceGuid, { region, subdomain, spaceName }] of spaceMap) {
      const dir = join(APPS_DIR, region, subdomain, sanitizeName(spaceName));
      try {
        const files = await readdir(dir);
        const guids = new Set<string>();
        for (const f of files) {
          if (f.endsWith('.json') && !f.endsWith('.deleted.json')) guids.add(f.slice(0, -5));
        }
        existingBySpace.set(spaceGuid, guids);
      } catch { /* dir not yet created */ }
    }

    // Group space guids by region
    const byRegion = new Map<string, string[]>();
    for (const [spaceGuid, { region }] of spaceMap) {
      const list = byRegion.get(region);
      if (list) list.push(spaceGuid);
      else byRegion.set(region, [spaceGuid]);
    }

    const seenAppGuids      = new Set<string>();
    const successfulRegions = new Set<string>();
    const totalRegions      = byRegion.size;
    let   doneRegions       = 0;

    let totalStarted = 0, totalStopped = 0, sumStartedMB = 0, sumStoppedMB = 0;
    let aodStarted   = 0, aodStopped   = 0, aodStartedMB = 0, aodStoppedMB = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const [region, spaceGuids] of byRegion) {
      try {
        const spaceGuidsParam = spaceGuids.join(',');
        const [apps, processes, routes] = await Promise.all([
          cfGetAll<CfApp>(region, `/v3/apps?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
          cfGetAll<CfProcess>(region, `/v3/processes?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
          cfGetAll<CfRoute>(region, `/v3/routes?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
        ]);

        // Process map: appGuid → web process (prefer type=web)
        const processMap = new Map<string, CfProcess>();
        for (const p of processes) {
          const ag = p.relationships.app.data.guid;
          if (!processMap.has(ag) || p.type === 'web') processMap.set(ag, p);
        }

        // Routes map: appGuid → array of https:// URLs
        const routesByApp = new Map<string, string[]>();
        for (const route of routes) {
          for (const dest of route.destinations ?? []) {
            const guid = dest.app.guid;
            const url  = `https://${route.url}`;
            const existing = routesByApp.get(guid);
            if (existing) existing.push(url);
            else routesByApp.set(guid, [url]);
          }
        }

        for (const app of apps) {
          const spaceGuid = app.relationships.space.data.guid;
          const meta      = spaceMap.get(spaceGuid);
          if (!meta) continue;

          const { subdomain, spaceName } = meta;
          const dir = join(APPS_DIR, region, subdomain, sanitizeName(spaceName));
          await mkdir(dir, { recursive: true });

          // Preserve existing aod flag from prior JSON; urls are replaced by CF routes
          let existingAod = false;
          try {
            const existing = JSON.parse(await readFile(join(dir, `${app.guid}.json`), 'utf-8')) as AppFile;
            existingAod = existing.aod ?? false;
          } catch { /* new file */ }

          const proc    = processMap.get(app.guid);
          const appFile: AppFile = {
            guid: app.guid, name: app.name, state: app.state,
            spaceGuid, region, subdomain, spaceName,
            process: proc ? {
              type: proc.type, instances: proc.instances,
              memory_in_mb: proc.memory_in_mb, disk_in_mb: proc.disk_in_mb,
            } : undefined,
            aod: existingAod,
            urls: routesByApp.get(app.guid) ?? [],
            lastUpdated: now,
          };

          await writeFile(join(dir, `${app.guid}.json`), JSON.stringify(appFile, null, 2), 'utf-8');
          seenAppGuids.add(app.guid);

          const memMB = (proc?.instances ?? 1) * (proc?.memory_in_mb ?? 0);
          if (app.state === 'STARTED') {
            totalStarted++; sumStartedMB += memMB;
            if (existingAod) { aodStarted++; aodStartedMB += memMB; }
          } else {
            totalStopped++; sumStoppedMB += memMB;
            if (existingAod) { aodStopped++; aodStoppedMB += memMB; }
          }
        }

        successfulRegions.add(region);
        doneRegions++;
        logger.info({ region, apps: apps.length }, 'AOD apps scan: region complete');
        emitImmediate('aod-apps', { type: 'refresh-progress', current: doneRegions, total: totalRegions, region });
      } catch (err) {
        doneRegions++;
        logger.error({ err, region }, 'AOD apps scan: region failed, skipping deletion tracking');
        emitImmediate('aod-apps', { type: 'refresh-progress', current: doneRegions, total: totalRegions, region, error: true });
      }
    }

    // Mark apps not seen in scan as deleted (only for successfully scanned regions)
    for (const [spaceGuid, { region, subdomain, spaceName }] of spaceMap) {
      if (!successfulRegions.has(region)) continue;
      const dir      = join(APPS_DIR, region, subdomain, sanitizeName(spaceName));
      const existing = existingBySpace.get(spaceGuid) ?? new Set<string>();
      for (const guid of existing) {
        if (!seenAppGuids.has(guid)) {
          try {
            await rename(join(dir, `${guid}.json`), join(dir, `${guid}.deleted.json`));
            logger.debug({ region, subdomain, spaceName, guid }, 'AOD: app marked deleted');
          } catch { /* may already be gone */ }
        }
      }
    }

    const allRow: StatsRow = { timestamp: now, startedApps: totalStarted, stoppedApps: totalStopped, sumStartedMB, sumStoppedMB };
    const aodRow: StatsRow = { timestamp: now, startedApps: aodStarted,   stoppedApps: aodStopped,   sumStartedMB: aodStartedMB, sumStoppedMB: aodStoppedMB };

    await Promise.all([appendStatsFile('stats.csv', allRow), appendStatsFile('aod-stats.csv', aodRow)]);

    logger.info({ totalStarted, totalStopped, sumStartedMB, sumStoppedMB, aodStarted, aodStopped }, 'AOD apps scan complete');
    await doRefreshTopAppsCache();
    emitImmediate('aod-apps', { type: 'refresh-done', ts: Date.now(), allStats: allRow, aodStats: aodRow });
  } catch (err) {
    logger.error({ err }, 'AOD apps scan failed');
    emitImmediate('aod-apps', { type: 'refresh-error', ts: Date.now(), error: String(err) });
  } finally {
    refreshRunning = false;
  }
}

// ─── Per-subaccount scan ──────────────────────────────────────────────────────

export interface SubaccountScanResult {
  updated: number;
  created: number;
  deleted: number;
}

export async function scanSubaccountApps(region: string, subdomain: string): Promise<SubaccountScanResult> {
  const subaccounts = await readSubaccounts();
  const sa = subaccounts.find(s => s.region === region && s.subdomain === subdomain);
  if (!sa || sa.restricted) throw new Error('Subaccount not found or restricted');

  const spaces = sa.org?.spaces ?? [];
  if (spaces.length === 0) return { updated: 0, created: 0, deleted: 0 };

  const spaceGuids = spaces.map(sp => sp.spaceId);
  const spaceGuidsParam = spaceGuids.join(',');
  const spaceMap = new Map(spaces.map(sp => [sp.spaceId, sp.spaceName]));

  const [apps, processes, routes] = await Promise.all([
    cfGetAll<CfApp>(region, `/v3/apps?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
    cfGetAll<CfProcess>(region, `/v3/processes?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
    cfGetAll<CfRoute>(region, `/v3/routes?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
  ]);

  const processMap = new Map<string, CfProcess>();
  for (const p of processes) {
    const ag = p.relationships.app.data.guid;
    if (!processMap.has(ag) || p.type === 'web') processMap.set(ag, p);
  }

  const routesByApp = new Map<string, string[]>();
  for (const route of routes) {
    for (const dest of route.destinations ?? []) {
      const guid = dest.app.guid;
      const url  = `https://${route.url}`;
      const existing = routesByApp.get(guid);
      if (existing) existing.push(url);
      else routesByApp.set(guid, [url]);
    }
  }

  // Pre-scan existing JSON files per space
  const existingBySpace = new Map<string, Set<string>>();
  for (const [spaceGuid, spaceName] of spaceMap) {
    const dir = join(APPS_DIR, region, subdomain, sanitizeName(spaceName));
    try {
      const files = await readdir(dir);
      const guids = new Set(files.filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json')).map(f => f.slice(0, -5)));
      existingBySpace.set(spaceGuid, guids);
    } catch { /* dir not yet created */ }
  }

  const now        = Math.floor(Date.now() / 1000);
  const seenGuids  = new Set<string>();
  let updated = 0, created = 0;

  for (const app of apps) {
    const spaceName = spaceMap.get(app.relationships.space.data.guid);
    if (!spaceName) continue;

    const dir = join(APPS_DIR, region, subdomain, sanitizeName(spaceName));
    await mkdir(dir, { recursive: true });

    const existing = existingBySpace.get(app.relationships.space.data.guid);
    const isNew = !existing?.has(app.guid);

    let existingAod = false;
    try {
      const raw = JSON.parse(await readFile(join(dir, `${app.guid}.json`), 'utf-8')) as AppFile;
      existingAod = raw.aod ?? false;
    } catch { /* new file */ }

    const proc = processMap.get(app.guid);
    const appFile: AppFile = {
      guid: app.guid, name: app.name, state: app.state,
      spaceGuid: app.relationships.space.data.guid, region, subdomain, spaceName,
      process: proc ? { type: proc.type, instances: proc.instances, memory_in_mb: proc.memory_in_mb, disk_in_mb: proc.disk_in_mb } : undefined,
      aod: existingAod,
      urls: routesByApp.get(app.guid) ?? [],
      lastUpdated: now,
    };

    await writeFile(join(dir, `${app.guid}.json`), JSON.stringify(appFile, null, 2), 'utf-8');
    seenGuids.add(app.guid);
    if (isNew) created++; else updated++;
  }

  // Mark disappeared apps as deleted
  let deleted = 0;
  for (const [spaceGuid, spaceName] of spaceMap) {
    const dir      = join(APPS_DIR, region, subdomain, sanitizeName(spaceName));
    const existing = existingBySpace.get(spaceGuid) ?? new Set<string>();
    for (const guid of existing) {
      if (!seenGuids.has(guid)) {
        try {
          await rename(join(dir, `${guid}.json`), join(dir, `${guid}.deleted.json`));
          deleted++;
        } catch { /* already gone */ }
      }
    }
  }

  invalidateTopAppsCache();
  logger.info({ region, subdomain, updated, created, deleted }, 'AOD: per-subaccount scan complete');
  return { updated, created, deleted };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function startAppsScheduler(): void {
  stopAppsScheduler();
  void (async () => {
    try {
      const aodConfig = await readAodConfig();
      const hrs       = aodConfig.refreshAppsIntervalHrs ?? 0;
      if (!hrs || hrs <= 0) return;
      const ms = hrs * 3_600_000;
      schedulerTimer = setInterval(() => { void scanApps(); }, ms);
      if (schedulerTimer.unref) schedulerTimer.unref();
      logger.info({ hrs }, 'AOD apps auto-refresh scheduled');
    } catch (err) {
      logger.warn({ err }, 'AOD apps scheduler init failed');
    }
  })();
}

export function stopAppsScheduler(): void {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}
