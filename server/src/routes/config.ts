import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import { readOrgs, refreshOrgs, saveOrgs } from '../services/orgsService.js';
import type { OrgRegion } from '../services/orgsService.js';
import { readDirs, saveDirs } from '../services/dirsService.js';
import type { DirTab } from '../services/dirsService.js';

const router = Router();

router.get('/orgs', requireAdmin, async (_req, res, next) => {
  try {
    const data = await readOrgs();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/orgs/refresh', requireAdmin, async (_req, res, next) => {
  try {
    const data = await refreshOrgs();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/orgs/save', requireAdmin, async (req, res, next) => {
  try {
    const { data } = req.body as { data?: unknown };
    if (!Array.isArray(data)) {
      res.status(400).json({ ok: false, error: 'data must be an array' });
      return;
    }
    await saveOrgs(data as OrgRegion[]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/dirs', requireAdmin, async (_req, res, next) => {
  try {
    const data = await readDirs();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/dirs/save', requireAdmin, async (req, res, next) => {
  try {
    const { data } = req.body as { data?: unknown };
    if (!Array.isArray(data)) {
      res.status(400).json({ ok: false, error: 'data must be an array' });
      return;
    }
    await saveDirs(data as DirTab[]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
