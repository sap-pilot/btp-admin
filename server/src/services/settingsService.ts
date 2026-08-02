import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { notifyCallbacks } from './syncService.js';
import { emit } from './liveEvents.js';
import { appendConfigChangelog } from './configChangelogService.js';
import { touchLastUpdated } from './lastUpdatedService.js';

const CONFIG_DIR     = join(config.LOCAL_STORE_DIR, 'conf');
const SETTINGS_PATH  = join(CONFIG_DIR, 'settings.json');
const DEFAULT_PATH   = './config/default-settings.json';

export interface MainSubscription { name: string; alias?: string; }
export interface Submenu  { text: string; url: string; public?: boolean; }
export interface MenuEntry { text: string; icon: string; submenus: Submenu[]; }
export interface SettingsData {
  homepage: {
    cockpit: { idp: string; host: string; };
    mainSubscriptions: MainSubscription[];
  };
  menus: MenuEntry[];
}

function parseSettings(raw: string): SettingsData {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const hp = (parsed['homepage'] ?? {}) as Record<string, unknown>;
  const cockpit = (hp['cockpit'] ?? {}) as Record<string, unknown>;
  return {
    homepage: {
      cockpit: {
        idp:  typeof cockpit['idp']  === 'string' ? cockpit['idp']  : 'sap.default',
        host: typeof cockpit['host'] === 'string' ? cockpit['host'] : '',
      },
      mainSubscriptions: Array.isArray(hp['mainSubscriptions'])
        ? (hp['mainSubscriptions'] as unknown[]).map(s => {
            const sub = s as Record<string, unknown>;
            return { name: String(sub['name'] ?? ''), alias: sub['alias'] ? String(sub['alias']) : undefined };
          })
        : [],
    },
    menus: Array.isArray(parsed['menus'])
      ? (parsed['menus'] as unknown[]).map(m => {
          const menu = m as Record<string, unknown>;
          const submenus = Array.isArray(menu['submenus'])
            ? (menu['submenus'] as unknown[]).map(s => {
                const sub = s as Record<string, unknown>;
                return {
                  text:   String(sub['text'] ?? ''),
                  url:    String(sub['url'] ?? ''),
                  public: sub['public'] === true,
                };
              })
            : [];
          return { text: String(menu['text'] ?? ''), icon: String(menu['icon'] ?? ''), submenus };
        })
      : [],
  };
}

function readDefault(): SettingsData {
  const raw = readFileSync(DEFAULT_PATH, 'utf-8');
  return parseSettings(raw);
}

export async function readSettings(): Promise<SettingsData> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    return parseSettings(raw);
  } catch {
    return readDefault();
  }
}

export async function writeSettings(data: SettingsData): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  touchLastUpdated();
  notifyCallbacks();
  emit('config', { ts: Date.now() });
}

export async function settingsFileExists(): Promise<boolean> {
  try { await access(SETTINGS_PATH); return true; } catch { return false; }
}

