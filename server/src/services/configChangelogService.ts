import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';

const CONFIG_DIR     = join(config.LOCAL_STORE_DIR, 'conf');
const CHANGELOG_PATH = join(CONFIG_DIR, 'changelog.md');
const MAX_CHANGELOG_SIZE = 2 * 1024 * 1024; // 2 MB

export async function readConfigChangelog(): Promise<string> {
  try { return await readFile(CHANGELOG_PATH, 'utf-8'); }
  catch { return ''; }
}

export async function listArchivedChangelogs(): Promise<string[]> {
  try {
    const files = await readdir(CONFIG_DIR);
    return files
      .filter(f => /^changelog\.\d{12}\.md$/.test(f))
      .sort()
      .reverse();
  } catch { return []; }
}

export async function readArchivedChangelog(filename: string): Promise<string> {
  if (!/^changelog\.\d{12}\.md$/.test(filename)) return '';
  try { return await readFile(join(CONFIG_DIR, filename), 'utf-8'); }
  catch { return ''; }
}

function utcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function rotationTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(-2)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function appendConfigChangelog(
  action: 'Refresh' | 'Update' | 'Import',
  user: string,
  filename: string,
  diff: string,
): Promise<void> {
  const trimmed = diff.trim();
  if (!trimmed) return;

  await mkdir(CONFIG_DIR, { recursive: true });

  // Rotate if current changelog exceeds 2 MB
  try {
    const stats = await stat(CHANGELOG_PATH);
    if (stats.size > MAX_CHANGELOG_SIZE) {
      const ts = rotationTimestamp();
      await rename(CHANGELOG_PATH, join(CONFIG_DIR, `changelog.${ts}.md`));
      logger.info({ ts }, 'config changelog rotated');
    }
  } catch { /* file doesn't exist yet — no rotation needed */ }

  const existing = await readConfigChangelog();
  const header   = `## [${action}] [${filename}] by <${user}> at ${utcTimestamp()}`;
  const entry    = `${header}\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n`;

  await writeFile(CHANGELOG_PATH, entry + existing, 'utf-8');
  notifyCallbacks();
  const ts = Date.now();
  emit('root',   { files: ['conf/changelog.md'], ts });
  emit('config', { files: ['changelog.md'], ts });
  logger.info({ action, user, filename }, 'config changelog updated');
}

export async function searchConfigChangelogs(query: string): Promise<{ files: string[]; matchCount: number }> {
  if (!query.trim()) return { files: [], matchCount: 0 };
  const lq = query.toLowerCase();

  const allFiles: string[] = ['', ...await listArchivedChangelogs()];
  const matched: string[] = [];
  let totalMatches = 0;

  for (const f of allFiles) {
    const text = f === '' ? await readConfigChangelog() : await readArchivedChangelog(f);
    const count = text.toLowerCase().split(lq).length - 1;
    if (count > 0) {
      matched.push(f);
      totalMatches += count;
    }
  }

  return { files: matched, matchCount: totalMatches };
}

