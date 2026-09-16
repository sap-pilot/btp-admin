import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { touchAppLastAccessed, updateAppFileState } from '../services/appService.js';
import { getAnalytics, getRequests, getTopApps, getTopUsers, recordAodRequest } from '../services/aodAnalyticsService.js';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { requireAdmin, getClientIp } from '../middleware/requireAuth.js';
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

// ─── Analytics (/api/aod/analytics) ──────────────────────────────────────────

router.get('/analytics', async (req, res, next) => {
  try {
    const raw   = req.query['duration'];
    const hours = typeof raw === 'string' ? Math.max(1, Math.min(168, Number(raw) || 24)) : 24;
    const data  = await getAnalytics(hours);
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/top-apps', async (req, res, next) => {
  try {
    const raw   = req.query['duration'];
    const hours = typeof raw === 'string' ? Math.max(1, Math.min(168, Number(raw) || 24)) : 24;
    const city        = typeof req.query['city']        === 'string' ? req.query['city']        : undefined;
    const countryCode = typeof req.query['countryCode'] === 'string' ? req.query['countryCode'] : undefined;
    const data = await getTopApps(hours, { city, countryCode });
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/top-users', async (req, res, next) => {
  try {
    const raw   = req.query['duration'];
    const hours = typeof raw === 'string' ? Math.max(1, Math.min(168, Number(raw) || 24)) : 24;
    const city        = typeof req.query['city']        === 'string' ? req.query['city']        : undefined;
    const countryCode = typeof req.query['countryCode'] === 'string' ? req.query['countryCode'] : undefined;
    const data = await getTopUsers(hours, { city, countryCode });
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

router.get('/requests', async (req, res, next) => {
  try {
    const page     = Math.max(1, Number(req.query['page'])     || 1);
    const pageSize = Math.min(500, Math.max(1, Number(req.query['pageSize']) || 50));
    const sortBy   = typeof req.query['sortBy']  === 'string' ? req.query['sortBy']  : 'ts';
    const sortDir  = req.query['sortDir'] === 'asc' ? 'asc' as const : 'desc' as const;
    const str      = (k: string) => typeof req.query[k] === 'string' ? (req.query[k] as string) : '';
    const result   = await getRequests({
      page, pageSize, sortBy, sortDir,
      countryCode: str('countryCode'), city:      str('city'),      country:   str('country'),
      alias:       str('alias'),       region:    str('region'),    subdomain: str('subdomain'),
      spaceName:   str('spaceName'),   appName:   str('appName'),   userId:    str('userId'),
    });
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

export default router;

// ─── AOD proxy handler (mounted at /aod — no auth) ───────────────────────────

const AOD_DIR = join(config.LOCAL_STORE_DIR, 'apps');

// In-flight app-start promises keyed by app URL base (prevents concurrent starts)
const startQueue = new Map<string, Promise<'up' | 'timeout'>>();

type GeoResult = { country: string; countryCode: string; city: string; lat: number; lon: number };

// Resolved geo results keyed by /24 subnet (IPv4) or full address (IPv6) — never evicted
const geoCache   = new Map<string, GeoResult>();
// In-flight promises — deduplicates concurrent lookups for the same subnet
const geoPending = new Map<string, Promise<GeoResult>>();

const REGION_RE   = /\.cfapps\.([\w-]+)\.hana\.ondemand\.com/i;
const PRIVATE_IP  = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$)/;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

function extractRegion(url: string): string | null {
  const m = REGION_RE.exec(url);
  return m?.[1] ?? null;
}

// ─── Geo lookup ───────────────────────────────────────────────────────────────

async function lookupGeo(rawIp: string): Promise<GeoResult> {
  const ip    = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  const empty: GeoResult = { country: '', countryCode: '', city: '', lat: 0, lon: 0 };
  if (!ip || PRIVATE_IP.test(ip)) return empty;

  // Cache key: /24 subnet for IPv4, full address for IPv6
  const isIpv4   = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
  const cacheKey = isIpv4 ? ip.split('.').slice(0, 3).join('.') : ip;

  // Resolved cache hit — most common path
  const cached = geoCache.get(cacheKey);
  if (cached) return cached;

  // In-flight dedup — prevents concurrent AOD requests from the same /24 subnet
  // from each firing a separate ip-api.com call (rate limit: 45 req/min)
  const pending = geoPending.get(cacheKey);
  if (pending) return pending;

  const promise = (async (): Promise<GeoResult> => {
    try {
      const ctrl = new AbortController();
      const id   = setTimeout(() => ctrl.abort(), 3000);
      const res  = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,lat,lon`, { signal: ctrl.signal })
        .finally(() => clearTimeout(id));
      if (res.ok) {
        const data = await res.json() as { status?: string; country?: string; countryCode?: string; city?: string; lat?: number; lon?: number };
        if (data.status === 'success') {
          const geo: GeoResult = { country: data.country ?? '', countryCode: data.countryCode ?? '', city: data.city ?? '', lat: data.lat ?? 0, lon: data.lon ?? 0 };
          geoCache.set(cacheKey, geo);
          return geo;
        }
      }
    } catch { /* network error or timeout — fall through to empty */ }
    return empty;
  })().finally(() => geoPending.delete(cacheKey));

  geoPending.set(cacheKey, promise);
  return promise;
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
    return String(decoded['email'] ?? decoded['user_name'] ?? decoded['sub'] ?? '');
  } catch {
    return '';
  }
}

// ─── Access log CSV ───────────────────────────────────────────────────────────

const CSV_HEADER = '"requestTime","url","appId","clientIp","country","countryCode","city","lat","lon","userId","startupMs","totalResponseMs"\n';

async function appendCsvLog(
  region:      string,
  subdomain:   string,
  requestTime: number,   // unix seconds
  appUrl:      string,
  appId:       string,
  clientIp:    string,
  country:     string,
  countryCode: string,
  city:        string,
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
    const row  = [requestTime, appUrl, appId, clientIp, country, countryCode, city, lat, lon, userId, startupMs, totalMs].map(esc).join(',') + '\n';
    await appendFile(csvPath, needsHeader ? CSV_HEADER + row : row, 'utf-8');
  } catch (err) {
    logger.warn({ err, region, subdomain }, 'AOD: failed to write access log');
  }
}

// ─── App health / start ───────────────────────────────────────────────────────

async function checkAppUp(appUrl: string): Promise<boolean> {
  try {
    // Check only the origin so we don't accidentally follow an app-specific path that might
    // return a non-502 even while the app process is down (e.g. a CF login redirect).
    const origin = new URL(appUrl).origin;
    const ctrl   = new AbortController();
    const id     = setTimeout(() => ctrl.abort(), 5000);
    const res    = await fetch(origin, { signal: ctrl.signal }).finally(() => clearTimeout(id));
    // CF GoRouter returns 502/503 when the app process is down
    if (res.status === 502 || res.status === 503) return false;
    // CF GoRouter sets X-Cf-Routererror on any routing failure:
    //   endpoint_failure → app stopped/crashed (502)
    //   unknown_route    → route not registered (404)
    // This is more reliable than body-sniffing and covers both cases.
    if (res.headers.get('x-cf-routererror')) return false;
    // Fallback body check for older CF versions that may not set the header
    if (res.status === 404) {
      const body = await res.text();
      if (/Requested route \('[^']*'\) does not exist\./i.test(body) || body.includes('CF-RouteNotFound')) return false;
    }
    return true;
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
  // clientIp: authoritative caller IP used for filtering and access logging.
  // On CF, x-cf-true-client-ip is the CF internal service IP (Workzone/dest service), not the
  // browser user's IP — use x-forwarded-for[0] for geo lookup to get the actual user location.
  const clientIp = getClientIp(req);
  const xff      = req.headers['x-forwarded-for'];
  const geoIp    = (typeof xff === 'string' ? xff.split(',')[0] : undefined)?.trim() || clientIp;

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
  const geoPromise = lookupGeo(geoIp);

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
        logger.warn({ appUrl, appId, region, subdomain, startupMs }, 'AOD: app did not become responsive before timeout');
        const totalMs  = Date.now() - t0;
        const timeoutTs = Math.floor(t0 / 1000);
        const geo       = await geoPromise;
        void appendCsvLog(region, subdomain, timeoutTs, appUrl, appId, clientIp, geo.country, geo.countryCode, geo.city, geo.lat, geo.lon, userId, startupMs, totalMs);
        recordAodRequest({ region, subdomain, appId, userId, country: geo.country, countryCode: geo.countryCode, city: geo.city, lat: geo.lat, lon: geo.lon, ts: timeoutTs });
        void touchAppLastAccessed(appId, region, subdomain, timeoutTs);
        res.status(503).json({ ok: false, error: 'App did not start within timeout' });
        return;
      }
      logger.info({ appUrl, appId, region, subdomain, startupMs }, 'AOD: app was stopped — started and became responsive');
      void updateAppFileState(appId, region, subdomain, 'STARTED');
    }

    // Build proxy headers — strip host, x-aod-*, and the btpauth session cookie so the
    // upstream CF app cannot read or replay this server's session credentials.
    // content-length is forwarded as-is: express.raw() captured the exact client bytes so the
    // original value is correct. accept-encoding is forwarded as-is: for 2xx we pipe raw bytes
    // so the client handles decompression itself; for errors we buffer and strip content-encoding.
    const proxyHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host') continue;
      if (lk.startsWith('x-aod-')) continue;
      const raw = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : undefined;
      if (!raw) continue;
      if (lk === 'cookie') {
        // Strip the btpauth session cookie — never forward server credentials to upstream apps
        const stripped = raw.replace(/(?:^|;\s*)btpauth=[^;]*/g, '').replace(/^[\s;]+|[\s;]+$/g, '');
        if (stripped) proxyHeaders[k] = stripped;
      } else {
        proxyHeaders[k] = raw;
      }
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    // req.body is a raw Buffer captured by express.raw() — forward as-is for any content type
    const rawBody: Buffer | undefined = hasBody && Buffer.isBuffer(req.body) && req.body.length > 0
      ? req.body
      : undefined;

    // Upstream request and geo lookup run concurrently
    const [upstream, geo] = await Promise.all([
      fetch(targetUrl, { method: req.method, headers: proxyHeaders, body: rawBody as BodyInit | undefined }),
      geoPromise,
    ]);

    const totalMs = Date.now() - t0;

    logger.debug({ appUrl, appId, region, subdomain, path: req.path, method: req.method, status: upstream.status, totalMs }, 'AOD: proxy response');

    res.status(upstream.status);

    // Write access log + fire analytics event + touch lastAccessed — all non-blocking
    const reqTs = Math.floor(t0 / 1000);
    void appendCsvLog(region, subdomain, reqTs, appUrl, appId, clientIp, geo.country, geo.countryCode, geo.city, geo.lat, geo.lon, userId, startupMs, totalMs);
    recordAodRequest({ region, subdomain, appId, userId, country: geo.country, countryCode: geo.countryCode, city: geo.city, lat: geo.lat, lon: geo.lon, ts: reqTs });
    void touchAppLastAccessed(appId, region, subdomain, reqTs);

    if (upstream.status < 300 && upstream.body) {
      // Forward headers as-is and pipe raw bytes — accept-encoding was forwarded so the
      // upstream may compress; we relay those bytes directly and the client decompresses.
      upstream.headers.forEach((v, k) => {
        if (k.toLowerCase() === 'transfer-encoding') return;
        res.setHeader(k, v);
      });
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } else {
      // Buffer error responses. undici decompresses transparently, so strip encoding
      // headers and recalculate content-length from the actual (decoded) buffer.
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk === 'transfer-encoding') return;
        if (lk === 'content-encoding') return;
        if (lk === 'content-length') return;
        res.setHeader(k, v);
      });
      const upBuf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('content-length', upBuf.length);
      res.end(upBuf);
    }
  } catch (err) {
    logger.error({ err, appUrl, targetUrl }, 'AOD proxy error');
    next(err);
  }
}
