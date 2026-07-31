import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getOrRefreshToken, fetchWithRateLimit } from './cfLoginService.js';
import { readOrgs, type OrgEntry } from './orgsService.js';
import { notifyCallbacks } from './syncService.js';

const BA_DIR         = join(homedir(), '.ba');
const KEYS_PATH      = join(BA_DIR, 'destination-keys.json');
const TOKENS_PATH    = join(BA_DIR, 'destination-tokens.json');
const LOCAL_DEST_DIR = join(config.LOCAL_STORE_DIR, 'dest');

function isSensitiveField(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes('secret') || k.includes('password') || k.includes('credential');
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DestCredentials {
  uri:          string;
  clientid:     string;
  clientsecret: string;
  url:          string;
  [k: string]: unknown;
}

export interface DestKeyEntry {
  org_id:      string;
  region:      string;
  subdomain:   string;
  credentials: DestCredentials;
}

interface DestTokenEntry {
  org_id:       string;
  access_token: string;
  expires_at:   number;
}

type KeyStore   = Record<string, DestKeyEntry>;
type TokenStore = Record<string, DestTokenEntry>;

// ─── Persistence helpers ──────────────────────────────────────────────────────

async function loadKeyStore(): Promise<KeyStore> {
  try { return JSON.parse(await readFile(KEYS_PATH, 'utf-8')) as KeyStore; }
  catch { return {}; }
}

async function saveKeyStore(store: KeyStore): Promise<void> {
  await mkdir(BA_DIR, { recursive: true });
  await writeFile(KEYS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

async function loadTokenStore(): Promise<TokenStore> {
  try { return JSON.parse(await readFile(TOKENS_PATH, 'utf-8')) as TokenStore; }
  catch { return {}; }
}

async function saveTokenStore(store: TokenStore): Promise<void> {
  await mkdir(BA_DIR, { recursive: true });
  await writeFile(TOKENS_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

// ─── CF v3 API helpers ────────────────────────────────────────────────────────

async function cfGet(region: string, path: string): Promise<unknown> {
  const token = await getOrRefreshToken(region);
  const url   = `${token.api_url}${path}`;
  const res   = await fetchWithRateLimit(
    () => fetch(url, { headers: { Authorization: `${token.token_type} ${token.access_token}` } }),
    url,
  );
  if (!res.ok) throw new Error(`CF GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function fetchDestInstanceGuid(region: string, orgGuid: string): Promise<string | null> {
  const data = await cfGet(region,
    `/v3/service_instances?organization_guids=${orgGuid}&names=destination&per_page=10`,
  ) as { resources?: Array<{ guid: string }> };
  return data.resources?.[0]?.guid ?? null;
}

async function fetchDestKeyGuid(region: string, instanceGuid: string): Promise<string | null> {
  const data = await cfGet(region,
    `/v3/service_credential_bindings?service_instance_guids=${instanceGuid}&type=key&per_page=10`,
  ) as { resources?: Array<{ guid: string }> };
  return data.resources?.[0]?.guid ?? null;
}

async function fetchDestCredentials(region: string, keyGuid: string): Promise<DestCredentials> {
  const data = await cfGet(region, `/v3/service_credential_bindings/${keyGuid}/details`) as {
    credentials?: DestCredentials;
  };
  const creds = data.credentials;
  if (!creds?.uri || !creds?.clientid || !creds?.clientsecret || !creds?.url) {
    throw new Error(`Incomplete destination service credentials for key ${keyGuid}`);
  }
  return creds;
}

// ─── Destination service OAuth ────────────────────────────────────────────────

async function getDestToken(entry: DestKeyEntry, store: TokenStore): Promise<string> {
  const cached = store[entry.org_id];
  if (cached && cached.expires_at - Date.now() > 60_000) return cached.access_token;

  const { url, clientid, clientsecret } = entry.credentials;
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString('base64');
  const tokenUrl = `${url}/oauth/token`;

  const res = await fetchWithRateLimit(
    () => fetch(tokenUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body:    'grant_type=client_credentials',
    }),
    tokenUrl,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Destination OAuth for ${entry.org_id} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; expires_in?: number };
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 1800;
  store[entry.org_id] = { org_id: entry.org_id, access_token: data.access_token, expires_at: Date.now() + expiresIn * 1000 };
  return data.access_token;
}

// ─── Destination API ──────────────────────────────────────────────────────────

async function fetchSubaccountDestinations(entry: DestKeyEntry, token: string): Promise<unknown[]> {
  const url = `${entry.credentials.uri}/destination-configuration/v1/subaccountDestinations`;
  const res = await fetchWithRateLimit(
    () => fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
    url,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Destination API for ${entry.org_id} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ─── Diff / changelog ────────────────────────────────────────────────────────

function diffDestination(prev: Record<string, unknown>, next: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    const pv = JSON.stringify(prev[k] ?? null);
    const nv = JSON.stringify(next[k] ?? null);
    if (pv !== nv) lines.push(`- ${k}: ${pv} → ${nv}`);
  }
  return lines.join('\n');
}

async function persistDestination(
  destDir: string,
  name: string,
  incoming: Record<string, unknown>,
): Promise<void> {
  const filePath      = join(destDir, `${name}.json`);
  const changelogPath = join(destDir, `${name}.changelog.md`);
  const incomingJson  = JSON.stringify(incoming, null, 2);

  if (existsSync(filePath)) {
    const existing = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
    if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
      const diff = diffDestination(existing, incoming);
      const heading = `## ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`;
      const entry   = `${heading}\n${diff}\n\n`;
      const existing_cl = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
      await writeFile(changelogPath, entry + existing_cl, 'utf-8');
    }
  }
  await writeFile(filePath, incomingJson, 'utf-8');
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function refreshDestinations(): Promise<{ refreshed: number; errors: string[] }> {
  const allOrgs = await readOrgs();
  const targetOrgs: Array<OrgEntry & { region: string }> = [];
  for (const { region, orgs } of allOrgs) {
    for (const org of orgs) {
      if (org.manageDestination) targetOrgs.push({ ...org, region });
    }
  }

  if (targetOrgs.length === 0) {
    logger.info('No orgs with manageDestination=true — nothing to refresh');
    return { refreshed: 0, errors: [] };
  }

  const keyStore   = await loadKeyStore();
  const tokenStore = await loadTokenStore();
  const errors: string[] = [];
  let refreshed = 0;

  // Step 1: discover missing keys
  for (const org of targetOrgs) {
    if (keyStore[org.org_id]) continue;
    try {
      const instanceGuid = await fetchDestInstanceGuid(org.region, org.org_id);
      if (!instanceGuid) {
        logger.warn({ org: org.org_id, region: org.region }, 'No "destination" service instance found — skipping');
        continue;
      }
      const keyGuid = await fetchDestKeyGuid(org.region, instanceGuid);
      if (!keyGuid) {
        logger.warn({ org: org.org_id, region: org.region }, 'No service key found for destination instance — skipping');
        continue;
      }
      const credentials = await fetchDestCredentials(org.region, keyGuid);
      keyStore[org.org_id] = { org_id: org.org_id, region: org.region, subdomain: org.subdomain, credentials };
      logger.info({ org: org.org_id, region: org.region }, 'Destination service key acquired');
    } catch (err) {
      const msg = `Key discovery failed for ${org.org_id}: ${String(err)}`;
      logger.error({ org: org.org_id, err }, msg);
      errors.push(msg);
    }
  }
  await saveKeyStore(keyStore);

  // Step 2: fetch destinations for each org that has a key
  for (const org of targetOrgs) {
    const keyEntry = keyStore[org.org_id];
    if (!keyEntry) continue;
    try {
      const accessToken = await getDestToken(keyEntry, tokenStore);
      const destinations = await fetchSubaccountDestinations(keyEntry, accessToken);

      const destDir = join(LOCAL_DEST_DIR, org.region, org.subdomain);
      await mkdir(destDir, { recursive: true });

      // Track names returned by API
      const apiNames = new Set<string>();
      for (const dest of destinations) {
        const d    = dest as Record<string, unknown>;
        const name = String(d['Name'] ?? d['name'] ?? '');
        if (!name) continue;
        apiNames.add(name);
        await persistDestination(destDir, name, d);
      }

      // Rename local files not in API response to .deleted.json
      const entries = await readdir(destDir).catch(() => [] as string[]);
      for (const fname of entries) {
        if (!fname.endsWith('.json') || fname.endsWith('.deleted.json')) continue;
        const destName = fname.slice(0, -5);
        if (!apiNames.has(destName)) {
          await rename(join(destDir, fname), join(destDir, `${destName}.deleted.json`));
          logger.info({ org: org.org_id, destination: destName }, 'Destination marked as deleted');
        }
      }

      logger.info({ org: org.org_id, region: org.region, count: apiNames.size }, 'Destinations refreshed');
      refreshed++;
    } catch (err) {
      const msg = `Destination refresh failed for ${org.org_id}: ${String(err)}`;
      logger.error({ org: org.org_id, err }, msg);
      errors.push(msg);
    }
  }
  await saveTokenStore(tokenStore);

  if (refreshed > 0) notifyCallbacks();

  return { refreshed, errors };
}

export interface DestSearchResult {
  region:     string;
  subdomain:  string;
  org_id:     string;
  name:       string;
  matchField: string;
  matchValue: string;
}

export async function searchDestinations(
  query: string,
  scopeRegion?: string,
  scopeSubdomain?: string,
): Promise<DestSearchResult[]> {
  if (!query) return [];
  const lq = query.toLowerCase();
  const results: DestSearchResult[] = [];

  if (!existsSync(LOCAL_DEST_DIR)) return results;

  const allOrgs = await readOrgs();
  const orgIndex = new Map<string, string>(); // "region/subdomain" → org_id
  for (const { region, orgs } of allOrgs) {
    for (const org of orgs) {
      if (org.manageDestination) orgIndex.set(`${region}/${org.subdomain}`, org.org_id);
    }
  }

  const regions = await readdir(LOCAL_DEST_DIR).catch(() => [] as string[]);
  for (const region of regions) {
    if (scopeRegion && region !== scopeRegion) continue;
    const regionDir = join(LOCAL_DEST_DIR, region);
    try { if (!(await stat(regionDir)).isDirectory()) continue; } catch { continue; }
    const subdomains = await readdir(regionDir).catch(() => [] as string[]);
    for (const subdomain of subdomains) {
      if (scopeSubdomain && subdomain !== scopeSubdomain) continue;
      const subDir = join(regionDir, subdomain);
      try { if (!(await stat(subDir)).isDirectory()) continue; } catch { continue; }
      const org_id = orgIndex.get(`${region}/${subdomain}`) ?? '';
      const files  = await readdir(subDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.deleted.json')) continue;
        const name = file.slice(0, -5);
        try {
          const raw = await readFile(join(subDir, file), 'utf-8');
          const obj = JSON.parse(raw) as Record<string, unknown>;
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
        } catch { /* skip unreadable file */ }
      }
    }
  }
  return results;
}

// ─── Single-destination CRUD ──────────────────────────────────────────────────

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
    return { data, sensitiveFields: Object.keys(data).filter(k => isSensitiveField(k)) };
  } catch { return null; }
}

export async function exportDestination(region: string, subdomain: string, name: string): Promise<Record<string, unknown> | null> {
  const { jsonPath } = guardDestPath(region, subdomain, name);
  try { return JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; }
  catch { return null; }
}

export async function saveDestinationEntry(
  region: string,
  subdomain: string,
  name: string,
  incoming: Record<string, unknown>,
  username: string,
): Promise<void> {
  const { jsonPath, changelogPath } = guardDestPath(region, subdomain, name);

  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>; } catch { /* new */ }

  // Restore original sensitive values when the client sent the redacted sentinel unchanged
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    merged[k] = (v === REDACTED_SENTINEL && isSensitiveField(k) && k in existing) ? existing[k] : v;
  }

  // Compute diff
  const diffLines: string[] = [];
  const allKeys = [...new Set([...Object.keys(existing), ...Object.keys(merged)])].sort();
  for (const k of allKeys) {
    const pv = JSON.stringify(existing[k] ?? null);
    const nv = JSON.stringify(merged[k] ?? null);
    if (pv === nv) continue;
    diffLines.push(isSensitiveField(k)
      ? `- ${k}: [redacted] → [redacted]`
      : `- ${k}: ${pv} → ${nv}`);
  }

  if (diffLines.length > 0) {
    const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const entry   = `## ${name} # ${username} - ${dateStr}\n${diffLines.join('\n')}\n\n`;
    const prev    = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
    await writeFile(changelogPath, entry + prev, 'utf-8');
  }

  await mkdir(join(LOCAL_DEST_DIR, region, subdomain), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf-8');
  notifyCallbacks();
}

export async function getDestinationChangelog(region: string, subdomain: string, name: string): Promise<string> {
  const { changelogPath } = guardDestPath(region, subdomain, name);
  try { return await readFile(changelogPath, 'utf-8'); }
  catch { return ''; }
}

export async function listDestinations(): Promise<Record<string, Array<{ name: string; status: 'OK' }>>> {
  const result: Record<string, Array<{ name: string; status: 'OK' }>> = {};

  // Build a lookup: region/subdomain → org_id from orgs.json
  const allOrgs = await readOrgs();
  const orgIndex = new Map<string, string>(); // "region/subdomain" → org_id
  for (const { region, orgs } of allOrgs) {
    for (const org of orgs) {
      if (org.manageDestination) orgIndex.set(`${region}/${org.subdomain}`, org.org_id);
    }
  }

  if (!existsSync(LOCAL_DEST_DIR)) return result;

  const regions = await readdir(LOCAL_DEST_DIR).catch(() => [] as string[]);
  for (const region of regions) {
    const regionDir = join(LOCAL_DEST_DIR, region);
    const subdomains = await readdir(regionDir).catch(() => [] as string[]);
    for (const subdomain of subdomains) {
      const org_id = orgIndex.get(`${region}/${subdomain}`);
      if (!org_id) continue;
      const subDir  = join(regionDir, subdomain);
      const files   = await readdir(subDir).catch(() => [] as string[]);
      const dests   = files
        .filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'))
        .map(f => ({ name: f.slice(0, -5), status: 'OK' as const }));
      if (dests.length > 0) result[org_id] = dests;
    }
  }
  return result;
}
