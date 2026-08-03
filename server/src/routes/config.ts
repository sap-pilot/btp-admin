import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { readSubaccounts, refreshSubaccounts, saveSubaccounts, exportConfig, subaccountsFileExists, importSubaccounts } from '../services/subaccountsService.js';
import type { SubaccountEntry } from '../services/subaccountsService.js';
import { readTabs, saveTabs, tabsFileExists, importTabs } from '../services/tabsService.js';
import type { TabEntry } from '../services/tabsService.js';
import { settingsFileExists, importSettings } from '../services/settingsService.js';
import { getLastUpdated } from '../services/lastUpdatedService.js';
import { readConfigChangelog } from '../services/configChangelogService.js';

const router = Router();

function reqUser(req: Parameters<typeof requireAdmin>[0]): string {
  return (req as AuthRequest).authSession?.email || 'local';
}

router.get('/subaccounts', requireAuth, async (_req, res, next) => {
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

router.get('/tabs', requireAuth, async (_req, res, next) => {
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

router.get('/local-exists', requireAdmin, async (_req, res, next) => {
  try {
    const [subaccounts, tabs, settings] = await Promise.all([
      subaccountsFileExists(),
      tabsFileExists(),
      settingsFileExists(),
    ]);
    res.json({ ok: true, data: { subaccounts, tabs, settings } });
  } catch (err) { next(err); }
});

router.post('/import', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'Expected a JSON object' });
      return;
    }
    const data = body as Record<string, unknown>;
    const user = reqUser(req);

    // Import always replaces ALL three config files; keys absent from the payload
    // are treated as empty (subaccounts/tabs → [], settings → defaults).
    // changelog.md is never touched except to append the diff entries below.

    const rawSa = data['subaccounts'];
    const saList: SubaccountEntry[] = Array.isArray(rawSa)
      ? rawSa as SubaccountEntry[]
      : (rawSa && typeof rawSa === 'object' && Array.isArray((rawSa as Record<string, unknown>)['subaccounts']))
        ? (rawSa as Record<string, unknown>)['subaccounts'] as SubaccountEntry[]
        : [];

    await importSubaccounts(saList, user);
    await importTabs(Array.isArray(data['tabs']) ? data['tabs'] : [], user);
    await importSettings(
      (data['settings'] && typeof data['settings'] === 'object' && !Array.isArray(data['settings']))
        ? data['settings']
        : {},
      user,
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/last-updated', (_req, res) => {
  res.json({ ok: true, ts: getLastUpdated() });
});

router.get('/cockpit-menu', (_req, res) => {
  try {
    const raw = readFileSync('./config/cockpit-menu.json', 'utf-8');
    res.json(JSON.parse(raw));
  } catch { res.json(null); }
});

router.get('/changelog', requireAdmin, async (_req, res, next) => {
  try {
    const text = await readConfigChangelog();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (err) { next(err); }
});

export default router;
