import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getService } from '../services/configService.js';
import { listResponseFiles } from '../services/localStoreService.js';
import { getEvaluationMode } from '../services/status/overrideService.js';
import { logger } from '../logger.js';

const router = Router();

/** Fallback lookback when no interval is configured on the endpoint or service (seconds). */
const DEFAULT_INTERVAL_S = 3600;

function extractRegion(host: string): string | null {
  return host.match(/cfapps\.([^.]+)\.hana/)?.[1] ?? null;
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
}

/**
 * Send a JSON response that is guaranteed never to be served as 304 Not Modified.
 *
 * res.json() calls res.send() which runs Express's ETag generation + req.fresh check
 * and may convert a 200 into a 304 when the client supplies If-None-Match.
 * Using res.end() bypasses that path entirely; no ETag is set, so the response
 * is never considered "fresh" by the browser or a caching proxy.
 */
function replyJson(res: Response, httpStatus: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.status(httpStatus);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.end(payload);
}

/**
 * File-based health check — designed for Traffic Manager probes (3–5 s interval, sub-second response).
 *
 * Evaluates the latest saved check result for each probe location (city) within the window
 * [now − endpoint.interval × 2, now]. Only region-matching endpoints are considered.
 *
 * Responses:
 *   200 {"status":"OK",           "locations":{"Ashburn":200,…}}
 *   200 {"status":"Partial OK",   "locations":{…}}
 *   500 {"status":"Service down", "locations":{…}}
 *
 * Evaluation-mode overrides (bypass file lookup):
 *   200 {"status":"Always OK"}
 *   500 {"status":"Always Error"}
 */
router.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
  const name = req.params['name'] as string;
  const requestHost =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ??
    (req.headers['host'] as string | undefined) ?? '';

  logger.debug({ service: name, from: req.ip ?? 'unknown' }, 'Health check request received');

  const evalMode = getEvaluationMode(name);

  if (evalMode === 'alwaysok') {
    logger.info({ service: name }, 'Health check forced OK — eval mode: alwaysok');
    replyJson(res, 200, { status: 'Always OK' });
    return;
  }
  if (evalMode === 'alwayserror') {
    logger.warn({ service: name }, 'Health check forced fail — eval mode: alwayserror');
    replyJson(res, 500, { status: 'Always Error' });
    return;
  }

  try {
    const service = getService(name);
    if (!service) {
      replyJson(res, 404, { status: `Service '${name}' not found` });
      return;
    }

    const hostRegion = extractRegion(requestHost);

    // Build per-endpoint (slug, lookbackMs) list, filtered by region.
    const epEntries = service.endpoints
      .filter(ep => !ep.region || !hostRegion || ep.region === hostRegion)
      .flatMap(ep => {
        if (!ep.name) return [];
        const effectiveInterval = ep.interval ?? service.interval ?? DEFAULT_INTERVAL_S;
        return [{ slug: slugify(ep.name), lookbackMs: effectiveInterval * 2 * 1000 }];
      });

    if (epEntries.length === 0) {
      logger.debug({ service: name, hostRegion }, 'Health check: no endpoints match region — returning OK');
      replyJson(res, 200, { status: 'OK', locations: [] });
      return;
    }

    const now = Date.now();
    // Fetch files using the broadest window across all endpoints; files are newest-first.
    const minFromMs = Math.min(...epEntries.map(e => now - e.lookbackMs));
    const files = await listResponseFiles(name, { fromMs: minFromMs, untilMs: now });

    // For each endpoint, find files within its own window and track the latest per city.
    const latestByCity = new Map<string, { status: number; timestamp: number }>();

    for (const { slug, lookbackMs } of epEntries) {
      const fromMs = now - lookbackMs;
      for (const f of files) {
        if (f.endpointSlug !== slug) continue;
        if (f.timestamp < fromMs) continue;
        const city = f.city ?? 'unknown';
        const existing = latestByCity.get(city);
        if (!existing || f.timestamp > existing.timestamp) {
          latestByCity.set(city, { status: f.overallStatus, timestamp: f.timestamp });
        }
      }
    }

    if (latestByCity.size === 0) {
      logger.debug({ service: name }, 'Health check: no recent data in window — returning OK');
      replyJson(res, 200, { status: 'OK', locations: [], note: 'no recent data' });
      return;
    }

    const locations = Object.fromEntries([...latestByCity.entries()].map(([city, e]) => [city, e.status]));
    const statuses = [...latestByCity.values()].map(e => e.status);

    const allDown = statuses.every(s => s === 500 || s === 503 || s === 504);
    const allOk = statuses.every(s => s === 200 || s === 203);

    if (allDown) {
      logger.warn({ service: name, locations }, 'Health check failed — all locations down');
      replyJson(res, 500, { status: 'Service down', locations });
    } else if (allOk) {
      logger.debug({ service: name, locations }, 'Health check passed');
      replyJson(res, 200, { status: 'OK', locations });
    } else {
      logger.debug({ service: name, locations }, 'Health check partial — some locations degraded');
      replyJson(res, 200, { status: 'Partial OK', locations });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
