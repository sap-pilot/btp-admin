import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { scanApps, getStatsData, getLatestStats, isRefreshRunning, getTopAppsPerSubaccount, getCachedTopApps, getSubaccountApps, searchApps, updateAppFileState, refreshTopAppsAndNotify } from '../services/aodAppsService.js';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getOrRefreshToken } from '../services/cfLoginService.js';
import { readAodConfig, writeAodConfig } from '../services/aodConfigService.js';
import type { AodConfig } from '../services/aodConfigService.js';

const router = Router();

// ─── AOD config API (/api/aod/config) ────────────────────────────────────────

router.get('/config', requireAdmin, async (_req, res, next) => {
  try {
    const data = await readAodConfig();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.post('/config/save', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body as Partial<AodConfig>;
    await writeAodConfig(body);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Apps endpoints (/api/aod/apps) ──────────────────────────────────────────

router.get('/apps/status', requireAdmin, (_req, res) => {
  res.json({ ok: true, refreshing: isRefreshRunning() });
});

router.post('/apps/refresh', requireAdmin, (_req, res) => {
  if (isRefreshRunning()) {
    res.json({ ok: false, error: 'already running' });
    return;
  }
  void scanApps();
  res.json({ ok: true, started: true });
});

router.get('/apps/top', requireAdmin, async (_req, res, next) => {
  try {
    const data = getCachedTopApps().length > 0 ? getCachedTopApps() : await getTopAppsPerSubaccount();
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/apps/subaccount', requireAdmin, async (req, res, next) => {
  try {
    const region    = typeof req.query['region']    === 'string' ? req.query['region']    : '';
    const subdomain = typeof req.query['subdomain'] === 'string' ? req.query['subdomain'] : '';
    if (!region || !subdomain) { res.status(400).json({ ok: false, error: 'region and subdomain required' }); return; }
    const data = await getSubaccountApps(region, subdomain);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/apps/search', requireAdmin, async (req, res, next) => {
  try {
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
    if (q.length < 2) { res.json({ ok: true, data: [] }); return; }
    const data = await searchApps(q);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/apps/stats', requireAdmin, async (req, res, next) => {
  try {
    const nowSecs  = Math.floor(Date.now() / 1000);
    const from     = typeof req.query['from'] === 'string' ? Number(req.query['from']) : nowSecs - 86400;
    const to       = typeof req.query['to']   === 'string' ? Number(req.query['to'])   : nowSecs;
    const aodOnly  = req.query['aod'] === '1';
    const [data, latest] = await Promise.all([getStatsData(from, to, aodOnly), getLatestStats(aodOnly)]);
    res.json({ ok: true, data, latest });
  } catch (err) { next(err); }
});

router.post('/apps/:guid/start', requireAdmin, async (req, res, next) => {
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

router.post('/apps/:guid/stop', requireAdmin, async (req, res, next) => {
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

// ─── AOD proxy handler (mounted at /aod — no auth) ───────────────────────────

const AOD_DIR = join(config.LOCAL_STORE_DIR, 'apps');

// In-flight app-start promises keyed by app URL base (prevents concurrent starts)
const startQueue = new Map<string, Promise<'up' | 'timeout'>>();

// Geo cache keyed by IPv4 /24 subnet or full IPv6 address
const geoCache = new Map<string, { city: string; lat: number; lon: number }>();

const REGION_RE   = /\.cfapps\.([\w-]+)\.hana\.ondemand\.com/i;
const PRIVATE_IP  = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$)/;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

function extractRegion(url: string): string | null {
  const m = REGION_RE.exec(url);
  return m?.[1] ?? null;
}

// ─── Geo lookup ───────────────────────────────────────────────────────────────

async function lookupGeo(rawIp: string): Promise<{ city: string; lat: number; lon: number }> {
  const ip    = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  const empty = { city: '', lat: 0, lon: 0 };
  if (!ip || PRIVATE_IP.test(ip)) return empty;

  // Cache key: /24 subnet for IPv4, full address for IPv6
  const isIpv4   = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
  const cacheKey = isIpv4 ? ip.split('.').slice(0, 3).join('.') : ip;

  const cached = geoCache.get(cacheKey);
  if (cached) return cached;

  try {
    const ctrl = new AbortController();
    const id   = setTimeout(() => ctrl.abort(), 3000);
    const res  = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,lat,lon`, { signal: ctrl.signal })
      .finally(() => clearTimeout(id));
    if (res.ok) {
      const data = await res.json() as { status?: string; city?: string; lat?: number; lon?: number };
      if (data.status === 'success') {
        const geo = { city: data.city ?? '', lat: data.lat ?? 0, lon: data.lon ?? 0 };
        geoCache.set(cacheKey, geo);
        return geo;
      }
    }
  } catch { /* network error or timeout — return empty */ }

  return empty;
}

// ─── JWT userId extraction ────────────────────────────────────────────────────

function extractUserId(req: Request): string {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return '';
  try {
    const parts = m[1]!.split('.');
    if (parts.length < 2) return '';
    const decoded = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>;
    return String(decoded['user_name'] ?? decoded['email'] ?? decoded['sub'] ?? '');
  } catch {
    return '';
  }
}

// ─── Access log CSV ───────────────────────────────────────────────────────────

const CSV_HEADER = '"requestTime","url","appId","clientIp","city","lat","lon","userId","startupMs","totalResponseMs"\n';

async function appendCsvLog(
  region:    string,
  subdomain: string,
  requestTime: number,   // unix seconds
  appUrl:    string,
  appId:     string,
  clientIp:  string,
  city:      string,
  lat:       number,
  lon:       number,
  userId:    string,
  startupMs: number,
  totalMs:   number,
): Promise<void> {
  try {
    const dir     = join(AOD_DIR, region, subdomain);
    const csvPath = join(dir, 'accesslog.csv');
    await mkdir(dir, { recursive: true });

    // Rotate if file >= 2 MB
    try {
      const info = await stat(csvPath);
      if (info.size >= LOG_ROTATE_BYTES) {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        await rename(csvPath, join(dir, `accesslog.${dateStr}.csv`));
      }
    } catch { /* file may not exist yet */ }

    // Write header if starting fresh
    let needsHeader = false;
    try { await stat(csvPath); } catch { needsHeader = true; }

    const esc  = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const row  = [requestTime, appUrl, appId, clientIp, city, lat, lon, userId, startupMs, totalMs].map(esc).join(',') + '\n';
    await appendFile(csvPath, needsHeader ? CSV_HEADER + row : row, 'utf-8');
  } catch (err) {
    logger.warn({ err, region, subdomain }, 'AOD: failed to write access log');
  }
}

// ─── App health / start ───────────────────────────────────────────────────────

async function checkAppUp(appUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const id   = setTimeout(() => ctrl.abort(), 5000);
    const res  = await fetch(appUrl, { method: 'HEAD', signal: ctrl.signal }).finally(() => clearTimeout(id));
    // CF GoRouter returns 502/503 when the app process is down
    return res.status !== 502 && res.status !== 503;
  } catch {
    return false;
  }
}

async function startApp(region: string, appGuid: string): Promise<void> {
  const token = await getOrRefreshToken(region);
  const url   = `${token.api_url}/v3/apps/${appGuid}/actions/start`;
  const res   = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `${token.token_type} ${token.access_token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CF start app failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function waitUntilUp(appUrl: string, timeoutMs = 30_000): Promise<'up' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    if (await checkAppUp(appUrl)) return 'up';
  }
  return 'timeout';
}

async function ensureAppRunning(appUrl: string, region: string, appGuid: string): Promise<'up' | 'timeout'> {
  const inFlight = startQueue.get(appUrl);
  if (inFlight) return inFlight;
  const promise = (async () => {
    try {
      await startApp(region, appGuid);
      return await waitUntilUp(appUrl);
    } finally {
      startQueue.delete(appUrl);
    }
  })();
  startQueue.set(appUrl, promise);
  return promise;
}

// ─── Proxy handler ────────────────────────────────────────────────────────────

export async function aodProxyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const t0       = Date.now();
  const appUrl   = req.headers['x-aod-app-url'];
  const appId    = req.headers['x-aod-app-id'];
  const rawIp    = req.headers['x-cf-true-client-ip'] ?? req.ip ?? '';
  const clientIp = Array.isArray(rawIp) ? (rawIp[0] ?? '') : rawIp;

  if (!appUrl || typeof appUrl !== 'string' || !appId || typeof appId !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing x-aod-app-url or x-aod-app-id headers' });
    return;
  }

  // Prefer headers injected by the destination service; fall back to URL extraction
  const hRegion    = req.headers['x-aod-region'];
  const hSubdomain = req.headers['x-aod-subdomain'];
  const region     = typeof hRegion    === 'string' ? hRegion    : (extractRegion(appUrl) ?? 'unknown');
  const subdomain  = typeof hSubdomain === 'string' ? hSubdomain : 'unknown';

  const userId = extractUserId(req);

  // Start geo lookup early so it can run concurrently with the app check / proxy
  const geoPromise = lookupGeo(clientIp);

  // Strip /aod prefix and reconstruct target URL
  const strippedPath = req.path.startsWith('/aod') ? (req.path.slice(4) || '/') : req.path;
  const qs           = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const targetUrl    = appUrl.replace(/\/$/, '') + strippedPath + qs;

  let startupMs = 0;

  try {
    const isUp = await checkAppUp(appUrl);
    if (!isUp) {
      const t1      = Date.now();
      const outcome = await ensureAppRunning(appUrl, region, appId);
      startupMs     = Date.now() - t1;
      if (outcome === 'timeout') {
        const totalMs = Date.now() - t0;
        const geo     = await geoPromise;
        void appendCsvLog(region, subdomain, Math.floor(t0 / 1000), appUrl, appId, clientIp, geo.city, geo.lat, geo.lon, userId, startupMs, totalMs);
        res.status(503).json({ ok: false, error: 'App did not start within timeout' });
        return;
      }
    }

    // Build proxy headers — strip host and x-aod-* headers
    const proxyHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') continue;
      if (k.toLowerCase().startsWith('x-aod-')) continue;
      if (typeof v === 'string') proxyHeaders[k] = v;
      else if (Array.isArray(v)) proxyHeaders[k] = v.join(', ');
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const bodyBuf = hasBody ? JSON.stringify(req.body) : undefined;

    // Upstream request and geo lookup run concurrently
    const [upstream, geo] = await Promise.all([
      fetch(targetUrl, { method: req.method, headers: proxyHeaders, body: bodyBuf }),
      geoPromise,
    ]);

    const totalMs = Date.now() - t0;

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(k, v);
    });
    const upBuf = await upstream.arrayBuffer();
    res.end(Buffer.from(upBuf));

    // Write access log after response is sent (non-blocking)
    void appendCsvLog(region, subdomain, Math.floor(t0 / 1000), appUrl, appId, clientIp, geo.city, geo.lat, geo.lon, userId, startupMs, totalMs);
  } catch (err) {
    logger.error({ err, appUrl, targetUrl }, 'AOD proxy error');
    next(err);
  }
}
