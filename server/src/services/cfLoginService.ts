import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';
import { getConfig } from './configService.js';
import { logger } from '../logger.js';

const TOKEN_DIR  = join(homedir(), '.ba');
const TOKEN_PATH = join(TOKEN_DIR, 'cf_login_tokens.json');

export interface CfRegionToken {
  api_url: string;
  token_endpoint: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
  login_type: string;
}

type TokenStore = Record<string, CfRegionToken>;

// In-memory credentials — populated lazily on first CF API call
let cachedUsername = '';
let cachedPassword = '';
let cachedOrigin   = '';
let tokenStore: TokenStore = {};
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const creds = getCfCredentials();
    cachedUsername = creds.username;
    cachedPassword = creds.password;
    cachedOrigin   = creds.origin;
    tokenStore = await loadTokenStore();
    logger.debug('CF login service initialized (lazy)');
  })();
  return initPromise;
}

function cfApiUrl(region: string): string {
  return `https://api.cf.${region}.hana.ondemand.com`;
}

function getCfCredentials(): { username: string; password: string; origin: string } {
  const vars = getConfig().variables ?? {};
  return {
    username: process.env.CF_USERNAME ?? vars['CF_USERNAME'] ?? '',
    password: process.env.CF_PASSWORD ?? vars['CF_PASSWORD'] ?? '',
    origin:   process.env.CF_ORIGIN   ?? vars['CF_ORIGIN']   ?? '',
  };
}

const RATE_LIMIT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries on HTTP 429, honouring the Retry-After header (seconds).
// Falls back to exponential backoff (2 s, 4 s, 8 s) when the header is absent.
async function fetchWithRateLimit(request: () => Promise<Response>, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await request();
    if (res.status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) return res;
    const raw      = res.headers.get('Retry-After');
    const secs     = raw ? parseFloat(raw) : NaN;
    const waitMs   = Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) * 1000 : 2 ** (attempt + 1) * 1000;
    logger.warn({ label, attempt: attempt + 1, waitMs }, 'CF API rate limited — backing off');
    await sleep(waitMs);
  }
}

async function httpGet(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetchWithRateLimit(() => fetch(url, { headers }), url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

async function httpPostForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();
  const res  = await fetchWithRateLimit(
    () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }),
    url,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function getTokenEndpoint(region: string): Promise<string> {
  const info = await httpGet(`${cfApiUrl(region)}/v2/info`) as { token_endpoint?: string };
  if (!info.token_endpoint) throw new Error(`No token_endpoint in /v2/info for ${region}`);
  return info.token_endpoint;
}

async function loadTokenStore(): Promise<TokenStore> {
  try {
    const raw = await readFile(TOKEN_PATH, 'utf-8');
    return JSON.parse(raw) as TokenStore;
  } catch { return {}; }
}

async function saveTokenStore(store: TokenStore): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

async function loginRegion(region: string, creds: { username: string; password: string; origin: string }): Promise<CfRegionToken> {
  const api_url = cfApiUrl(region);
  const token_endpoint = await getTokenEndpoint(region);

  const params: Record<string, string> = {
    grant_type: 'password',
    username:   creds.username,
    password:   creds.password,
    client_id:  'cf',
    client_secret: '',
  };
  if (creds.origin) params['login_hint'] = JSON.stringify({ origin: creds.origin });

  const data = await httpPostForm(`${token_endpoint}/oauth/token`, params);
  const expiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : 1200;
  return {
    api_url,
    token_endpoint,
    access_token:  String(data['access_token'] ?? ''),
    refresh_token: String(data['refresh_token'] ?? ''),
    token_type:    String(data['token_type']    ?? 'bearer'),
    expires_at:    Date.now() + expiresIn * 1000,
    login_type:    'password',
  };
}

async function refreshToken(existing: CfRegionToken): Promise<CfRegionToken> {
  const data = await httpPostForm(`${existing.token_endpoint}/oauth/token`, {
    grant_type:    'refresh_token',
    refresh_token: existing.refresh_token,
    client_id:     'cf',
    client_secret: '',
  });
  const expiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : 1200;
  return {
    ...existing,
    access_token:  String(data['access_token']  ?? existing.access_token),
    refresh_token: String(data['refresh_token'] ?? existing.refresh_token),
    expires_at:    Date.now() + expiresIn * 1000,
    login_type:    'refresh',
  };
}

/** Returns a valid access token for the region; refreshes or re-logins as needed. */
export async function getOrRefreshToken(region: string): Promise<CfRegionToken> {
  await ensureInitialized();
  const existing = tokenStore[region];
  if (existing && existing.expires_at - Date.now() > 60_000) return existing;

  // Try refresh first
  if (existing?.refresh_token) {
    try {
      const refreshed = await refreshToken(existing);
      tokenStore[region] = refreshed;
      await saveTokenStore(tokenStore);
      logger.debug({ region }, 'CF token refreshed');
      return refreshed;
    } catch (err) {
      logger.debug({ region, err }, 'CF token refresh failed — re-logging in');
    }
  }

  // Fall back to password login
  if (!cachedUsername || !cachedPassword) throw new Error(`No CF credentials available for region ${region}`);
  try {
    const token = await loginRegion(region, { username: cachedUsername, password: cachedPassword, origin: cachedOrigin });
    tokenStore[region] = token;
    await saveTokenStore(tokenStore);
    logger.info({ region, username: cachedUsername, origin: cachedOrigin },
      `${cachedUsername} cf-login ${region} via (${cachedOrigin}) successfully`);
    return token;
  } catch (err) {
    logger.error({ region, username: cachedUsername, origin: cachedOrigin, err },
      `${cachedUsername} cf-login ${region} via (${cachedOrigin}) failed`);
    throw err;
  }
}

/** Fetches all accessible CF organizations for a region. */
export async function fetchOrgsForRegion(region: string): Promise<Array<{ guid: string; name: string }>> {
  const token = await getOrRefreshToken(region);
  const url = `${token.api_url}/v3/organizations?per_page=200`;
  const data = await httpGet(url, { Authorization: `${token.token_type} ${token.access_token}` }) as {
    resources?: Array<{ guid: string; name: string }>;
  };
  return (data.resources ?? []).map(r => ({ guid: r.guid, name: r.name }));
}

