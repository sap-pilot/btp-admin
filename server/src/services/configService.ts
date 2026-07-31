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
