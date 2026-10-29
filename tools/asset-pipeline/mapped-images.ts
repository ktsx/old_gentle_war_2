#!/usr/bin/env node --experimental-strip-types
/**
 * mapped-images.ts — labelled placeholder atlases for the corpus' MappedImage definitions.
 *
 * Data/INI/MappedImages/** describes ~1 400 UI images (unit cameos, buttons, icons, menu
 * art) as rectangles inside ~130 textures the free set does not have. Instead of magenta
 * "missing texture" plates, every texture is generated with each image's rectangle drawn as
 * a bevelled tile carrying its MappedImage name (pixel font, wrapped), so the command bar,
 * menus and score screens are readable until real art replaces a texture — one file at a time.
 * Images the INIs use as cameos (unit / building / upgrade / power buttons and portraits) get a
 * drawn icon instead — side colour, silhouette, display name (cameos.ts).
 *
 * Usage:
 *   node --experimental-strip-types mapped-images.ts <patchDataDir> <outDir>   # writes <outDir>/Art/Textures/*.tga
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Image32, encodeTga, type RGBA } from "./tga.ts";
import { drawText, textWidth, wrapName, GLYPH_H, GLYPH_W } from "./pixelfont.ts";
import { collectCameos, drawCameo } from "./cameos.ts";

export interface MappedImage { name: string; texture: string; texW: number; texH: number; l: number; t: number; r: number; b: number }

export function parseMappedImages(iniText: string): MappedImage[] {
  const out: MappedImage[] = [];
  let cur: Partial<MappedImage> | null = null;
  for (const raw of iniText.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = /^MappedImage\s+(\S+)/i.exec(line))) { cur = { name: m[1] }; continue; }
    if (!cur) continue;
    if (/^End$/i.test(line)) { if (cur.name && cur.texture && cur.r !== undefined) out.push(cur as MappedImage); cur = null; continue; }
    if ((m = /^Texture\s*=\s*(\S+)/i.exec(line))) cur.texture = m[1];
    else if ((m = /^TextureWidth\s*=\s*(\d+)/i.exec(line))) cur.texW = +m[1];
    else if ((m = /^TextureHeight\s*=\s*(\d+)/i.exec(line))) cur.texH = +m[1];
    else if ((m = /^Coords\s*=\s*Left:\s*(-?\d+)\s+Top:\s*(-?\d+)\s+Right:\s*(-?\d+)\s+Bottom:\s*(-?\d+)/i.exec(line))) {
      cur.l = +m[1]; cur.t = +m[2]; cur.r = +m[3]; cur.b = +m[4];
    }
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ini$/i.test(e)) out.push(p);
  }
  return out;
}

/** Hue from the name so related images (same prefix) share a tint. */
function tint(name: string): RGBA {
  const key = name.replace(/[^A-Za-z]/g, "").slice(0, 4);
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = (h % 360) / 60, c = 28, m = 34;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round(m + r), Math.round(m + g), Math.round(m + b), 255];
}

export function drawPlaceholder(img: Image32, mi: MappedImage) {
  const w = mi.r - mi.l, h = mi.b - mi.t;
  if (w <= 0 || h <= 0) return;
  const fill = tint(mi.name);
  img.plate(mi.l, mi.t, w, h, fill, [fill[0] + 40, fill[1] + 40, fill[2] + 40, 255], [12, 13, 16, 255], w > 4 && h > 4 ? [6, 6, 8, 255] : undefined);
  if (w < 14 || h < 9) return;
  const scale = w >= 120 && h >= 48 ? 2 : 1;
  const maxChars = Math.max(1, Math.floor((w - 4) / ((GLYPH_W + 1) * scale)));
  const maxLines = Math.max(1, Math.floor((h - 4) / ((GLYPH_H + 2) * scale)));
  const lines = wrapName(mi.name, maxChars, Math.min(maxLines, 4));
  const totalH = lines.length * (GLYPH_H + 2) * scale - 2 * scale;
  let y = mi.t + Math.floor((h - totalH) / 2);
  for (const ln of lines) {
    const tw = textWidth(ln, scale);
    drawText(img, mi.l + Math.floor((w - tw) / 2), y, ln, [225, 228, 235, 255], scale);
    y += (GLYPH_H + 2) * scale;
  }
}

/** Generate one atlas per texture referenced by the INIs; `skip` lists textures provided elsewhere. */
export function buildPlaceholderAtlases(patchDataDir: string, skip: Set<string> = new Set()): Map<string, Image32> {
  const dir = join(patchDataDir, "INI", "MappedImages");
  const all: MappedImage[] = [];
  for (const f of walk(dir)) all.push(...parseMappedImages(readFileSync(f, "utf8")));
  const byTex = new Map<string, MappedImage[]>();
  for (const mi of all) {
    if (skip.has(mi.texture.toLowerCase())) continue;
    const list = byTex.get(mi.texture) ?? [];
    list.push(mi); byTex.set(mi.texture, list);
  }
  const cameos = collectCameos(patchDataDir);
  const atlases = new Map<string, Image32>();
  for (const [tex, list] of byTex) {
    const W = Math.min(1024, Math.max(...list.map((m) => m.texW || 0), ...list.map((m) => m.r), 16));
    const H = Math.min(1024, Math.max(...list.map((m) => m.texH || 0), ...list.map((m) => m.b), 16));
    const img = new Image32(W, H, [40, 20, 50, 255]);
    for (const mi of list) {
      const cameo = cameos.get(mi.name.toLowerCase());
      if (cameo && mi.r - mi.l >= 24 && mi.b - mi.t >= 20) drawCameo(img, mi.l, mi.t, mi.r - mi.l, mi.b - mi.t, cameo);
      else drawPlaceholder(img, mi);
    }
    atlases.set(tex, img);
  }
  return atlases;
}

export function writePlaceholderAtlases(patchDataDir: string, outDir: string, skip?: Set<string>): { textures: number; bytes: number } {
  const dir = join(outDir, "Art", "Textures");
  mkdirSync(dir, { recursive: true });
  let bytes = 0, n = 0;
  for (const [tex, img] of buildPlaceholderAtlases(patchDataDir, skip)) {
    const buf = encodeTga(img, true);
    writeFileSync(join(dir, tex), buf);
    bytes += buf.length; n++;
  }
  return { textures: n, bytes };
}

if (process.argv[1] && /mapped-images\.ts$/.test(process.argv[1])) {
  const [patch, out] = process.argv.slice(2);
  if (!patch || !out) { console.error("usage: mapped-images.ts <patchDataDir> <outDir>"); process.exit(2); }
  const r = writePlaceholderAtlases(patch, out);
  console.log(`${r.textures} textures, ${(r.bytes / 1e6).toFixed(1)} MB`);
}
