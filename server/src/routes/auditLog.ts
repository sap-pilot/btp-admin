import { Router } from 'express';
import { resolve as resolvePath, join, basename } from 'node:path';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { requireAdmin } from '../middleware/requireAuth.js';
import {
  refreshAuditLogs, isAuditRefreshRunning,
  refreshSubaccountAuditLogs, isSaAuditRefreshRunning, stopSubaccountAuditLogRefresh,
  getAuditStats, getAuditSaStats, getAuditRecords, getLatestAuditEntries,
  getAuditLogDir,
} from '../services/auditLogService.js';
import { config } from '../config.js';
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

// POST /api/audit-log/refresh/:region/:subdomain/stop — stop an in-progress single-SA refresh (admin only)
router.post('/refresh/:region/:subdomain/stop', requireAdmin, (req, res) => {
  const { region, subdomain } = req.params as { region: string; subdomain: string };
  stopSubaccountAuditLogRefresh(region, subdomain);
  logger.info({ region, subdomain }, 'Single-SA audit log refresh stop requested via API');
  res.json({ ok: true });
});

// GET /api/audit-log/stats?duration=30&q=keyword&categories=... — hourly chart data derived from filenames
router.get('/stats', requireAdmin, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const duration   = parseInt(typeof req.query['duration'] === 'string' ? req.query['duration'] : '30', 10);
    const keyword    = typeof req.query['q']          === 'string' && req.query['q']          ? req.query['q']          : undefined;
    const from       = typeof req.query['from'] === 'string' && req.query['from'] ? req.query['from'] : undefined;
    const to         = typeof req.query['to']   === 'string' && req.query['to']   ? req.query['to']   : undefined;
    const categories = parseCategoriesParam(typeof req.query['categories'] === 'string' ? req.query['categories'] : undefined);
    const { stats, warnings, saSizes } = await getAuditStats(Math.min(Math.max(duration, 1), 365), keyword, from, to);
    logger.debug({ duration, from, to, keyword, categories: categories ? [...categories] : undefined, durationMs: Date.now() - t0 }, 'audit-log/stats');
    res.json({ ok: true, stats, warnings, saSizes });
  } catch (err) { next(err); }
});

// GET /api/audit-log/latest?duration=30&q=keyword&from=...&to=...&categories=... — latest 10 entries per subaccount
router.get('/latest', requireAdmin, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const duration   = parseInt(typeof req.query['duration'] === 'string' ? req.query['duration'] : '30', 10);
    const keyword    = typeof req.query['q']    === 'string' && req.query['q']    ? req.query['q']    : undefined;
    const from       = typeof req.query['from'] === 'string' && req.query['from'] ? req.query['from'] : undefined;
    const to         = typeof req.query['to']   === 'string' && req.query['to']   ? req.query['to']   : undefined;
    const categories = parseCategoriesParam(typeof req.query['categories'] === 'string' ? req.query['categories'] : undefined);
    const entries    = await getLatestAuditEntries(Math.min(Math.max(duration, 1), 365), keyword, from, to, categories);
    logger.debug({ duration, keyword, from, to, categories: categories ? [...categories] : undefined, durationMs: Date.now() - t0 }, 'audit-log/latest');
    res.json({ ok: true, entries });
  } catch (err) { next(err); }
});

