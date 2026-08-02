import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const CONFIG_DIR  = join(config.LOCAL_STORE_DIR, 'config');
const WATCH_FILES = ['tabs.json', 'subaccounts.json', 'settings.json'];

let lastUpdatedTs: number | null = null;

export function getLastUpdated(): number | null { return lastUpdatedTs; }

/** Call from write functions — sets timestamp to now (local change). */
export function touchLastUpdated(ts: number = Date.now()): void {
  lastUpdatedTs = ts;
}

/** Call on startup and after remote sync — reads actual file mtimes. */
export async function refreshLastUpdated(): Promise<void> {
  let max = 0;
  for (const f of WATCH_FILES) {
    try {
      const s = await stat(join(CONFIG_DIR, f));
      if (s.mtimeMs > max) max = s.mtimeMs;
    } catch { /* file not yet present */ }
  }
  if (max > 0) lastUpdatedTs = max;
}
