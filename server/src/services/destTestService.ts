import http from 'node:http';
import { getCachedUserToken } from './authService.js';
import { exportDestination, exportInstanceDestination } from './destinationService.js';
import { logger } from '../logger.js';

export interface TestRequest {
  method: string;
  path: string;
  headers: Array<{ key: string; value: string }>;
  body?: string;
}

export interface UserInfo {
  sub:   string;
  email: string;
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|sap-connectivity-authentication|sap-connectivity-authentication-v2)$|token|secret|password|credential/i;

function redactHeaders(headers: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return headers.map(h => SENSITIVE_HEADER.test(h.key) ? { key: h.key, value: '[REDACTED]' } : h);
}

export type TestResult =
  | { ok: true; status: number; statusText: string; durationMs: number;
      headers: Array<{ key: string; value: string }>; body: string }
  | { ok: false; error: string; detail: string;
      source: 'config' | 'auth' | 'connectivity' | 'network' | 'timeout' };

interface ConnCreds {
  onpremise_proxy_host: string;
  // HTTP CONNECT proxy (HTTP/HTTPS destinations)
  onpremise_proxy_http_port?: string;
  onpremise_proxy_port?: string;
  // SOCKS5 proxy with SAP JWT auth — generic TCP
  onpremise_socks5_proxy_port?: string;
  // HTTP CONNECT proxy specifically for RFC destinations (typically 20001)
  onpremise_proxy_rfc_port?: string;
  // Optional Cloud Connector location ID for multi-CC setups
  location_id?: string;
  // token_service_url may be the bare XSUAA base URL or may already include /oauth/token.
  // url is the canonical bare XSUAA base URL (preferred by the SAP Cloud SDK).
  token_service_url?: string;
  url?: string;
  clientid: string;
  clientsecret: string;
}

let _connCreds: ConnCreds | null | undefined;

export function getConnectivityCreds(): ConnCreds | null {
  if (_connCreds !== undefined) return _connCreds;
  try {
    const vcap = process.env.VCAP_SERVICES;
    if (!vcap) { _connCreds = null; return null; }
    const parsed = JSON.parse(vcap) as Record<string, unknown>;
    const arr = parsed['connectivity'] as Array<{ credentials: ConnCreds }> | undefined;
    _connCreds = arr?.[0]?.credentials ?? null;
  } catch {
    _connCreds = null;
  }
  return _connCreds;
}

// client_credentials token cache (for non-PP requests — authenticates the app)
let _ccConnTokenCache: { token: string; expiresAt: number } | null = null;
// jwt-bearer token cache (for PP requests — authenticates app + encodes user identity)
const _ppConnTokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get a connectivity service token.
 *
 * Without userJwt: client_credentials grant — authenticates the app only.
 *   Used for NoAuthentication and BasicAuthentication destinations.
 *
 * With userJwt: jwt-bearer grant — exchanges the user's XSUAA JWT for a
 *   connectivity-scoped token that embeds the user identity.
 *   Used for PrincipalPropagation destinations.  The connectivity proxy reads
 *   the user identity out of the Proxy-Authorization token itself, so we do
 *   NOT need a separate SAP-Connectivity-Authentication header.  This is
 *   important: the two-header approach (client_credentials + SAP-Connectivity-
 *   Authentication) causes the connectivity proxy to forward the
 *   SAP-Connectivity-Authentication header through to SCC and then to the ABAP
 *   backend, where the ICM's JWT auth handler sees it and rejects the request
 *   before the PP X.509 certificate has a chance to authenticate the user.
 */
