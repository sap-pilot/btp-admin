import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

const BTP_BASE = 'https://cli.btp.cloud.sap';
const BTP_UA   = 'btpCLI/2.106.1 (Linux/amd64, Ubuntu)';
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function btpRetry(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await request();
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
    const raw    = res.headers.get('Retry-After');
    const secs   = raw ? parseFloat(raw) : NaN;
    const waitMs = Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) * 1000 : 2 ** (attempt + 1) * 1000;
    logger.warn({ attempt: attempt + 1, waitMs }, 'BTP CLI rate limited — backing off');
    await sleep(waitMs);
  }
}

export async function btpLogin(username: string, password: string): Promise<string> {
  const url        = `${BTP_BASE}/login/v2.106.1`;
  const reqHeaders = {
    'content-type':    'application/json',
    'user-agent':      BTP_UA,
    'x-correlationid': randomUUID(),
  };
  const reqBody = JSON.stringify({ customIdp: '', userName: username, password, jwt: '' });
  if (logger.isLevelEnabled('trace')) {
    logger.trace({ method: 'POST', url, reqHeaders, reqBody }, 'BTP CLI request');
  }
  const t0  = Date.now();
  const res = await btpRetry(() => fetch(url, { method: 'POST', headers: reqHeaders, body: reqBody }));
  const ms  = Date.now() - t0;
  let resText: string | undefined;
  if (logger.isLevelEnabled('trace')) {
    resText = await res.text().catch(() => '');
    logger.trace({ method: 'POST', url, status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: resText }, 'BTP CLI response');
  }
  logger.debug({ method: 'POST', url, status: res.status, cl: res.headers.get('content-length'), ms }, 'BTP CLI call');
  if (!res.ok) {
    const text = resText ?? await res.text().catch(() => '');
    throw new Error(`BTP CLI login → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const sessionId = res.headers.get('x-cpcli-sessionid');
  if (!sessionId) throw new Error('BTP CLI login: x-cpcli-sessionid missing from response');
  return sessionId;
}

async function btpPost(
  sessionId:   string,
  gaSubdomain: string,
  path:        string,
  body?:       unknown,
  format =     'json',
): Promise<unknown> {
  const url        = `${BTP_BASE}${path}`;
  const reqHeaders = {
    'x-cpcli-sessionid': sessionId,
    'x-cpcli-subdomain': gaSubdomain,
    'x-cpcli-format':    format,
    'content-type':      'application/json',
    'x-correlationid':   randomUUID(),
    'user-agent':        BTP_UA,
  };
  const reqBody = body !== undefined ? JSON.stringify(body) : '';
  if (logger.isLevelEnabled('trace')) {
    logger.trace({ method: 'POST', url, reqHeaders, reqBody }, 'BTP CLI request');
  }
  const t0  = Date.now();
  const res = await btpRetry(() => fetch(url, { method: 'POST', headers: reqHeaders, body: reqBody }));
  const ms  = Date.now() - t0;
  let resText: string | undefined;
  if (logger.isLevelEnabled('trace')) {
    resText = await res.text().catch(() => '');
    logger.trace({ method: 'POST', url, status: res.status, resHeaders: Object.fromEntries(res.headers.entries()), resBody: resText }, 'BTP CLI response');
  }
  logger.debug({ method: 'POST', url, status: res.status, cl: res.headers.get('content-length'), ms }, 'BTP CLI call');
  if (!res.ok) {
    const text = resText ?? await res.text().catch(() => '');
    throw new Error(`BTP CLI POST ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return resText !== undefined ? JSON.parse(resText) : res.json();
}

export interface GaInfo {
  guid:        string;
  subdomain:   string;
  displayName: string;
}

export async function btpListGlobalAccounts(sessionId: string): Promise<GaInfo[]> {
  const data = await btpPost(sessionId, '', '/client/v2.106.1/globalAccountList', undefined, 'text') as GaInfo[];
  return (Array.isArray(data) ? data : [])
    .map(ga => ({
      guid:        String(ga.guid        ?? ''),
      subdomain:   String(ga.subdomain   ?? ''),
      displayName: String(ga.displayName ?? ''),
    }))
    .filter(ga => ga.subdomain);
}

export interface SaRaw {
  guid:              string;
  globalAccountGUID: string;
  displayName:       string;
  subdomain:         string;
  region:            string;
}

export async function btpListSubaccounts(sessionId: string, gaSubdomain: string): Promise<SaRaw[]> {
  const data = await btpPost(sessionId, gaSubdomain, '/command/v2.106.1/accounts/subaccount?list', {
    paramValues: { authorized: 'false', globalAccount: gaSubdomain },
  }) as { value?: SaRaw[] };
  return (data.value ?? [])
    .map(sa => ({
      guid:              String(sa.guid              ?? ''),
      globalAccountGUID: String(sa.globalAccountGUID ?? ''),
      displayName:       String(sa.displayName       ?? ''),
      subdomain:         String(sa.subdomain         ?? ''),
      region:            String(sa.region            ?? ''),
    }))
    .filter(sa => sa.guid);
}

export interface EnvOrgInfo {
  orgId:   string;
  orgName: string;
}

export async function btpListEnvInstances(
  sessionId:     string,
  gaSubdomain:   string,
  subaccountId:  string,
): Promise<EnvOrgInfo[]> {
  const data = await btpPost(sessionId, gaSubdomain, '/command/v2.106.1/accounts/environment-instance?list', {
    paramValues: { subaccount: subaccountId },
  }) as { environmentInstances?: Array<{ environmentType?: string; platformId?: string; labels?: string }> };
  const result: EnvOrgInfo[] = [];
  for (const inst of data.environmentInstances ?? []) {
    if (inst.environmentType !== 'cloudfoundry') continue;
    const orgId = inst.platformId ?? '';
    let orgName = '';
    if (inst.labels) {
      try {
        const parsed = JSON.parse(inst.labels) as Record<string, string>;
        orgName = parsed['Org Name'] ?? '';
      } catch { /* ignore */ }
    }
    if (orgId) result.push({ orgId, orgName });
  }
  return result;
}

export interface SubscriptionInfo {
  displayName:       string;
  url:               string;
  customerDeveloped: boolean;
}

export async function btpListSubscriptions(
  sessionId:    string,
  gaSubdomain:  string,
  subaccountId: string,
): Promise<SubscriptionInfo[]> {
  const data = await btpPost(sessionId, gaSubdomain, '/command/v2.106.1/accounts/subscription?list', {
    paramValues: { subaccount: subaccountId },
  }) as { applications?: Array<{ state?: string; displayName?: string; subscriptionUrl?: string | null; customerDeveloped?: boolean }> };
  return (data.applications ?? [])
    .filter(a => a.state === 'SUBSCRIBED' && a.subscriptionUrl)
    .map(a => ({
      displayName:       String(a.displayName ?? ''),
      url:               String(a.subscriptionUrl),
      customerDeveloped: Boolean(a.customerDeveloped),
    }));
}

export interface RawServiceInstance {
  id:              string;
  name:            string;
  service_plan_id: string;
  dashboard_url:   string;
  spaceId:         string;
}

export async function btpListServiceInstances(
  sessionId:    string,
  gaSubdomain:  string,
  subaccountId: string,
): Promise<RawServiceInstance[]> {
  const data = await btpPost(sessionId, gaSubdomain, '/command/v2.106.1/services/instance?list', {
    paramValues: { subaccount: subaccountId },
  }) as Array<{ id?: string; name?: string; service_plan_id?: string; dashboard_url?: string | null; context?: { space_guid?: string } }>;
  return (Array.isArray(data) ? data : [])
    .filter(inst => inst.dashboard_url && inst.dashboard_url.startsWith('http'))
    .map(inst => ({
      id:              String(inst.id              ?? ''),
      name:            String(inst.name            ?? ''),
      service_plan_id: String(inst.service_plan_id ?? ''),
      dashboard_url:   inst.dashboard_url as string,
      spaceId:         String(inst.context?.space_guid ?? ''),
    }));
}

export async function btpListServicePlans(
  sessionId:    string,
  gaSubdomain:  string,
  subaccountId: string,
): Promise<Map<string, string>> {
  const data = await btpPost(sessionId, gaSubdomain, '/command/v2.106.1/services/plan?list', {
    paramValues: { dataCenter: 'false', subaccount: subaccountId },
  }) as Array<{ id?: string; service_offering_name?: string }>;
  const map = new Map<string, string>();
  for (const plan of Array.isArray(data) ? data : []) {
    if (plan.id && plan.service_offering_name) {
      map.set(String(plan.id), String(plan.service_offering_name));
    }
  }
  return map;
}
