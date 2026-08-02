// Minimal hand-rolled ZIP writer for tests. Built from Node built-ins only
// (zlib + Buffer) so fixtures never depend on the extractor under test, on
// yauzl, or on PowerShell. Emits real local headers, a real central
// directory, and a real end-of-central-directory record.

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const STORE = 0;
const DEFLATE = 8;

// DOS time/date for a fixed timestamp so fixtures are byte-deterministic.
const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = 0x5821; // 2024-01-01

/**
 * @param {Array<{name: string, data?: Buffer|string, method?: "store"|"deflate", dir?: boolean}>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.dir === true || entry.name.endsWith("/");
    const name = Buffer.from(isDir && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name, "utf8");
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? "", "utf8");
    const method = isDir ? STORE : entry.method === "deflate" ? DEFLATE : STORE;
    const payload = method === DEFLATE ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(isDir ? 0x10 : 0, 38); // external attrs (DOS directory bit)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/**
 * Self-check that a produced buffer really is a structurally valid ZIP:
 * locates the EOCD, walks the central directory, and confirms every entry's
 * local header signature and declared name. Throws on any inconsistency.
 * @returns {string[]} entry names in central-directory order
 */
export function verifyZipStructure(buf) {
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("fixture invalid: no end-of-central-directory record");

  const total = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > buf.length) throw new Error("fixture invalid: central directory out of range");

  const names = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`fixture invalid: bad central header signature at entry ${i}`);
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`fixture invalid: bad local header signature for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localName = buf.toString("utf8", localOffset + 30, localOffset + 30 + localNameLen);
    if (localName !== name) {
      throw new Error(`fixture invalid: local/central name mismatch (${localName} vs ${name})`);
    }

    names.push(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * Standard fixture payload used by the extraction tests: nested directories,
 * a DEFLATE-compressed entry, and both binary and model files.
 */
export function standardFixtureEntries() {
  return [
    { name: "bin/", dir: true },
    { name: "bin/photo-tool.exe", data: "PHOTO-BINARY-CONTENT", method: "store" },
    // DEFLATE entry: this is the shape that stalls the yauzl path on Windows.
    { name: "bin/anime-tool.exe", data: "ANIME-BINARY-CONTENT".repeat(64), method: "deflate" },
    { name: "models/", dir: true },
    { name: "models/photo/", dir: true },
    { name: "models/photo/model.param", data: "photo-param", method: "deflate" },
    { name: "models/anime/", dir: true },
    { name: "models/anime/model.param", data: "anime-param", method: "store" },
  ];
}
