import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getOrRefreshToken, fetchWithRateLimit } from './cfLoginService.js';
import { getRestrictedIds, getAutoSubaccountRefreshMs } from './configService.js';
import { readSubaccounts, type SubaccountEntry } from './subaccountsService.js';
import { readAodConfig, type AodConfig } from './aodConfigService.js';
import { updateAppFileAod } from './appService.js';
import { notifyCallbacks, registerOnDestChangelogSynced, registerOnDestSynced } from './syncService.js';
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

// Returns the active destination names in a directory, applying dedupe:
// if both {name}.json and {name}.deleted.json exist, the newer mtime wins.
async function listActiveDestNames(dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const jsonNames    = new Set<string>();
  const deletedNames = new Set<string>();
  for (const f of files) {
    if (f.endsWith('.deleted.json')) deletedNames.add(f.slice(0, -13));
    else if (f.endsWith('.json'))    jsonNames.add(f.slice(0, -5));
  }
  const result: string[] = [];
  for (const name of jsonNames) {
    if (!deletedNames.has(name)) {
      result.push(name);
    } else {
      try {
        const [jStat, dStat] = await Promise.all([
          stat(join(dir, `${name}.json`)),
          stat(join(dir, `${name}.deleted.json`)),
        ]);
        if (jStat.mtimeMs >= dStat.mtimeMs) result.push(name);
      } catch { /* skip unreadable */ }
    }
  }
  return result.sort();
}

