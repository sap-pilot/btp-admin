import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { appendConfigChangelog } from './configChangelogService.js';
import { touchLastUpdated } from './lastUpdatedService.js';

const CONFIG_DIR = join(config.LOCAL_STORE_DIR, 'config');
const TABS_PATH  = join(CONFIG_DIR, 'tabs.json');

export type BannerColor = 'transparent' | 'blue' | 'green' | 'yellow' | 'red' | 'purple';

export type TabSection =
  | { type: 'subaccountGroup'; title?: string; groupId: string }
  | { type: 'banner';          message: string; backgroundColor: BannerColor }
  | { type: 'table';           title?: string;  tableContent: string[][] };

export interface TabEntry {
  tab:      string;
  sections: TabSection[];
}

function migrateLegacy(raw: unknown): TabEntry[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map((t): TabEntry => {
    const entry = t as Record<string, unknown>;
    if (Array.isArray(entry['sections'])) return entry as unknown as TabEntry;
    const groups = Array.isArray(entry['groups']) ? (entry['groups'] as Record<string, unknown>[]) : [];
    return {
      tab: typeof entry['tab'] === 'string' ? entry['tab'] : '',
      sections: groups.map(g => ({
        type:    'subaccountGroup' as const,
        title:   typeof g['groupTitle'] === 'string' && g['groupTitle'] ? g['groupTitle'] : undefined,
        groupId: typeof g['groupId']    === 'string' ? g['groupId'] : '',
      })),
    };
  });
}

export async function readTabs(): Promise<TabEntry[]> {
  try {
    const raw = await readFile(TABS_PATH, 'utf-8');
    return migrateLegacy(JSON.parse(raw));
  } catch { return []; }
}

async function writeTabs(data: TabEntry[]): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TABS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  touchLastUpdated();
  notifyCallbacks();
  const ts = Date.now();
  emit('root',   { files: ['config/tabs.json'], ts });
  emit('config', { files: ['tabs.json'], ts });
  logger.info({ tabs: data.length }, 'tabs.json saved');
}

type SaGroup = Extract<TabSection, { type: 'subaccountGroup' }>;
type Banner  = Extract<TabSection, { type: 'banner' }>;
type Table   = Extract<TabSection, { type: 'table' }>;

