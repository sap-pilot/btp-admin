import { Router } from 'express';
import { getAllServices, getLandscapes, getService } from '../services/configService.js';
import { listResponseFiles, readResponseFile, starResponseFile } from '../services/localStoreService.js';
import { getEvaluationMode, setEvaluationMode, getIntervalOverride, setIntervalOverride } from '../services/status/overrideService.js';
import { rescheduleService } from '../services/status/schedulerService.js';
import { checkService } from '../services/status/healthCheckService.js';
import { notifyCallbacks } from '../services/syncService.js';
import { emit } from '../services/liveEvents.js';
import { logger } from '../logger.js';
import { userLabel } from '../services/authService.js';
import { requireAuth, requireAdmin, getClientIp } from '../middleware/requireAuth.js';
import type { AuthRequest } from '../middleware/requireAuth.js';
import type { EvaluationMode, ServiceSummary } from '../types/index.js';

const VALID_EVAL_MODES = new Set<string>(['condition', 'alwaysok', 'alwayserror']);

function parseTimeRangeQuery(
  query: Record<string, unknown>,
): { hours: number } | { fromMs: number; untilMs: number } {
  const rawSince = query['since'];
  if (typeof rawSince === 'string') {
    const since = parseInt(rawSince, 10);
    if (!isNaN(since) && since > 0) {
      return { fromMs: since, untilMs: Date.now() + 10_000 };
    }
  }
  const rawFrom = query['fromMs'];
  const rawUntil = query['untilMs'];
  if (typeof rawFrom === 'string' && typeof rawUntil === 'string') {
    const fromMs = parseInt(rawFrom, 10);
    const untilMs = parseInt(rawUntil, 10);
    if (!isNaN(fromMs) && !isNaN(untilMs) && fromMs <= untilMs) {
      return { fromMs, untilMs };
    }
  }
  const raw = query['hours'];
  const hours = Math.min(168, Math.max(1, parseInt(typeof raw === 'string' ? raw : '24', 10)));
  return { hours };
}

const router = Router();

router.get('/overview', async (req, res, next) => {
  try {
    const range = parseTimeRangeQuery(req.query);
    const services = getAllServices();
    const lastModified = Date.now();
    const result = await Promise.all(
      services.map(async s => {
        const history = await listResponseFiles(s.name, range);
        const safeEndpoints = s.endpoints.map(ep => ({ name: ep.name, url: ep.url }));
        const safeHistory = history.map(f => f.filename.replace(/\.json$/, ''));
        return { ...s, endpoints: safeEndpoints, history: safeHistory };
      }),
    );
    res.json({ lastModified, services: result });
  } catch (err) {
    next(err);
  }
});

router.get('/history/:name', async (req, res, next) => {
  try {
    const rawTag = req.query['tag'];
    const sinceParsed = typeof req.query['since'] === 'string' ? parseInt(req.query['since'], 10) : NaN;
    const range =
      rawTag === 'starred' ? ({ tag: 'starred' } as const) :
      !isNaN(sinceParsed) && sinceParsed > 0 ? { since: sinceParsed } :
      parseTimeRangeQuery(req.query);
    const lastModified = Date.now();
    const files = await listResponseFiles(req.params.name, range);
    res.json({ lastModified, files: files.map(f => f.filename.replace(/\.json$/, '')) });
  } catch (err) {
    next(err);
  }
});

