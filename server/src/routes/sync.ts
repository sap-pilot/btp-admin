import { Router } from 'express';
import { readConfigFile, readDestFile, readRcsFile, readRootFile, readRawResponseFile, readUsersFile, readAodFile, browseResponseFiles, formatBrowseT, parseBrowseT } from '../services/localStoreService.js';
import { buildZip } from '../services/zipBuilder.js';
import { handleDownloadTrigger, registerCallback } from '../services/syncService.js';
import { logger } from '../logger.js';
import { requireSyncAuth, getClientIp } from '../middleware/requireAuth.js';
import { resolve as resolvePath } from 'node:path';
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
    const safeBase = resolvePath(config.LOCAL_STORE_DIR);

    for (const p of paths) {
      if (typeof p !== 'string' || p.includes('..') || p.startsWith('/') || p.startsWith('\\')) {
        rejectBatch(400, `invalid path: ${String(p)}`);
        return;
      }
      const parts = p.split('/');
      if (parts.length === 1) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(json|md)$/.test(parts[0]!)) {
          rejectBatch(400, `invalid root filename: ${p}`);
          return;
        }
      } else if (parts[0] === 'dest') {
        // dest paths: root .md files (dest/changelog*.md) or subaccount files (dest/{region}/{subdomain}/{file})
        if (parts.length === 2) {
          if (!parts[1] || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(parts[1])) {
            rejectBatch(400, `invalid dest root path: ${p}`);
            return;
          }
        } else if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
          rejectBatch(400, `invalid dest path (expected 2 or 4 segments): ${p}`);
          return;
        }
      } else if (parts[0] === 'rcs') {
        // rcs paths: root .md files (rcs/changelog*.md) or subaccount files (rcs/{region}/{subdomain}/{file})
        if (parts.length === 2) {
          if (!parts[1] || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(parts[1])) {
            rejectBatch(400, `invalid rcs root path: ${p}`);
            return;
          }
        } else if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
          rejectBatch(400, `invalid rcs path (expected 2 or 4 segments): ${p}`);
          return;
        }
      } else if (parts[0] === 'users') {
        // users paths: root .md files (users/changelog*.md) or user files (users/{region}/{subdomain}/{origin}/{file})
        if (parts.length === 2) {
          if (!parts[1] || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/.test(parts[1])) {
            rejectBatch(400, `invalid users root path: ${p}`);
            return;
          }
        } else if (parts.length !== 5 || !parts[1] || !parts[2] || !parts[3] || !parts[4]) {
          rejectBatch(400, `invalid users path (expected 2 or 5 segments): ${p}`);
          return;
        }
      } else if (parts[0] === 'apps') {
        // apps paths: stats/config (2 segs), accesslog (4 segs), per-app JSON (5 segs)
        if (parts.length === 2) {
          if (!parts[1] || !/^(stats|aod-stats|aod-config)\.(csv|json)$/.test(parts[1])) {
            rejectBatch(400, `invalid apps root file: ${p}`);
            return;
          }
        } else if (parts.length === 4) {
          if (!parts[1] || !parts[2] || !parts[3] || !/^accesslog(\.\d{8})?\.csv$/.test(parts[3])) {
            rejectBatch(400, `invalid apps access log path: ${p}`);
            return;
          }
        } else if (parts.length === 5) {
          if (!parts[1] || !parts[2] || !parts[3] || !parts[4] || !/^[\w-]+(?:\.deleted)?\.json$/.test(parts[4])) {
            rejectBatch(400, `invalid apps file path: ${p}`);
            return;
          }
        } else {
          rejectBatch(400, `invalid apps path (expected 2, 4, or 5 segments): ${p}`);
          return;
        }
      } else if (parts.length !== 2 || !parts[0] || !parts[1]) {
        rejectBatch(400, `path must be filename or folder/filename: ${p}`);
        return;
      }

      // Path traversal guard
      const targetCheck = resolvePath(safeBase, p);
      if (!targetCheck.startsWith(safeBase + '/')) {
        rejectBatch(400, `invalid path: ${p}`);
        return;
      }
    }

    const entries: { name: string; data: Buffer }[] = [];
    for (const p of paths as string[]) {
      try {
        const slash = p.indexOf('/');
        let data: Buffer;
        if (slash === -1) {
          data = await readRootFile(p);
        } else {
          const folder = p.slice(0, slash);
          const rest   = p.slice(slash + 1);
          if (folder === 'conf') {
            data = await readConfigFile(rest);
          } else if (folder === 'dest') {
            data = await readDestFile(rest);
          } else if (folder === 'rcs') {
            data = await readRcsFile(rest);
          } else if (folder === 'users') {
            data = await readUsersFile(rest);
          } else if (folder === 'apps') {
            data = await readAodFile(rest);
          } else {
            data = await readRawResponseFile(folder, rest);
          }
        }
        entries.push({ name: p, data });
      } catch {
        // skip files pruned since browse was called
      }
    }

    const zip = buildZip(entries);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="batch.zip"');
    res.send(zip);
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
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          registerCallback(rawCallback);
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