export async function getConnectivityToken(userJwt?: string): Promise<string> {
  const now = Date.now();
  const conn = getConnectivityCreds();
  if (!conn) throw new Error('Connectivity service not bound');
  const basic = Buffer.from(`${conn.clientid}:${conn.clientsecret}`).toString('base64');
  // Prefer 'url' (bare XSUAA base URL, as the SAP Cloud SDK uses), fall back to
  // 'token_service_url'. Strip trailing /oauth/token so we don't double it.
  const rawBase = (conn.url ?? conn.token_service_url ?? '').replace(/\/oauth\/token$/, '');
  const tokenUrl = `${rawBase}/oauth/token`;

  if (userJwt) {
    // jwt-bearer: exchange user JWT for a connectivity-scoped token that includes the user identity.
    const cacheKey = (peekJwtClaims(userJwt)?.['sub'] as string | undefined) ?? userJwt.slice(-20);
    const cached = _ppConnTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now + 60_000) return cached.token;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: userJwt,
    });
    logger.debug({ tokenUrl, grantType: 'jwt-bearer', proxyHost: conn.onpremise_proxy_host,
      proxyHttpPort: conn.onpremise_proxy_http_port }, 'Fetching connectivity token (jwt-bearer)');
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`JWT-bearer token exchange failed: ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    const json = await res.json() as { access_token: string; expires_in: number };
    _ppConnTokenCache.set(cacheKey, { token: json.access_token, expiresAt: now + json.expires_in * 1000 });
    return json.access_token;
  }

  // client_credentials: authenticates the app only (no user identity)
  if (_ccConnTokenCache && _ccConnTokenCache.expiresAt > now + 60_000) return _ccConnTokenCache.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  logger.debug({ tokenUrl, grantType: 'client_credentials', proxyHost: conn.onpremise_proxy_host,
    proxyHttpPort: conn.onpremise_proxy_http_port, proxyPort: conn.onpremise_proxy_port }, 'Fetching connectivity token');
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Connectivity token fetch failed: ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  _ccConnTokenCache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return json.access_token;
}

function buildAuthHeader(destData: Record<string, unknown>): string | null {
  const auth = destData['Authentication'] as string | undefined;
  if (!auth || auth === 'NoAuthentication' || auth === 'PrincipalPropagation') return null;
  if (auth === 'BasicAuthentication') {
    const user = (destData['User'] as string | undefined) ?? '';
    const pass = (destData['Password'] as string | undefined) ?? '';
    // Don't send garbage credentials if the destination has no user — the BTP sync API
    // omits the Password field for some destination types, so we must not send Base64(':').
    if (!user) return null;
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return null;
}

/** Decode JWT payload without verification — for diagnostic logging only. */
function peekJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch { return null; }
}

function httpStatusText(status: number): string {
  const map: Record<number, string> = {
    200:'OK',201:'Created',204:'No Content',301:'Moved Permanently',302:'Found',
    304:'Not Modified',400:'Bad Request',401:'Unauthorized',403:'Forbidden',
    404:'Not Found',405:'Method Not Allowed',409:'Conflict',429:'Too Many Requests',
    500:'Internal Server Error',502:'Bad Gateway',503:'Service Unavailable',504:'Gateway Timeout',
  };
  return map[status] ?? 'Unknown';
}

// Join destination base URL with user-supplied path without double-slash
function joinPath(base: string, suffix: string): string {
  if (!suffix || suffix === '/') return base;
  if (base.endsWith('/') && suffix.startsWith('/')) return base + suffix.slice(1);
  if (!base.endsWith('/') && !suffix.startsWith('/')) return base + '/' + suffix;
  return base + suffix;
}

async function runInternetTest(destData: Record<string, unknown>, req: TestRequest): Promise<TestResult> {
  const destUrl = (destData['URL'] as string | undefined) ?? '';
  const fullUrl = joinPath(destUrl, req.path);

  const auth = destData['Authentication'] as string | undefined;
  if (auth && auth !== 'NoAuthentication' && auth !== 'BasicAuthentication') {
    return { ok: false, error: `Authentication type "${auth}" is not supported for testing`, detail: 'Only NoAuthentication and BasicAuthentication are supported.', source: 'config' };
  }

  const headers: Record<string, string> = {};
  for (const h of req.headers) { if (h.key) headers[h.key] = h.value; }
  const authHeader = buildAuthHeader(destData);
  if (authHeader) headers['Authorization'] = authHeader;
  const sapClient = destData['sap-client'] as string | undefined;
  if (sapClient) headers['sap-client'] = sapClient;

  const start = Date.now();
  try {
    const res = await fetch(fullUrl, {
      method: req.method,
      headers,
      body: req.body && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const durationMs = Date.now() - start;
    const respHeaders: Array<{ key: string; value: string }> = [];
    res.headers.forEach((v, k) => respHeaders.push({ key: k, value: v }));
    const body = await res.text();
    return { ok: true, status: res.status, statusText: res.statusText || httpStatusText(res.status), durationMs, headers: respHeaders, body };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { ok: false, error: 'Request timed out', detail: `No response after ${durationMs}ms`, source: 'timeout' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'Network error', detail: msg, source: 'network' };
  }
}

type RawProxyResult =
  | { kind: 'response'; status: number; statusText: string; headers: Array<{ key: string; value: string }>; body: string }
  | { kind: 'network'; message: string }
  | { kind: 'timeout' };

function doProxyRequest(
  host: string, port: number,
  method: string, path: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RawProxyResult> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method, path, headers }, (res) => {
      const respHeaders: Array<{ key: string; value: string }> = [];
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach(val => respHeaders.push({ key: k, value: val }));
        else if (typeof v === 'string') respHeaders.push({ key: k, value: v });
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        kind: 'response',
        status: res.statusCode ?? 0,
        statusText: res.statusMessage || httpStatusText(res.statusCode ?? 0),
        headers: respHeaders,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
      res.on('error', (err) => resolve({ kind: 'network', message: err.message }));
    });
    req.setTimeout(30_000, () => { req.destroy(); resolve({ kind: 'timeout' }); });
    req.on('error', (err) => resolve({ kind: 'network', message: err.message }));
    if (body && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

async function runOnPremiseTest(destData: Record<string, unknown>, req: TestRequest, userSub: string): Promise<TestResult> {
  const conn = getConnectivityCreds();
  if (!conn) return { ok: false, error: 'Connectivity service not bound', detail: 'The connectivity service resource is not bound to this application.', source: 'connectivity' };

  const isPP = destData['Authentication'] === 'PrincipalPropagation';

  // For PrincipalPropagation, retrieve the cached user JWT before any async work
  let userJwt: string | undefined;
  if (isPP) {
    const cached = getCachedUserToken(userSub);
    if (!cached) {
      return { ok: false, error: 'User JWT not available', detail: 'Re-login is required for PrincipalPropagation destinations — the session token has expired or was not cached.', source: 'auth' };
    }
    userJwt = cached;
  }

  let token: string;
  try {
    // For PP: use jwt-bearer grant so the user identity is embedded in Proxy-Authorization.
    // The connectivity proxy extracts the user from this token to drive PP in SCC.
    // For non-PP: client_credentials (authenticates the app only).
    token = await getConnectivityToken(isPP ? userJwt : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'Failed to obtain connectivity token', detail: msg, source: 'connectivity' };
  }

  const destUrl = (destData['URL'] as string | undefined) ?? '';
  const fullPath = joinPath(destUrl, req.path);

  // Build proxy request headers
  const reqHeaders: Record<string, string> = {};
  for (const h of req.headers) { if (h.key) reqHeaders[h.key] = h.value; }

  // For PP: the jwt-bearer token already encodes the user identity — no separate header needed.
  // For non-PP: client_credentials token authenticates the application.
  reqHeaders['Proxy-Authorization'] = `Bearer ${token}`;

  // Cloud Connector location ID (optional, for multi-SCC setups)
  const locationId = destData['CloudConnectorLocationId'] as string | undefined;
  if (locationId) reqHeaders['SAP-Connectivity-SCC-Location_ID'] = locationId;

  // Backend authentication header (BasicAuthentication)
  const authHeader = buildAuthHeader(destData);
  if (authHeader) reqHeaders['authorization'] = authHeader;
  const sapClient = destData['sap-client'] as string | undefined;
  if (sapClient) reqHeaders['sap-client'] = sapClient;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fullPath);
  } catch {
    return { ok: false, error: 'Invalid destination URL', detail: `Cannot parse URL: ${fullPath}`, source: 'config' };
  }

  // SDK selects onpremise_proxy_http_port first, falls back to onpremise_proxy_port.
  const proxyPort = parseInt(conn.onpremise_proxy_http_port ?? conn.onpremise_proxy_port ?? '', 10);
  // Host header must reflect the backend virtual host, not the proxy host.
  const outHeaders = { ...reqHeaders, host: parsedUrl.host };

  // Diagnostic log — confirm what we are actually sending to the connectivity proxy.
  // This is the single most useful log for diagnosing OnPremise 401s and PP failures.
  {
    const destAuth = destData['Authentication'] as string | undefined;
    const logCtx: Record<string, unknown> = {
      proxyHost: conn.onpremise_proxy_host,
      proxyPort,
      destUrl,
      destAuth,
      isPP,
      outHeaderKeys: Object.keys(outHeaders),
      hasProxyAuth: 'Proxy-Authorization' in outHeaders,
    };
    if (destAuth === 'BasicAuthentication') {
      logCtx['hasUser']     = !!(destData['User'] as string | undefined);
      logCtx['hasPassword'] = !!(destData['Password'] as string | undefined);
      logCtx['authHeaderBuilt'] = 'Authorization' in outHeaders;
    }
    if (isPP && userJwt) {
      const claims = peekJwtClaims(userJwt);
      logCtx['ppGrantType']  = 'jwt-bearer';   // user identity embedded in Proxy-Authorization token
      logCtx['ppJwtPresent'] = true;
      logCtx['ppJwtClaims']  = claims
        ? { iss: claims['iss'], sub: claims['sub'], exp: claims['exp'], aud: claims['aud'], zid: claims['zid'] }
        : null;
    } else if (isPP) {
      logCtx['ppJwtPresent'] = false;
    }
    logger.debug(logCtx, 'OnPremise test dispatch');
  }

  const start = Date.now();
  const raw = await doProxyRequest(conn.onpremise_proxy_host, proxyPort, req.method, fullPath, outHeaders, req.body);
  const durationMs = Date.now() - start;

  if (raw.kind === 'timeout') {
    return { ok: false, error: 'Request timed out', detail: `No response after ${durationMs}ms`, source: 'timeout' };
  }
  if (raw.kind === 'network') {
    return { ok: false, error: 'Network error', detail: raw.message, source: 'network' };
  }

  const sapAuth = raw.headers.find(h => h.key.toLowerCase() === 'sap-authenticated')?.value;
  if (sapAuth !== undefined) {
    // sap-authenticated is set by the connectivity proxy when the request was intercepted
    // before reaching the backend.  'false' = SCC session not yet open; 'pending' = setting up.
    // Its presence means the backend was NOT reached.
    logger.debug({ sapAuthenticated: sapAuth, status: raw.status, isPP }, 'OnPremise proxy intercept (sap-authenticated header present)');
  }

  return { ok: true, status: raw.status, statusText: raw.statusText, durationMs, headers: raw.headers, body: raw.body };
}

async function runTest(destData: Record<string, unknown>, req: TestRequest, userSub: string): Promise<TestResult> {
  if (destData['Type'] !== 'HTTP') {
    return { ok: false, error: `Destination type "${destData['Type'] ?? 'RFC'}" is not supported for testing`, detail: 'Only HTTP destinations can be tested.', source: 'config' };
  }
  if (destData['ProxyType'] === 'OnPremise') return runOnPremiseTest(destData, req, userSub);
  return runInternetTest(destData, req);
}

export async function testSaDestination(
  region: string, subdomain: string, name: string,
  req: TestRequest, user: UserInfo,
): Promise<TestResult> {
  logger.info({
    user:  { sub: user.sub, email: user.email },
    dest:  { region, subdomain, name },
    req:   { method: req.method, path: req.path, headers: redactHeaders(req.headers), body: req.body },
  }, 'Destination test request');
  const destData = await exportDestination(region, subdomain, name);
  if (!destData) return { ok: false, error: 'Destination not found', detail: `No destination "${name}" found in ${subdomain}.`, source: 'config' };
  const result = await runTest(destData, req, user.sub);
  logger.debug({
    dest:   { region, subdomain, name },
    result: result.ok
      ? { ok: true, status: result.status, statusText: result.statusText, durationMs: result.durationMs }
      : { ok: false, error: result.error, detail: result.detail, source: result.source },
  }, 'Destination test result');
  return result;
}

export async function testInstanceDestination(
  region: string, subdomain: string,
  spaceName: string, instanceGuid: string, name: string,
  req: TestRequest, user: UserInfo,
): Promise<TestResult> {
  logger.info({
    user:  { sub: user.sub, email: user.email },
    dest:  { region, subdomain, spaceName, instanceGuid, name },
    req:   { method: req.method, path: req.path, headers: redactHeaders(req.headers), body: req.body },
  }, 'Destination test request');
  const destData = await exportInstanceDestination(region, subdomain, spaceName, instanceGuid, name);
  if (!destData) return { ok: false, error: 'Destination not found', detail: `No destination "${name}" found in instance ${instanceGuid}.`, source: 'config' };
  const result = await runTest(destData, req, user.sub);
  logger.debug({
    dest:   { region, subdomain, spaceName, instanceGuid, name },
    result: result.ok
      ? { ok: true, status: result.status, statusText: result.statusText, durationMs: result.durationMs }
      : { ok: false, error: result.error, detail: result.detail, source: result.source },
  }, 'Destination test result');
  return result;
}
