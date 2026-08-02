import { Router } from 'express';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/requireAuth.js';
import {
  isSubaccountRestricted,
  listDestinations,
  refreshDestinations,
  refreshSubaccountDestinations,
  searchDestinations,
  getDestination,
  exportDestination,
  saveDestinationEntry,
  getDestinationChangelog,
} from '../services/destinationService.js';

const router = Router();

const RESTRICTED = { ok: false, error: 'Access to this subaccount is restricted' } as const;

router.get('/search', requireAdmin, async (req, res, next) => {
  try {
    const q         = String(req.query['q']         ?? '').trim();
    const region    = req.query['region']    ? String(req.query['region'])    : undefined;
    const subdomain = req.query['subdomain'] ? String(req.query['subdomain']) : undefined;
    if (region && subdomain && await isSubaccountRestricted(region, subdomain)) {
      return void res.status(403).json(RESTRICTED);
    }
    const data = await searchDestinations(q, region, subdomain);
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
    const result   = await refreshDestinations(username);
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

router.post('/:region/:subdomain/refresh', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq  = req as AuthRequest;
    const username = authReq.authSession?.email || authReq.authSession?.firstName || 'admin';
    const result   = await refreshSubaccountDestinations(region, subdomain, username);
    res.json({ ok: true, result });
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
