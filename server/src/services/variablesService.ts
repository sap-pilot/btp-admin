import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

const SETTINGS_PATH = join(config.LOCAL_STORE_DIR, 'conf', 'settings.json');

export interface VariableDef {
  key: string;
  description: string;
  sensitive: boolean;
  readonly: boolean;
}

export const VARIABLE_DEFS: VariableDef[] = [
  { key: 'CF_USERNAME',                  description: 'CF service account username for CF API calls',                   sensitive: false, readonly: false },
  { key: 'CF_PASSWORD',                  description: 'CF service account password',                                    sensitive: true,  readonly: false },
  { key: 'CF_REGIONS',                   description: 'Comma-separated CF API regions (e.g. us10,us20)',                sensitive: false, readonly: false },
  { key: 'MONITOR_USERNAME',             description: 'Username substituted into {{MONITOR_USERNAME}} probe templates', sensitive: false, readonly: false },
  { key: 'MONITOR_PASSWORD',             description: 'Password substituted into {{MONITOR_PASSWORD}} probe templates', sensitive: true,  readonly: false },
  { key: 'SYNC_KEY',                     description: 'Auth key for remote config sync',                               sensitive: true,  readonly: false },
  { key: 'SYNC_EXCLUDES',               description: 'Comma-separated folders excluded from remote sync (e.g. rcs,users)', sensitive: false, readonly: false },
  { key: 'AUTO_SUBACCOUNT_REFRESH_MINS', description: 'Proactive destination refresh interval per subaccount (minutes)', sensitive: false, readonly: false },
  { key: 'AUTO_GLOBAL_REFRESH_HRS',      description: 'Global (all-subaccounts) destination auto-refresh interval (hours)', sensitive: false, readonly: false },
  { key: 'MAX_RESPONSE_STORAGE_DAYS',    description: 'Days to retain probe response history files',                   sensitive: false, readonly: false },
  { key: 'REFRESH_APPS_INTERVAL_HRS',    description: 'CF app scan interval in hours; saving restarts the scheduler', sensitive: false, readonly: false },
  { key: 'STOP_APPS_UNUSED_AFTER_HRS',   description: 'Stop AOD-managed apps idle for this many hours (0 = disabled)', sensitive: false, readonly: false },
  { key: 'RESTRICTED_SUBACCOUNT_IDS',    description: 'Comma-separated subaccount IDs whose destinations and AOD are restricted', sensitive: false, readonly: true  },
];

const SENSITIVE_KEYS = new Set(VARIABLE_DEFS.filter(d => d.sensitive).map(d => d.key));

// In-memory cache of settings.json->variables. Populated by warmSettingsVarsCache() at startup
// and updated by updateSettingsVarsCache() after each settings save. Always sync-readable.
let settingsVarsCache: Record<string, string> = {};

export async function warmSettingsVarsCache(): Promise<void> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { variables?: unknown };
    const vars = parsed.variables;
    if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
      settingsVarsCache = Object.fromEntries(
        Object.entries(vars as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' && v !== '')
          .map(([k, v]) => [k, v as string]),
      );
    } else {
      settingsVarsCache = {};
    }
  } catch {
    settingsVarsCache = {};
  }
}

export function updateSettingsVarsCache(vars: Record<string, string>): void {
  settingsVarsCache = Object.fromEntries(
    Object.entries(vars).filter(([, v]) => typeof v === 'string' && v !== ''),
  );
}

export function maskIfSensitive(key: string, value: string | undefined): string {
  if (!value) return '';
  return SENSITIVE_KEYS.has(key) ? '****' : value;
}

// Parse variables from the CONFIG_JSON env blob (separate from individual env vars)
function getEnvBlobVars(): Record<string, string> {
  try {
    const raw = process.env.CONFIG_JSON;
    if (!raw) return {};
    return ((JSON.parse(raw) as { variables?: Record<string, string> }).variables) ?? {};
  } catch { return {}; }
}

// One-time lazy parse of config.json->variables (or CONFIG_JSON blob, whichever is active)
let configFileVarsCache: Record<string, string> | null = null;

function getConfigFileVars(): Record<string, string> {
  if (configFileVarsCache !== null) return configFileVarsCache;
  try {
    if (process.env.CONFIG_JSON) {
      // CONFIG_JSON blob is the entire config — its variables are already read by getEnvBlobVars()
      configFileVarsCache = {};
    } else {
      const raw = readFileSync(config.CONFIG_FILE, 'utf-8');
      configFileVarsCache = ((JSON.parse(raw) as { variables?: Record<string, string> }).variables) ?? {};
    }
  } catch {
    configFileVarsCache = {};
  }
  return configFileVarsCache;
}

/**
 * Full override chain (highest to lowest priority):
 *   settings.json->variables → process.env[key] → CONFIG_JSON->variables → config.json->variables
 */
export function getVar(key: string): string | undefined {
  const fromSettings = settingsVarsCache[key];
  if (fromSettings) return fromSettings;

  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const fromBlob = getEnvBlobVars()[key];
  if (fromBlob) return fromBlob;

  const fromFile = getConfigFileVars()[key];
  if (fromFile) return fromFile;

  return undefined;
}

/**
 * Effective default — same chain but skips settings.json (for "Default Value" column).
 * Returns env/config.json value with provenance for the UI badge.
 */
export function getEffectiveDefault(key: string): { value: string | undefined; isEnv: boolean } {
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, isEnv: true };

  const fromBlob = getEnvBlobVars()[key];
  if (fromBlob) return { value: fromBlob, isEnv: true };

  const fromFile = getConfigFileVars()[key];
  return { value: fromFile, isEnv: false };
}

/** Returns the current settings.json override value for a key, or undefined if not set. */
export function getSettingsVar(key: string): string | undefined {
  return settingsVarsCache[key];
}
