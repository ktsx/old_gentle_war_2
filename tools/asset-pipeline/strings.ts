#!/usr/bin/env node --experimental-strip-types
/**
 * strings.ts — string-table tooling for the web port.
 *
 * The engine (Core/GameEngine/Source/GameClient/GameText.cpp) reads UI text from
 * either `Data\generals.str` (text, one language) or `Data\<Language>\generals.csf`
 * (binary). The community patch corpus (TheSuperHackers/GeneralsGamePatch) keeps
 * its strings in a *multi-language* .str the engine does not understand:
 *
 *   LABEL:Name
 *   US: "text"
 *   DE: "text"
 *   END
 *
 * This tool reads both that format and the classic one (`"text"` lines) and
 * writes what the engine loads:
 *
 *   csf  — binary CSF (preferred: binary, fast, exactly what retail ships)
 *   str  — classic single-language .str (handy for diffing / hand edits)
 *
 * CSF layout (verified against GameTextManager::parseCSF, all ints little-endian):
 *   header: id " FSC"  version=3  num_labels  num_strings  skip=0  langid
 *   per label:  " LBL"  num_strings(=1)  len  label bytes
 *   per string: " RTS"  len(chars)  UTF-16LE chars, each bitwise NOT
 *
 * Usage:
 *   node --experimental-strip-types strings.ts csf <in.str> <out.csf> [--lang US]
 *   node --experimental-strip-types strings.ts str <in.str> <out.str> [--lang US]
 *   node --experimental-strip-types strings.ts dump <in.csf> [--limit N]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StringEntry {
  label: string;
  /** Text with escapes resolved (real newlines, quotes). */
  text: string;
}

/** CSF language ids as the engine enumerates them (LanguageID in GameText.cpp). */
const LANG_IDS: Record<string, number> = {
  US: 0, UK: 1, DE: 2, FR: 3, ES: 4, IT: 5, JA: 6, JB: 7, KO: 8, ZH: 9, // ZH = Chinese
  // The patch corpus also carries BP (Brazilian Portuguese), PL, RU, AR — no retail id; keep US slot.
};

/** Resolve the escapes the engine's translateCopy() understands. */
export function unescapeStr(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) { out += c; continue; }
    const n = s[++i];
    switch (n) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      default: out += "\\" + n; // unknown escape: keep verbatim
    }
  }
  return out;
}

export function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/**
 * Parse a .str in either the classic or the multi-language format.
 * For multi-language files, `lang` picks the column; falls back to US, then to
 * the first quoted line found.
 */
export function parseStr(src: string, lang = "US"): StringEntry[] {
  const lines = src.replace(/^﻿/, "").split(/\r?\n/);
  const entries: StringEntry[] = [];
  let i = 0;
  const isLabel = (l: string) => /^[A-Za-z_][^\s"]*$/.test(l) && !/^[A-Z][A-Z]:$/.test(l);
  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (!line || line.startsWith("//")) continue;
    if (!isLabel(line)) continue; // stray text outside a block
    const label = line;
    let chosen: string | undefined;
    let us: string | undefined;
    let first: string | undefined;
    while (i < lines.length) {
      const l = lines[i].trim();
      i++;
      if (l.toUpperCase() === "END") break;
      if (!l || l.startsWith("//")) continue;
      let quoted: string | undefined;
      let col: string | undefined;
      const m = /^([A-Z][A-Z]):\s*(.*)$/.exec(l);
      if (m) { col = m[1]; quoted = m[2]; } else { quoted = l; }
      if (quoted === undefined || !quoted.startsWith('"')) continue; // junk line (the corpus has a few)
      // text runs to the last quote on the line; anything after is ignored (speech hint)
      const end = quoted.lastIndexOf('"');
      const body = end > 0 ? quoted.slice(1, end) : quoted.slice(1);
      if (first === undefined) first = body;
      if (col === lang && chosen === undefined) chosen = body;
      if (col === "US" && us === undefined) us = body;
      if (!col && chosen === undefined) chosen = body; // classic format
    }
    const text = chosen ?? us ?? first ?? "";
    entries.push({ label, text: unescapeStr(text) });
  }
  return entries;
}

