import { Router } from 'express';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/requireAuth.js';
import { logger } from '../logger.js';
import {
  isSubaccountRestricted,
  listDestinations,
  refreshDestinations,
  refreshSubaccountDestinations,
  searchDestinations,
  getSubaccountDestinationNames,
  getDestination,
  exportDestination,
  saveDestinationEntry,
  getDestinationChangelog,
  getGlobalRefreshTs,
  getGlobalChangelog,
  getGlobalChangelogFile,
} from '../services/destinationService.js';
import { getAutoGlobalRefreshMs, getAutoSubaccountRefreshMs } from '../services/configService.js';

const router = Router();

const RESTRICTED = { ok: false, error: 'Access to this subaccount is restricted' } as const;

router.get('/status', requireAdmin, async (req, res, next) => {
  try {
    const authReq  = req as AuthRequest;
    const username = authReq.authSession?.email || authReq.authSession?.firstName || 'system';
    const globalTs = getGlobalRefreshTs();
    const autoGlobalMs = getAutoGlobalRefreshMs();
    const autoSaMs     = getAutoSubaccountRefreshMs();

    // Auto-trigger a global refresh in the background if threshold exceeded
    if (globalTs === null || (Date.now() - globalTs) > autoGlobalMs) {
      void refreshDestinations(username, 'auto').catch(() => {});
    }

    res.json({
      ok:                       true,
      globalRefreshTs:          globalTs,
      autoGlobalRefreshHrs:     autoGlobalMs / 3_600_000,
      autoSubaccountRefreshMins: autoSaMs   / 60_000,
    });
  } catch (err) { next(err); }
});

router.get('/search', requireAdmin, async (req, res, next) => {
  try {
    const q         = String(req.query['q']         ?? '').trim();
    const region    = req.query['region']    ? String(req.query['region'])    : undefined;
    const subdomain = req.query['subdomain'] ? String(req.query['subdomain']) : undefined;
    if (region && subdomain && await isSubaccountRestricted(region, subdomain)) {
      return void res.status(403).json(RESTRICTED);
    }
    const authReq = req as AuthRequest;
    const user    = authReq.authSession?.email || authReq.authSession?.firstName || 'anonymous';
    const t0      = Date.now();
    const data    = await searchDestinations(q, region, subdomain);
    logger.info(
      { user, query: q, results: data.length, ms: Date.now() - t0, ...(region ? { region } : {}), ...(subdomain ? { subdomain } : {}) },
      'Destination search',
    );
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const data = await listDestinations();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/refresh', requireAdmin, async (req, res, next) => {
  try {
    const authReq  = req as AuthRequest;
    const username = authReq.authSession?.email || authReq.authSession?.firstName || 'admin';
    const force    = req.query['force'] === 'true';
    const result   = await refreshDestinations(username, 'manual', force);
    if (result.skipped) {
      res.json({ ok: false, busy: true, reason: 'Refresh already in progress' });
      return;
    }
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

router.get('/global-changelog', requireAdmin, async (req, res, next) => {
  try {
    const file = typeof req.query['file'] === 'string' ? req.query['file'] : undefined;
    if (file) {
      const data = await getGlobalChangelogFile(file);
      res.json({ ok: true, data });
    } else {
      const result = await getGlobalChangelog();
      res.json({ ok: true, ...result });
    }
  } catch (err) { next(err); }
});

router.post('/:region/:subdomain/refresh', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq  = req as AuthRequest;
    const username = authReq.authSession?.email || authReq.authSession?.firstName || 'admin';
    const result   = await refreshSubaccountDestinations(region, subdomain, username, 'manual');
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

// ── Subaccount destination names (proactive load) ────────────────────────────

router.get('/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq  = req as AuthRequest;
    const username = authReq.authSession?.email || authReq.authSession?.firstName || 'admin';
    const force    = req.query['force'] === '1';
    const result   = await getSubaccountDestinationNames(region, subdomain, username, force);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Single-destination endpoints ──────────────────────────────────────────────

router.get('/:region/:subdomain/:name/changelog', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const data = await getDestinationChangelog(region, subdomain, name);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name/export', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const data = await exportDestination(region, subdomain, name);
    if (!data) return void res.status(404).json({ ok: false, error: 'Not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${region}_${subdomain}_${name}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const result = await getDestination(region, subdomain, name);
    if (!result) return void res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.put('/:region/:subdomain/:name', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const { data, username = 'admin' } = req.body as { data: Record<string, unknown>; username?: string };
    const authReq   = req as AuthRequest;
    const sessionUser = authReq.authSession?.email || authReq.authSession?.firstName || username;
    if (!data || typeof data !== 'object') return void res.status(400).json({ ok: false, error: 'data required' });
    await saveDestinationEntry(region, subdomain, name, data, sessionUser);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
