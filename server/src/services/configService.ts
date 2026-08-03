import { readFileSync } from 'node:fs';
import type { AppConfig, ServiceConfig, LandscapeConfig, SiteConfig, EndpointConfig } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

let appConfig: AppConfig | null = null;

function applyVars(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => vars[key.trim()] ?? `{{${key}}}`);
}

function substituteEndpoint(ep: EndpointConfig, vars: Record<string, string>): EndpointConfig {
  const s = (str: string) => applyVars(str, vars);
  let headers = ep.headers;
  if (headers && !Array.isArray(headers)) {
    headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, s(v)]));
  } else if (Array.isArray(headers)) {
    headers = headers.map(h => ({ name: h.name, value: s(h.value) }));
  }
  return {
    ...ep,
    url: s(ep.url),
    ...(ep.username !== undefined && { username: s(ep.username) }),
    ...(ep.password !== undefined && { password: s(ep.password) }),
    ...(ep.body != null && { body: s(ep.body) }),
    ...(headers !== undefined && { headers }),
  };
}

export function loadConfig(): AppConfig {
  let raw: AppConfig;
  if (process.env.CONFIG_JSON) {
    logger.info('Loading config from CONFIG_JSON environment variable');
    raw = JSON.parse(process.env.CONFIG_JSON) as AppConfig;
  } else {
    try {
      logger.info({ path: config.CONFIG_FILE }, 'Loading config from file');
      raw = JSON.parse(readFileSync(config.CONFIG_FILE, 'utf-8')) as AppConfig;
    } catch (err: unknown) {
      const isNotFound =
        typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        logger.warn(
          { path: config.CONFIG_FILE },
          'Config file not found — starting with no services. Set CONFIG_JSON env var or provide the config file and restart.',
        );
      } else {
        logger.warn({ err, path: config.CONFIG_FILE }, 'Failed to parse config — starting with no services');
      }
      appConfig = { services: [] };
      return appConfig;
    }
  }

  const vars = raw.variables ?? {};
  appConfig = {
    ...raw,
    services: raw.services.map(svc => ({
      ...svc,
      endpoints: svc.endpoints.map(ep => substituteEndpoint(ep, vars)),
    })),
  };
  return appConfig;
}

export function getConfig(): AppConfig {
  if (!appConfig) loadConfig();
  return appConfig!;
}

export function getService(name: string): ServiceConfig | undefined {
  return getConfig().services.find(s => s.name === name);
}

export function getAllServices(): ServiceConfig[] {
  return getConfig().services.filter(s => s.enabled !== false);
}

export function getLandscapes(): LandscapeConfig[] {
  return getConfig().landscapes ?? [];
}

export function getSites(): SiteConfig[] {
  return getConfig().sites ?? [];
}

/** Returns the sync key: SYNC_KEY env var takes precedence over config.variables['SYNC_KEY']. */
export function getSyncKey(): string | null {
  if (process.env.SYNC_KEY) return process.env.SYNC_KEY;
  return getConfig().variables?.['SYNC_KEY'] ?? null;
}

/**
 * Returns the set of restricted subaccount IDs whose destinations and AOD features are blocked.
 * RESTRICTED_SUBACCOUNT_IDS env var (comma-separated) takes precedence over config.variables entry.
 */
export function getRestrictedIds(): Set<string> {
  const raw = process.env.RESTRICTED_SUBACCOUNT_IDS ?? getConfig().variables?.['RESTRICTED_SUBACCOUNT_IDS'] ?? '';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Per-subaccount proactive refresh threshold in milliseconds.
 * DESTINATIONS_AUTO_SUBACCOUNT_REFRESH_MINS replaces DESTINATION_REFRESH_DELAY_SECONDS.
 * Fractional values supported (e.g. 0.5 = 30 s). Default: 10 minutes.
 * Set to 0 to disable proactive refresh entirely.
 */
export function getAutoSubaccountRefreshMs(): number {
  const mins = process.env.DESTINATIONS_AUTO_SUBACCOUNT_REFRESH_MINS ?? getConfig().variables?.['DESTINATIONS_AUTO_SUBACCOUNT_REFRESH_MINS'];
  if (mins !== undefined && mins !== '') {
    const n = parseFloat(mins);
    return (!isNaN(n) && n > 0) ? n * 60_000 : 0;
  }
  return 10 * 60_000; // default 10 minutes
}

const DEFAULT_INTERNAL_IP_WHITELIST = '192.168.0.0/16,10.0.0.0/8,172.16.0.0/12';

/**
 * Returns CIDRs for internal/private network ranges always allowed on sync endpoints.
 * SYNC_INTERNAL_IP_WHITELIST env var takes precedence over config.variables entry.
 * Defaults to RFC 1918 private ranges: 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12.
 * Set to empty string to disable.
 */
export function getSyncInternalIpWhitelist(): string[] {
  const raw = process.env.SYNC_INTERNAL_IP_WHITELIST ?? getConfig().variables?.['SYNC_INTERNAL_IP_WHITELIST'] ?? DEFAULT_INTERNAL_IP_WHITELIST;
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

/** Returns true when SYNC_NO_IP_PROTECTION is set to "true" or "1". */
export function getSyncNoIpProtection(): boolean {
  const raw = process.env.SYNC_NO_IP_PROTECTION ?? getConfig().variables?.['SYNC_NO_IP_PROTECTION'];
  return raw === 'true' || raw === '1';
}

/**
 * Returns extra IPs/CIDRs to whitelist for sync requests in addition to BTP egress IPs.
 * SYNC_WHITELIST_IPS env var (comma-separated) takes precedence over config.variables entry.
 */
export function getSyncWhitelistIPs(): string[] {
  const raw = process.env.SYNC_WHITELIST_IPS ?? getConfig().variables?.['SYNC_WHITELIST_IPS'] ?? '';
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Global (all-subaccounts) auto-refresh threshold in milliseconds.
 * DESTINATION_AUTO_GLOBAL_REFRESH_HRS supports fractional values (e.g. 1.5 = 90 min).
 * Default: 6 hours. Set to 0 to disable auto-refresh on page open.
 */
export function getAutoGlobalRefreshMs(): number {
  const raw = process.env.DESTINATION_AUTO_GLOBAL_REFRESH_HRS ?? getConfig().variables?.['DESTINATION_AUTO_GLOBAL_REFRESH_HRS'];
  if (raw !== undefined && raw !== '') {
    const n = parseFloat(raw);
    return (!isNaN(n) && n > 0) ? n * 3_600_000 : 0;
  }
  return 6 * 3_600_000; // default 6 hours
}
