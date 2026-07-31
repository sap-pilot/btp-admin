import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js';
import { listDestinations, refreshDestinations, searchDestinations } from '../services/destinationService.js';

const router = Router();

router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query['q'] ?? '').trim();
    const data = await searchDestinations(q);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (_req, res, next) => {
  try {
    const data = await listDestinations();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/refresh', requireAdmin, async (_req, res, next) => {
  try {
    const result = await refreshDestinations();
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

export default router;
