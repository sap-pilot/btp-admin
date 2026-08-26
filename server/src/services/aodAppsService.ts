import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export function isRefreshRunning(): boolean { return refreshRunning; }

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

interface AppFile {
  guid:        string;
  name:        string;
  state:       string;
  spaceGuid:   string;
  region:      string;
  subdomain:   string;
  spaceName:   string;
  process?:    { type: string; instances: number; memory_in_mb: number; disk_in_mb: number };
  aod?:        boolean;
  urls?:       string[];
  lastUpdated: number;
}

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
    emitImmediate('aod-apps', { type: 'refresh-done', ts: Date.now(), allStats: allRow, aodStats: aodRow });
  } catch (err) {
    logger.error({ err }, 'AOD apps scan failed');
    emitImmediate('aod-apps', { type: 'refresh-error', ts: Date.now(), error: String(err) });
  } finally {
    refreshRunning = false;
  }
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