function diffSettings(before: SettingsData, after: SettingsData): string {
  const lines: string[] = [];

  // ── Cockpit ───────────────────────────────────────────────────────────────
  const bc = before.homepage.cockpit;
  const ac = after.homepage.cockpit;
  if (bc.idp  !== ac.idp)  lines.push(`~ homepage.cockpit.idp:  ${JSON.stringify(bc.idp)} → ${JSON.stringify(ac.idp)}`);
  if (bc.host !== ac.host) lines.push(`~ homepage.cockpit.host: ${JSON.stringify(bc.host)} → ${JSON.stringify(ac.host)}`);

  // ── mainSubscriptions ─────────────────────────────────────────────────────
  const bSubs   = before.homepage.mainSubscriptions;
  const aSubs   = after.homepage.mainSubscriptions;
  const bSubMap = new Map(bSubs.map(s => [s.name, s]));
  const aSubMap = new Map(aSubs.map(s => [s.name, s]));

  for (const [n] of aSubMap) { if (!bSubMap.has(n)) lines.push(`+ mainSubscription: "${n}"`); }
  for (const [n] of bSubMap) { if (!aSubMap.has(n)) lines.push(`- mainSubscription: "${n}"`); }

  const bSubOrder = bSubs.map(s => s.name).filter(n => aSubMap.has(n));
  const aSubOrder = aSubs.map(s => s.name).filter(n => bSubMap.has(n));
  if (bSubOrder.join('\0') !== aSubOrder.join('\0'))
    lines.push(`~ mainSubscriptions order: [${bSubOrder.map(n => `"${n}"`).join(', ')}] → [${aSubOrder.map(n => `"${n}"`).join(', ')}]`);

  for (const [n, as_] of aSubMap) {
    const bs = bSubMap.get(n);
    if (!bs) continue;
    if ((bs.alias ?? '') !== (as_.alias ?? ''))
      lines.push(`~ mainSubscription "${n}" alias: ${JSON.stringify(bs.alias ?? '')} → ${JSON.stringify(as_.alias ?? '')}`);
  }

  // ── Menus ─────────────────────────────────────────────────────────────────
  const bMenuMap = new Map(before.menus.map(m => [m.text, m]));
  const aMenuMap = new Map(after.menus.map(m => [m.text, m]));

  for (const [t] of aMenuMap) { if (!bMenuMap.has(t)) lines.push(`+ menu: "${t}"`); }
  for (const [t] of bMenuMap) { if (!aMenuMap.has(t)) lines.push(`- menu: "${t}"`); }

  const bMenuOrder = before.menus.map(m => m.text).filter(t => aMenuMap.has(t));
  const aMenuOrder = after.menus.map(m => m.text).filter(t => bMenuMap.has(t));
  if (bMenuOrder.join('\0') !== aMenuOrder.join('\0'))
    lines.push(`~ menus order: [${bMenuOrder.map(t => `"${t}"`).join(', ')}] → [${aMenuOrder.map(t => `"${t}"`).join(', ')}]`);

  for (const [text, am] of aMenuMap) {
    const bm = bMenuMap.get(text);
    if (!bm) continue;
    const menuLines: string[] = [];

    if (bm.icon !== am.icon)
      menuLines.push(`    ~ icon: ${JSON.stringify(bm.icon)} → ${JSON.stringify(am.icon)}`);

    const bSmMap = new Map(bm.submenus.map(s => [s.text, s]));
    const aSmMap = new Map(am.submenus.map(s => [s.text, s]));

    for (const [st] of aSmMap) { if (!bSmMap.has(st)) menuLines.push(`    + submenu: "${st}"`); }
    for (const [st] of bSmMap) { if (!aSmMap.has(st)) menuLines.push(`    - submenu: "${st}"`); }

    const bSmOrder = bm.submenus.map(s => s.text).filter(t => aSmMap.has(t));
    const aSmOrder = am.submenus.map(s => s.text).filter(t => bSmMap.has(t));
    if (bSmOrder.join('\0') !== aSmOrder.join('\0'))
      menuLines.push(`    ~ submenu order: [${bSmOrder.map(t => `"${t}"`).join(', ')}] → [${aSmOrder.map(t => `"${t}"`).join(', ')}]`);

    for (const [st, as_] of aSmMap) {
      const bs = bSmMap.get(st);
      if (!bs) continue;
      if (bs.url !== as_.url)
        menuLines.push(`    ~ submenu "${st}" url: ${JSON.stringify(bs.url)} → ${JSON.stringify(as_.url)}`);
      if ((bs.public ?? false) !== (as_.public ?? false))
        menuLines.push(`    ~ submenu "${st}" public: ${bs.public ?? false} → ${as_.public ?? false}`);
    }

    if (menuLines.length) { lines.push(`~ menu: "${text}"`); lines.push(...menuLines); }
  }

  return lines.join('\n');
}

export async function saveSettings(data: SettingsData, user: string): Promise<void> {
  const before = await readSettings();
  const diff   = diffSettings(before, data);
  await writeSettings(data);
  await appendConfigChangelog('Update', user, 'settings.json', diff);
}

export async function importSettings(data: unknown, user: string): Promise<void> {
  const incoming = parseSettings(JSON.stringify(data));
  const before   = await readSettings();
  const diff     = diffSettings(before, incoming);
  await writeSettings(incoming);
  await appendConfigChangelog('Import', user, 'settings.json', diff);
}
