import { mkdir, writeFile, readdir, readFile, rename, stat, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { getCity } from './geoService.js';
import { logger } from '../logger.js';
import type { ResponseRecord, HistoryFile } from '../types/index.js';

export interface BrowseFile {
  name: string;
  /** File last-modified time in Unix milliseconds. */
  mtime: number;
}

/** UTC timestamp string: yyyyMMdd-HHmmss */
function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/**
 * Formats a Unix-ms timestamp as a yyyyMMdd-HHmmss UTC string.
 * Used for the browseT response field and ?since= URL parameter.
 */
export function formatBrowseT(ms: number): string {
  return formatTimestamp(new Date(ms));
}

/**
 * Parses a yyyyMMdd-HHmmss UTC string (browseT format) to Unix milliseconds.
 * Returns 0 if the string is not in the expected format.
 */
export function parseBrowseT(s: string): number {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Replace non-alphanumeric runs with a single dash; trim leading/trailing dashes. */
function sanitizeEndpointName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
}

/** Resolve the `resp/{service}` directory under LOCAL_STORE_DIR. */
function respDir(serviceName: string): string {
  return join(config.LOCAL_STORE_DIR, 'resp', sanitizeName(serviceName));
}

export async function saveResponse(
  serviceName: string,
  record: ResponseRecord,
  screenshot?: Buffer,
  consoleLogs?: string[],
  htmlContent?: string,
  isRetry = false,
): Promise<string> {
  const dir = respDir(serviceName);
  await mkdir(dir, { recursive: true });

  const ts = formatTimestamp(new Date());
  const epSlug = sanitizeEndpointName(record.endpointName);
  const city = record.city ?? getCity();
  const base = `${ts}_${epSlug}_${city}_${record.responseTime}_${record.overallStatus}`;
  const retrySuffix = isRetry ? '.retry' : '';

  let finalRecord = record;
  if (screenshot && screenshot.length > 0) {
    const pngFilename = `${base}${retrySuffix}.screenshot.png`;
    await writeFile(join(dir, pngFilename), screenshot);
    finalRecord = { ...finalRecord, screenshotFile: pngFilename };
  }
  if (consoleLogs && consoleLogs.length > 0) {
    const logFilename = `${base}${retrySuffix}.console.log`;
    await writeFile(join(dir, logFilename), consoleLogs.join('\n'), 'utf-8');
    finalRecord = { ...finalRecord, consoleLogFile: logFilename };
  }
  if (htmlContent && htmlContent.length > 0) {
    const htmlFilename = `${base}${retrySuffix}.content.html`;
    await writeFile(join(dir, htmlFilename), htmlContent, 'utf-8');
    finalRecord = { ...finalRecord, contentFile: htmlFilename };
  }

  const filename = `${base}${retrySuffix}.json`;
  await writeFile(join(dir, filename), JSON.stringify(finalRecord, null, 2), 'utf-8');
  return filename;
}

export async function listResponseFiles(
  serviceName: string,
  range: { hours: number } | { fromMs: number; untilMs: number } | { tag: 'starred' } | { since: number },
): Promise<HistoryFile[]> {
  const dir = respDir(serviceName);
  try {
    const files = await readdir(dir);
    const fileSet = new Set(files);

    // mtime-based delta: stat every JSON concurrently and return those modified since the timestamp
    if ('since' in range) {
      const { since } = range;
      const hits = await Promise.all(
        files.map(async (f): Promise<HistoryFile | null> => {
          if (!f.endsWith('.json') || f.endsWith('.retry.json')) return null;
          const meta = parseFilename(f);
          if (!meta) return null;
          try {
            const info = await stat(join(dir, f));
            if (info.mtimeMs < since) return null;
            const pngNew = f.replace(/\.json$/, '.screenshot.png');
            const pngOld = f.replace(/\.json$/, '.png');
            const pngFile = fileSet.has(pngNew) ? pngNew : fileSet.has(pngOld) ? pngOld : null;
            return pngFile ? { ...meta, screenshotFile: pngFile } : meta;
          } catch { return null; }
        }),
      );
      return (hits.filter((f): f is HistoryFile => f !== null))
        .sort((a, b) => b.timestamp - a.timestamp);
    }

    const starredOnly = 'tag' in range;
    let fromMs: number;
    let untilMs: number;
    if (starredOnly) {
      fromMs = 0; untilMs = Infinity;
    } else if ('hours' in range) {
      fromMs = Date.now() - range.hours * 3_600_000; untilMs = Infinity;
    } else {
      fromMs = range.fromMs; untilMs = range.untilMs;
    }
    const results: HistoryFile[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (f.endsWith('.retry.json')) continue;
      if (starredOnly && !f.includes('.starred.')) continue;
      const meta = parseFilename(f);
      if (meta && meta.timestamp >= fromMs && meta.timestamp <= untilMs) {
        const pngNew = f.replace(/\.json$/, '.screenshot.png');
        const pngOld = f.replace(/\.json$/, '.png');
        const pngFile = fileSet.has(pngNew) ? pngNew : fileSet.has(pngOld) ? pngOld : null;
        results.push(pngFile ? { ...meta, screenshotFile: pngFile } : meta);
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export async function readResponseFile(
  serviceName: string,
  filename: string,
): Promise<ResponseRecord> {
  if (!/^[\w-]+(?:\.starred)?(?:\.retry)?\.json$/.test(filename)) throw new Error('Invalid filename');
  const filepath = join(respDir(serviceName), filename);
  const raw = await readFile(filepath, 'utf-8');
  return JSON.parse(raw) as ResponseRecord;
}

export async function readScreenshotFile(
  serviceName: string,
  filename: string,
): Promise<Buffer> {
  if (!/^[\w-]+(?:\.starred)?(?:\.retry)?(?:\.screenshot)?\.png$/.test(filename)) throw new Error('Invalid filename');
  return readFile(join(respDir(serviceName), filename));
}

export async function readConsoleLogFile(
  serviceName: string,
  filename: string,
): Promise<Buffer> {
  if (!/^[\w-]+(?:(?:\.starred)?(?:\.retry)?\.console\.log|_console(?:\.retry)?\.log)$/.test(filename)) throw new Error('Invalid filename');
  return readFile(join(respDir(serviceName), filename));
}

export async function readContentFile(
  serviceName: string,
  filename: string,
): Promise<Buffer> {
  if (!/^[\w-]+(?:(?:\.starred)?(?:\.retry)?\.content\.html|_content(?:\.retry)?\.html)$/.test(filename)) throw new Error('Invalid filename');
  return readFile(join(respDir(serviceName), filename));
}

export function parseFilename(filename: string): HistoryFile | null {
  // New format (v0.5.0+): yyyyMMdd-HHmmss_{slug}_{city}_{ms}_{status}[.starred][.retry].json  (UTC timestamp)
  const newM = filename.match(
    /^(\d{8}-\d{6})_([a-zA-Z0-9-]+)_([a-zA-Z0-9-]+)_(\d+)_(200|203|400|500|503|504)(?:\.starred)?(?:\.retry)?\.json$/,
  );
  if (newM) {
    const [, dateStr, slug, city, msStr, statusStr] = newM;
    const result: HistoryFile = {
      filename,
      timestamp: parseFileDateUTC(dateStr),
      endpointIndex: -1,
      endpointSlug: slug,
      city,
      responseTime: parseInt(msStr, 10),
      httpStatus: 0,
      overallStatus: parseInt(statusStr, 10) as 200 | 203 | 400 | 500 | 503 | 504,
    };
    if (filename.includes('.starred.')) result.starred = true;
    return result;
  }

  // Old format (pre-v0.5.0): yyyyMMdd-HHmmss_{idx}_{ms}ms_{status}.json  (local timestamp)
  const oldM = filename.match(
    /^(\d{8}-\d{6})_(\d+)_(\d+)ms_(200|203|400|500|503|504)\.json$/,
  );
  if (oldM) {
    const [, dateStr, idxStr, msStr, statusStr] = oldM;
    return {
      filename,
      timestamp: parseFileDateLocal(dateStr),
      endpointIndex: parseInt(idxStr, 10),
      responseTime: parseInt(msStr, 10),
      httpStatus: 0,
      overallStatus: parseInt(statusStr, 10) as 200 | 203 | 400 | 500 | 503 | 504,
    };
  }

  return null;
}

/** Parse a yyyyMMdd-HHmmss string as UTC milliseconds. */
function parseFileDateUTC(s: string): number {
  return Date.UTC(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15),
  );
}

/** Parse a yyyyMMdd-HHmmss string as local-timezone milliseconds (legacy files). */
function parseFileDateLocal(s: string): number {
  return new Date(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15),
  ).getTime();
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '_');
}

/** Extract the UTC timestamp from a response filename prefix (yyyyMMdd-HHmmss_). Returns 0 if unparseable. */
export function filenameTimestamp(filename: string): number {
  const m = filename.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * Lists all local files for sync. Service files live in `resp/{folder}/`; conf files in `conf/`;
 * dest files in `dest/{region}/{subdomain}/`; root-level files live directly in LOCAL_STORE_DIR.
 * Returns `{ [folder]: BrowseFile[] }` where folder `""` holds root files.
 * When `since` is provided, only files whose mtime >= since are returned.
 */
export async function browseResponseFiles(since?: number): Promise<Record<string, BrowseFile[]>> {
  const result: Record<string, BrowseFile[]> = {};
  const storeDir = config.LOCAL_STORE_DIR;

  try {
    // Root-level files directly in LOCAL_STORE_DIR
    const rootEntries = await readdir(storeDir, { withFileTypes: true });
    const rootFiles: BrowseFile[] = [];
    for (const e of rootEntries) {
      if (!e.isFile()) continue;
      try {
        const info = await stat(join(storeDir, e.name));
        const rawMtime = info.mtimeMs;
        if (!since || since <= 0 || rawMtime >= since) {
          rootFiles.push({ name: e.name, mtime: rawMtime });
        }
      } catch { /* skip */ }
    }
    if (rootFiles.length > 0) {
      rootFiles.sort((a, b) => a.name.localeCompare(b.name));
      result[''] = rootFiles;
    }
  } catch {
    // LOCAL_STORE_DIR doesn't exist yet
  }

  try {
    // conf/ directory — flat; files synced to consumers alongside root and resp/ files
    const configDir = join(storeDir, 'conf');
    const configEntries = await readdir(configDir, { withFileTypes: true });
    const configFiles: BrowseFile[] = [];
    for (const e of configEntries) {
      if (!e.isFile()) continue;
      try {
        const info = await stat(join(configDir, e.name));
        const rawMtime = info.mtimeMs;
        if (!since || since <= 0 || rawMtime >= since) {
          configFiles.push({ name: e.name, mtime: rawMtime });
        }
      } catch { /* skip */ }
    }
    if (configFiles.length > 0) {
      configFiles.sort((a, b) => a.name.localeCompare(b.name));
      result['conf'] = configFiles;
    }
  } catch {
    // conf/ doesn't exist yet
  }

  try {
    // dest/{region}/{subdomain}/ — returned as folder keys "dest/{region}/{subdomain}"
    // Also includes root-level .md files (changelog, archives) under folder key "dest"
    const destBase = join(storeDir, 'dest');
    const destRegions = await readdir(destBase, { withFileTypes: true });

    // Root-level .md files in dest/ (changelog.md, changelog.*.md)
    const destRootFiles: BrowseFile[] = [];
    for (const e of destRegions) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      try {
        const info = await stat(join(destBase, e.name));
        if (!since || since <= 0 || info.mtimeMs >= since) {
          destRootFiles.push({ name: e.name, mtime: info.mtimeMs });
        }
      } catch { /* skip */ }
    }
    if (destRootFiles.length > 0) {
      destRootFiles.sort((a, b) => a.name.localeCompare(b.name));
      result['dest'] = destRootFiles;
    }

    await Promise.all(
      destRegions.filter(e => e.isDirectory()).map(async (regionEntry) => {
        try {
          const regionPath = join(destBase, regionEntry.name);
          const subEntries = await readdir(regionPath, { withFileTypes: true });
          await Promise.all(
            subEntries.filter(e => e.isDirectory()).map(async (subEntry) => {
              const folderKey = `dest/${regionEntry.name}/${subEntry.name}`;
              try {
                const subPath = join(regionPath, subEntry.name);
                const files = await readdir(subPath);
                const withMtime = await Promise.all(
                  files.map(async (name) => {
                    try {
                      const info = await stat(join(subPath, name));
                      return { name, rawMtime: info.mtimeMs };
                    } catch { return { name, rawMtime: 0 }; }
                  }),
                );
                result[folderKey] = withMtime
                  .filter(f => !since || since <= 0 || f.rawMtime === 0 || f.rawMtime >= since)
                  .map(({ name, rawMtime }) => ({ name, mtime: rawMtime === 0 ? 0 : rawMtime }));
                result[folderKey].sort((a, b) => a.name.localeCompare(b.name));
              } catch { result[folderKey] = []; }
            }),
          );
        } catch { /* region dir unreadable */ }
      }),
    );
  } catch {
    // dest/ doesn't exist yet
  }

  try {
    // rcs/{region}/{subdomain}/ — returned as folder keys "rcs/{region}/{subdomain}"
    // Also includes root-level .md files (changelog, archives) under folder key "rcs"
    const rcsBase = join(storeDir, 'rcs');
    const rcsRegions = await readdir(rcsBase, { withFileTypes: true });

    // Root-level .md files in rcs/ (changelog.md, changelog.*.md)
    const rcsRootFiles: BrowseFile[] = [];
    for (const e of rcsRegions) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      try {
        const info = await stat(join(rcsBase, e.name));
        if (!since || since <= 0 || info.mtimeMs >= since) {
          rcsRootFiles.push({ name: e.name, mtime: info.mtimeMs });
        }
      } catch { /* skip */ }
    }
    if (rcsRootFiles.length > 0) {
      rcsRootFiles.sort((a, b) => a.name.localeCompare(b.name));
      result['rcs'] = rcsRootFiles;
    }

    await Promise.all(
      rcsRegions.filter(e => e.isDirectory()).map(async (regionEntry) => {
        try {
          const regionPath = join(rcsBase, regionEntry.name);
          const subEntries = await readdir(regionPath, { withFileTypes: true });
          await Promise.all(
            subEntries.filter(e => e.isDirectory()).map(async (subEntry) => {
              const folderKey = `rcs/${regionEntry.name}/${subEntry.name}`;
              try {
                const subPath = join(regionPath, subEntry.name);
                const files = await readdir(subPath);
                const withMtime = await Promise.all(
                  files.map(async (name) => {
                    try {
                      const info = await stat(join(subPath, name));
                      return { name, rawMtime: info.mtimeMs };
                    } catch { return { name, rawMtime: 0 }; }
                  }),
                );
                result[folderKey] = withMtime
                  .filter(f => !since || since <= 0 || f.rawMtime === 0 || f.rawMtime >= since)
                  .map(({ name, rawMtime }) => ({ name, mtime: rawMtime === 0 ? 0 : rawMtime }));
                result[folderKey].sort((a, b) => a.name.localeCompare(b.name));
              } catch { result[folderKey] = []; }
            }),
          );
        } catch { /* region dir unreadable */ }
      }),
    );
  } catch {
    // rcs/ doesn't exist yet
  }

  try {
    // users/{region}/{subdomain}/ — returned as folder keys "users/{region}/{subdomain}"
    // Also includes root-level .md files (changelog, archives) under folder key "users"
    const usersBase = join(storeDir, 'users');
    const usersRegions = await readdir(usersBase, { withFileTypes: true });

    const usersRootFiles: BrowseFile[] = [];
    for (const e of usersRegions) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      try {
        const info = await stat(join(usersBase, e.name));
        if (!since || since <= 0 || info.mtimeMs >= since) {
          usersRootFiles.push({ name: e.name, mtime: info.mtimeMs });
        }
      } catch { /* skip */ }
    }
    if (usersRootFiles.length > 0) {
      usersRootFiles.sort((a, b) => a.name.localeCompare(b.name));
      result['users'] = usersRootFiles;
    }

    await Promise.all(
      usersRegions.filter(e => e.isDirectory()).map(async (regionEntry) => {
        try {
          const regionPath = join(usersBase, regionEntry.name);
          const subEntries = await readdir(regionPath, { withFileTypes: true });
          await Promise.all(
            subEntries.filter(e => e.isDirectory()).map(async (subEntry) => {
              const folderKey = `users/${regionEntry.name}/${subEntry.name}`;
              try {
                const subPath = join(regionPath, subEntry.name);
                const originEntries = await readdir(subPath, { withFileTypes: true });
                // Each origin is a subdirectory; list files within as "{origin}/{file}"
                const collected: { name: string; rawMtime: number }[] = [];
                await Promise.all(
                  originEntries.filter(e => e.isDirectory()).map(async (originEntry) => {
                    const originPath = join(subPath, originEntry.name);
                    try {
                      const originFiles = await readdir(originPath);
                      await Promise.all(originFiles.map(async (fname) => {
                        try {
                          const info = await stat(join(originPath, fname));
                          collected.push({ name: `${originEntry.name}/${fname}`, rawMtime: info.mtimeMs });
                        } catch { collected.push({ name: `${originEntry.name}/${fname}`, rawMtime: 0 }); }
                      }));
                    } catch { /* origin dir unreadable */ }
                  }),
                );
                result[folderKey] = collected
                  .filter(f => !since || since <= 0 || f.rawMtime === 0 || f.rawMtime >= since)
                  .map(({ name, rawMtime }) => ({ name, mtime: rawMtime === 0 ? 0 : rawMtime }));
                result[folderKey].sort((a, b) => a.name.localeCompare(b.name));
              } catch { result[folderKey] = []; }
            }),
          );
        } catch { /* region dir unreadable */ }
      }),
    );
  } catch {
    // users/ doesn't exist yet
  }

  try {
    // Service response files under resp/{service}/
    const respBase = join(storeDir, 'resp');
    const entries = await readdir(respBase, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(e => e.isDirectory())
        .map(async (dirEntry) => {
          try {
            const names = await readdir(join(respBase, dirEntry.name));
            const withRawMtime = await Promise.all(
              names.map(async (name) => {
                try {
                  const info = await stat(join(respBase, dirEntry.name, name));
                  return { name, rawMtime: info.mtimeMs };
                } catch {
                  return { name, rawMtime: 0 };
                }
              }),
            );
            result[dirEntry.name] = withRawMtime
              .filter(f => !since || since <= 0 || f.rawMtime === 0 || f.rawMtime >= since)
              .map(({ name, rawMtime }) => ({
                name,
                mtime: rawMtime === 0 ? 0 : rawMtime,
              }));
            result[dirEntry.name].sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            result[dirEntry.name] = [];
          }
        }),
    );
  } catch {
    // resp/ subdirectory doesn't exist yet
  }

  return result;
}

