import { Router } from 'express';
import { browseResponseFiles, formatBrowseT, parseBrowseT } from '../services/localStoreService.js';
import { handleDownloadTrigger, registerCallback } from '../services/syncService.js';
import { logger } from '../logger.js';
import { requireSyncAuth, getClientIp } from '../middleware/requireAuth.js';
import { resolve as resolvePath, join } from 'node:path';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

const router = Router();

router.post('/batch', requireSyncAuth, async (req, res, next) => {
  try {
    const { paths } = req.body as { paths?: unknown };
    const rejectBatch = (status: number, error: string) => {
      logger.debug({ from: getClientIp(req), status, error }, 'sync batch rejected');
      res.status(status).json({ error });
    };
    if (!Array.isArray(paths) || paths.length === 0) {
      rejectBatch(400, 'paths must be a non-empty array');
      return;
    }

    // Resp files (region/sub/...) live under LOCAL_STORE_DIR/resp/; all other
    // known prefixes map directly under LOCAL_STORE_DIR.
    const DIRECT_PREFIXES = new Set(['conf', 'dest', 'rcs', 'users', 'apps', 'audit-log']);
    const safeBase = resolvePath(config.LOCAL_STORE_DIR);

    // Validate each requested path; skip invalid ones instead of aborting the
    // whole batch so one bad entry doesn't block all legitimate files.
    const validPaths: string[] = [];
    for (const raw of paths as unknown[]) {
      if (typeof raw !== 'string' || raw.includes('..') || raw.startsWith('/') || raw.startsWith('\\')) {
        logger.warn({ entry: String(raw).slice(0, 100) }, 'sync batch: skipping invalid path entry');
        continue;
      }
      const p = raw;
      const parts = p.split('/');
      let ok = true;
      if (parts.length === 1) {
        ok = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(json|md)$/.test(parts[0]!);
      } else if (parts[0] === 'dest') {
        if (parts.length === 2)      ok = !!parts[1] && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(parts[1]);
        else if (parts.length === 4) ok = !!(parts[1] && parts[2] && parts[3]);
        else if (parts.length === 6) ok = !!(parts[1] && parts[2] && parts[3] && parts[4] && parts[5]) && /^[\w][\w.-]*\.json$/.test(parts[5]!);
        else ok = false;
      } else if (parts[0] === 'rcs') {
        if (parts.length === 2)      ok = !!parts[1] && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(parts[1]);
        else                         ok = parts.length === 4 && !!(parts[1] && parts[2] && parts[3]);
      } else if (parts[0] === 'users') {
        if (parts.length === 2)      ok = !!parts[1] && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(parts[1]);
        else                         ok = parts.length === 5 && !!(parts[1] && parts[2] && parts[3] && parts[4]);
      } else if (parts[0] === 'apps') {
        if (parts.length === 2)      ok = !!parts[1] && /^(stats|aod-stats|aod-config)\.(csv|json)$/.test(parts[1]);
        else if (parts.length === 4) ok = !!(parts[1] && parts[2] && parts[3]) && /^accesslog(\.\d{8})?\.csv$/.test(parts[3]!);
        else if (parts.length === 5) ok = !!(parts[1] && parts[2] && parts[3] && parts[4]) && /^[\w-]+(?:\.deleted)?\.json$/.test(parts[4]!);
        else ok = false;
      } else if (parts[0] === 'audit-log') {
        ok = parts.length === 4 && !!(parts[1] && parts[2] && parts[3]) &&
          /^\d{4}-\d{2}-\d{2}T\d{2}_\d+_\d+_\d+_\d+(?:_\d+)?\.json$/.test(parts[3]!);
      } else {
        ok = parts.length === 2 && !!(parts[0] && parts[1]);
      }
      if (!ok) {
        logger.warn({ path: p }, 'sync batch: skipping path with invalid format');
        continue;
      }
      // Path traversal guard
      if (!resolvePath(safeBase, p).startsWith(safeBase + '/')) {
        logger.warn({ path: p }, 'sync batch: skipping path traversal attempt');
        continue;
      }
      validPaths.push(p);
    }

    if (validPaths.length === 0) {
      rejectBatch(400, 'no valid paths in request');
      return;
    }

    const fileEntries = validPaths.map(p => {
      const slash = p.indexOf('/');
      const first = slash === -1 ? '' : p.slice(0, slash);
      const actualPath = (slash === -1 || DIRECT_PREFIXES.has(first))
        ? join(config.LOCAL_STORE_DIR, p)
        : join(config.LOCAL_STORE_DIR, 'resp', p);
      return { name: p, actualPath };
    });

    // Use system zip (normal compression) with filenames piped on stdin to
    // avoid arg-list length limits. resolvePath ensures absolute paths so the
    // zip subprocess can locate the output file regardless of its cwd.
    const tmpBase = resolvePath(config.LOCAL_STORE_DIR, '..', 'tmp');
    await mkdir(tmpBase, { recursive: true });
    const tmpZip  = join(tmpBase, `sync-batch-${randomBytes(8).toString('hex')}.zip`);

    // -q suppresses per-file output; without it the stdout pipe fills and zip
    // deadlocks when the batch is large (pipe buffer ~64 KB ≈ ~1 300 file lines).
    const runZip = (cwd: string, args: string[], names: string[]) =>
      new Promise<void>((resolve, reject) => {
        const proc = spawn('zip', ['-q', ...args], { cwd });
        proc.stdout?.resume();
        proc.stderr?.resume();
        proc.on('close', code => {
          if (code === 0 || code === 12) { resolve(); return; }
          // code 18 = some input files not found — zip skips them; archive still usable
          if (code === 18) {
            logger.warn({ cwd, count: names.length }, 'sync batch: zip skipped missing files (code 18)');
            resolve(); return;
          }
          reject(new Error(`zip exited with code ${code}`));
        });
        proc.on('error', reject);
        proc.stdin!.on('error', () => { /* ignore EPIPE if zip exits early */ });
        proc.stdin!.end(names.join('\n'));
      });

    try {
      // Split by storage location: DIRECT_PREFIXES are under LOCAL_STORE_DIR,
      // everything else lives under LOCAL_STORE_DIR/resp — both keep their
      // logical entry name intact so the consumer can reconstruct paths.
      const directNames = fileEntries
        .filter(e => !e.name.includes('/') || DIRECT_PREFIXES.has(e.name.slice(0, e.name.indexOf('/'))))
        .map(e => e.name);
      const respNames = fileEntries
        .filter(e => e.name.includes('/') && !DIRECT_PREFIXES.has(e.name.slice(0, e.name.indexOf('/'))))
        .map(e => e.name);

      logger.debug({ count: fileEntries.length, direct: directNames.length, resp: respNames.length }, 'sync batch: creating zip');
      const t0Zip = Date.now();

      if (directNames.length > 0)
        await runZip(resolvePath(config.LOCAL_STORE_DIR), [tmpZip, '-@'], directNames);
      if (respNames.length > 0)
        await runZip(resolvePath(config.LOCAL_STORE_DIR, 'resp'),
          directNames.length > 0 ? ['-u', tmpZip, '-@'] : [tmpZip, '-@'], respNames);

      const zipSize = await stat(tmpZip).then(s => s.size).catch(() => 0);
      logger.debug({ count: fileEntries.length, sizeKB: Math.round(zipSize / 1024), durationMs: Date.now() - t0Zip }, 'sync batch: zip ready, streaming to consumer');

      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename="batch.zip"');
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(tmpZip);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(res, { end: false });
      });
      res.end();
    } finally {
      await unlink(tmpZip).catch(() => { /* ignore */ });
    }
  } catch (err) {
    next(err);
  }
});

