import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { browseResponseFiles, resolveSyncDuplicates, sanitizeName } from './status/responseStore.js';
import type { BrowseFile } from './status/responseStore.js';
import { extractZip } from './zipBuilder.js';
import { getSyncKey, getAllServices } from './status/configService.js';
import { emit } from './liveEvents.js';

const gunzipAsync = promisify(gunzip);
const INDIVIDUAL_CONCURRENCY = 10;

/** Thrown when the remote rejects the sync key with 401; always aborts the full sync. */
class SyncAuthError extends Error {
  constructor(url: string) {
    super(`Remote rejected sync request (HTTP 401) for ${url} — check SYNC_KEY / sync.key configuration`);
    this.name = 'SyncAuthError';
  }
}

/** Thrown for any non-2xx, non-401 HTTP response. */
class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, url: string) {
    super(`HTTP ${statusCode} for ${url}`);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

// ── Callback registry (producer side) ────────────────────────────────────────
// Stores callback URLs registered by consumers via ?callback= on /api/browse.
// When new check results are available, notifyCallbacks() fires all registered URLs.
const registeredCallbacks = new Set<string>();

export function registerCallback(url: string): void {
  if (registeredCallbacks.has(url)) {
    logger.debug({ url }, 'Sync callback already registered (skipping duplicate)');
    return;
  }
  registeredCallbacks.add(url);
  logger.info({ url }, 'Sync callback registered');
}

export function notifyCallbacks(): void {
  if (registeredCallbacks.size === 0) return;
  const headers = syncKeyHeader();
  for (const url of registeredCallbacks) {
    fetchRaw(url, headers)
      .then(() => logger.debug({ url }, 'Sync callback notified'))
      .catch(err => {
        if (err instanceof HttpError) {
          registeredCallbacks.delete(url);
          logger.warn({ url, status: err.statusCode }, 'Sync callback HTTP error — deregistered; remote will re-register on next sync');
        } else {
          logger.warn({ url, err }, 'Failed to notify sync callback (network error — keeping registered)');
        }
      });
  }
}

// ── Download trigger (consumer side) ─────────────────────────────────────────
// One concurrent download allowed; latest trigger queued, extras dropped.
let lastTriggerSyncTs = 0;  // ms timestamp after last successful trigger sync (0 = do full sync)
let lastBrowseTs = 0;       // ms timestamp just before the last browse HTTP call
let triggerRunning = false;
let triggerQueued = false;

/**
 * Returns the `since=` timestamp to use for the next browse request.
 * Steps back by SYNC_INTERVAL milliseconds (min 300 s) from the last browse
 * timestamp to create an overlap window that catches files created on the
 * producer just as the previous browse was executing. Already-local files are
 * filtered by the local-set comparison in syncFromRemote, so the overlap adds
 * no redundant downloads. Falls back to lastTriggerSyncTs (0 = full sync)
 * when no browse has been issued yet.
 */
function sinceWithOverlap(): number {
  if (lastBrowseTs <= 0) return lastTriggerSyncTs;
  const overlap = config.SYNC_INTERVAL > 0 ? config.SYNC_INTERVAL * 1000 : 300_000;
  return Math.max(0, lastBrowseTs - overlap);
}

/** Advance the trigger timestamp — call after a non-trigger sync (e.g. startup) completes. */
export function setLastTriggerSyncTs(ts: number): void {
  if (ts > lastTriggerSyncTs) lastTriggerSyncTs = ts;
}

/** Fire-and-forget: queues one delta download from SYNC_REMOTE. */
export function handleDownloadTrigger(): void {
  if (!config.SYNC_REMOTE) return;
  if (triggerRunning || syncInProgress) {
    if (!triggerQueued) {
      triggerQueued = true;
      logger.debug('Download trigger queued (sync already in progress)');
    } else {
      logger.debug('Download trigger dropped (already queued)');
    }
    return;
  }
  void runTriggerSync();
}

async function runTriggerSync(): Promise<void> {
  triggerRunning = true;
  const since = sinceWithOverlap();
  const startTs = Date.now();
  try {
    logger.debug({ since }, 'Download trigger sync starting');
    const stats = await syncFromRemote(config.SYNC_REMOTE, { since, selfBaseUrl: config.SELF_URL });
    if (!stats.busy) lastTriggerSyncTs = startTs; // only advance on success
  } catch (err) {
    logger.error({ err }, 'Download trigger sync error');
  } finally {
    triggerRunning = false;
    if (triggerQueued) {
      triggerQueued = false;
      void runTriggerSync();
    }
  }
}

// ── Interval fallback (consumer side) ────────────────────────────────────────
// Fires a delta sync when no webhook-triggered download has completed within
// SYNC_INTERVAL seconds — recovers automatically if the producer restarts and
// loses its registered callback URLs.
let intervalHandle: NodeJS.Timeout | null = null;

async function runIntervalSync(): Promise<void> {
  if (!config.SYNC_REMOTE) return;
  triggerRunning = true;
  const since = sinceWithOverlap() || undefined;
  const startTs = Date.now();
  try {
    logger.info({ since }, 'Interval fallback sync starting');
    const stats = await syncFromRemote(config.SYNC_REMOTE, { since, selfBaseUrl: config.SELF_URL });
    if (!stats.busy) lastTriggerSyncTs = startTs;
  } catch (err) {
    logger.error({ err }, 'Interval fallback sync error');
  } finally {
    triggerRunning = false;
    if (triggerQueued) {
      triggerQueued = false;
      void runTriggerSync();
    }
  }
}

export function startIntervalFallback(): void {
  if (intervalHandle || !config.SYNC_REMOTE) return;
  const ms = config.SYNC_INTERVAL * 1000;
  if (ms <= 0) return;
  // Check at most every 60 s so the maximum extra delay is 60 s above SYNC_INTERVAL.
  const checkMs = Math.min(ms, 60_000);
  intervalHandle = setInterval(() => {
    if (lastTriggerSyncTs === 0) return; // startup sync not done yet
    if (Date.now() - lastTriggerSyncTs < ms) return; // recent sync — skip
    if (triggerRunning) return; // already in progress
    logger.info({ lastSyncAgoMs: Date.now() - lastTriggerSyncTs }, 'No recent download — interval fallback triggered');
    void runIntervalSync();
  }, checkMs);
}

export function stopIntervalFallback(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export interface SyncStats {
  files: number;
  transferredMB: string;
  decompressedMB: string;
  elapsedSec: string;
  busy?: true;
  error?: string;
}

interface FetchResult {
  buf: Buffer;
  transferred: number;
  decompressed: number;
}

function fetchRaw(url: string, extraHeaders: Record<string, string> = {}): Promise<FetchResult> {
  const get = url.startsWith('https://') ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'Accept-Encoding': 'gzip', ...extraHeaders } }, (res) => {
      if (res.statusCode === 401) {
        res.resume();
        reject(new SyncAuthError(url));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new HttpError(res.statusCode, url));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        (async () => {
          const raw = Buffer.concat(chunks);
          const transferred = raw.length;
          const buf =
            res.headers['content-encoding'] === 'gzip' ? await gunzipAsync(raw) : raw;
          resolve({ buf, transferred, decompressed: buf.length });
        })().catch(reject);
      });
    });
    req.on('error', reject);
  });
}

