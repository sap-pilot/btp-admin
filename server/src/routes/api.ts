import { Router } from 'express';
import { readRawResponseFile, readResponseFile, readScreenshotFile, readConsoleLogFile, readContentFile, browseResponseFiles } from '../services/status/responseStore.js';
import { buildZip } from '../services/zipBuilder.js';
import { syncFromRemote, handleDownloadTrigger, registerCallback } from '../services/status/syncService.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import { requireAuth, requireSyncAuth, requireSyncAuthOrOpen } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { userLabel } from '../services/authService.js';
import { subscribe } from '../services/liveEvents.js';

const router = Router();

router.get('/events', (req, res) => {
  const svc = typeof req.query['service'] === 'string' ? req.query['service'] : null;
  const topics: string[] = ['global'];
  if (svc) topics.push(`service:${svc}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write('event: connected\ndata: {}\n\n');

  const unsubscribe = subscribe(res, topics);
  req.on('close', unsubscribe);
});

router.get('/me', (req, res) => {
  const x = getXsuaaConfig();
  if (!x) { res.json({ enabled: false }); return; }
  const session = readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret);
  if (!session) { res.json({ enabled: true, loggedIn: false }); return; }
  res.json({ enabled: true, loggedIn: true, firstName: session.firstName, email: session.email, initials: session.initials, isAdmin: session.isAdmin });
});

router.post('/sync', requireAuth, async (req, res, next) => {
  if (!config.SYNC_REMOTE) {
    res.status(400).json({ ok: false, reason: 'SYNC_REMOTE not configured' });
    return;
  }
  try {
    const user = (req as AuthRequest).authSession ? userLabel((req as AuthRequest).authSession!) : 'anon';
    logger.info({ from: req.ip, user }, 'On-demand sync triggered');
    const stats = await syncFromRemote(config.SYNC_REMOTE, { selfBaseUrl: config.SELF_URL });
    res.json({ ok: !stats.error, ...stats });
  } catch (err) {
    next(err);
  }
});

router.post('/batch-download', requireSyncAuthOrOpen, async (req, res, next) => {
  try {
    const { paths } = req.body as { paths?: unknown };
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: 'paths must be a non-empty array' });
      return;
    }
    if (paths.length > 500) {
      res.status(400).json({ error: 'paths exceeds maximum of 500' });
      return;
    }
    for (const p of paths) {
      if (typeof p !== 'string' || p.includes('..') || p.startsWith('/') || p.startsWith('\\')) {
        res.status(400).json({ error: `invalid path: ${String(p)}` });
        return;
      }
      const parts = p.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        res.status(400).json({ error: `path must be folder/filename: ${p}` });
        return;
      }
    }

    const entries: { name: string; data: Buffer }[] = [];
    for (const p of paths as string[]) {
      const [folder, filename] = p.split('/') as [string, string];
      try {
        const data = await readRawResponseFile(folder, filename);
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

router.get('/download-trigger', requireSyncAuth, (req, res) => {
  void req;
  handleDownloadTrigger();
  res.json({ ok: true });
});

router.get('/browse', requireSyncAuthOrOpen, async (req, res, next) => {
  try {
    const rawSince = req.query['since'];
    const since = typeof rawSince === 'string' ? parseInt(rawSince, 10) : undefined;

    const rawCallback = req.query['callback'];
    if (typeof rawCallback === 'string') {
      try {
        const parsed = new URL(rawCallback);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          registerCallback(rawCallback);
        }
      } catch { /* invalid URL — ignore */ }
    }

    const folders = await browseResponseFiles(since && since > 0 ? since : undefined);
    res.json({ folders });
  } catch (err) {
    next(err);
  }
});

router.get('/download', requireSyncAuth, async (req, res, next) => {
  try {
    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (!rawPath || rawPath.includes('..') || rawPath.startsWith('/') || rawPath.startsWith('\\')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const parts = rawPath.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      res.status(400).json({ error: 'Path must be folder/filename' });
      return;
    }
    const [folder, filename] = parts;
    if (filename.endsWith('.png')) {
      const buf = await readScreenshotFile(folder, filename);
      res.type('image/png').send(buf);
    } else if (filename.endsWith('.log')) {
      const buf = await readConsoleLogFile(folder, filename);
      res.type('text/plain').send(buf);
    } else if (filename.endsWith('.html')) {
      const buf = await readContentFile(folder, filename);
      res.type('text/plain').send(buf);
    } else {
      const data = await readResponseFile(folder, filename);
      res.json(data);
    }
  } catch (err) {
    next(err);
  }
});

export default router;
