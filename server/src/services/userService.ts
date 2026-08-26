import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { fetchWithRateLimit } from './cfLoginService.js';
import { getAutoGlobalRefreshMs, getAutoSubaccountRefreshMs } from './configService.js';
import { readSubaccounts } from './subaccountsService.js';
import { isRcSubaccountRestricted } from './rcService.js';
import {
  loadXsuaaKeyStore, saveXsuaaKeyStore,
  loadXsuaaTokenStore, saveXsuaaTokenStore,
  resolveXsuaaToken, withXsuaaApiRetry,
  type XsuaaKeyStore, type XsuaaTokenStore, type XsuaaCredentials,
} from './rcService.js';
import { notifyCallbacks, registerOnUsersChangelogSynced, registerOnUsersSynced } from './syncService.js';
import { emit, emitImmediate } from './liveEvents.js';

const LOCAL_USERS_DIR       = join(config.LOCAL_STORE_DIR, 'users');
const GLOBAL_CHANGELOG_PATH = join(LOCAL_USERS_DIR, 'changelog.md');
const MAX_CHANGELOG_SIZE    = 2 * 1024 * 1024; // 2 MB

let globalUsersRefreshTs:      number | null = null;
let globalUsersRefreshRunning  = false;
const lastUsersRefreshTs       = new Map<string, number>(); // per-SA last refresh wall-clock time

const usersOverviewCache = new Map<string, { users: UserSummary[]; total: number }>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface XsuaaUserName {
  familyName?: string;
  givenName?:  string;
}

export interface XsuaaUserEmail {
  value:   string;
  primary: boolean;
}

export interface XsuaaUserGroup {
  value:   string;
  display: string;
  type:    string;
}

export interface XsuaaMeta {
  version?:      number;
  created?:      string;
  lastModified?: string;
}

export interface XsuaaUser {
  id:                    string;
  externalId?:           string;
  meta?:                 XsuaaMeta;
  userName:              string;
  name?:                 XsuaaUserName;
  emails?:               XsuaaUserEmail[];
  groups?:               XsuaaUserGroup[];
  approvals?:            unknown[];
  active?:               boolean;
  verified?:             boolean;
  origin:                string;
  zoneId?:               string;
  passwordLastModified?: string;
  previousLogonTime?:    number;
  lastLogonTime?:        number;
  schemas?:              string[];
}

export interface UserSummary {
  id:            string;
  userName:      string;
  email:         string;
  origin:        string;
  lastLogonTime?: number;
  active?:        boolean;
}

