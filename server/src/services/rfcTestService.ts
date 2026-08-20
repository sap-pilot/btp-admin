import { getCachedUserToken } from './authService.js';
import { exportDestination, exportInstanceDestination } from './destinationService.js';
import { getConnectivityCreds, getConnectivityToken } from './destTestService.js';
import { invokeRfc } from '../rfc/rfcAddon.js';
import { withDirectTunnelShim, type TunnelMode } from '../rfc/localProxyShim.js';
import { logger } from '../logger.js';
import type { UserInfo } from './destTestService.js';

export interface RfcTestRequest {
  rfcName: string;
  importParams: Array<{ key: string; value: string }>;
}

export type RfcTestResult =
  | { ok: true; durationMs: number; output: Record<string, unknown> }
  | { ok: false; error: string; detail: string;
      source: 'config' | 'auth' | 'connectivity' | 'addon' | 'rfc' };

async function runRfcTest(
  destData: Record<string, unknown>,
  req: RfcTestRequest,
  userSub: string,
): Promise<RfcTestResult> {
  const proxyType = destData['jco.destination.proxy_type'] as string | undefined;
  if (proxyType !== 'OnPremise') {
    return {
      ok: false,
      error: `Proxy type "${proxyType ?? 'none'}" is not supported for RFC testing`,
      detail: 'Only OnPremise RFC destinations (via BTP Connectivity Service / Cloud Connector) can be tested.',
      source: 'config',
    };
  }

  const addonFn = invokeRfc;
  if (!addonFn) {
    return {
      ok: false,
      error: 'RFC addon not built',
      detail: 'The native RFC addon is not available. Build it with: cd server && npm run build:addon',
      source: 'addon',
    };
  }

  const authType = destData['jco.destination.auth_type'] as string | undefined;
  const isPP = authType === 'PrincipalPropagation';

  let userJwt: string | undefined;
  if (isPP) {
    const cached = getCachedUserToken(userSub);
    if (!cached) {
      return {
        ok: false,
        error: 'User JWT not available',
        detail: 'Re-login is required for PrincipalPropagation RFC destinations — the session token has expired or was not cached.',
        source: 'auth',
      };
    }
    userJwt = cached;
  }

  let token: string;
  try {
    token = await getConnectivityToken(isPP ? userJwt : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'Failed to obtain connectivity token', detail: msg, source: 'connectivity' };
  }

  const conn = getConnectivityCreds();
  if (!conn) {
    return {
      ok: false,
      error: 'Connectivity service not bound',
      detail: 'The connectivity service resource is not bound to this application.',
      source: 'connectivity',
    };
  }

  // Log all keys present in the connectivity binding (values omitted — may contain tokens).
  logger.info({ connFields: Object.keys(conn) }, 'RFC: connectivity binding fields');

  // Port selection strategy (confirmed behavior):
  //   - Port 20001 (onpremise_proxy_rfc_port): JCo-specific SCC binary protocol.
  //     Plain HTTP CONNECT → proxy routes CPIC one-way (proxyToClient=0 confirmed).
  //   - Port 20003 (onpremise_proxy_http_port): HTTP forward proxy (no CONNECT) → 405.
  //   - Port 20004 (SOCKS5): for TCP-protocol CC backends. Previously rejected RFC-type
  //     backends with 0x02; with CC backend set to Protocol=TCP this should succeed.
  const socks5Port = parseInt(conn.onpremise_socks5_proxy_port ?? '20004', 10);
  const proxyPort = socks5Port;
  const tunnelMode: TunnelMode = 'socks5';
  logger.info({
    socks5Port: conn.onpremise_socks5_proxy_port ?? '(absent)',
    rfcPort: conn.onpremise_proxy_rfc_port ?? '(absent)',
    httpPort: conn.onpremise_proxy_http_port ?? '(absent)',
    proxyPort, tunnelMode,
    proxyHost: conn.onpremise_proxy_host,
  }, 'RFC: tunnel mode and port selection');

  const ashost    = destData['jco.client.ashost']  as string | undefined;
  const sysnr     = destData['jco.client.sysnr']   as string | undefined;
  const client    = destData['jco.client.client']  as string | undefined;
  const lang      = (destData['jco.client.lang']   as string | undefined) ?? 'EN';
  // Some JCo destinations carry a CC location ID to route to a specific Cloud Connector instance.
  const destLocationId = (destData['jco.destination.cloud_connector_location_id']
    ?? destData['jco.destination.cc_location_id']
    ?? destData['CloudConnectorLocationId']
    ?? conn.location_id
    ?? '') as string;
  // Log all destination property keys so we can discover any unknown location-ID or CC fields.
  logger.info({ destKeys: Object.keys(destData) }, 'RFC: destination property keys');

  if (!ashost || !sysnr || !client) {
    return {
      ok: false,
      error: 'Incomplete RFC destination configuration',
      detail: `Missing required jco.client properties: ${[!ashost && 'ashost', !sysnr && 'sysnr', !client && 'client'].filter(Boolean).join(', ')}`,
      source: 'config',
    };
  }

  const importParamsMap: Record<string, string> = {};
  for (const { key, value } of req.importParams) {
    if (key) importParamsMap[key] = value;
  }

  logger.info({
    dest: { ashost, sysnr, client, authType },
    rfcName: req.rfcName,
    importParamKeys: Object.keys(importParamsMap),
    proxyHost: conn.onpremise_proxy_host,
    proxyPort, tunnelMode,
    locationId: destLocationId || '(empty)',
    isPP,
  }, 'RFC test request');

  const virtualPort = 3300 + parseInt(sysnr, 10);
  const virtualTarget = `${ashost}:${virtualPort}`;

  let result: RfcTestResult;
  const start = Date.now();

  // nwrfcsdk always resolves ASHOST via local DNS — the virtual CC hostname (e.g. dr5-basic)
  // is not in CF's DNS, so we use ASHOST=127.0.0.1 and the SCC shim tunnels the connection.
  const user   = isPP ? undefined : (destData['jco.client.user']   as string | undefined);
  const passwd = isPP ? undefined : (destData['jco.client.passwd'] as string | undefined);

  try {
    await withDirectTunnelShim(conn.onpremise_proxy_host, proxyPort, token, virtualTarget, async (localPort) => {
      const fakeSymnr = String(localPort - 3300).padStart(2, '0');
      logger.info({ shimPort: localPort, fakeSymnr, virtualTarget, tunnelMode }, 'RFC: shim listening, invoking addon');
      const connParams: Record<string, string> = {
        ASHOST: '127.0.0.1',
        SYSNR: fakeSymnr,
        CLIENT: client,
        LANG: lang,
      };

      if (!isPP) {
        if (user)   connParams['USER']   = user;
        if (passwd) connParams['PASSWD'] = passwd;
      } else {
        const sncPartner = destData['jco.client.snc_partnername'] as string | undefined;
        if (sncPartner) {
          connParams['SNC_MODE']        = '1';
          connParams['SNC_PARTNERNAME'] = sncPartner;
        }
      }

      const addonResult = await addonFn(connParams, req.rfcName, importParamsMap);
      const durationMs = Date.now() - start;

      if (!addonResult) {
        result = { ok: false, error: 'RFC addon returned null', detail: 'Unexpected null from native addon.', source: 'addon' };
        return;
      }
      if ('error' in addonResult) {
        result = { ok: false, error: 'RFC call failed', detail: addonResult.error, source: 'rfc' };
        return;
      }
      try {
        const output = JSON.parse(addonResult.json) as Record<string, unknown>;
        result = { ok: true, durationMs, output };
      } catch {
        result = { ok: false, error: 'Failed to parse RFC output', detail: addonResult.json.slice(0, 500), source: 'rfc' };
      }
    }, destLocationId, tunnelMode);
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    result = { ok: false, error: 'RFC connectivity error', detail: `${msg} (after ${durationMs}ms)`, source: 'connectivity' };
  }

  logger.debug({
    rfcName: req.rfcName,
    result: result!.ok ? { ok: true, durationMs: result!.durationMs } : { ok: false, error: result!.error, source: result!.source },
  }, 'RFC test result');

  return result!;
}

export async function testSaRfcDestination(
  region: string, subdomain: string, name: string,
  req: RfcTestRequest, user: UserInfo,
): Promise<RfcTestResult> {
  const destData = await exportDestination(region, subdomain, name);
  if (!destData) {
    return { ok: false, error: 'Destination not found', detail: `No destination "${name}" found in ${subdomain}.`, source: 'config' };
  }
  return runRfcTest(destData, req, user.sub);
}

export async function testInstanceRfcDestination(
  region: string, subdomain: string,
  spaceName: string, instanceGuid: string, name: string,
  req: RfcTestRequest, user: UserInfo,
): Promise<RfcTestResult> {
  const destData = await exportInstanceDestination(region, subdomain, spaceName, instanceGuid, name);
  if (!destData) {
    return { ok: false, error: 'Destination not found', detail: `No destination "${name}" found in instance ${instanceGuid}.`, source: 'config' };
  }
  return runRfcTest(destData, req, user.sub);
}
