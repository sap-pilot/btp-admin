import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { emit, emitImmediate } from './liveEvents.js';
import { readSubaccounts, type SubaccountEntry, type ServiceInstanceEntry } from './subaccountsService.js';
import { getOrRefreshToken, clearRegionToken, fetchWithRateLimit, getRegionAuditPlanGuid, setRegionAuditPlanGuid } from './cfLoginService.js';
import { getVar } from './variablesService.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditRecord {
  uuid?:     string;
  time:      string;
  category:  string;
  message:   unknown;
  [key: string]: unknown;
}

interface AuditCredentials {
  uaa: { url: string; clientid: string; clientsecret: string };
  url: string;
}

interface AuditToken { access_token: string; expires_at: number }

// Per-subaccount in-memory token cache
const auditTokenCache = new Map<string, AuditToken>();

const execAsync = promisify(exec);

// ─── Keyword search helpers ───────────────────────────────────────────────────

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function parseKeywords(q?: string): string[] {
  return (q ?? '').split(/\s+/).filter(Boolean);
}

// Returns the set of absolute file paths within `dir` that contain ALL keywords.
// Uses grep -rli + xargs -r grep -li pipeline (case-insensitive).
async function grepFiles(dir: string, keywords: string[]): Promise<Set<string>> {
  if (keywords.length === 0) return new Set();
  let cmd = `grep -rli ${shellQuote(keywords[0]!)} ${shellQuote(dir)}`;
  for (let i = 1; i < keywords.length; i++) {
    cmd += ` | xargs -r grep -li ${shellQuote(keywords[i]!)}`;
  }
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    return new Set(stdout.trim().split('\n').filter(Boolean));
  } catch { return new Set(); }
}

// Grep a specific list of file paths (not a whole directory) for all keywords.
// Used to apply keyword filter to an already time-range-narrowed file list.
async function grepFileList(filePaths: string[], keywords: string[]): Promise<Set<string>> {
  if (keywords.length === 0 || filePaths.length === 0) return new Set(filePaths);
  const fileArgs = filePaths.map(shellQuote).join(' ');
  let cmd = `grep -li ${shellQuote(keywords[0]!)} ${fileArgs}`;
  for (let i = 1; i < keywords.length; i++) {
    cmd += ` | xargs -r grep -li ${shellQuote(keywords[i]!)}`;
  }
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
    return new Set(stdout.trim().split('\n').filter(Boolean));
  } catch { return new Set(); }
}

// Returns lines from the given files that match ALL keywords (case-insensitive).
// Each line is a compact JSON record (JSONL format).
// Returns JSON record lines from files that match ALL keywords (case-insensitive).
// Filters out `[` / `]` array delimiters and strips trailing commas so each line
// is parseable as a standalone JSON object.
async function grepLines(files: string[], keywords: string[]): Promise<string[]> {
  if (keywords.length === 0 || files.length === 0) return [];
  const fileArgs = files.map(shellQuote).join(' ');
  let cmd = `grep -hi ${shellQuote(keywords[0]!)} ${fileArgs}`;
  for (let i = 1; i < keywords.length; i++) {
    cmd += ` | grep -i ${shellQuote(keywords[i]!)}`;
  }
  try {
    const { stdout } = await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(l => {
      const t = l.trim();
      return t !== '' && t !== '[' && t !== ']';
    }).map(l => l.trimEnd().replace(/,$/, '')); // strip trailing comma from JSON array lines
  } catch { return []; }
}

// ─── Regions ──────────────────────────────────────────────────────────────────

// Regions with 8 req/s limit; all others are 4 req/s
const FAST_REGIONS = new Set(['us10', 'eu10', 'ap10', 'jp10', 'br10', 'ca10', 'au10', 'eu11', 'us20', 'us21', 'ap11', 'ap12', 'ap20', 'ap21', 'eu20', 'eu30', 'in30', 'jp20', 'us30']);
function getRateLimitDelayMs(region: string): number {
  return FAST_REGIONS.has(region) ? 125 : 250;
}

function getMaxAuditStorageDays(): number {
  const v = getVar('MAX_AUDIT_LOG_STORAGE_DAYS');
  if (!v) return 0;
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? 0 : n;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

export function getAuditLogDir(region: string, subdomain: string): string {
  return join(config.LOCAL_STORE_DIR, 'audit-log', region, subdomain.toLowerCase());
}

function parseHourKey(isoTime: string): string {
  // From "2026-09-14T00:12:34.000Z" → "2026-09-14T00"
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getUTCFullYear();
  const MM   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const HH   = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${HH}`;
}

function formatTimeForApi(d: Date): string {
  // "2026-09-14T00:00:00" (no timezone suffix — API expects this format)
  const yyyy = d.getUTCFullYear();
  const MM   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const HH   = String(d.getUTCHours()).padStart(2, '0');
  const mm   = String(d.getUTCMinutes()).padStart(2, '0');
  const ss   = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}`;
}

function categoryCounts(records: AuditRecord[]): { da: number; se: number; cfg: number; dm: number; other: number } {
  let da = 0, se = 0, cfg = 0, dm = 0, other = 0;
  for (const r of records) {
    switch (r.category) {
      case 'audit.data-access':       da++;    break;
      case 'audit.security-events':   se++;    break;
      case 'audit.configuration':     cfg++;   break;
      case 'audit.data-modification': dm++;    break;
      default:                        other++; break;
    }
  }
  return { da, se, cfg, dm, other };
}

function hourFilename(hourKey: string, counts: ReturnType<typeof categoryCounts>): string {
  const { da, se, cfg, dm, other } = counts;
  return `${hourKey}_${da}_${se}_${cfg}_${dm}${other > 0 ? `_${other}` : ''}.json`;
}

// ─── Audit file parse (JSON array with JSONL fallback for legacy files) ────────

function parseAuditFile(raw: string): AuditRecord[] {
  const t = raw.trim();
  if (t.startsWith('[')) {
    try { return JSON.parse(t) as AuditRecord[]; } catch { /* fall through */ }
  }
  // Legacy JSONL: one record per line, no surrounding array
  return t.split('\n').filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l.replace(/,$/, '')) as AuditRecord]; } catch { return []; }
  });
}

