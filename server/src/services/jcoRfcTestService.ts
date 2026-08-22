import { createHash } from 'node:crypto';
import { getCachedUserToken, getServiceToken } from './authService.js';
import { exportDestination, exportInstanceDestination } from './destinationService.js';
import { logger } from '../logger.js';
import type { UserInfo } from './destTestService.js';

export type { RfcTestRequest, RfcTestResult } from './rfcTestService.js';
import type { RfcTestRequest, RfcTestResult } from './rfcTestService.js';

// ─── Destination name generation ──────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_');
}

function makeDestName(region: string, subdomain: string, name: string, props: Record<string, unknown>): string {
  // Hash of sorted properties guarantees same content → same name → skip re-creation.
  const sorted    = Object.fromEntries(Object.keys(props).sort().map(k => [k, props[k]]));
  const shortHash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 8);
  const seg       = `${sanitize(region)}_${sanitize(subdomain)}_${sanitize(name)}`.slice(0, 185);
  return `${seg}_${shortHash}`.toUpperCase();
}

// ─── Instance destination cache ───────────────────────────────────────────────
// Keyed by destination name. Same name = same properties hash = no need to POST again.

const destCache = new Set<string>();

// ─── Destination service credentials (own btp-admin-dest binding) ─────────────

interface DestCreds { uri: string; clientid: string; clientsecret: string; url: string; }

function getOwnDestCreds(): DestCreds | null {
  try {
    const vcap = JSON.parse(process.env['VCAP_SERVICES'] ?? '{}');
    const c = vcap['destination']?.[0]?.credentials;
    if (c?.uri && c?.clientid && c?.clientsecret && c?.url) return c as DestCreds;
  } catch { /* ignore */ }
  return null;
}

async function getDestServiceToken(creds: DestCreds): Promise<string> {
  const body  = new URLSearchParams({ grant_type: 'client_credentials', response_type: 'token' });
  const basic = Buffer.from(`${creds.clientid}:${creds.clientsecret}`).toString('base64');
  const res   = await fetch(`${creds.url}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const json = await res.json() as { access_token: string };
  return json.access_token;
}

// ─── Instance destination upsert ──────────────────────────────────────────────

async function ensureInstanceDest(
  destName: string,
  jcoProps: Record<string, unknown>,
): Promise<void> {
  if (destCache.has(destName)) {
    logger.debug({ destName }, 'Instance destination cached — skipping create');
    return;
  }

  const creds = getOwnDestCreds();
  if (!creds) {
    throw new Error('btp-admin-dest not found in VCAP_SERVICES — bind the destination service to btp-admin in mta.yaml');
  }

  const token   = await getDestServiceToken(creds);
  const url     = `${creds.uri}/destination-configuration/v1/instanceDestinations`;
  // Post raw JCo properties as-is — no field-name conversion. The BTP Destination Service
  // stores them verbatim and JCo resolves jco.client.* properties when getDestination() is called.
  // Name must come LAST so the generated destName wins over any 'Name' field in jcoProps.
  // Type is not hardcoded — use whatever Type the stored destination already declares.
  const payload = JSON.stringify({ ...jcoProps, Name: destName });

  logger.info({ destName, url }, 'Creating instance destination');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });

  if (res.ok) {
    logger.info({ destName, status: res.status }, 'Instance destination created');
    destCache.add(destName);
    return;
  }

  if (res.status === 409) {
    // Already exists. Same name = same hash = same content, so no update needed.
    logger.info({ destName }, 'Instance destination already exists — skipping');
    destCache.add(destName);
    return;
  }

  const errBody = await res.text();
  throw new Error(`POST instanceDestinations ${res.status}: ${errBody.slice(0, 200)}`);
}

// ─── Sidecar call ─────────────────────────────────────────────────────────────

function getSidecarUrl(): string {
  return (process.env['SIDECAR_URL'] ?? '').replace(/\/$/, '');
}

async function callSidecar(
  destinationName: string,
  req: RfcTestRequest,
  userJwt: string | undefined,
): Promise<RfcTestResult> {
  const sidecarUrl = getSidecarUrl();
  if (!sidecarUrl) {
    return {
      ok: false,
      error: 'Sidecar not configured',
      detail: 'SIDECAR_URL environment variable is not set. Deploy btp-admin-sidecar and wire it via MTA provides/requires.',
      source: 'config',
    };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const authToken = userJwt ?? (await getServiceToken()) ?? undefined;
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  // CSRF preflight — SAP Java Buildpack may inject a CSRF filter
  try {
    const csrfRes = await fetch(`${sidecarUrl}/ping`, {
      method: 'GET',
      headers: { 'X-CSRF-Token': 'Fetch', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    const csrfToken = csrfRes.headers.get('x-csrf-token');
    if (csrfToken && csrfToken.toLowerCase() !== 'nocheck') headers['X-CSRF-Token'] = csrfToken;
  } catch (e) {
    logger.warn({ err: e }, 'Sidecar CSRF preflight failed, continuing without token');
  }

  logger.info({ sidecarUrl: `${sidecarUrl}/api/test-rfc`, destinationName }, 'Sidecar POST /api/test-rfc');

  const res = await fetch(`${sidecarUrl}/api/test-rfc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ destinationName, rfcName: req.rfcName, importParams: req.importParams }),
    signal: AbortSignal.timeout(60_000),
  });

  logger.info({ status: res.status }, 'Sidecar response');

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const text    = await res.text();
    const stripped = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    logger.warn({ status: res.status, ct, body: stripped }, 'Sidecar non-JSON response');
    return { ok: false, error: `Sidecar HTTP ${res.status}`, detail: stripped || `non-JSON response (${ct})`, source: 'connectivity' };
  }

  return await res.json() as RfcTestResult;
}