/** Read a root-level file directly from LOCAL_STORE_DIR. */
export async function readRootFile(filename: string): Promise<Buffer> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(json|md)$/.test(filename)) {
    throw new Error('Invalid root filename');
  }
  return readFile(join(config.LOCAL_STORE_DIR, filename));
}

/** Read a file from LOCAL_STORE_DIR/conf/ (json or md). */
export async function readConfigFile(filename: string): Promise<Buffer> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(json|md)$/.test(filename)) {
    throw new Error('Invalid conf filename');
  }
  return readFile(join(config.LOCAL_STORE_DIR, 'conf', filename));
}

/** Read a file from LOCAL_STORE_DIR/dest/{relPath} (e.g. us10/subdomain/name.json). */
export async function readDestFile(relPath: string): Promise<Buffer> {
  const parts = relPath.split('/');
  if (parts.length === 0 || parts.some(p => p === '..' || p === '.' || p === '')) {
    throw new Error('Invalid dest path');
  }
  return readFile(join(config.LOCAL_STORE_DIR, 'dest', relPath));
}

/** Read a file from LOCAL_STORE_DIR/rcs/{relPath} (e.g. us10/subdomain/name.json or changelog.md). */
export async function readRcsFile(relPath: string): Promise<Buffer> {
  const parts = relPath.split('/');
  if (parts.length === 0 || parts.some(p => p === '..' || p === '.' || p === '')) {
    throw new Error('Invalid rcs path');
  }
  return readFile(join(config.LOCAL_STORE_DIR, 'rcs', relPath));
}

