import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getOrRefreshToken, fetchWithRateLimit } from './cfLoginService.js';
import { getRestrictedIds, getAutoSubaccountRefreshMs } from './configService.js';
import { readSubaccounts, type SubaccountEntry } from './subaccountsService.js';
import { notifyCallbacks, registerOnRcsChangelogSynced } from './syncService.js';
import { emit, emitImmediate } from './liveEvents.js';

const BA_DIR       = join(homedir(), '.ba');
const KEYS_PATH    = join(BA_DIR, 'xsuaa-keys.json');
const TOKENS_PATH  = join(BA_DIR, 'xsuaa-tokens.json');
const LOCAL_RC_DIR = join(config.LOCAL_STORE_DIR, 'rcs');

const MAX_CHANGELOG_SIZE = 2 * 1024 * 1024; // 2 MB

const lastRefreshTs = new Map<string, number>();
let globalRcsRefreshTs: number | null = null;
let globalRcsRefreshRunning = false;

// Overview cache: `${region}/${subdomain}` → full RcSummary[] for that subaccount.
// Populated on first listRoleCollections() call per subaccount; individual keys are
// deleted on subaccount-level refresh or mutation; cleared entirely on global refresh.
const rcOverviewCache = new Map<string, RcSummary[]>();

export function getGlobalRcsRefreshTs(): number | null { return globalRcsRefreshTs; }

// ─── Filename helpers ─────────────────────────────────────────────────────────