// GET /api/audit-log/range/:region/:subdomain — actual earliest/latest {time} from first and last audit log files
router.get('/range/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    const AUDIT_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}_.+\.json$/;
    const dir = getAuditLogDir(region, subdomain);
    let files: string[];
    try { files = (await readdir(dir)).filter(f => AUDIT_FILE_RE.test(f)).sort(); }
    catch { files = []; }

    if (!files.length) { res.json({ ok: true, earliest: '', latest: '' }); return; }

    // Scan a file line-by-line for "time" fields without a full JSON parse.
    // Returns min and max time strings found in the file.
    async function scanTimes(filepath: string): Promise<{ min: string; max: string }> {
      const content = await readFile(filepath, 'utf-8').catch(() => '');
      let min = '', max = '';
      for (const line of content.split('\n')) {
        const m = line.match(/"time"\s*:\s*"([^"]+)"/);
        if (m?.[1]) {
          const t = m[1]!;
          if (!min || t < min) min = t;
          if (!max || t > max) max = t;
        }
      }
      return { min, max };
    }

    // Convert a UTC ISO timestamp to datetime-local format (YYYY-MM-DDTHH:mm) using UTC fields.
    function toLocal(utcIso: string): string {
      if (!utcIso) return '';
      const d = new Date(utcIso.endsWith('Z') ? utcIso : utcIso + 'Z');
      if (isNaN(d.getTime())) return '';
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    }

    const [first, last] = await Promise.all([
      scanTimes(join(dir, files[0]!)),
      files.length > 1 ? scanTimes(join(dir, files[files.length - 1]!)) : Promise.resolve({ min: '', max: '' }),
    ]);
    const earliestTs = first.min;
    const latestTs   = files.length > 1 ? last.max : first.max;

    res.json({ ok: true, earliest: toLocal(earliestTs), latest: toLocal(latestTs) });
  } catch (err) { next(err); }
});

// GET /api/audit-log/stats/:region/:subdomain?duration=90&categories=data-access,security-events — mini chart
router.get('/stats/:region/:subdomain', requireAdmin, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    const duration   = parseInt(typeof req.query['duration']   === 'string' ? req.query['duration']   : '90', 10);
    const categories = parseCategoriesParam(typeof req.query['categories'] === 'string' ? req.query['categories'] : undefined);
    const stats = await getAuditSaStats(region, subdomain, Math.min(Math.max(duration, 1), 365), categories);
    logger.debug({ region, subdomain, duration, categories: categories ? [...categories] : undefined, durationMs: Date.now() - t0 }, 'audit-log/stats/:sa');
    res.json({ ok: true, stats });
  } catch (err) { next(err); }
});

