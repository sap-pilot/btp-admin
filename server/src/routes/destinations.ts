import { Router } from 'express';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/requireAuth.js';
import {
  listDestinations,
  refreshDestinations,
  searchDestinations,
  getDestination,
  exportDestination,
  saveDestinationEntry,
  getDestinationChangelog,
} from '../services/destinationService.js';

const router = Router();

router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const q         = String(req.query['q']         ?? '').trim();
    const region    = req.query['region']    ? String(req.query['region'])    : undefined;
    const subdomain = req.query['subdomain'] ? String(req.query['subdomain']) : undefined;
    const data = await searchDestinations(q, region, subdomain);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (_req, res, next) => {
  try {
    const data = await listDestinations();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/refresh', requireAdmin, async (_req, res, next) => {
  try {
    const result = await refreshDestinations();
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

// ── Single-destination endpoints ──────────────────────────────────────────────

router.get('/:region/:subdomain/:name/changelog', requireAuth, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    const data = await getDestinationChangelog(region, subdomain, name);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name/export', requireAuth, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    const data = await exportDestination(region, subdomain, name);
    if (!data) return void res.status(404).json({ ok: false, error: 'Not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${region}_${subdomain}_${name}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name', requireAuth, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    const result = await getDestination(region, subdomain, name);
    if (!result) return void res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.put('/:region/:subdomain/:name', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    const { data, username = 'admin' } = req.body as { data: Record<string, unknown>; username?: string };
    // Prefer session username if available
    const authReq   = req as AuthRequest;
    const sessionUser = authReq.authSession?.email || authReq.authSession?.firstName || username;
    if (!data || typeof data !== 'object') return void res.status(400).json({ ok: false, error: 'data required' });
    await saveDestinationEntry(region, subdomain, name, data, sessionUser);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
