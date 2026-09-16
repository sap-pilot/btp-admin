// Minimal ZIP builder/extractor — STORE method only, single-disk, < 4 GiB total size.
// Native implementation; no third-party dependencies.

import { readFile } from 'node:fs/promises';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF]! ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipEntry { name: string; data: Buffer; }
export interface ZipPathEntry { name: string; actualPath: string; }

// Streaming ZIP builder — reads each file from disk one at a time to avoid
// loading thousands of files into memory simultaneously.
export async function streamZip(entries: ZipPathEntry[], write: (chunk: Buffer) => void): Promise<void> {
  type CdEntry = { nameBytes: Buffer; crc: number; size: number; localOffset: number };
  const cdEntries: CdEntry[] = [];
  let offset = 0;

  for (const { name, actualPath } of entries) {
    let data: Buffer;
    try { data = await readFile(actualPath); }
    catch { continue; }

    const nameBytes = Buffer.from(name, 'utf-8');
    const c = crc32(data);
    const size = data.length;

    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);   // STORE
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(c, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);

    cdEntries.push({ nameBytes, crc: c, size, localOffset: offset });
    write(lh);
    write(data);
    offset += lh.length + size;
  }

  const cdStart = offset;
  for (const { nameBytes, crc, size, localOffset } of cdEntries) {
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localOffset, 42);
    nameBytes.copy(cd, 46);
    write(cd);
    offset += cd.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdEntries.length, 8);
  eocd.writeUInt16LE(cdEntries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  write(eocd);
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const meta = entries.map(({ name, data }) => ({
    nameBytes: Buffer.from(name, 'utf-8'),
    crc: crc32(data),
    size: data.length,
    localOffset: 0,
  }));

  const localParts: Buffer[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { nameBytes, crc, size } = meta[i]!;
    meta[i]!.localOffset = offset;

    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);   // STORE
    lh.writeUInt16LE(0, 10);  // mod time
    lh.writeUInt16LE(0, 12);  // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);

    localParts.push(lh, entries[i]!.data);
    offset += lh.length + size;
  }

  const cdStart = offset;
  const cdParts: Buffer[] = [];

  for (const { nameBytes, crc, size, localOffset } of meta) {
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);  // STORE
    cd.writeUInt16LE(0, 12);  // mod time
    cd.writeUInt16LE(0, 14);  // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);  // extra length
    cd.writeUInt16LE(0, 32);  // comment length
    cd.writeUInt16LE(0, 34);  // disk number
    cd.writeUInt16LE(0, 36);  // internal attrs
    cd.writeUInt32LE(0, 38);  // external attrs
    cd.writeUInt32LE(localOffset, 42);
    nameBytes.copy(cd, 46);
    cdParts.push(cd);
  }

  const cdBuf = Buffer.concat(cdParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

export function extractZip(buf: Buffer): ZipEntry[] {
  // Search backward for EOCD signature (allows up to 64 KiB ZIP comment)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP: EOCD not found');

  const count = buf.readUInt16LE(eocdOffset + 8);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Invalid central directory signature');
    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf-8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (compression !== 0) throw new Error(`Unsupported compression method ${compression} for ${name}`);

    // Local file header extra length may differ from CD extra length
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({ name, data: Buffer.from(buf.subarray(dataStart, dataStart + compressedSize)) });
  }

  return entries;
}
