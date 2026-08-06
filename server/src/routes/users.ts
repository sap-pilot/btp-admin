import { Router } from 'express';
import { requireAdmin, type AuthRequest } from '../middleware/requireAuth.js';
import { getAutoGlobalRefreshMs } from '../services/configService.js';
import { isRcSubaccountRestricted } from '../services/rcService.js';
import {
  getGlobalUsersRefreshTs,
  refreshUsers,
  refreshSubaccountUsers,
  listUsers,
  getUsersForSubaccount,
  getUserDetail,
  getUserChangelog,
  getUserGlobalAccess,
  searchUsers,
  getGlobalUsersChangelog,
  searchGlobalUsersChangelogs,
} from '../services/userService.js';

const router = Router();

const RESTRICTED = { ok: false, error: 'Access to this subaccount is restricted' } as const;

function sessionUser(req: AuthRequest): string {
  return req.authSession?.email || req.authSession?.firstName || 'admin';
}

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', requireAdmin, async (req, res, next) => {
  try {
    const authReq      = req as AuthRequest;
    const globalTs     = getGlobalUsersRefreshTs();
    const autoGlobalMs = getAutoGlobalRefreshMs();

    if (autoGlobalMs > 0 && (globalTs === null || (Date.now() - globalTs) > autoGlobalMs)) {
      void refreshUsers(sessionUser(authReq), 'auto').catch(() => {});
    }

    res.json({ ok: true, globalRefreshTs: globalTs, autoGlobalRefreshHrs: autoGlobalMs / 3_600_000 });
  } catch (err) { next(err); }
});

// ── Global refresh ────────────────────────────────────────────────────────────

router.post('/refresh', requireAdmin, async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const force   = req.query['force'] === 'true';
    const result  = await refreshUsers(sessionUser(authReq), 'manual', force);
    if (result.skipped) { res.json({ ok: false, busy: true, reason: 'Refresh already in progress' }); return; }
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

// ── Overview list ─────────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const data = await listUsers();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// ── Global changelog ──────────────────────────────────────────────────────────

router.get('/global-changelog', requireAdmin, async (req, res, next) => {
  try {
    const file = typeof req.query['file'] === 'string' ? req.query['file'] : undefined;
    const result = await getGlobalUsersChangelog(file);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.get('/global-changelog/search', requireAdmin, async (req, res, next) => {
  try {
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const result = await searchGlobalUsersChangelogs(q);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Full-text search ──────────────────────────────────────────────────────────

router.get('/search', requireAdmin, async (req, res, next) => {
  try {
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const result = await searchUsers(q);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Subaccount refresh ────────────────────────────────────────────────────────

router.post('/:region/:subdomain/refresh', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq = req as AuthRequest;
    const result  = await refreshSubaccountUsers(region, subdomain, sessionUser(authReq), 'manual');
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

// ── Full user list for modal ──────────────────────────────────────────────────

router.get('/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const users = await getUsersForSubaccount(region, subdomain);
    res.json({ ok: true, users });
  } catch (err) { next(err); }
});

// ── Single user endpoints ─────────────────────────────────────────────────────

router.get('/:region/:subdomain/:origin/:email/history', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, origin, email } = req.params as { region: string; subdomain: string; origin: string; email: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const data = await getUserChangelog(region, subdomain, origin, email);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:origin/:email/access', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, origin, email } = req.params as { region: string; subdomain: string; origin: string; email: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const data = await getUserGlobalAccess(origin, email);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:origin/:email/export', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, origin, email } = req.params as { region: string; subdomain: string; origin: string; email: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const user = await getUserDetail(region, subdomain, origin, email);
    if (!user) return void res.status(404).json({ ok: false, error: 'Not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${region}_${subdomain}_${encodeURIComponent(origin)}_${encodeURIComponent(email)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(user, null, 2));
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:origin/:email', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, origin, email } = req.params as { region: string; subdomain: string; origin: string; email: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const user = await getUserDetail(region, subdomain, origin, email);
    if (!user) return void res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, user });
  } catch (err) { next(err); }
});

export default router;
