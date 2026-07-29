import { mkdir, writeFile, readdir, readFile, rename, stat, utimes, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config.js';
import { getCity } from '../geoService.js';
import { logger } from '../../logger.js';
import type { ResponseRecord, HistoryFile } from '../../types/index.js';

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

/** Replace non-alphanumeric runs with a single dash; trim leading/trailing dashes. */
function sanitizeEndpointName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
}

export async function saveResponse(
  serviceName: string,
  record: ResponseRecord,
  screenshot?: Buffer,
  consoleLogs?: string[],
  htmlContent?: string,
  isRetry = false,
): Promise<string> {
  const dir = join(config.RESPONSE_DIR, sanitizeName(serviceName));
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
  const dir = join(config.RESPONSE_DIR, sanitizeName(serviceName));
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
      if (f.endsWith('.retry.json')) continue;  // exclude retry files from history
      if (starredOnly && !f.includes('.starred.')) continue;
      const meta = parseFilename(f);
      if (meta && meta.timestamp >= fromMs && meta.timestamp <= untilMs) {
        // Support both old (*.png) and new (*.screenshot.png) screenshot naming
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
  const filepath = join(config.RESPONSE_DIR, sanitizeName(serviceName), filename);
  const raw = await readFile(filepath, 'utf-8');
  return JSON.parse(raw) as ResponseRecord;
}

export async function readScreenshotFile(
  serviceName: string,
  filename: string,
): Promise<Buffer> {
  // Accept new (*.screenshot.png / *.retry.screenshot.png / *.starred.screenshot.png) and legacy naming
  if (!/^[\w-]+(?:\.starred)?(?:\.retry)?(?:\.screenshot)?\.png$/.test(filename)) throw new Error('Invalid filename');
  const filepath = join(config.RESPONSE_DIR, sanitizeName(serviceName), filename);
  return readFile(filepath);
}

export async function readConsoleLogFile(
  serviceName: string,
  filename: string,
): Promise<Buffer> {
  // Accept new (*[.starred][.retry].console.log) and legacy (*_console[.retry].log) naming
  if (!/^[\w-]+(?:(?:\.starred)?(?:\.retry)?\.console\.log|_console(?:\.retry)?\.log)$/.test(filename)) throw new Error('Invalid filename');
  const filepath = join(config.RESPONSE_DIR, sanitizeName(serviceName), filename);
  return readFile(filepath);
}

export async function readContentFile(
  serviceName: string,
  filename: string,
): Promise<Buffer> {
  // Accept new (*[.starred][.retry].content.html) and legacy (*_content[.retry].html) naming
  if (!/^[\w-]+(?:(?:\.starred)?(?:\.retry)?\.content\.html|_content(?:\.retry)?\.html)$/.test(filename)) throw new Error('Invalid filename');
  const filepath = join(config.RESPONSE_DIR, sanitizeName(serviceName), filename);
  return readFile(filepath);
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
 * Lists all response files in all service folders, with their last-modified timestamps.
 * When `since` is provided, only files whose mtime >= since are returned (mtime-based,
 * so starred/unstarred renames appear in the next delta browse).
 */
export async function browseResponseFiles(since?: number): Promise<Record<string, BrowseFile[]>> {
  const result: Record<string, BrowseFile[]> = {};
  try {
    const entries = await readdir(config.RESPONSE_DIR, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(e => e.isDirectory())
        .map(async (dirEntry) => {
          try {
            const names = await readdir(join(config.RESPONSE_DIR, dirEntry.name));
            const filtered = names.filter(f =>
              f.endsWith('.json') || f.endsWith('.png') ||
              f.endsWith('.log') || f.endsWith('.html'),
            );
            const withMtime = await Promise.all(
              filtered.map(async (name) => {
                try {
                  const info = await stat(join(config.RESPONSE_DIR, dirEntry.name, name));
                  return { name, mtime: info.mtimeMs };
                } catch {
                  return { name, mtime: 0 };
                }
              }),
            );
            result[dirEntry.name] = since && since > 0
              ? withMtime.filter(f => f.mtime === 0 || f.mtime >= since)
              : withMtime;
            result[dirEntry.name].sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            result[dirEntry.name] = [];
          }
        }),
    );
  } catch {
    // response dir doesn't exist yet
  }
  return result;
}

/**
 * After a batch download, finds local starred/unstarred duplicate pairs (filenames
 * identical except for `.starred.`) among files with timestamp >= the oldest filename
 * timestamp in the newly downloaded batch, then deletes the one with the older mtime.
 * This resolves star/unstar operations that happened on the producer since the last sync.
 */
export async function resolveSyncDuplicates(
  folder: string,
  downloadedFilenames: string[],
): Promise<void> {
  if (downloadedFilenames.length === 0) return;

  // Find the oldest filename timestamp among downloaded files
  let minTs = Infinity;
  for (const f of downloadedFilenames) {
    const ts = filenameTimestamp(f);
    if (ts > 0 && ts < minTs) minTs = ts;
  }
  if (!isFinite(minTs)) return;

  const dir = join(config.RESPONSE_DIR, folder);
  let allFiles: string[];
  try {
    allFiles = await readdir(dir);
  } catch {
    return;
  }

  // Only check files with filename timestamp >= the oldest downloaded file
  const candidates = allFiles.filter(f => {
    if (!f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.log') && !f.endsWith('.html')) return false;
    const ts = filenameTimestamp(f);
    return ts > 0 && ts >= minTs;
  });
  if (candidates.length === 0) return;

  // Stat candidates for local mtime (includes mtimes just restored from remote)
  const mtimes = new Map<string, number>();
  await Promise.all(candidates.map(async (f) => {
    try {
      const info = await stat(join(dir, f));
      mtimes.set(f, info.mtimeMs);
    } catch { /* file may have been deleted */ }
  }));

  // Find starred/canonical pairs and delete the stale one
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
 * Stars or unstars a response file (and all its sidecar / retry files) by renaming them
 * to include or remove the `.starred.` segment, and updating JSON references accordingly.
 */
export async function starResponseFile(
  serviceName: string,
  filename: string,
  star: boolean,
): Promise<void> {
  // Only new-format main json files (not retry) are allowed
  if (
    !/^\d{8}-\d{6}_[a-zA-Z0-9-]+_[a-zA-Z0-9-]+_\d+_(200|203|400|500|503|504)(?:\.starred)?\.json$/.test(filename)
  ) {
    throw new Error('Invalid filename');
  }

  const isAlreadyStarred = filename.includes('.starred.json');
  if (star === isAlreadyStarred) return; // already in desired state

  const dir = join(config.RESPONSE_DIR, sanitizeName(serviceName));
  const filePath = join(dir, filename);

  const raw = await readFile(filePath, 'utf-8');
  const record = JSON.parse(raw) as ResponseRecord;

  function transform(name: string): string {
    if (star) {
      // Insert .starred after the base (before the first dot)
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
  const filepath = join(config.RESPONSE_DIR, sanitizeName(folder), filename);
  return readFile(filepath);
}

export async function responseFileSize(folder: string, filename: string): Promise<number> {
  try {
    const info = await stat(join(config.RESPONSE_DIR, sanitizeName(folder), filename));
    return info.size;
  } catch {
    return 0;
  }
}
