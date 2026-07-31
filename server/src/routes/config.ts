import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { readOrgs, refreshOrgs, saveOrgs, exportConfig, importConfig } from '../services/orgsService.js';
import type { OrgRegion } from '../services/orgsService.js';
import { readDirs, saveDirs } from '../services/dirsService.js';
import type { DirTab } from '../services/dirsService.js';
import { readConfigChangelog } from '../services/configChangelogService.js';

const router = Router();

function reqUser(req: Parameters<typeof requireAdmin>[0]): string {
  return (req as AuthRequest).authSession?.email || 'local';
}

router.get('/orgs', requireAdmin, async (_req, res, next) => {
  try {
    const data = await readOrgs();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/orgs/refresh', requireAdmin, async (req, res, next) => {
  try {
    const data = await refreshOrgs(reqUser(req));
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
    await saveOrgs(data as OrgRegion[], reqUser(req));
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
    await saveDirs(data as DirTab[], reqUser(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/export', requireAdmin, async (_req, res, next) => {
  try {
    const data = await exportConfig();
    res.setHeader('Content-Disposition', 'attachment; filename="combined-config.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { next(err); }
});

router.post('/import', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'Expected a JSON object' });
      return;
    }
    await importConfig(body as Record<string, unknown>);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/changelog', requireAdmin, async (_req, res, next) => {
  try {
    const text = await readConfigChangelog();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (err) { next(err); }
});

export default router;
