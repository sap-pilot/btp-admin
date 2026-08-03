import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { touchLastUpdated } from './lastUpdatedService.js';
import { getCfCredentials, getCfRegions, fetchOrgsForRegion, fetchSpacesByOrgs } from './cfLoginService.js';
import { getRestrictedIds } from './configService.js';
import {
  btpLogin, btpListGlobalAccounts, btpListSubaccounts,
  btpListEnvInstances, btpListSubscriptions, btpListServiceInstances, btpListServicePlans,
  type GaInfo,
} from './btpCliService.js';
import { appendConfigChangelog } from './configChangelogService.js';

const CONFIG_DIR        = join(config.LOCAL_STORE_DIR, 'conf');
const SUBACCOUNTS_PATH  = join(CONFIG_DIR, 'subaccounts.json');

export interface SpaceEntry {
  spaceId:   string;
  spaceName: string;
}

export interface ServiceInstanceEntry {
  serviceOfferingName: string;
  servicePlanId:       string;
  instanceName:        string;
  url:                 string;
  spaceId:             string;
}

export interface SubaccountEntry {
  region:                 string;
  globalAccountGUID:      string;
  globalAccountName:      string;
  globalAccountSubdomain: string;
  subdomain:              string;
  subaccountId:       string;
  subaccountName:     string;
  groupIds:           string;
  alias:              string;
  pos:                number;
  inHomepage:         boolean;
  manageDestinations: boolean;
  useAOD:             boolean;
  /** Runtime-only: true when this SA's subaccount ID is in RESTRICTED_SUBACCOUNT_IDS. Never persisted. */
  restricted?:        boolean;
  org?: {
    orgId:   string;
    orgName: string;
    spaces:  SpaceEntry[];
  };
  subscriptions:    { displayName: string; url: string; customerDeveloped: boolean }[];
  serviceInstances: ServiceInstanceEntry[];
}

async function readSubaccountsFile(): Promise<{ subaccounts: SubaccountEntry[]; globalAccounts: GaInfo[] }> {
  try {
    const raw  = await readFile(SUBACCOUNTS_PATH, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) return { subaccounts: data as SubaccountEntry[], globalAccounts: [] };
    const obj = data as { subaccounts?: SubaccountEntry[]; globalAccounts?: GaInfo[] };
    return {
      subaccounts:    Array.isArray(obj.subaccounts)    ? obj.subaccounts    : [],
      globalAccounts: Array.isArray(obj.globalAccounts) ? obj.globalAccounts : [],
    };
  } catch { return { subaccounts: [], globalAccounts: [] }; }
}

export async function readSubaccounts(): Promise<SubaccountEntry[]> {
  const { subaccounts } = await readSubaccountsFile();
  const restricted = getRestrictedIds();
  return subaccounts.map(sa => {
    const base = { ...sa, subdomain: sa.subdomain.toLowerCase() };
    const isRestricted = restricted.has(sa.subaccountId);
    if (isRestricted) {
      return { ...base, manageDestinations: false, useAOD: false, restricted: true };
    }
    return base;
  });
}

async function writeSubaccounts(subaccounts: SubaccountEntry[], globalAccounts?: GaInfo[]): Promise<void> {
  const gas = globalAccounts ?? (await readSubaccountsFile()).globalAccounts;
  // Strip runtime-only field before persisting
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const toSave = subaccounts.map(({ restricted: _r, ...rest }) => rest);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SUBACCOUNTS_PATH, JSON.stringify({ subaccounts: toSave, globalAccounts: gas }, null, 2), 'utf-8');
  touchLastUpdated();
  notifyCallbacks();
  const ts = Date.now();
  emit('root',   { files: ['conf/subaccounts.json'], ts });
  emit('config', { files: ['subaccounts.json'], ts });
  logger.info({ subaccounts: subaccounts.length, globalAccounts: gas.length }, 'subaccounts.json saved');
}

const SA_DIFF_FIELDS = [
  'subaccountName', 'alias', 'groupIds', 'pos', 'subdomain',
  'globalAccountGUID', 'inHomepage', 'manageDestinations', 'useAOD',
] as const;

function diffSubaccounts(before: SubaccountEntry[], after: SubaccountEntry[]): string {
  const beforeMap = new Map<string, SubaccountEntry>();
  const afterMap  = new Map<string, SubaccountEntry>();
  for (const s of before) beforeMap.set(s.subaccountId, s);
  for (const s of after)  afterMap.set(s.subaccountId,  s);

  const lines: string[] = [];
  for (const [id, s] of afterMap)  { if (!beforeMap.has(id)) lines.push(`+ ${id} (${s.subaccountName})`); }
  for (const [id, s] of beforeMap) { if (!afterMap.has(id))  lines.push(`- ${id} (${s.subaccountName})`); }

  for (const [id, bef] of beforeMap) {
    const aft = afterMap.get(id);
    if (!aft) continue;
    const changes: string[] = [];
    for (const f of SA_DIFF_FIELDS) {
      if (String(bef[f]) !== String(aft[f]))
        changes.push(`    ${f}: ${JSON.stringify(bef[f])} → ${JSON.stringify(aft[f])}`);
    }
    if (changes.length) { lines.push(`~ ${id} (${aft.subaccountName})`); lines.push(...changes); }
  }
  return lines.join('\n');
}