router.get('/history/:name/:filename', requireAuth, async (req, res, next) => {
  try {
    const data = await readResponseFile(req.params['name'] as string, req.params['filename'] as string);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/service-summary', async (req, res, next) => {
  try {
    const range = parseTimeRangeQuery(req.query);
    const services = getAllServices();
    const summaries: ServiceSummary[] = await Promise.all(
      services.map(async s => {
        const files = await listResponseFiles(s.name, range);
        const byBucket = new Map<number, typeof files>();
        for (const f of files) {
          const bucket = Math.floor(f.timestamp / 1000);
          if (!byBucket.has(bucket)) byBucket.set(bucket, []);
          byBucket.get(bucket)!.push(f);
        }
        let latestBucket = -Infinity;
        let latestPassed = false;
        let latestPartial = false;
        let anyFailed = false;
        let hasRuns = false;
        for (const [bucket, runFiles] of byBucket) {
          const override = runFiles.find(f => f.overallStatus === 203 || f.overallStatus === 503);
          const runPassed = override
            ? override.overallStatus === 203
            : runFiles.every(f => f.overallStatus === 200);
          const runPartial = !override && !runPassed &&
            runFiles.every(f => f.overallStatus === 200 || f.overallStatus === 400);
          hasRuns = true;
          if (!runPassed) anyFailed = true;
          if (bucket > latestBucket) { latestBucket = bucket; latestPassed = runPassed; latestPartial = runPartial; }
        }
        const rangeStatus: ServiceSummary['rangeStatus'] = !hasRuns
          ? null
          : !latestPassed
            ? (latestPartial ? 'warning' : 'error')
            : anyFailed
              ? 'warning'
              : 'ok';
        return { name: s.name, group: s.group, rangeStatus };
      }),
    );
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

router.get('/landscapes', (_req, res) => {
  res.json(getLandscapes());
});


router.get('/eval-mode/:name', (req, res) => {
  res.json({ mode: getEvaluationMode(req.params.name) });
});

router.post('/eval-mode/:name', requireAdmin, (req, res) => {
  const svcName = req.params['name'] as string;
  const user = (req as AuthRequest).authSession ? userLabel((req as AuthRequest).authSession!) : 'anon';
  const mode = (req.body as { mode?: string })?.mode;
  if (!mode || !VALID_EVAL_MODES.has(mode)) {
    res.status(400).json({ error: 'mode must be condition, alwaysok, or alwayserror' });
    return;
  }
  setEvaluationMode(svcName, mode as EvaluationMode);
  logger.info({ service: svcName, mode, user }, 'Evaluation mode updated');
  res.json({ ok: true, mode });
});

router.get('/schedule/:name', (req, res) => {
  const name = req.params.name;
  const override = getIntervalOverride(name);
  if (override !== null) {
    res.json({ intervalSeconds: override });
    return;
  }
  const svc = getService(name);
  const firstEp = svc?.endpoints[0];
  res.json({ intervalSeconds: firstEp?.interval ?? svc?.interval ?? 0 });
});

router.post('/schedule/:name', requireAdmin, (req, res) => {
  const name = req.params['name'] as string;
  const user = (req as AuthRequest).authSession ? userLabel((req as AuthRequest).authSession!) : 'anon';
  const { intervalSeconds } = req.body as { intervalSeconds?: unknown };
  if (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 0) {
    res.status(400).json({ error: 'intervalSeconds must be a non-negative integer' });
    return;
  }
  setIntervalOverride(name, intervalSeconds);
  rescheduleService(name, intervalSeconds);
  logger.info({ service: name, intervalSeconds, user }, 'Schedule updated');
  res.json({ ok: true, intervalSeconds });
});

router.get('/services', (_req, res) => {
  const services = getAllServices().map(s => ({
    ...s,
    endpoints: s.endpoints.map(ep => {
      const { username, password, ...safe } = ep;
      void username; void password;
      return safe;
    }),
  }));
  res.json(services);
});

router.get('/check/:name', requireAuth, async (req, res, next) => {
  const name = req.params['name'] as string;
  const user = (req as AuthRequest).authSession ? userLabel((req as AuthRequest).authSession!) : 'anon';
  logger.info({ service: name, from: getClientIp(req), user }, 'Manual test triggered');
  try {
    const result = await checkService(name);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/star/:name/:filename', requireAuth, async (req, res, next) => {
  try {
    const serviceName = req.params['name'] as string;
    const filename = req.params['filename'] as string;
    const { star } = req.body as { star?: unknown };
    if (typeof star !== 'boolean') {
      res.status(400).json({ error: 'star must be a boolean' });
      return;
    }
    const user = (req as AuthRequest).authSession ? userLabel((req as AuthRequest).authSession!) : 'anon';
    await starResponseFile(serviceName, filename, star);
    logger.info({ service: serviceName, filename, star, user, from: getClientIp(req) }, star ? 'Response file starred' : 'Response file unstarred');
    notifyCallbacks();
    emit(`service:${serviceName}`, { service: serviceName, ts: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