/** Read a file from LOCAL_STORE_DIR/users/{relPath} (e.g. us10/subdomain/uuid.json or changelog.md). */
export async function readUsersFile(relPath: string): Promise<Buffer> {
  const parts = relPath.split('/');
  if (parts.length === 0 || parts.some(p => p === '..' || p === '.' || p === '')) {
    throw new Error('Invalid users path');
  }
  return readFile(join(config.LOCAL_STORE_DIR, 'users', relPath));
}

/**
 * After a batch download, finds local starred/unstarred duplicate pairs and deletes
 * the one with the older mtime. Resolves star/unstar operations from the producer.
 */
export async function resolveSyncDuplicates(
  folder: string,
  downloadedFilenames: string[],
): Promise<void> {
  if (downloadedFilenames.length === 0) return;

  let minTs = Infinity;
  for (const f of downloadedFilenames) {
    const ts = filenameTimestamp(f);
    if (ts > 0 && ts < minTs) minTs = ts;
  }
  if (!isFinite(minTs)) return;

  const dir = join(config.LOCAL_STORE_DIR, 'resp', folder);
  let allFiles: string[];
  try {
    allFiles = await readdir(dir);
  } catch {
    return;
  }

  const candidates = allFiles.filter(f => {
    if (!f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.log') && !f.endsWith('.html')) return false;
    const ts = filenameTimestamp(f);
    return ts > 0 && ts >= minTs;
  });
  if (candidates.length === 0) return;

  const mtimes = new Map<string, number>();
  await Promise.all(candidates.map(async (f) => {
    try {
      const info = await stat(join(dir, f));
      mtimes.set(f, info.mtimeMs);
    } catch { /* file may have been deleted */ }
  }));

  const processed = new Set<string>();
  for (const f of candidates) {
    if (processed.has(f) || !mtimes.has(f) || !f.includes('.starred.')) continue;
    const canonical = f.replace('.starred.', '.');
    if (!mtimes.has(canonical)) continue;
    processed.add(f);
    processed.add(canonical);
    const toDelete = mtimes.get(f)! >= mtimes.get(canonical)! ? canonical : f;
    try {
      await unlink(join(dir, toDelete));
      logger.info({ folder, deleted: toDelete }, 'Removed stale duplicate (star/unstar resolved by mtime)');
    } catch { /* already gone */ }
  }
}

/**
 * Stars or unstars a response file (and all its sidecar / retry files).
 */
export async function starResponseFile(
  serviceName: string,
  filename: string,
  star: boolean,
): Promise<void> {
  if (
    !/^\d{8}-\d{6}_[a-zA-Z0-9-]+_[a-zA-Z0-9-]+_\d+_(200|203|400|500|503|504)(?:\.starred)?\.json$/.test(filename)
  ) {
    throw new Error('Invalid filename');
  }

  const isAlreadyStarred = filename.includes('.starred.json');
  if (star === isAlreadyStarred) return;

  const dir = respDir(serviceName);
  const filePath = join(dir, filename);

  const raw = await readFile(filePath, 'utf-8');
  const record = JSON.parse(raw) as ResponseRecord;

  function transform(name: string): string {
    if (star) {
      const firstDot = name.indexOf('.');
      return firstDot === -1 ? name : name.slice(0, firstDot) + '.starred' + name.slice(firstDot);
    }
    return name.replace('.starred.', '.');
  }

  const now = new Date();
  async function renameTouchNow(oldName: string, newName: string): Promise<void> {
    const newPath = join(dir, newName);
    try {
      await rename(join(dir, oldName), newPath);
      await utimes(newPath, now, now);
    } catch { /* may not exist */ }
  }

  const updates = { ...record };

  if (record.screenshotFile) {
    const n = transform(record.screenshotFile);
    await renameTouchNow(record.screenshotFile, n);
    updates.screenshotFile = n;
  }
  if (record.consoleLogFile) {
    const n = transform(record.consoleLogFile);
    await renameTouchNow(record.consoleLogFile, n);
    updates.consoleLogFile = n;
  }
  if (record.contentFile) {
    const n = transform(record.contentFile);
    await renameTouchNow(record.contentFile, n);
    updates.contentFile = n;
  }

  if (record.retryFiles && record.retryFiles.length > 0) {
    const newRetryFiles: string[] = [];
    for (const retryFile of record.retryFiles) {
      const retryPath = join(dir, retryFile);
      try {
        const retryRaw = await readFile(retryPath, 'utf-8');
        const retryRecord = JSON.parse(retryRaw) as ResponseRecord;
        const retryUpdates = { ...retryRecord };
        if (retryRecord.screenshotFile) {
          const n = transform(retryRecord.screenshotFile);
          await renameTouchNow(retryRecord.screenshotFile, n);
          retryUpdates.screenshotFile = n;
        }
        if (retryRecord.consoleLogFile) {
          const n = transform(retryRecord.consoleLogFile);
          await renameTouchNow(retryRecord.consoleLogFile, n);
          retryUpdates.consoleLogFile = n;
        }
        if (retryRecord.contentFile) {
          const n = transform(retryRecord.contentFile);
          await renameTouchNow(retryRecord.contentFile, n);
          retryUpdates.contentFile = n;
        }
        const newRetryFilename = transform(retryFile);
        await writeFile(retryPath, JSON.stringify(retryUpdates, null, 2), 'utf-8');
        await rename(retryPath, join(dir, newRetryFilename));
        await utimes(join(dir, newRetryFilename), now, now);
        newRetryFiles.push(newRetryFilename);
      } catch {
        const newRetryFilename = transform(retryFile);
        await renameTouchNow(retryFile, newRetryFilename);
        newRetryFiles.push(newRetryFilename);
      }
    }
    updates.retryFiles = newRetryFiles;
  }

  const newFilename = transform(filename);
  await writeFile(filePath, JSON.stringify(updates, null, 2), 'utf-8');
  const newFilePath = join(dir, newFilename);
  await rename(filePath, newFilePath);
  await utimes(newFilePath, now, now);
}

export async function readRawResponseFile(folder: string, filename: string): Promise<Buffer> {
  const filepath = join(config.LOCAL_STORE_DIR, 'resp', sanitizeName(folder), filename);
  return readFile(filepath);
}

export async function responseFileSize(folder: string, filename: string): Promise<number> {
  try {
    const info = await stat(join(config.LOCAL_STORE_DIR, 'resp', sanitizeName(folder), filename));
    return info.size;
  } catch {
    return 0;
  }
}
