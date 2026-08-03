#!/usr/bin/env node
/**
 * Parse SAP BTP CF endpoints CSV → server/config/btp-endpoints.json
 * Usage: node scripts/parse-btp-endpoints.mjs <path-to-csv>
 *
 * The CSV from SAP help uses semicolon delimiters, a BOM header, and
 * has literal newlines inside quoted fields for regions with sub-regions.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/parse-btp-endpoints.mjs <path-to-csv>');
  process.exit(1);
}

let raw = readFileSync(resolve(csvPath), 'utf-8');
// Strip BOM if present
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

/**
 * Parse a semicolon-delimited CSV that may contain quoted multi-line fields.
 * Returns an array of rows (each row is an array of field strings).
 */
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const row = [];

    while (i < n) {
      if (text[i] === '"') {
        // Quoted field — read until closing quote (handle "" escape)
        i++;
        let field = '';
        while (i < n) {
          if (text[i] === '"') {
            if (i + 1 < n && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            field += text[i++];
          }
        }
        row.push(field);
      } else {
        // Unquoted field — read until ; or line end
        let field = '';
        while (i < n && text[i] !== ';' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i++];
        }
        row.push(field);
      }

      if (i < n && text[i] === ';') {
        i++; // advance to next field
        continue;
      }
      break; // end of row
    }

    // Consume trailing newline (\r\n or \n)
    if (i < n && text[i] === '\r') i++;
    if (i < n && text[i] === '\n') i++;

    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Extract all IPv4 addresses (with optional /prefix CIDR) from a string.
 */
function extractIPs(text) {
  return (text.match(/\d+\.\d+\.\d+\.\d+(?:\/\d+)?/g) ?? []);
}

/**
 * Parse an IP cell which may be either:
 *   simple:    "ip1, ip2, ip3"           → { [defaultKey]: [ip1, ip2, ip3] }
 *   sub-region: "cf-eu10:\n  ip1\n  cf-eu10-002:\n  ip2" → { "cf-eu10": [ip1], "cf-eu10-002": [ip2] }
 */
function parseIPCell(cellText, defaultKey) {
  const text = cellText.trim();
  if (!text) return {};

  const lines = text.split('\n');
  const result = {};
  let hasSubRegions = false;
  let currentKey = null;
  let currentIPs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const labelMatch = trimmed.match(/^(cf-[a-z0-9-]+)\s*:$/);
    if (labelMatch) {
      if (currentKey !== null && currentIPs.length > 0) {
        result[currentKey] = currentIPs;
      }
      currentKey = labelMatch[1];
      currentIPs = [];
      hasSubRegions = true;
    } else {
      currentIPs.push(...extractIPs(trimmed));
    }
  }

  if (hasSubRegions) {
    if (currentKey !== null && currentIPs.length > 0) {
      result[currentKey] = currentIPs;
    }
  } else {
    if (currentIPs.length > 0) {
      result[defaultKey] = currentIPs;
    }
  }

  return result;
}

// --- Main ---

const rows = parseCSV(raw);
if (rows.length < 2) {
  console.error('CSV has too few rows (expected header + data)');
  process.exit(1);
}

const header = rows[0];
console.log(`Columns: ${header.join(' | ')}`);
console.log(`Data rows: ${rows.length - 1}`);

const regionData = {};
let skipped = 0;

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  // Need at least: iaas(0), region(1), regionName(2), technicalKey(3), iaasKey(4), egressIPs(5), ingressIPs(6)
  if (row.length < 7) {
    console.warn(`Row ${i + 1}: only ${row.length} columns, skipping`);
    skipped++;
    continue;
  }

  const iaasProvider = row[0].trim();
  const region       = row[1].trim(); // e.g. "eu10"
  const regionName   = row[2].trim(); // e.g. "Europe (Frankfurt)"
  const technicalKey = row[3].trim(); // e.g. "cf-eu10"
  // row[4] = IaaS technical key (unused)
  const egressCell   = row[5];
  const ingressCell  = row[6];

  if (!region || !technicalKey) {
    skipped++;
    continue;
  }

  const egressIPs  = parseIPCell(egressCell,  technicalKey);
  const ingressIPs = parseIPCell(ingressCell, technicalKey);

  regionData[region] = { regionName, iaasProvider, egressIPs, ingressIPs };
}

const output = {
  updateTime: new Date().toISOString(),
  region: regionData,
};

const outPath = resolve(__dirname, '../server/config/btp-endpoints.json');
writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

const regionCount = Object.keys(regionData).length;
console.log(`\nWrote ${regionCount} regions to ${outPath}`);
if (skipped > 0) console.warn(`Skipped ${skipped} malformed rows`);
