import { getConfig } from './configService.js';
import { getCachedSettingsOverrides } from './settingsDataCache.js';
import { readSettings, writeSettings } from './settingsService.js';
import { logger } from '../logger.js';

export interface AodConfig {
  stopAppsUnusedAfterHrs?:  number;
  excludeApps?:             string[];
  regionProxyEndpoint?:     Record<string, string>;
  refreshAppsIntervalHrs?:  number;
}

function getConfigFileAod(): AodConfig {
  try {
    const raw = getConfig() as unknown as { aod?: AodConfig };
    return raw.aod ?? {};
  } catch { return {}; }
}

/**
 * Reads merged AOD configuration from three sources in priority order:
 *   1. config.json → aod        bundled base config (lowest priority)
 *   2. CONFIG_JSON → aod        env-var override of config.json (handled by getConfig())
 *   3. settings.json → aod      config page overrides — applied when non-empty (highest priority)
 */
export async function readAodConfig(): Promise<AodConfig> {
  const merged: AodConfig = { ...getConfigFileAod() };
  const settingsAod = getCachedSettingsOverrides().aod;
  if (settingsAod?.regionalEndpoints) merged.regionProxyEndpoint = settingsAod.regionalEndpoints;
  if (settingsAod?.excludeApps)       merged.excludeApps         = settingsAod.excludeApps;
  return merged;
}

/**
 * Persists AOD fields into settings.json → aod (the config-page-editable layer).
 * Fields controlled via variables (stopAppsUnusedAfterHrs, refreshAppsIntervalHrs)
 * are not written here — configure those via the Variables settings panel.
 */
export async function writeAodConfig(data: Partial<AodConfig>): Promise<void> {
  const current  = await readSettings();
  const existing = current.aod ?? {};
  if (data.excludeApps         !== undefined) existing.excludeApps       = data.excludeApps;
  if (data.regionProxyEndpoint !== undefined) existing.regionalEndpoints = data.regionProxyEndpoint;
  current.aod = existing;
  await writeSettings(current);
  logger.info('AOD config saved to settings.json');
}