export function buildCsf(entries: StringEntry[], lang = "US"): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const tag = (s: string) => Buffer.from(s, "latin1"); // " FSC" etc. — bytes as they sit in the file
  parts.push(tag(" FSC"), u32(3), u32(entries.length), u32(entries.length), u32(0), u32(LANG_IDS[lang] ?? 0));
  for (const e of entries) {
    const label = Buffer.from(e.label, "latin1");
    parts.push(tag(" LBL"), u32(1), u32(label.length), label);
    const chars = Buffer.from(e.text, "utf16le");
    for (let i = 0; i < chars.length; i++) chars[i] = ~chars[i] & 0xff;
    parts.push(tag(" RTS"), u32(chars.length / 2), chars);
  }
  return Buffer.concat(parts);
}

export function parseCsf(buf: Buffer): { lang: number; entries: StringEntry[] } {
  let p = 0;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const tag = () => { const s = buf.toString("latin1", p, p + 4); p += 4; return s; };
  if (tag() !== " FSC") throw new Error("not a CSF file");
  const version = u32(); const numLabels = u32(); u32(); u32(); const lang = u32();
  if (version < 2) throw new Error(`unsupported CSF version ${version}`);
  const entries: StringEntry[] = [];
  for (let n = 0; n < numLabels && p < buf.length; n++) {
    if (tag() !== " LBL") throw new Error(`bad label tag at ${p - 4}`);
    const numStrings = u32(); const len = u32();
    const label = buf.toString("latin1", p, p + len); p += len;
    let text = "";
    for (let s = 0; s < numStrings; s++) {
      const t = tag();
      if (t !== " RTS" && t !== "WRTS") throw new Error(`bad string tag ${JSON.stringify(t)} at ${p - 4}`);
      const chars = u32();
      const raw = Buffer.from(buf.subarray(p, p + chars * 2)); p += chars * 2;
      for (let i = 0; i < raw.length; i++) raw[i] = ~raw[i] & 0xff;
      if (s === 0) text = raw.toString("utf16le");
      if (t === "WRTS") { const wl = u32(); p += wl; }
    }
    entries.push({ label, text });
  }
  return { lang, entries };
}

function buildStr(entries: StringEntry[]): string {
  const out: string[] = ["// generated by tools/asset-pipeline/strings.ts", ""];
  for (const e of entries) out.push(e.label, `"${escapeStr(e.text)}"`, "END", "");
  return out.join("\n");
}

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  const [cmd, inPath, outPath] = process.argv.slice(2);
  const lang = arg("--lang", "US").toUpperCase();
  if (cmd === "csf" || cmd === "str") {
    if (!inPath || !outPath) { console.error("usage: strings.ts csf|str <in.str> <out> [--lang US]"); process.exit(2); }
    const entries = parseStr(readFileSync(inPath, "utf8"), lang);
    mkdirSync(dirname(outPath), { recursive: true });
    if (cmd === "csf") writeFileSync(outPath, buildCsf(entries, lang));
    else writeFileSync(outPath, buildStr(entries));
    const empty = entries.filter((e) => !e.text).length;
    console.log(`${outPath}: ${entries.length} labels (${lang}), ${empty} empty`);
  } else if (cmd === "dump") {
    if (!inPath) { console.error("usage: strings.ts dump <in.csf> [--limit N]"); process.exit(2); }
    const { lang: l, entries } = parseCsf(readFileSync(inPath));
    const limit = Number(arg("--limit", "20"));
    console.log(`langid=${l} labels=${entries.length}`);
    for (const e of entries.slice(0, limit)) console.log(`${e.label}\t${JSON.stringify(e.text)}`);
  } else {
    console.error("commands: csf, str, dump");
    process.exit(2);
  }
}

if (process.argv[1] && /strings\.ts$/.test(process.argv[1])) main();