function fetchPost(url: string, body: string, extraHeaders: Record<string, string> = {}): Promise<FetchResult> {
  const isHttps = url.startsWith('https://');
  const request = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const bodyBytes = Buffer.from(body, 'utf-8');
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBytes.length,
          'Accept-Encoding': 'gzip',
          ...extraHeaders,
        },
      },
      (res) => {
        if (res.statusCode === 401) {
          res.resume();
          reject(new SyncAuthError(url));
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new HttpError(res.statusCode, url));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          (async () => {
            const raw = Buffer.concat(chunks);
            const transferred = raw.length;
            const buf =
              res.headers['content-encoding'] === 'gzip' ? await gunzipAsync(raw) : raw;
            resolve({ buf, transferred, decompressed: buf.length });
          })().catch(reject);
        });
      },
    );
    req.on('error', reject);
    req.write(bodyBytes);
    req.end();
  });
}

function syncKeyHeader(): Record<string, string> {
  const key = getSyncKey();
  if (!key) return {};
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(ts).digest('hex');
  return { 'x-sync-ts': ts, 'x-sync-sig': sig };
}

async function downloadOne(
  remoteBase: string,
  filePath: string,
  remoteMtime?: number,
): Promise<{ transferred: number; decompressed: number }> {
  const url = `${remoteBase}/api/download?path=${encodeURIComponent(filePath)}`;
  const { buf, transferred, decompressed } = await fetchRaw(url, syncKeyHeader());

  const slash = filePath.indexOf('/');
  let target: string;
  if (slash === -1) {
    // Root-level file (e.g. homepage.json)
    target = resolvePath(config.RESPONSE_DIR, filePath);
    if (!target.startsWith(resolvePath(config.RESPONSE_DIR) + '/')) {
      logger.warn({ path: filePath }, 'Skipping root file: path traversal detected');
      return { transferred: 0, decompressed: 0 };
    }
    await mkdir(config.RESPONSE_DIR, { recursive: true });
  } else {
    const folder = filePath.slice(0, slash);
    const filename = filePath.slice(slash + 1);
    target = resolvePath(config.RESPONSE_DIR, folder, filename);
    if (!target.startsWith(resolvePath(config.RESPONSE_DIR) + '/')) {
      logger.warn({ path: filePath }, 'Skipping file: path traversal detected');
      return { transferred: 0, decompressed: 0 };
    }
    await mkdir(join(config.RESPONSE_DIR, folder), { recursive: true });
  }
  await writeFile(target, buf);
  if (remoteMtime) {
    const mt = new Date(remoteMtime);
    try { await utimes(target, mt, mt); } catch { /* ignore — best-effort */ }
  }
  logger.debug({ path: filePath }, 'Downloaded file');
  return { transferred, decompressed };
}