/** Encode RC name → safe filename stem (only encodes filesystem-unsafe chars). */
function rcFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Decode filename stem → original RC name. */
function rcFilenameToName(stem: string): string {
  return stem
    .replace(/\.changelog\.md$/, '')
    .replace(/\.users\.json$/, '')
    .replace(/\.users$/, '')
    .replace(/\.json$/, '')
    .replace(/%([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ─── XSUAA types ──────────────────────────────────────────────────────────────

interface XsuaaCredentials {
  apiurl:       string;  // XSUAA API base URL (for role collection calls)
  url:          string;  // OAuth token URL
  clientid:     string;
  clientsecret: string;
  [k: string]: unknown;
}

interface XsuaaKeyEntry {
  orgName:    string;
  instanceId: string;
  instanceName: string;
  credential: XsuaaCredentials;
}

// { [region]: { [orgId]: XsuaaKeyEntry } }
type XsuaaKeyStore = Record<string, Record<string, XsuaaKeyEntry>>;

interface XsuaaTokenEntry {
  token:     string;
  expiresAt: number;
  tokenUrl:  string;
}

// { [region]: { [orgId]: XsuaaTokenEntry } }
type XsuaaTokenStore = Record<string, Record<string, XsuaaTokenEntry>>;

// ─── RC data types ────────────────────────────────────────────────────────────

export interface RoleReference {
  roleTemplateAppId: string;
  roleTemplateName:  string;
  name:              string;
  description:       string;
}

export interface GroupReference {
  idpDisplayName:     string;
  roleCollectionName: string;
  samlAttrName:       string;
  samlAttributeValue: string;
}

export interface UserReference {
  id:       string;
  userName: string;
  email:    string;
  origin:   string;
}

export interface RoleCollection {
  name:            string;
  description:     string;
  isReadOnly:      boolean;
  roleReferences:  RoleReference[];
  groupReferences: GroupReference[];
}

export interface RcChange {
  region:    string;
  subdomain: string;
  name:      string;
  action:    'created' | 'updated' | 'deleted';
  usersChanged?: boolean;
}

// ─── Key/token store helpers ──────────────────────────────────────────────────

async function loadXsuaaKeyStore(): Promise<XsuaaKeyStore> {
  try { return JSON.parse(await readFile(KEYS_PATH, 'utf-8')) as XsuaaKeyStore; }
  catch { return {}; }
}

async function saveXsuaaKeyStore(store: XsuaaKeyStore): Promise<void> {
  await mkdir(BA_DIR, { recursive: true });
  await writeFile(KEYS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

async function loadXsuaaTokenStore(): Promise<XsuaaTokenStore> {
  try { return JSON.parse(await readFile(TOKENS_PATH, 'utf-8')) as XsuaaTokenStore; }
  catch { return {}; }
}

async function saveXsuaaTokenStore(store: XsuaaTokenStore): Promise<void> {
  await mkdir(BA_DIR, { recursive: true });
  await writeFile(TOKENS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

// ─── CF API helpers ───────────────────────────────────────────────────────────

async function cfGet(region: string, path: string): Promise<unknown> {
  const token      = await getOrRefreshToken(region);
  const url        = `${token.api_url}${path}`;
  const reqHeaders = { Authorization: `${token.token_type} ${token.access_token}` };
  const t0         = Date.now();
  const res        = await fetchWithRateLimit(() => fetch(url, { headers: reqHeaders }), url);
  logger.debug({ method: 'GET', url, durationMs: Date.now() - t0, status: res.status }, 'CF v3 API call (rcs)');
  if (!res.ok) throw new Error(`CF GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function cfGetAllPages(region: string, path: string): Promise<unknown[]> {
  const sep = path.includes('?') ? '&' : '?';
  let url = `${path}${sep}per_page=5000`;
  const results: unknown[] = [];
  while (url) {
    const data = await cfGet(region, url) as { resources?: unknown[]; pagination?: { next?: { href?: string } } };
    results.push(...(data.resources ?? []));
    const nextHref = data.pagination?.next?.href;
    if (!nextHref) break;
    const parsed = new URL(nextHref);
    url = parsed.pathname + parsed.search;
  }
  return results;
}

async function discoverXsuaaKey(region: string, orgId: string, orgName: string, spaceIds: string[]): Promise<XsuaaKeyEntry> {
  // Find the xsuaa/apiaccess service plan GUID
  const plans = await cfGetAllPages(region, '/v3/service_plans?service_offering_names=xsuaa') as Array<{
    guid: string; name: string;
  }>;
  const apiaccessPlan = plans.find(p => p.name === 'apiaccess');
  if (!apiaccessPlan) throw new Error(`xsuaa/apiaccess service plan not found in region ${region}`);

  // Fetch all instances for that plan and match by space
  const allInstances = await cfGetAllPages(region,
    `/v3/service_instances?service_plan_guids=${apiaccessPlan.guid}`,
  ) as Array<{ guid: string; name: string; relationships: { space: { data: { guid: string } } } }>;

  const spaceSet = new Set(spaceIds);
  const inst = allInstances.find(i => spaceSet.has(i.relationships.space.data.guid));
  if (!inst) throw new Error(`No xsuaa/apiaccess instance found for org ${orgId} (region ${region}) in spaces [${spaceIds.join(', ')}]`);

  const keys = await cfGetAllPages(region,
    `/v3/service_credential_bindings?service_instance_guids=${inst.guid}&type=key`,
  ) as Array<{ guid: string; name: string }>;

  if (keys.length === 0) throw new Error(`No service key for xsuaa instance ${inst.name} in org ${orgId}`);
  const key = keys[0]!;

  const details = await cfGet(region, `/v3/service_credential_bindings/${key.guid}/details`) as {
    credentials?: Record<string, unknown>;
  };
  const cred = details.credentials ?? {};
  const uaa  = (cred.uaa as Record<string, unknown> | undefined) ?? {};
  const apiurl       = String(cred.apiurl       ?? uaa['apiurl']     ?? '');
  const url          = String(cred.url          ?? uaa.url           ?? '');
  const clientid     = String(cred.clientid     ?? uaa.clientid      ?? '');
  const clientsecret = String(cred.clientsecret ?? uaa.clientsecret  ?? '');
  if (!url || !clientid || !clientsecret) throw new Error(`Incomplete XSUAA credentials for key ${key.guid}`);

  logger.info({ region, orgId, instanceId: inst.guid, keyId: key.guid }, 'XSUAA service key acquired via CF API');
  return { orgName, instanceId: inst.guid, instanceName: inst.name, credential: { ...cred, apiurl, url, clientid, clientsecret } };
}

async function acquireXsuaaToken(credential: XsuaaCredentials): Promise<XsuaaTokenEntry> {
  const tokenUrl = `${credential.url}/oauth/token`;
  const basic    = Buffer.from(`${credential.clientid}:${credential.clientsecret}`).toString('base64');
  const res      = await fetchWithRateLimit(() => fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body:    'grant_type=client_credentials',
  }), tokenUrl);
  logger.debug({ tokenUrl, status: res.status }, 'XSUAA OAuth token call');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`XSUAA OAuth → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; expires_in?: number };
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 1800;
  return { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000, tokenUrl };
}

async function resolveXsuaaToken(
  region:     string,
  orgId:      string,
  orgName:    string,
  spaceIds:   string[],
  keyStore:   XsuaaKeyStore,
  tokenStore: XsuaaTokenStore,
  cfLoginFailed: Set<string>,
): Promise<{ token: string; credential: XsuaaCredentials } | { error: string }> {
  const existing = tokenStore[region]?.[orgId];
  const keyEntry = keyStore[region]?.[orgId];

  // 1. Valid cached token
  if (existing && existing.expiresAt - Date.now() > 60_000) {
    if (keyEntry) return { token: existing.token, credential: keyEntry.credential };
  }

  // 2. Re-acquire with existing key
  if (keyEntry) {
    try {
      const tok = await acquireXsuaaToken(keyEntry.credential);
      if (!tokenStore[region]) tokenStore[region] = {};
      tokenStore[region]![orgId] = tok;
      return { token: tok.token, credential: keyEntry.credential };
    } catch (err) {
      logger.debug({ region, orgId, err }, 'XSUAA token from existing key failed — re-discovering');
    }
  }

  // 3. Discover key via CF API
  if (cfLoginFailed.has(region)) return { error: `CF login failed for region ${region}` };

  try {
    const entry = await discoverXsuaaKey(region, orgId, orgName, spaceIds);
    if (!keyStore[region]) keyStore[region] = {};
    keyStore[region]![orgId] = entry;
    const tok = await acquireXsuaaToken(entry.credential);
    if (!tokenStore[region]) tokenStore[region] = {};
    tokenStore[region]![orgId] = tok;
    return { token: tok.token, credential: entry.credential };
  } catch (err) {
    return { error: `XSUAA key/token discovery failed for ${region}/${orgId}: ${String(err)}` };
  }
}

// ─── XSUAA API call with 401 retry cascade ────────────────────────────────────

async function withXsuaaApiRetry<T>(
  region:     string,
  orgId:      string,
  orgName:    string,
  spaceIds:   string[],
  keyStore:   XsuaaKeyStore,
  tokenStore: XsuaaTokenStore,
  cfFailed:   Set<string>,
  auth:       { token: string; credential: XsuaaCredentials },
  call:       (token: string, credential: XsuaaCredentials) => Promise<T>,
): Promise<T> {
  try {
    return await call(auth.token, auth.credential);
  } catch (err) {
    if (!String(err).includes('HTTP 401')) throw err;

    // Retry 1: invalidate cached token, re-acquire using existing service key
    logger.info({ region, orgId }, 'XSUAA API 401 — re-acquiring token via existing service key');
    if (tokenStore[region]) delete tokenStore[region][orgId];
    const auth2 = await resolveXsuaaToken(region, orgId, orgName, spaceIds, keyStore, tokenStore, cfFailed);
    if ('error' in auth2) throw new Error(auth2.error);

    try {
      return await call(auth2.token, auth2.credential);
    } catch (err2) {
      if (!String(err2).includes('HTTP 401')) throw err2;

      // Retry 2: also invalidate service key, re-discover via CF API
      logger.info({ region, orgId }, 'XSUAA API 401 again — re-discovering service key via CF API');
      if (keyStore[region]) delete keyStore[region][orgId];
      if (tokenStore[region]) delete tokenStore[region][orgId];
      const auth3 = await resolveXsuaaToken(region, orgId, orgName, spaceIds, keyStore, tokenStore, cfFailed);
      if ('error' in auth3) throw new Error(auth3.error);
      return await call(auth3.token, auth3.credential);
    }
  }
}

// ─── XSUAA Role Collections API ───────────────────────────────────────────────

function normalizeUserRef(u: Record<string, string>): UserReference {
  return {
    id:       u['id']       ?? '',
    userName: u['userName'] ?? u['username'] ?? '',
    email:    u['email']    ?? '',
    origin:   u['origin']   ?? '',
  };
}

async function fetchRoleCollectionsFromApi(
  baseUrl: string,
  token:   string,
): Promise<Array<RoleCollection & { userReferences: UserReference[] }>> {
  const url = `${baseUrl}/sap/rest/authorization/v2/rolecollections?showGroups=true&showRoles=true&showUsers=true`;
  const res = await fetchWithRateLimit(() => fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }), url);
  logger.debug({ url, status: res.status }, 'XSUAA role collections API call');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`XSUAA role collections → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as unknown;
  const arr  = Array.isArray(data) ? data : ((data as Record<string, unknown>).roleCollections as unknown[] ?? []);
  return (arr as Array<Record<string, unknown>>).map(rc => ({
    ...rc,
    userReferences: ((rc['userReferences'] ?? []) as Array<Record<string, string>>).map(normalizeUserRef),
  })) as Array<RoleCollection & { userReferences: UserReference[] }>;
}

export async function addUserToRoleCollection(
  baseUrl:            string,
  token:              string,
  roleCollectionName: string,
  user:               UserReference,
): Promise<void> {
  const enc = encodeURIComponent;
  const url = `${baseUrl}/sap/rest/authorization/v2/rolecollections/${enc(roleCollectionName)}/users`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([user]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Add user → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function removeUserFromRoleCollection(
  baseUrl:            string,
  token:              string,
  roleCollectionName: string,
  userId:             string,
  origin:             string,
): Promise<void> {
  const enc = encodeURIComponent;
  const url = `${baseUrl}/sap/rest/authorization/v2/rolecollections/${enc(roleCollectionName)}/users/${enc(userId)}?origin=${enc(origin)}`;
  const res = await fetch(url, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Remove user → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Diff helpers ─────────────────────────────────────────────────────────────

function diffObjects(prev: Record<string, unknown>, next: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const pv = JSON.stringify(prev[k] ?? null);
    const nv = JSON.stringify(next[k] ?? null);
    if (pv !== nv) lines.push(`- ${k}: ${pv} → ${nv}`);
  }
  return lines.join('\n');
}

function diffUsers(prev: UserReference[], next: UserReference[]): string {
  const prevIds = new Map(prev.map(u => [u.id || u.email, u]));
  const nextIds = new Map(next.map(u => [u.id || u.email, u]));
  const lines: string[] = [];
  for (const [id, u] of nextIds) { if (!prevIds.has(id)) lines.push(`+ ${u.email || u.userName || id} (${u.origin})`); }
  for (const [id, u] of prevIds) { if (!nextIds.has(id)) lines.push(`- ${u.email || u.userName || id} (${u.origin})`); }
  return lines.join('\n');
}

function utcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function rotationTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(-2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

type PersistResult = 'created' | 'updated' | 'unchanged';

async function persistRC(
  rcDir:    string,
  safeName: string,
  rc:       RoleCollection,
  users:    UserReference[],
  username: string,
  mode:     'auto' | 'manual',
): Promise<PersistResult> {
  await mkdir(rcDir, { recursive: true });
  const rcPath        = join(rcDir, `${safeName}.json`);
  const usersPath     = join(rcDir, `${safeName}.users.json`);
  const changelogPath = join(rcDir, `${safeName}.changelog.md`);

  const rcJson    = JSON.stringify(rc, null, 2);
  const usersJson = JSON.stringify(users, null, 2);

  const rcExists    = existsSync(rcPath);
  const usersExist  = existsSync(usersPath);

  let rcDiff     = '';
  let usersDiff  = '';
  let wasCreated = false;

  if (rcExists) {
    const existingRc = JSON.parse(await readFile(rcPath, 'utf-8')) as Record<string, unknown>;
    rcDiff = diffObjects(existingRc, rc as unknown as Record<string, unknown>);
  } else {
    wasCreated = true;
  }

  if (usersExist) {
    const existingUsers = JSON.parse(await readFile(usersPath, 'utf-8')) as UserReference[];
    usersDiff = diffUsers(existingUsers, users);
  }

  const hasChange = wasCreated || !!rcDiff || !!usersDiff;
  if (!hasChange) return 'unchanged';

  const ts      = utcTimestamp();
  const label   = mode === 'auto' ? 'Auto' : 'Manual';
  const heading = `## [${label}] refresh by <${username}> at ${ts}`;
  const parts: string[] = [heading];
  if (rcDiff)    parts.push(rcDiff);
  if (usersDiff) parts.push('Users:\n' + usersDiff);
  const entry = parts.join('\n') + '\n\n';

  const prevChangelog = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prevChangelog, 'utf-8');
  await writeFile(rcPath,    rcJson,    'utf-8');
  await writeFile(usersPath, usersJson, 'utf-8');

  return wasCreated ? 'created' : 'updated';
}

// ─── Global changelog ─────────────────────────────────────────────────────────

const GLOBAL_CHANGELOG_PATH = join(LOCAL_RC_DIR, 'changelog.md');

async function rotateGlobalChangelogIfNeeded(): Promise<void> {
  try {
    const info = await stat(GLOBAL_CHANGELOG_PATH);
    if (info.size > MAX_CHANGELOG_SIZE) {
      const ts = rotationTimestamp();
      await rename(GLOBAL_CHANGELOG_PATH, join(LOCAL_RC_DIR, `changelog.${ts}.md`));
      logger.info({ ts }, 'rcs global changelog rotated');
    }
  } catch { /* file doesn't exist yet */ }
}

async function appendGlobalChangelog(
  mode:      'auto' | 'manual',
  username:  string,
  refreshed: number,
  total:     number,
  received:  number,
  created:   number,
  updated:   number,
  deleted:   number,
  changes:   RcChange[],
): Promise<void> {
  await mkdir(LOCAL_RC_DIR, { recursive: true });
  await rotateGlobalChangelogIfNeeded();

  const label   = mode === 'auto' ? 'Auto' : 'Manual';
  const ts      = utcTimestamp();
  const header  = `## [${label}] global refresh by <${username}> at ${ts}`;
  const summary = `Refreshed ${refreshed}/${total} subaccounts, received ${received} role collections, created ${created}, updated ${updated} and deleted ${deleted} locally`;

  const changeLines = changes.map(c => {
    const histLink = `/role-collections/${c.region}/${c.subdomain}/${encodeURIComponent(c.name)}/history`;
    const suffix   = c.usersChanged ? ' → Users' : '';
    return `- ${c.action}: ${c.region}.${c.subdomain} → ${c.name}${suffix} ([History](${histLink}))`;
  });

  const existing = await readGlobalChangelog();
  const entry    = [header, '', summary, ...changeLines, '', ''].join('\n');
  await writeFile(GLOBAL_CHANGELOG_PATH, entry + existing, 'utf-8');
  notifyCallbacks();
  const now = Date.now();
  emit('root',       { files: ['rcs/changelog.md'], ts: now });
  emit('rcs',        { files: ['changelog.md'], ts: now });
}

export async function readGlobalChangelog(): Promise<string> {
  try { return await readFile(GLOBAL_CHANGELOG_PATH, 'utf-8'); }
  catch { return ''; }
}

export async function listArchivedRcsChangelogs(): Promise<string[]> {
  try {
    const files = await readdir(LOCAL_RC_DIR);
    return files
      .filter(f => /^changelog\.\d{12}\.md$/.test(f))
      .sort()
      .reverse();
  } catch { return []; }
}

export async function readArchivedRcsChangelog(filename: string): Promise<string> {
  if (!/^changelog\.\d{12}\.md$/.test(filename)) return '';
  try { return await readFile(join(LOCAL_RC_DIR, filename), 'utf-8'); }
  catch { return ''; }
}

export async function getGlobalRcsChangelog(): Promise<{ data: string; archivedFiles: string[] }> {
  const [data, archivedFiles] = await Promise.all([readGlobalChangelog(), listArchivedRcsChangelogs()]);
  return { data, archivedFiles };
}

export async function getGlobalRcsChangelogFile(filename: string): Promise<string> {
  return readArchivedRcsChangelog(filename);
}

export async function searchGlobalRcsChangelogs(query: string): Promise<{ files: string[]; matchCount: number }> {
  if (!query.trim()) return { files: [], matchCount: 0 };
  const lq = query.toLowerCase();
  const allFiles = ['', ...await listArchivedRcsChangelogs()];
  const matched: string[] = [];
  let total = 0;
  for (const f of allFiles) {
    const text  = f === '' ? await readGlobalChangelog() : await readArchivedRcsChangelog(f);
    const count = text.toLowerCase().split(lq).length - 1;
    if (count > 0) { matched.push(f); total += count; }
  }
  return { files: matched, matchCount: total };
}

export async function searchRoleCollections(query: string): Promise<{ matches: Record<string, string[]> }> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return { matches: {} };

  const matches: Record<string, string[]> = {};
  const regions = await readdir(LOCAL_RC_DIR).catch(() => [] as string[]);

  await Promise.all(regions.map(async region => {
    const regionDir  = join(LOCAL_RC_DIR, region);
    const subdomains = await readdir(regionDir).catch(() => [] as string[]);

    await Promise.all(subdomains.map(async subdomain => {
      const subDir = join(LOCAL_RC_DIR, region, subdomain);
      const files  = await readdir(subDir).catch(() => [] as string[]);
      const rcFiles = files.filter(f => f.endsWith('.json') && !f.endsWith('.users.json'));

      const found: string[] = [];
      await Promise.all(rcFiles.map(async f => {
        try {
          const text = await readFile(join(subDir, f), 'utf-8');
          if (text.toLowerCase().includes(q)) found.push(rcFilenameToName(f));
        } catch { /* skip unreadable */ }
      }));

      if (found.length > 0) matches[`${region}/${subdomain}`] = found;
    }));
  }));

  return { matches };
}

// ─── Local data readers ───────────────────────────────────────────────────────

export async function listSubaccountRCNames(region: string, subdomain: string): Promise<string[]> {
  const dir = join(LOCAL_RC_DIR, region, subdomain);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter(f => f.endsWith('.json') && !f.endsWith('.users.json'))
    .map(f => rcFilenameToName(f))
    .sort();
}

export interface RcSummary { name: string; userCount: number }

export async function listRoleCollections(): Promise<Record<string, RcSummary[]>> {
  const result: Record<string, RcSummary[]> = {};
  const sas = (await readSubaccounts()).filter(sa => sa.manageRoles);
  await Promise.all(sas.map(async sa => {
    const key    = `${sa.region}/${sa.subdomain}`;
    const cached = rcOverviewCache.get(key);
    if (cached !== undefined) { result[key] = cached; return; }
    const dir  = join(LOCAL_RC_DIR, sa.region, sa.subdomain);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const rcFiles = entries.filter(f => f.endsWith('.json') && !f.endsWith('.users.json'));
    const summaries = await Promise.all(rcFiles.map(async f => {
      const safeName = f.slice(0, -5);
      const name     = rcFilenameToName(safeName);
      let userCount  = 0;
      try {
        const content = await readFile(join(dir, `${safeName}.users.json`), 'utf-8');
        const lines   = content.split('\n').length;
        userCount     = Math.max(0, Math.round((lines - 2) / 9));
      } catch { /* no users file */ }
      return { name, userCount };
    }));
    const sorted = summaries.sort((a, b) => a.name.localeCompare(b.name));
    rcOverviewCache.set(key, sorted);
    result[key] = sorted;
  }));
  return result;
}

export async function getRoleCollection(
  region: string, subdomain: string, name: string,
): Promise<{ rc: RoleCollection; sensitiveFields: string[] } | null> {
  const path = join(LOCAL_RC_DIR, region, subdomain, `${rcFilename(name)}.json`);
  try {
    const rc = JSON.parse(await readFile(path, 'utf-8')) as RoleCollection;
    return { rc, sensitiveFields: [] };
  } catch { return null; }
}

export async function getRCUsers(region: string, subdomain: string, name: string): Promise<UserReference[]> {
  const path = join(LOCAL_RC_DIR, region, subdomain, `${rcFilename(name)}.users.json`);
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Array<Record<string, string>>;
    return raw.map(normalizeUserRef);
  }
  catch { return []; }
}

export async function getRCChangelog(region: string, subdomain: string, name: string): Promise<string> {
  const path = join(LOCAL_RC_DIR, region, subdomain, `${rcFilename(name)}.changelog.md`);
  try { return await readFile(path, 'utf-8'); }
  catch { return ''; }
}

export async function saveRCToLocal(
  region:    string,
  subdomain: string,
  name:      string,
  rc:        RoleCollection,
  users:     UserReference[],
  username:  string,
): Promise<void> {
  const rcDir = join(LOCAL_RC_DIR, region, subdomain);
  await persistRC(rcDir, rcFilename(name), rc, users, username, 'manual');
  rcOverviewCache.delete(`${region}/${subdomain}`);
  const now = Date.now();
  emit('rcs', { files: [`${region}/${subdomain}/${rcFilename(name)}.json`], ts: now });
}

// ─── Subaccount-level refresh ─────────────────────────────────────────────────

export async function refreshSubaccountRoleCollections(
  region:    string,
  subdomain: string,
  username:  string,
  mode:      'auto' | 'manual',
): Promise<{ received: number; created: number; updated: number; deleted: number; errors: string[] }> {
  const sas = await readSubaccounts();
  const sa  = sas.find(s => s.region === region && s.subdomain === subdomain && s.manageRoles);
  if (!sa) return { received: 0, created: 0, updated: 0, deleted: 0, errors: [`No managed-rcs subaccount found for ${region}/${subdomain}`] };

  const orgId   = sa.org?.orgId ?? '';
  const orgName = sa.org?.orgName ?? '';
  const loc     = `${region}/${subdomain}`;

  if (!orgId) return { received: 0, created: 0, updated: 0, deleted: 0, errors: [`${loc}: no org — cannot access XSUAA`] };

  const keyStore   = await loadXsuaaKeyStore();
  const tokenStore = await loadXsuaaTokenStore();
  const cfFailed   = new Set<string>();

  const spaceIds = sa.org?.spaces?.map(s => s.spaceId) ?? [];
  const auth = await resolveXsuaaToken(region, orgId, orgName, spaceIds, keyStore, tokenStore, cfFailed);
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);

  if ('error' in auth) return { received: 0, created: 0, updated: 0, deleted: 0, errors: [auth.error] };

  const rcDir = join(LOCAL_RC_DIR, region, subdomain);

  let rcs: Array<RoleCollection & { userReferences: UserReference[] }>;
  try {
    rcs = await withXsuaaApiRetry(region, orgId, orgName, spaceIds, keyStore, tokenStore, cfFailed, auth,
      (tok, cred) => fetchRoleCollectionsFromApi(cred.apiurl || cred.url, tok));
  } catch (err) {
    void saveXsuaaKeyStore(keyStore).catch(() => {});
    void saveXsuaaTokenStore(tokenStore).catch(() => {});
    return { received: 0, created: 0, updated: 0, deleted: 0, errors: [String(err)] };
  }
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);

  const errors:  string[]  = [];
  const changes: RcChange[] = [];
  let created = 0, updated = 0, deleted = 0;

  const apiNames = new Set<string>();
  for (const raw of rcs) {
    const { userReferences, ...rc } = raw;
    const safeName = rcFilename(rc.name);
    apiNames.add(safeName);
    try {
      const result = await persistRC(rcDir, safeName, rc, userReferences ?? [], username, mode);
      if (result === 'created') { created++; changes.push({ region, subdomain, name: rc.name, action: 'created' }); }
      else if (result === 'updated') { updated++; changes.push({ region, subdomain, name: rc.name, action: 'updated', usersChanged: true }); }
    } catch (err) {
      errors.push(`${loc}/${rc.name}: ${String(err)}`);
    }
  }

  // Mark deleted — rename .json files not in API response to .deleted.json
  const existingFiles = await readdir(rcDir).catch(() => [] as string[]);
  for (const f of existingFiles) {
    if (!f.endsWith('.json') || f.endsWith('.users.json') || f.endsWith('.deleted.json')) continue;
    const safeName = f.slice(0, -5);
    if (!apiNames.has(safeName)) {
      await rename(join(rcDir, f), join(rcDir, `${safeName}.deleted.json`)).catch(() => {});
      deleted++;
      changes.push({ region, subdomain, name: rcFilenameToName(safeName), action: 'deleted' });
    }
  }

  const now = Date.now();
  lastRefreshTs.set(`${region}/${subdomain}`, now);
  rcOverviewCache.delete(`${region}/${subdomain}`);
  emit('rcs', { files: [`${region}/${subdomain}`], ts: now });

  return { received: rcs.length, created, updated, deleted, errors };
}

// ─── Global refresh ───────────────────────────────────────────────────────────

export async function refreshRoleCollections(
  username: string,
  mode:     'auto' | 'manual',
  force     = false,
): Promise<{ refreshed: number; received: number; created: number; updated: number; deleted: number; errors: string[]; skipped?: boolean }> {
  if (globalRcsRefreshRunning && !force) {
    logger.info({ username }, 'RCS global refresh skipped — already running');
    return { refreshed: 0, received: 0, created: 0, updated: 0, deleted: 0, errors: [], skipped: true };
  }
  if (force) logger.warn({ username }, 'Force RCS global refresh');
  else       logger.info({ username }, 'RCS global refresh starting');

  globalRcsRefreshRunning = true;
  try {
    const allSas    = await readSubaccounts();
    const targetSas = allSas.filter(sa => sa.manageRoles && !sa.restricted);
    const total     = targetSas.length;

    if (total === 0) {
      emitImmediate('refresh-rcs', { type: 'done', scope: 'global', refreshed: 0, total: 0, received: 0, created: 0, updated: 0, deleted: 0, issues: [] });
      return { refreshed: 0, received: 0, created: 0, updated: 0, deleted: 0, errors: [] };
    }

    const keyStore   = await loadXsuaaKeyStore();
    const tokenStore = await loadXsuaaTokenStore();
    const cfFailed   = new Set<string>();

    const allChanges: RcChange[] = [];
    const issues: string[] = [];
    let refreshed = 0, received = 0, created = 0, updated = 0, deleted = 0;

    emit('refresh-rcs', { type: 'progress', scope: 'global', current: 0, total, name: 'Initializing…', received: 0 });

    for (let idx = 0; idx < targetSas.length; idx++) {
      const sa      = targetSas[idx]!;
      const loc     = `${sa.region}/${sa.subdomain}`;
      const saLabel = sa.alias || sa.subaccountName || sa.subdomain;

      emit('refresh-rcs', { type: 'progress', scope: 'global', current: idx + 1, total, name: saLabel, received });

      if (!sa.org?.orgId) {
        const msg = `${loc}: no org — cannot access XSUAA`;
        issues.push(msg);
        logger.warn({ loc }, msg);
        continue;
      }

      const saSpaceIds = sa.org?.spaces?.map(s => s.spaceId) ?? [];
      const auth = await resolveXsuaaToken(sa.region, sa.org.orgId, sa.org.orgName, saSpaceIds, keyStore, tokenStore, cfFailed);
      if ('error' in auth) { issues.push(`${loc}: ${auth.error}`); continue; }

      const rcDir = join(LOCAL_RC_DIR, sa.region, sa.subdomain);

      let rcs: Array<RoleCollection & { userReferences: UserReference[] }>;
      try {
        rcs = await withXsuaaApiRetry(sa.region, sa.org.orgId, sa.org.orgName, saSpaceIds, keyStore, tokenStore, cfFailed, auth,
          (tok, cred) => fetchRoleCollectionsFromApi(cred.apiurl || cred.url, tok));
      } catch (err) {
        issues.push(`${loc}: ${String(err)}`);
        continue;
      }

      received += rcs.length;
      const apiNames = new Set<string>();

      for (const raw of rcs) {
        const { userReferences, ...rc } = raw;
        const safeName = rcFilename(rc.name);
        apiNames.add(safeName);
        try {
          const result = await persistRC(rcDir, safeName, rc, userReferences ?? [], username, mode);
          if (result === 'created') { created++; allChanges.push({ region: sa.region, subdomain: sa.subdomain, name: rc.name, action: 'created' }); }
          else if (result === 'updated') { updated++; allChanges.push({ region: sa.region, subdomain: sa.subdomain, name: rc.name, action: 'updated', usersChanged: true }); }
        } catch (err) {
          issues.push(`${loc}/${rc.name}: ${String(err)}`);
        }
      }

      // Deletions
      const existing = await readdir(rcDir).catch(() => [] as string[]);
      for (const f of existing) {
        if (!f.endsWith('.json') || f.endsWith('.users.json') || f.endsWith('.deleted.json')) continue;
        const safeName = f.slice(0, -5);
        if (!apiNames.has(safeName)) {
          await rename(join(rcDir, f), join(rcDir, `${safeName}.deleted.json`)).catch(() => {});
          deleted++;
          allChanges.push({ region: sa.region, subdomain: sa.subdomain, name: rcFilenameToName(safeName), action: 'deleted' });
        }
      }

      refreshed++;
    }

    await saveXsuaaKeyStore(keyStore);
    await saveXsuaaTokenStore(tokenStore);

    emitImmediate('refresh-rcs', {
      type: 'done', scope: 'global',
      refreshed, total, received, created, updated, deleted, issues,
    });

    if (allChanges.length > 0 || refreshed > 0) {
      await appendGlobalChangelog(mode, username, refreshed, total, received, created, updated, deleted, allChanges)
        .catch(err => logger.error({ err }, 'Failed to write RCS global changelog'));
    }

    globalRcsRefreshTs = Date.now();
    rcOverviewCache.clear();
    logger.info({ refreshed, total, received, created, updated, deleted, issues: issues.length }, 'RCS global refresh complete');
    return { refreshed, received, created, updated, deleted, errors: issues };
  } finally {
    globalRcsRefreshRunning = false;
  }
}

// ─── Resolve XSUAA token for API calls (used by routes) ──────────────────────

export async function resolveSubaccountXsuaaToken(
  sa: SubaccountEntry,
): Promise<{ token: string; baseUrl: string } | { error: string }> {
  if (!sa.org?.orgId) return { error: 'No org — cannot access XSUAA' };
  const keyStore   = await loadXsuaaKeyStore();
  const tokenStore = await loadXsuaaTokenStore();
  const cfFailed   = new Set<string>();
  const spaceIds   = sa.org?.spaces?.map(s => s.spaceId) ?? [];
  const auth = await resolveXsuaaToken(sa.region, sa.org.orgId, sa.org.orgName, spaceIds, keyStore, tokenStore, cfFailed);
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);
  if ('error' in auth) return auth;
  return { token: auth.token, baseUrl: auth.credential.apiurl || auth.credential.url };
}