export interface GlobalAccessEntry {
  region:    string;
  subdomain: string;
  alias:     string;
  groups:    XsuaaUserGroup[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function userEmail(u: XsuaaUser): string {
  return u.emails?.[0]?.value || u.id;
}

function utcTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function rotationTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(-2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function normalizeGroups(groups: XsuaaUserGroup[]): XsuaaUserGroup[] {
  return [...groups].sort((a, b) => a.value.localeCompare(b.value));
}

// Deep-diff two user records, ignoring frequently-changing fields.
// 'meta' (version/created/lastModified) is excluded — XSUAA bumps it on every read,
// so meta-only changes would produce changelog noise with no meaningful content change.
const IGNORED_DIFF_KEYS = new Set(['passwordLastModified', 'previousLogonTime', 'lastLogonTime', 'meta']);

function diffUser(prev: XsuaaUser, next: XsuaaUser): string {
  const lines: string[] = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of allKeys) {
    if (IGNORED_DIFF_KEYS.has(k)) continue;
    const pk = prev[k as keyof XsuaaUser];
    const nk = next[k as keyof XsuaaUser];
    if (k === 'groups') {
      const pg = normalizeGroups((pk as XsuaaUserGroup[] | undefined) ?? []);
      const ng = normalizeGroups((nk as XsuaaUserGroup[] | undefined) ?? []);
      const prevVals = new Map(pg.map(g => [g.value, g]));
      const nextVals = new Map(ng.map(g => [g.value, g]));
      const groupLines: string[] = [];
      for (const [v, g] of nextVals) { if (!prevVals.has(v)) groupLines.push(`  + ${g.display || v} (${g.type})`); }
      for (const [v, g] of prevVals) { if (!nextVals.has(v)) groupLines.push(`  - ${g.display || v} (${g.type})`); }
      if (groupLines.length > 0) lines.push('- groups:\n' + groupLines.join('\n'));
      continue;
    }
    const pv = JSON.stringify(pk ?? null);
    const nv = JSON.stringify(nk ?? null);
    if (pv !== nv) lines.push(`- ${k}: ${pv} → ${nv}`);
  }
  return lines.join('\n');
}

// ─── Directory scanner (handles both old UUID format and new origin/email format) ──

async function readAllUsersFromDir(userDir: string): Promise<XsuaaUser[]> {
  const entries = await readdir(userDir, { withFileTypes: true });
  const seen    = new Set<string>();
  const users: XsuaaUser[] = [];

  const tryAdd = (u: XsuaaUser) => {
    const k = `${u.origin}|${userEmail(u)}`;
    if (!seen.has(k)) { seen.add(k); users.push(u); }
  };

  // New format: origin subdirectories
  for (const d of entries.filter(e => e.isDirectory())) {
    const originDir = join(userDir, d.name);
    const files = (await readdir(originDir)).filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'));
    for (const f of files) {
      try { tryAdd(JSON.parse(await readFile(join(originDir, f), 'utf-8')) as XsuaaUser); } catch { /* skip */ }
    }
  }

  // Old format: UUID.json files directly in userDir (backward compat)
  for (const e of entries.filter(e => !e.isDirectory() && /^[a-f0-9-]{36}\.json$/.test(e.name))) {
    try { tryAdd(JSON.parse(await readFile(join(userDir, e.name), 'utf-8')) as XsuaaUser); } catch { /* skip */ }
  }

  return users;
}

async function refreshUsersOverviewCacheForSa(region: string, subdomain: string): Promise<void> {
  const key     = `${region}/${subdomain}`;
  const userDir = join(LOCAL_USERS_DIR, region, subdomain);
  try {
    const users = await readAllUsersFromDir(userDir);
    const summaries: UserSummary[] = users.map(u => ({
      id: u.id, userName: u.userName, email: userEmail(u),
      origin: u.origin, lastLogonTime: u.lastLogonTime, active: u.active,
    }));
    summaries.sort((a, b) => (b.lastLogonTime ?? 0) - (a.lastLogonTime ?? 0));
    usersOverviewCache.set(key, { users: summaries.slice(0, 16), total: summaries.length });
  } catch {
    usersOverviewCache.delete(key);
  }
}

// Deduplicate by origin+email; when two records share the same key, the one
// with the later meta.lastModified wins. This handles XSUAA zones that contain
// duplicate accounts (same identity, different internal id).
function deduplicateUsers(users: XsuaaUser[]): { users: XsuaaUser[]; removed: XsuaaUser[] } {
  const map     = new Map<string, XsuaaUser>();
  const removed: XsuaaUser[] = [];
  for (const u of users) {
    const key      = `${u.origin}|${userEmail(u)}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, u);
    } else {
      const existingTs = existing.meta?.lastModified ? Date.parse(existing.meta.lastModified) : 0;
      const newTs      = u.meta?.lastModified        ? Date.parse(u.meta.lastModified)        : 0;
      if (newTs > existingTs) { removed.push(existing); map.set(key, u); }
      else                    { removed.push(u); }
    }
  }
  return { users: [...map.values()], removed };
}

// ─── XSUAA Users API ──────────────────────────────────────────────────────────

async function fetchUsersFromApi(apiUrl: string, token: string): Promise<XsuaaUser[]> {
  const all: XsuaaUser[] = [];
  let startIndex = 1;
  const count = 500;

  while (true) {
    const url = `${apiUrl}/Users?count=${count}&startIndex=${startIndex}`;
    const res = await fetchWithRateLimit(() => fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }), url);
    logger.debug({ url, status: res.status }, 'XSUAA users API call');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`XSUAA users → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as {
      startIndex?: number;
      itemsPerPage?: number;
      totalResults?: number;
      resources?: unknown[];
      Resources?: unknown[];
    };
    const resources = (data.resources ?? data.Resources ?? []) as XsuaaUser[];
    all.push(...resources);

    const total       = data.totalResults ?? 0;
    const perPage     = data.itemsPerPage ?? resources.length;
    const nextStart   = startIndex + perPage;
    if (resources.length === 0 || nextStart > total) break;
    startIndex = nextStart;
  }

  return all;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

type PersistResult = 'created' | 'updated' | 'unchanged';

async function persistUser(
  userDir:  string,
  user:     XsuaaUser,
  username: string,
  mode:     'auto' | 'manual',
): Promise<PersistResult> {
  const email         = userEmail(user);
  const originDir     = join(userDir, user.origin);
  await mkdir(originDir, { recursive: true });
  const userPath      = join(originDir, `${email}.json`);
  const changelogPath = join(originDir, `${email}.changelog.md`);

  const exists = existsSync(userPath);
  let diff = '';

  if (exists) {
    const prev = JSON.parse(await readFile(userPath, 'utf-8')) as XsuaaUser;
    diff = diffUser(prev, user); // meta excluded from diff
    // Always write JSON when anything changed (including meta-only) so the stored
    // baseline stays current and future diffs don't re-detect the same meta bump.
    if (JSON.stringify(prev) !== JSON.stringify(user)) {
      await writeFile(userPath, JSON.stringify(user, null, 2), 'utf-8');
    }
    if (!diff) return 'unchanged'; // meta-only or truly unchanged — no changelog
  } else {
    await writeFile(userPath, JSON.stringify(user, null, 2), 'utf-8');
  }

  const ts      = utcTimestamp();
  const label   = mode === 'auto' ? 'Auto' : 'Manual';
  const heading = `## [${label}] refresh by <${username}> at ${ts}`;
  const entry   = [heading, diff || '(new user)'].filter(Boolean).join('\n') + '\n\n';

  const prevChangelog = existsSync(changelogPath) ? await readFile(changelogPath, 'utf-8') : '';
  await writeFile(changelogPath, entry + prevChangelog, 'utf-8');

  return exists ? 'updated' : 'created';
}

// ─── Global changelog ─────────────────────────────────────────────────────────

async function rotateGlobalChangelogIfNeeded(): Promise<void> {
  try {
    const info = await stat(GLOBAL_CHANGELOG_PATH);
    if (info.size > MAX_CHANGELOG_SIZE) {
      const ts = rotationTimestamp();
      await rename(GLOBAL_CHANGELOG_PATH, join(LOCAL_USERS_DIR, `changelog.${ts}.md`));
      logger.info({ ts }, 'users global changelog rotated');
    }
  } catch { /* file doesn't exist yet */ }
}

async function listArchivedChangelogFiles(): Promise<string[]> {
  try {
    const files = await readdir(LOCAL_USERS_DIR);
    return files
      .filter(f => /^changelog\.\d{12}\.md$/.test(f))
      .sort()
      .reverse();
  } catch { return []; }
}

interface UserChange {
  region:    string;
  subdomain: string;
  userName:  string;
  email:     string;
  origin:    string;
  action:    'created' | 'updated' | 'deleted';
}

async function appendGlobalChangelog(
  username: string,
  mode:     'auto' | 'manual',
  total:    number,
  received: number,
  created:  number,
  updated:  number,
  deleted:  number,
  changes:  UserChange[],
): Promise<void> {
  await mkdir(LOCAL_USERS_DIR, { recursive: true });
  await rotateGlobalChangelogIfNeeded();

  const ts    = utcTimestamp();
  const label = mode === 'auto' ? 'Auto' : 'Manual';
  const heading = `## [${label}] global refresh by <${username}> at ${ts}`;
  const summary = `Refreshed ${total} of ${total} subaccounts - received ${received} users, created ${created}, updated ${updated} and deleted ${deleted} locally`;

  const changeLines = changes.map(c => {
    const display = `${c.email} <${c.email}> (${c.origin})`;
    const path = `/users/${encodeURIComponent(c.region)}/${encodeURIComponent(c.subdomain)}/${encodeURIComponent(c.origin)}/${encodeURIComponent(c.email)}/history`;
    return `- ${c.action}: ${c.region}.${c.subdomain} → ${display} [History](${path})`;
  });

  const parts = [heading, summary, ...changeLines].filter(Boolean);
  const entry = parts.join('\n') + '\n\n';

  const prev = existsSync(GLOBAL_CHANGELOG_PATH) ? await readFile(GLOBAL_CHANGELOG_PATH, 'utf-8') : '';
  await writeFile(GLOBAL_CHANGELOG_PATH, entry + prev, 'utf-8');
}

// ─── Startup: restore globalUsersRefreshTs from changelog ─────────────────────

async function restoreGlobalUsersRefreshTsFromChangelog(): Promise<void> {
  try {
    const content = await readFile(GLOBAL_CHANGELOG_PATH, 'utf-8');
    const m = content.match(/## \[(?:Auto|Manual)\] global refresh by .+ at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)/);
    if (m) {
      const parsed = new Date(m[1]!.replace(' UTC', 'Z')).getTime();
      if (!isNaN(parsed) && (globalUsersRefreshTs === null || parsed > globalUsersRefreshTs)) {
        globalUsersRefreshTs = parsed;
        logger.info({ ts: new Date(parsed).toISOString() }, 'users globalRefreshTs restored from changelog');
      }
    }
  } catch { /* no changelog yet */ }
}

void restoreGlobalUsersRefreshTsFromChangelog();

registerOnUsersChangelogSynced(() => {
  void restoreGlobalUsersRefreshTsFromChangelog();
});

registerOnUsersSynced(async (saPaths: string[]) => {
  const ts = Date.now();
  await Promise.all(saPaths.map(async key => {
    const slash = key.indexOf('/');
    if (slash === -1) return;
    const region    = key.slice(0, slash);
    const subdomain = key.slice(slash + 1);
    await refreshUsersOverviewCacheForSa(region, subdomain);
  }));
  emit('users', { files: saPaths, ts });
});

// ─── Public accessors ─────────────────────────────────────────────────────────

export function getGlobalUsersRefreshTs(): number | null { return globalUsersRefreshTs; }

// ─── Global refresh ───────────────────────────────────────────────────────────

export interface UserRefreshResult {
  received: number;
  created:  number;
  updated:  number;
  deleted:  number;
  errors:   string[];
  skipped?: boolean;
}

export async function refreshUsers(
  username = 'system',
  mode: 'auto' | 'manual',
  force = false,
): Promise<UserRefreshResult & { skipped?: boolean }> {
  if (globalUsersRefreshRunning && !force) {
    return { received: 0, created: 0, updated: 0, deleted: 0, errors: [], skipped: true };
  }
  globalUsersRefreshRunning = true;

  const sas        = (await readSubaccounts()).filter(sa => sa.manageRoles && !sa.restricted && sa.org?.orgId);
  const total      = sas.length;
  const keyStore   = await loadXsuaaKeyStore();
  const tokenStore = await loadXsuaaTokenStore();
  const cfFailed   = new Set<string>();

  let totalReceived  = 0;
  let totalCreated   = 0;
  let totalUpdated   = 0;
  let totalDeleted   = 0;
  let totalRefreshed = 0;
  const errors: string[]      = [];
  const allChanges: UserChange[] = [];

  try {
    for (let i = 0; i < sas.length; i++) {
      const sa    = sas[i]!;
      const loc   = `${sa.region}/${sa.subdomain}`;
      const orgId = sa.org!.orgId;

      emitImmediate('refresh-users', {
        type: 'progress', scope: 'global',
        current: i + 1, total,
        name: sa.alias || sa.subaccountName || sa.subdomain,
        received: totalReceived,
      });

      if (cfFailed.has(sa.region)) {
        errors.push(`${loc}: CF login failed for region ${sa.region}`);
        continue;
      }

      const spaceIds = sa.org?.spaces?.map(s => s.spaceId) ?? [];
      const auth = await resolveXsuaaToken(sa.region, orgId, sa.org!.orgName, spaceIds, keyStore, tokenStore, cfFailed);
      if ('error' in auth) {
        errors.push(`${loc}: ${auth.error}`);
        continue;
      }

      let users: XsuaaUser[];
      try {
        const raw = await withXsuaaApiRetry(sa.region, orgId, sa.org!.orgName, spaceIds, keyStore, tokenStore, cfFailed, auth,
          (tok, cred) => fetchUsersFromApi(cred.apiurl || cred.url, tok));
        const deduped = deduplicateUsers(raw);
        users = deduped.users;
        if (deduped.removed.length > 0)
          logger.warn(
            { loc, raw: raw.length, deduped: users.length, duplicates: deduped.removed.map(u => ({ id: u.id, userName: u.userName, email: userEmail(u), origin: u.origin })) },
            'XSUAA users: removed duplicate accounts (same origin+email)',
          );
      } catch (err) {
        errors.push(`${loc}: ${String(err)}`);
        continue;
      }

      totalRefreshed++;
      totalReceived += users.length;
      const userDir = join(LOCAL_USERS_DIR, sa.region, sa.subdomain);
      await mkdir(userDir, { recursive: true });

      // Persist each user
      const seenKeys = new Set<string>();
      for (const u of users) {
        seenKeys.add(`${u.origin}/${userEmail(u)}`);
        try {
          const result = await persistUser(userDir, u, username, mode);
          if (result === 'created') {
            totalCreated++;
            allChanges.push({ region: sa.region, subdomain: sa.subdomain, userName: u.userName, email: userEmail(u), origin: u.origin, action: 'created' });
          } else if (result === 'updated') {
            totalUpdated++;
            allChanges.push({ region: sa.region, subdomain: sa.subdomain, userName: u.userName, email: userEmail(u), origin: u.origin, action: 'updated' });
          }
        } catch (err) {
          errors.push(`${loc}/${userEmail(u)}: ${String(err)}`);
        }
      }

      // Deletions: rename .json to .deleted.json for users no longer returned by API
      try {
        const originEntries = await readdir(userDir, { withFileTypes: true });
        for (const originEntry of originEntries.filter(e => e.isDirectory())) {
          const originDir = join(userDir, originEntry.name);
          const files = (await readdir(originDir)).filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'));
          for (const f of files) {
            const emailKey = f.replace(/\.json$/, '');
            if (!seenKeys.has(`${originEntry.name}/${emailKey}`)) {
              const src = join(originDir, f);
              const dst = join(originDir, `${emailKey}.deleted.json`);
              await rename(src, dst);
              totalDeleted++;
              try {
                const del = JSON.parse(await readFile(dst, 'utf-8')) as XsuaaUser;
                allChanges.push({ region: sa.region, subdomain: sa.subdomain, userName: del.userName, email: userEmail(del), origin: del.origin, action: 'deleted' });
              } catch { allChanges.push({ region: sa.region, subdomain: sa.subdomain, userName: emailKey, email: emailKey, origin: originEntry.name, action: 'deleted' }); }
            }
          }
        }
      } catch { /* dir may not exist */ }

      await refreshUsersOverviewCacheForSa(sa.region, sa.subdomain);
      lastUsersRefreshTs.set(loc, Date.now());
      emit('users', { files: [loc], ts: Date.now() });
    }

    await saveXsuaaKeyStore(keyStore);
    await saveXsuaaTokenStore(tokenStore);

    // Append global changelog
    await appendGlobalChangelog(username, mode, total, totalReceived, totalCreated, totalUpdated, totalDeleted, allChanges);
    globalUsersRefreshTs = Date.now();
    notifyCallbacks();

    const result: UserRefreshResult = { received: totalReceived, created: totalCreated, updated: totalUpdated, deleted: totalDeleted, errors };
    emitImmediate('refresh-users', {
      type: 'done', scope: 'global',
      total: sas.length, refreshed: totalRefreshed,
      received: totalReceived, created: totalCreated, updated: totalUpdated, deleted: totalDeleted,
      issues: errors,
    });
    return result;
  } finally {
    globalUsersRefreshRunning = false;
  }
}

// ─── Per-SA refresh ───────────────────────────────────────────────────────────

export async function refreshSubaccountUsers(
  region:   string,
  subdomain: string,
  username = 'system',
  mode: 'auto' | 'manual',
): Promise<UserRefreshResult> {
  const sas = await readSubaccounts();
  const sa  = sas.find(s => s.region === region && s.subdomain === subdomain && s.manageRoles);
  if (!sa?.org?.orgId) throw new Error(`No managed-roles subaccount for ${region}/${subdomain}`);

  if (mode === 'auto') {
    const key   = `${region}/${subdomain}`;
    const delta = getAutoSubaccountRefreshMs();
    const last  = Math.max(lastUsersRefreshTs.get(key) ?? 0, globalUsersRefreshTs ?? 0);
    if (delta > 0 && Date.now() - last <= delta) {
      logger.debug({ loc: key }, 'users refresh skipped — still fresh');
      return { received: 0, created: 0, updated: 0, deleted: 0, errors: [] };
    }
  }

  const keyStore   = await loadXsuaaKeyStore();
  const tokenStore = await loadXsuaaTokenStore();
  const cfFailed   = new Set<string>();
  const spaceIds   = sa.org?.spaces?.map(s => s.spaceId) ?? [];

  const auth = await resolveXsuaaToken(region, sa.org.orgId, sa.org.orgName, spaceIds, keyStore, tokenStore, cfFailed);
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);
  if ('error' in auth) throw new Error(auth.error);

  emitImmediate('refresh-users', { type: 'progress', scope: 'subaccount', region, subdomain, current: 1, total: 1 });

  let users: XsuaaUser[];
  try {
    const raw = await withXsuaaApiRetry(region, sa.org.orgId, sa.org.orgName, spaceIds, keyStore, tokenStore, cfFailed, auth,
      (tok, cred) => fetchUsersFromApi(cred.apiurl || cred.url, tok));
    const deduped = deduplicateUsers(raw);
    users = deduped.users;
    if (deduped.removed.length > 0)
      logger.warn(
        { loc: `${region}/${subdomain}`, raw: raw.length, deduped: users.length, duplicates: deduped.removed.map(u => ({ id: u.id, userName: u.userName, email: userEmail(u), origin: u.origin })) },
        'XSUAA users: removed duplicate accounts (same origin+email)',
      );
  } catch (err) {
    await saveXsuaaKeyStore(keyStore);
    await saveXsuaaTokenStore(tokenStore);
    throw err;
  }
  await saveXsuaaKeyStore(keyStore);
  await saveXsuaaTokenStore(tokenStore);

  const userDir = join(LOCAL_USERS_DIR, region, subdomain);
  await mkdir(userDir, { recursive: true });

  let created = 0, updated = 0, deleted = 0;
  const errors: string[] = [];
  const seenKeys = new Set<string>();

  for (const u of users) {
    seenKeys.add(`${u.origin}/${userEmail(u)}`);
    try {
      const r = await persistUser(userDir, u, username, mode);
      if (r === 'created') created++;
      else if (r === 'updated') updated++;
    } catch (err) { errors.push(`${userEmail(u)}: ${String(err)}`); }
  }

  try {
    const originEntries = await readdir(userDir, { withFileTypes: true });
    for (const originEntry of originEntries.filter(e => e.isDirectory())) {
      const originDir = join(userDir, originEntry.name);
      const files = (await readdir(originDir)).filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'));
      for (const f of files) {
        const emailKey = f.replace(/\.json$/, '');
        if (!seenKeys.has(`${originEntry.name}/${emailKey}`)) {
          await rename(join(originDir, f), join(originDir, `${emailKey}.deleted.json`));
          deleted++;
        }
      }
    }
  } catch { /* ok */ }

  await refreshUsersOverviewCacheForSa(region, subdomain);
  lastUsersRefreshTs.set(`${region}/${subdomain}`, Date.now());
  emit('users', { files: [`${region}/${subdomain}`], ts: Date.now() });
  emitImmediate('refresh-users', { type: 'done', scope: 'subaccount', region, subdomain, received: users.length, created, updated, deleted, issues: errors });

  return { received: users.length, created, updated, deleted, errors };
}

// ─── Overview list ────────────────────────────────────────────────────────────

export async function listUsers(): Promise<Record<string, { users: UserSummary[]; total: number }>> {
  const sas = (await readSubaccounts()).filter(sa => sa.manageRoles && !sa.restricted);
  const result: Record<string, { users: UserSummary[]; total: number }> = {};

  await Promise.all(sas.map(async sa => {
    const key    = `${sa.region}/${sa.subdomain}`;
    const cached = usersOverviewCache.get(key);
    if (cached !== undefined) { result[key] = cached; return; }
    await refreshUsersOverviewCacheForSa(sa.region, sa.subdomain);
    result[key] = usersOverviewCache.get(key) ?? { users: [], total: 0 };
  }));

  return result;
}

// ─── Modal: full list for a subaccount ───────────────────────────────────────

export async function getUsersForSubaccount(region: string, subdomain: string): Promise<XsuaaUser[]> {
  const userDir = join(LOCAL_USERS_DIR, region, subdomain);
  try {
    const users = await readAllUsersFromDir(userDir);
    users.sort((a, b) => a.userName.localeCompare(b.userName));
    return users;
  } catch { return []; }
}

// ─── Single user ─────────────────────────────────────────────────────────────

export async function getUserDetail(region: string, subdomain: string, origin: string, email: string): Promise<XsuaaUser | null> {
  if (!origin || !email || origin.includes('..') || email.includes('..') || origin.includes('/') || email.includes('/')) return null;
  try {
    const raw = await readFile(join(LOCAL_USERS_DIR, region, subdomain, origin, `${email}.json`), 'utf-8');
    return JSON.parse(raw) as XsuaaUser;
  } catch { return null; }
}

export async function getUserChangelog(region: string, subdomain: string, origin: string, email: string): Promise<string> {
  if (!origin || !email || origin.includes('..') || email.includes('..') || origin.includes('/') || email.includes('/')) return '';
  try {
    return await readFile(join(LOCAL_USERS_DIR, region, subdomain, origin, `${email}.changelog.md`), 'utf-8');
  } catch { return ''; }
}

// ─── Global Access (cross-subaccount groups for a user email) ────────────────

export async function getUserGlobalAccess(origin: string, email: string): Promise<GlobalAccessEntry[]> {
  if (!origin || !email || origin.includes('..') || email.includes('..') || origin.includes('/') || email.includes('/')) return [];
  const sas    = (await readSubaccounts()).filter(sa => sa.manageRoles && !sa.restricted);
  const result: GlobalAccessEntry[] = [];

  await Promise.all(sas.map(async sa => {
    const filePath = join(LOCAL_USERS_DIR, sa.region, sa.subdomain, origin, `${email}.json`);
    if (!existsSync(filePath)) return;
    try {
      const u = JSON.parse(await readFile(filePath, 'utf-8')) as XsuaaUser;
      if (u.groups && u.groups.length > 0) {
        result.push({
          region:    sa.region,
          subdomain: sa.subdomain,
          alias:     sa.alias || sa.subdomain,
          groups:    normalizeGroups(u.groups),
        });
      }
    } catch { /* parse error */ }
  }));

  result.sort((a, b) => `${a.region}/${a.subdomain}`.localeCompare(`${b.region}/${b.subdomain}`));
  return result;
}

// ─── Full-text search ─────────────────────────────────────────────────────────

export async function searchUsers(q: string): Promise<{ matches: Record<string, { users: UserSummary[]; total: number }> }> {
  if (!q || q.trim().length < 2) return { matches: {} };
  const low     = q.trim().toLowerCase();
  const matches: Record<string, { users: UserSummary[]; total: number }> = {};

  const sas = (await readSubaccounts()).filter(sa => sa.manageRoles && !sa.restricted);
  await Promise.all(sas.map(async sa => {
    const key     = `${sa.region}/${sa.subdomain}`;
    const userDir = join(LOCAL_USERS_DIR, sa.region, sa.subdomain);
    try {
      const entries = await readdir(userDir, { withFileTypes: true });
      const found: UserSummary[] = [];

      // New format: origin subdirectories
      await Promise.all(entries.filter(e => e.isDirectory()).map(async d => {
        const oDir = join(userDir, d.name);
        const files = (await readdir(oDir)).filter(f => f.endsWith('.json') && !f.endsWith('.deleted.json'));
        await Promise.all(files.map(async f => {
          try {
            const text = await readFile(join(oDir, f), 'utf-8');
            if (!text.toLowerCase().includes(low)) return;
            const u = JSON.parse(text) as XsuaaUser;
            found.push({ id: u.id, userName: u.userName, email: userEmail(u), origin: u.origin, lastLogonTime: u.lastLogonTime, active: u.active });
          } catch { /* skip */ }
        }));
      }));

      // Old format: UUID files directly in userDir
      await Promise.all(entries.filter(e => !e.isDirectory() && /^[a-f0-9-]{36}\.json$/.test(e.name)).map(async e => {
        try {
          const text = await readFile(join(userDir, e.name), 'utf-8');
          if (!text.toLowerCase().includes(low)) return;
          const u  = JSON.parse(text) as XsuaaUser;
          const em = userEmail(u);
          if (!found.some(f => f.email === em)) {
            found.push({ id: u.id, userName: u.userName, email: em, origin: u.origin, lastLogonTime: u.lastLogonTime, active: u.active });
          }
        } catch { /* skip */ }
      }));

      if (found.length > 0) {
        found.sort((a, b) => (b.lastLogonTime ?? 0) - (a.lastLogonTime ?? 0));
        matches[key] = { users: found.slice(0, 15), total: found.length };
      }
    } catch { /* dir missing */ }
  }));

  return { matches };
}

// ─── Global changelog ─────────────────────────────────────────────────────────

export async function getGlobalUsersChangelog(file?: string): Promise<{ data: string; archivedFiles: string[] }> {
  const archivedFiles = await listArchivedChangelogFiles();
  if (file) {
    if (!/^changelog\.\d{12}\.md$/.test(file)) return { data: '', archivedFiles };
    try {
      const data = await readFile(join(LOCAL_USERS_DIR, file), 'utf-8');
      return { data, archivedFiles };
    } catch { return { data: '', archivedFiles }; }
  }
  try {
    const data = await readFile(GLOBAL_CHANGELOG_PATH, 'utf-8');
    return { data, archivedFiles };
  } catch { return { data: '', archivedFiles }; }
}

export async function searchGlobalUsersChangelogs(q: string): Promise<{ results: Record<string, string>; archivedFiles: string[] }> {
  const archivedFiles = await listArchivedChangelogFiles();
  if (!q || q.trim().length < 2) return { results: {}, archivedFiles };
  const low = q.trim().toLowerCase();
  const files = ['changelog.md', ...archivedFiles];
  const results: Record<string, string> = {};

  await Promise.all(files.map(async f => {
    try {
      const text = await readFile(join(LOCAL_USERS_DIR, f), 'utf-8');
      if (text.toLowerCase().includes(low)) results[f] = text;
    } catch { /* file missing */ }
  }));

  return { results, archivedFiles };
}