// GET /api/audit-log/records/:region/:subdomain — paginated records for subaccount modal
router.get('/records/:region/:subdomain', requireAdmin, async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    const keyword    = typeof req.query['q']     === 'string' ? req.query['q']     : undefined;
    const from       = typeof req.query['from']  === 'string' ? req.query['from']  : undefined;
    const to         = typeof req.query['to']    === 'string' ? req.query['to']    : undefined;
    const limit      = parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '100', 10);
    const page       = parseInt(typeof req.query['page']  === 'string' ? req.query['page']  : '1', 10);
    const categories = parseCategoriesParam(typeof req.query['categories'] === 'string' ? req.query['categories'] : undefined);
    const result     = await getAuditRecords(region, subdomain, { from, to, keyword, limit, page, categories });
    logger.debug({ region, subdomain, keyword, from, to, limit, page, categories: categories ? [...categories] : undefined, total: result.total, durationMs: Date.now() - t0 }, 'audit-log/records');
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// GET /api/audit-log/export/:region/:subdomain?from=...&to=...&q=...&confirm=1
// Streams a ZIP of matching audit log files. If no keywords and total size > 1 GB,
// returns a JSON warning instead (unless confirm=1 is passed).
router.get('/export/:region/:subdomain', requireAdmin, async (req, res, next) => {
  try {
    const { region, subdomain } = req.params as { region: string; subdomain: string };
    const from    = typeof req.query['from']    === 'string' ? req.query['from'].trim()    : '';
    const to      = typeof req.query['to']      === 'string' ? req.query['to'].trim()      : '';
    const kwStr   = typeof req.query['q']       === 'string' ? req.query['q'].trim()       : '';
    const confirm = req.query['confirm'] === '1';

    // Convert an ISO / datetime-local string to a UTC hour key "YYYY-MM-DDTHH"
    // (same convention as parseHourKey in auditLogService — uses UTC methods so
    //  the result matches the UTC-keyed filenames).
    const toHourKey = (iso: string): string => {
      const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
      if (isNaN(d.getTime())) return '';
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
    };

    const fromHour = from ? toHourKey(from) : '';
    const toHour   = to   ? toHourKey(to)   : '9999';

    // Locate matching files by comparing the hour key embedded in the filename
    const AUDIT_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}_.+\.json$/;
    const dir = getAuditLogDir(region, subdomain);
    let allFiles: string[];
    try {
      allFiles = (await readdir(dir)).filter(f => AUDIT_FILE_RE.test(f)).sort();
    } catch {
      res.json({ ok: false, error: 'No audit log data found for this subaccount.' });
      return;
    }

    const matched = allFiles.filter(f => {
      const hk = f.slice(0, 13); // "YYYY-MM-DDTHH"
      return (!fromHour || hk >= fromHour) && hk <= toHour;
    });

    if (matched.length === 0) {
      res.json({ ok: false, error: 'No audit log files found for the selected time range.' });
      return;
    }

    // Sum file sizes
    const filePaths = matched.map(f => join(dir, f));
    let totalBytes = 0;
    for (const fp of filePaths) {
      const s = await stat(fp).catch(() => null);
      if (s) totalBytes += s.size;
    }

    const ONE_GB = 1_073_741_824;
    const hasKeywords = kwStr.length > 0;

    if (!hasKeywords && !confirm && totalBytes > ONE_GB) {
      res.json({
        ok: false,
        warning: true,
        message: `The selected time range covers ${matched.length} file(s) totalling ${(totalBytes / ONE_GB).toFixed(1)} GB. The export ZIP may exceed 100 MB. Consider choosing a smaller time range or entering keywords to filter records.`,
        fileCount: matched.length,
        sizeBytes: totalBytes,
      });
      return;
    }

    const tmpBase = resolvePath(config.LOCAL_STORE_DIR, '..', 'tmp');
    await mkdir(tmpBase, { recursive: true });
    const hex     = randomBytes(8).toString('hex');
    const tmpZip  = join(tmpBase, `audit-export-${hex}.zip`);
    let   tmpJson: string | null = null;

    try {
      if (hasKeywords) {
        // Filter records by every keyword (case-insensitive AND), write filtered JSON
        const keywords = kwStr.split(/\s+/).filter(Boolean).map(k => k.toLowerCase());
        const matching: string[] = [];
        for (const fp of filePaths) {
          const raw = await readFile(fp, 'utf-8').catch(() => '');
          for (const line of raw.split('\n')) {
            const stripped = line.trim().replace(/,$/, '');
            if (!stripped.startsWith('{')) continue;
            const lower = stripped.toLowerCase();
            if (keywords.every(kw => lower.includes(kw))) matching.push(stripped);
          }
        }
        tmpJson = join(tmpBase, `audit-export-${hex}.json`);
        await writeFile(tmpJson, `[\n${matching.join(',\n')}\n]`, 'utf-8');
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('zip', ['-q', tmpZip, basename(tmpJson!)], { cwd: tmpBase });
          proc.stdout?.resume(); proc.stderr?.resume();
          proc.on('close', code => code === 0 ? resolve() : reject(new Error(`zip exited with ${code}`)));
          proc.on('error', reject);
        });
      } else {
        // Zip matching files directly using stdin (-@) from the audit log dir
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('zip', ['-q', tmpZip, '-@'], { cwd: dir });
          proc.stdout?.resume(); proc.stderr?.resume();
          proc.on('close', code => (code === 0 || code === 12) ? resolve() : reject(new Error(`zip exited with ${code}`)));
          proc.on('error', reject);
          proc.stdin!.on('error', () => { /* EPIPE if zip exits early */ });
          proc.stdin!.end(matched.join('\n'));
        });
      }

      const zipStat  = await stat(tmpZip);
      const dlName   = `audit-log_${region}_${subdomain}${from ? `_${from.slice(0, 10)}` : ''}${to ? `_to_${to.slice(0, 10)}` : ''}.zip`;
      logger.debug({ region, subdomain, from, to, kwStr, matched: matched.length, sizeBytes: totalBytes, zipBytes: zipStat.size }, 'audit-log/export streaming');
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${dlName}"`);
      res.set('Content-Length', String(zipStat.size));
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(tmpZip);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(res, { end: false });
      });
      res.end();
    } finally {
      await unlink(tmpZip).catch(() => { /* ignore */ });
      if (tmpJson) await unlink(tmpJson).catch(() => { /* ignore */ });
    }
  } catch (err) { next(err); }
});

export default router;
