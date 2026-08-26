import { appendFile, mkdir } from 'node:fs/promises';
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

export default router;

// ─── AOD proxy handler (mounted at /aod — no auth) ───────────────────────────

const AOD_ACCESS_LOG = join(config.LOCAL_STORE_DIR, 'aod', 'access-log.csv');

// In-flight app-start promises keyed by app URL base (prevents concurrent starts for the same app)
const startQueue = new Map<string, Promise<'up' | 'timeout'>>();

const REGION_RE = /\.cfapps\.([\w-]+)\.hana\.ondemand\.com/i;

function extractRegion(url: string): string | null {
  const m = REGION_RE.exec(url);
  return m?.[1] ?? null;
}

async function checkAppUp(appUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(appUrl, { method: 'HEAD', signal: ctrl.signal }).finally(() => clearTimeout(timeout));
    // CF returns a specific text body for apps that are down / route not found
    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      if (text.includes('404 Not Found: Requested route (')) return false;
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

async function appendCsvLog(
  requestTime: string,
  appUrl: string,
  appId: string,
  clientIp: string,
  result: string,
  startupMs: number,
  totalMs: number,
): Promise<void> {
  try {
    await mkdir(join(config.LOCAL_STORE_DIR, 'aod'), { recursive: true });
    const row = [requestTime, appUrl, appId, clientIp, result, String(startupMs), String(totalMs)]
      .map(v => `"${v.replace(/"/g, '""')}"`)
      .join(',') + '\n';
    await appendFile(AOD_ACCESS_LOG, row, 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'AOD: failed to write access log');
  }
}

export async function aodProxyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const t0        = Date.now();
  const appUrl    = req.headers['x-aod-app-url'];
  const appId     = req.headers['x-aod-app-id'];
  const clientIp  = req.headers['x-cf-true-client-ip'] ?? req.ip ?? '';

  if (!appUrl || typeof appUrl !== 'string' || !appId || typeof appId !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing x-aod-app-url or x-aod-app-id headers' });
    return;
  }

  const region = extractRegion(appUrl);
  if (!region) {
    res.status(400).json({ ok: false, error: 'Cannot extract CF region from x-aod-app-url' });
    return;
  }

  // Strip /aod prefix and reconstruct target URL
  const suffix      = req.path.replace(/^\/aod/, '') || '/';
  const targetUrl   = appUrl.replace(/\/$/, '') + suffix + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');

  let result    = 'PASSED';
  let startupMs = 0;

  try {
    const isUp = await checkAppUp(appUrl);
    if (!isUp) {
      const t1      = Date.now();
      const outcome = await ensureAppRunning(appUrl, region, appId);
      startupMs     = Date.now() - t1;
      if (outcome === 'timeout') {
        result = 'TIMEOUT';
        const totalMs = Date.now() - t0;
        await appendCsvLog(new Date(t0).toISOString(), appUrl, appId, String(clientIp), result, startupMs, totalMs);
        res.status(503).json({ ok: false, error: 'App did not start within timeout' });
        return;
      }
      result = 'STARTED';
    }

    // Forward the request to the target app
    const proxyHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === 'host') continue;
      if (k.toLowerCase().startsWith('x-aod-')) continue;
      if (typeof v === 'string') proxyHeaders[k] = v;
      else if (Array.isArray(v)) proxyHeaders[k] = v.join(', ');
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const bodyBuf = hasBody ? JSON.stringify(req.body) : undefined;

    const upstream = await fetch(targetUrl, {
      method:  req.method,
      headers: proxyHeaders,
      body:    bodyBuf,
    });

    const totalMs = Date.now() - t0;
    await appendCsvLog(new Date(t0).toISOString(), appUrl, appId, String(clientIp), result, startupMs, totalMs);

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(k, v);
    });
    const upBuf = await upstream.arrayBuffer();
    res.end(Buffer.from(upBuf));
  } catch (err) {
    logger.error({ err, appUrl, targetUrl }, 'AOD proxy error');
    next(err);
  }
}
