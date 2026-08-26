import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getConfig } from './configService.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { touchLastUpdated } from './lastUpdatedService.js';

const AOD_DIR         = join(config.LOCAL_STORE_DIR, 'apps');
const AOD_CONFIG_PATH = join(AOD_DIR, 'aod-config.json');

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

export async function readAodConfig(): Promise<AodConfig> {
  const base = getConfigFileAod();
  try {
    const raw     = await readFile(AOD_CONFIG_PATH, 'utf-8');
    const local   = JSON.parse(raw) as AodConfig;
    return { ...base, ...local };
  } catch {
    return base;
  }
}

export async function writeAodConfig(data: AodConfig): Promise<void> {
  const { regionProxyEndpoint: _rpe, refreshAppsIntervalHrs: _ri, ...toSave } = data;
  await mkdir(AOD_DIR, { recursive: true });
  await writeFile(AOD_CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf-8');
  touchLastUpdated();
  notifyCallbacks();
  emit('config', { ts: Date.now() });
  logger.info('aod-config.json saved');
}