// ─── Time range ───────────────────────────────────────────────────────────────

async function getTimeRange(dir: string): Promise<{ from: string; to: string }> {
  const to = formatTimeForApi(new Date());
  try {
    const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) throw new Error('empty');
    const lastFile = files[files.length - 1]!;
    const raw  = await readFile(join(dir, lastFile), 'utf-8');
    const recs = parseAuditFile(raw);
    // Find the latest time entry
    let latest = '';
    for (const r of recs) {
      if (r.time && r.time > latest) latest = r.time;
    }
    if (!latest) throw new Error('no time');
    return { from: formatTimeForApi(new Date(latest)), to };
  } catch {
    // No files or can't read — start from configured max days (default 90)
    const days = getMaxAuditStorageDays() || 90;
    return { from: formatTimeForApi(new Date(Date.now() - days * 24 * 60 * 60 * 1000)), to };
  }
}

// ─── Record storage ───────────────────────────────────────────────────────────

function tryParseMessage(msg: unknown): unknown {
  if (typeof msg !== 'string') return msg;
  try { return JSON.parse(msg); } catch { return msg; }
}

async function parseAndSaveRecords(dir: string, records: AuditRecord[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dir, { recursive: true });

  // Normalize message fields
  const normalized: AuditRecord[] = records.map(r => {
    const msg = tryParseMessage(r.message);
    if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
      const msgObj = msg as Record<string, unknown>;
      if (typeof msgObj['data'] === 'string') msgObj['data'] = tryParseMessage(msgObj['data']);
    }
    return { ...r, message: msg };
  });

  // Group by UTC hour
  const byHour = new Map<string, AuditRecord[]>();
  for (const r of normalized) {
    const key = parseHourKey(r.time);
    if (!key) continue;
    const arr = byHour.get(key) ?? [];
    arr.push(r);
    byHour.set(key, arr);
  }

  const existingFiles = await readdir(dir).catch(() => [] as string[]);

  for (const [hourKey, newRecs] of byHour) {
    const prefix       = `${hourKey}_`;
    const existingFile = existingFiles.find(f => f.startsWith(prefix) && f.endsWith('.json'));

    let fileContent: string;
    let finalCounts:  { da: number; se: number; cfg: number; dm: number; other: number };

    if (existingFile) {
      // Read file once: used for both dedup and content manipulation
      let raw = '';
      try { raw = await readFile(join(dir, existingFile), 'utf-8'); } catch { /* treat as missing */ }

      // Deduplicate incoming records against existing content
      const prev  = parseAuditFile(raw);
      const seen  = new Set<string>(prev.map(r => r.uuid ?? JSON.stringify(r)));
      const fresh = newRecs
        .filter(r => !seen.has(r.uuid ?? JSON.stringify(r)))
        .sort((a, b) => a.time.localeCompare(b.time));

      if (fresh.length === 0) continue; // nothing new

      // Efficient append: find closing `\n]` and insert new lines before it.
      // This avoids reparsing the entire array — counts come from the filename.
      const closingIdx = raw.lastIndexOf('\n]');
      if (closingIdx !== -1 && prev.length > 0) {
        fileContent = raw.slice(0, closingIdx)
          + ',\n'
          + fresh.map(r => JSON.stringify(r)).join(',\n')
          + '\n]';
      } else {
        // File was empty/malformed — rebuild from scratch
        const merged = [...prev, ...fresh].sort((a, b) => a.time.localeCompare(b.time));
        fileContent  = `[\n${merged.map(r => JSON.stringify(r)).join(',\n')}\n]`;
      }

      // Derive updated counts from the filename + fresh records (no full re-parse)
      const existingMatch = AUDIT_FILENAME_RE.exec(existingFile);
      if (existingMatch) {
        const nc = categoryCounts(fresh);
        finalCounts = {
          da:    parseInt(existingMatch[2]!, 10) + nc.da,
          se:    parseInt(existingMatch[3]!, 10) + nc.se,
          cfg:   parseInt(existingMatch[4]!, 10) + nc.cfg,
          dm:    parseInt(existingMatch[5]!, 10) + nc.dm,
          other: (existingMatch[6] ? parseInt(existingMatch[6], 10) : 0) + nc.other,
        };
      } else {
        finalCounts = categoryCounts(parseAuditFile(fileContent));
      }

      await unlink(join(dir, existingFile)).catch(() => undefined);
    } else {
      // New file
      const sorted = [...newRecs].sort((a, b) => a.time.localeCompare(b.time));
      fileContent  = `[\n${sorted.map(r => JSON.stringify(r)).join(',\n')}\n]`;
      finalCounts  = categoryCounts(sorted);
    }

    const filename = hourFilename(hourKey, finalCounts);
    await writeFile(join(dir, filename), fileContent, 'utf-8');
  }
}

// ─── CF API helpers ───────────────────────────────────────────────────────────

interface CfPage<T> { resources: T[]; pagination?: { next?: { href?: string } } }

async function cfFetch(url: string, authHeader: string): Promise<Response> {
  return fetchWithRateLimit(
    () => fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } }),
    url,
  );
}

