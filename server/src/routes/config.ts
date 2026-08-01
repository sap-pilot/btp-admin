import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { readSubaccounts, refreshSubaccounts, saveSubaccounts, exportConfig, importConfig } from '../services/subaccountsService.js';
import type { SubaccountEntry } from '../services/subaccountsService.js';
import { readTabs, saveTabs } from '../services/tabsService.js';
import type { TabEntry } from '../services/tabsService.js';
import { readConfigChangelog } from '../services/configChangelogService.js';

const router = Router();

function reqUser(req: Parameters<typeof requireAdmin>[0]): string {
  return (req as AuthRequest).authSession?.email || 'local';
}

router.get('/subaccounts', requireAdmin, async (_req, res, next) => {
  try {
    const data = await readSubaccounts();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/subaccounts/refresh', requireAdmin, async (req, res, next) => {
  try {
    const { data, warnings } = await refreshSubaccounts(reqUser(req));
    res.json({ ok: true, data, warnings });
  } catch (err) { next(err); }
});

router.post('/subaccounts/save', requireAdmin, async (req, res, next) => {
  try {
    const { data } = req.body as { data?: unknown };
    if (!Array.isArray(data)) {
      res.status(400).json({ ok: false, error: 'data must be an array' });
      return;
    }
    await saveSubaccounts(data as SubaccountEntry[], reqUser(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/tabs', requireAdmin, async (_req, res, next) => {
  try {
    const data = await readTabs();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/tabs/save', requireAdmin, async (req, res, next) => {
  try {
    const { data } = req.body as { data?: unknown };
    if (!Array.isArray(data)) {
      res.status(400).json({ ok: false, error: 'data must be an array' });
      return;
    }
    await saveTabs(data as TabEntry[], reqUser(req));
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
