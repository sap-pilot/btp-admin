import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getOrRefreshToken, fetchWithRateLimit } from './cfLoginService.js';
import { getRestrictedIds, getAutoSubaccountRefreshMs } from './configService.js';
import { readSubaccounts, type SubaccountEntry } from './subaccountsService.js';
import { notifyCallbacks, registerOnDestChangelogSynced } from './syncService.js';
import { emit, emitImmediate } from './liveEvents.js';

const BA_DIR         = join(homedir(), '.ba');
const KEYS_PATH      = join(BA_DIR, 'destination-keys.json');
const TOKENS_PATH    = join(BA_DIR, 'destination-tokens.json');
const LOCAL_DEST_DIR = join(config.LOCAL_STORE_DIR, 'dest');

// In-memory record of when each subaccount's destinations were last successfully fetched from the API.
// Keyed by "${region}/${subdomain}". Resets on server restart (intentional: first open after restart always refreshes).
const lastRefreshTs = new Map<string, number>();

// Timestamp of the last completed global (all-subaccounts) refresh. Null until the first refresh runs.
let globalRefreshTs: number | null = null;

let globalRefreshRunning = false;

export function getGlobalRefreshTs(): number | null { return globalRefreshTs; }

async function getLocalDestinationNames(region: string, subdomain: string): Promise<string[]> {
  const destDir = join(LOCAL_DEST_DIR, region, subdomain);
  const entries = await readdir(destDir).catch(() => [] as string[]);
  return entries
    .filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'))
    .map(f => f.slice(0, -5))
    .sort();
}

function isSensitiveField(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('secret') || k.includes('password') || k.includes('passwd') || k.includes('credential');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DestCredentials {
  uri:          string;
  clientid:     string;
  clientsecret: string;
  url:          string;
  [k: string]: unknown;
}

interface ServiceKey {
  keyId:      string;
  keyName:    string;
  credential: DestCredentials;
}

interface DestKeyInstance {
  instanceId:   string;
  instanceName: string;
  serviceKeys:  ServiceKey[];
}

interface OrgKeyEntry {
  orgName:              string;
  destinationInstances: DestKeyInstance[];
}

// { [region]: { [orgId]: OrgKeyEntry } }
type KeyStore = Record<string, Record<string, OrgKeyEntry>>;

export interface DestToken {
  access_token:   string;
  expires_at:     number;
  refresh_token?: string;
  token_url:      string;
}

interface DestTokenInstance {
  instanceId:   string;
  instanceName: string;
  token:        DestToken;
}

interface OrgTokenEntry {
  orgName:              string;
  destinationInstances: DestTokenInstance[];
}

// { [region]: { [orgId]: OrgTokenEntry } }
type TokenStore = Record<string, Record<string, OrgTokenEntry>>;

// ─── Persistence helpers ──────────────────────────────────────────────────────

const PLAN_GUID_SUFFIX = '_destination_service_plan_guid';

async function loadKeyStore(): Promise<{ orgs: KeyStore; planGuids: Record<string, string> }> {
  try {
    const raw  = JSON.parse(await readFile(KEYS_PATH, 'utf-8')) as Record<string, unknown>;
    const orgs: KeyStore = {};
    const planGuids: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.endsWith(PLAN_GUID_SUFFIX) && typeof v === 'string') {
        planGuids[k.slice(0, -PLAN_GUID_SUFFIX.length)] = v;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        orgs[k] = v as Record<string, OrgKeyEntry>;
      }
    }
    return { orgs, planGuids };
  } catch {
    return { orgs: {}, planGuids: {} };
  }
}

async function saveKeyStore(orgs: KeyStore, planGuids: Record<string, string>): Promise<void> {
  await mkdir(BA_DIR, { recursive: true });
  const out: Record<string, unknown> = {};
  for (const [region, guid] of Object.entries(planGuids)) out[`${region}${PLAN_GUID_SUFFIX}`] = guid;
  for (const [region, orgMap] of Object.entries(orgs))     out[region] = orgMap;
  await writeFile(KEYS_PATH, JSON.stringify(out, null, 2), 'utf-8');
}

async function loadTokenStore(): Promise<TokenStore> {
  try { return JSON.parse(await readFile(TOKENS_PATH, 'utf-8')) as TokenStore; }
  catch { return {}; }
}

