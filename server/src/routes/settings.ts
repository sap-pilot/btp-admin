import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { readSettings, saveSettings } from '../services/settingsService.js';
import type { SettingsData } from '../services/settingsService.js';

const router = Router();

function reqUser(req: Parameters<typeof requireAdmin>[0]): string {
  return (req as AuthRequest).authSession?.email || 'local';
}

router.get('/', async (_req, res, next) => {
  try {
    const data = await readSettings();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/save', requireAdmin, async (req, res, next) => {
  try {
    const { data } = req.body as { data?: unknown };
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      res.status(400).json({ ok: false, error: 'data must be an object' });
      return;
    }
    await saveSettings(data as SettingsData, reqUser(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