// Fetches a CF API URL with automatic 401 recovery: evicts the cached token for
// the region and re-authenticates using CF_USERNAME + CF_PASSWORD, then retries once.
async function cfGet<T>(region: string, url: string): Promise<T> {
  const token = await getOrRefreshToken(region);
  let res = await cfFetch(url, `${token.token_type} ${token.access_token}`);
  if (res.status === 401) {
    logger.debug({ region, url }, 'CF API 401 — evicting cached token and re-authenticating');
    clearRegionToken(region);
    const fresh = await getOrRefreshToken(region);
    res = await cfFetch(url, `${fresh.token_type} ${fresh.access_token}`);
  }
  if (!res.ok) throw new Error(`CF API GET ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function cfGetAll<T>(region: string, startUrl: string): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = startUrl;
  while (url) {
    // eslint-disable-next-line no-await-in-loop
    const resp: CfPage<T> = await cfGet<CfPage<T>>(region, url);
    all.push(...(resp.resources ?? []));
    url = resp.pagination?.next?.href ?? null;
  }
  return all;
}

// ─── Audit key file store ─────────────────────────────────────────────────────

const AUDIT_KEY_PATH = join(homedir(), '.ba', 'auditlog-management-keys.json');

interface AuditKeyEntry { keyGuid: string; credentials: AuditCredentials; cachedAt: number }
type AuditKeyStore = Record<string, AuditKeyEntry>; // key: `${region}/${instanceId}`

let auditKeyStore: AuditKeyStore | null = null;

async function loadAuditKeyStore(): Promise<AuditKeyStore> {
  if (auditKeyStore !== null) return auditKeyStore;
  try {
    const raw = await readFile(AUDIT_KEY_PATH, 'utf-8');
    auditKeyStore = JSON.parse(raw) as AuditKeyStore;
  } catch { auditKeyStore = {}; }
  return auditKeyStore;
}

async function saveAuditKeyStore(): Promise<void> {
  if (auditKeyStore === null) return;
  await mkdir(join(homedir(), '.ba'), { recursive: true });
  await writeFile(AUDIT_KEY_PATH, JSON.stringify(auditKeyStore, null, 2), 'utf-8');
}

// ─── Credentials ─────────────────────────────────────────────────────────────

// Per-region in-memory cache for the auditlog-management 'default' plan GUID.
// The GUID is also persisted in cf_login_tokens.json so it survives restarts.
const auditPlanGuidCache = new Map<string, string>();

async function getAuditLogPlanGuid(region: string): Promise<string | null> {
  if (auditPlanGuidCache.has(region)) return auditPlanGuidCache.get(region)!;
  // Check what was persisted in cf_login_tokens.json on a previous run
  const stored = getRegionAuditPlanGuid(region);
  if (stored) { auditPlanGuidCache.set(region, stored); return stored; }
  const apiUrl  = `https://api.cf.${region}.hana.ondemand.com`;
  const planUrl = `${apiUrl}/v3/service_plans?per_page=5000&service_offering_names=auditlog-management&names=default`;
  logger.debug({ region, planUrl }, 'Querying auditlog-management default plan GUID');
  const plans = await cfGetAll<{ guid: string; name: string }>(region, planUrl);
  logger.debug({ region, count: plans.length }, 'auditlog-management plans found');
  if (plans.length === 0) return null;
  const guid = plans[0]!.guid;
  auditPlanGuidCache.set(region, guid);
  await setRegionAuditPlanGuid(region, guid).catch(err =>
    logger.warn({ region, err }, 'Failed to persist audit plan GUID to token store'),
  );
  return guid;
}

async function cfPost<T>(region: string, url: string, body: unknown): Promise<{ status: number; data: T; location?: string }> {
  const doReq = (tok: Awaited<ReturnType<typeof getOrRefreshToken>>) =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `${tok.token_type} ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  const token = await getOrRefreshToken(region);
  let res = await doReq(token);
  if (res.status === 401) {
    clearRegionToken(region);
    res = await doReq(await getOrRefreshToken(region));
  }
  if (res.status !== 201 && res.status !== 202) {
    const text = await res.text().catch(() => '');
    throw new Error(`CF API POST ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as T;
  return { status: res.status, data, location: res.headers.get('Location') ?? undefined };
}

async function pollCfJob(region: string, jobUrl: string): Promise<void> {
  const apiUrl = `https://api.cf.${region}.hana.ondemand.com`;
  const fullUrl = jobUrl.startsWith('http') ? jobUrl : `${apiUrl}${jobUrl}`;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    // eslint-disable-next-line no-await-in-loop
    const job = await cfGet<{ state: string; errors?: unknown[] }>(region, fullUrl);
    if (job.state === 'COMPLETE') return;
    if (job.state === 'FAILED') throw new Error(`CF job failed: ${JSON.stringify(job.errors)}`);
  }
  throw new Error('CF job timed out after 60s');
}

async function createAuditLogServiceKey(region: string, instanceId: string): Promise<{ guid: string; name: string } | null> {
  const apiUrl = `https://api.cf.${region}.hana.ondemand.com`;
  const keyName = 'btp-admin-sk';
  logger.debug({ region, instanceId, keyName }, 'Creating auditlog-management service key');
  try {
    const result = await cfPost<{ guid?: string }>(region, `${apiUrl}/v3/service_credential_bindings`, {
      type: 'key', name: keyName,
      relationships: { service_instance: { data: { guid: instanceId } } },
    });
    if (result.status === 201 && result.data.guid) return { guid: result.data.guid, name: keyName };
    if (result.status === 202 && result.location) await pollCfJob(region, result.location);
    const found = await cfGetAll<{ guid: string; name: string }>(
      region,
      `${apiUrl}/v3/service_credential_bindings?type=key&name=${encodeURIComponent(keyName)}&service_instance_guids=${instanceId}`,
    );
    return found[0] ?? null;
  } catch (err) {
    logger.warn({ region, instanceId, err }, 'Failed to create auditlog-management service key');
    return null;
  }
}