async function getLocalDestinationNames(region: string, subdomain: string): Promise<string[]> {
  return listActiveDestNames(join(LOCAL_DEST_DIR, region, subdomain));
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

// Look up a key by a specific instance GUID (for space-level instances stored under their own GUID key).
function getKeyInfoForInstance(store: KeyStore, region: string, instanceGuid: string): FirstKeyInfo | null {
  const orgMap = store[region];
  if (!orgMap) return null;
  for (const orgEntry of Object.values(orgMap)) {
    const inst = orgEntry.destinationInstances.find(i => i.instanceId === instanceGuid);
    if (!inst) continue;
    const key = inst.serviceKeys[0];
    if (!key) continue;
    return { credential: key.credential, instanceId: inst.instanceId, instanceName: inst.instanceName, keyId: key.keyId, keyName: key.keyName };
  }
  return null;
}

// Store a key for a specific instance under a dedicated per-instance bucket (key = instanceGuid).
function setInstanceKeyEntry(store: KeyStore, region: string, instanceGuid: string, instanceName: string, keyId: string, keyName: string, credential: DestCredentials): void {
  if (!store[region]) store[region] = {};
  store[region]![instanceGuid] = { orgName: instanceName, destinationInstances: [{ instanceId: instanceGuid, instanceName, serviceKeys: [{ keyId, keyName, credential }] }] };
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

// Token helpers keyed by instanceGuid (for space-level instances).
function getTokenForInstance(store: TokenStore, region: string, instanceGuid: string): TokenInfo | null {
  const orgMap = store[region];
  if (!orgMap) return null;
  for (const orgEntry of Object.values(orgMap)) {
    const inst = orgEntry.destinationInstances.find(i => i.instanceId === instanceGuid);
    if (inst) return { token: inst.token, instanceId: inst.instanceId, instanceName: inst.instanceName };
  }
  return null;
}

function setInstanceTokenEntry(store: TokenStore, region: string, instanceGuid: string, instanceName: string, token: DestToken): void {
  if (!store[region]) store[region] = {};
  store[region]![instanceGuid] = { orgName: instanceName, destinationInstances: [{ instanceId: instanceGuid, instanceName, token }] };
}

/**
 * Resolve auth for a known space-level destination service instance.
 * Unlike resolveToken (which discovers instances from the org), this function
 * fetches credentials for the specific instanceGuid we already know from CF discovery.
 */
async function resolveInstanceToken(
  region:        string,
  instanceGuid:  string,
  instanceName:  string,
  keyStore:      KeyStore,
  tokenStore:    TokenStore,
  cfLoginFailed: Set<string>,
  location:      string,
): Promise<TokenResult> {
  // 1. Valid cached token for this specific instance → use immediately
  const tokenInfo = getTokenForInstance(tokenStore, region, instanceGuid);
  const keyInfo   = getKeyInfoForInstance(keyStore, region, instanceGuid);

  if (tokenInfo && tokenInfo.token.expires_at - Date.now() > 60_000 && keyInfo) {
    return { accessToken: tokenInfo.token.access_token, credential: keyInfo.credential };
  }

  // 2. Try refresh_token
  if (tokenInfo?.token.refresh_token) {
    try {
      const refreshed = await refreshDestToken(tokenInfo.token);
      setInstanceTokenEntry(tokenStore, region, instanceGuid, instanceName, refreshed);
      if (keyInfo) return { accessToken: refreshed.access_token, credential: keyInfo.credential };
    } catch (err) {
      logger.debug({ location, err }, 'Instance destination token refresh failed — will use service key');
    }
  }

  // 3. Use cached key for a new client_credentials token
  if (keyInfo) {
    try {
      const token = await acquireDestToken(keyInfo.credential);
      setInstanceTokenEntry(tokenStore, region, instanceGuid, instanceName, token);
      return { accessToken: token.access_token, credential: keyInfo.credential };
    } catch (err) {
      const errMsg = String(err);
      const isCredErr = errMsg.includes('HTTP 401') || errMsg.includes('HTTP 403') ||
                        errMsg.includes('Bad credentials') || errMsg.includes('Incomplete');
      if (!isCredErr) {
        logger.debug({ location, err }, 'Instance token from existing key failed (non-credential error)');
        return { error: `Token acquisition failed: ${errMsg}` };
      }
      // Stale key — fall through to CF API discovery
      logger.info({ location, err }, 'Cached instance key rejected — re-discovering via CF API');
      delete keyStore[region]?.[instanceGuid];
    }
  }

  // 4. Discover credentials via CF API for this specific instance GUID
  if (cfLoginFailed.has(region)) {
    return { error: `CF login failed for region ${region}` };
  }

  try {
    let keys = await fetchDestKeysForInstances(region, [instanceGuid]);
    if (keys.length === 0) {
      // No service key yet — create btp-admin-sk and use it
      const newKey = await ensureDestServiceKey(region, instanceGuid);
      keys = [newKey];
    }
    const key        = keys[0]!;
    const credential = await fetchDestCredentials(region, key.keyId);
    setInstanceKeyEntry(keyStore, region, instanceGuid, instanceName, key.keyId, key.keyName, credential);
    const token = await acquireDestToken(credential);
    setInstanceTokenEntry(tokenStore, region, instanceGuid, instanceName, token);
    logger.info({ region, instanceGuid, keyId: key.keyId, location }, 'Space instance service key acquired via CF API');
    return { accessToken: token.access_token, credential };
  } catch (err) {
    const msg = String(err);
    const isCfAuth = msg.includes('No CF credentials available') ||
                     (msg.includes('HTTP 401') && msg.includes('oauth/token'));
    if (isCfAuth) {
      logger.warn({ region, err }, `Not able to login to CF at ${region}`);
      cfLoginFailed.add(region);
      return { error: `CF login failed for region ${region}` };
    }
    logger.info({ region, instanceGuid, location, err }, 'Cannot get credential for space destination instance');
    return { error: `Cannot fetch instance credential: ${msg}` };
  }
}

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

async function cfPost(region: string, path: string, body: Record<string, unknown>): Promise<{ status: number; data: unknown; location: string }> {
  const token = await getOrRefreshToken(region);
  const url   = `${token.api_url}${path}`;
  const res   = await fetchWithRateLimit(() => fetch(url, {
    method:  'POST',
    headers: { Authorization: `${token.token_type} ${token.access_token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }), url);
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '');
    throw new Error(`CF POST ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data, location: res.headers.get('Location') ?? '' };
}

async function pollCfJob(region: string, jobPath: string): Promise<void> {
  const path = jobPath.startsWith('/') ? jobPath : new URL(jobPath).pathname;
  for (let i = 0; i < 30; i++) {
    await new Promise<void>(r => setTimeout(r, 2_000));
    const data = await cfGet(region, path) as { state: string; errors?: Array<{ detail?: string }> };
    if (data.state === 'COMPLETE') return;
    if (data.state === 'FAILED') {
      throw new Error(`CF job ${path} failed: ${data.errors?.[0]?.detail ?? 'unknown error'}`);
    }
  }
  throw new Error(`CF job ${path} timed out after 60 s`);
}

// Ensures a service key named 'btp-admin-sk' exists for the given service instance.
// Creates one via the CF API if not present, waiting for async job completion.
async function ensureDestServiceKey(region: string, instanceGuid: string): Promise<DestKeyWithInstance> {
  const KEY_NAME = 'btp-admin-sk';
  const checkPath = `/v3/service_credential_bindings?service_instance_guids=${instanceGuid}&names=${encodeURIComponent(KEY_NAME)}&type=key&per_page=1`;

  const existing = await cfGet(region, checkPath) as { resources?: Array<{ guid: string; name: string }> };
  if ((existing.resources?.length ?? 0) > 0) {
    const r = existing.resources![0]!;
    logger.debug({ region, instanceGuid, keyId: r.guid }, `Reusing existing "${KEY_NAME}" service key`);
    return { keyId: r.guid, keyName: r.name, instanceId: instanceGuid };
  }

  logger.info({ region, instanceGuid }, `No service key found — creating "${KEY_NAME}" for destination instance`);
  const result = await cfPost(region, '/v3/service_credential_bindings', {
    type: 'key',
    name: KEY_NAME,
    relationships: { service_instance: { data: { guid: instanceGuid } } },
  });

  if (result.status === 202 && result.location) {
    await pollCfJob(region, result.location);
  }

  const created = await cfGet(region, checkPath) as { resources?: Array<{ guid: string; name: string }> };
  const key = created.resources?.[0];
  if (!key) throw new Error(`Service key "${KEY_NAME}" not found after creation for instance ${instanceGuid}`);
  logger.info({ region, instanceGuid, keyId: key.guid }, `Created "${KEY_NAME}" service key`);
  return { keyId: key.guid, keyName: key.name, instanceId: instanceGuid };
}

interface DestInstanceInfo { instanceId: string; instanceName: string }
interface DestKeyRaw       { keyId: string; keyName: string }

async function fetchDestServicePlanGuids(region: string): Promise<string> {
  // Fetch ALL plans for the destination service offering (may include lite, trial, standard, etc.).
  // Returns comma-separated GUIDs for use in service_plan_guids= filters.
  // Note: service_offering_names IS supported on /v3/service_plans but NOT on /v3/service_instances.
  const data = await cfGet(region, '/v3/service_plans?service_offering_names=destination&per_page=100') as {
    resources?: Array<{ guid: string }>;
  };
  const guids = (data.resources ?? []).map(r => r.guid).filter(Boolean);
  if (guids.length === 0) throw new Error('No destination service plans found in region');
  return guids.join(',');
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
      planGuid = await fetchDestServicePlanGuids(region);
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
    // Whole-JSON comparison — all fields considered (no IGNORED_DIFF_KEYS for destinations)
    if (JSON.stringify(existing) === JSON.stringify(incoming)) return 'unchanged';
    const diff = diffDestination(existing, incoming);
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
  refreshed:          number;
  received:           number;
  created:            number;
  updated:            number;
  deleted:            number;
  errors:             string[];
  skipped?:           boolean;
}

interface DestChange { region: string; subdomain: string; name: string; action: 'created' | 'updated' | 'deleted'; spaceName?: string; instanceName?: string; instanceGuid?: string }

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
  action:   'refresh' | 'update' | 'import' | 'delete',
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

  const modeLabel  = mode === 'auto' ? 'Auto' : 'Manual';
  const dateStr    = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const created    = changes.filter(c => c.action === 'created').length;
  const updated    = changes.filter(c => c.action === 'updated').length;
  const deleted    = changes.filter(c => c.action === 'deleted').length;
  const hasInst    = changes.some(c => c.spaceName);
  const scopeWord  = action === 'import' ? (hasInst ? 'subaccount/instances' : 'subaccount') : 'subaccount';
  const summary    = action === 'import'
    ? `Import: created ${created}, updated ${updated} destinations`
    : action === 'delete'
    ? `Manual delete: deleted ${deleted} destinations`
    : `${action === 'update' ? 'Manual update' : 'Refresh'}: created ${created}, updated ${updated} and deleted ${deleted} destinations`;

  let entry = `## [${modeLabel}] ${scopeWord} destinations ${action} by <${username}> at ${dateStr}\n\n${summary}`;
  for (const c of changes) {
    const histPath = c.spaceName
      ? `/destinations/${encodeURIComponent(c.region)}/${encodeURIComponent(c.subdomain)}/${encodeURIComponent(c.spaceName)}/${encodeURIComponent(c.instanceName ?? '')}/${encodeURIComponent(c.instanceGuid ?? '')}/${encodeURIComponent(c.name)}/history`
      : `/destinations/${encodeURIComponent(c.region)}/${encodeURIComponent(c.subdomain)}/${encodeURIComponent(c.name)}/history`;
    const scopeLabel = c.spaceName ? ` > ${c.spaceName} > ${c.instanceName}` : '';
    entry += `\n- ${c.action}: ${c.region} > ${c.subdomain}${scopeLabel} → ${c.name} ([History](${histPath}))`;
  }
  entry += '\n\n';

  const prev = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');
}

// Writes a per-destination changelog entry and a global changelog entry when AOD
// proxy is installed, updated (proxy URL changed), or uninstalled for a destination.
async function appendAodDestChangelog(
  instanceDir: string,
  destName:    string,
  before:      Record<string, unknown>,
  after:       Record<string, unknown>,
  action:      'installed' | 'updated' | 'uninstalled',
  username:    string,
  inst:        { region: string; subdomain: string; spaceName: string; name: string; guid: string },
): Promise<void> {
  const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Per-destination .changelog.md
  const changelogPath = join(instanceDir, `${destName}.changelog.md`);
  const diff  = diffDestination(before, after);
  const entry = `## AOD ${action} by <${username}> at ${dateStr}\n${diff}\n\n`;
  const prev  = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');

  // Global dest/changelog.md (with size-based rotation)
  await mkdir(LOCAL_DEST_DIR, { recursive: true });
  const globalPath = join(LOCAL_DEST_DIR, 'changelog.md');
  try {
    const info = await stat(globalPath);
    if (info.size > 2 * 1024 * 1024) {
      const archiveName = `changelog.${formatChangelogTs(new Date())}.md`;
      await rename(globalPath, join(LOCAL_DEST_DIR, archiveName));
      logger.info({ archiveName }, 'Rotated global changelog');
    }
  } catch { /* may not exist yet */ }
  const histPath = `/destinations/${encodeURIComponent(inst.region)}/${encodeURIComponent(inst.subdomain)}/${encodeURIComponent(inst.spaceName)}/${encodeURIComponent(inst.name)}/${encodeURIComponent(inst.guid)}/${encodeURIComponent(destName)}/history`;
  const scopeLabel   = `${inst.region} > ${inst.subdomain} > ${inst.spaceName} > ${inst.name}`;
  const globalEntry  = `## [Auto] AOD ${action} by <${username}> at ${dateStr}\n\n- ${action}: ${scopeLabel} → ${destName} ([History](${histPath}))\n\n`;
  const prevGlobal   = existsSync(globalPath) ? await readFile(globalPath, 'utf-8') : '';
  await writeFile(globalPath, globalEntry + prevGlobal, 'utf-8');
}

// ─── AOD: routes table + proxy install/uninstall ─────────────────────────────

const CFAPPS_URL_RE = /https?:\/\/[^/]+\.cfapps\.[^/]+\.hana\.ondemand\.com/i;

async function buildRoutesTable(subaccounts: SubaccountEntry[]): Promise<Map<string, string>> {
  const routesTable = new Map<string, string>();

  // Group AOD spaces by region
  const byRegion = new Map<string, string[]>();
  for (const sa of subaccounts) {
    if (!sa.org) continue;
    for (const sp of sa.org.spaces) {
      if (!sp.aod) continue;
      const arr = byRegion.get(sa.region) ?? [];
      arr.push(sp.spaceId);
      byRegion.set(sa.region, arr);
    }
  }

  if (byRegion.size === 0) return routesTable;

  for (const [region, spaceGuids] of byRegion) {
    const guids = spaceGuids.join(',');
    let path: string | null = `/v3/routes?space_guids=${encodeURIComponent(guids)}&per_page=5000`;
    while (path) {
      try {
        const data = await cfGet(region, path) as {
          resources?: Array<{ url?: string; destinations?: Array<{ app?: { guid?: string } }> }>;
          pagination?: { next?: { href?: string } };
        };
        for (const r of data.resources ?? []) {
          const url    = r.url ? `https://${r.url}` : '';
          const appGuid = r.destinations?.[0]?.app?.guid ?? '';
          if (url && appGuid) routesTable.set(url, appGuid);
        }
        const nextHref = data.pagination?.next?.href;
        if (!nextHref) break;
        try { path = new URL(nextHref).pathname + new URL(nextHref).search; } catch { break; }
      } catch (err) {
        logger.warn({ region, err }, 'AOD: failed to fetch routes for region');
        break;
      }
    }
  }

  logger.info({ routes: routesTable.size }, 'AOD routes table built');
  return routesTable;
}

async function applyAodToDestination(
  dest:        Record<string, unknown>,
  spaceAod:    boolean,
  region:      string,
  subdomain:   string,
  accessToken: string,
  credential:  DestCredentials,
  routesTable: Map<string, string>,
  aodConfig:   AodConfig,
  label:       string,
): Promise<Record<string, unknown> | null> {
  const url  = String(dest['URL'] ?? '');
  const isCandidate = dest['ProxyType'] === 'Internet' && dest['Authentication'] === 'NoAuthentication' && CFAPPS_URL_RE.test(url);
  if (!isCandidate) return null;

  const hasProxy = 'URL.headers.x-aod-app-url' in dest;

  if (spaceAod && hasProxy) {
    // Already installed — check if proxy URL needs updating
    const proxyUrl = aodConfig.regionProxyEndpoint?.[region];
    if (!proxyUrl || url === proxyUrl) return null;
    const updated = { ...dest, URL: proxyUrl };
    await pushAodDestination(region, credential, accessToken, updated, label);
    logger.info({ label, from: url, to: proxyUrl }, 'AOD: proxy URL updated');
    return updated;
  }

  if (spaceAod && !hasProxy) {
    // Install proxy
    const proxyUrl = aodConfig.regionProxyEndpoint?.[region];
    if (!proxyUrl) {
      logger.warn({ label, region }, `AOD: no regionProxyEndpoint configured for ${region} — skipping AOD install`);
      return null;
    }
    const appGuid = routesTable.get(url);
    if (!appGuid) {
      logger.warn({ label, url }, 'AOD: no app.guid found in routes table for URL — skipping AOD install');
      return null;
    }
    const updated = {
      ...dest,
      URL:                            proxyUrl,
      'URL.headers.x-aod-app-url':   url,
      'URL.headers.x-aod-app-id':    appGuid,
      'URL.headers.x-aod-region':    region,
      'URL.headers.x-aod-subdomain': subdomain,
    };
    await pushAodDestination(region, credential, accessToken, updated, label);
    logger.info({ label, url, proxyUrl }, `AOD: ${label}->${url} has been switched to AOD`);
    return updated;
  }

  if (!spaceAod && hasProxy) {
    // Uninstall proxy — restore original URL
    const originalUrl = String(dest['URL.headers.x-aod-app-url'] ?? '');
    if (!originalUrl || originalUrl === url) return null;
    const updated: Record<string, unknown> = { ...dest, URL: originalUrl };
    delete updated['URL.headers.x-aod-app-url'];
    delete updated['URL.headers.x-aod-app-id'];
    delete updated['URL.headers.x-aod-region'];
    delete updated['URL.headers.x-aod-subdomain'];
    await pushAodDestination(region, credential, accessToken, updated, label);
    logger.info({ label, to: originalUrl }, `AOD: ${label}->${originalUrl} has been reverted (AOD uninstalled)`);
    return updated;
  }

  return null;
}

async function pushAodDestination(region: string, credential: DestCredentials, accessToken: string, dest: Record<string, unknown>, label: string): Promise<void> {
  const baseUrl = `${credential.uri}/destination-configuration/v1/instanceDestinations`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const body    = JSON.stringify(dest);
  const putRes  = await fetchWithRateLimit(() => fetch(baseUrl, { method: 'PUT', headers, body }), baseUrl);
  if (putRes.ok) return;
  if (putRes.status === 404) {
    const postRes = await fetchWithRateLimit(() => fetch(baseUrl, { method: 'POST', headers, body }), baseUrl);
    if (postRes.ok) return;
    const errText = await postRes.text().catch(() => '');
    throw new Error(`AOD dest push POST failed at ${label}: HTTP ${postRes.status}: ${errText.slice(0, 200)}`);
  }
  const errText = await putRes.text().catch(() => '');
  throw new Error(`AOD dest push PUT failed at ${label}: HTTP ${putRes.status}: ${errText.slice(0, 200)}`);
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

  // Build routes table for AOD proxy install/uninstall across all target subaccounts
  const routesTable = await buildRoutesTable(targetSas);

  // Warnings and errors collected during the run, keyed with location for display
  const issues: string[] = [];
  const cfLoginFailed = new Set<string>();
  const destChanges: DestChange[] = [];
  let refreshed = 0, received = 0, created = 0, updated = 0, deleted = 0;

  emit('refresh-destinations', { type: 'progress', scope: 'global', current: 0, total, name: 'Initializing…', received: 0 });

  for (let idx = 0; idx < targetSas.length; idx++) {
    const sa       = targetSas[idx]!;
    const location = `${sa.region}/${sa.subdomain}`;

    emit('refresh-destinations', { type: 'progress', scope: 'global', current: idx + 1, total, name: location, received });

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
        const deletedPath = join(destDir, `${destName}.deleted.json`);
        await rename(join(destDir, fname), deletedPath);
        const now = new Date(); await utimes(deletedPath, now, now);
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

    // Immediately after SA-level refresh, refresh instance destinations for any manageDest spaces
    // within this same subaccount — counter stays at idx+1, name updates to show space/instance.
    if ((sa.org?.spaces ?? []).some(s => s.manageDest)) {
      const spaceResult = await refreshSpaceDestinations([sa], username, mode,
        (_spaceDone, _spacesTotal, instLabel, spaceReceivedSoFar) => {
          emit('refresh-destinations', { type: 'progress', scope: 'global', current: idx + 1, total, name: instLabel, received: received + spaceReceivedSoFar });
        },
        undefined,
        routesTable,
      );
      if (spaceResult.errors.length > 0) {
        logger.warn({ location, errors: spaceResult.errors }, 'Some space destination refreshes failed');
        issues.push(...spaceResult.errors);
      }
      created += spaceResult.created;
      updated += spaceResult.updated;
      deleted += spaceResult.deleted;
    }
  }

  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);

  // Rename subdomain dirs for SAs no longer in manageDestinations list
  const managedPaths = new Set(targetSas.map(sa => `${sa.region}/${sa.subdomain}`));
  const regionEntries = await readdir(LOCAL_DEST_DIR, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  for (const regionEnt of regionEntries) {
    if (!regionEnt.isDirectory()) continue;
    const region    = regionEnt.name;
    const regionDir = join(LOCAL_DEST_DIR, region);
    const subEntries = await readdir(regionDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const subEnt of subEntries) {
      if (!subEnt.isDirectory() || subEnt.name.endsWith('.deleted')) continue;
      const subdomain = subEnt.name;
      if (managedPaths.has(`${region}/${subdomain}`)) continue;
      const subDir     = join(regionDir, subdomain);
      const deletedDir = join(regionDir, `${subdomain}.deleted`);
      try {
        await rename(subDir, deletedDir);
        logger.info({ region, subdomain }, 'Subaccount no longer manageDestinations — folder renamed to .deleted');
      } catch (err) {
        logger.warn({ region, subdomain, err }, 'Failed to rename non-managed subaccount folder to .deleted');
      }
    }
  }

  globalRefreshTs = Date.now();

  await writeGlobalChangelog(username, mode, refreshed, total, received, created, updated, deleted, isDeltaMode, destChanges).catch(
    err => logger.error({ err }, 'Failed to write global changelog'),
  );

  notifyCallbacks();
  emit('dest', { ts: Date.now() });

  emitImmediate('refresh-destinations', {
    type: 'done', scope: 'global',
    refreshed, total, received,
    created, updated, deleted,
    issues,
  });

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
  const routesTable = await buildRoutesTable([sa]);

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
        const deletedPath2 = join(destDir, `${destName}.deleted.json`);
        await rename(join(destDir, fname), deletedPath2);
        const now2 = new Date(); await utimes(deletedPath2, now2, now2);
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

  // Refresh space-level instance destinations for this subaccount.
  // Progress: 1 (SA) + N instances. Emit inst-progress so the modal can show a real counter.
  emitImmediate('refresh-destinations', {
    type: 'inst-progress', scope: 'subaccount',
    region: sa.region, subdomain: sa.subdomain,
    current: 1, total: 1, name: 'SA destinations',
  });
  const spaceResult = await refreshSpaceDestinations([sa], username, mode, undefined, (instsDone, instsTotal, instLabel) => {
    emit('refresh-destinations', {
      type: 'inst-progress', scope: 'subaccount',
      region: sa.region, subdomain: sa.subdomain,
      current: 1 + instsDone, total: 1 + instsTotal, name: instLabel,
    });
  }, routesTable);
  if (spaceResult.errors.length > 0) {
    logger.warn({ errors: spaceResult.errors }, 'Some space destination refreshes failed during subaccount refresh');
  }

  return { refreshed, received, created: created + spaceResult.created, updated: updated + spaceResult.updated, deleted: deleted + spaceResult.deleted, errors: [...issues, ...spaceResult.errors] };
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
  const key        = `${region}/${subdomain}`;
  const delta      = getAutoSubaccountRefreshMs();
  const lastSa     = lastRefreshTs.get(key) ?? 0;
  const lastGlobal = globalRefreshTs ?? 0;
  const last       = Math.max(lastSa, lastGlobal);
  const stale      = force || (delta > 0 && Date.now() - last > delta);

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

const REDACTED_SENTINEL = '***';

export interface DestinationResponse {
  data:            Record<string, unknown>;
  sensitiveFields: string[];
}

// ─── Public: space-level destination instances ───────────────────────────────

export interface SpaceInstance {
  spaceName:    string;
  instanceGuid: string;
  instanceName: string;
}

async function guardSpaceDestPath(
  region: string, subdomain: string, spaceName: string, instanceGuid: string, name: string,
): Promise<{ instanceDir: string; jsonPath: string; changelogPath: string }> {
  for (const s of [region, subdomain, spaceName, instanceGuid, name]) {
    if (!s || s.includes('..') || s.includes('/') || s.includes('\\')) {
      throw Object.assign(new Error('Invalid path segment'), { status: 400 });
    }
  }
  // Actual directory name is {guid}_{instanceName} — find by GUID prefix, excluding .deleted dirs
  const subDir      = join(LOCAL_DEST_DIR, region, subdomain, spaceName);
  const instEntries = await readdir(subDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  const instDirEnt  = instEntries.find(e => e.isDirectory() && !e.name.endsWith('.deleted') && e.name.startsWith(`${instanceGuid}_`));
  const instanceDir = join(subDir, instDirEnt ? instDirEnt.name : instanceGuid);
  return {
    instanceDir,
    jsonPath:      join(instanceDir, `${name}.json`),
    changelogPath: join(instanceDir, `${name}.changelog.md`),
  };
}

export async function getSpaceInstances(region: string, subdomain: string): Promise<SpaceInstance[]> {
  const subDir = join(LOCAL_DEST_DIR, region, subdomain);
  const result: SpaceInstance[] = [];
  const spaceEntries = await readdir(subDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  for (const spaceEnt of spaceEntries) {
    if (!spaceEnt.isDirectory() || spaceEnt.name.endsWith('.deleted')) continue;
    const spaceName   = spaceEnt.name;
    const spaceDir    = join(subDir, spaceName);
    const instEntries = await readdir(spaceDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);

    // Build per-GUID map to apply dedupe (active vs .deleted folder, newer mtime wins)
    const byGuid = new Map<string, { active?: string; deleted?: string }>();
    for (const instEnt of instEntries) {
      if (!instEnt.isDirectory()) continue;
      const isDeleted = instEnt.name.endsWith('.deleted');
      const baseName  = isDeleted ? instEnt.name.slice(0, -8) : instEnt.name;
      const idx       = baseName.indexOf('_');
      if (idx < 0) continue;
      const guid  = baseName.slice(0, idx);
      const entry = byGuid.get(guid) ?? {};
      if (isDeleted) entry.deleted = instEnt.name; else entry.active = instEnt.name;
      byGuid.set(guid, entry);
    }

    for (const [guid, entry] of byGuid) {
      let dirName: string;
      if (entry.active && entry.deleted) {
        try {
          const aMs = (await stat(join(spaceDir, entry.active))).mtimeMs;
          const dMs = (await stat(join(spaceDir, entry.deleted))).mtimeMs;
          if (aMs < dMs) continue; // deleted folder is newer → skip
        } catch { continue; }
        dirName = entry.active;
      } else if (entry.active) {
        dirName = entry.active;
      } else {
        continue; // only deleted → skip
      }
      const us = dirName.indexOf('_');
      result.push({ spaceName, instanceGuid: guid, instanceName: dirName.slice(us + 1) });
    }
  }
  return result;
}

export async function getInstanceDestinationNames(
  region: string, subdomain: string, spaceName: string, instanceGuid: string,
): Promise<string[]> {
  const subDir = join(LOCAL_DEST_DIR, region, subdomain, spaceName);
  const instEntries = await readdir(subDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  const instDirEnt  = instEntries.find(e => e.isDirectory() && !e.name.endsWith('.deleted') && e.name.startsWith(`${instanceGuid}_`));
  if (!instDirEnt) return [];
  return listActiveDestNames(join(subDir, instDirEnt.name));
}

export async function getInstanceDestination(
  region: string, subdomain: string, spaceName: string, instanceGuid: string, name: string,
): Promise<DestinationResponse | null> {
  const { jsonPath } = await guardSpaceDestPath(region, subdomain, spaceName, instanceGuid, name);
  try {
    const data = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
    return { data, sensitiveFields: Object.keys(data).filter(isSensitiveField) };
  } catch { return null; }
}

export async function getInstanceDestinationChangelog(
  region: string, subdomain: string, spaceName: string, instanceGuid: string, name: string,
): Promise<string> {
  const { changelogPath } = await guardSpaceDestPath(region, subdomain, spaceName, instanceGuid, name);
  try { return await readFile(changelogPath, 'utf-8'); } catch { return ''; }
}

export async function exportInstanceDestination(
  region: string, subdomain: string, spaceName: string, instanceGuid: string, name: string,
): Promise<Record<string, unknown> | null> {
  const { jsonPath } = await guardSpaceDestPath(region, subdomain, spaceName, instanceGuid, name);
  try { return JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

async function persistSpaceDestination(
  instanceDir: string,
  name:        string,
  incoming:    Record<string, unknown>,
  username:    string,
): Promise<PersistResult> {
  const filePath      = join(instanceDir, `${name}.json`);
  const changelogPath = join(instanceDir, `${name}.changelog.md`);
  const incomingJson  = JSON.stringify(incoming, null, 2);

  if (existsSync(filePath)) {
    const existing = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
    if (JSON.stringify(existing) === JSON.stringify(incoming)) return 'unchanged';
    const diff = diffDestination(existing, incoming);
    if (!diff) return 'unchanged';
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const heading = `## Refreshed by <${username}> at ${dateStr}`;
    const entry   = `${heading}\n${diff}\n\n`;
    const prev    = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
    await writeFile(filePath, incomingJson, 'utf-8');
    return 'updated';
  }

  const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const entry   = `## Created by <${username}> at ${dateStr}\n\n`;
  await writeFile(filePath, incomingJson, 'utf-8');
  await writeFile(changelogPath, entry, 'utf-8');
  return 'created';
}

async function fetchCfPaginatedResources<T>(region: string, initialPath: string): Promise<T[]> {
  const all: T[] = [];
  let path: string | null = initialPath;
  while (path) {
    const data = await cfGet(region, path) as { resources?: T[]; pagination?: { next?: { href?: string } } };
    all.push(...(data.resources ?? []));
    const nextHref = data.pagination?.next?.href;
    if (!nextHref) break;
    // Extract path+query from the full href
    try { path = new URL(nextHref).pathname + new URL(nextHref).search; }
    catch { break; }
  }
  return all;
}

interface SpaceServiceInstance {
  guid:      string;
  name:      string;
  spaceId:   string;
  spaceName: string;
  subdomain: string;
  region:    string;
  aod?:      boolean;
}

export async function refreshSpaceDestinations(
  subaccounts:    import('./subaccountsService.js').SubaccountEntry[],
  username:       string,
  mode:           'auto' | 'manual',
  onProgress?:    (current: number, total: number, label: string, received: number) => void,
  onInstProgress?:(current: number, total: number, label: string) => void,
  routesTable:    Map<string, string> = new Map(),
): Promise<{ created: number; updated: number; deleted: number; errors: string[] }> {
  // Collect all (region, subdomain, spaceId, spaceName) tuples with manageDest=true
  type SpaceTodo = { region: string; subdomain: string; spaceId: string; spaceName: string; orgId: string; aod?: boolean };
  const todos: SpaceTodo[] = [];
  for (const sa of subaccounts) {
    if (!sa.org?.orgId) continue;
    for (const sp of sa.org.spaces) {
      if (sp.manageDest) todos.push({ region: sa.region, subdomain: sa.subdomain, spaceId: sp.spaceId, spaceName: sp.spaceName, orgId: sa.org.orgId, aod: sp.aod });
    }
  }
  if (todos.length === 0) return { created: 0, updated: 0, deleted: 0, errors: [] };

  const issues: string[] = [];
  let created = 0, updated = 0, deleted = 0, done = 0;

  const { orgs: keyStore, planGuids: instancePlanGuids } = await loadKeyStore();
  const tokenStore    = await loadTokenStore();
  const cfLoginFailed = new Set<string>();

  // ── Step A: discover destination service instances per region ──────────────
  const byRegion = new Map<string, SpaceTodo[]>();
  for (const t of todos) {
    const arr = byRegion.get(t.region) ?? [];
    arr.push(t);
    byRegion.set(t.region, arr);
  }

  const spaceInstances: SpaceServiceInstance[] = [];
  for (const [region, regionTodos] of byRegion) {
    // Resolve destination service plan GUIDs for this region.
    // /v3/service_instances does not support service_offering_names — must use service_plan_guids.
    // Reuse cached value from instancePlanGuids (shared with the SA-level resolveToken path).
    let planGuidsCsv = instancePlanGuids[region];
    if (!planGuidsCsv) {
      try {
        planGuidsCsv = await fetchDestServicePlanGuids(region);
        instancePlanGuids[region] = planGuidsCsv;
        logger.debug({ region, planGuidsCsv }, 'Cached destination service plan guids for space instance discovery');
      } catch (err) {
        const msg = `CF destination service plan lookup failed for region ${region}: ${String(err)}`;
        logger.error({ region, err }, msg);
        issues.push(msg);
        continue;
      }
    }

    const spaceGuids = regionTodos.map(t => t.spaceId).join(',');
    try {
      const resources = await fetchCfPaginatedResources<{
        guid: string; name: string;
        relationships?: { space?: { data?: { guid?: string } } };
      }>(region, `/v3/service_instances?service_plan_guids=${encodeURIComponent(planGuidsCsv)}&space_guids=${encodeURIComponent(spaceGuids)}&per_page=5000`);

      for (const r of resources) {
        const spaceGuid = r.relationships?.space?.data?.guid ?? '';
        const todo      = regionTodos.find(t => t.spaceId === spaceGuid);
        if (!todo) continue;
        spaceInstances.push({
          guid:      r.guid,
          name:      r.name,
          spaceId:   todo.spaceId,
          spaceName: todo.spaceName,
          subdomain: todo.subdomain,
          region,
          aod:       todo.aod,
        });
      }
    } catch (err) {
      const msg = `CF service instances fetch failed for region ${region}: ${String(err)}`;
      logger.error({ region, err }, msg);
      issues.push(msg);
    }
  }

  // ── Step A2: mark obsolete instances (exist on disk but no longer in CF) ──────
  // Build index of CF-known GUIDs per (region/subdomain/spaceName) key.
  const cfGuids = new Map<string, Set<string>>();
  for (const inst of spaceInstances) {
    const k = `${inst.region}/${inst.subdomain}/${inst.spaceName}`;
    const s = cfGuids.get(k) ?? new Set<string>();
    s.add(inst.guid);
    cfGuids.set(k, s);
  }

  for (const todo of todos) {
    const spaceKey   = `${todo.region}/${todo.subdomain}/${todo.spaceName}`;
    const knownGuids = cfGuids.get(spaceKey) ?? new Set<string>();
    const spaceDir   = join(LOCAL_DEST_DIR, todo.region, todo.subdomain, todo.spaceName);
    const instEntries = await readdir(spaceDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const instEnt of instEntries) {
      if (!instEnt.isDirectory() || instEnt.name.endsWith('.deleted')) continue;
      const sepIdx = instEnt.name.indexOf('_');
      if (sepIdx < 0) continue;
      const guid = instEnt.name.slice(0, sepIdx);
      if (knownGuids.has(guid)) continue; // still present in CF — skip
      // Instance removed from CF: count active destinations then rename folder to {name}.deleted
      const instanceDir  = join(spaceDir, instEnt.name);
      const files        = await readdir(instanceDir).catch(() => [] as string[]);
      const activeCount  = files.filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json')).length;
      const deletedDirPath = join(spaceDir, `${instEnt.name}.deleted`);
      try {
        await rename(instanceDir, deletedDirPath);
        deleted += activeCount;
        logger.info({ spaceKey, instance: instEnt.name, count: activeCount }, 'Destination service instance removed from CF — folder renamed to .deleted');
      } catch (err) {
        logger.warn({ spaceKey, instance: instEnt.name, err }, 'Failed to rename removed instance folder to .deleted');
      }
    }
  }

  // ── Step A2b: rename space dirs no longer in manageDest ───────────────────
  for (const sa of subaccounts) {
    if (!sa.org) continue;
    const managedSpaceNames = new Set(
      todos.filter(t => t.region === sa.region && t.subdomain === sa.subdomain).map(t => t.spaceName),
    );
    const subDir      = join(LOCAL_DEST_DIR, sa.region, sa.subdomain);
    const spaceEntries = await readdir(subDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const spaceEnt of spaceEntries) {
      if (!spaceEnt.isDirectory() || spaceEnt.name.endsWith('.deleted')) continue;
      if (managedSpaceNames.has(spaceEnt.name)) continue;
      // Space is no longer manageDest — rename to {spaceName}.deleted
      const spaceDir      = join(subDir, spaceEnt.name);
      const deletedPath   = join(subDir, `${spaceEnt.name}.deleted`);
      try {
        await rename(spaceDir, deletedPath);
        logger.info({ location: `${sa.region}/${sa.subdomain}/${spaceEnt.name}` }, 'Space no longer manageDest — folder renamed to .deleted');
      } catch (err) {
        logger.warn({ location: `${sa.region}/${sa.subdomain}/${spaceEnt.name}`, err }, 'Failed to rename removed space folder to .deleted');
      }
    }
  }

  if (spaceInstances.length === 0) {
    logger.info({ todos: todos.length }, 'No destination service instances found in spaces with manageDest=true');
    return { created, updated, deleted, errors: issues };
  }

  let spaceReceived = 0;
  const totalInstances = spaceInstances.length;
  const aodConfig = await readAodConfig();

  // Emit initial instance-progress signal so the caller knows the total
  onInstProgress?.(0, totalInstances, 'starting');

  // ── Step B+C: resolve credential and fetch instance destinations ───────────
  for (const inst of spaceInstances) {
    const label     = `${inst.region}/${inst.subdomain}/${inst.spaceName}/${inst.name}`; // full path for logging
    const instLabel = label;                                                               // region/subdomain/space/instance for progress display

    onProgress?.(done + 1, todos.length, instLabel, spaceReceived);
    onInstProgress?.(done, totalInstances, inst.name);

    // Resolve credentials specifically for this instance GUID (not the org-level instance)
    const tokenResult = await resolveInstanceToken(inst.region, inst.guid, inst.name, keyStore, tokenStore, cfLoginFailed, label);
    if ('error' in tokenResult) {
      issues.push(`${label}: ${tokenResult.error}`);
      done++;
      onInstProgress?.(done, totalInstances, inst.name);
      continue;
    }

    const { accessToken, credential } = tokenResult;

    const instanceDir = join(LOCAL_DEST_DIR, inst.region, inst.subdomain, inst.spaceName, `${inst.guid}_${inst.name}`);
    await mkdir(instanceDir, { recursive: true });

    let instanceDests: Record<string, unknown>[] = [];
    let finalToken      = accessToken;
    let finalCredential = credential;

    async function fetchAndPersist(token: string, cred: typeof credential): Promise<boolean> {
      const url     = `${cred.uri}/destination-configuration/v1/instanceDestinations`;
      const headers = { Authorization: `Bearer ${token}` };
      const res     = await fetchWithRateLimit(() => fetch(url, { headers }), url);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Instance Destination API → HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const dests = await res.json() as unknown[];
      instanceDests = [];
      const apiNames = new Set<string>();
      for (const dest of dests) {
        const d    = dest as Record<string, unknown>;
        const name = String(d['Name'] ?? d['name'] ?? '');
        if (!name) continue;
        apiNames.add(name);
        instanceDests.push(d);
        const r = await persistSpaceDestination(instanceDir, name, d, username);
        if (r === 'created') created++;
        else if (r === 'updated') updated++;
        spaceReceived++;
      }
      // Mark deleted
      const existing = await readdir(instanceDir).catch(() => [] as string[]);
      for (const fname of existing) {
        if (!fname.endsWith('.json') || fname.endsWith('.deleted.json')) continue;
        const destName = fname.slice(0, -5);
        if (apiNames.has(destName)) continue;
        const changelogPath = join(instanceDir, `${destName}.changelog.md`);
        const dateStr       = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const prev          = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
        await writeFile(changelogPath, `## Deleted by refresh at ${dateStr}\n\n` + prev, 'utf-8');
        const instDeletedPath = join(instanceDir, `${destName}.deleted.json`);
        await rename(join(instanceDir, fname), instDeletedPath);
        const nowInst = new Date(); await utimes(instDeletedPath, nowInst, nowInst);
        deleted++;
      }
      return true;
    }

    try {
      await fetchAndPersist(accessToken, credential);
      logger.info({ label, instanceGuid: inst.guid }, 'Space instance destinations refreshed');
    } catch (err) {
      if (!String(err).includes('HTTP 401')) {
        issues.push(`${label}: ${String(err)}`);
        done++;
        onInstProgress?.(done, totalInstances, inst.name);
        continue;
      }
      // 401 retry: invalidate cached token/key for this instance and re-acquire
      logger.info({ label, instanceGuid: inst.guid }, 'Instance Destination API 401 — retrying with fresh token');
      if (tokenStore[inst.region]) delete tokenStore[inst.region]![inst.guid];
      if (keyStore[inst.region])   delete keyStore[inst.region]![inst.guid];
      const r2 = await resolveInstanceToken(inst.region, inst.guid, inst.name, keyStore, tokenStore, cfLoginFailed, label);
      if ('error' in r2) {
        issues.push(`${label}: ${r2.error}`);
        done++;
        onInstProgress?.(done, totalInstances, inst.name);
        continue;
      }
      finalToken      = r2.accessToken;
      finalCredential = r2.credential;
      try {
        await fetchAndPersist(r2.accessToken, r2.credential);
        logger.info({ label, instanceGuid: inst.guid }, 'Space instance destinations refreshed (after 401 retry)');
      } catch (err2) {
        issues.push(`${label}: ${String(err2)}`);
      }
    }

    // Apply AOD proxy install/update/uninstall for each fetched destination
    if (instanceDests.length > 0) {
      for (const dest of instanceDests) {
        const destName = String(dest['Name'] ?? dest['name'] ?? '');
        if (!destName) continue;
        try {
          const updated = await applyAodToDestination(
            dest, inst.aod ?? false, inst.region, inst.subdomain, finalToken, finalCredential,
            routesTable, aodConfig, `${label}/${destName}`,
          );
          if (updated) {
            await persistSpaceDestination(instanceDir, destName, updated, username);
            // Update {appGuid}.json->aod and ->urls after AOD install/uninstall
            const aodInstalled = 'URL.headers.x-aod-app-id' in updated;
            const appGuid      = String(updated['URL.headers.x-aod-app-id'] ?? dest['URL.headers.x-aod-app-id'] ?? '');
            const destUrl      = aodInstalled
              ? String(updated['URL.headers.x-aod-app-url'] ?? '')
              : String(updated['URL'] ?? '');
            void updateAppFileAod(appGuid, inst.region, inst.subdomain, destUrl, aodInstalled);
            // Write AOD-specific changelog entries
            const wasAod    = 'URL.headers.x-aod-app-url' in dest;
            const isAod     = 'URL.headers.x-aod-app-url' in updated;
            const aodAction = (!wasAod && isAod) ? 'installed' : (wasAod && !isAod) ? 'uninstalled' : 'updated';
            void appendAodDestChangelog(instanceDir, destName, dest, updated, aodAction, username, inst);
          }
        } catch (aodErr) {
          logger.warn({ label, destName, err: aodErr }, 'AOD apply failed for destination');
        }
      }
    }

    done++;
    onInstProgress?.(done, totalInstances, inst.name);
  } // end for inst of spaceInstances

  await saveKeyStore(keyStore, instancePlanGuids);
  await saveTokenStore(tokenStore);
  if (created + updated + deleted > 0) {
    const dateStr      = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const modeLabel    = mode === 'manual' ? 'Manual' : 'Auto';
    const summary      = `created ${created}, updated ${updated}, deleted ${deleted} instance destinations`;
    const entry        = `## [${modeLabel}] space instance destination refresh by <${username}> at ${dateStr}\n\n${summary}\n\n`;
    const changelogPath = join(LOCAL_DEST_DIR, 'changelog.md');
    const MAX_SIZE      = 2 * 1024 * 1024;
    try {
      const s = await stat(changelogPath).catch(() => null);
      if (s && s.size > MAX_SIZE) {
        const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, match => match === 'T' ? '-' : match === '-' ? match : '');
        await rename(changelogPath, join(LOCAL_DEST_DIR, `changelog.${ts}.md`));
      }
    } catch { /* ignore */ }
    const prev = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
    notifyCallbacks();
    emit('dest', { ts: Date.now() });
  }

  return { created, updated, deleted, errors: issues };
}

export async function saveInstanceDestinationEntry(
  region:      string,
  subdomain:   string,
  spaceName:   string,
  instanceGuid: string,
  name:        string,
  incoming:    Record<string, unknown>,
  username:    string,
  action:      'update' | 'import' = 'update',
  skipGlobalChangelog = false,
): Promise<{ isNew: boolean; changed: boolean; instanceName: string }> {
  const { instanceDir, jsonPath, changelogPath } = await guardSpaceDestPath(region, subdomain, spaceName, instanceGuid, name);

  // Derive instanceName from the resolved instanceDir name
  const instanceDirBase = instanceDir.split(sep).pop() ?? instanceGuid;
  const instanceName = instanceDirBase.startsWith(`${instanceGuid}_`)
    ? instanceDirBase.slice(instanceGuid.length + 1) : instanceGuid;

  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; } catch { /* new */ }
  const isNew = Object.keys(existing).length === 0;

  // Restore redacted sentinel
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    merged[k] = (v === REDACTED_SENTINEL && isSensitiveField(k) && k in existing) ? existing[k] : v;
  }

  // Push to instance destination API using instance-specific credentials
  const location = `${region}/${subdomain}/${spaceName}/${instanceName}/${name}`;

  const { orgs: keyStore, planGuids } = await loadKeyStore();
  const tokenStore    = await loadTokenStore();
  const cfLoginFailed = new Set<string>();

  const tokenResult = await resolveInstanceToken(region, instanceGuid, instanceName, keyStore, tokenStore, cfLoginFailed, location);
  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);
  if ('error' in tokenResult) throw new Error(`Cannot authenticate: ${tokenResult.error}`);

  const encodedBody = JSON.stringify(merged);
  await withDestApiRetry(region, instanceGuid, instanceName, keyStore, tokenStore, cfLoginFailed, planGuids, location, tokenResult,
    async (auth) => {
      const baseUrl = `${auth.credential.uri}/destination-configuration/v1/instanceDestinations`;
      const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };
      const putRes  = await fetchWithRateLimit(() => fetch(baseUrl, { method: 'PUT', headers, body: encodedBody }), baseUrl);
      if (putRes.ok) return;
      if (putRes.status === 404) {
        const postRes = await fetchWithRateLimit(() => fetch(baseUrl, { method: 'POST', headers, body: encodedBody }), baseUrl);
        if (postRes.ok) return;
        const errText = await postRes.text().catch(() => '');
        throw new Error(`Instance Destination API POST failed: HTTP ${postRes.status}: ${errText.slice(0, 300)}`);
      }
      const errText = await putRes.text().catch(() => '');
      throw new Error(`Instance Destination API PUT failed: HTTP ${putRes.status}: ${errText.slice(0, 300)}`);
    });

  const diffLines: string[] = [];
  const allKeys = [...new Set([...Object.keys(existing), ...Object.keys(merged)])].sort();
  for (const k of allKeys) {
    const pv = JSON.stringify(existing[k] ?? null);
    const nv = JSON.stringify(merged[k] ?? null);
    if (pv === nv) continue;
    diffLines.push(isSensitiveField(k) ? `- ${k}: [redacted] → [redacted]` : `- ${k}: ${pv} → ${nv}`);
  }

  await mkdir(instanceDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf-8');

  if (diffLines.length > 0) {
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const heading = action === 'import'
      ? `## [Manual] destination imported by <${username}> at ${dateStr}`
      : `## Manual update by <${username}> at ${dateStr}`;
    const entry = `${heading}\n\n~${diffLines.length} field${diffLines.length !== 1 ? 's' : ''} updated:\n${diffLines.join('\n')}\n\n`;
    const prev  = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
    notifyCallbacks();
    emit('dest', { region, subdomain, ts: Date.now() });
    if (!skipGlobalChangelog) {
      await appendSubaccountGlobalChangelog('manual', action === 'import' ? 'import' : 'update', username, [{
        region, subdomain, name, action: isNew ? 'created' : 'updated', spaceName, instanceName,
      }]).catch(err => logger.error({ err }, 'Failed to write subaccount global changelog'));
    }
    logger.info({ user: username, location, changes: diffLines }, action === 'import' ? 'Instance destination imported' : 'Instance destination updated');
  } else {
    logger.info({ user: username, location }, 'Instance destination saved (no changes)');
  }
  return { isNew, changed: diffLines.length > 0, instanceName };
}

// ─── Public: search ───────────────────────────────────────────────────────────

export interface DestSearchResult {
  region:        string;
  subdomain:     string;
  org_id:        string;
  name:          string;
  matchField:    string;
  matchValue:    string;
  spaceName?:    string;
  instanceName?: string;
  instanceGuid?: string;
}

export async function searchDestinations(query: string, scopeRegion?: string, scopeSubdomain?: string): Promise<DestSearchResult[]> {
  if (!query) return [];
  const results: DestSearchResult[] = [];
  if (!existsSync(LOCAL_DEST_DIR)) return results;

  const allSas         = await readSubaccounts();
  const restrictedKeys = new Set(allSas.filter(sa => sa.restricted).map(sa => `${sa.region}/${sa.subdomain}`));
  const managedKeys    = new Set(allSas.filter(sa => sa.manageDestinations).map(sa => `${sa.region}/${sa.subdomain}`));
  const orgIndex = new Map<string, string>();
  for (const sa of allSas) {
    if (sa.manageDestinations && sa.org?.orgId) orgIndex.set(`${sa.region}/${sa.subdomain}`, sa.org.orgId);
  }

  // Parse a file path under LOCAL_DEST_DIR into its components.
  // Paths have one of two shapes:
  //   {region}/{subdomain}/{destName}.json            (SA-level)
  //   {region}/{subdomain}/{spaceName}/{guid_instName}/{destName}.json  (instance-level)
  function parsePath(absPath: string): { region: string; subdomain: string; spaceName?: string; instanceName?: string; instanceGuid?: string; name: string } | null {
    const rel = absPath.startsWith(LOCAL_DEST_DIR + sep) ? absPath.slice(LOCAL_DEST_DIR.length + 1) : null;
    if (!rel) return null;
    const parts = rel.split(sep);
    if (parts.length === 3) {
      const [region, subdomain, file] = parts as [string, string, string];
      if (!file.endsWith('.json') || file.endsWith('.deleted.json')) return null;
      return { region, subdomain, name: file.slice(0, -5) };
    }
    if (parts.length === 5) {
      const [region, subdomain, spaceName, instDir, file] = parts as [string, string, string, string, string];
      if (spaceName.endsWith('.deleted') || instDir.endsWith('.deleted')) return null;
      if (!file.endsWith('.json') || file.endsWith('.deleted.json')) return null;
      const us = instDir.indexOf('_');
      if (us < 0) return null;
      const instanceGuid = instDir.slice(0, us);
      const instanceName = instDir.slice(us + 1);
      return { region, subdomain, spaceName, instanceName, instanceGuid, name: file.slice(0, -5) };
    }
    return null;
  }

  async function grepDir(dir: string): Promise<string[]> {
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync(
        'grep',
        ['-ril', dir, '--include=*.json', '-e', query],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      return stdout.trim() ? stdout.trim().split('\n') : [];
    } catch (err: unknown) {
      // grep exits with code 1 when no matches — that's fine
      if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 1) return [];
      return [];
    }
  }

  async function processDir(region: string, subdomain: string, dir: string) {
    const org_id = orgIndex.get(`${region}/${subdomain}`) ?? '';
    const matchedFiles = await grepDir(dir);
    for (const absPath of matchedFiles) {
      // Skip .deleted.json and .changelog.md files grep may find
      if (!absPath.endsWith('.json') || absPath.endsWith('.deleted.json')) continue;
      const parsed = parsePath(absPath);
      if (!parsed) continue;
      if (parsed.region !== region || parsed.subdomain !== subdomain) continue;
      // Determine which field matched by reading the file
      try {
        const obj = JSON.parse(await readFile(absPath, 'utf-8')) as Record<string, unknown>;
        const lq  = query.toLowerCase();
        let matchField = 'Name';
        let matchValue = parsed.name;
        if (!parsed.name.toLowerCase().includes(lq)) {
          for (const [key, val] of Object.entries(obj)) {
            if (isSensitiveField(key)) continue;
            if (typeof val === 'string' && val.toLowerCase().includes(lq)) {
              matchField = key; matchValue = val; break;
            }
          }
        }
        results.push({ region, subdomain, org_id, name: parsed.name, matchField, matchValue, spaceName: parsed.spaceName, instanceName: parsed.instanceName, instanceGuid: parsed.instanceGuid });
      } catch { /* skip unreadable */ }
    }
  }

  if (scopeRegion && scopeSubdomain) {
    // Fast path: grep the entire subaccount directory in one shot
    if (!restrictedKeys.has(`${scopeRegion}/${scopeSubdomain}`) && managedKeys.has(`${scopeRegion}/${scopeSubdomain}`)) {
      const subDir = join(LOCAL_DEST_DIR, scopeRegion, scopeSubdomain);
      if (existsSync(subDir)) await processDir(scopeRegion, scopeSubdomain, subDir);
    }
  } else {
    // Global: iterate all regions+subdomains
    const regions = await readdir(LOCAL_DEST_DIR).catch(() => [] as string[]);
    for (const region of regions) {
      if (scopeRegion && region !== scopeRegion) continue;
      const regionDir = join(LOCAL_DEST_DIR, region);
      try { if (!(await stat(regionDir)).isDirectory()) continue; } catch { continue; }
      const subdomains = await readdir(regionDir).catch(() => [] as string[]);
      for (const subdomain of subdomains) {
        if (restrictedKeys.has(`${region}/${subdomain}`)) continue;
        if (!managedKeys.has(`${region}/${subdomain}`)) continue;
        const subDir = join(regionDir, subdomain);
        try { if (!(await stat(subDir)).isDirectory()) continue; } catch { continue; }
        await processDir(region, subdomain, subDir);
      }
    }
  }
  return results;
}

export async function countDestinationFiles(): Promise<number> {
  if (!existsSync(LOCAL_DEST_DIR)) return 0;
  try {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'find', [LOCAL_DEST_DIR, '-type', 'f', '-name', '*.json', '!', '-name', '*.deleted.json', '!', '-path', '*.deleted/*'],
      { maxBuffer: 1024 * 1024 },
    );
    return stdout.trim() ? stdout.trim().split('\n').length : 0;
  } catch {
    return 0;
  }
}

// ─── Destination API write (PUT with POST fallback) and delete ───────────────

async function deleteFromDestinationApi(
  region:    string,
  subdomain: string,
  name:      string,
): Promise<void> {
  const allSas = await readSubaccounts();
  const sa     = allSas.find(s => s.region === region && s.subdomain === subdomain);
  if (!sa?.org?.orgId) {
    throw new Error(`No CF org found for ${region}/${subdomain} — cannot delete from Destination API`);
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

  await withDestApiRetry(region, orgId, orgName, keyStore, tokenStore, cfLoginFailed, planGuids, location, tokenResult,
    async (auth) => {
      const url = `${auth.credential.uri}/destination-configuration/v1/subaccountDestinations/${encodeURIComponent(name)}`;
      const res = await fetchWithRateLimit(() => fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      }), url);
      // 404 = not in BTP (already absent); treat as success
      if (res.ok || res.status === 404) {
        logger.debug({ location, status: res.status }, 'Destination deleted from Destination API');
        return;
      }
      const errText = await res.text().catch(() => '');
      throw new Error(`Destination API DELETE failed: HTTP ${res.status}: ${errText.slice(0, 300)}`);
    });

  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);
}

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
  action:   'update' | 'import' = 'update',
  skipGlobalChangelog = false,
): Promise<{ isNew: boolean; changed: boolean }> {
  const { jsonPath, changelogPath } = guardDestPath(region, subdomain, name);

  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; } catch { /* new */ }
  const isNew = Object.keys(existing).length === 0;

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
    const heading = action === 'import'
      ? `## [Manual] destination imported by <${username}> at ${dateStr}`
      : `## Manual update done by <${username}> at ${dateStr}`;
    const entry = `${heading}\n\n~${diffLines.length} field${diffLines.length !== 1 ? 's' : ''} updated:\n${diffLines.join('\n')}\n\n`;
    const prev  = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
    if (!skipGlobalChangelog) {
      await appendSubaccountGlobalChangelog('manual', action === 'import' ? 'import' : 'update', username, [{ region, subdomain, name, action: isNew ? 'created' : 'updated' }])
        .catch(err => logger.error({ err }, 'Failed to write subaccount global changelog'));
    }
    logger.info({ user: username, destination: `${region}.${subdomain}/${name}`, changes: diffLines }, action === 'import' ? 'Destination imported' : 'Destination updated');
  } else {
    logger.info({ user: username, destination: `${region}.${subdomain}/${name}` }, 'Destination saved (no changes)');
  }

  await mkdir(join(LOCAL_DEST_DIR, region, subdomain), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf-8');
  if (diffLines.length > 0) notifyCallbacks();
  emit('dest', { region, subdomain, name, ts: Date.now() });
  return { isNew, changed: diffLines.length > 0 };
}

