#!/usr/bin/env node
// Formats piped `cf logs` output: strips CF prefix, pretty-prints pino JSON, colorizes levels.
// Non-JSON lines (plain text, partial lines) are passed through unchanged.
import { createInterface } from 'node:readline';

const R = '\x1b[0m';
const DIM = '\x1b[2m';

// [color, padded label]
const LEVEL = {
  10: ['\x1b[2m',    'TRACE'],
  20: ['\x1b[36m',   'DEBUG'],
  30: ['\x1b[32m',   'INFO '],
  40: ['\x1b[33m',   'WARN '],
  50: ['\x1b[31m',   'ERROR'],
  60: ['\x1b[1;31m', 'FATAL'],
};

const SKIP = new Set(['level', 'time', 'msg', 'pid', 'hostname']);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', raw => {
  const line = raw.trim();
  if (!line) return;

  // Extract JSON payload from a CF log line: "... OUT {...}" or "... ERR {...}"
  // Falls back to treating the whole line as JSON (e.g. local `node dist/index.js | node scripts/format-logs.mjs`)
  const cfMatch = line.match(/(?:OUT|ERR) (\{.+\})$/);
  const jsonStr = cfMatch ? cfMatch[1] : line;

  let obj;
  try { obj = JSON.parse(jsonStr); } catch { process.stdout.write(line + '\n'); return; }

  // Must look like a pino record
  if (typeof obj.msg !== 'string') { process.stdout.write(line + '\n'); return; }

  const level = typeof obj.level === 'number' ? obj.level : 30;
  const [color, label] = LEVEL[level] ?? ['\x1b[37m', 'UNKNW'];
  const time = obj.time ? new Date(obj.time).toISOString().slice(11, 23) : '';

  // Extra fields — err.message highlighted in red, rest as dim key=value
  const extras = [];
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP.has(k)) continue;
    if (k === 'err' && v && typeof v === 'object') {
      const msg = v.message ?? v.type ?? JSON.stringify(v);
      extras.push(`\x1b[31m${msg}${R}`);
    } else {
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      extras.push(`${DIM}${k}${R}=${str}`);
    }
  }

  const parts = [`${color}${label}${R}`, time, obj.msg];
  if (extras.length) parts.push(extras.join(' '));
  process.stdout.write(parts.join(' ') + '\n');
});