// ─── RFC test orchestration ───────────────────────────────────────────────────

async function runJcoRfcTest(
  region: string,
  subdomain: string,
  name: string,
  destData: Record<string, unknown>,
  req: RfcTestRequest,
  userSub: string,
): Promise<RfcTestResult> {
  const proxyType = destData['jco.destination.proxy_type'] as string | undefined;
  if (proxyType !== 'OnPremise') {
    return {
      ok: false,
      error: `Proxy type "${proxyType ?? 'none'}" is not supported`,
      detail: 'Only OnPremise RFC destinations (via BTP Connectivity / Cloud Connector) can be tested.',
      source: 'config',
    };
  }

  const authType = destData['jco.destination.auth_type'] as string | undefined;
  const isPP     = authType === 'PrincipalPropagation';

  let userJwt: string | undefined;
  const cached = getCachedUserToken(userSub);
  if (cached) {
    userJwt = cached;
  } else if (isPP) {
    return {
      ok: false,
      error: 'User JWT not available',
      detail: 'Re-login is required for PrincipalPropagation destinations.',
      source: 'auth',
    };
  }

  const destName = makeDestName(region, subdomain, name, destData);

  logger.info({ destName, rfcName: req.rfcName, isPP, sidecarUrl: getSidecarUrl() || '(not set)' }, 'RFC test via sidecar');

  try {
    await ensureInstanceDest(destName, destData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to create instance destination');
    return { ok: false, error: 'Failed to prepare RFC destination', detail: msg, source: 'config' };
  }

  try {
    return await callSidecar(destName, req, userJwt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sidecarUrl: getSidecarUrl() }, 'Sidecar call failed');
    return { ok: false, error: 'Sidecar unreachable', detail: msg, source: 'connectivity' };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function testSaRfcDestination(
  region: string,
  subdomain: string,
  name: string,
  req: RfcTestRequest,
  user: UserInfo,
): Promise<RfcTestResult> {
  const destData = await exportDestination(region, subdomain, name);
  if (!destData) {
    return { ok: false, error: 'Destination not found', detail: `No stored destination "${name}" in ${subdomain}.`, source: 'config' };
  }
  return runJcoRfcTest(region, subdomain, name, destData, req, user.sub);
}

export async function testInstanceRfcDestination(
  region: string,
  subdomain: string,
  spaceName: string,
  instanceGuid: string,
  name: string,
  req: RfcTestRequest,
  user: UserInfo,
): Promise<RfcTestResult> {
  const destData = await exportInstanceDestination(region, subdomain, spaceName, instanceGuid, name);
  if (!destData) {
    return { ok: false, error: 'Destination not found', detail: `No stored destination "${name}" in instance ${instanceGuid}.`, source: 'config' };
  }
  return runJcoRfcTest(region, subdomain, name, destData, req, user.sub);
}