export async function deleteDestinationEntry(
  region: string, subdomain: string, name: string, username: string,
): Promise<void> {
  const { jsonPath, changelogPath } = guardDestPath(region, subdomain, name);
  if (!existsSync(jsonPath)) throw Object.assign(new Error('Destination not found'), { status: 404 });

  // Delete from BTP Destination Service first; propagate error if it fails
  await deleteFromDestinationApi(region, subdomain, name);

  const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const entry   = `## [Manual] destination deleted by <${username}> at ${dateStr}\n\n`;
  const prev    = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');
  const manualDeletedPath = jsonPath.replace(/\.json$/, '.deleted.json');
  await rename(jsonPath, manualDeletedPath);
  const nowDel = new Date(); await utimes(manualDeletedPath, nowDel, nowDel);
  await appendSubaccountGlobalChangelog('manual', 'delete', username, [{ region, subdomain, name, action: 'deleted' }])
    .catch(err => logger.error({ err }, 'Failed to write global changelog after delete'));
  notifyCallbacks();
  emit('dest', { region, subdomain, name, ts: Date.now() });
}

export async function deleteInstanceDestinationEntry(
  region: string, subdomain: string, spaceName: string, instanceGuid: string, name: string, username: string,
): Promise<void> {
  const { jsonPath, changelogPath, instanceDir } = await guardSpaceDestPath(region, subdomain, spaceName, instanceGuid, name);
  if (!existsSync(jsonPath)) throw Object.assign(new Error('Destination not found'), { status: 404 });
  // resolve instanceName from directory name ({guid}_{instanceName})
  const dirBasename   = instanceDir.split(sep).pop() ?? '';
  const underscoreIdx = dirBasename.indexOf('_');
  const instanceName  = underscoreIdx >= 0 ? dirBasename.slice(underscoreIdx + 1) : dirBasename;
  const location      = `${region}/${subdomain}/${spaceName}/${instanceName}/${name}`;

  // Delete from BTP instance Destination Service first; propagate error if it fails
  const { orgs: keyStore, planGuids } = await loadKeyStore();
  const tokenStore    = await loadTokenStore();
  const cfLoginFailed = new Set<string>();

  const tokenResult = await resolveInstanceToken(region, instanceGuid, instanceName, keyStore, tokenStore, cfLoginFailed, location);
  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);
  if ('error' in tokenResult) throw new Error(`Cannot authenticate: ${tokenResult.error}`);

  await withDestApiRetry(region, instanceGuid, instanceName, keyStore, tokenStore, cfLoginFailed, planGuids, location, tokenResult,
    async (auth) => {
      const url = `${auth.credential.uri}/destination-configuration/v1/instanceDestinations/${encodeURIComponent(name)}`;
      const res = await fetchWithRateLimit(() => fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      }), url);
      // 404 = not in BTP (already absent); treat as success
      if (res.ok || res.status === 404) {
        logger.debug({ location, status: res.status }, 'Instance destination deleted from Destination API');
        return;
      }
      const errText = await res.text().catch(() => '');
      throw new Error(`Instance Destination API DELETE failed: HTTP ${res.status}: ${errText.slice(0, 300)}`);
    });

  await saveKeyStore(keyStore, planGuids);
  await saveTokenStore(tokenStore);

  const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const entry   = `## [Manual] destination deleted by <${username}> at ${dateStr}\n\n`;
  const prev    = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prev, 'utf-8');
  const instManualDeletedPath = jsonPath.replace(/\.json$/, '.deleted.json');
  await rename(jsonPath, instManualDeletedPath);
  const nowInstDel = new Date(); await utimes(instManualDeletedPath, nowInstDel, nowInstDel);
  await appendSubaccountGlobalChangelog('manual', 'delete', username, [{ region, subdomain, name, action: 'deleted', spaceName, instanceName, instanceGuid }])
    .catch(err => logger.error({ err }, 'Failed to write global changelog after instance delete'));
  notifyCallbacks();
  emit('dest', { region, subdomain, name, ts: Date.now() });
}

