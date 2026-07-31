import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';
import { getOrRefreshToken, fetchWithRateLimit } from './cfLoginService.js';

const CIS_CACHE_DIR  = join(homedir(), '.ba');
const CIS_CACHE_PATH = join(CIS_CACHE_DIR, 'cis-central-viewer-key.json');

interface CisCredentials {
  uaa: { url: string; clientid: string; clientsecret: string };
  endpoints: { accounts_service_url: string };
}

interface CisKeyCache {
  credentials: CisCredentials;
  access_token: string;
  expires_at: number;
}

interface GaNode {
  guid?: string;
  entityType?: string;
  displayName?: string;
  subdomain?: string;
  children?: GaNode[];
}

export interface CisSubaccountInfo {
  global_account_id: string;
  subaccount_id:     string;
  subaccount_name:   string;
  subdomain:         string;
}

async function loadKeyCache(): Promise<CisKeyCache | null> {
  try {
    const raw    = await readFile(CIS_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CisKeyCache>;
    if (parsed.credentials && parsed.access_token && typeof parsed.expires_at === 'number') {
      return parsed as CisKeyCache;
    }
    return null;
  } catch { return null; }
}

async function saveKeyCache(cache: CisKeyCache): Promise<void> {
  await mkdir(CIS_CACHE_DIR, { recursive: true });
  await writeFile(CIS_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

async function clearKeyCache(): Promise<void> {
  try { await unlink(CIS_CACHE_PATH); } catch { /* ok if absent */ }
}

async function cisV3Get(region: string, path: string): Promise<unknown> {
  const token = await getOrRefreshToken(region);
  const url   = `${token.api_url}${path}`;
  const t0    = Date.now();
  const res   = await fetchWithRateLimit(
    () => fetch(url, { headers: { Authorization: `${token.token_type} ${token.access_token}` } }),
    url,
  );
  logger.debug({ method: 'GET', url, status: res.status, cl: res.headers.get('content-length'), ms: Date.now() - t0 }, 'CIS discovery CF v3 call');
  if (!res.ok) throw new Error(`CIS CF v3 GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function findCisKeyInRegion(region: string): Promise<CisCredentials | null> {
  const plansData = await cisV3Get(
    region,
    '/v3/service_plans?names=central-viewer&service_offering_names=cis',
  ) as { resources?: Array<{ guid: string }> };
  const planGuid = plansData.resources?.[0]?.guid;
  if (!planGuid) return null;

  const instancesData = await cisV3Get(
    region,
    `/v3/service_instances?service_plan_guids=${planGuid}&per_page=1`,
  ) as { resources?: Array<{ guid: string }> };
  const instanceGuid = instancesData.resources?.[0]?.guid;
  if (!instanceGuid) return null;

  const bindingsData = await cisV3Get(
    region,
    `/v3/service_credential_bindings?service_instance_guids=${instanceGuid}&type=key&per_page=1`,
  ) as { resources?: Array<{ guid: string }> };
  const bindingGuid = bindingsData.resources?.[0]?.guid;
  if (!bindingGuid) return null;

  const details = await cisV3Get(
    region,
    `/v3/service_credential_bindings/${bindingGuid}/details`,
  ) as { credentials?: CisCredentials };
  const creds = details.credentials;
  if (!creds?.uaa?.url || !creds?.uaa?.clientid || !creds?.endpoints?.accounts_service_url) return null;

  logger.info({ region, instanceGuid }, 'Found CIS central-viewer service key');
  return creds;
}

async function getCisToken(creds: CisCredentials): Promise<{ access_token: string; expires_at: number }> {
  const url  = `${creds.uaa.url}/oauth/token`;
  const form = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     creds.uaa.clientid,
    client_secret: creds.uaa.clientsecret,
  }).toString();
  const t0  = Date.now();
  const res = await fetchWithRateLimit(
    () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }),
    url,
  );
  logger.debug({ method: 'POST', url, grant_type: 'client_credentials', status: res.status, cl: res.headers.get('content-length'), ms: Date.now() - t0 }, 'CIS OAuth token call');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CIS OAuth POST → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data      = await res.json() as { access_token?: string; expires_in?: number };
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  return { access_token: String(data.access_token ?? ''), expires_at: Date.now() + expiresIn * 1000 };
}

function flattenSubaccounts(node: GaNode, globalAccountId: string, result: Map<string, CisSubaccountInfo>): void {
  if (node.entityType === 'SUBACCOUNT' && node.subdomain && node.guid) {
    result.set(node.subdomain, {
      global_account_id: globalAccountId,
      subaccount_id:     node.guid,
      subaccount_name:   node.displayName ?? '',
      subdomain:         node.subdomain,
    });
  }
  for (const child of node.children ?? []) {
    flattenSubaccounts(child, globalAccountId, result);
  }
}

const NO_CIS_WARNING =
  'Cloud Management Service (cis) with plan "central-viewer" not found in any configured CF region. ' +
  'Create a service instance + service key in one of your subaccounts, then retry Refresh.';

export async function getCisSubaccountIndex(
  regions: string[],
): Promise<{ index: Map<string, CisSubaccountInfo>; warning: string | null }> {
  const empty = (warning: string) => ({ index: new Map<string, CisSubaccountInfo>(), warning });

  let cache = await loadKeyCache();

  if (!cache) {
    let credentials: CisCredentials | null = null;
    for (const region of regions) {
      try {
        credentials = await findCisKeyInRegion(region);
        if (credentials) break;
      } catch (err) {
        logger.warn({ region, err }, 'CIS key discovery failed for region — trying next');
      }
    }
    if (!credentials) {
      logger.warn({ regions }, 'CIS central-viewer service key not found in any configured region');
      return empty(NO_CIS_WARNING);
    }
    const tokenResult = await getCisToken(credentials);
    cache = { credentials, ...tokenResult };
    await saveKeyCache(cache);
  }

  if (cache.expires_at - Date.now() < 60_000) {
    try {
      const tokenResult = await getCisToken(cache.credentials);
      cache = { ...cache, ...tokenResult };
      await saveKeyCache(cache);
    } catch (err) {
      logger.warn({ err }, 'CIS token refresh failed — clearing cache');
      await clearKeyCache();
      return empty('CIS credentials are stale or invalid — retry Refresh to re-discover the service key.');
    }
  }

  const accountsUrl = cache.credentials.endpoints.accounts_service_url;
  const url = `${accountsUrl}/accounts/v1/globalAccount?expand=true`;
  const t0  = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cache.access_token}` } });
  logger.debug({ method: 'GET', url, status: res.status, cl: res.headers.get('content-length'), ms: Date.now() - t0 }, 'CIS global account hierarchy call');

  if (res.status === 401) {
    await clearKeyCache();
    return empty('CIS credentials are stale or invalid — retry Refresh to re-discover the service key.');
  }
  if (!res.ok) {
    logger.warn({ status: res.status, url }, 'CIS global account API returned non-OK status');
    return empty(`CIS global account API returned HTTP ${res.status} — retry Refresh.`);
  }

  const gaRoot          = await res.json() as GaNode;
  const globalAccountId = gaRoot.guid ?? '';
  const index           = new Map<string, CisSubaccountInfo>();
  flattenSubaccounts(gaRoot, globalAccountId, index);

  logger.info({ subaccounts: index.size }, 'CIS subaccount index built');
  return { index, warning: null };
}