// ─── Sync hook: restore globalRcsRefreshTs from changelog after a sync ───────

async function restoreGlobalRcsRefreshTsFromChangelog(): Promise<void> {
  try {
    const text = await readGlobalChangelog();
    const m = text.match(/## \[(?:Auto|Manual)\] global refresh by .+ at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)/);
    if (m) {
      const ts = new Date(m[1]!.replace(' UTC', 'Z')).getTime();
      if (ts > 0 && (globalRcsRefreshTs === null || ts > globalRcsRefreshTs)) {
        globalRcsRefreshTs = ts;
        logger.info({ lastRcGlobalRefreshTs: new Date(ts).toISOString() }, 'Restored RCS global refresh timestamp from changelog');
      }
    }
  } catch { /* best effort */ }
}

void restoreGlobalRcsRefreshTsFromChangelog();

// ─── Public: proactive subaccount RC load ─────────────────────────────────────

export interface SubaccountRcNamesResult {
  names:     string[];
  refreshed: boolean;
  errors:    string[];
  created?:  number;
  updated?:  number;
  deleted?:  number;
  received?: number;
  stale?:    boolean;
}

export async function getSubaccountRcNames(
  region:    string,
  subdomain: string,
  username:  string,
  force      = false,
  noRefresh  = false,
): Promise<SubaccountRcNamesResult> {
  const key   = `${region}/${subdomain}`;
  const delta = getAutoSubaccountRefreshMs();
  const last  = lastRefreshTs.get(key) ?? 0;
  const stale = force || (delta > 0 && Date.now() - last > delta);

  if (noRefresh) {
    const names = await listSubaccountRCNames(region, subdomain);
    return { names, refreshed: false, errors: [], stale };
  }

  if (stale) {
    logger.info({ location: key, force, ageSec: Math.round((Date.now() - last) / 1000) }, 'Proactive RC refresh');
    const result = await refreshSubaccountRoleCollections(region, subdomain, username, 'auto');
    const names  = await listSubaccountRCNames(region, subdomain);
    return { names, refreshed: true, errors: result.errors, created: result.created, updated: result.updated, deleted: result.deleted, received: result.received };
  }

  const names = await listSubaccountRCNames(region, subdomain);
  return { names, refreshed: false, errors: [] };
}

// ─── Public: restriction helper ──────────────────────────────────────────────

export async function isRcSubaccountRestricted(region: string, subdomain: string): Promise<boolean> {
  if (getRestrictedIds().size === 0) return false;
  const sas = await readSubaccounts();
  return sas.some(sa => sa.region === region && sa.subdomain === subdomain && sa.restricted === true);
}

// ─── Public: user management ──────────────────────────────────────────────────

export async function addUserToRc(
  region:    string,
  subdomain: string,
  name:      string,
  user:      UserReference,
  username:  string,
): Promise<void> {
  const sas = await readSubaccounts();
  const sa  = sas.find(s => s.region === region && s.subdomain === subdomain && s.manageRoles);
  if (!sa?.org?.orgId) throw new Error(`No managed-RC subaccount for ${region}/${subdomain}`);

  const keyStore   = await loadXsuaaKeyStore();
  const tokenStore = await loadXsuaaTokenStore();
  const saSpaceIds = sa.org?.spaces?.map(s => s.spaceId) ?? [];
  const cfFailed   = new Set<string>();
  const auth = await resolveXsuaaToken(region, sa.org.orgId, sa.org.orgName, saSpaceIds, keyStore, tokenStore, cfFailed);
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);
  if ('error' in auth) throw new Error(auth.error);

  await withXsuaaApiRetry(region, sa.org.orgId, sa.org.orgName, saSpaceIds, keyStore, tokenStore, cfFailed, auth,
    (tok, cred) => addUserToRoleCollection(cred.apiurl || cred.url, tok, name, user));
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);

  // Update local users file
  const rcDir      = join(LOCAL_RC_DIR, region, subdomain);
  const safeStem   = rcFilename(name);
  const usersPath  = join(rcDir, `${safeStem}.users.json`);
  const changelogPath = join(rcDir, `${safeStem}.changelog.md`);

  let users: UserReference[] = [];
  try { users = JSON.parse(await readFile(usersPath, 'utf-8')) as UserReference[]; } catch { /* new */ }

  const exists = users.some(u => (u.id && u.id === user.id) || (u.userName === user.userName && u.origin === user.origin));
  if (!exists) users.push(user);
  await writeFile(usersPath, JSON.stringify(users, null, 2), 'utf-8');
  rcOverviewCache.delete(`${region}/${subdomain}`);

  const ts = utcTimestamp();
  const entry = `## [Manual] user added by <${username}> at ${ts}\n+ ${user.email || user.userName || user.id} (${user.origin})\n\n`;
  const prev  = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');

  emit('rcs', { files: [`${region}/${subdomain}/${safeStem}.users.json`], ts: Date.now() });
}

