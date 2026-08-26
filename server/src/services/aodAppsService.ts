import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { readSubaccounts } from './subaccountsService.js';
import { getOrRefreshToken } from './cfLoginService.js';
import { readAodConfig } from './aodConfigService.js';
import { emitImmediate } from './liveEvents.js';

const AOD_DIR = join(config.LOCAL_STORE_DIR, 'aod');
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

interface AppFile {
  guid:      string;
  name:      string;
  state:     string;
  spaceGuid: string;
  region:    string;
  subdomain: string;
  spaceName: string;
  process?:  { type: string; instances: number; memory_in_mb: number; disk_in_mb: number };
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

const STATS_HEADER = '"timestamp","startedApps","stoppedApps","sumStartedMB","sumStoppedMB"\n';

function sanitizeName(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, '_');
}

async function appendStats(row: StatsRow): Promise<void> {
  const statsPath = join(AOD_DIR, 'stats.csv');
  await mkdir(AOD_DIR, { recursive: true });

  try {
    const info = await stat(statsPath);
    if (info.size >= STATS_ROTATE_BYTES) {
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      await rename(statsPath, join(AOD_DIR, `stats.${dateStr}.csv`));
    }
  } catch { /* file may not exist yet */ }

  let needsHeader = false;
  try { await stat(statsPath); } catch { needsHeader = true; }

  const line = `${row.timestamp},${row.startedApps},${row.stoppedApps},${row.sumStartedMB},${row.sumStoppedMB}\n`;
  await appendFile(statsPath, needsHeader ? STATS_HEADER + line : line, 'utf-8');
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

export async function getStatsData(fromSecs: number, toSecs: number): Promise<StatsRow[]> {
  const statsPath = join(AOD_DIR, 'stats.csv');
  let raw = '';
  try { raw = await readFile(statsPath, 'utf-8'); } catch { return []; }

  const rows: StatsRow[] = [];
  for (const line of raw.split('\n')) {
    const row = parseStatsLine(line);
    if (row && row.timestamp >= fromSecs && row.timestamp <= toSecs) rows.push(row);
  }
  return rows;
}

export async function getLatestStats(): Promise<StatsRow | null> {
  const statsPath = join(AOD_DIR, 'stats.csv');
  let raw = '';
  try { raw = await readFile(statsPath, 'utf-8'); } catch { return null; }

  let latest: StatsRow | null = null;
  for (const line of raw.split('\n')) {
    const row = parseStatsLine(line);
    if (row && (!latest || row.timestamp > latest.timestamp)) latest = row;
  }
  return latest;
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
    const spaceMap = new Map<string, { region: string; subdomain: string; spaceName: string }>();
    for (const sa of subaccounts) {
      for (const sp of sa.org?.spaces ?? []) {
        if (sp.aod) {
          spaceMap.set(sp.spaceId, { region: sa.region, subdomain: sa.subdomain, spaceName: sp.spaceName });
        }
      }
    }

    if (spaceMap.size === 0) {
      logger.info('AOD apps scan: no AOD spaces configured');
      emitImmediate('aod-apps', { type: 'refresh-done', ts: Date.now(), stats: null });
      return;
    }

    // Pre-scan existing .json files per space (to detect deletions)
    const existingBySpace = new Map<string, Set<string>>();
    for (const [spaceGuid, { region, subdomain, spaceName }] of spaceMap) {
      const dir = join(AOD_DIR, region, subdomain, sanitizeName(spaceName));
      try {
        const files = await readdir(dir);
        const guids = new Set<string>();
        for (const f of files) {
          if (f.endsWith('.json') && !f.endsWith('.deleted.json')) {
            guids.add(f.slice(0, -5));
          }
        }
        existingBySpace.set(spaceGuid, guids);
      } catch { /* dir not yet created */ }
    }

    // Group space guids by region
    const byRegion = new Map<string, string[]>();
    for (const [spaceGuid, { region }] of spaceMap) {
      (byRegion.get(region) ?? (byRegion.set(region, []), byRegion.get(region)!)).push(spaceGuid);
    }

    const seenAppGuids     = new Set<string>();
    const successfulRegions = new Set<string>();

    let totalStarted  = 0;
    let totalStopped  = 0;
    let sumStartedMB  = 0;
    let sumStoppedMB  = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const [region, spaceGuids] of byRegion) {
      try {
        const spaceGuidsParam = spaceGuids.join(',');

        const [apps, processes] = await Promise.all([
          cfGetAll<CfApp>(region, `/v3/apps?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
          cfGetAll<CfProcess>(region, `/v3/processes?per_page=5000&space_guids=${encodeURIComponent(spaceGuidsParam)}`),
        ]);

        // Build process map: appGuid → web process (prefer type=web)
        const processMap = new Map<string, CfProcess>();
        for (const p of processes) {
          const appGuid = p.relationships.app.data.guid;
          if (!processMap.has(appGuid) || p.type === 'web') processMap.set(appGuid, p);
        }

        for (const app of apps) {
          const spaceGuid = app.relationships.space.data.guid;
          const meta      = spaceMap.get(spaceGuid);
          if (!meta) continue;

          const { subdomain, spaceName } = meta;
          const dir = join(AOD_DIR, region, subdomain, sanitizeName(spaceName));
          await mkdir(dir, { recursive: true });

          const proc    = processMap.get(app.guid);
          const appFile: AppFile = {
            guid: app.guid, name: app.name, state: app.state,
            spaceGuid, region, subdomain, spaceName,
            process: proc ? {
              type: proc.type, instances: proc.instances,
              memory_in_mb: proc.memory_in_mb, disk_in_mb: proc.disk_in_mb,
            } : undefined,
            lastUpdated: now,
          };

          await writeFile(join(dir, `${app.guid}.json`), JSON.stringify(appFile, null, 2), 'utf-8');
          seenAppGuids.add(app.guid);

          const memMB = (proc?.instances ?? 1) * (proc?.memory_in_mb ?? 0);
          if (app.state === 'STARTED') { totalStarted++; sumStartedMB += memMB; }
          else                          { totalStopped++; sumStoppedMB += memMB; }
        }

        successfulRegions.add(region);
        logger.info({ region, apps: apps.length }, 'AOD apps scan: region complete');
      } catch (err) {
        logger.error({ err, region }, 'AOD apps scan: region failed, skipping deletion tracking');
      }
    }

    // Mark deleted apps (only for successfully scanned regions)
    for (const [spaceGuid, { region, subdomain, spaceName }] of spaceMap) {
      if (!successfulRegions.has(region)) continue;
      const dir      = join(AOD_DIR, region, subdomain, sanitizeName(spaceName));
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

    const statsRow: StatsRow = { timestamp: now, startedApps: totalStarted, stoppedApps: totalStopped, sumStartedMB, sumStoppedMB };
    await appendStats(statsRow);

    logger.info({ totalStarted, totalStopped, sumStartedMB, sumStoppedMB }, 'AOD apps scan complete');
    emitImmediate('aod-apps', { type: 'refresh-done', ts: Date.now(), stats: statsRow });
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
      const hrs = (aodConfig as unknown as { refreshIntervalHrs?: number }).refreshIntervalHrs ?? 0;
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