function diffTabs(before: TabEntry[], after: TabEntry[]): string {
  const beforeMap = new Map(before.map(t => [t.tab, t]));
  const afterMap  = new Map(after.map(t => [t.tab, t]));
  const lines: string[] = [];

  for (const [tab] of afterMap)  { if (!beforeMap.has(tab)) lines.push(`+ tab: "${tab}"`); }
  for (const [tab] of beforeMap) { if (!afterMap.has(tab))  lines.push(`- tab: "${tab}"`); }

  const commonBefore = before.map(t => t.tab).filter(t => afterMap.has(t));
  const commonAfter  = after.map(t => t.tab).filter(t => beforeMap.has(t));
  if (commonBefore.join('\0') !== commonAfter.join('\0'))
    lines.push(`~ tab order: ${commonBefore.map(t => `"${t}"`).join(', ')} → ${commonAfter.map(t => `"${t}"`).join(', ')}`);

  for (const [tab, aft] of afterMap) {
    const bef = beforeMap.get(tab);
    if (!bef) continue;
    const tabLines: string[] = [];

    // subaccountGroup sections — keyed by groupId
    const befSaGroups = bef.sections.filter((s): s is SaGroup => s.type === 'subaccountGroup');
    const aftSaGroups = aft.sections.filter((s): s is SaGroup => s.type === 'subaccountGroup');
    const bGrpMap = new Map(befSaGroups.map(g => [g.groupId, g]));
    const aGrpMap = new Map(aftSaGroups.map(g => [g.groupId, g]));
    for (const [id] of aGrpMap) { if (!bGrpMap.has(id)) tabLines.push(`    + subaccountGroup: ${id}`); }
    for (const [id] of bGrpMap) { if (!aGrpMap.has(id)) tabLines.push(`    - subaccountGroup: ${id}`); }
    for (const [id, ag] of aGrpMap) {
      const bg = bGrpMap.get(id);
      if (!bg || (bg.title ?? '') === (ag.title ?? '')) continue;
      tabLines.push(`    ~ subaccountGroup: ${id}  title: ${JSON.stringify(bg.title ?? '')} → ${JSON.stringify(ag.title ?? '')}`);
    }
    const cGrpB = befSaGroups.map(g => g.groupId).filter(id => aGrpMap.has(id));
    const cGrpA = aftSaGroups.map(g => g.groupId).filter(id => bGrpMap.has(id));
    if (cGrpB.join('\0') !== cGrpA.join('\0'))
      tabLines.push(`    ~ subaccountGroup order: ${cGrpB.join(', ')} → ${cGrpA.join(', ')}`);

    // banner/table sections — compared by index
    const befOther = bef.sections.filter(s => s.type !== 'subaccountGroup');
    const aftOther = aft.sections.filter(s => s.type !== 'subaccountGroup');
    const maxLen = Math.max(befOther.length, aftOther.length);
    for (let i = 0; i < maxLen; i++) {
      const bs = befOther[i];
      const as_ = aftOther[i];
      if (!bs && as_) { tabLines.push(`    + ${as_.type} section`); continue; }
      if (bs && !as_) { tabLines.push(`    - ${bs.type} section`); continue; }
      if (!bs || !as_) continue;
      if (bs.type !== as_.type) { tabLines.push(`    ~ section[${i}]: ${bs.type} → ${as_.type}`); continue; }
      if (bs.type === 'banner' && as_.type === 'banner') {
        const b = bs as Banner; const a = as_ as Banner;
        if (b.message !== a.message)
          tabLines.push(`    ~ banner[${i}] message: ${JSON.stringify(b.message)} → ${JSON.stringify(a.message)}`);
        if (b.backgroundColor !== a.backgroundColor)
          tabLines.push(`    ~ banner[${i}] color: ${b.backgroundColor} → ${a.backgroundColor}`);
      }
      if (bs.type === 'table' && as_.type === 'table') {
        const b = bs as Table; const a = as_ as Table;
        if ((b.title ?? '') !== (a.title ?? ''))
          tabLines.push(`    ~ table[${i}] title: ${JSON.stringify(b.title ?? '')} → ${JSON.stringify(a.title ?? '')}`);
        const bRows = b.tableContent;
        const aRows = a.tableContent;
        const maxR  = Math.max(bRows.length, aRows.length);
        for (let r = 0; r < maxR; r++) {
          const bRow = bRows[r];
          const aRow = aRows[r];
          if (!bRow && aRow) {
            tabLines.push(`    + table[${i}] row[${r}]: [${aRow.map(c => JSON.stringify(c)).join(', ')}]`);
          } else if (bRow && !aRow) {
            tabLines.push(`    - table[${i}] row[${r}]: [${bRow.map(c => JSON.stringify(c)).join(', ')}]`);
          } else if (bRow && aRow) {
            const maxC = Math.max(bRow.length, aRow.length);
            for (let c = 0; c < maxC; c++) {
              const bVal = bRow[c] ?? '';
              const aVal = aRow[c] ?? '';
              if (bVal !== aVal)
                tabLines.push(`    ~ table[${i}][${r},${c}]: ${JSON.stringify(bVal)} → ${JSON.stringify(aVal)}`);
            }
          }
        }
      }
    }

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

export async function tabsFileExists(): Promise<boolean> {
  try { await access(TABS_PATH); return true; } catch { return false; }
}

export async function importTabs(data: unknown, user: string): Promise<void> {
  const incoming = migrateLegacy(data);
  const before   = await readTabs();
  const diff     = diffTabs(before, incoming);
  await writeTabs(incoming);
  await appendConfigChangelog('Import', user, 'tabs.json', diff);
}
