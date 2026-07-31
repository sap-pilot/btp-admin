import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';

const CONFIG_DIR     = join(config.LOCAL_STORE_DIR, 'config');
const CHANGELOG_PATH = join(CONFIG_DIR, 'changelog.md');

// Local type aliases — structurally compatible with orgsService / dirsService types.
// Kept here to avoid circular imports (orgsService/dirsService import this module).
interface OrgEntry  { org_id: string; org_name: string; alias: string; directories: string; pos: number; subdomain: string; subaccount_id: string; includeInHomepage: boolean; manageDestination: boolean; manageApps: boolean; }
interface OrgRegion { region: string; orgs: OrgEntry[]; }
interface DirEntry  { alias: string; title: string; pos: number; }
interface DirTab    { tab: string; dirs: DirEntry[]; }

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

const ORG_FIELDS = [
  'org_name', 'alias', 'directories', 'pos',
  'subdomain', 'subaccount_id',
  'includeInHomepage', 'manageDestination', 'manageApps',
] as const;

export function diffOrgs(before: OrgRegion[], after: OrgRegion[]): string {
  const beforeMap = new Map<string, OrgEntry>();
  const afterMap  = new Map<string, OrgEntry>();
  for (const r of before) for (const o of r.orgs) beforeMap.set(`${r.region}/${o.org_id}`, o);
  for (const r of after)  for (const o of r.orgs) afterMap.set(`${r.region}/${o.org_id}`,  o);

  const lines: string[] = [];

  for (const [key, o] of afterMap)  { if (!beforeMap.has(key)) lines.push(`+ ${key} (${o.org_name})`); }
  for (const [key, o] of beforeMap) { if (!afterMap.has(key))  lines.push(`- ${key} (${o.org_name})`); }

  for (const [key, bef] of beforeMap) {
    const aft = afterMap.get(key);
    if (!aft) continue;
    const changes: string[] = [];
    for (const f of ORG_FIELDS) {
      if (String(bef[f]) !== String(aft[f]))
        changes.push(`    ${f}: ${JSON.stringify(bef[f])} → ${JSON.stringify(aft[f])}`);
    }
    if (changes.length) { lines.push(`~ ${key} (${aft.org_name})`); lines.push(...changes); }
  }

  return lines.join('\n');
}

export function diffDirs(before: DirTab[], after: DirTab[]): string {
  const beforeMap = new Map(before.map(t => [t.tab, t]));
  const afterMap  = new Map(after.map(t => [t.tab, t]));
  const lines: string[] = [];

  for (const [tab] of afterMap)  { if (!beforeMap.has(tab)) lines.push(`+ tab: "${tab}"`); }
  for (const [tab] of beforeMap) { if (!afterMap.has(tab))  lines.push(`- tab: "${tab}"`); }

  for (const [tab, aft] of afterMap) {
    const bef = beforeMap.get(tab);
    if (!bef) continue;
    const bDirs = new Map(bef.dirs.map(d => [d.alias, d]));
    const aDirs = new Map(aft.dirs.map(d => [d.alias, d]));
    const tabLines: string[] = [];
    for (const [alias] of aDirs) { if (!bDirs.has(alias)) tabLines.push(`    + dir: ${alias}`); }
    for (const [alias] of bDirs) { if (!aDirs.has(alias)) tabLines.push(`    - dir: ${alias}`); }
    for (const [alias, ad] of aDirs) {
      const bd = bDirs.get(alias);
      if (!bd) continue;
      if (bd.pos !== ad.pos)     tabLines.push(`    ~ dir: ${alias}  pos: ${bd.pos} → ${ad.pos}`);
      if (bd.title !== ad.title) tabLines.push(`    ~ dir: ${alias}  title: ${JSON.stringify(bd.title)} → ${JSON.stringify(ad.title)}`);
    }
    if (tabLines.length) { lines.push(`~ tab: "${tab}"`); lines.push(...tabLines); }
  }

  return lines.join('\n');
}
