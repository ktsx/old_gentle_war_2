#!/usr/bin/env node --experimental-strip-types
/**
 * big.ts — reader/writer for SAGE engine `.big` archives (BIGF format) used by
 * C&C Generals / Zero Hour.
 *
 * Format (verified against Core/GameEngineDevice/Source/Win32Device/Common/Win32BIGFileSystem.cpp):
 *   0x00  "BIGF"                      magic
 *   0x04  u32 LE  archive size         (engine reads it as little-endian)
 *   0x08  u32 BE  number of entries
 *   0x0C  u32 BE  first-file offset / header size (engine ignores it)
 *   0x10  entries: u32 BE offset, u32 BE size, NUL-terminated path ("Data\INI\Object\x.ini")
 *   ...   file data (uncompressed)
 *
 * Usage:
 *   node --experimental-strip-types big.ts list    <archive.big> [--json]
 *   node --experimental-strip-types big.ts extract <archive.big> <outDir> [--filter substr]
 *   node --experimental-strip-types big.ts pack    <inDir> <archive.big>
 *   node --experimental-strip-types big.ts cat     <archive.big> <path-inside-archive>
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";

export interface BigEntry {
  /** Path as stored in the archive, backslash-separated, original case. */
  path: string;
  offset: number;
  size: number;
}

export interface BigHeader {
  archiveSize: number;
  numEntries: number;
  headerSize: number;
}

export interface BigArchive {
  header: BigHeader;
  entries: BigEntry[];
}

const MAGIC = "BIGF";

/** Parse only the header + directory table (reads the file lazily, no full load). */
export function readBigDirectory(file: string): BigArchive {
  const fd = openSync(file, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    if (head.toString("latin1", 0, 4) !== MAGIC) {
      throw new Error(`${file}: not a BIGF archive (magic = ${JSON.stringify(head.toString("latin1", 0, 4))})`);
    }
    const header: BigHeader = {
      archiveSize: head.readUInt32LE(4),
      numEntries: head.readUInt32BE(8),
      headerSize: head.readUInt32BE(12),
    };
    // The directory table ends at headerSize; read it whole (bounded by file size).
    const tableEnd = Math.min(header.headerSize > 16 ? header.headerSize : fileSize, fileSize);
    const table = Buffer.alloc(tableEnd - 16);
    readSync(fd, table, 0, table.length, 16);

    const entries: BigEntry[] = [];
    let p = 0;
    for (let i = 0; i < header.numEntries; i++) {
      if (p + 8 > table.length) throw new Error(`${file}: directory truncated at entry ${i}`);
      const offset = table.readUInt32BE(p);
      const size = table.readUInt32BE(p + 4);
      p += 8;
      const nul = table.indexOf(0, p);
      if (nul < 0) throw new Error(`${file}: unterminated path at entry ${i}`);
      const path = table.toString("latin1", p, nul);
      p = nul + 1;
      if (offset + size > fileSize) throw new Error(`${file}: entry ${path} points past EOF`);
      entries.push({ path, offset, size });
    }
    return { header, entries };
  } finally {
    closeSync(fd);
  }
}

/** Read one entry's bytes. */
export function readBigEntry(file: string, entry: BigEntry): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(entry.size);
    readSync(fd, buf, 0, entry.size, entry.offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Case-insensitive lookup, accepts "/" or "\" separators. */
export function findBigEntry(archive: BigArchive, path: string): BigEntry | undefined {
  const norm = (s: string) => s.replace(/\//g, "\\").toLowerCase();
  const want = norm(path);
  return archive.entries.find((e) => norm(e.path) === want);
}

/**
 * Build a BIGF archive from {path → bytes}. Paths use backslashes inside the archive.
 * Entries passing the same Buffer object share one copy of the data (audio.ts maps thousands of
 * file names onto a few dozen sounds); the format allows any number of entries per byte range.
 */
export function buildBig(files: { path: string; data: Buffer }[]): Buffer {
  const tableParts: Buffer[] = [];
  let tableSize = 16;
  for (const f of files) tableSize += 8 + Buffer.byteLength(f.path, "latin1") + 1;
  // Game archives align the header size; the engine doesn't care, so we keep it exact.
  let offset = tableSize;
  const placed = new Map<Buffer, number>();
  const blobs: Buffer[] = [];
  for (const f of files) {
    const rec = Buffer.alloc(8 + Buffer.byteLength(f.path, "latin1") + 1);
    let at = placed.get(f.data);
    if (at === undefined) {
      at = offset;
      placed.set(f.data, at);
      blobs.push(f.data);
      offset += f.data.length;
    }
    rec.writeUInt32BE(at, 0);
    rec.writeUInt32BE(f.data.length, 4);
    rec.write(f.path.replace(/\//g, "\\"), 8, "latin1");
    tableParts.push(rec);
  }
  const total = offset;
  const head = Buffer.alloc(16);
  head.write(MAGIC, 0, "latin1");
  head.writeUInt32LE(total, 4);
  head.writeUInt32BE(files.length, 8);
  head.writeUInt32BE(tableSize, 12);
  return Buffer.concat([head, ...tableParts, ...blobs]);
}

/** Pack every file under `dir` into `outFile`; returns the file count. Paths are stored with backslashes. */
export function packDir(dir: string, outFile: string): number {
  const files = walk(dir).map((rel) => ({
    path: rel.split(sep).join("\\"),
    data: readFileSync(join(dir, rel)),
  }));
  writeFileSync(outFile, buildBig(files));
  return files.length;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function main(argv: string[]): number {
  const [cmd, a, b, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case "list": {
      const arc = readBigDirectory(a);
      if (rest.includes("--json")) {
        console.log(JSON.stringify(arc, null, 2));
      } else {
        console.log(`${a}: ${arc.header.numEntries} entries, ${arc.header.archiveSize} bytes`);
        for (const e of arc.entries) console.log(`${String(e.size).padStart(10)}  ${e.path}`);
      }
      return 0;
    }
    case "cat": {
      const arc = readBigDirectory(a);
      const e = findBigEntry(arc, b);
      if (!e) { console.error(`not found: ${b}`); return 1; }
      process.stdout.write(readBigEntry(a, e));
      return 0;
    }
    case "extract": {
      const arc = readBigDirectory(a);
      const filter = flag("--filter")?.toLowerCase();
      let n = 0;
      for (const e of arc.entries) {
        if (filter && !e.path.toLowerCase().includes(filter)) continue;
        const out = join(b, ...e.path.split("\\"));
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, readBigEntry(a, e));
        n++;
      }
      console.log(`extracted ${n} files to ${b}`);
      return 0;
    }
    case "pack": {
      const n = packDir(a, b);
      console.log(`packed ${n} files into ${b}`);
      return 0;
    }
    default:
      console.error("usage: big.ts list|cat|extract|pack ... (see header comment)");
      return 2;
  }
}

if (process.argv[1] && /big\.ts$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
