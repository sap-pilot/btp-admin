import { Router } from 'express';
import { readRawResponseFile, readResponseFile, readScreenshotFile, readConsoleLogFile, readContentFile } from '../services/localStoreService.js';
import { syncFromRemote, type SyncStats } from '../services/syncService.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import { requireAuth, requireAdmin, getClientIp } from '../middleware/requireAuth.js';
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
  const rcsOnly    = req.query['rcs']    === '1';
  const usersOnly  = req.query['users']  === '1';

  let topics: string[];
  if (configOnly) {
    topics = ['config', 'refresh-subaccounts'];
  } else if (destOnly) {
    topics = ['dest', 'refresh-destinations'];
  } else if (rcsOnly) {
    topics = ['rcs', 'refresh-rcs'];
  } else if (usersOnly) {
    topics = ['users', 'refresh-users'];
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
    logger.info({ from: getClientIp(req), user, force: !!force }, 'On-demand sync triggered');
    const stats: SyncStats = await syncFromRemote(config.SYNC_REMOTE, { selfBaseUrl: config.SELF_URL, force: !!force });
    res.json({ ok: !stats.error && !stats.busy, ...stats });
  } catch (err) {
    next(err);
  }
});

// View endpoint: XSUAA session required; restricted to resp/{service}/{filename} only.
// Used by the UI to display response JSON, screenshots, console logs, and page source.
// Sync peers use /api/sync/browse + /api/sync/batch instead.
router.get('/view', requireAuth, async (req, res, next) => {
  try {
    const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
    if (!rawPath || rawPath.includes('..') || rawPath.startsWith('/') || rawPath.startsWith('\\')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    const slash = rawPath.indexOf('/');
    if (slash === -1 || slash === rawPath.length - 1) {
      res.status(400).json({ error: 'Invalid path: must be service/filename' });
      return;
    }
    const service = rawPath.slice(0, slash);
    const filename = rawPath.slice(slash + 1);
    if (!service || !filename || filename.includes('/')) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }
    if (filename.endsWith('.png')) {
      const buf = await readScreenshotFile(service, filename);
      res.type('image/png').send(buf);
    } else if (filename.endsWith('.log')) {
      const buf = await readConsoleLogFile(service, filename);
      res.type('text/plain').send(buf);
    } else if (filename.endsWith('.html')) {
      const buf = await readContentFile(service, filename);
      res.type('text/plain').send(buf);
    } else {
      const data = await readResponseFile(service, filename);
      res.json(data);
    }
  } catch (err) {
    next(err);
  }
});

export default router;
