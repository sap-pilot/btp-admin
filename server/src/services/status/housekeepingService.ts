import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { parseFilename } from './responseStore.js';

let timer: ReturnType<typeof setInterval> | null = null;

export async function runHousekeeping(): Promise<void> {
  const maxDays = config.MAX_RESPONSE_STORAGE_DAYS;
  if (maxDays <= 0) return;

  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let errors = 0;

  try {
    const entries = await readdir(config.RESPONSE_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const serviceDir = join(config.RESPONSE_DIR, entry.name);

      let files: string[];
      try {
        files = await readdir(serviceDir);
      } catch {
        continue;
      }

      for (const file of files) {
        // Starred files are retained indefinitely
        if (file.includes('.starred.')) continue;

        // Derive the corresponding .json filename so we can parse the timestamp
        let jsonName: string;
        if (file.endsWith('.json')) jsonName = file;
        else if (file.endsWith('.png')) jsonName = file.replace(/\.png$/, '.json');
        else if (file.endsWith('_console.log')) jsonName = file.slice(0, -12) + '.json';
        else if (file.endsWith('_content.html')) jsonName = file.slice(0, -13) + '.json';
        else if (file.endsWith('_console.retry.log')) jsonName = file.slice(0, file.length - '_console.retry.log'.length) + '.retry.json';
        else if (file.endsWith('_content.retry.html')) jsonName = file.slice(0, file.length - '_content.retry.html'.length) + '.retry.json';
        else continue;
        // Use the shared parser which correctly handles UTC (new format) and local (old format)
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

    logger.info({ deleted, errors, maxDays }, 'Housekeeping completed');
  } catch (err) {
    logger.warn({ err }, 'Housekeeping error');
  }
}

export function startHousekeepingScheduler(): void {
  if (config.MAX_RESPONSE_STORAGE_DAYS <= 0) {
    logger.info('Housekeeping disabled (MAX_RESPONSE_STORAGE_DAYS=0)');
    return;
  }
  logger.info({ maxDays: config.MAX_RESPONSE_STORAGE_DAYS }, 'Housekeeping scheduler started');
  void runHousekeeping();
  // Run once a day
  timer = setInterval(() => void runHousekeeping(), 24 * 60 * 60 * 1000);
  timer.unref();
}

export function stopHousekeepingScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
