import { Router } from 'express';
import { scanApps, getStatsData, getLatestStats, isRefreshRunning, getTopAppsPerSubaccount, getCachedTopApps, getSubaccountApps, searchApps, updateAppFileState, refreshTopAppsAndNotify, scanSubaccountApps } from '../services/appService.js';
import { requireAdmin } from '../middleware/requireAuth.js';
import { logger } from '../logger.js';
import { getOrRefreshToken } from '../services/cfLoginService.js';

const router = Router();

router.get('/status', requireAdmin, (_req, res) => {
  res.json({ ok: true, refreshing: isRefreshRunning() });
});

router.post('/refresh', requireAdmin, (_req, res) => {
  if (isRefreshRunning()) {
    res.json({ ok: false, error: 'already running' });
    return;
  }
  void scanApps();
  res.json({ ok: true, started: true });
});

router.get('/top', requireAdmin, async (_req, res, next) => {
  try {
    const data = getCachedTopApps().length > 0 ? getCachedTopApps() : await getTopAppsPerSubaccount();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/subaccount', requireAdmin, async (req, res, next) => {
  try {
    const region    = typeof req.query['region']    === 'string' ? req.query['region']    : '';
    const subdomain = typeof req.query['subdomain'] === 'string' ? req.query['subdomain'] : '';
    if (!region || !subdomain) { res.status(400).json({ ok: false, error: 'region and subdomain required' }); return; }
    const data = await getSubaccountApps(region, subdomain);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/refresh-subaccount', requireAdmin, async (req, res, next) => {
  try {
    const region    = typeof req.query['region']    === 'string' ? req.query['region']    : '';
    const subdomain = typeof req.query['subdomain'] === 'string' ? req.query['subdomain'] : '';
    if (!region || !subdomain) { res.status(400).json({ ok: false, error: 'region and subdomain required' }); return; }
    const result = await scanSubaccountApps(region, subdomain);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

router.get('/search', requireAdmin, async (req, res, next) => {
  try {
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
    if (q.length < 2) { res.json({ ok: true, data: [] }); return; }
    const data = await searchApps(q);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const nowSecs  = Math.floor(Date.now() / 1000);
    const from     = typeof req.query['from'] === 'string' ? Number(req.query['from']) : nowSecs - 86400;
    const to       = typeof req.query['to']   === 'string' ? Number(req.query['to'])   : nowSecs;
    const aodOnly  = req.query['aod'] === '1';
    const [data, latest] = await Promise.all([getStatsData(from, to, aodOnly), getLatestStats(aodOnly)]);
    res.json({ ok: true, data, latest });
  } catch (err) { next(err); }
});

router.post('/:guid/start', requireAdmin, async (req, res, next) => {
  try {
    const guid      = typeof req.params['guid']      === 'string' ? req.params['guid']      : '';
    const region    = typeof req.query['region']     === 'string' ? req.query['region']     : '';
    const subdomain = typeof req.query['subdomain']  === 'string' ? req.query['subdomain']  : '';
    if (!guid || !region) { res.status(400).json({ ok: false, error: 'guid and region required' }); return; }
    const token  = await getOrRefreshToken(region);
    const cfRes  = await fetch(`${token.api_url}/v3/apps/${guid}/actions/start`, {
      method: 'POST',
      headers: { Authorization: `${token.token_type} ${token.access_token}`, 'Content-Type': 'application/json' },
    });
    if (!cfRes.ok) {
      const text = await cfRes.text().catch(() => '');
      res.status(502).json({ ok: false, error: `CF ${cfRes.status}: ${text.slice(0, 200)}` });
      return;
    }
    logger.info({ guid, region }, 'AOD: app started via UI');
    res.json({ ok: true });
    if (subdomain) void updateAppFileState(guid, region, subdomain, 'STARTED').then(() => refreshTopAppsAndNotify());
  } catch (err) { next(err); }
});

router.post('/:guid/stop', requireAdmin, async (req, res, next) => {
  try {
    const guid      = typeof req.params['guid']      === 'string' ? req.params['guid']      : '';
    const region    = typeof req.query['region']     === 'string' ? req.query['region']     : '';
    const subdomain = typeof req.query['subdomain']  === 'string' ? req.query['subdomain']  : '';
    if (!guid || !region) { res.status(400).json({ ok: false, error: 'guid and region required' }); return; }
    const token  = await getOrRefreshToken(region);
    const cfRes  = await fetch(`${token.api_url}/v3/apps/${guid}/actions/stop`, {
      method: 'POST',
      headers: { Authorization: `${token.token_type} ${token.access_token}`, 'Content-Type': 'application/json' },
    });
    if (!cfRes.ok) {
      const text = await cfRes.text().catch(() => '');
      res.status(502).json({ ok: false, error: `CF ${cfRes.status}: ${text.slice(0, 200)}` });
      return;
    }
    logger.info({ guid, region }, 'AOD: app stopped via UI');
    res.json({ ok: true });
    if (subdomain) void updateAppFileState(guid, region, subdomain, 'STOPPED').then(() => refreshTopAppsAndNotify());
  } catch (err) { next(err); }
});

export default router;