router.get('/trigger', requireSyncAuth, (req, res) => {
  void req;
  handleDownloadTrigger();
  res.json({ ok: true });
});

router.get('/browse', requireSyncAuth, async (req, res, next) => {
  try {
    const rawSince = req.query['since'];
    let sinceMs: number | undefined;
    if (typeof rawSince === 'string' && rawSince) {
      if (/^\d{8}-\d{6}$/.test(rawSince)) {
        const parsed = parseBrowseT(rawSince);
        if (parsed > 0) sinceMs = parsed;
      } else {
        const n = parseInt(rawSince, 10);
        if (n > 0) sinceMs = n;
      }
    }

    const rawCallback = req.query['callback'];
    if (typeof rawCallback === 'string') {
      try {
        const parsed = new URL(rawCallback);
        // Only register https:// callbacks whose hostname matches a known peer URL
        // (SYNC_REMOTE or SELF_URL) or the BTP CF app domain pattern.
        // This prevents an authenticated caller from using callback registration as SSRF.
        const isBtpDomain = /\.cfapps\.[a-z0-9-]+\.hana\.ondemand\.com$/.test(parsed.hostname);
        const isKnownPeer = [config.SYNC_REMOTE, config.SELF_URL]
          .filter(Boolean)
          .some(u => { try { return new URL(u).hostname === parsed.hostname; } catch { return false; } });
        if (parsed.protocol === 'https:' && (isBtpDomain || isKnownPeer)) {
          registerCallback(rawCallback);
        } else {
          logger.warn({ callback: rawCallback, ip: getClientIp(req) }, 'Sync: callback URL rejected — not a known BTP CF hostname');
        }
      } catch { /* invalid URL — ignore */ }
    }

    const browseT = formatBrowseT(Math.floor(Date.now() / 1000) * 1000);
    const folders = await browseResponseFiles(sinceMs);
    res.json({ folders, browseT });
  } catch (err) {
    next(err);
  }
});

export default router;
