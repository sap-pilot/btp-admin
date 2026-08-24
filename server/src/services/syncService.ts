import { get as httpGet, request as httpRequest } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { resolveSyncDuplicates, sanitizeName, formatBrowseT } from './localStoreService.js';
import type { BrowseFile } from './localStoreService.js';
import { extractZip } from './zipBuilder.js';
import { getSyncKey, getAllServices } from './configService.js';
import { emit } from './liveEvents.js';
import { refreshLastUpdated } from './lastUpdatedService.js';

const gunzipAsync = promisify(gunzip);
const BATCH_MAX_ATTEMPTS   = 3;
const BATCH_RETRY_DELAY_MS = 4_000;
const BATCH_CAP_ON_EXCEED  = 500;

// Per-remote forced batch size cap, set when the remote signals "paths exceeds maximum of N".
// Persists for the lifetime of the process so subsequent syncs respect the remote's limit.
const remoteBatchCap = new Map<string, number>();

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
  readonly body:       string;
  constructor(statusCode: number, url: string, body = '') {
    super(`HTTP ${statusCode} for ${url}`);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ── dest sync hooks ───────────────────────────────────────────────────────────
// onDestChangelogSynced: called when dest/changelog.md is in the batch.
// onDestSynced: called whenever any dest/* files land — used to run file-level dedupe.
let onDestChangelogSynced: (() => void) | null = null;
let onDestSynced:          (() => void) | null = null;

export function registerOnDestChangelogSynced(fn: () => void): void {
  onDestChangelogSynced = fn;
}

export function registerOnDestSynced(fn: () => void): void {
  onDestSynced = fn;
}

let onRcsChangelogSynced: (() => void) | null = null;

export function registerOnRcsChangelogSynced(fn: () => void): void {
  onRcsChangelogSynced = fn;
}

// Called by executeSync with deduplicated SA keys (e.g. ['eu10/my-sub']) when any
// rcs/{region}/{subdomain}/* files are included in a sync batch — lets rcService
// refresh per-SA overview cache and emit a targeted SSE in one pass.
let onRcsSynced: ((saPaths: string[]) => void) | null = null;

export function registerOnRcsSynced(fn: (saPaths: string[]) => void): void {
  onRcsSynced = fn;
}

let onUsersChangelogSynced: (() => void) | null = null;

export function registerOnUsersChangelogSynced(fn: () => void): void {
  onUsersChangelogSynced = fn;
}

// Called by executeSync with deduplicated SA keys when any users/{region}/{subdomain}/*
// files are included in a sync batch — lets userService refresh per-SA cache and emit.
let onUsersSynced: ((saPaths: string[]) => void) | null = null;

export function registerOnUsersSynced(fn: (saPaths: string[]) => void): void {
  onUsersSynced = fn;
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

// Debounce handle: multiple rapid notifyCallbacks() calls (e.g. one per file write
// during a health check cycle) are coalesced into a single HTTP notification.
let notifyDebounceHandle: NodeJS.Timeout | null = null;
const NOTIFY_DEBOUNCE_MS = 500;

export function notifyCallbacks(): void {
  if (registeredCallbacks.size === 0) return;
  if (notifyDebounceHandle) return; // already scheduled — coalesce
  notifyDebounceHandle = setTimeout(() => {
    notifyDebounceHandle = null;
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
  }, NOTIFY_DEBOUNCE_MS);
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
  headers: Record<string, string | string[] | undefined>;
}

function fetchRaw(url: string, extraHeaders: Record<string, string> = {}): Promise<FetchResult> {
  const get = url.startsWith('https://') ? httpsGet : httpGet;
  const reqHeaders = { 'Accept-Encoding': 'gzip', ...extraHeaders };
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: reqHeaders }, (res) => {
      if (res.statusCode === 401 || (res.statusCode && res.statusCode >= 400)) {
        const code = res.statusCode!;
        const resHeaders = res.headers as Record<string, string | string[] | undefined>;
        const errChunks: Buffer[] = [];
        res.on('data', (c: Buffer) => errChunks.push(c));
        res.on('error', () => reject(code === 401 ? new SyncAuthError(url) : new HttpError(code, url)));
        res.on('end', () => {
          (async () => {
            const raw = Buffer.concat(errChunks);
            const buf = res.headers['content-encoding'] === 'gzip' ? await gunzipAsync(raw) : raw;
            const resBody = buf.toString('utf-8').slice(0, 500);
            logger.debug({ url, reqHeaders, statusCode: code, resHeaders, resBody }, 'Sync HTTP error response');
            reject(code === 401 ? new SyncAuthError(url) : new HttpError(code, url, resBody));
          })().catch(() => reject(code === 401 ? new SyncAuthError(url) : new HttpError(code, url)));
        });
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
          resolve({ buf, transferred, decompressed: buf.length, headers: res.headers as Record<string, string | string[] | undefined> });
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
        if (res.statusCode === 401 || (res.statusCode && res.statusCode >= 400)) {
          const code = res.statusCode!;
          const resHeaders = res.headers as Record<string, string | string[] | undefined>;
          const errChunks: Buffer[] = [];
          res.on('data', (c: Buffer) => errChunks.push(c));
          res.on('error', () => reject(code === 401 ? new SyncAuthError(url) : new HttpError(code, url)));
          res.on('end', () => {
            (async () => {
              const raw = Buffer.concat(errChunks);
              const buf = res.headers['content-encoding'] === 'gzip' ? await gunzipAsync(raw) : raw;
              const resBody = buf.toString('utf-8').slice(0, 500);
              logger.debug({ url, reqBody: body.slice(0, 200), reqHeaders: { 'Content-Type': 'application/json', ...extraHeaders }, statusCode: code, resHeaders, resBody }, 'Sync HTTP error response');
              reject(code === 401 ? new SyncAuthError(url) : new HttpError(code, url, resBody));
            })().catch(() => reject(code === 401 ? new SyncAuthError(url) : new HttpError(code, url)));
          });
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
            resolve({ buf, transferred, decompressed: buf.length, headers: res.headers as Record<string, string | string[] | undefined> });
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


/** Resolve a flat sync path (e.g. "dest/eu10/sub/f.json" or "MySvc/status.json") to an absolute local path. */
function resolveLocalPath(flatPath: string): string {
  const slash = flatPath.indexOf('/');
  if (slash === -1) return join(config.LOCAL_STORE_DIR, flatPath);
  const first = flatPath.slice(0, slash);
  if (first === 'conf' || first === 'dest' || first === 'rcs' || first === 'users') {
    return join(config.LOCAL_STORE_DIR, flatPath);
  }
  return join(config.LOCAL_STORE_DIR, 'resp', flatPath);
}

async function downloadBatch(
  remoteBase: string,
  filePaths: string[],
  remoteMtimes: Map<string, number>,
): Promise<{ transferred: number; decompressed: number }> {
  const url = `${remoteBase}/api/sync/batch`;
  const t0 = Date.now();
  const { buf: zip, transferred } = await fetchPost(url, JSON.stringify({ paths: filePaths }), syncKeyHeader());
  const t0Write = Date.now();
  logger.debug({ url, requested: filePaths.length, durationMs: t0Write - t0 }, 'Sync batch HTTP complete');
  const entries = extractZip(zip);

  const safeBase = resolvePath(config.LOCAL_STORE_DIR);
  await Promise.all(
    entries.map(async ({ name, data }) => {
      const slash = name.indexOf('/');
      let target: string;
      if (slash === -1) {
        // Root-level file
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
        if (folder === 'conf') {
          target = resolvePath(config.LOCAL_STORE_DIR, 'conf', filename);
          if (!target.startsWith(safeBase + '/')) {
            logger.warn({ name }, 'Skipping ZIP conf entry: path traversal detected');
            return;
          }
          await mkdir(join(config.LOCAL_STORE_DIR, 'conf'), { recursive: true });
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
        } else if (folder === 'rcs') {
          target = resolvePath(config.LOCAL_STORE_DIR, 'rcs', filename);
          if (!target.startsWith(safeBase + '/')) {
            logger.warn({ name }, 'Skipping ZIP rcs entry: path traversal detected');
            return;
          }
          const lastSlash = filename.lastIndexOf('/');
          const parentDir = lastSlash !== -1
            ? join(config.LOCAL_STORE_DIR, 'rcs', filename.slice(0, lastSlash))
            : join(config.LOCAL_STORE_DIR, 'rcs');
          await mkdir(parentDir, { recursive: true });
        } else if (folder === 'users') {
          target = resolvePath(config.LOCAL_STORE_DIR, 'users', filename);
          if (!target.startsWith(safeBase + '/')) {
            logger.warn({ name }, 'Skipping ZIP users entry: path traversal detected');
            return;
          }
          const lastSlash = filename.lastIndexOf('/');
          const parentDir = lastSlash !== -1
            ? join(config.LOCAL_STORE_DIR, 'users', filename.slice(0, lastSlash))
            : join(config.LOCAL_STORE_DIR, 'users');
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
  logger.debug({ files: entries.length, writeMs: Date.now() - t0Write, totalMs: Date.now() - t0 }, 'Batch download chunk complete');
  return { transferred, decompressed };
}

async function runBatches(
  remoteBase:   string,
  files:        string[],
  batchSize:    number,
  remoteMtimes: Map<string, number>,
): Promise<{ transferred: number; decompressed: number }> {
  let transferred = 0, decompressed = 0;

  // Honour any per-remote cap set by a previous exceed error
  const cap = remoteBatchCap.get(remoteBase);
  let effectiveSize = cap !== undefined ? Math.min(batchSize, cap) : batchSize;

  let i = 0;
  while (i < files.length) {
    const chunk = files.slice(i, i + effectiveSize);
    let succeeded = false;
    let lastErr:   unknown;

    for (let attempt = 1; attempt <= BATCH_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await downloadBatch(remoteBase, chunk, remoteMtimes);
        transferred += result.transferred;
        decompressed += result.decompressed;
        succeeded = true;
        break;
      } catch (err) {
        if (err instanceof SyncAuthError) throw err;
        if (err instanceof HttpError && err.statusCode === 400 && effectiveSize > BATCH_CAP_ON_EXCEED) {
          // Either an explicit "paths exceeds maximum of N" message from the current remote,
          // or a generic 400 from an older remote that doesn't emit that message — both are
          // resolved by capping to 500 and retrying from the same position.
          const reason = err.body.includes('paths exceeds maximum of') ? 'exceed error' : 'bad request (compat)';
          remoteBatchCap.set(remoteBase, BATCH_CAP_ON_EXCEED);
          effectiveSize = BATCH_CAP_ON_EXCEED;
          logger.warn({ remoteBase, forcedBatchSize: BATCH_CAP_ON_EXCEED, reason },
            'Remote enforces batch size limit — capping to 500 for this remote going forward');
          break; // retry from the same position with the smaller size
        }
        if (err instanceof HttpError && err.statusCode === 400 && effectiveSize <= BATCH_CAP_ON_EXCEED) {
          // Already at cap and still getting 400 — not a batch-size issue; treat as fatal
          lastErr = err;
          break;
        }
        lastErr = err;
        if (attempt < BATCH_MAX_ATTEMPTS) {
          logger.warn({ err, attempt, maxAttempts: BATCH_MAX_ATTEMPTS, delayMs: BATCH_RETRY_DELAY_MS }, 'Batch download failed, retrying');
          await new Promise<void>(res => setTimeout(res, BATCH_RETRY_DELAY_MS));
        }
      }
    }

    if (succeeded) {
      logger.debug({ done: Math.min(i + chunk.length, files.length), total: files.length }, 'Sync batch complete');
      i += chunk.length;
    } else if (lastErr !== undefined) {
      logger.error({ err: lastErr, maxAttempts: BATCH_MAX_ATTEMPTS }, 'Batch download failed after all retries — aborting sync');
      throw lastErr;
    }
    // else: exceed error hit and effectiveSize was reduced — loop again from same i
  }
  return { transferred, decompressed };
}

// ── Core sync executor ────────────────────────────────────────────────────────

async function executeSync(
  remoteBase: string,
  selfBaseUrl: string | undefined,
  since: string | undefined,  // yyyyMMdd-HHmmss UTC, or undefined for a full sync
): Promise<SyncStats> {
  const callbackUrl = selfBaseUrl ? `${selfBaseUrl}/api/sync/trigger` : undefined;
  logger.info({ remote: remoteBase, since: since ?? 'full', hasCallback: !!callbackUrl }, 'Sync starting');
  const start = Date.now();

  try {
    // Build browse URL
    const browseParams = new URLSearchParams();
    if (since) browseParams.set('since', since);
    if (callbackUrl) browseParams.set('callback', callbackUrl);
    const browseQs = browseParams.toString();
    const browseUrl = browseQs ? `${remoteBase}/api/sync/browse?${browseQs}` : `${remoteBase}/api/sync/browse`;

    const t0Browse = Date.now();
    const { buf: browseBuf, headers: browseHeaders } = await fetchRaw(browseUrl, syncKeyHeader());
    let rawBrowse: {
      folders: Record<string, (string | BrowseFile)[]>;
      browseT?: string;
      browseTs?: number;
    };
    try {
      rawBrowse = JSON.parse(browseBuf.toString('utf-8')) as typeof rawBrowse;
    } catch (parseErr) {
      logger.debug(
        { url: browseUrl, headers: browseHeaders, body: browseBuf.toString('utf-8').slice(0, 500) },
        'Browse response is not valid JSON',
      );
      throw parseErr;
    }
    // Prefer new browseT string; convert legacy browseTs number if present
    const remoteBrowseT = rawBrowse.browseT
      ?? (rawBrowse.browseTs ? formatBrowseT(rawBrowse.browseTs) : undefined);

    // Normalise folders (legacy servers may return string[] instead of BrowseFile[])
    const folders: Record<string, BrowseFile[]> = {};
    for (const [folder, items] of Object.entries(rawBrowse.folders)) {
      folders[folder] = items.map(item => (typeof item === 'string' ? { name: item, mtime: 0 } : item));
    }

    const remoteFileCount = Object.values(folders).reduce((s, fs) => s + fs.length, 0);
    logger.debug({ url: browseUrl, durationMs: Date.now() - t0Browse, files: remoteFileCount }, 'Sync browse HTTP complete');

    const fp = (folder: string, name: string) => folder ? `${folder}/${name}` : name;

    // Build flat list of remote-reported files and their mtimes
    const remoteMtimes = new Map<string, number>();
    const allRemotePaths: string[] = [];
    for (const [folder, files] of Object.entries(folders)) {
      for (const f of files) {
        const flatPath = fp(folder, f.name);
        remoteMtimes.set(flatPath, f.mtime);
        allRemotePaths.push(flatPath);
      }
    }

    // Stat only the specific files the remote reported — O(remote files) not O(all local files).
    // For delta syncs with no remote changes this is 0 stat calls, cutting ~6 s to ~0 s.
    const t0Stat = Date.now();
    const localMtimes = new Map<string, number>();
    await Promise.all(allRemotePaths.map(async (flatPath) => {
      try {
        const info = await stat(resolveLocalPath(flatPath));
        localMtimes.set(flatPath, info.mtimeMs);
      } catch { /* file absent locally */ }
    }));
    logger.debug({ remoteFiles: allRemotePaths.length, localFound: localMtimes.size, durationMs: Date.now() - t0Stat }, 'Local stat complete');

    const missing: string[] = [];
    for (const flatPath of allRemotePaths) {
      const remoteMtime = remoteMtimes.get(flatPath)!;
      const localMtime  = localMtimes.get(flatPath);
      // localMtime undefined means file is absent locally — always download.
      // Round both sides to second precision: remote returns precise ms but local filesystems
      // on some VMs store mtime at 1-second granularity, so utimes(remote_ms) reads back as
      // floor(remote_ms/1000)*1000 locally. Comparing at second precision avoids re-downloading
      // unchanged files while still catching genuine updates (different second).
      if (localMtime !== undefined && (!remoteMtime || Math.round(localMtime / 1000) >= Math.round(remoteMtime / 1000))) continue;
      missing.push(flatPath);
    }
    logger.debug({ remoteFiles: allRemotePaths.length, localFound: localMtimes.size, missing: missing.length }, 'Remote/local comparison complete');

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

    // Binary (png) files use the base batch size; text (json/md) use 10× for throughput.
    // Exception: delta syncs with few files skip the split and download everything together.
    const isBinary    = (p: string) => /\.png$/i.test(p);
    const textBatch   = batchSize * 10;
    const syncLabel   = since ? 'Delta' : 'Initial';
    if (since && missing.length < batchSize) {
      logger.debug({ count: missing.length, batchSize: missing.length }, 'Delta sync: downloading all files together (below batch threshold)');
      const r = await runBatches(remoteBase, missing, missing.length, remoteMtimes);
      totalTransferred += r.transferred; totalDecompressed += r.decompressed;
    } else {
      const binaryFiles = missing.filter(isBinary);
      const textFiles   = missing.filter(p => !isBinary(p));
      if (binaryFiles.length > 0) {
        logger.debug({ count: binaryFiles.length, batchSize }, `${syncLabel} sync: downloading binary files`);
        const r = await runBatches(remoteBase, binaryFiles, batchSize, remoteMtimes);
        totalTransferred += r.transferred; totalDecompressed += r.decompressed;
      }
      if (textFiles.length > 0) {
        logger.debug({ count: textFiles.length, batchSize: textBatch }, `${syncLabel} sync: downloading text files`);
        const r = await runBatches(remoteBase, textFiles, textBatch, remoteMtimes);
        totalTransferred += r.transferred; totalDecompressed += r.decompressed;
      }
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
    if (updatedRootFiles.length > 0) {
      emit('root', { files: updatedRootFiles, ts });
    }
    if (updatedFolders.has('conf')) {
      emit('config', { ts });
      void refreshLastUpdated(); // re-read file mtimes set by utimes() during sync
    }
    if (updatedFolders.has('dest')) {
      emit('dest', { ts });
      if (onDestChangelogSynced && missing.includes('dest/changelog.md')) onDestChangelogSynced();
      if (onDestSynced) onDestSynced();
    }
    if (updatedFolders.has('rcs')) {
      const rcSaKeys = [...new Set(
        missing
          .filter(p => p.startsWith('rcs/'))
          .map(p => { const parts = p.split('/'); return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : ''; })
          .filter(Boolean),
      )];
      if (rcSaKeys.length > 0 && onRcsSynced) {
        void (onRcsSynced as (s: string[]) => void | Promise<void>)(rcSaKeys);
      } else {
        emit('rcs', { ts });
      }
      if (onRcsChangelogSynced && missing.includes('rcs/changelog.md')) onRcsChangelogSynced();
    }
    if (updatedFolders.has('users')) {
      const userSaKeys = [...new Set(
        missing
          .filter(p => p.startsWith('users/'))
          .map(p => { const parts = p.split('/'); return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : ''; })
          .filter(Boolean),
      )];
      if (userSaKeys.length > 0 && onUsersSynced) {
        void (onUsersSynced as (s: string[]) => void | Promise<void>)(userSaKeys);
      } else {
        emit('users', { ts });
      }
      if (onUsersChangelogSynced && missing.includes('users/changelog.md')) onUsersChangelogSynced();
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
