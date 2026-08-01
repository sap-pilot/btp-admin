import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { appendConfigChangelog } from './configChangelogService.js';

const CONFIG_DIR = join(config.LOCAL_STORE_DIR, 'config');
const TABS_PATH  = join(CONFIG_DIR, 'tabs.json');

export interface TabGroup {
  groupId:    string;
  groupTitle: string;
}

export interface TabEntry {
  tab:    string;
  groups: TabGroup[];
}

export async function readTabs(): Promise<TabEntry[]> {
  try {
    const raw = await readFile(TABS_PATH, 'utf-8');
    return JSON.parse(raw) as TabEntry[];
  } catch { return []; }
}

async function writeTabs(data: TabEntry[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TABS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  notifyCallbacks();
  const ts = Date.now();
  emit('root',   { files: ['config/tabs.json'], ts });
  emit('config', { files: ['tabs.json'], ts });
  logger.info({ tabs: data.length }, 'tabs.json saved');
}

function diffTabs(before: TabEntry[], after: TabEntry[]): string {
  const beforeMap = new Map(before.map(t => [t.tab, t]));
  const afterMap  = new Map(after.map(t => [t.tab, t]));
  const lines: string[] = [];

  for (const [tab] of afterMap)  { if (!beforeMap.has(tab)) lines.push(`+ tab: "${tab}"`); }
  for (const [tab] of beforeMap) { if (!afterMap.has(tab))  lines.push(`- tab: "${tab}"`); }

  // Tab order among tabs present in both
  const commonBefore = before.map(t => t.tab).filter(t => afterMap.has(t));
  const commonAfter  = after.map(t => t.tab).filter(t => beforeMap.has(t));
  if (commonBefore.join('\0') !== commonAfter.join('\0'))
    lines.push(`~ tab order: ${commonBefore.map(t => `"${t}"`).join(', ')} → ${commonAfter.map(t => `"${t}"`).join(', ')}`);

  for (const [tab, aft] of afterMap) {
    const bef = beforeMap.get(tab);
    if (!bef) continue;
    const bGroups = new Map(bef.groups.map(g => [g.groupId, g]));
    const aGroups = new Map(aft.groups.map(g => [g.groupId, g]));
    const tabLines: string[] = [];
    for (const [id] of aGroups) { if (!bGroups.has(id)) tabLines.push(`    + group: ${id}`); }
    for (const [id] of bGroups) { if (!aGroups.has(id)) tabLines.push(`    - group: ${id}`); }
    for (const [id, ag] of aGroups) {
      const bg = bGroups.get(id);
      if (!bg) continue;
      if (bg.groupTitle !== ag.groupTitle)
        tabLines.push(`    ~ group: ${id}  title: ${JSON.stringify(bg.groupTitle)} → ${JSON.stringify(ag.groupTitle)}`);
    }
    // Group order among groups present in both
    const commonGrpsBefore = bef.groups.map(g => g.groupId).filter(id => aGroups.has(id));
    const commonGrpsAfter  = aft.groups.map(g => g.groupId).filter(id => bGroups.has(id));
    if (commonGrpsBefore.join('\0') !== commonGrpsAfter.join('\0'))
      tabLines.push(`    ~ group order: ${commonGrpsBefore.join(', ')} → ${commonGrpsAfter.join(', ')}`);
    if (tabLines.length) { lines.push(`~ tab: "${tab}"`); lines.push(...tabLines); }
  }

  return lines.join('\n');
}

export async function saveTabs(data: TabEntry[], user = 'system'): Promise<void> {
  const before = await readTabs();
  const diff   = diffTabs(before, data);
  await writeTabs(data);
  await appendConfigChangelog('Update', user, 'tabs.json', diff);
}
