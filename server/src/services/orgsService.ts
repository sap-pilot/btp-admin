import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { fetchOrgsForRegion, fetchSpacesByOrgs, getCfRegions, getCfCredentials } from './cfLoginService.js';
import { readEffectiveHomepageRaw } from './home/homepageEditService.js';
import { prefillDirsIfEmpty } from './dirsService.js';

const CONFIG_DIR = join(config.LOCAL_STORE_DIR, 'config');
const ORGS_PATH  = join(CONFIG_DIR, 'orgs.json');

export interface SpaceEntry {
  space_id:   string;
  space_name: string;
}

export interface OrgEntry {
  org_id:          string;
  org_name:        string;
  subdomain:       string;
  subaccount_id:   string;
  subaccount_name: string;
  alias:           string;
  directories:     string;
  pos:             number;
  includeInHomepage: boolean;
  manageDestination: boolean;
  manageApps:        boolean;
  spaces:          SpaceEntry[];
}

export interface OrgRegion {
  region: string;
  orgs:   OrgEntry[];
}

interface SaMeta { id: string; dirShort: string; name: string; subdomain: string; hpPos: number; }

/** Build an index of orgId → subaccount metadata from homepage.json. */
function buildSubaccountIndex(): Map<string, SaMeta> {
  const index = new Map<string, SaMeta>();
  try {
    const raw = readEffectiveHomepageRaw();
    if (!raw) return index;
    const hp = JSON.parse(raw) as {
      btp?: {
        globalAccounts?: Array<{
          directories?: Array<{
            short?: string;
            subaccounts?: Array<{ id?: string; name?: string; subdomain?: string; orgId?: string }>;
          }>;
        }>;
      };
    };
    let hpPos = 0;
    for (const ga of hp.btp?.globalAccounts ?? []) {
      for (const dir of ga.directories ?? []) {
        const dirShort = dir.short ?? '';
        for (const sa of dir.subaccounts ?? []) {
          if (sa.orgId && sa.id) {
            index.set(sa.orgId, {
              id:        sa.id,
              dirShort,
              name:      sa.name      ?? '',
              subdomain: sa.subdomain ?? '',
              hpPos:     hpPos,
            });
          }
          hpPos++;
        }
      }
    }
  } catch { /* homepage.json missing or invalid — proceed without subaccount cross-ref */ }
  return index;
}

export async function readOrgs(): Promise<OrgRegion[]> {
  try {
    const raw = await readFile(ORGS_PATH, 'utf-8');
    return JSON.parse(raw) as OrgRegion[];
  } catch { return []; }
}

async function writeOrgs(data: OrgRegion[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(ORGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  notifyCallbacks();
  const ts = Date.now();
  emit('root', { files: ['config/orgs.json'], ts });
  emit('config', { files: ['orgs.json'], ts });
  logger.info({ regions: data.length, total: data.reduce((n, r) => n + r.orgs.length, 0) }, 'orgs.json saved');
}

function mergeOrgs(existing: OrgRegion[], fresh: OrgRegion[]): OrgRegion[] {
  const editableByKey = new Map<string, Pick<OrgEntry, 'alias' | 'directories' | 'pos' | 'subdomain' | 'subaccount_id' | 'includeInHomepage' | 'manageDestination' | 'manageApps'>>();
  for (const r of existing) {
    for (const o of r.orgs) {
      editableByKey.set(`${r.region}/${o.org_id}`, {
        alias:             o.alias,
        directories:       o.directories,
        pos:               o.pos,
        subdomain:         o.subdomain,
        subaccount_id:     o.subaccount_id,
        includeInHomepage: o.includeInHomepage  ?? false,
        manageDestination: o.manageDestination ?? false,
        manageApps:        o.manageApps        ?? false,
      });
    }
  }

  const seenKeys = new Set<string>();
  const merged: OrgRegion[] = fresh.map(r => ({
    region: r.region,
    orgs: r.orgs.map((o, i) => {
      const key = `${r.region}/${o.org_id}`;
      seenKeys.add(key);
      const prev = editableByKey.get(key);
      return prev ? { ...o, ...prev } : { ...o, pos: i };
    }).sort((a, b) => a.pos - b.pos),
  }));

  // Keep orgs from existing that did not appear in fresh (access may be temporarily unavailable)
  for (const r of existing) {
    const orphans = r.orgs.filter(o => !seenKeys.has(`${r.region}/${o.org_id}`));
    if (orphans.length === 0) continue;
    const target = merged.find(m => m.region === r.region);
    if (target) target.orgs.push(...orphans);
    else merged.push({ region: r.region, orgs: orphans });
  }

  return merged;
}

/** Re-fetch orgs from CF API for all configured regions, merge with existing, save, notify. */
export async function refreshOrgs(): Promise<OrgRegion[]> {
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

  const saIndex  = buildSubaccountIndex();
  const existing = await readOrgs();
  const existingKeys = new Set(existing.flatMap(r => r.orgs.map(o => `${r.region}/${o.org_id}`)));

  const freshRegions: OrgRegion[] = [];
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

      const orgs: OrgEntry[] = cfOrgs.map(({ guid, name }, i) => {
        const sa = saIndex.get(guid);
        return {
          org_id:          guid,
          org_name:        name,
          subdomain:       sa?.subdomain ?? '',
          subaccount_id:   sa?.id        ?? '',
          subaccount_name: '',
          alias:           '',
          directories:     '',
          pos:             i,
          includeInHomepage: false,
          manageDestination: false,
          manageApps:        false,
          spaces:          spacesByOrg.get(guid) ?? [],
        };
      });
      freshRegions.push({ region, orgs });
      logger.info({ region, orgs: orgs.length, spaces: [...spacesByOrg.values()].reduce((n, s) => n + s.length, 0) }, 'CF orgs + spaces fetched');
    } catch (err) {
      logger.warn({ region, err }, 'Failed to fetch CF orgs for region — skipping');
    }
  }

  const merged = mergeOrgs(existing, freshRegions);

  // Fill empty editable fields from homepage.json metadata
  for (const r of merged) {
    for (const o of r.orgs) {
      const meta = saIndex.get(o.org_id);
      if (!meta) continue;
      if (!o.alias)          o.alias          = meta.name;
      if (!o.directories)    o.directories    = meta.dirShort;
      if (!o.subdomain)      o.subdomain      = meta.subdomain;
      if (!o.subaccount_id)  o.subaccount_id  = meta.id;
      if (!existingKeys.has(`${r.region}/${o.org_id}`)) o.pos = meta.hpPos;
    }
  }

  await writeOrgs(merged);
  await prefillDirsIfEmpty();
  return merged;
}

/** Save admin-edited orgs (preserves all fields as-is, just persists and notifies). */
export async function saveOrgs(data: OrgRegion[]): Promise<void> {
  await writeOrgs(data);
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