async function saveTokenStore(store: TokenStore): Promise<void> {
  await mkdir(BA_DIR, { recursive: true });
  await writeFile(TOKENS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

// ─── Key/token store accessors ────────────────────────────────────────────────

interface FirstKeyInfo {
  credential:   DestCredentials;
  instanceId:   string;
  instanceName: string;
  keyId:        string;
  keyName:      string;
}

function getFirstKeyInfo(store: KeyStore, region: string, orgId: string): FirstKeyInfo | null {
  const inst = store[region]?.[orgId]?.destinationInstances[0];
  if (!inst) return null;
  const key = inst.serviceKeys[0];
  if (!key) return null;
  return { credential: key.credential, instanceId: inst.instanceId, instanceName: inst.instanceName, keyId: key.keyId, keyName: key.keyName };
}

interface TokenInfo {
  token:        DestToken;
  instanceId:   string;
  instanceName: string;
}

function getTokenInfo(store: TokenStore, region: string, orgId: string): TokenInfo | null {
  const inst = store[region]?.[orgId]?.destinationInstances[0];
  return inst ? { token: inst.token, instanceId: inst.instanceId, instanceName: inst.instanceName } : null;
}

function setKeyEntry(store: KeyStore, region: string, orgId: string, orgName: string, instanceId: string, instanceName: string, keyId: string, keyName: string, credential: DestCredentials): void {
  if (!store[region]) store[region] = {};
  store[region]![orgId] = { orgName, destinationInstances: [{ instanceId, instanceName, serviceKeys: [{ keyId, keyName, credential }] }] };
}

function setTokenEntry(store: TokenStore, region: string, orgId: string, orgName: string, instanceId: string, instanceName: string, token: DestToken): void {
  if (!store[region]) store[region] = {};
  store[region]![orgId] = { orgName, destinationInstances: [{ instanceId, instanceName, token }] };
}

// ─── CF v3 API helpers ────────────────────────────────────────────────────────

async function cfGet(region: string, path: string): Promise<unknown> {
  const token      = await getOrRefreshToken(region);
  const url        = `${token.api_url}${path}`;
  const reqHeaders = { Authorization: `${token.token_type} ${token.access_token}` };
  if (logger.isLevelEnabled('trace')) logger.trace({ method: 'GET', url, reqHeaders }, 'CF v3 API request');
  const t0  = Date.now();
  const res = await fetchWithRateLimit(() => fetch(url, { headers: reqHeaders }), url);
  const ms  = Date.now() - t0;
  let resText: string | undefined;
  if (logger.isLevelEnabled('trace')) {
    resText = await res.text().catch(() => '');
    logger.trace({ method: 'GET', url, status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: resText }, 'CF v3 API response');
  }
  logger.debug({ method: 'GET', url, status: res.status, cl: res.headers.get('content-length'), ms }, 'CF v3 API call');
  if (!res.ok) throw new Error(`CF GET ${path} → HTTP ${res.status}`);
  return resText !== undefined ? JSON.parse(resText) : res.json();
}

interface DestInstanceInfo { instanceId: string; instanceName: string }
interface DestKeyRaw       { keyId: string; keyName: string }

async function fetchDestServicePlanGuid(region: string): Promise<string> {
  const data = await cfGet(region, '/v3/service_plans?service_offering_names=destination&names=lite&per_page=1') as {
    resources?: Array<{ guid: string }>;
  };
  const guid = data.resources?.[0]?.guid;
  if (!guid) throw new Error('Destination service plan (destination/lite) not found in region');
  return guid;
}

async function fetchDestInstances(region: string, orgGuid: string, planGuid: string): Promise<DestInstanceInfo[]> {
  const data = await cfGet(region,
    `/v3/service_instances?organization_guids=${orgGuid}&service_plan_guids=${planGuid}&per_page=10`,
  ) as { resources?: Array<{ guid: string; name: string }> };
  return (data.resources ?? []).map(r => ({ instanceId: r.guid, instanceName: r.name }));
}

interface DestKeyWithInstance extends DestKeyRaw { instanceId: string }

async function fetchDestKeysForInstances(region: string, instanceIds: string[]): Promise<DestKeyWithInstance[]> {
  if (instanceIds.length === 0) return [];
  const data = await cfGet(region,
    `/v3/service_credential_bindings?service_instance_guids=${instanceIds.join(',')}&type=key&per_page=10`,
  ) as {
    resources?: Array<{
      guid: string;
      name: string;
      relationships?: { service_instance?: { data?: { guid?: string } } };
    }>;
  };
  return (data.resources ?? []).map(r => ({
    keyId:      r.guid,
    keyName:    r.name,
    instanceId: r.relationships?.service_instance?.data?.guid ?? '',
  }));
}

async function fetchDestCredentials(region: string, keyGuid: string): Promise<DestCredentials> {
  const raw = await cfGet(region, `/v3/service_credential_bindings/${keyGuid}/details`) as {
    credentials?: Record<string, unknown>;
  };
  const c   = raw.credentials ?? {};
  const uaa = (c.uaa as Record<string, unknown> | undefined) ?? {};

  // clientid / clientsecret / url (token URL) may be at root or nested under credentials.uaa
  const uri          = (c.uri          ?? uaa.uri)          as string | undefined;
  const clientid     = (c.clientid     ?? uaa.clientid)     as string | undefined;
  const clientsecret = (c.clientsecret ?? uaa.clientsecret) as string | undefined;
  const url          = (c.url          ?? uaa.url)          as string | undefined;

  if (!uri || !clientid || !clientsecret || !url) {
    throw new Error(`Incomplete destination credentials for key ${keyGuid}`);
  }
  return { ...c, uri, clientid, clientsecret, url };
}

interface DiscoveredKey extends DestInstanceInfo, DestKeyRaw { credential: DestCredentials }

async function discoverDestKey(region: string, orgId: string, planGuid: string): Promise<DiscoveredKey> {
  const restrictedIds = getRestrictedIds();
  if (restrictedIds.size > 0) {
    const allSas = await readSubaccounts();
    const sa = allSas.find(s => s.org?.orgId === orgId);
    if (sa?.restricted) {
      logger.warn({ orgId, region, subaccountId: sa.subaccountId }, 'Blocked CF service-key discovery for restricted subaccount');
      throw new Error(`Subaccount ${sa.subaccountId} is restricted — service key discovery blocked`);
    }
  }
  // Oldest instances first — older instances are less likely to be redeployed and have more stable keys
  const instances = await fetchDestInstances(region, orgId, planGuid);
  if (instances.length === 0) throw new Error(`No "destination" service instance found in org ${orgId}`);

  // Batch-fetch oldest service keys across all instances in one call; oldest keys are preferred for the same reason
  const keys = await fetchDestKeysForInstances(region, instances.map(i => i.instanceId));
  const key  = keys.find(k => k.instanceId);
  if (!key) throw new Error(`No service key found for any destination service instance in org ${orgId}`);

  const inst = instances.find(i => i.instanceId === key.instanceId) ?? instances[0]!;
  const credential = await fetchDestCredentials(region, key.keyId);
  logger.info({ orgId, region, instanceId: inst.instanceId, keyId: key.keyId }, 'Destination service key acquired via CF API');
  return { ...inst, ...key, credential };
}

// ─── Destination OAuth token ──────────────────────────────────────────────────

async function acquireDestToken(credential: DestCredentials): Promise<DestToken> {
  const tokenUrl = `${credential.url}/oauth/token`;
  const basic    = Buffer.from(`${credential.clientid}:${credential.clientsecret}`).toString('base64');
  const headers  = { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` };
  const body     = 'grant_type=client_credentials';
  if (logger.isLevelEnabled('trace')) logger.trace({ method: 'POST', url: tokenUrl, reqHeaders: headers, reqBody: body }, 'Destination OAuth request');
  const t0  = Date.now();
  const res = await fetchWithRateLimit(() => fetch(tokenUrl, { method: 'POST', headers, body }), tokenUrl);
  const ms  = Date.now() - t0;
  let resText: string | undefined;
  if (logger.isLevelEnabled('trace')) {
    resText = await res.text().catch(() => '');
    logger.trace({ method: 'POST', url: tokenUrl, status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: resText }, 'Destination OAuth response');
  }
  logger.debug({ method: 'POST', url: tokenUrl, grant_type: 'client_credentials', status: res.status, cl: res.headers.get('content-length'), ms }, 'Destination OAuth token call');
  if (!res.ok) {
    const text = resText ?? await res.text().catch(() => '');
    throw new Error(`Destination OAuth → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (resText !== undefined ? JSON.parse(resText) : await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 1800;
  return {
    access_token:   data.access_token,
    expires_at:     Date.now() + expiresIn * 1000,
    refresh_token:  data.refresh_token,
    token_url:      tokenUrl,
  };
}

async function refreshDestToken(existing: DestToken): Promise<DestToken> {
  if (!existing.refresh_token) throw new Error('No refresh_token available');
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body    = `grant_type=refresh_token&refresh_token=${encodeURIComponent(existing.refresh_token)}`;
  const res     = await fetchWithRateLimit(() => fetch(existing.token_url, { method: 'POST', headers, body }), existing.token_url);
  if (!res.ok) throw new Error(`Destination token refresh → HTTP ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in?: number; refresh_token?: string };
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 1800;
  return {
    access_token:  data.access_token,
    expires_at:    Date.now() + expiresIn * 1000,
    refresh_token: data.refresh_token ?? existing.refresh_token,
    token_url:     existing.token_url,
  };
}

// ─── Token resolution (full fallback chain) ───────────────────────────────────

interface ResolvedAuth { accessToken: string; credential: DestCredentials }
type TokenResult = ResolvedAuth | { error: string };

async function resolveToken(
  region:        string,
  orgId:         string,
  orgName:       string,
  keyStore:      KeyStore,
  tokenStore:    TokenStore,
  cfLoginFailed: Set<string>,
  planGuids:     Record<string, string>,
  location:      string,
): Promise<TokenResult> {
  {
    const restrictedIds = getRestrictedIds();
    if (restrictedIds.size > 0) {
      const allSas = await readSubaccounts();
      const sa = allSas.find(s => s.org?.orgId === orgId);
      if (sa?.restricted) {
        logger.warn({ orgId, orgName, region, location, subaccountId: sa.subaccountId }, 'Blocked CF credential resolution for restricted subaccount');
        return { error: `Subaccount ${sa.subaccountId} is restricted — destination credential access blocked` };
      }
    }
  }
  const keyInfo   = getFirstKeyInfo(keyStore, region, orgId);
  const tokenInfo = getTokenInfo(tokenStore, region, orgId);

  // 1. Valid cached token + known credential → use immediately
  if (tokenInfo && tokenInfo.token.expires_at - Date.now() > 60_000 && keyInfo) {
    return { accessToken: tokenInfo.token.access_token, credential: keyInfo.credential };
  }

  // 2. Try refresh_token
  if (tokenInfo?.token.refresh_token) {
    try {
      const refreshed = await refreshDestToken(tokenInfo.token);
      setTokenEntry(tokenStore, region, orgId, orgName, tokenInfo.instanceId, tokenInfo.instanceName, refreshed);
      if (keyInfo) return { accessToken: refreshed.access_token, credential: keyInfo.credential };
    } catch (err) {
      logger.debug({ location, err }, 'Destination token refresh failed — will use service key');
    }
  }

  // 3. Use existing key for a new client_credentials token; re-discover if key is rejected
  if (keyInfo) {
    try {
      const token = await acquireDestToken(keyInfo.credential);
      setTokenEntry(tokenStore, region, orgId, orgName, keyInfo.instanceId, keyInfo.instanceName, token);
      return { accessToken: token.access_token, credential: keyInfo.credential };
    } catch (err) {
      const errMsg = String(err);
      const isCredErr = errMsg.includes('HTTP 401') || errMsg.includes('HTTP 403') ||
                        errMsg.includes('Bad credentials') || errMsg.includes('Incomplete');
      if (isCredErr && !cfLoginFailed.has(region)) {
        // Cached key is stale/revoked — re-discover once with fresh CF API lookup
        logger.info({ location, err }, 'Cached destination key rejected — re-discovering latest key');
        return await rediscoverAndAcquire(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
      }
      logger.debug({ location, err }, 'Token from existing key failed — trying CF API for new key');
    }
  }

  // 4. Discover key via CF API (no cached key, or non-credential failure above)
  if (cfLoginFailed.has(region)) {
    return { error: `CF login failed for region ${region}` };
  }

  return await rediscoverAndAcquire(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
}

async function rediscoverAndAcquire(
  region:        string,
  orgId:         string,
  orgName:       string,
  keyStore:      KeyStore,
  tokenStore:    TokenStore,
  cfLoginFailed: Set<string>,
  planGuids:     Record<string, string>,
  location:      string,
): Promise<TokenResult> {
  // Fetch (and cache) the destination service plan guid — one per region
  let planGuid = planGuids[region];
  if (!planGuid) {
    try {
      planGuid = await fetchDestServicePlanGuid(region);
      planGuids[region] = planGuid;
      logger.debug({ region, planGuid }, 'Cached destination service plan guid');
    } catch (err) {
      const msg = String(err);
      const isCfAuth = msg.includes('No CF credentials available') ||
                       (msg.includes('HTTP 401') && msg.includes('oauth/token'));
      if (isCfAuth) {
        logger.warn({ region, err }, `Not able to login to CF at ${region}`);
        cfLoginFailed.add(region);
        return { error: `CF login failed for region ${region}` };
      }
      logger.info({ region, err }, 'Cannot fetch destination service plan guid');
      return { error: `Cannot fetch destination service plan: ${msg}` };
    }
  }

  try {
    const discovered = await discoverDestKey(region, orgId, planGuid);
    setKeyEntry(keyStore, region, orgId, orgName, discovered.instanceId, discovered.instanceName, discovered.keyId, discovered.keyName, discovered.credential);
    const token = await acquireDestToken(discovered.credential);
    setTokenEntry(tokenStore, region, orgId, orgName, discovered.instanceId, discovered.instanceName, token);
    return { accessToken: token.access_token, credential: discovered.credential };
  } catch (err) {
    const msg = String(err);
    const isCfAuth  = msg.includes('No CF credentials available') ||
                      (msg.includes('HTTP 401') && msg.includes('oauth/token'));
    const isNoSvc   = msg.includes('No "destination" service instance');
    if (isCfAuth) {
      logger.warn({ region, err }, `Not able to login or refresh destinations at ${region}`);
      cfLoginFailed.add(region);
      return { error: `CF login failed for region ${region}` };
    }
    if (isNoSvc) {
      logger.info({ location }, 'No destination service instance found');
      return { error: 'No destination service instance found' };
    }
    logger.info({ location, err }, `Cannot get destination key for ${location}`);
    return { error: `Cannot fetch destination key: ${msg}` };
  }
}

// ─── Destination API call with 401 retry cascade ─────────────────────────────

async function withDestApiRetry<T>(
  region:        string,
  orgId:         string,
  orgName:       string,
  keyStore:      KeyStore,
  tokenStore:    TokenStore,
  cfLoginFailed: Set<string>,
  planGuids:     Record<string, string>,
  location:      string,
  auth:          ResolvedAuth,
  call:          (auth: ResolvedAuth) => Promise<T>,
): Promise<T> {
  try {
    return await call(auth);
  } catch (err) {
    if (!String(err).includes('HTTP 401')) throw err;

    // Retry 1: invalidate cached token, re-acquire using existing service key
    logger.info({ region, orgId, location }, 'Destination API 401 — re-acquiring token via existing service key');
    if (tokenStore[region]) delete tokenStore[region][orgId];
    const r2 = await resolveToken(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
    if ('error' in r2) throw new Error(r2.error);

    try {
      return await call(r2);
    } catch (err2) {
      if (!String(err2).includes('HTTP 401')) throw err2;

      // Retry 2: also invalidate service key, re-discover via CF API
      logger.info({ region, orgId, location }, 'Destination API 401 again — re-discovering service key via CF API');
      if (keyStore[region]) delete keyStore[region][orgId];
      if (tokenStore[region]) delete tokenStore[region][orgId];
      const r3 = await resolveToken(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
      if ('error' in r3) throw new Error(r3.error);
      return await call(r3);
    }
  }
}

// ─── Destination API ──────────────────────────────────────────────────────────

async function fetchSubaccountDestinations(credential: DestCredentials, accessToken: string): Promise<unknown[]> {
  const url     = `${credential.uri}/destination-configuration/v1/subaccountDestinations`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (logger.isLevelEnabled('trace')) logger.trace({ method: 'GET', url, reqHeaders: headers }, 'Destination API request');
  const t0  = Date.now();
  const res = await fetchWithRateLimit(() => fetch(url, { headers }), url);
  const ms  = Date.now() - t0;
  let resText: string | undefined;
  if (logger.isLevelEnabled('trace')) {
    resText = await res.text().catch(() => '');
    logger.trace({ method: 'GET', url, status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: resText }, 'Destination API response');
  }
  logger.debug({ method: 'GET', url, status: res.status, cl: res.headers.get('content-length'), ms }, 'Destination API call');
  if (!res.ok) {
    const text = resText ?? await res.text().catch(() => '');
    throw new Error(`Destination API → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = resText !== undefined ? JSON.parse(resText) : await res.json();
  return Array.isArray(data) ? data : [];
}

// ─── Diff / changelog ────────────────────────────────────────────────────────

function diffDestination(prev: Record<string, unknown>, next: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const pv = JSON.stringify(prev[k] ?? null);
    const nv = JSON.stringify(next[k] ?? null);
    if (pv !== nv) lines.push(isSensitiveField(k) ? `- ${k}: [redacted] → [redacted]` : `- ${k}: ${pv} → ${nv}`);
  }
  return lines.join('\n');
}

type PersistResult = 'created' | 'updated' | 'unchanged';

async function persistDestination(
  destDir:  string,
  name:     string,
  incoming: Record<string, unknown>,
  username: string,
): Promise<PersistResult> {
  const filePath      = join(destDir, `${name}.json`);
  const changelogPath = join(destDir, `${name}.changelog.md`);
  const incomingJson  = JSON.stringify(incoming, null, 2);

  if (existsSync(filePath)) {
    const existing = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
    const diff     = diffDestination(existing, incoming);
    if (!diff) return 'unchanged';
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const heading = `## Refreshed by <${username}> at ${dateStr}`;
    const entry   = `${heading}\n${diff}\n\n`;
    const prev    = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
    await writeFile(filePath, incomingJson, 'utf-8');
    return 'updated';
  }

  await writeFile(filePath, incomingJson, 'utf-8');
  return 'created';
}

// ─── Public: refresh ─────────────────────────────────────────────────────────

export interface RefreshResult {
  refreshed: number;
  received:  number;
  created:   number;
  updated:   number;
  deleted:   number;
  errors:    string[];
  skipped?:  boolean;
}

interface DestChange { region: string; subdomain: string; name: string; action: 'created' | 'updated' | 'deleted' }

function formatChangelogTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function writeGlobalChangelog(
  username:  string,
  mode:      'auto' | 'manual',
  refreshed: number,
  total:     number,
  received:  number,
  created:   number,
  updated:   number,
  deleted:   number,
  isDelta:   boolean,
  changes:   DestChange[],
): Promise<void> {
  await mkdir(LOCAL_DEST_DIR, { recursive: true });
  const changelogPath = join(LOCAL_DEST_DIR, 'changelog.md');

  // Rotate if > 2 MB
  try {
    const info = await stat(changelogPath);
    if (info.size > 2 * 1024 * 1024) {
      const archiveName = `changelog.${formatChangelogTs(new Date())}.md`;
      await rename(changelogPath, join(LOCAL_DEST_DIR, archiveName));
      logger.info({ archiveName }, 'Rotated global changelog');
    }
  } catch { /* file may not exist yet */ }

  const modeLabel = mode === 'auto' ? 'Auto' : 'Manual';
  const dateStr   = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const summary   = `Refresh ${refreshed}/${total} subaccounts, received ${received} destinations, created ${created}, updated ${updated} and deleted ${deleted} destinations`;

  let entry = `## [${modeLabel}] global refresh triggered by <${username}> at ${dateStr}\n\n${summary}`;

  if (isDelta && changes.length > 0) {
    for (const c of changes) {
      const histPath = `/destinations/${encodeURIComponent(c.region)}/${encodeURIComponent(c.subdomain)}/${encodeURIComponent(c.name)}/history`;
      entry += `\n- ${c.action}: ${c.region}.${c.subdomain} -> ${c.name} ([History](${histPath}))`;
    }
  }

  entry += '\n\n';

  const prev = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');
}

export async function getGlobalChangelog(): Promise<{ data: string; archivedFiles: string[] }> {
  try {
    const changelogPath = join(LOCAL_DEST_DIR, 'changelog.md');
    const data          = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    const files         = existsSync(LOCAL_DEST_DIR) ? await readdir(LOCAL_DEST_DIR) : [];
    const archivedFiles = files
      .filter(f => /^changelog\.\d{8}-\d{6}\.md$/.test(f))
      .sort()
      .reverse();
    return { data, archivedFiles };
  } catch { return { data: '', archivedFiles: [] }; }
}

export async function getGlobalChangelogFile(filename: string): Promise<string> {
  if (!/^changelog\.\d{8}-\d{6}\.md$/.test(filename)) throw Object.assign(new Error('Invalid filename'), { status: 400 });
  try { return await readFile(join(LOCAL_DEST_DIR, filename), 'utf-8'); }
  catch { return ''; }
}

export async function searchGlobalChangelogs(query: string): Promise<{ files: string[]; matchCount: number }> {
  if (!query.trim()) return { files: [], matchCount: 0 };
  const lq = query.toLowerCase();

  const { data: currentData, archivedFiles } = await getGlobalChangelog();
  const matched: string[] = [];
  let totalMatches = 0;

  const countMatches = (text: string) => text.toLowerCase().split(lq).length - 1;

  const currentCount = countMatches(currentData);
  if (currentCount > 0) { matched.push(''); totalMatches += currentCount; }

  for (const f of archivedFiles) {
    const text = await getGlobalChangelogFile(f);
    const count = countMatches(text);
    if (count > 0) { matched.push(f); totalMatches += count; }
  }

  return { files: matched, matchCount: totalMatches };
}

// Parse the topmost "global refresh triggered by" timestamp from changelog text.
// Deliberately skips "subaccount destination refresh/update" lines.
function parseGlobalRefreshTsFromChangelog(text: string): number | null {
  const m = text.match(/^## \[(?:Auto|Manual)\] global refresh triggered by [^\n]+ at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)/m);
  if (!m) return null;
  const ms = new Date(m[1]!.replace(' ', 'T').replace(' UTC', 'Z')).getTime();
  return isNaN(ms) ? null : ms;
}

// Append a subaccount-scoped entry to the global dest/changelog.md.
// Applies the same 2 MB rotation as writeGlobalChangelog.
async function appendSubaccountGlobalChangelog(
  mode:     'auto' | 'manual',
  action:   'refresh' | 'update',
  username: string,
  changes:  DestChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await mkdir(LOCAL_DEST_DIR, { recursive: true });
  const changelogPath = join(LOCAL_DEST_DIR, 'changelog.md');

  try {
    const info = await stat(changelogPath);
    if (info.size > 2 * 1024 * 1024) {
      const archiveName = `changelog.${formatChangelogTs(new Date())}.md`;
      await rename(changelogPath, join(LOCAL_DEST_DIR, archiveName));
      logger.info({ archiveName }, 'Rotated global changelog');
    }
  } catch { /* file may not exist yet */ }

  const modeLabel = mode === 'auto' ? 'Auto' : 'Manual';
  const dateStr   = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const created   = changes.filter(c => c.action === 'created').length;
  const updated   = changes.filter(c => c.action === 'updated').length;
  const deleted   = changes.filter(c => c.action === 'deleted').length;
  const summary   = `${action === 'update' ? 'Manual update' : 'Refresh'}: created ${created}, updated ${updated} and deleted ${deleted} destinations`;

  let entry = `## [${modeLabel}] subaccount destination ${action} by <${username}> at ${dateStr}\n\n${summary}`;
  for (const c of changes) {
    const histPath = `/destinations/${encodeURIComponent(c.region)}/${encodeURIComponent(c.subdomain)}/${encodeURIComponent(c.name)}/history`;
    entry += `\n- ${c.action}: ${c.region}.${c.subdomain} -> ${c.name} ([History](${histPath}))`;
  }
  entry += '\n\n';

  const prev = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');
}

export async function refreshDestinations(username = 'system', mode: 'auto' | 'manual' = 'auto', force = false): Promise<RefreshResult> {
  if (globalRefreshRunning && !force) {
    logger.info({ username, mode }, 'Global destination refresh skipped — already running');
    return { refreshed: 0, received: 0, created: 0, updated: 0, deleted: 0, errors: [], skipped: true };
  }
  if (force) logger.warn({ username, mode }, 'Force global destination refresh requested');
  else logger.info({ username, mode }, 'Global destination refresh requested');
  globalRefreshRunning = true;
  try {
  const allSas    = await readSubaccounts();
  const targetSas = allSas
    .filter(sa => sa.manageDestinations)
    .sort((a, b) => a.region.localeCompare(b.region) || a.subdomain.localeCompare(b.subdomain));

  const total = targetSas.length;
  if (total === 0) {
    logger.info('No subaccounts with manageDestinations=true — nothing to refresh');
    emitImmediate('refresh-destinations', { type: 'done', scope: 'global', refreshed: 0, total: 0, received: 0, created: 0, updated: 0, deleted: 0, issues: [] });
    return { refreshed: 0, received: 0, created: 0, updated: 0, deleted: 0, errors: [] };
  }

  // Delta mode: dest/ already has subaccount subdirs → track per-destination changes.
  // Initial mode (no subdirs, e.g. server startup): skip the list to avoid noise.
  let isDeltaMode = false;
  try {
    const destEntries = await readdir(LOCAL_DEST_DIR, { withFileTypes: true });
    isDeltaMode = destEntries.some(e => e.isDirectory());
  } catch { /* dest/ doesn't exist yet */ }

  const { orgs: keyStore, planGuids } = await loadKeyStore();
  const tokenStore = await loadTokenStore();

  // Warnings and errors collected during the run, keyed with location for display
  const issues: string[] = [];
  const cfLoginFailed = new Set<string>();
  const destChanges: DestChange[] = [];
  let refreshed = 0, received = 0, created = 0, updated = 0, deleted = 0;

  emit('refresh-destinations', { type: 'progress', scope: 'global', current: 0, total, name: 'Initializing…', received: 0 });

  for (let idx = 0; idx < targetSas.length; idx++) {
    const sa       = targetSas[idx]!;
    const location = `${sa.region}/${sa.subdomain}`;
    const saLabel  = sa.alias || sa.subaccountName || sa.subdomain;

    emit('refresh-destinations', { type: 'progress', scope: 'global', current: idx + 1, total, name: saLabel, received });

    if (!sa.org?.orgId) {
      const msg = `${location}: no org — cannot access destination service`;
      logger.warn({ location }, msg);
      issues.push(msg);
      continue;
    }

    const orgId   = sa.org.orgId;
    const orgName = sa.org.orgName ?? '';

    // Helper: format issue with instance name/id when available
    function issueRef(): string {
      const ki = getFirstKeyInfo(keyStore, sa.region, orgId);
      return ki ? ` -> ${ki.instanceName}[${ki.instanceId}]` : '';
    }

    try {
      const tokenResult = await resolveToken(sa.region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
      if ('error' in tokenResult) {
        issues.push(`${location}${issueRef()}: ${tokenResult.error}`);
        continue;
      }

      const destinations = await withDestApiRetry(sa.region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location, tokenResult,
        auth => fetchSubaccountDestinations(auth.credential, auth.accessToken));
      const destDir = join(LOCAL_DEST_DIR, sa.region, sa.subdomain);
      await mkdir(destDir, { recursive: true });

      const apiNames = new Set<string>();
      for (const dest of destinations) {
        const d    = dest as Record<string, unknown>;
        const name = String(d['Name'] ?? d['name'] ?? '');
        if (!name) continue;
        apiNames.add(name);
        const result = await persistDestination(destDir, name, d, username);
        if (result === 'created') { created++; destChanges.push({ region: sa.region, subdomain: sa.subdomain, name, action: 'created' }); }
        else if (result === 'updated') { updated++; destChanges.push({ region: sa.region, subdomain: sa.subdomain, name, action: 'updated' }); }
      }
      received += apiNames.size;

      // Rename destinations absent from API response to .deleted.json
      const entries = await readdir(destDir).catch(() => [] as string[]);
      for (const fname of entries) {
        if (!fname.endsWith('.json') || fname.endsWith('.deleted.json')) continue;
        const destName     = fname.slice(0, -5);
        if (apiNames.has(destName)) continue;
        const changelogPath = join(destDir, `${destName}.changelog.md`);
        const dateStr       = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const entry         = `## Deleted by refresh at ${dateStr}\n\n`;
        const prev          = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
        await writeFile(changelogPath, entry + prev, 'utf-8');
        await rename(join(destDir, fname), join(destDir, `${destName}.deleted.json`));
        logger.info({ location, destination: destName }, `${location}/${destName} is deleted`);
        deleted++;
        destChanges.push({ region: sa.region, subdomain: sa.subdomain, name: destName, action: 'deleted' });
      }

      logger.info({ location, count: apiNames.size }, `Destinations refreshed for ${location}`);
      lastRefreshTs.set(location, Date.now());
      refreshed++;
    } catch (err) {
      const msg = String(err);
      logger.error({ location, err }, `Destination refresh failed for ${location}: ${msg}`);
      issues.push(`${location}${issueRef()}: ${msg}`);
    }
  }

  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);

  emitImmediate('refresh-destinations', {
    type: 'done', scope: 'global',
    refreshed, total, received, created, updated, deleted, issues,
  });

  globalRefreshTs = Date.now();

  await writeGlobalChangelog(username, mode, refreshed, total, received, created, updated, deleted, isDeltaMode, destChanges).catch(
    err => logger.error({ err }, 'Failed to write global changelog'),
  );

  notifyCallbacks();
  emit('dest', { ts: Date.now() });

  return { refreshed, received, created, updated, deleted, errors: issues };
  } finally {
    globalRefreshRunning = false;
  }
}

export async function refreshSubaccountDestinations(region: string, subdomain: string, username = 'system', mode: 'auto' | 'manual' = 'auto'): Promise<RefreshResult> {
  const allSas = await readSubaccounts();
  const sa     = allSas.find(s => s.region === region && s.subdomain === subdomain && s.manageDestinations);
  if (!sa) return { refreshed: 0, received: 0, created: 0, updated: 0, deleted: 0, errors: [`No managed-destination subaccount found for ${region}/${subdomain}`] };

  const total    = 1;
  const location = `${sa.region}/${sa.subdomain}`;
  const saLabel  = sa.alias || sa.subaccountName || sa.subdomain;
  const issues:       string[] = [];
  const changedDests: DestChange[] = [];
  let received = 0, created = 0, updated = 0, deleted = 0;

  const { orgs: keyStore, planGuids } = await loadKeyStore();
  const tokenStore = await loadTokenStore();
  const cfLoginFailed = new Set<string>();

  emit('refresh-destinations', { type: 'progress', scope: 'subaccount', region: sa.region, subdomain: sa.subdomain, current: 1, total, name: saLabel, received: 0 });

  if (!sa.org?.orgId) {
    const msg = `${location}: no org — cannot access destination service`;
    emitImmediate('refresh-destinations', { type: 'done', scope: 'subaccount', region: sa.region, subdomain: sa.subdomain, refreshed: 0, total, received: 0, created: 0, updated: 0, deleted: 0, issues: [msg] });
    return { refreshed: 0, received: 0, created: 0, updated: 0, deleted: 0, errors: [msg] };
  }

  const orgId   = sa.org.orgId;
  const orgName = sa.org.orgName ?? '';

  const saRegion = sa.region;
  function issueRef(): string {
    const ki = getFirstKeyInfo(keyStore, saRegion, orgId);
    return ki ? ` -> ${ki.instanceName}[${ki.instanceId}]` : '';
  }

  try {
    const tokenResult = await resolveToken(saRegion, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
    if ('error' in tokenResult) {
      issues.push(`${location}${issueRef()}: ${tokenResult.error}`);
    } else {
      const destinations = await withDestApiRetry(saRegion, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location, tokenResult,
        auth => fetchSubaccountDestinations(auth.credential, auth.accessToken));
      const destDir = join(LOCAL_DEST_DIR, sa.region, sa.subdomain);
      await mkdir(destDir, { recursive: true });

      const apiNames = new Set<string>();
      for (const dest of destinations) {
        const d    = dest as Record<string, unknown>;
        const name = String(d['Name'] ?? d['name'] ?? '');
        if (!name) continue;
        apiNames.add(name);
        const result = await persistDestination(destDir, name, d, username);
        if (result === 'created') { created++; changedDests.push({ region: sa.region, subdomain: sa.subdomain, name, action: 'created' }); }
        else if (result === 'updated') { updated++; changedDests.push({ region: sa.region, subdomain: sa.subdomain, name, action: 'updated' }); }
      }
      received += apiNames.size;

      const entries = await readdir(destDir).catch(() => [] as string[]);
      for (const fname of entries) {
        if (!fname.endsWith('.json') || fname.endsWith('.deleted.json')) continue;
        const destName      = fname.slice(0, -5);
        if (apiNames.has(destName)) continue;
        const changelogPath = join(destDir, `${destName}.changelog.md`);
        const dateStr       = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const entry         = `## Deleted by refresh at ${dateStr}\n\n`;
        const prev          = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
        await writeFile(changelogPath, entry + prev, 'utf-8');
        await rename(join(destDir, fname), join(destDir, `${destName}.deleted.json`));
        deleted++;
        changedDests.push({ region: sa.region, subdomain: sa.subdomain, name: destName, action: 'deleted' });
      }

      logger.info({ location, count: apiNames.size }, `Destinations refreshed for ${location}`);
      lastRefreshTs.set(location, Date.now());
    }
  } catch (err) {
    const msg = String(err);
    logger.error({ location, err }, `Destination refresh failed for ${location}: ${msg}`);
    issues.push(`${location}${issueRef()}: ${msg}`);
  }

  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);

  const refreshed = issues.length === 0 ? 1 : 0;
  emitImmediate('refresh-destinations', { type: 'done', scope: 'subaccount', region: sa.region, subdomain: sa.subdomain, refreshed, total, received, created, updated, deleted, issues });

  if (changedDests.length > 0) {
    await appendSubaccountGlobalChangelog(mode, 'refresh', username, changedDests)
      .catch(err => logger.error({ err }, 'Failed to write subaccount global changelog'));
    notifyCallbacks();
    emit('dest', { ts: Date.now() });
  }

  return { refreshed, received, created, updated, deleted, errors: issues };
}

// ─── Public: proactive subaccount destination load ────────────────────────────

export interface SubaccountDestNamesResult {
  names:     string[];
  refreshed: boolean;
  errors:    string[];
  created?:  number;
  updated?:  number;
  deleted?:  number;
  received?: number;
}

/**
 * Returns destination names for a subaccount, proactively refreshing from the
 * Destination API if the cached data is older than AUTO_SUBACCOUNT_REFRESH_MINS.
 * When force=true the refresh always runs regardless of age.
 */
export async function getSubaccountDestinationNames(
  region:    string,
  subdomain: string,
  username:  string,
  force      = false,
): Promise<SubaccountDestNamesResult> {
  const key   = `${region}/${subdomain}`;
  const delta = getAutoSubaccountRefreshMs();
  const last  = lastRefreshTs.get(key) ?? 0;
  const stale = force || (delta > 0 && Date.now() - last > delta);

  if (stale) {
    logger.info({ location: key, force, ageSec: Math.round((Date.now() - last) / 1000) }, 'Proactive destination refresh');
    const result = await refreshSubaccountDestinations(region, subdomain, username, 'auto');
    const names  = await getLocalDestinationNames(region, subdomain);
    return { names, refreshed: true, errors: result.errors, created: result.created, updated: result.updated, deleted: result.deleted, received: result.received };
  }

  const names = await getLocalDestinationNames(region, subdomain);
  return { names, refreshed: false, errors: [] };
}

// ─── Public: restriction helper ──────────────────────────────────────────────

/** Returns true if the subaccount identified by region+subdomain is in RESTRICTED_SUBACCOUNT_IDS. */
export async function isSubaccountRestricted(region: string, subdomain: string): Promise<boolean> {
  if (getRestrictedIds().size === 0) return false;
  const sas = await readSubaccounts();
  return sas.some(sa => sa.region === region && sa.subdomain === subdomain && sa.restricted === true);
}

// ─── Public: search ───────────────────────────────────────────────────────────

export interface DestSearchResult {
  region:     string;
  subdomain:  string;
  org_id:     string;
  name:       string;
  matchField: string;
  matchValue: string;
}

export async function searchDestinations(query: string, scopeRegion?: string, scopeSubdomain?: string): Promise<DestSearchResult[]> {
  if (!query) return [];
  const lq = query.toLowerCase();
  const results: DestSearchResult[] = [];
  if (!existsSync(LOCAL_DEST_DIR)) return results;

  const allSas        = await readSubaccounts();
  const restrictedKeys = new Set(allSas.filter(sa => sa.restricted).map(sa => `${sa.region}/${sa.subdomain}`));
  const orgIndex = new Map<string, string>();
  for (const sa of allSas) {
    if (sa.manageDestinations && sa.org?.orgId) orgIndex.set(`${sa.region}/${sa.subdomain}`, sa.org.orgId);
  }

  const regions = await readdir(LOCAL_DEST_DIR).catch(() => [] as string[]);
  for (const region of regions) {
    if (scopeRegion && region !== scopeRegion) continue;
    const regionDir = join(LOCAL_DEST_DIR, region);
    try { if (!(await stat(regionDir)).isDirectory()) continue; } catch { continue; }
    const subdomains = await readdir(regionDir).catch(() => [] as string[]);
    for (const subdomain of subdomains) {
      if (scopeSubdomain && subdomain !== scopeSubdomain) continue;
      if (restrictedKeys.has(`${region}/${subdomain}`)) continue;
      const subDir = join(regionDir, subdomain);
      try { if (!(await stat(subDir)).isDirectory()) continue; } catch { continue; }
      const org_id = orgIndex.get(`${region}/${subdomain}`) ?? '';
      const files  = await readdir(subDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.deleted.json')) continue;
        const name = file.slice(0, -5);
        try {
          const obj = JSON.parse(await readFile(join(subDir, file), 'utf-8')) as Record<string, unknown>;
          if (name.toLowerCase().includes(lq)) {
            results.push({ region, subdomain, org_id, name, matchField: 'Name', matchValue: name });
            continue;
          }
          for (const [key, val] of Object.entries(obj)) {
            if (isSensitiveField(key)) continue;
            if (typeof val === 'string' && val.toLowerCase().includes(lq)) {
              results.push({ region, subdomain, org_id, name, matchField: key, matchValue: val });
              break;
            }
          }
        } catch { /* skip unreadable */ }
      }
    }
  }
  return results;
}

// ─── Destination API write (PUT with POST fallback) ──────────────────────────

async function pushToDestinationApi(
  region:    string,
  subdomain: string,
  name:      string,
  data:      Record<string, unknown>,
): Promise<void> {
  const allSas = await readSubaccounts();
  const sa     = allSas.find(s => s.region === region && s.subdomain === subdomain);
  if (!sa?.org?.orgId) {
    throw new Error(`No CF org found for ${region}/${subdomain} — cannot push to Destination API`);
  }

  const orgId    = sa.org.orgId;
  const orgName  = sa.org.orgName ?? '';
  const location = `${region}/${subdomain}/${name}`;

  const { orgs: keyStore, planGuids } = await loadKeyStore();
  const tokenStore   = await loadTokenStore();
  const cfLoginFailed = new Set<string>();

  const tokenResult = await resolveToken(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location);
  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);

  if ('error' in tokenResult) {
    throw new Error(`Cannot authenticate to Destination API for ${region}/${subdomain}: ${tokenResult.error}`);
  }

  const encodedBody = JSON.stringify(data);
  await withDestApiRetry(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location, tokenResult,
    async (auth) => {
      const baseUrl = `${auth.credential.uri}/destination-configuration/v1/subaccountDestinations`;
      const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };

      // Try PUT (update) first; fall back to POST (create) if destination doesn't exist yet
      const putRes = await fetchWithRateLimit(() => fetch(baseUrl, { method: 'PUT', headers, body: encodedBody }), baseUrl);
      if (putRes.ok) { logger.debug({ location }, 'Destination pushed to API via PUT'); return; }

      if (putRes.status === 404) {
        const postRes = await fetchWithRateLimit(() => fetch(baseUrl, { method: 'POST', headers, body: encodedBody }), baseUrl);
        if (postRes.ok) { logger.debug({ location }, 'Destination created in API via POST'); return; }
        const errText = await postRes.text().catch(() => '');
        throw new Error(`Destination API POST failed with HTTP ${postRes.status}: ${errText.slice(0, 300)}`);
      }

      const errText = await putRes.text().catch(() => '');
      throw new Error(`Destination API PUT failed with HTTP ${putRes.status}: ${errText.slice(0, 300)}`);
    });

  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);
}

// ─── Public: single-destination CRUD ─────────────────────────────────────────

const REDACTED_SENTINEL = '***';

export interface DestinationResponse {
  data:            Record<string, unknown>;
  sensitiveFields: string[];
}

function guardDestPath(region: string, subdomain: string, name: string): { jsonPath: string; changelogPath: string } {
  for (const s of [region, subdomain, name]) {
    if (!s || s.includes('..') || s.includes('/') || s.includes('\\')) {
      throw Object.assign(new Error('Invalid path segment'), { status: 400 });
    }
  }
  const base          = join(LOCAL_DEST_DIR, region, subdomain);
  const jsonPath      = join(base, `${name}.json`);
  const changelogPath = join(base, `${name}.changelog.md`);
  if (!jsonPath.startsWith(LOCAL_DEST_DIR + sep)) {
    throw Object.assign(new Error('Path traversal detected'), { status: 400 });
  }
  return { jsonPath, changelogPath };
}

export async function getDestination(region: string, subdomain: string, name: string): Promise<DestinationResponse | null> {
  const { jsonPath } = guardDestPath(region, subdomain, name);
  try {
    const data = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
    return { data, sensitiveFields: Object.keys(data).filter(isSensitiveField) };
  } catch { return null; }
}

export async function exportDestination(region: string, subdomain: string, name: string): Promise<Record<string, unknown> | null> {
  const { jsonPath } = guardDestPath(region, subdomain, name);
  try { return JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; }
  catch { return null; }
}

export async function saveDestinationEntry(
  region:   string,
  subdomain: string,
  name:     string,
  incoming: Record<string, unknown>,
  username: string,
): Promise<void> {
  const { jsonPath, changelogPath } = guardDestPath(region, subdomain, name);

  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; } catch { /* new */ }

  // Restore original sensitive values when the client sent the redacted sentinel
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    merged[k] = (v === REDACTED_SENTINEL && isSensitiveField(k) && k in existing) ? existing[k] : v;
  }

  // Push to Destination API first; propagate error if it fails
  await pushToDestinationApi(region, subdomain, name, merged);

  const diffLines: string[] = [];
  const allKeys = [...new Set([...Object.keys(existing), ...Object.keys(merged)])].sort();
  for (const k of allKeys) {
    const pv = JSON.stringify(existing[k] ?? null);
    const nv = JSON.stringify(merged[k] ?? null);
    if (pv === nv) continue;
    diffLines.push(isSensitiveField(k) ? `- ${k}: [redacted] → [redacted]` : `- ${k}: ${pv} → ${nv}`);
  }

  if (diffLines.length > 0) {
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const entry   = `## Manual update done by <${username}> at ${dateStr}\n${diffLines.join('\n')}\n\n`;
    const prev    = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
    await appendSubaccountGlobalChangelog('manual', 'update', username, [{ region, subdomain, name, action: 'updated' }])
      .catch(err => logger.error({ err }, 'Failed to write subaccount global changelog'));
    logger.info({ user: username, destination: `${region}.${subdomain}/${name}`, changes: diffLines }, 'Destination updated');
  } else {
    logger.info({ user: username, destination: `${region}.${subdomain}/${name}` }, 'Destination saved (no changes)');
  }

  await mkdir(join(LOCAL_DEST_DIR, region, subdomain), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf-8');
  if (diffLines.length > 0) notifyCallbacks();
  emit('dest', { region, subdomain, name, ts: Date.now() });
}

export async function getDestinationChangelog(region: string, subdomain: string, name: string): Promise<string> {
  const { changelogPath } = guardDestPath(region, subdomain, name);
  try { return await readFile(changelogPath, 'utf-8'); }
  catch { return ''; }
}

export async function listDestinations(): Promise<Record<string, Array<{ name: string; status: 'OK' }>>> {
  const result: Record<string, Array<{ name: string; status: 'OK' }>> = {};

  const allSas   = await readSubaccounts();
  const orgIndex = new Map<string, string>();
  for (const sa of allSas) {
    if (sa.manageDestinations && sa.org?.orgId) orgIndex.set(`${sa.region}/${sa.subdomain}`, sa.org.orgId);
  }

  if (!existsSync(LOCAL_DEST_DIR)) return result;

  const regions = await readdir(LOCAL_DEST_DIR).catch(() => [] as string[]);
  for (const region of regions) {
    const regionDir  = join(LOCAL_DEST_DIR, region);
    const subdomains = await readdir(regionDir).catch(() => [] as string[]);
    for (const subdomain of subdomains) {
      const org_id = orgIndex.get(`${region}/${subdomain}`);
      if (!org_id) continue;
      const files = await readdir(join(regionDir, subdomain)).catch(() => [] as string[]);
      const dests = files
        .filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'))
        .map(f => ({ name: f.slice(0, -5), status: 'OK' as const }));
      if (dests.length > 0) result[org_id] = dests;
    }
  }
  return result;
}

// ─── Startup + sync: restore globalRefreshTs from changelog ──────────────────
// Reads dest/changelog.md and updates globalRefreshTs from the topmost global
// refresh header. Called at module init and again whenever the file is synced
// from a remote peer, so local dev servers (and consumers) avoid triggering a
// redundant global refresh that was already done recently.
async function restoreGlobalRefreshTsFromChangelog(): Promise<void> {
  try {
    const text = await readFile(join(LOCAL_DEST_DIR, 'changelog.md'), 'utf-8');
    const ts   = parseGlobalRefreshTsFromChangelog(text);
    if (ts !== null && (globalRefreshTs === null || ts > globalRefreshTs)) {
      globalRefreshTs = ts;
      logger.info({ ts: new Date(ts).toISOString() }, 'destination globalRefreshTs restored from changelog');
    }
  } catch { /* changelog does not exist yet */ }
}

// Run on module load (server startup)
void restoreGlobalRefreshTsFromChangelog();

// Re-run whenever dest/changelog.md is downloaded from a remote peer
registerOnDestChangelogSynced(() => void restoreGlobalRefreshTsFromChangelog());
