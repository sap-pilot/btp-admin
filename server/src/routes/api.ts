import { Router } from 'express';
import { readRawResponseFile, readRootFile, readConfigFile, readDestFile, readResponseFile, readScreenshotFile, readConsoleLogFile, readContentFile, browseResponseFiles, formatBrowseT, parseBrowseT } from '../services/localStoreService.js';
import { buildZip } from '../services/zipBuilder.js';
import { syncFromRemote, handleDownloadTrigger, registerCallback, type SyncStats } from '../services/syncService.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import { requireAuth, requireAdmin, requireSyncAuth, requireSyncAuthOrOpen } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { userLabel } from '../services/authService.js';
import { subscribe } from '../services/liveEvents.js';
import { getSites } from '../services/configService.js';
import { getCity } from '../services/geoService.js';

const router = Router();

// Public — exempt from session auth; used by the sidebar before login for site-switcher and title.
router.get('/info', (_req, res) => {
  res.json({ syncRemote: !!config.SYNC_REMOTE, city: getCity(), sites: getSites(), maxStorageDays: config.MAX_RESPONSE_STORAGE_DAYS });
});

router.get('/events', (req, res) => {
  const svc        = typeof req.query['service'] === 'string' ? req.query['service'] : null;
  const configOnly = req.query['config'] === '1';
  const destOnly   = req.query['dest']   === '1';

  let topics: string[];
  if (configOnly) {
    topics = ['config', 'refresh-subaccounts'];
  } else if (destOnly) {
    topics = ['dest', 'refresh-destinations'];
  } else {
    topics = ['global'];
    if (svc) topics.push(`service:${svc}`);
  }

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
    const { force } = (req.body as { force?: boolean } | undefined) ?? {};
    const user = (req as AuthRequest).authSession ? userLabel((req as AuthRequest).authSession!) : 'anon';
    logger.info({ from: req.ip, user, force: !!force }, 'On-demand sync triggered');
    const stats: SyncStats = await syncFromRemote(config.SYNC_REMOTE, { selfBaseUrl: config.SELF_URL, force: !!force });
    res.json({ ok: !stats.error && !stats.busy, ...stats });
  } catch (err) {
    next(err);
  }
});

router.post('/batch-download', requireSyncAuthOrOpen, async (req, res, next) => {
  try {
    // XSUAA session without admin role cannot use batch-download (it exposes conf/ and dest/)
    const bdSession = (req as AuthRequest).authSession;
    if (bdSession && !bdSession.isAdmin) {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }
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
      if (parts.length === 1) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(json|md)$/.test(parts[0]!)) {
          res.status(400).json({ error: `invalid root filename: ${p}` });
          return;
        }
      } else if (parts.length !== 2 || !parts[0] || !parts[1]) {
        res.status(400).json({ error: `path must be filename or folder/filename: ${p}` });
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
          const folder   = p.slice(0, slash);
          const rest     = p.slice(slash + 1);
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

router.get('/download-trigger', requireSyncAuth, (req, res) => {
  void req;
  handleDownloadTrigger();
  res.json({ ok: true });
});

router.get('/browse', requireSyncAuthOrOpen, async (req, res, next) => {
  try {
    // XSUAA session without admin role cannot browse (response includes conf/ and dest/ keys)
    const brSession = (req as AuthRequest).authSession;
    if (brSession && !brSession.isAdmin) {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }
    const rawSince = req.query['since'];
    let sinceMs: number | undefined;
    if (typeof rawSince === 'string' && rawSince) {
      if (/^\d{8}-\d{6}$/.test(rawSince)) {
        // New format: yyyyMMdd-HHmmss UTC
        const parsed = parseBrowseT(rawSince);
        if (parsed > 0) sinceMs = parsed;
      } else {
        // Legacy: bare Unix-ms timestamp from older consumers
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

    // Floor to second precision before the FS scan so browseT aligns with
    // second-precision file mtimes and can be used directly as the next ?since=.
    const browseT = formatBrowseT(Math.floor(Date.now() / 1000) * 1000);
    const folders = await browseResponseFiles(sinceMs);
    res.json({ folders, browseT });
  } catch (err) {
    next(err);
  }
});

router.get('/download', requireSyncAuth, async (req, res, next) => {
  try {
    // authSession present → XSUAA session used (not peer HMAC); absent → peer or open
    const dlSession = (req as AuthRequest).authSession;
    const isAdmin   = !dlSession || dlSession.isAdmin;

    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (!rawPath || rawPath.includes('..') || rawPath.startsWith('/') || rawPath.startsWith('\\')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const slash = rawPath.indexOf('/');
    if (slash === -1) {
      // Root file — admin only
      if (!isAdmin) { res.status(403).json({ error: 'Admin role required' }); return; }
      const buf = await readRootFile(rawPath);
      res.type(rawPath.endsWith('.json') ? 'application/json' : 'text/plain').send(buf);
      return;
    }
    const folder = rawPath.slice(0, slash);
    const rest   = rawPath.slice(slash + 1);
    if (!folder || !rest) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    if (folder === 'conf') {
      if (!isAdmin) { res.status(403).json({ error: 'Admin role required' }); return; }
      const buf = await readConfigFile(rest);
      res.type(rest.endsWith('.json') ? 'application/json' : 'text/plain').send(buf);
    } else if (folder === 'dest') {
      if (!isAdmin) { res.status(403).json({ error: 'Admin role required' }); return; }
      const buf = await readDestFile(rest);
      res.type(rest.endsWith('.png') ? 'image/png' : rest.endsWith('.md') ? 'text/plain' : 'application/json').send(buf);
    } else {
      // resp/{service}/filename — allowed for any authenticated user; single level only
      if (rest.includes('/')) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }
      if (rest.endsWith('.png')) {
        const buf = await readScreenshotFile(folder, rest);
        res.type('image/png').send(buf);
      } else if (rest.endsWith('.log')) {
        const buf = await readConsoleLogFile(folder, rest);
        res.type('text/plain').send(buf);
      } else if (rest.endsWith('.html')) {
        const buf = await readContentFile(folder, rest);
        res.type('text/plain').send(buf);
      } else {
        const data = await readResponseFile(folder, rest);
        res.json(data);
      }
    }
  } catch (err) {
    next(err);
  }
});

export default router;