function normalizeSubaccountPositions(data: SubaccountEntry[]): SubaccountEntry[] {
  const sorted = [...data].sort((a, b) => {
    const aPosSet = a.pos > 0;
    const bPosSet = b.pos > 0;
    if (aPosSet !== bPosSet) return aPosSet ? -1 : 1;
    if (aPosSet) return a.pos - b.pos;
    return a.groupIds.localeCompare(b.groupIds) || a.subdomain.localeCompare(b.subdomain);
  });
  return sorted.map((s, idx) => ({ ...s, pos: idx + 1 }));
}

function mergeSubaccounts(existing: SubaccountEntry[], fresh: SubaccountEntry[]): SubaccountEntry[] {
  type Editable = Pick<SubaccountEntry, 'alias' | 'groupIds' | 'pos' | 'inHomepage' | 'manageDestinations' | 'useAOD'>;
  const editableById = new Map<string, Editable>();
  for (const s of existing) {
    editableById.set(s.subaccountId, {
      alias:              s.alias,
      groupIds:           s.groupIds,
      pos:                s.pos,
      inHomepage:         s.inHomepage         ?? false,
      manageDestinations: s.manageDestinations ?? false,
      useAOD:             s.useAOD             ?? false,
    });
  }

  const seenIds = new Set<string>();
  const merged: SubaccountEntry[] = fresh.map((s, i) => {
    seenIds.add(s.subaccountId);
    const prev = editableById.get(s.subaccountId);
    return prev ? { ...s, ...prev } : { ...s, pos: i };
  });

  // Keep subaccounts from existing that did not appear in fresh (temporary access loss)
  for (const s of existing) {
    if (!seenIds.has(s.subaccountId)) merged.push(s);
  }
  return merged;
}

let subaccountRefreshRunning = false;