async function downloadBatch(
  remoteBase: string,
  filePaths: string[],
  remoteMtimes: Map<string, number>,
): Promise<{ transferred: number; decompressed: number }> {
  const url = `${remoteBase}/api/batch-download`;
  const { buf: zip, transferred } = await fetchPost(url, JSON.stringify({ paths: filePaths }), syncKeyHeader());
  const entries = extractZip(zip);

  const safeBase = resolvePath(config.RESPONSE_DIR);
  await Promise.all(
    entries.map(async ({ name, data }) => {
      const slash = name.indexOf('/');
      let target: string;
      if (slash === -1) {
        // Root-level file (e.g. homepage.json)
        target = resolvePath(config.RESPONSE_DIR, name);
        if (!target.startsWith(safeBase + '/')) {
          logger.warn({ name }, 'Skipping ZIP root entry: path traversal detected');
          return;
        }
        await mkdir(config.RESPONSE_DIR, { recursive: true });
      } else {
        const folder = name.slice(0, slash);
        const filename = name.slice(slash + 1);
        if (!folder || !filename) return;
        target = resolvePath(config.RESPONSE_DIR, folder, filename);
        if (!target.startsWith(safeBase + '/')) {
          logger.warn({ name }, 'Skipping ZIP entry: path traversal detected');
          return;
        }
        await mkdir(join(config.RESPONSE_DIR, folder), { recursive: true });
      }
      await writeFile(target, data);
      const mtime = remoteMtimes.get(name);
      if (mtime) {
        const mt = new Date(mtime);
        try { await utimes(target, mt, mt); } catch { /* ignore — best-effort */ }
      }
    }),
  );

  const decompressed = entries.reduce((sum, e) => sum + e.data.length, 0);
  logger.debug({ files: entries.length }, 'Batch download chunk complete');
  return { transferred, decompressed };
}

// ── Main sync function ────────────────────────────────────────────────────────

let syncInProgress = false;

