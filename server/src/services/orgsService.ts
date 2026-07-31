import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { fetchOrgsForRegion, fetchSpacesByOrgs, getCfRegions, getCfCredentials } from './cfLoginService.js';
import { getCisSubaccountIndex } from './cisService.js';
import { prefillDirsIfEmpty } from './dirsService.js';
import { appendConfigChangelog, diffOrgs } from './configChangelogService.js';

const CONFIG_DIR = join(config.LOCAL_STORE_DIR, 'config');
const ORGS_PATH  = join(CONFIG_DIR, 'orgs.json');

export interface SpaceEntry {
  space_id:   string;
  space_name: string;
}

export interface OrgEntry {
  region:             string;
  global_account_id:  string;
  org_id:             string;
  org_name:           string;
  subdomain:          string;
  subaccount_id:      string;
  subaccount_name:    string;
  alias:              string;
  directories:        string;
  pos:                number;
  include_in_homepage: boolean;
  manage_destinations: boolean;
  manage_apps:         boolean;
  spaces:             SpaceEntry[];
}


export async function readOrgs(): Promise<OrgEntry[]> {
  try {
    const raw = await readFile(ORGS_PATH, 'utf-8');
    return JSON.parse(raw) as OrgEntry[];
  } catch { return []; }
}

async function writeOrgs(data: OrgEntry[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(ORGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  notifyCallbacks();
  const ts = Date.now();
  emit('root', { files: ['config/orgs.json'], ts });
  emit('config', { files: ['orgs.json'], ts });
  logger.info({ orgs: data.length }, 'orgs.json saved');
}

/**
 * Sort all orgs globally (pos>0 first ascending, then unset by directories→subdomain),
 * reassign pos = index+1 (1-based, globally unique).
 */
function normalizeOrgPositions(data: OrgEntry[]): OrgEntry[] {
  const sorted = [...data].sort((a, b) => {
    const aPosSet = a.pos > 0;
    const bPosSet = b.pos > 0;
    if (aPosSet !== bPosSet) return aPosSet ? -1 : 1;
    if (aPosSet) return a.pos - b.pos;
    return a.directories.localeCompare(b.directories) || a.subdomain.localeCompare(b.subdomain);
  });
  return sorted.map((o, idx) => ({ ...o, pos: idx + 1 }));
}

function mergeOrgs(existing: OrgEntry[], fresh: OrgEntry[]): OrgEntry[] {
  type Editable = Pick<OrgEntry, 'alias' | 'directories' | 'pos' | 'subdomain' | 'subaccount_id' | 'include_in_homepage' | 'manage_destinations' | 'manage_apps'>;
  const editableByKey = new Map<string, Editable>();
  for (const o of existing) {
    editableByKey.set(`${o.region}/${o.org_id}`, {
      alias:               o.alias,
      directories:         o.directories,
      pos:                 o.pos,
      subdomain:           o.subdomain,
      subaccount_id:       o.subaccount_id,
      include_in_homepage: o.include_in_homepage ?? false,
      manage_destinations: o.manage_destinations ?? false,
      manage_apps:         o.manage_apps          ?? false,
    });
  }

  const seenKeys = new Set<string>();
  const merged: OrgEntry[] = fresh.map((o, i) => {
    const key = `${o.region}/${o.org_id}`;
    seenKeys.add(key);
    const prev = editableByKey.get(key);
    return prev ? { ...o, ...prev } : { ...o, pos: i };
  });

  // Keep orgs from existing that did not appear in fresh (access may be temporarily unavailable)
  for (const o of existing) {
    if (!seenKeys.has(`${o.region}/${o.org_id}`)) merged.push(o);
  }

  return merged;
}

/** Re-fetch orgs from CF API for all configured regions, merge with existing, save, notify. */
export async function refreshOrgs(user = 'system'): Promise<{ data: OrgEntry[]; warnings: string[] }> {
  const regions = getCfRegions();
  if (regions.length === 0) {
    throw Object.assign(
      new Error('CF_REGIONS not configured — add it to env or config.json->variables (comma-separated, e.g. "eu10,us10")'),
      { status: 400 },
    );
  }

  const { username, password } = getCfCredentials();
  if (!username || !password) {
    throw Object.assign(
      new Error('CF_USERNAME or CF_PASSWORD not configured — add them to env or config.json->variables'),
      { status: 400 },
    );
  }

  const { index: cisIndex, warning } = await getCisSubaccountIndex(regions);
  const warnings  = warning ? [warning] : [];
  const existing  = await readOrgs();

  const fresh: OrgEntry[] = [];
  for (const region of regions) {
    try {
      const cfOrgs = await fetchOrgsForRegion(region);

      // Fetch spaces for all orgs in this region in a single CF API call
      const orgGuids = cfOrgs.map(o => o.guid);
      let spacesByOrg = new Map<string, Array<{ space_id: string; space_name: string }>>();
      try {
        spacesByOrg = await fetchSpacesByOrgs(region, orgGuids);
      } catch (err) {
        logger.warn({ region, err }, 'Failed to fetch spaces for region — orgs will have empty spaces list');
      }

      for (const { guid, name } of cfOrgs) {
        const cis = cisIndex.get(name);
        fresh.push({
          region,
          global_account_id:   cis?.global_account_id ?? '',
          org_id:              guid,
          org_name:            name,
          subdomain:           cis?.subdomain         ?? '',
          subaccount_id:       cis?.subaccount_id     ?? '',
          subaccount_name:     cis?.subaccount_name   ?? '',
          alias:               '',
          directories:         '',
          pos:                 0,
          include_in_homepage: false,
          manage_destinations: false,
          manage_apps:         false,
          spaces:              spacesByOrg.get(guid) ?? [],
        });
      }
      logger.info({
        region,
        orgs:   cfOrgs.length,
        spaces: [...spacesByOrg.values()].reduce((n, s) => n + s.length, 0),
      }, 'CF orgs + spaces fetched');
    } catch (err) {
      logger.warn({ region, err }, 'Failed to fetch CF orgs for region — skipping');
    }
  }

  const merged = mergeOrgs(existing, fresh);

  // Apply CIS overlay — overwrite subaccount fields from authoritative BTP hierarchy
  for (const o of merged) {
    const cis = cisIndex.get(o.org_name);
    if (!cis) continue;
    o.global_account_id = cis.global_account_id;
    o.subaccount_id     = cis.subaccount_id;
    o.subaccount_name   = cis.subaccount_name;
    o.subdomain         = cis.subdomain;
  }

  const normalized = normalizeOrgPositions(merged);
  const diff = diffOrgs(existing, normalized);
  await writeOrgs(normalized);
  await appendConfigChangelog('Refresh', user, 'orgs.json', diff);
  await prefillDirsIfEmpty();
  return { data: normalized, warnings };
}

/** Save admin-edited orgs (preserves all fields as-is, just persists and notifies). */
export async function saveOrgs(data: OrgEntry[], user = 'system'): Promise<void> {
  const before = await readOrgs();
  const diff   = diffOrgs(before, data);
  await writeOrgs(data);
  await appendConfigChangelog('Update', user, 'orgs.json', diff);
}

/** Export all JSON files from the config dir as a combined object keyed by filename stem. */
export async function exportConfig(): Promise<Record<string, unknown>> {
  const { readdir: fsReaddir, readFile: fsReadFile } = await import('node:fs/promises');
  const combined: Record<string, unknown> = {};
  let files: string[] = [];
  try { files = await fsReaddir(CONFIG_DIR); } catch { return combined; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const content = await fsReadFile(join(CONFIG_DIR, f), 'utf-8');
      combined[f.replace(/\.json$/, '')] = JSON.parse(content);
    } catch { /* skip unreadable */ }
  }
  return combined;
}

/** Import a combined config object, writing each key back as {key}.json. */
export async function importConfig(data: Record<string, unknown>): Promise<void> {
  const { writeFile: fsWriteFile } = await import('node:fs/promises');
  await mkdir(CONFIG_DIR, { recursive: true });
  for (const [key, value] of Object.entries(data)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(key)) continue;
    await fsWriteFile(join(CONFIG_DIR, `${key}.json`), JSON.stringify(value, null, 2), 'utf-8');
  }
  notifyCallbacks();
  const ts = Date.now();
  emit('root',   { files: Object.keys(data).map(k => `config/${k}.json`), ts });
  emit('config', { ts });
  logger.info({ keys: Object.keys(data).length }, 'Config imported');
}