export async function refreshSubaccounts(user = 'system', force = false): Promise<{ data: SubaccountEntry[]; warnings: string[]; skipped?: boolean }> {
  if (subaccountRefreshRunning && !force) {
    logger.info({ user }, 'Subaccount refresh skipped — already running');
    return { data: [], warnings: [], skipped: true };
  }
  if (force) logger.warn({ user }, 'Force subaccount refresh requested');
  else logger.info({ user }, 'Subaccount refresh requested');
  subaccountRefreshRunning = true;
  try {
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

  const warnings: string[] = [];

  // ── BTP account API: login + collect all subaccounts across all global accounts ──
  type SaWithGa = { saRaw: import('./btpCliService.js').SaRaw; gaSubdomain: string };
  let allSas:     SaWithGa[]   = [];
  let sessionId:  string | null = null;
  let fetchedGas: GaInfo[]     = [];

  try {
    sessionId  = await btpLogin(username, password);
    fetchedGas = await btpListGlobalAccounts(sessionId);
    logger.info({ globalAccounts: fetchedGas.length }, 'BTP: global accounts fetched');
    for (const ga of fetchedGas) {
      try {
        const sas = await btpListSubaccounts(sessionId, ga.subdomain);
        for (const saRaw of sas) allSas.push({ saRaw, gaSubdomain: ga.subdomain });
        logger.info({ ga: ga.subdomain, subaccounts: sas.length }, 'BTP: subaccounts fetched');
      } catch (err) {
        logger.warn({ ga: ga.subdomain, err }, 'BTP: failed to list subaccounts for GA — skipping');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'BTP login / GA list failed — proceeding without BTP account data');
    warnings.push(
      'Account discovery failed — subaccount names, subscriptions, and services may be stale. Check CF_USERNAME / CF_PASSWORD.',
    );
  }

  // ── CF API: orgs + spaces (runs in parallel with BTP account API per-SA processing) ──
  const cfOrgMapPromise = (async () => {
    const cfOrgMap = new Map<string, { region: string; orgName: string; spaces: SpaceEntry[] }>();
    for (const region of regions) {
      try {
        const cfOrgs = await fetchOrgsForRegion(region);
        const guids  = cfOrgs.map(o => o.guid);
        let spacesByOrg = new Map<string, Array<{ space_id: string; space_name: string }>>();
        try {
          spacesByOrg = await fetchSpacesByOrgs(region, guids);
        } catch (err) {
          logger.warn({ region, err }, 'CF: failed to fetch spaces — orgs will have empty spaces list');
        }
        for (const { guid, name } of cfOrgs) {
          cfOrgMap.set(guid, {
            region,
            orgName: name,
            spaces:  (spacesByOrg.get(guid) ?? []).map(s => ({ spaceId: s.space_id, spaceName: s.space_name })),
          });
        }
        logger.info({ region, orgs: cfOrgs.length }, 'CF API: orgs + spaces fetched');
      } catch (err) {
        logger.warn({ region, err }, 'CF API: failed to fetch orgs for region — skipping');
      }
    }
    return cfOrgMap;
  })();

  // ── BTP account API: per-subaccount sequential processing ──
  type SaResult = {
    orgInstances:   { orgId: string; orgName: string }[];
    subscriptions:  import('./btpCliService.js').SubscriptionInfo[];
    serviceInstRaw: import('./btpCliService.js').RawServiceInstance[];
    plansMap:       Map<string, string>;
  };
  const saResults = new Map<string, SaResult>();

  if (sessionId) {
    const total = allSas.length;
    for (let i = 0; i < allSas.length; i++) {
      const { saRaw, gaSubdomain } = allSas[i]!;
      emit('refresh-subaccounts', {
        type:    'progress',
        pct:     Math.floor(i * 100 / Math.max(total, 1)),
        message: `Processing ${i + 1} of ${total}: ${saRaw.displayName}`,
      });
      try {
        const envInstances   = await btpListEnvInstances(sessionId, gaSubdomain, saRaw.guid).catch(() => []);
        const subscriptions  = await btpListSubscriptions(sessionId, gaSubdomain, saRaw.guid).catch(() => []);
        const serviceInstRaw = await btpListServiceInstances(sessionId, gaSubdomain, saRaw.guid).catch(() => []);
        const plansMap       = serviceInstRaw.length > 0
          ? await btpListServicePlans(sessionId, gaSubdomain, saRaw.guid).catch(() => new Map<string, string>())
          : new Map<string, string>();
        saResults.set(saRaw.guid, { orgInstances: envInstances, subscriptions, serviceInstRaw, plansMap });
      } catch (err) {
        logger.warn({ sa: saRaw.guid, name: saRaw.displayName, err }, 'BTP per-SA processing failed — skipping');
        saResults.set(saRaw.guid, { orgInstances: [], subscriptions: [], serviceInstRaw: [], plansMap: new Map() });
      }
    }
  }

  // ── Await CF API result ──
  const cfOrgMap = await cfOrgMapPromise;

  // ── Build fresh SubaccountEntry[] ──
  const gaMap = new Map(fetchedGas.map(ga => [ga.guid, ga]));

  const fresh: SubaccountEntry[] = [];
  for (const { saRaw } of allSas) {
    const result    = saResults.get(saRaw.guid);
    const firstOrg  = result?.orgInstances[0];
    const cfOrg     = firstOrg ? cfOrgMap.get(firstOrg.orgId) : undefined;

    const serviceInstances: ServiceInstanceEntry[] = (result?.serviceInstRaw ?? []).map(inst => ({
      serviceOfferingName: result?.plansMap.get(inst.service_plan_id) ?? '',
      servicePlanId:       inst.service_plan_id,
      instanceName:        inst.name,
      url:                 inst.dashboard_url,
      spaceId:             inst.spaceId,
    }));

    fresh.push({
      region:             cfOrg?.region  ?? saRaw.region,
      globalAccountGUID:      saRaw.globalAccountGUID,
      globalAccountName:      gaMap.get(saRaw.globalAccountGUID)?.displayName ?? '',
      globalAccountSubdomain: gaMap.get(saRaw.globalAccountGUID)?.subdomain   ?? '',
      subdomain:              saRaw.subdomain,
      subaccountId:       saRaw.guid,
      subaccountName:     saRaw.displayName,
      groupIds:           '',
      alias:              '',
      pos:                0,
      inHomepage:         false,
      manageDestinations: false,
      useAOD:             false,
      org: cfOrg && firstOrg ? {
        orgId:   firstOrg.orgId,
        orgName: cfOrg.orgName,
        spaces:  cfOrg.spaces,
      } : undefined,
      subscriptions:    result?.subscriptions  ?? [],
      serviceInstances,
    });
  }

  // ── Merge with existing, normalize positions, persist ──
  const existing   = await readSubaccounts();
  const merged     = mergeSubaccounts(existing, fresh);
  const normalized = normalizeSubaccountPositions(merged);
  const diff       = diffSubaccounts(existing, normalized);
  await writeSubaccounts(normalized, fetchedGas.length > 0 ? fetchedGas : undefined);
  await appendConfigChangelog('Refresh', user, 'subaccounts.json', diff);

  emit('refresh-subaccounts', { type: 'progress', pct: 100, message: 'Done' });
  logger.info({ subaccounts: normalized.length, warnings: warnings.length }, 'Subaccounts refresh complete');
  return { data: normalized, warnings };
  } finally {
    subaccountRefreshRunning = false;
  }
}

export async function saveSubaccounts(data: SubaccountEntry[], user = 'system'): Promise<void> {
  const before = await readSubaccounts();
  const diff   = diffSubaccounts(before, data);
  await writeSubaccounts(data);
  await appendConfigChangelog('Update', user, 'subaccounts.json', diff);
}

export async function subaccountsFileExists(): Promise<boolean> {
  try { await access(SUBACCOUNTS_PATH); return true; } catch { return false; }
}

export async function importSubaccounts(data: SubaccountEntry[], user: string): Promise<void> {
  const existing   = await readSubaccounts();
  const normalized = normalizeSubaccountPositions(data);
  const diff       = diffSubaccounts(existing, normalized);
  await writeSubaccounts(normalized);
  await appendConfigChangelog('Import', user, 'subaccounts.json', diff);
}

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