export async function syncFromRemote(
  remoteBase: string,
  opts?: { since?: number; selfBaseUrl?: string },
): Promise<SyncStats> {
  if (syncInProgress) {
    logger.warn({ remote: remoteBase }, 'Sync already in progress, skipping');
    return { files: 0, transferredMB: '0.00', decompressedMB: '0.00', elapsedSec: '0.0', busy: true };
  }

  syncInProgress = true;
  const since = opts?.since && opts.since > 0 ? opts.since : undefined;
  const callbackUrl = opts?.selfBaseUrl ? `${opts.selfBaseUrl}/api/download-trigger` : undefined;
  logger.info({ remote: remoteBase, since, hasCallback: !!callbackUrl }, 'Remote sync starting');
  const start = Date.now();

  try {
    const browseParams = new URLSearchParams();
    if (since) browseParams.set('since', String(since));
    if (callbackUrl) browseParams.set('callback', callbackUrl);
    const browseQs = browseParams.toString();
    const browseUrl = browseQs ? `${remoteBase}/api/browse?${browseQs}` : `${remoteBase}/api/browse`;
    lastBrowseTs = Date.now();
    const { buf: browseBuf } = await fetchRaw(browseUrl, syncKeyHeader());
    // Support legacy servers that return string[] instead of BrowseFile[]; mtime will be 0 (falsy) for those entries
    const rawBrowse = JSON.parse(browseBuf.toString('utf-8')) as { folders: Record<string, (string | BrowseFile)[]> };
    const folders: Record<string, BrowseFile[]> = {};
    for (const [folder, items] of Object.entries(rawBrowse.folders)) {
      folders[folder] = items.map(item => (typeof item === 'string' ? { name: item, mtime: 0 } : item));
    }

    const localFolders = await browseResponseFiles();

    const fp = (folder: string, name: string) => folder ? `${folder}/${name}` : name;

    // Build a map of remote file path → mtime for post-download mtime restoration
    const remoteMtimes = new Map<string, number>();
    for (const [folder, files] of Object.entries(folders)) {
      for (const f of files) {
        remoteMtimes.set(fp(folder, f.name), f.mtime);
      }
    }

    let missing: string[] = [];
    for (const [folder, files] of Object.entries(folders)) {
      // Map local filename → mtime so we can detect updated files, not just new ones.
      const localMtimes = new Map((localFolders[folder] ?? []).map(f => [f.name, f.mtime]));
      for (const f of files) {
        const localMtime = localMtimes.get(f.name);
        // File is up-to-date if it exists locally and local mtime >= remote mtime.
        // When remote mtime is 0 (legacy server) and file already exists, skip it.
        if (localMtime !== undefined && (!f.mtime || localMtime >= f.mtime)) continue;
        missing.push(fp(folder, f.name));
      }
    }

    // On a full (initial) sync, skip files that are outside the retention window and not starred.
    // This avoids pulling old data that housekeeping would delete anyway.
    if (!since && config.MAX_RESPONSE_STORAGE_DAYS > 0) {
      const cutoff = Date.now() - config.MAX_RESPONSE_STORAGE_DAYS * 24 * 60 * 60 * 1000;
      const before = missing.length;
      missing = missing.filter(p => {
        const name = p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
        if (name.includes('.starred.')) return true;   // starred — always include
        const mtime = remoteMtimes.get(p);
        return !mtime || mtime >= cutoff;              // include if mtime unknown or within window
      });
      const skipped = before - missing.length;
      if (skipped > 0) logger.info({ skipped, maxDays: config.MAX_RESPONSE_STORAGE_DAYS }, 'Initial sync: skipped files older than retention window (starred always included)');
    }

    logger.info({ total: missing.length }, 'Files to sync from remote');

    const elapsedSec = () => ((Date.now() - start) / 1000).toFixed(1);

    if (missing.length === 0) {
      logger.info({ elapsedMs: Date.now() - start }, 'Remote sync complete — already up to date');
      return { files: 0, transferredMB: '0.00', decompressedMB: '0.00', elapsedSec: elapsedSec() };
    }

    let totalTransferred = 0;
    let totalDecompressed = 0;

    const batchSize = config.SYNC_REMOTE_BATCH_SIZE;
    // null = untested, true = available, false = unavailable (fall back to individual)
    let batchAvailable: boolean | null = null;

    for (let i = 0; i < missing.length; i += batchSize) {
      const chunk = missing.slice(i, i + batchSize);

      if (batchAvailable !== false) {
        try {
            const result = await downloadBatch(remoteBase, chunk, remoteMtimes);
          totalTransferred += result.transferred;
          totalDecompressed += result.decompressed;
          batchAvailable = true;
          logger.debug({ done: Math.min(i + batchSize, missing.length), total: missing.length }, 'Sync batch complete');
          continue;
        } catch (err) {
          if (err instanceof SyncAuthError) throw err; // auth failure — abort entire sync
          if (batchAvailable === null) {
            logger.info({ err }, 'Batch download not available, falling back to individual downloads');
            batchAvailable = false;
            // fall through to individual downloads for this chunk
          } else {
            throw err;
          }
        }
      }

      // Individual download mode
      for (let j = 0; j < chunk.length; j += INDIVIDUAL_CONCURRENCY) {
        const concurrentSlice = chunk.slice(j, j + INDIVIDUAL_CONCURRENCY);
        const results = await Promise.all(concurrentSlice.map(f => downloadOne(remoteBase, f, remoteMtimes.get(f))));
        for (const r of results) {
          totalTransferred += r.transferred;
          totalDecompressed += r.decompressed;
        }
      }
      logger.debug({ done: Math.min(i + batchSize, missing.length), total: missing.length }, 'Sync batch complete');
    }

    // Resolve starred/unstarred duplicates (folder files only — root files are just overwritten)
    const downloadedByFolder = new Map<string, string[]>();
    for (const fp of missing) {
      const slash = fp.indexOf('/');
      if (slash === -1) continue; // skip root files
      const folder = fp.slice(0, slash);
      const filename = fp.slice(slash + 1);
      if (!downloadedByFolder.has(folder)) downloadedByFolder.set(folder, []);
      downloadedByFolder.get(folder)!.push(filename);
    }
    await Promise.all(
      [...downloadedByFolder.entries()].map(([folder, files]) =>
        resolveSyncDuplicates(folder, files),
      ),
    );

    const stats: SyncStats = {
      files: missing.length,
      transferredMB: (totalTransferred / 1_048_576).toFixed(2),
      decompressedMB: (totalDecompressed / 1_048_576).toFixed(2),
      elapsedSec: elapsedSec(),
    };

    logger.info(stats, 'Remote sync complete');

    // Notify live-update subscribers
    const ts = Date.now();
    const updatedFolders = new Set<string>();
    const updatedRootFiles: string[] = [];
    for (const p of missing) {
      const slash = p.indexOf('/');
      if (slash === -1) updatedRootFiles.push(p);
      else updatedFolders.add(p.slice(0, slash));
    }
    const folderToService = Object.fromEntries(
      getAllServices().map(s => [sanitizeName(s.name), s.name]),
    );
    emit('global', { ts });
    for (const folder of updatedFolders) {
      const svcName = folderToService[folder];
      if (svcName) emit(`service:${svcName}`, { service: svcName, ts });
    }
    if (updatedRootFiles.some(f => f.startsWith('homepage'))) {
      emit('homepage', { ts });
    }
    const otherRootFiles = updatedRootFiles.filter(f => !f.startsWith('homepage'));
    if (otherRootFiles.length > 0) {
      emit('root', { files: otherRootFiles, ts });
    }

    return stats;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, remote: remoteBase }, 'Remote sync failed');
    return {
      files: 0,
      transferredMB: '0.00',
      decompressedMB: '0.00',
      elapsedSec: ((Date.now() - start) / 1000).toFixed(1),
      error: msg,
    };
  } finally {
    syncInProgress = false;
    // Dispatch a queued trigger when this syncFromRemote call was the manual-sync
    // path (triggerRunning is false). The trigger/interval paths handle this in
    // their own finally blocks after clearing triggerRunning.
    if (!triggerRunning && triggerQueued) {
      triggerQueued = false;
      void runTriggerSync();
    }
  }
}
