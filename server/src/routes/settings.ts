import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import { readSettings, saveSettings } from '../services/settingsService.js';
import type { SettingsData } from '../services/settingsService.js';
import { VARIABLE_DEFS, getEffectiveDefault, maskIfSensitive, getSettingsVar } from '../services/variablesService.js';

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

router.get('/variables', requireAdmin, (_req, res, next) => {
  try {
    const vars = VARIABLE_DEFS.map(def => {
      const { value: defVal, isEnv } = getEffectiveDefault(def.key);
      const settingsVal = def.readonly ? undefined : getSettingsVar(def.key);
      return {
        key:             def.key,
        description:     def.description,
        sensitive:       def.sensitive,
        readonly:        def.readonly,
        defaultValue:    maskIfSensitive(def.key, defVal),
        isEnvOverride:   isEnv,
        settingsOverride: settingsVal !== undefined ? maskIfSensitive(def.key, settingsVal) : '',
      };
    });
    res.json({ ok: true, vars });
  } catch (err) { next(err); }
});

router.post('/variables', requireAdmin, async (req, res, next) => {
  try {
    const { variables } = req.body as { variables?: Record<string, string> };
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
      res.status(400).json({ ok: false, error: 'variables must be an object' });
      return;
    }
    // Validate: only known writable keys accepted
    const writableKeys = new Set(VARIABLE_DEFS.filter(d => !d.readonly).map(d => d.key));
    const invalid = Object.keys(variables).filter(k => !writableKeys.has(k));
    if (invalid.length > 0) {
      res.status(400).json({ ok: false, error: `Unknown or readonly variable keys: ${invalid.join(', ')}` });
      return;
    }
    const settings = await readSettings();
    const existing = settings.variables ?? {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(variables)) {
      if (typeof v === 'string' && v !== '') merged[k] = v;
      else delete merged[k];
    }
    await saveSettings({ ...settings, variables: Object.keys(merged).length > 0 ? merged : undefined }, reqUser(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
