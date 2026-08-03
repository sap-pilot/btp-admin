import { Router } from 'express';
import { readConfigFile, readDestFile, readRootFile, readRawResponseFile, browseResponseFiles, formatBrowseT, parseBrowseT } from '../services/localStoreService.js';
import { buildZip } from '../services/zipBuilder.js';
import { handleDownloadTrigger, registerCallback } from '../services/syncService.js';
import { logger } from '../logger.js';
import { requireSyncAuth } from '../middleware/requireAuth.js';
import { resolve as resolvePath } from 'node:path';
import { config } from '../config.js';

const router = Router();

router.post('/batch', requireSyncAuth, async (req, res, next) => {
  try {
    const { paths } = req.body as { paths?: unknown };
    const rejectBatch = (status: number, error: string) => {
      logger.debug({ from: req.ip, status, error }, 'sync batch rejected');
      res.status(status).json({ error });
    };
    if (!Array.isArray(paths) || paths.length === 0) {
      rejectBatch(400, 'paths must be a non-empty array');
      return;
    }
    if (paths.length > 500) {
      rejectBatch(400, 'paths exceeds maximum of 500');
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
