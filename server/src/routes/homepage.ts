import { Router } from 'express';
import { readEffectiveHomepageRaw, saveHomepage, readHomepageChangelog } from '../services/home/homepageEditService.js';
import { getXsuaaConfig, readSessionFromRequest } from '../services/authService.js';
import { requireAdmin } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';

const router = Router();

router.get('/raw', requireAdmin, (_req, res) => {
  res.json({ json: readEffectiveHomepageRaw() });
});

router.get('/changelog', requireAdmin, (_req, res) => {
  res.json({ text: readHomepageChangelog() });
});

router.post('/save', requireAdmin, (req, res, next) => {
  try {
    const { json } = req.body as { json?: unknown };
    if (typeof json !== 'string') { res.status(400).json({ error: 'json string required' }); return; }
    JSON.parse(json);
    const session = (req as AuthRequest).authSession;
    saveHomepage(json, { name: session?.firstName ?? 'Anonymous', email: session?.email });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/', (req, res) => {
  const raw = readEffectiveHomepageRaw();
  if (!raw) { res.json(null); return; }
  try {
    const data = JSON.parse(raw) as {
      resources?: { restricted?: boolean }[];
      menus?: { restricted?: boolean; children?: { restricted?: boolean }[] }[];
      [k: string]: unknown;
    };
    const x = getXsuaaConfig();
    const session = x ? readSessionFromRequest(req.headers.cookie ?? '', x.clientsecret) : null;
    if (Array.isArray(data.resources)) {
      data.resources = data.resources.filter(r => !r.restricted || !!session);
    }
    if (Array.isArray(data.menus)) {
      data.menus = data.menus
        .filter(m => !m.restricted || !!session)
        .map(m => ({
          ...m,
          children: Array.isArray(m.children) ? m.children.filter(c => !c.restricted || !!session) : []
        }));
    }
    res.json(data);
  } catch { res.status(500).json({ error: 'Failed to parse homepage.json' }); }
});

export default router;
