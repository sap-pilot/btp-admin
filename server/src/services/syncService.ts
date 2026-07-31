import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { browseResponseFiles, resolveSyncDuplicates, sanitizeName, formatBrowseT, parseBrowseT } from './localStoreService.js';
import type { BrowseFile } from './localStoreService.js';
import { extractZip } from './zipBuilder.js';
import { getSyncKey, getAllServices } from './configService.js';
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

// ── Sync state ────────────────────────────────────────────────────────────────
// One normal sync running at a time, one queued slot; additional requests dropped.
// Manual/force sync from the UI bypasses this queue.
let syncRunning = false;
let syncQueued = false;
let lastBrowseT = '';        // browseT (yyyyMMdd-HHmmss UTC) from the last successful remote browse; empty = no prior browse
let lastSyncCompletedTs = 0; // wall-clock time when the last normal sync completed

// ── Normal sync queue ─────────────────────────────────────────────────────────

function scheduleNormalSync(remoteBase: string, selfBaseUrl?: string): void {
  if (syncRunning) {
    if (!syncQueued) {
      syncQueued = true;
      logger.debug('Sync queued (another sync is already in progress)');
    } else {
      logger.debug('Sync dropped (queue slot already taken)');
    }
    return;
  }
  void runNormalSync(remoteBase, selfBaseUrl);
}

async function runNormalSync(remoteBase: string, selfBaseUrl?: string): Promise<void> {
  syncRunning = true;
  const since = lastBrowseT || undefined;
  try {
    await executeSync(remoteBase, selfBaseUrl, since);
  } catch (err) {
    logger.error({ err }, 'Unexpected sync error');
  } finally {
    lastSyncCompletedTs = Date.now();
    syncRunning = false;
    if (syncQueued) {
      syncQueued = false;
      void runNormalSync(remoteBase, selfBaseUrl);
    }
  }
}

// ── Download trigger (consumer side) ─────────────────────────────────────────

export function handleDownloadTrigger(): void {
  if (!config.SYNC_REMOTE) return;
  scheduleNormalSync(config.SYNC_REMOTE, config.SELF_URL);
}

// ── Startup sync ──────────────────────────────────────────────────────────────

export function startupSync(): void {
  if (!config.SYNC_REMOTE) return;
  scheduleNormalSync(config.SYNC_REMOTE, config.SELF_URL);
}

// ── Interval fallback (consumer side) ────────────────────────────────────────
let intervalHandle: NodeJS.Timeout | null = null;

export function startIntervalFallback(): void {
  if (intervalHandle || !config.SYNC_REMOTE) return;
  const ms = config.SYNC_INTERVAL * 1000;
  if (ms <= 0) return;
  const checkMs = Math.min(ms, 60_000);
  intervalHandle = setInterval(() => {
    if (syncRunning) return;
    if (lastSyncCompletedTs > 0 && Date.now() - lastSyncCompletedTs < ms) return;
    logger.info(
      { lastSyncAgoMs: lastSyncCompletedTs > 0 ? Date.now() - lastSyncCompletedTs : null },
      'No recent sync — interval fallback triggered',
    );
    scheduleNormalSync(config.SYNC_REMOTE!, config.SELF_URL);
  }, checkMs);
}

