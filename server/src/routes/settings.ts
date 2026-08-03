import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import { readSettings, saveSettings } from '../services/settingsService.js';
import type { SettingsData } from '../services/settingsService.js';

const router = Router();

function reqUser(req: Parameters<typeof requireAdmin>[0]): string {
  return (req as AuthRequest).authSession?.email || 'local';
}

router.get('/', async (req, res, next) => {
  try {
    const data = await readSettings();
    const x = getXsuaaConfig();
    const authed = !x || readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret) !== null;
    if (authed) {
      res.json({ ok: true, data });
      return;
    }
    // Unauthenticated: expose only public submenus; omit homepage config
    const publicMenus = data.menus
      .map(m => ({ ...m, submenus: m.submenus.filter(s => s.public) }))
      .filter(m => m.submenus.length > 0);
    const publicData: SettingsData = {
      homepage: { cockpit: { idp: '', host: '' }, mainSubscriptions: [] },
      menus: publicMenus,
    };
    res.json({ ok: true, data: publicData });
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