export type ImportTarget =
  | { type: 'sa' }
  | { type: 'inst'; spaceName: string; instanceGuid: string; instanceName: string };

export interface BatchImportResult {
  created: number;
  updated: number;
  errors: Array<{ name: string; target: string; message: string }>;
}

export async function batchImportDestinations(
  region:    string,
  subdomain: string,
  items:     Record<string, unknown>[],
  targets:   ImportTarget[],
  username:  string,
): Promise<BatchImportResult> {
  const allChanges: DestChange[] = [];
  let created = 0; let updated = 0;
  const errors: BatchImportResult['errors'] = [];

  for (const item of items) {
    const name = String(item['Name'] ?? '').trim();
    if (!name) continue;
    for (const target of targets) {
      try {
        if (target.type === 'sa') {
          const r = await saveDestinationEntry(region, subdomain, name, item, username, 'import', true);
          if (r.changed) { allChanges.push({ region, subdomain, name, action: r.isNew ? 'created' : 'updated' }); }
          if (r.isNew) created++; else updated++;
        } else {
          const r = await saveInstanceDestinationEntry(region, subdomain, target.spaceName, target.instanceGuid, name, item, username, 'import', true);
          if (r.changed) {
            allChanges.push({ region, subdomain, name, action: r.isNew ? 'created' : 'updated', spaceName: target.spaceName, instanceGuid: target.instanceGuid, instanceName: r.instanceName });
          }
          if (r.isNew) created++; else updated++;
        }
      } catch (err) {
        const targetLabel = target.type === 'sa' ? subdomain : `${target.spaceName}/${target.instanceName}`;
        errors.push({ name, target: targetLabel, message: err instanceof Error ? err.message : 'unknown error' });
      }
    }
  }

  if (allChanges.length > 0) {
    // Build a single grouped global changelog entry for the entire import batch
    const hasInstances = allChanges.some(c => c.spaceName);
    const scopeLabel   = hasInstances ? 'subaccount/instances' : 'subaccount';
    await appendSubaccountGlobalChangelog('manual', 'import', username, allChanges)
      .catch(err => logger.error({ err }, 'Failed to write batch import global changelog'));
    logger.info({ user: username, region, subdomain, created, updated, scope: scopeLabel }, 'Batch destination import complete');
  }

  return { created, updated, errors };
}

