import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { logger } from '../logger.js';

export interface XsuaaConfig {
  url: string;
  clientid: string;
  clientsecret: string;
  xsappname: string;
  verificationkey: string;
}

export interface SessionPayload {
  firstName: string;
  lastName: string;
  userName: string;
  email: string;
  initials: string;
  origin: string;
  isAdmin: boolean;
  sub: string;
  exp: number;
}

/** Returns "userName <email> (origin)" — compact form used in operation audit logs. */
export function userLabel(s: SessionPayload): string {
  const parts: string[] = [s.userName];
  if (s.email && s.email !== s.userName) parts.push(`<${s.email}>`);
  if (s.origin) parts.push(`(${s.origin})`);
  return parts.join(' ');
}

/** Returns full user info object for login/logout audit logs. */
export function userAuditLog(s: SessionPayload): { id: string; name: string; email: string; origin: string; isAdmin: boolean; firstName: string; lastName: string } {
  return { id: s.sub, name: s.userName, email: s.email, origin: s.origin, isAdmin: s.isAdmin, firstName: s.firstName, lastName: s.lastName };
}

// ─── User JWT cache (for PrincipalPropagation) ───────────────────────────────
// Maps sub → { token, exp } so the test endpoint can do a jwt-bearer exchange.
const _userTokenCache = new Map<string, { token: string; exp: number }>();

export function cacheUserToken(sub: string, token: string, exp: number): void {
  _userTokenCache.set(sub, { token, exp });
}

export function getCachedUserToken(sub: string): string | null {
  const entry = _userTokenCache.get(sub);
  if (!entry || entry.exp < Date.now() / 1000 + 60) { _userTokenCache.delete(sub); return null; }
  return entry.token;
}

// Cache after first parse so we don't re-parse VCAP on every request
let _xsuaa: XsuaaConfig | null | undefined = undefined;
let _appUrl: string | undefined = undefined;

export function getXsuaaConfig(): XsuaaConfig | null {
  if (_xsuaa !== undefined) return _xsuaa;
  try {
    const raw = process.env.VCAP_SERVICES;
    if (!raw) { _xsuaa = null; return null; }
    const vcap = JSON.parse(raw) as Record<string, { credentials: XsuaaConfig }[]>;
    const creds = vcap.xsuaa?.[0]?.credentials;
    if (!creds?.url || !creds?.clientid || !creds?.clientsecret) { _xsuaa = null; return null; }
    _xsuaa = creds;
    return _xsuaa;
  } catch { _xsuaa = null; return null; }
}

export function getAppUrl(): string {
  if (_appUrl !== undefined) return _appUrl;
  try {
    const raw = process.env.VCAP_APPLICATION;
    if (!raw) { _appUrl = ''; return ''; }
    const vcap = JSON.parse(raw) as { application_uris?: string[] };
    const uri = vcap.application_uris?.[0];
    _appUrl = uri ? `https://${uri}` : '';
    return _appUrl;
  } catch { _appUrl = ''; return ''; }
}

export function buildAuthUrl(callbackBase: string): string {
  const x = getXsuaaConfig();
  if (!x) throw new Error('XSUAA not configured');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: x.clientid,
    redirect_uri: `${callbackBase}/login/callback`,
  });
  return `${x.url}/oauth/authorize?${params}`;
}

function fetchJson(url: string, method: string, headers: Record<string, string | number>, body?: string): Promise<Record<string, unknown>> {
  const isHttps = url.startsWith('https://');
  const request = isHttps ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body, 'utf-8') : undefined;
    const req = request(url, { method, headers: { ...headers, ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

export async function exchangeCode(code: string, callbackBase: string): Promise<{ session: SessionPayload; accessToken: string }> {
  const x = getXsuaaConfig();
  if (!x) throw new Error('XSUAA not configured');

  const basicAuth = Buffer.from(`${x.clientid}:${x.clientsecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${callbackBase}/login/callback`,
  }).toString();

  const data = await fetchJson(`${x.url}/oauth/token`, 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${basicAuth}`,
  }, body);

  const accessToken = data.access_token as string | undefined;
  if (!accessToken) throw new Error('No access_token in token response');

  const claims = verifyJwt(accessToken, x.verificationkey);

  const givenName = claims.given_name as string | undefined;
  const familyName = claims.family_name as string | undefined;
  const email = claims.email as string | undefined;
  const userNameClaim = claims.user_name as string | undefined;
  const firstName = givenName ?? email?.split('@')[0] ?? userNameClaim ?? 'User';
  const userName = (userNameClaim ?? email ?? '') as string;
  const origin = (claims.origin as string | undefined) ?? '';

  // Build full name for initials: prefer display name claim, fall back to given+family
  const joinedName = [givenName, familyName].filter(Boolean).join(' ');
  const fullName = (claims.name as string | undefined) ?? (joinedName || firstName);
  const initials = fullName.trim().split(/\s+/).map(w => (w[0] ?? '').toUpperCase()).join('').slice(0, 2) || '?';

  const lastName = familyName ?? '';

  const scopes = (claims.scope as string[] | string | undefined);
  const scopeList = Array.isArray(scopes) ? scopes : typeof scopes === 'string' ? scopes.split(' ') : [];
  const isAdmin = scopeList.includes(`${x.xsappname}.admin`);
  logger.debug({
    user: { id: (claims.sub as string | undefined) ?? '', name: userName, email: email ?? '', origin, isAdmin, firstName, lastName },
    xsappname: x.xsappname,
    scopes: scopeList,
  }, 'JWT scope check');

  const session: SessionPayload = {
    firstName,
    lastName,
    userName,
    email: email ?? '',
    initials,
    origin,
    isAdmin,
    sub: (claims.sub as string | undefined) ?? '',
    exp: (claims.exp as number | undefined) ?? Math.floor(Date.now() / 1000) + 86400,
  };
  return { session, accessToken };
}

function verifyJwt(token: string, publicKey: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const [header, payload, sig] = parts as [string, string, string];
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  if (!verifier.verify(publicKey, Buffer.from(sig, 'base64url'))) throw new Error('Invalid JWT signature');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>;
  if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) throw new Error('JWT expired');
  return claims;
}

export function signSession(payload: SessionPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

export function verifySession(value: string, secret: string): SessionPayload | null {
  const dot = value.indexOf('.');
  if (dot === -1) return null;
  const data = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  const expBuf = Buffer.from(expected);
  const actBuf = Buffer.from(mac);
  if (expBuf.length !== actBuf.length || !timingSafeEqual(expBuf, actBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as SessionPayload;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

export function readSessionFromRequest(cookieHeader: string, secret: string): SessionPayload | null {
  const entry = cookieHeader.split(';').map(p => p.trim()).find(p => p.startsWith('btpauth='));
  if (!entry) return null;
  return verifySession(entry.slice('btpauth='.length), secret);
}
