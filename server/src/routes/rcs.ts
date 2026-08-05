import { Router } from 'express';
import { requireAdmin, type AuthRequest } from '../middleware/requireAuth.js';
import { logger } from '../logger.js';
import { getAutoGlobalRefreshMs } from '../services/configService.js';
import {
  isRcSubaccountRestricted,
  listRoleCollections,
  refreshRoleCollections,
  refreshSubaccountRoleCollections,
  getSubaccountRcNames,
  getRoleCollection,
  getRCUsers,
  getRCChangelog,
  getGlobalRcsChangelog,
  getGlobalRcsChangelogFile,
  searchGlobalRcsChangelogs,
  searchRoleCollections,
  getGlobalRcsRefreshTs,
  saveRCToLocal,
  addUserToRc,
  removeUserFromRc,
  type RoleCollection,
  type UserReference,
} from '../services/rcService.js';

const router = Router();

const RESTRICTED = { ok: false, error: 'Access to this subaccount is restricted' } as const;

function sessionUser(req: AuthRequest): string {
  return req.authSession?.email || req.authSession?.firstName || 'admin';
}

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', requireAdmin, async (req, res, next) => {
  try {
    const authReq      = req as AuthRequest;
    const globalTs     = getGlobalRcsRefreshTs();
    const autoGlobalMs = getAutoGlobalRefreshMs();

    if (autoGlobalMs > 0 && (globalTs === null || (Date.now() - globalTs) > autoGlobalMs)) {
      void refreshRoleCollections(sessionUser(authReq), 'auto').catch(() => {});
    }

    res.json({
      ok:                   true,
      globalRefreshTs:      globalTs,
      autoGlobalRefreshHrs: autoGlobalMs / 3_600_000,
    });
  } catch (err) { next(err); }
});

// ── Global refresh ────────────────────────────────────────────────────────────

router.post('/refresh', requireAdmin, async (req, res, next) => {
  try {
    const authReq = req as AuthRequest;
    const force   = req.query['force'] === 'true';
    const result  = await refreshRoleCollections(sessionUser(authReq), 'manual', force);
    if (result.skipped) { res.json({ ok: false, busy: true, reason: 'Refresh already in progress' }); return; }
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

// ── Overview list ─────────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (_req, res, next) => {
  try {
    const data = await listRoleCollections();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// ── Global changelog ──────────────────────────────────────────────────────────

router.get('/global-changelog', requireAdmin, async (req, res, next) => {
  try {
    const file = typeof req.query['file'] === 'string' ? req.query['file'] : undefined;
    if (file) {
      const data = await getGlobalRcsChangelogFile(file);
      res.json({ ok: true, data });
    } else {
      const result = await getGlobalRcsChangelog();
      res.json({ ok: true, ...result });
    }
  } catch (err) { next(err); }
});

router.get('/global-changelog/search', requireAdmin, async (req, res, next) => {
  try {
    const q      = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const result = await searchGlobalRcsChangelogs(q);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Full-text search across all RC data ───────────────────────────────────────

router.get('/search', requireAdmin, async (req, res, next) => {
  try {
    const q      = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    const result = await searchRoleCollections(q);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Subaccount refresh ────────────────────────────────────────────────────────

router.post('/:region/:subdomain/refresh', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq = req as AuthRequest;
    const result  = await refreshSubaccountRoleCollections(region, subdomain, sessionUser(authReq), 'manual');
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

// ── RC names for a subaccount (proactive load with auto-refresh) ──────────────

router.get('/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq   = req as AuthRequest;
    const force     = req.query['force'] === '1';
    const noRefresh = req.query['noRefresh'] === '1';
    const result    = await getSubaccountRcNames(region, subdomain, sessionUser(authReq), force, noRefresh);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ── Single RC endpoints ───────────────────────────────────────────────────────

router.get('/:region/:subdomain/:name/changelog', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const data = await getRCChangelog(region, subdomain, name);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name/users', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const users = await getRCUsers(region, subdomain, name);
    res.json({ ok: true, data: users });
  } catch (err) { next(err); }
});

router.post('/:region/:subdomain/:name/users', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq = req as AuthRequest;
    const user    = req.body as UserReference;
    if (!user?.userName || !user?.origin) return void res.status(400).json({ ok: false, error: 'userName and origin required' });
    await addUserToRc(region, subdomain, name, user, sessionUser(authReq));
    const allUsers = await getRCUsers(region, subdomain, name);
    logger.info({ region, subdomain, name, user: user.userName, by: sessionUser(authReq) }, 'User added to RC');
    res.json({ ok: true, data: allUsers });
  } catch (err) { next(err); }
});

router.delete('/:region/:subdomain/:name/users/:origin/:userId', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name, origin, userId } = req.params as {
      region: string; subdomain: string; name: string; origin: string; userId: string;
    };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq = req as AuthRequest;
    await removeUserFromRc(region, subdomain, name, origin, userId, sessionUser(authReq));
    const allUsers = await getRCUsers(region, subdomain, name);
    logger.info({ region, subdomain, name, userId, origin, by: sessionUser(authReq) }, 'User removed from RC');
    res.json({ ok: true, data: allUsers });
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name/export', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const result = await getRoleCollection(region, subdomain, name);
    if (!result) return void res.status(404).json({ ok: false, error: 'Not found' });
    const users = await getRCUsers(region, subdomain, name);
    const data  = { ...result.rc, userReferences: users };
    res.setHeader('Content-Disposition', `attachment; filename="${region}_${subdomain}_${encodeURIComponent(name)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { next(err); }
});

router.get('/:region/:subdomain/:name', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const result = await getRoleCollection(region, subdomain, name);
    if (!result) return void res.status(404).json({ ok: false, error: 'Not found' });
    const users = await getRCUsers(region, subdomain, name);
    res.json({ ok: true, rc: result.rc, users });
  } catch (err) { next(err); }
});

router.put('/:region/:subdomain/:name', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain, name } = req.params as { region: string; subdomain: string; name: string };
    if (await isRcSubaccountRestricted(region, subdomain)) return void res.status(403).json(RESTRICTED);
    const authReq = req as AuthRequest;
    const { rc, users = [] } = req.body as { rc: RoleCollection; users?: UserReference[] };
    if (!rc || typeof rc !== 'object') return void res.status(400).json({ ok: false, error: 'rc required' });
    await saveRCToLocal(region, subdomain, name, rc, users, sessionUser(authReq));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
