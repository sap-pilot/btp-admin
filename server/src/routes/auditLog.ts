import { Router } from 'express';
import { requireAdmin } from '../middleware/requireAuth.js';
import {
  refreshAuditLogs, isAuditRefreshRunning,
  refreshSubaccountAuditLogs, isSaAuditRefreshRunning,
  getAuditStats, getAuditSaStats, getAuditRecords, getLatestAuditEntries,
} from '../services/auditLogService.js';
import { logger } from '../logger.js';

const router = Router();

const ALL_AUDIT_CATS = new Set(['data-access', 'security-events', 'configuration', 'data-modification', 'other']);

function parseCategoriesParam(raw: string | undefined): Set<string> | undefined {
  if (!raw) return undefined;
  const cats = new Set(raw.split(',').map(s => s.trim()).filter(s => ALL_AUDIT_CATS.has(s)));
  return cats.size > 0 && cats.size < ALL_AUDIT_CATS.size ? cats : undefined;
}

// POST /api/audit-log/refresh — trigger background audit log refresh for all SAs (admin only)
router.post('/refresh', requireAdmin, (_req, res) => {
  if (isAuditRefreshRunning()) {
    res.json({ ok: true, started: false, reason: 'already running' });
    return;
  }
  void refreshAuditLogs();
  logger.info('Audit log refresh triggered via API');
  res.json({ ok: true, started: true });
});

// POST /api/audit-log/refresh/:region/:subdomain — single-SA delta refresh (admin only)
router.post('/refresh/:region/:subdomain', requireAdmin, (req, res) => {
  const { region, subdomain } = req.params as { region: string; subdomain: string };
  if (isSaAuditRefreshRunning(region, subdomain)) {
    res.json({ ok: true, started: false, reason: 'already running' });
    return;
  }
  void refreshSubaccountAuditLogs(region, subdomain);
  logger.info({ region, subdomain }, 'Single-SA audit log refresh triggered via API');
  res.json({ ok: true, started: true });
});

// GET /api/audit-log/stats?duration=30&q=keyword — hourly chart data derived from filenames
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const duration = parseInt(typeof req.query['duration'] === 'string' ? req.query['duration'] : '30', 10);
    const keyword  = typeof req.query['q'] === 'string' && req.query['q'] ? req.query['q'] : undefined;
    const { stats, warnings } = await getAuditStats(Math.min(Math.max(duration, 1), 90), keyword);
    res.json({ ok: true, stats, warnings });
  } catch (err) { next(err); }
});

// GET /api/audit-log/latest?duration=30&q=keyword&from=...&to=... — latest 10 entries per subaccount
router.get('/latest', requireAdmin, async (req, res, next) => {
  try {
    const duration = parseInt(typeof req.query['duration'] === 'string' ? req.query['duration'] : '30', 10);
    const keyword  = typeof req.query['q']    === 'string' && req.query['q']    ? req.query['q']    : undefined;
    const from     = typeof req.query['from'] === 'string' && req.query['from'] ? req.query['from'] : undefined;
    const to       = typeof req.query['to']   === 'string' && req.query['to']   ? req.query['to']   : undefined;
    const entries  = await getLatestAuditEntries(Math.min(Math.max(duration, 1), 90), keyword, from, to);
    res.json({ ok: true, entries });
  } catch (err) { next(err); }
});

// GET /api/audit-log/stats/:region/:subdomain?duration=90&categories=data-access,security-events — mini chart
router.get('/stats/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    const duration   = parseInt(typeof req.query['duration']   === 'string' ? req.query['duration']   : '90', 10);
    const categories = parseCategoriesParam(typeof req.query['categories'] === 'string' ? req.query['categories'] : undefined);
    const stats = await getAuditSaStats(region, subdomain, Math.min(Math.max(duration, 1), 365), categories);
    res.json({ ok: true, stats });
  } catch (err) { next(err); }
});

// GET /api/audit-log/records/:region/:subdomain — paginated records for subaccount modal
router.get('/records/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    const keyword = typeof req.query['q']     === 'string' ? req.query['q']     : undefined;
    const from    = typeof req.query['from']  === 'string' ? req.query['from']  : undefined;
    const to      = typeof req.query['to']    === 'string' ? req.query['to']    : undefined;
    const limit      = parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '100', 10);
    const page       = parseInt(typeof req.query['page']  === 'string' ? req.query['page']  : '1', 10);
    const categories = parseCategoriesParam(typeof req.query['categories'] === 'string' ? req.query['categories'] : undefined);
    const result  = await getAuditRecords(region, subdomain, { from, to, keyword, limit, page, categories });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

export default router;