export async function appendImportGlobalChangelog(
  username: string,
  changes: Array<{ region: string; subdomain: string; name: string; action: 'created' | 'updated'; spaceName?: string; instanceGuid?: string; instanceName?: string }>,
): Promise<void> {
  await appendSubaccountGlobalChangelog('manual', 'import', username, changes);
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
      const names = await listActiveDestNames(join(regionDir, subdomain));
      const dests = names.map(name => ({ name, status: 'OK' as const }));
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

// ── Destination file dedupe ───────────────────────────────────────────────────
// When both {name}.json and {name}.deleted.json exist in a dest dir, the newer
// mtime wins and the older file is deleted. Runs after any dest sync and on startup.

async function dedupeDestFiles(): Promise<void> {
  if (!existsSync(LOCAL_DEST_DIR)) return;

  async function dedupeDir(dir: string): Promise<void> {
    const files = await readdir(dir).catch(() => [] as string[]);
    const jsonNames    = new Set<string>();
    const deletedNames = new Set<string>();
    for (const f of files) {
      if (f.endsWith('.deleted.json')) deletedNames.add(f.slice(0, -13));
      else if (f.endsWith('.json'))    jsonNames.add(f.slice(0, -5));
    }
    for (const name of jsonNames) {
      if (!deletedNames.has(name)) continue;
      const jsonPath    = join(dir, `${name}.json`);
      const deletedPath = join(dir, `${name}.deleted.json`);
      try {
        const [jStat, dStat] = await Promise.all([stat(jsonPath), stat(deletedPath)]);
        if (jStat.mtimeMs >= dStat.mtimeMs) {
          await unlink(deletedPath);
          logger.info({ path: deletedPath }, 'Dest dedupe: removed stale .deleted.json');
        } else {
          await unlink(jsonPath);
          logger.info({ path: jsonPath }, 'Dest dedupe: removed stale .json (deleted version is newer)');
        }
      } catch (err) {
        logger.warn({ dir, name, err }, 'Dest dedupe: failed to resolve pair');
      }
    }
  }

  try {
    const regions = await readdir(LOCAL_DEST_DIR, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const regionEnt of regions) {
      if (!regionEnt.isDirectory()) continue;
      const regionDir  = join(LOCAL_DEST_DIR, regionEnt.name);
      const subEntries = await readdir(regionDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
      for (const subEnt of subEntries) {
        if (!subEnt.isDirectory() || subEnt.name.endsWith('.deleted')) continue;
        const subDir = join(regionDir, subEnt.name);
        await dedupeDir(subDir);
        // instance-level dirs
        const spaceEntries = await readdir(subDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
        for (const spaceEnt of spaceEntries) {
          if (!spaceEnt.isDirectory() || spaceEnt.name.endsWith('.deleted')) continue;
          const spaceDir   = join(subDir, spaceEnt.name);
          const instEntries = await readdir(spaceDir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
          for (const instEnt of instEntries) {
            if (!instEnt.isDirectory() || instEnt.name.endsWith('.deleted')) continue;
            await dedupeDir(join(spaceDir, instEnt.name));
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Dest dedupe scan failed');
  }
}

void dedupeDestFiles();
registerOnDestSynced(() => void dedupeDestFiles());
