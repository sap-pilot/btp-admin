import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { readEffectiveHomepageRaw } from './home/homepageEditService.js';

const CONFIG_DIR = join(config.LOCAL_STORE_DIR, 'config');
const DIRS_PATH  = join(CONFIG_DIR, 'dirs.json');

export interface DirEntry {
  alias: string;
  title: string;
  pos:   number;
}

export interface DirTab {
  tab:  string;
  dirs: DirEntry[];
}

export async function readDirs(): Promise<DirTab[]> {
  try {
    const raw = await readFile(DIRS_PATH, 'utf-8');
    return JSON.parse(raw) as DirTab[];
  } catch { return []; }
}

async function writeDirs(data: DirTab[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(DIRS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  notifyCallbacks();
  const ts = Date.now();
  emit('root', { files: ['config/dirs.json'], ts });
  emit('config', { files: ['dirs.json'], ts });
  logger.info({ tabs: data.length, total: data.reduce((n, t) => n + t.dirs.length, 0) }, 'dirs.json saved');
}

export async function saveDirs(data: DirTab[]): Promise<void> {
  await writeDirs(data);
}

/** Sort each tab's dirs by pos ascending, reassign pos = index+1 (1-based unique). */
function normalizeDirPositions(data: DirTab[]): DirTab[] {
  return data.map(tab => ({
    ...tab,
    dirs: [...tab.dirs]
      .sort((a, b) => a.pos - b.pos)
      .map((d, idx) => ({ ...d, pos: idx + 1 })),
  }));
}

/** Prefill dirs.json from homepage.json tabs/directories — only runs when dirs.json is empty. */
export async function prefillDirsIfEmpty(): Promise<void> {
  const current = await readDirs();
  if (current.length > 0) return;

  const raw = readEffectiveHomepageRaw();
  if (!raw) return;

  try {
    const hp = JSON.parse(raw) as {
      tabs?: Array<{ title: string; dirs?: string[] }>;
      btp?: { globalAccounts?: Array<{
        directories?: Array<{ name?: string; short?: string }>;
      }>; };
    };

    // Build lookup: dir.short → { title, pos }
    const dirLookup = new Map<string, { title: string; pos: number }>();
    let pos = 0;
    for (const ga of hp.btp?.globalAccounts ?? []) {
      for (const dir of ga.directories ?? []) {
        if (dir.short) dirLookup.set(dir.short, { title: dir.name ?? dir.short, pos: pos++ });
      }
    }

    // Build DirTab[] from tabs[].dirs → dir lookup
    const prefilled: DirTab[] = [];
    for (const tab of hp.tabs ?? []) {
      if (!tab.title) continue;
      const dirs: DirEntry[] = [];
      for (const short of tab.dirs ?? []) {
        const meta = dirLookup.get(short);
        if (meta) dirs.push({ alias: short, title: meta.title, pos: meta.pos });
      }
      prefilled.push({ tab: tab.title, dirs });
    }

    if (prefilled.length > 0) {
      const normalized = normalizeDirPositions(prefilled);
      await writeDirs(normalized);
      logger.info({ tabs: normalized.length }, 'dirs.json prefilled from homepage.json');
    }
  } catch { /* homepage.json missing or invalid — skip prefill */ }
}