export async function removeUserFromRc(
  region:    string,
  subdomain: string,
  name:      string,
  origin:    string,
  userId:    string,
  username:  string,
): Promise<void> {
  const sas = await readSubaccounts();
  const sa  = sas.find(s => s.region === region && s.subdomain === subdomain && s.manageRoles);
  if (!sa?.org?.orgId) throw new Error(`No managed-RC subaccount for ${region}/${subdomain}`);

  const keyStore    = await loadXsuaaKeyStore();
  const tokenStore  = await loadXsuaaTokenStore();
  const saSpaceIds2 = sa.org?.spaces?.map(s => s.spaceId) ?? [];
  const cfFailed2   = new Set<string>();
  const auth = await resolveXsuaaToken(region, sa.org.orgId, sa.org.orgName, saSpaceIds2, keyStore, tokenStore, cfFailed2);
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);
  if ('error' in auth) throw new Error(auth.error);

  await withXsuaaApiRetry(region, sa.org.orgId, sa.org.orgName, saSpaceIds2, keyStore, tokenStore, cfFailed2, auth,
    (tok, cred) => removeUserFromRoleCollection(cred.apiurl || cred.url, tok, name, userId, origin));
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);

  // Update local users file
  const rcDir     = join(LOCAL_RC_DIR, region, subdomain);
  const safeStem  = rcFilename(name);
  const usersPath = join(rcDir, `${safeStem}.users.json`);
  const changelogPath = join(rcDir, `${safeStem}.changelog.md`);

  let users: UserReference[] = [];
  try { users = JSON.parse(await readFile(usersPath, 'utf-8')) as UserReference[]; } catch { /* new */ }

  const removed = users.find(u => u.id === userId || u.userName === userId);
  users = users.filter(u => u.id !== userId && u.userName !== userId);
  await writeFile(usersPath, JSON.stringify(users, null, 2), 'utf-8');
  rcOverviewCache.delete(`${region}/${subdomain}`);

  if (removed) {
    const ts    = utcTimestamp();
    const entry = `## [Manual] user removed by <${username}> at ${ts}\n- ${removed.email || removed.userName || userId} (${removed.origin})\n\n`;
    const prev  = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
  }

  emit('rcs', { files: [`${region}/${subdomain}/${safeStem}.users.json`], ts: Date.now() });
}

registerOnRcsChangelogSynced(() => {
  rcOverviewCache.clear();
  void restoreGlobalRcsRefreshTsFromChangelog();
});
