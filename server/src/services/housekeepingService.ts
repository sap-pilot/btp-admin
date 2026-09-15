import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseFilename } from './localStoreService.js';
import { getVar } from './variablesService.js';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

const AUDIT_FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})_\d+_\d+_\d+_\d+(?:_\d+)?\.json$/;

export async function runHousekeeping(): Promise<void> {
  const maxDays = config.MAX_RESPONSE_STORAGE_DAYS;

  // ── Response file cleanup ────────────────────────────────────────────────────
  if (maxDays > 0) {
    const cutoff      = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const cutoffLabel = new Date(cutoff).toISOString().replace('T', ' ').slice(0, 19);
    let deleted = 0;
    let starred = 0;
    let errors  = 0;

    const respBase = join(config.LOCAL_STORE_DIR, 'resp');
    try {
      const entries = await readdir(respBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const serviceDir = join(respBase, entry.name);

        let files: string[];
        try { files = await readdir(serviceDir); } catch { continue; }

        for (const file of files) {
          if (file.includes('.starred.')) {
            if (file.endsWith('.json')) {
              const meta = parseFilename(file.replace('.starred.', '.'));
              if (meta !== null && meta.timestamp < cutoff) starred++;
            }
            continue;
          }

          let jsonName: string;
          if (file.endsWith('.json'))                    jsonName = file;
          else if (file.endsWith('.png'))                jsonName = file.replace(/\.png$/, '.json');
          else if (file.endsWith('_console.log'))        jsonName = file.slice(0, -12) + '.json';
          else if (file.endsWith('_content.html'))       jsonName = file.slice(0, -13) + '.json';
          else if (file.endsWith('_console.retry.log'))  jsonName = file.slice(0, file.length - '_console.retry.log'.length) + '.retry.json';
          else if (file.endsWith('_content.retry.html')) jsonName = file.slice(0, file.length - '_content.retry.html'.length) + '.retry.json';
          else continue;

          const meta = parseFilename(jsonName);
          if (meta === null || meta.timestamp >= cutoff) continue;
          try { await unlink(join(serviceDir, file)); deleted++; } catch { errors++; }
        }
      }

      logger.info(
        { deleted, starred, errors, maxDays, cutoff: cutoffLabel },
        `Housekeeping: ${deleted} file(s) deleted (older than ${cutoffLabel} UTC), ${starred} starred file(s) preserved`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // resp/ doesn't exist yet — nothing to clean up
      } else {
        logger.warn({ err }, 'Housekeeping (resp/) error (will retry in 1 h)');
      }
    }
  }

  // ── Audit log file cleanup ───────────────────────────────────────────────────
  const maxAuditStr  = getVar('MAX_AUDIT_LOG_STORAGE_DAYS');
  const maxAuditDays = maxAuditStr ? parseInt(maxAuditStr, 10) : 0;
  if (maxAuditDays > 0) {
    const cutoffKey  = new Date(Date.now() - maxAuditDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 13);
    const auditBase  = join(config.LOCAL_STORE_DIR, 'audit-log');
    let auditDeleted = 0;

    try {
      for (const regionEntry of await readdir(auditBase, { withFileTypes: true })) {
        if (!regionEntry.isDirectory()) continue;
        const regionDir = join(auditBase, regionEntry.name);
        for (const saEntry of await readdir(regionDir, { withFileTypes: true }).catch(() => [])) {
          if (!saEntry.isDirectory()) continue;
          const saDir = join(regionDir, saEntry.name);
          for (const file of await readdir(saDir).catch(() => [] as string[])) {
            const m = AUDIT_FILE_RE.exec(file);
            if (!m || m[1]! >= cutoffKey) continue;
            try { await unlink(join(saDir, file)); auditDeleted++; } catch { /* skip */ }
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'Housekeeping (audit-log/) error (will retry in 1 h)');
      }
    }

    if (auditDeleted > 0) {
      logger.info({ auditDeleted, maxAuditDays, cutoff: cutoffKey },
        `Housekeeping: ${auditDeleted} audit log file(s) deleted (older than ${cutoffKey} UTC)`);
    }
  }
}

function scheduleNext(): void {
  if (stopped) return;
  timer = setTimeout(() => {
    void runHousekeeping().finally(scheduleNext);
  }, INTERVAL_MS);
  timer.unref();
}

export function startHousekeepingScheduler(): void {
  const maxAuditStr  = getVar('MAX_AUDIT_LOG_STORAGE_DAYS');
  const maxAuditDays = maxAuditStr ? parseInt(maxAuditStr, 10) : 0;
  if (config.MAX_RESPONSE_STORAGE_DAYS <= 0 && maxAuditDays <= 0) {
    logger.info('Housekeeping disabled (MAX_RESPONSE_STORAGE_DAYS=0 and MAX_AUDIT_LOG_STORAGE_DAYS not set)');
    return;
  }
  stopped = false;
  logger.info(
    { maxDays: config.MAX_RESPONSE_STORAGE_DAYS, maxAuditDays },
    'Housekeeping scheduler started — first run in 1 h',
  );
  scheduleNext();
}

export function stopHousekeepingScheduler(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}
