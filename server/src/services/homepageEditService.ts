import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { notifyCallbacks } from './status/syncService.js';

const HOMEPAGE_PATH = join(config.RESPONSE_DIR, 'homepage.json');
const CHANGELOG_PATH = join(config.RESPONSE_DIR, 'homepage-changelog.md');

/** Read the effective raw homepage JSON following the priority chain:
 *  RESPONSE_DIR/homepage.json > HOMEPAGE_JSON env > server/homepage.json */
export function readEffectiveHomepageRaw(): string | null {
  if (existsSync(HOMEPAGE_PATH)) return readFileSync(HOMEPAGE_PATH, 'utf-8');
  if (process.env.HOMEPAGE_JSON) return process.env.HOMEPAGE_JSON;
  try { return readFileSync('./homepage.json', 'utf-8'); } catch { return null; }
}

export function saveHomepage(jsonText: string, user: { name: string; email?: string }): void {
  const oldRaw = readEffectiveHomepageRaw();
  mkdirSync(config.RESPONSE_DIR, { recursive: true });
  writeFileSync(HOMEPAGE_PATH, jsonText, 'utf-8');

  const diff = computeDiff(oldRaw, jsonText);
  const dateStr = fmtDate(new Date());
  const userStr = user.email ? `${user.name} <${user.email}>` : user.name;
  const entry = `## ${dateStr} - ${userStr}\n${diff}\n\n`;
  const existing = existsSync(CHANGELOG_PATH) ? readFileSync(CHANGELOG_PATH, 'utf-8') : '';
  writeFileSync(CHANGELOG_PATH, entry + existing, 'utf-8');

  notifyCallbacks();
}

export function readHomepageChangelog(): string {
  if (!existsSync(CHANGELOG_PATH)) return '';
  return readFileSync(CHANGELOG_PATH, 'utf-8');
}

// ─── Internals ────────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ` +
    `${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

function computeDiff(oldRaw: string | null, newRaw: string): string {
  if (!oldRaw) return 'Initial homepage configuration.';
  try {
    const lines: string[] = [];
    diffValues(JSON.parse(oldRaw) as unknown, JSON.parse(newRaw) as unknown, '', lines, 0);
    if (lines.length === 0) return 'No changes.';
    if (lines.length > 100) return lines.slice(0, 100).join('\n') + `\n… (${lines.length - 100} more changes)`;
    return lines.join('\n');
  } catch {
    return 'Configuration updated.';
  }
}

function trunc(s: string, max = 150): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function diffValues(a: unknown, b: unknown, path: string, lines: string[], depth: number): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const aIsObj = a !== null && typeof a === 'object';
  const bIsObj = b !== null && typeof b === 'object';
  if (!aIsObj || !bIsObj || Array.isArray(a) !== Array.isArray(b) || depth >= 5) {
    lines.push(`- ${path || '(root)'}: ${trunc(JSON.stringify(a))}`);
    lines.push(`+ ${path || '(root)'}: ${trunc(JSON.stringify(b))}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) lines.push(`+ ${p}: ${trunc(JSON.stringify(b[i]))}`);
      else if (i >= b.length) lines.push(`- ${p}: ${trunc(JSON.stringify(a[i]))}`);
      else diffValues(a[i], b[i], p, lines, depth + 1);
    }
    return;
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ar), ...Object.keys(br)])) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in ar)) lines.push(`+ ${p}: ${trunc(JSON.stringify(br[k]))}`);
    else if (!(k in br)) lines.push(`- ${p}: ${trunc(JSON.stringify(ar[k]))}`);
    else diffValues(ar[k], br[k], p, lines, depth + 1);
  }
}
