import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';

const CONFIG_DIR     = join(config.LOCAL_STORE_DIR, 'config');
const CHANGELOG_PATH = join(CONFIG_DIR, 'changelog.md');

export async function readConfigChangelog(): Promise<string> {
  try { return await readFile(CHANGELOG_PATH, 'utf-8'); }
  catch { return ''; }
}

function utcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export async function appendConfigChangelog(
  action: 'Refresh' | 'Update',
  user: string,
  filename: string,
  diff: string,
): Promise<void> {
  const trimmed = diff.trim();
  if (!trimmed) return;

  const existing = await readConfigChangelog();
  const header   = `## [${action}] [${filename}] by <${user}> at ${utcTimestamp()}`;
  const entry    = `${header}\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n`;

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CHANGELOG_PATH, entry + existing, 'utf-8');
  notifyCallbacks();
  const ts = Date.now();
  emit('root',   { files: ['config/changelog.md'], ts });
  emit('config', { files: ['changelog.md'], ts });
  logger.info({ action, user, filename }, 'config changelog updated');
}

