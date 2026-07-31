import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseFilename } from './localStoreService.js';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export async function runHousekeeping(): Promise<void> {
  const maxDays = config.MAX_RESPONSE_STORAGE_DAYS;
  if (maxDays <= 0) return;

  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const cutoffLabel = new Date(cutoff).toISOString().replace('T', ' ').slice(0, 19);
  let deleted = 0;
  let starred = 0;
  let errors = 0;

  // Housekeeping is scoped strictly to {LOCAL_STORE_DIR}/resp/ — root files
  // (homepage.json, etc.) stored directly in LOCAL_STORE_DIR are never touched.
  const respBase = join(config.LOCAL_STORE_DIR, 'resp');

  try {
    const entries = await readdir(respBase, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const serviceDir = join(respBase, entry.name);

      let files: string[];
      try {
        files = await readdir(serviceDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (file.includes('.starred.')) {
          // Count old-enough starred JSON records that are preserved from deletion
          if (file.endsWith('.json')) {
            const meta = parseFilename(file.replace('.starred.', '.'));
            if (meta !== null && meta.timestamp < cutoff) starred++;
          }
          continue;
        }

        let jsonName: string;
        if (file.endsWith('.json')) jsonName = file;
        else if (file.endsWith('.png')) jsonName = file.replace(/\.png$/, '.json');
        else if (file.endsWith('_console.log')) jsonName = file.slice(0, -12) + '.json';
        else if (file.endsWith('_content.html')) jsonName = file.slice(0, -13) + '.json';
        else if (file.endsWith('_console.retry.log')) jsonName = file.slice(0, file.length - '_console.retry.log'.length) + '.retry.json';
        else if (file.endsWith('_content.retry.html')) jsonName = file.slice(0, file.length - '_content.retry.html'.length) + '.retry.json';
        else continue;

        const meta = parseFilename(jsonName);
        if (meta === null || meta.timestamp >= cutoff) continue;

        try {
          await unlink(join(serviceDir, file));
          deleted++;
        } catch {
          errors++;
        }
      }
    }

    logger.info(
      { deleted, starred, errors, maxDays, cutoff: cutoffLabel },
      `Housekeeping: ${deleted} file(s) deleted (older than ${cutoffLabel} UTC), ${starred} starred file(s) preserved`,
    );
  } catch (err) {
    // resp/ doesn't exist yet (no health checks run yet) — nothing to clean up
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn({ err }, 'Housekeeping error (will retry in 1 h)');
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
  if (config.MAX_RESPONSE_STORAGE_DAYS <= 0) {
    logger.info('Housekeeping disabled (MAX_RESPONSE_STORAGE_DAYS=0)');
    return;
  }
  stopped = false;
  logger.info({ maxDays: config.MAX_RESPONSE_STORAGE_DAYS }, 'Housekeeping scheduler started — first run in 1 h');
  scheduleNext();
}

export function stopHousekeepingScheduler(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}
