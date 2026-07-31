import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { fetchOrgsForRegion, fetchSpacesByOrgs, getCfRegions, getCfCredentials } from './cfLoginService.js';
import { readEffectiveHomepageRaw } from './home/homepageEditService.js';
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

interface SaMeta {
  id:               string;
  dirShort:         string;
  name:             string;
  subdomain:        string;
  hpPos:            number;
  global_account_id: string;
}

/** Build an index of orgId → subaccount metadata from homepage.json. */
function buildSubaccountIndex(): Map<string, SaMeta> {
  const index = new Map<string, SaMeta>();
  try {
    const raw = readEffectiveHomepageRaw();
    if (!raw) return index;
    const hp = JSON.parse(raw) as {
      btp?: {
        globalAccounts?: Array<{
          id?: string;
          directories?: Array<{
            short?: string;
            subaccounts?: Array<{ id?: string; name?: string; subdomain?: string; orgId?: string }>;
          }>;
        }>;
      };
    };
    let hpPos = 0;
    for (const ga of hp.btp?.globalAccounts ?? []) {
      const global_account_id = ga.id ?? '';
      for (const dir of ga.directories ?? []) {
        const dirShort = dir.short ?? '';
        for (const sa of dir.subaccounts ?? []) {
          if (sa.orgId && sa.id) {
            index.set(sa.orgId, {
              id:               sa.id,
              dirShort,
              name:             sa.name      ?? '',
              subdomain:        sa.subdomain ?? '',
              hpPos,
              global_account_id,
            });
          }
          hpPos++;
        }
      }
    }
  } catch { /* homepage.json missing or invalid — proceed without subaccount cross-ref */ }
  return index;
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
export async function refreshOrgs(user = 'system'): Promise<OrgEntry[]> {
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

  const saIndex     = buildSubaccountIndex();
  const existing    = await readOrgs();
  const existingKeys = new Set(existing.map(o => `${o.region}/${o.org_id}`));

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
        const sa = saIndex.get(guid);
        fresh.push({
          region,
          global_account_id:   sa?.global_account_id ?? '',
          org_id:              guid,
          org_name:            name,
          subdomain:           sa?.subdomain ?? '',
          subaccount_id:       sa?.id        ?? '',
          subaccount_name:     '',
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

  // Fill empty editable fields from homepage.json metadata
  for (const o of merged) {
    const meta = saIndex.get(o.org_id);
    if (!meta) continue;
    if (!o.alias)             o.alias             = meta.name;
    if (!o.directories)       o.directories       = meta.dirShort;
    if (!o.subdomain)         o.subdomain         = meta.subdomain;
    if (!o.subaccount_id)     o.subaccount_id     = meta.id;
    if (!o.global_account_id) o.global_account_id = meta.global_account_id;
    if (!existingKeys.has(`${o.region}/${o.org_id}`)) o.pos = meta.hpPos;
  }

  const normalized = normalizeOrgPositions(merged);
  const diff = diffOrgs(existing, normalized);
  await writeOrgs(normalized);
  await appendConfigChangelog('Refresh', user, 'orgs.json', diff);
  await prefillDirsIfEmpty();
  return normalized;
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