async function getAuditLogCredentials(
  sa: SubaccountEntry,
  warnings: string[],
): Promise<AuditCredentials | null> {
  const region = sa.region;
  const alias  = sa.alias || sa.subaccountName;
  const label  = `${alias} (${region}/${sa.subdomain})`;

  // 1. Try cached serviceInstances
  let instance: ServiceInstanceEntry | undefined = sa.serviceInstances?.find(
    si => si.serviceOfferingName === 'auditlog-management',
  );
  let instanceId: string | undefined = instance?.id;

  // 2. Query CF API if not in cache
  if (!instanceId) {
    if (!sa.org?.orgId) {
      warnings.push(`${label} — no auditlog-management service instance (no org info)`);
      return null;
    }
    try {
      const apiUrl = `https://api.cf.${region}.hana.ondemand.com`;

      // Step 2a: Get the 'default' plan GUID for this region (cached after first call)
      const planGuid = await getAuditLogPlanGuid(region);
      if (!planGuid) {
        warnings.push(`${label} — auditlog-management 'default' plan not found in region ${region}`);
        return null;
      }

      // Step 2b: Find the service instance in this org using the plan GUID
      const instanceUrl = `${apiUrl}/v3/service_instances?type=managed&service_plan_guids=${planGuid}&organization_guids=${encodeURIComponent(sa.org.orgId)}&per_page=200`;
      logger.debug({ label, planGuid, instanceUrl }, 'Looking up auditlog-management service instance');
      const instances = await cfGetAll<{ guid: string; name: string }>(region, instanceUrl);
      logger.debug({ label, count: instances.length, names: instances.map(i => i.name) }, 'auditlog-management instances found');
      if (instances.length === 0) {
        warnings.push(`${label} — no auditlog-management.default instance found in org ${sa.org.orgId}`);
        return null;
      }
      instanceId = instances[0]!.guid;
    } catch (err) {
      warnings.push(`${label} CF API error looking up auditlog-management: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // 3. Check persisted key cache
  const keyCacheKey = `${region}/${instanceId}`;
  const keyStore = await loadAuditKeyStore();
  const cachedKey = keyStore[keyCacheKey];
  if (cachedKey?.credentials?.uaa?.url && cachedKey.credentials.url) {
    logger.debug({ label, keyCacheKey }, 'Using cached auditlog-management service key');
    return cachedKey.credentials;
  }

  // 4. Discover or create service key
  try {
    const apiUrl = `https://api.cf.${region}.hana.ondemand.com`;

    const bindingsUrl = `${apiUrl}/v3/service_credential_bindings?type=key&service_instance_guids=${instanceId}&per_page=50`;
    logger.debug({ label, instanceId, bindingsUrl }, 'Looking up auditlog-management service key bindings');
    const bindings = await cfGetAll<{ guid: string; name: string }>(region, bindingsUrl);
    logger.debug({ label, count: bindings.length, names: bindings.map(b => b.name) }, 'auditlog-management service key bindings found');

    let binding: { guid: string; name: string } | undefined;
    if (bindings.length === 0) {
      logger.debug({ label, instanceId }, 'No service keys — creating btp-admin-sk');
      const created = await createAuditLogServiceKey(region, instanceId);
      if (!created) {
        warnings.push(`${label} — no service key found and failed to create btp-admin-sk`);
        return null;
      }
      binding = created;
    } else {
      // Prefer dedicated btp-admin-sk; fall back to first available
      binding = bindings.find(b => b.name === 'btp-admin-sk') ?? bindings[0]!;
      logger.debug({ label, chosen: binding.name }, 'Selected auditlog-management service key');
    }

    const details = await cfGet<{ credentials: AuditCredentials }>(
      region,
      `${apiUrl}/v3/service_credential_bindings/${binding.guid}/details`,
    );
    if (!details.credentials?.uaa?.url || !details.credentials?.url) {
      warnings.push(`${label} service key credentials are incomplete`);
      return null;
    }

    // Persist to key cache
    keyStore[keyCacheKey] = { keyGuid: binding.guid, credentials: details.credentials, cachedAt: Date.now() };
    auditKeyStore = keyStore;
    await saveAuditKeyStore().catch(err =>
      logger.warn({ label, err }, 'Failed to save audit key store'),
    );

    return details.credentials;
  } catch (err) {
    warnings.push(`${label} error getting service key: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Audit Log OAuth token ────────────────────────────────────────────────────

async function getAuditLogToken(creds: AuditCredentials, cacheKey: string): Promise<string> {
  const cached = auditTokenCache.get(cacheKey);
  if (cached && cached.expires_at - Date.now() > 60_000) return cached.access_token;

  const basic  = Buffer.from(`${creds.uaa.clientid}:${creds.uaa.clientsecret}`).toString('base64');
  const res    = await fetchWithRateLimit(
    () => fetch(`${creds.uaa.url}/oauth/token`, {
      method:  'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'grant_type=client_credentials',
    }),
    'audit-log-token',
  );
  if (!res.ok) throw new Error(`Audit log token request failed: HTTP ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in?: number };
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  auditTokenCache.set(cacheKey, { access_token: data.access_token, expires_at: Date.now() + expiresIn * 1000 });
  return data.access_token;
}

// ─── Refresh orchestration ────────────────────────────────────────────────────

let refreshRunning = false;

export async function refreshAuditLogs(): Promise<void> {
  if (refreshRunning) {
    logger.info('Audit log refresh already running — skipping');
    return;
  }
  refreshRunning = true;
  const warnings: string[] = [];

  try {
    const allSas = await readSubaccounts();
    const targets = allSas.filter(sa => sa.viewAuditLogs);
    const total   = targets.length;

    emitImmediate('audit-log', { type: 'audit-start', total });
    logger.info({ total }, 'Audit log refresh started');

    for (let i = 0; i < targets.length; i++) {
      const sa    = targets[i]!;
      const alias = sa.alias || sa.subaccountName;
      const current = i + 1;

      emit('audit-log', { type: 'audit-progress', current, total, alias, phase: 'credentials' });
      logger.debug({ alias, current, total }, 'Fetching audit log credentials');

      const creds = await getAuditLogCredentials(sa, warnings);
      if (!creds) continue;

      const cacheKey = `${sa.region}/${sa.subdomain}`;
      let token: string;
      try {
        token = await getAuditLogToken(creds, cacheKey);
      } catch (err) {
        const msg = `${alias} (${sa.region}/${sa.subdomain}) audit log token error: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(msg);
        logger.warn({ alias }, 'Audit log token fetch failed');
        continue;
      }

      const dir = getAuditLogDir(sa.region, sa.subdomain);
      const { from, to } = await getTimeRange(dir);
      logger.debug({ alias, from, to }, 'Audit log time range');

      emit('audit-log', { type: 'audit-progress', current, total, alias, phase: 'fetching', page: 0 });

      let url: string | null = `${creds.url}/auditlog/v2/auditlogrecords?time_from=${encodeURIComponent(from)}&time_to=${encodeURIComponent(to)}`;
      // Streaming buffer: flush to disk when a new hour is detected or buffer exceeds 2 000 records
      let pendingRecords: AuditRecord[] = [];
      let lastHourKey = '';
      let totalSaved = 0;
      let page = 0;

      while (url) {
        const delayMs = getRateLimitDelayMs(sa.region);
        let res: Response;
        let attempts = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (res.status !== 429 || attempts >= 3) break;
          const retryAfter = res.headers.get('Retry-After');
          const wait = retryAfter ? parseFloat(retryAfter) * 1000 : delayMs * 4;
          logger.warn({ alias, attempt: attempts + 1, wait }, 'Audit log API rate limited');
          await new Promise(r => setTimeout(r, wait));
          attempts++;
        }

        if (!res.ok) {
          warnings.push(`${alias} audit log API error HTTP ${res.status} at page ${page + 1}`);
          break;
        }

        const records = await res.json() as AuditRecord[];
        page++;
        const lastTime = records[records.length - 1]?.time ?? '';
        emit('audit-log', { type: 'audit-progress', current, total, alias, phase: 'fetching', page, received: totalSaved + pendingRecords.length + records.length, lastTime });
        logger.debug({ alias, page, pending: pendingRecords.length, received: records.length, lastTime }, 'Audit log page fetched');

        // Flush pending records if a new hour has started or buffer is too large
        const firstHourKey = records[0]?.time ? parseHourKey(records[0].time) : '';
        const newHour = firstHourKey !== '' && firstHourKey !== lastHourKey && lastHourKey !== '';
        if (pendingRecords.length > 0 && (newHour || pendingRecords.length > 2000)) {
          await parseAndSaveRecords(dir, pendingRecords);
          totalSaved += pendingRecords.length;
          logger.debug({ alias, flushed: pendingRecords.length, totalSaved, trigger: newHour ? 'new-hour' : 'buffer-full' }, 'Audit log flushed to disk');
          pendingRecords = [];
        }

        pendingRecords.push(...records);
        if (lastTime) lastHourKey = parseHourKey(lastTime);

        // Pagination via paging header
        const pagingHeader = res.headers.get('paging') ?? res.headers.get('Paging') ?? '';
        const handleMatch  = pagingHeader.match(/handle=([^\s,]+)/);
        if (handleMatch?.[1]) {
          url = `${creds.url}/auditlog/v2/auditlogrecords?handle=${encodeURIComponent(handleMatch[1])}`;
          await new Promise(r => setTimeout(r, delayMs));
        } else {
          url = null;
        }
      }

      // Final flush for any remaining buffered records
      if (pendingRecords.length > 0) {
        await parseAndSaveRecords(dir, pendingRecords);
        totalSaved += pendingRecords.length;
      }
      logger.info({ alias, records: totalSaved, pages: page }, 'Audit log records saved');
    }

    emitImmediate('audit-log', { type: 'audit-done', warnings });
    logger.info({ warnings }, 'Audit log refresh completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitImmediate('audit-log', { type: 'audit-error', error: msg, warnings });
    logger.error({ err }, 'Audit log refresh failed');
  } finally {
    refreshRunning = false;
  }
}

export function isAuditRefreshRunning(): boolean {
  return refreshRunning;
}

// ─── Single-subaccount refresh ────────────────────────────────────────────────

const saRefreshRunning = new Set<string>();

export function isSaAuditRefreshRunning(region: string, subdomain: string): boolean {
  return saRefreshRunning.has(`${region}/${subdomain.toLowerCase()}`);
}

export async function refreshSubaccountAuditLogs(region: string, subdomain: string): Promise<void> {
  const key   = `${region}/${subdomain.toLowerCase()}`;
  const topic = `audit-sa:${key}`;
  if (saRefreshRunning.has(key)) return;
  saRefreshRunning.add(key);
  const warnings: string[] = [];

  try {
    const allSas = await readSubaccounts();
    const sa = allSas.find(s => s.region === region && s.subdomain.toLowerCase() === subdomain.toLowerCase());
    if (!sa) {
      emitImmediate(topic, { type: 'audit-sa-done', warnings: [`Subaccount not found: ${region}/${subdomain}`] });
      return;
    }
    const alias = sa.alias || sa.subaccountName;
    emitImmediate(topic, { type: 'audit-sa-start' });

    const creds = await getAuditLogCredentials(sa, warnings);
    if (!creds) { emitImmediate(topic, { type: 'audit-sa-done', warnings }); return; }

    const cacheKey = `${sa.region}/${sa.subdomain}`;
    let token: string;
    try {
      token = await getAuditLogToken(creds, cacheKey);
    } catch (err) {
      warnings.push(`${alias} token error: ${err instanceof Error ? err.message : String(err)}`);
      emitImmediate(topic, { type: 'audit-sa-done', warnings });
      return;
    }

    const dir = getAuditLogDir(sa.region, sa.subdomain);
    const { from, to } = await getTimeRange(dir);
    // from/to come from formatTimeForApi which always uses UTC values but omits the
    // Z suffix (the Audit Log API rejects the Z). Parse with explicit UTC to avoid
    // local-timezone skew that would make diffMinutes wildly negative.
    const fromTs       = new Date((from.endsWith('Z') ? from : from + 'Z')).getTime();
    const totalMinutes = Math.max((Date.now() - fromTs) / 60000, 1);
    emit(topic, { type: 'audit-sa-progress', phase: 'fetching', page: 0, lastTime: '', pct: 0 });

    let url: string | null = `${creds.url}/auditlog/v2/auditlogrecords?time_from=${encodeURIComponent(from)}&time_to=${encodeURIComponent(to)}`;
    let pendingRecords: AuditRecord[] = [];
    let lastHourKey = '';
    let totalSaved  = 0;
    let page        = 0;

    while (url) {
      const delayMs  = getRateLimitDelayMs(sa.region);
      const pageUrl  = url;
      const t0Page   = Date.now();
      let res: Response;
      let attempts = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status !== 429 || attempts >= 3) break;
        const retryAfter = res.headers.get('Retry-After');
        const wait = retryAfter ? parseFloat(retryAfter) * 1000 : delayMs * 4;
        await new Promise(r => setTimeout(r, wait));
        attempts++;
      }
      if (!res.ok) {
        warnings.push(`${alias} audit log API HTTP ${res.status} at page ${page + 1}`);
        break;
      }

      const records = await res.json() as AuditRecord[];
      page++;
      const lastTime    = records[records.length - 1]?.time ?? '';
      // API returns UTC ISO times; guard against missing Z just in case
      const lastTimeMs  = lastTime ? new Date(lastTime.endsWith('Z') ? lastTime : lastTime + 'Z').getTime() : 0;
      const diffMinutes = lastTimeMs ? (lastTimeMs - fromTs) / 60000 : 0;
      const pct         = Math.min(100, Math.round(diffMinutes / totalMinutes * 100));
      const queryStr    = (() => { try { return new URL(pageUrl).search.slice(1); } catch { return pageUrl; } })();
      logger.debug(
        { target: `${sa.region}.${sa.subdomain}`, alias, page, records: records.length, lastTime, pct, query: queryStr, durationMs: Date.now() - t0Page },
        'audit-sa: page received',
      );
      emit(topic, { type: 'audit-sa-progress', phase: 'fetching', page, lastTime, pct });

      const firstHourKey = records[0]?.time ? parseHourKey(records[0].time) : '';
      const newHour = firstHourKey !== '' && firstHourKey !== lastHourKey && lastHourKey !== '';
      if (pendingRecords.length > 0 && (newHour || pendingRecords.length > 2000)) {
        await parseAndSaveRecords(dir, pendingRecords);
        totalSaved += pendingRecords.length;
        pendingRecords = [];
      }
      pendingRecords.push(...records);
      if (lastTime) lastHourKey = parseHourKey(lastTime);

      const pagingHeader = res.headers.get('paging') ?? res.headers.get('Paging') ?? '';
      const handleMatch  = pagingHeader.match(/handle=([^\s,]+)/);
      if (handleMatch?.[1]) {
        url = `${creds.url}/auditlog/v2/auditlogrecords?handle=${encodeURIComponent(handleMatch[1])}`;
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        url = null;
      }
    }

    if (pendingRecords.length > 0) {
      await parseAndSaveRecords(dir, pendingRecords);
      totalSaved += pendingRecords.length;
    }
    logger.info({ alias, totalSaved, pages: page }, 'Single-SA audit log refresh complete');
    emitImmediate(topic, { type: 'audit-sa-done', warnings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitImmediate(topic, { type: 'audit-sa-error', error: msg, warnings });
    logger.error({ err, region, subdomain }, 'Single-SA audit log refresh failed');
  } finally {
    saRefreshRunning.delete(key);
  }
}

// ─── Stats (chart data) ───────────────────────────────────────────────────────

export interface AuditHourStat {
  hourKey:      string;  // "2026-09-14T00"
  region:       string;
  subdomain:    string;
  dataAccess:   number;
  security:     number;
  config:       number;
  modification: number;
  other:        number;
}

const AUDIT_FILENAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})_(\d+)_(\d+)_(\d+)_(\d+)(?:_(\d+))?\.json$/;

const KNOWN_SHORT_CATS = new Set(['data-access', 'security-events', 'configuration', 'data-modification']);
function normalizeCat(category: string): string {
  const short = category.replace('audit.', '');
  return KNOWN_SHORT_CATS.has(short) ? short : 'other';
}

export async function getAuditStats(
  durationDays: number,
  keyword?: string,
): Promise<{ stats: AuditHourStat[]; warnings: string[]; saSizes: Record<string, number> }> {
  const warnings: string[] = [];
  const stats:    AuditHourStat[] = [];
  const saSizes:  Record<string, number> = {};
  const cutoff    = new Date(Date.now() - durationDays * 24 * 60 * 60 * 1000);
  const cutoffKey = parseHourKey(cutoff.toISOString());

  const allSas = await readSubaccounts();
  const targets = allSas.filter(sa => sa.viewAuditLogs);

  for (const sa of targets) {
    const dir = getAuditLogDir(sa.region, sa.subdomain);
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }

    // Narrow to files in the requested time range
    const inRange = files
      .map(f => ({ f, m: AUDIT_FILENAME_RE.exec(f) }))
      .filter(({ m }) => m !== null && m[1]! >= cutoffKey);

    const keywords = parseKeywords(keyword);

    if (keywords.length > 0 && inRange.length > 0) {
      // Keyword path: grep only matching files, then count matching lines by
      // category so the chart reflects actual keyword-hit counts, not total
      // hourly counts from filenames.
      const inRangePaths = inRange.map(({ f }) => join(dir, f));
      const matchSet     = await grepFileList(inRangePaths, keywords);
      const candidatePaths = inRange
        .filter(({ f }) => matchSet.has(join(dir, f)))
        .map(({ f }) => join(dir, f));

      if (candidatePaths.length > 0) {
        const lines = await grepLines(candidatePaths, keywords);
        // Group matching lines by UTC hour (extracted from "time" field) and count categories.
        const hourCounts = new Map<string, { da: number; se: number; cfg: number; dm: number; other: number }>();
        for (const line of lines) {
          const timeMatch = /"time"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2})/.exec(line);
          if (!timeMatch) continue;
          const hourKey = timeMatch[1]!;
          if (!hourCounts.has(hourKey)) hourCounts.set(hourKey, { da: 0, se: 0, cfg: 0, dm: 0, other: 0 });
          const c = hourCounts.get(hourKey)!;
          const cat = (/"category"\s*:\s*"(audit\.[^"]+)"/.exec(line))?.[1] ?? '';
          switch (cat) {
            case 'audit.data-access':       c.da++;    break;
            case 'audit.security-events':   c.se++;    break;
            case 'audit.configuration':     c.cfg++;   break;
            case 'audit.data-modification': c.dm++;    break;
            default:                        c.other++; break;
          }
        }
        for (const [hourKey, { da, se, cfg, dm, other }] of hourCounts) {
          if (da + se + cfg + dm + other === 0) continue;
          stats.push({ hourKey, region: sa.region, subdomain: sa.subdomain,
            dataAccess: da, security: se, config: cfg, modification: dm, other });
        }
      }
    } else {
      // No keyword: fast path — read counts directly from filenames; stat for sizes.
      const saKey = `${sa.region}/${sa.subdomain}`;
      const sizes = await Promise.all(inRange.map(({ f }) => stat(join(dir, f)).then(s => s.size).catch(() => 0)));
      saSizes[saKey] = (saSizes[saKey] ?? 0) + sizes.reduce((a, b) => a + b, 0);
      for (const { f, m } of inRange) {
        stats.push({
          hourKey:      m![1]!,
          region:       sa.region,
          subdomain:    sa.subdomain,
          dataAccess:   parseInt(m![2]!, 10),
          security:     parseInt(m![3]!, 10),
          config:       parseInt(m![4]!, 10),
          modification: parseInt(m![5]!, 10),
          other:        m![6] ? parseInt(m![6], 10) : 0,
        });
      }
    }
  }

  stats.sort((a, b) => a.hourKey.localeCompare(b.hourKey));
  return { stats, warnings, saSizes };
}

// ─── Per-SA stats (for AuditLogTab mini chart) ───────────────────────────────

export async function getAuditSaStats(
  region:       string,
  subdomain:    string,
  durationDays: number,
  categories?:  Set<string>,
): Promise<AuditHourStat[]> {
  const cutoff    = new Date(Date.now() - durationDays * 24 * 60 * 60 * 1000);
  const cutoffKey = parseHourKey(cutoff.toISOString());
  const stats: AuditHourStat[] = [];
  const dir = getAuditLogDir(region, subdomain);
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }
  for (const f of files) {
    const m = AUDIT_FILENAME_RE.exec(f);
    if (!m || m[1]! < cutoffKey) continue;
    const has = (cat: string) => !categories || categories.has(cat);
    stats.push({
      hourKey:      m[1]!,
      region,
      subdomain,
      dataAccess:   has('data-access')       ? parseInt(m[2]!, 10) : 0,
      security:     has('security-events')   ? parseInt(m[3]!, 10) : 0,
      config:       has('configuration')     ? parseInt(m[4]!, 10) : 0,
      modification: has('data-modification') ? parseInt(m[5]!, 10) : 0,
      other:        has('other')             ? (m[6] ? parseInt(m[6], 10) : 0) : 0,
    });
  }
  stats.sort((a, b) => a.hourKey.localeCompare(b.hourKey));
  return stats;
}

// ─── Records (paginated, for subaccount modal) ────────────────────────────────

export interface AuditRecordPage {
  records: AuditRecord[];
  total:   number;
  page:    number;
  pages:   number;
}

export async function getAuditRecords(
  region:   string,
  subdomain: string,
  opts: {
    from?:       string;
    to?:         string;
    keyword?:    string;
    limit?:      number;
    page?:       number;
    categories?: Set<string>;
  },
): Promise<AuditRecordPage> {
  const limit   = Math.min(opts.limit ?? 100, 1000);
  const pageNum = Math.max(opts.page  ?? 1, 1);
  const dir     = getAuditLogDir(region, subdomain);

  let files: string[];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort().reverse(); } // newest first
  catch { return { records: [], total: 0, page: 1, pages: 0 }; }

  // File-level time range filter
  if (opts.from || opts.to) {
    const fromKey = opts.from ? parseHourKey(opts.from) : '';
    const toKey   = opts.to   ? parseHourKey(opts.to)   : '9999';
    files = files.filter(f => {
      const m = AUDIT_FILENAME_RE.exec(f);
      if (!m) return false;
      const k = m[1]!;
      return (!fromKey || k >= fromKey) && k <= toKey;
    });
  }

  const keywords = parseKeywords(opts.keyword);

  // ── Keyword path: fall back to full scan (keyword match count per file is unknown) ──
  if (keywords.length > 0) {
    const matchSet = await grepFiles(dir, keywords);
    const candidateFiles = files.filter(f => matchSet.has(join(dir, f)));
    const lines = await grepLines(candidateFiles.map(f => join(dir, f)), keywords);
    const all: AuditRecord[] = [];
    for (const line of lines) {
      try { all.push(JSON.parse(line) as AuditRecord); } catch { /* skip */ }
    }
    const filtered = opts.categories
      ? all.filter(r => opts.categories!.has(normalizeCat(r.category)))
      : all;
    filtered.sort((a, b) => b.time.localeCompare(a.time));
    const total = filtered.length;
    const pages = Math.ceil(total / limit);
    const slice = filtered.slice((pageNum - 1) * limit, pageNum * limit);
    return { records: slice, total, page: pageNum, pages };
  }

  // ── Fast path: filename-count-based pagination (no file reads to compute total) ──
  const cats = opts.categories;

  interface FileMeta { f: string; count: number }
  const fileMeta: FileMeta[] = files.map(f => {
    const m = AUDIT_FILENAME_RE.exec(f);
    if (!m) return { f, count: 0 };
    const da    = parseInt(m[2]!, 10);
    const se    = parseInt(m[3]!, 10);
    const cfg   = parseInt(m[4]!, 10);
    const dm    = parseInt(m[5]!, 10);
    const other = m[6] ? parseInt(m[6], 10) : 0;
    let count = 0;
    if (!cats || cats.has('data-access'))       count += da;
    if (!cats || cats.has('security-events'))   count += se;
    if (!cats || cats.has('configuration'))     count += cfg;
    if (!cats || cats.has('data-modification')) count += dm;
    if (!cats || cats.has('other'))             count += other;
    return { f, count };
  });

  const total = fileMeta.reduce((s, x) => s + x.count, 0);
  const pages = total > 0 ? Math.ceil(total / limit) : 0;

  if (total === 0) return { records: [], total: 0, page: pageNum, pages: 0 };

  // Find the file and in-file offset where the requested page starts
  const targetOffset = (pageNum - 1) * limit;
  let startFileIdx   = fileMeta.length;
  let startRecordSkip = 0;
  let cumCount = 0;
  for (let i = 0; i < fileMeta.length; i++) {
    const c = fileMeta[i]!.count;
    if (cumCount + c > targetOffset) {
      startFileIdx    = i;
      startRecordSkip = targetOffset - cumCount;
      break;
    }
    cumCount += c;
  }

  // Read only the files needed to fill one page
  const records: AuditRecord[] = [];
  for (let i = startFileIdx; i < fileMeta.length && records.length < limit; i++) {
    try {
      const raw  = await readFile(join(dir, fileMeta[i]!.f), 'utf-8');
      let recs   = parseAuditFile(raw);
      if (cats) recs = recs.filter(r => cats.has(normalizeCat(r.category)));
      recs.sort((a, b) => b.time.localeCompare(a.time)); // newest first within file
      if (i === startFileIdx) recs = recs.slice(startRecordSkip);
      records.push(...recs.slice(0, limit - records.length));
    } catch { /* skip unreadable */ }
  }

  return { records, total, page: pageNum, pages };
}

// ─── Latest entries per subaccount (for AuditLogPage table) ──────────────────

export interface SubaccountLatestAudit {
  region:    string;
  subdomain: string;
  alias:     string;
  entries:   AuditRecord[];
}

export async function getLatestAuditEntries(durationDays: number, keyword?: string, from?: string, to?: string, categories?: Set<string>): Promise<SubaccountLatestAudit[]> {
  const cutoff    = new Date(Date.now() - durationDays * 24 * 60 * 60 * 1000);
  const cutoffKey = parseHourKey(cutoff.toISOString());
  const fromKey   = from ? (parseHourKey(from) || cutoffKey) : cutoffKey;
  const toKey     = to   ? (parseHourKey(to)   || '9999')    : '9999';

  const allSas  = await readSubaccounts();
  const targets = allSas.filter(sa => sa.viewAuditLogs);
  const result:  SubaccountLatestAudit[] = [];

  for (const sa of targets) {
    const dir = getAuditLogDir(sa.region, sa.subdomain);
    let files: string[];
    try { files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort().reverse(); }
    catch { continue; }

    const keywords = parseKeywords(keyword);
    const inRange   = files.filter(f => { const m = AUDIT_FILENAME_RE.exec(f); return m !== null && m[1]! >= fromKey && m[1]! <= toKey; });

    // Narrow to time-range files first (filename-based, instant), then grep only
    // those files for keywords — avoids scanning the entire directory.
    let candidateFiles = inRange;
    if (keywords.length > 0 && inRange.length > 0) {
      const inRangePaths = inRange.map(f => join(dir, f));
      const matchSet = await grepFileList(inRangePaths, keywords);
      candidateFiles = inRange.filter(f => matchSet.has(join(dir, f)));
    }

    const entries: AuditRecord[] = [];
    for (const f of candidateFiles) {
      if (entries.length >= 10) break;
      try {
        const raw  = await readFile(join(dir, f), 'utf-8');
        const recs = parseAuditFile(raw).reverse(); // newest first within the hour file
        for (const r of recs) {
          if (entries.length >= 10) break;
          if (categories && !categories.has(normalizeCat(r.category))) continue;
          if (keywords.length > 0) {
            const s = JSON.stringify(r).toLowerCase();
            if (!keywords.every(kw => s.includes(kw.toLowerCase()))) continue;
          }
          entries.push(r);
        }
      } catch { /* skip */ }
    }

    if (entries.length > 0) {
      result.push({ region: sa.region, subdomain: sa.subdomain, alias: sa.alias || sa.subaccountName, entries });
    }
  }

  return result;
}

// ─── Prune helpers ────────────────────────────────────────────────────────────

// Delete the audit log directories for specific subaccounts (e.g. viewAuditLogs disabled).
export async function pruneAuditLogDirs(
  sas:  Array<{ region: string; subdomain: string }>,
  user = 'system',
): Promise<number> {
  let deleted = 0;
  for (const sa of sas) {
    const dir = getAuditLogDir(sa.region, sa.subdomain);
    try {
      await rm(dir, { recursive: true, force: true });
      deleted++;
      logger.info({ region: sa.region, subdomain: sa.subdomain, user }, 'audit-log: local store deleted — viewAuditLogs disabled by user');
    } catch (err) {
      logger.warn({ region: sa.region, subdomain: sa.subdomain, user, err }, 'audit-log: failed to delete local store');
    }
  }
  return deleted;
}

// Scan all audit-log/ subdirectories and delete those whose subaccount no longer has
// viewAuditLogs=true. Called after a sync that wrote conf/subaccounts.json.
export async function pruneObsoleteAuditLogDirs(): Promise<number> {
  const allSas  = await readSubaccounts();
  const keepSet = new Set(allSas.filter(s => s.viewAuditLogs).map(s => `${s.region}/${s.subdomain}`));
  const base    = join(config.LOCAL_STORE_DIR, 'audit-log');
  let deleted   = 0;
  let regions: string[];
  try { regions = await readdir(base); } catch { return 0; }
  for (const region of regions) {
    let subdomains: string[];
    try { subdomains = await readdir(join(base, region)); } catch { continue; }
    for (const subdomain of subdomains) {
      if (keepSet.has(`${region}/${subdomain}`)) continue;
      try {
        await rm(join(base, region, subdomain), { recursive: true, force: true });
        deleted++;
        logger.info({ region, subdomain }, 'audit-log: pruned obsolete local store after sync');
      } catch { /* ignore */ }
    }
  }
  return deleted;
}