export function stopIntervalFallback(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ── Manual sync (POST /api/sync from UI) ─────────────────────────────────────
// Always does a full browse (no since). Returns {busy:true} when another sync
// is running unless force=true, in which case it runs unconditionally in parallel.

export interface SyncStats {
  files: number;
  transferredMB: string;
  decompressedMB: string;
  elapsedSec: string;
  busy?: true;
  error?: string;
}

export async function syncFromRemote(
  remoteBase: string,
  opts?: { selfBaseUrl?: string; force?: boolean },
): Promise<SyncStats> {
  if (syncRunning && !opts?.force) {
    return { files: 0, transferredMB: '0.00', decompressedMB: '0.00', elapsedSec: '0.0', busy: true };
  }
  // Manual/force sync: full browse (no since), bypasses the normal queue
  return executeSync(remoteBase, opts?.selfBaseUrl, undefined);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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

  const safeBase = resolvePath(config.LOCAL_STORE_DIR);
  const slash = filePath.indexOf('/');
  let target: string;
  if (slash === -1) {
    // Root-level file (e.g. homepage.json)
    target = resolvePath(config.LOCAL_STORE_DIR, filePath);
    if (!target.startsWith(safeBase + '/')) {
      logger.warn({ path: filePath }, 'Skipping root file: path traversal detected');
      return { transferred: 0, decompressed: 0 };
    }
    await mkdir(config.LOCAL_STORE_DIR, { recursive: true });
  } else {
    const folder = filePath.slice(0, slash);
    const filename = filePath.slice(slash + 1);
    if (folder === 'config') {
      target = resolvePath(config.LOCAL_STORE_DIR, 'config', filename);
      if (!target.startsWith(safeBase + '/')) {
        logger.warn({ path: filePath }, 'Skipping config file: path traversal detected');
        return { transferred: 0, decompressed: 0 };
      }
      await mkdir(join(config.LOCAL_STORE_DIR, 'config'), { recursive: true });
    } else if (folder === 'dest') {
      target = resolvePath(config.LOCAL_STORE_DIR, 'dest', filename);
      if (!target.startsWith(safeBase + '/')) {
        logger.warn({ path: filePath }, 'Skipping dest file: path traversal detected');
        return { transferred: 0, decompressed: 0 };
      }
      const lastSlash = filename.lastIndexOf('/');
      const parentDir = lastSlash !== -1
        ? join(config.LOCAL_STORE_DIR, 'dest', filename.slice(0, lastSlash))
        : join(config.LOCAL_STORE_DIR, 'dest');
      await mkdir(parentDir, { recursive: true });
    } else {
      target = resolvePath(config.LOCAL_STORE_DIR, 'resp', folder, filename);
      if (!target.startsWith(safeBase + '/')) {
        logger.warn({ path: filePath }, 'Skipping file: path traversal detected');
        return { transferred: 0, decompressed: 0 };
      }
      await mkdir(join(config.LOCAL_STORE_DIR, 'resp', folder), { recursive: true });
    }
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

  const safeBase = resolvePath(config.LOCAL_STORE_DIR);
  await Promise.all(
    entries.map(async ({ name, data }) => {
      const slash = name.indexOf('/');
      let target: string;
      if (slash === -1) {
        // Root-level file (e.g. homepage.json)
        target = resolvePath(config.LOCAL_STORE_DIR, name);
        if (!target.startsWith(safeBase + '/')) {
          logger.warn({ name }, 'Skipping ZIP root entry: path traversal detected');
          return;
        }
        await mkdir(config.LOCAL_STORE_DIR, { recursive: true });
      } else {
        const folder = name.slice(0, slash);
        const filename = name.slice(slash + 1);
        if (!folder || !filename) return;
        if (folder === 'config') {
          target = resolvePath(config.LOCAL_STORE_DIR, 'config', filename);
          if (!target.startsWith(safeBase + '/')) {
            logger.warn({ name }, 'Skipping ZIP config entry: path traversal detected');
            return;
          }
          await mkdir(join(config.LOCAL_STORE_DIR, 'config'), { recursive: true });
        } else if (folder === 'dest') {
          target = resolvePath(config.LOCAL_STORE_DIR, 'dest', filename);
          if (!target.startsWith(safeBase + '/')) {
            logger.warn({ name }, 'Skipping ZIP dest entry: path traversal detected');
            return;
          }
          const lastSlash = filename.lastIndexOf('/');
          const parentDir = lastSlash !== -1
            ? join(config.LOCAL_STORE_DIR, 'dest', filename.slice(0, lastSlash))
            : join(config.LOCAL_STORE_DIR, 'dest');
          await mkdir(parentDir, { recursive: true });
        } else {
          target = resolvePath(config.LOCAL_STORE_DIR, 'resp', folder, filename);
          if (!target.startsWith(safeBase + '/')) {
            logger.warn({ name }, 'Skipping ZIP entry: path traversal detected');
            return;
          }
          await mkdir(join(config.LOCAL_STORE_DIR, 'resp', folder), { recursive: true });
        }
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

// ── Core sync executor ────────────────────────────────────────────────────────

async function executeSync(
  remoteBase: string,
  selfBaseUrl: string | undefined,
  since: string | undefined,  // yyyyMMdd-HHmmss UTC, or undefined for a full sync
): Promise<SyncStats> {
  const callbackUrl = selfBaseUrl ? `${selfBaseUrl}/api/download-trigger` : undefined;
  logger.info({ remote: remoteBase, since: since ?? 'full', hasCallback: !!callbackUrl }, 'Sync starting');
  const start = Date.now();

  // Parse since string to ms once for local FS comparison (avoids repeated parsing)
  const sinceMs = since ? parseBrowseT(since) : undefined;

  try {
    // Build browse URL
    const browseParams = new URLSearchParams();
    if (since) browseParams.set('since', since);
    if (callbackUrl) browseParams.set('callback', callbackUrl);
    const browseQs = browseParams.toString();
    const browseUrl = browseQs ? `${remoteBase}/api/browse?${browseQs}` : `${remoteBase}/api/browse`;

    const { buf: browseBuf } = await fetchRaw(browseUrl, syncKeyHeader());
    const rawBrowse = JSON.parse(browseBuf.toString('utf-8')) as {
      folders: Record<string, (string | BrowseFile)[]>;
      browseT?: string;    // new: yyyyMMdd-HHmmss UTC string
      browseTs?: number;   // legacy: Unix-ms number from older producers
    };
    // Prefer new browseT string; convert legacy browseTs number if present
    const remoteBrowseT = rawBrowse.browseT
      ?? (rawBrowse.browseTs ? formatBrowseT(rawBrowse.browseTs) : undefined);

    // Normalise folders (legacy servers may return string[] instead of BrowseFile[])
    const folders: Record<string, BrowseFile[]> = {};
    for (const [folder, items] of Object.entries(rawBrowse.folders)) {
      folders[folder] = items.map(item => (typeof item === 'string' ? { name: item, mtime: 0 } : item));
    }

    // Compare with LOCAL files modified since the same cutoff.
    // For delta syncs this skips stat-ing files that predate `since`, cutting
    // comparison time from O(all local files) to O(recently changed local files).
    const localFolders = await browseResponseFiles(sinceMs);

    const fp = (folder: string, name: string) => folder ? `${folder}/${name}` : name;

    const remoteMtimes = new Map<string, number>();
    for (const [folder, files] of Object.entries(folders)) {
      for (const f of files) remoteMtimes.set(fp(folder, f.name), f.mtime);
    }

    const missing: string[] = [];
    for (const [folder, files] of Object.entries(folders)) {
      const localMtimes = new Map((localFolders[folder] ?? []).map(f => [f.name, f.mtime]));
      for (const f of files) {
        const localMtime = localMtimes.get(f.name);
        // localMtime undefined means either missing or older than sinceMs — both need download.
        // Round both sides to second precision: remote returns precise ms but local filesystems
        // on some VMs store mtime at 1-second granularity, so utimes(remote_ms) reads back as
        // floor(remote_ms/1000)*1000 locally. Comparing at second precision avoids re-downloading
        // unchanged files while still catching genuine updates (different second).
        if (localMtime !== undefined && (!f.mtime || Math.round(localMtime / 1000) >= Math.round(f.mtime / 1000))) continue;
        missing.push(fp(folder, f.name));
      }
    }

    logger.info({ total: missing.length }, 'Files to sync from remote');

    const elapsedSec = () => ((Date.now() - start) / 1000).toFixed(1);

    if (missing.length === 0) {
      if (remoteBrowseT) lastBrowseT = remoteBrowseT;
      logger.info({ elapsedMs: Date.now() - start }, 'Remote sync complete — already up to date');
      return { files: 0, transferredMB: '0.00', decompressedMB: '0.00', elapsedSec: elapsedSec() };
    }

    let totalTransferred = 0;
    let totalDecompressed = 0;

    const batchSize = config.SYNC_REMOTE_BATCH_SIZE;
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
          if (err instanceof SyncAuthError) throw err;
          if (batchAvailable === null) {
            logger.info({ err }, 'Batch download not available, falling back to individual downloads');
            batchAvailable = false;
          } else {
            throw err;
          }
        }
      }

      // Individual download fallback
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

    // Resolve starred/unstarred duplicates in service folders
    const downloadedByFolder = new Map<string, string[]>();
    for (const p of missing) {
      const slash = p.indexOf('/');
      if (slash === -1) continue;
      const folder = p.slice(0, slash);
      const filename = p.slice(slash + 1);
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

    // Update lastBrowseTs on success so the next normal sync uses it as `since`
    if (remoteBrowseT) lastBrowseT = remoteBrowseT;

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
  }
}
