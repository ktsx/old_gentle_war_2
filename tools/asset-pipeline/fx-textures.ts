#!/usr/bin/env node --experimental-strip-types
/**
 * fx-textures.ts — placeholder effect textures for the free asset set.
 *
 * The corpus INIs reference ~150 textures for particles (ParticleSystem.ini `ParticleName`),
 * shadow decals (`ShadowTexture = ShadowI`), track marks (`TrackMarks = EXTnkTrack.tga`) and
 * beams/streams (`Texture = EXLaser.tga` in weapon objects). Missing ones draw as magenta
 * quads the moment a unit fires or moves. Every name the INIs mention gets a 64×64 soft alpha
 * sprite tinted by what the name says it is (fire/explosion → orange, smoke → grey, dirt →
 * brown, water → blue, sparks/laser/rings → white), shadows a dark disc, track marks two dark
 * stripes. Textures the atlases already provide (hud, units, terrain) are skipped by the caller.
 *
 * Usage: node --experimental-strip-types fx-textures.ts <patchDataDir> <outDir>
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Image32, encodeTga, type RGBA } from "./tga.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ini$/i.test(e)) out.push(p);
  }
  return out;
}

/** Texture names the INIs reference for effects: particles, shadows, track marks, beams. */
export function collectFxTextureNames(patchDataDir: string): Map<string, string> {
  const names = new Map<string, string>(); // lower-case file name -> kind
  const add = (raw: string, kind: string) => {
    let n = raw.trim().replace(/;.*$/, "").trim();
    if (!n || /^none$/i.test(n)) return;
    if (!/\.tga$/i.test(n)) n += ".tga";
    const key = n.toLowerCase();
    if (!names.has(key)) names.set(key, kind);
  };
  for (const f of walk(join(patchDataDir, "INI"))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/^\s*ParticleName\s*=\s*(\S+)/gim)) add(m[1], "particle");
    for (const m of text.matchAll(/^\s*ShadowTexture\s*=\s*(\S+)/gim)) add(m[1], "shadow");
    for (const m of text.matchAll(/^\s*TrackMarks\s*=\s*(\S+)/gim)) add(m[1], "track");
    for (const m of text.matchAll(/^\s*Texture\s*=\s*(EX\w+\.tga)/gim)) add(m[1], "beam");
  }
  return names;
}

function tintFor(name: string): RGBA {
  const n = name.toLowerCase();
  if (/fire|explo|fthrower|burn|flame|fireball|smolder|lnzflar|flare/.test(n)) return [255, 150, 40, 255];
  if (/smok|cloud|contrail|jet/.test(n)) return [150, 150, 155, 255];
  if (/dirt|debris|drt|avalanche|scorch|snow|chunk/.test(n)) return [150, 120, 85, 255];
  if (/water|wave|puddle|waterfall|oil/.test(n)) return [120, 170, 230, 255];
  if (/laser|spark|ring|sonic|sonar|shock|starburst|grid|heat|dots|fuzzy|emp|hack|thunder|stream|sine|noise|binary/.test(n)) return [255, 255, 255, 255];
  return [220, 220, 220, 255];
}

/**
 * A soft radial sprite. Most particle systems draw ADDITIVE, where only RGB matters and the
 * art fades to black at the edges, so the colour is premultiplied by the falloff; the alpha
 * channel carries the same falloff for ALPHA-blended systems.
 */
function blob(color: RGBA, size = 64, power = 1.6): Image32 {
  const img = new Image32(size, size, [0, 0, 0, 0]);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - c, y - c) / c;
    const a = d >= 1 ? 0 : Math.pow(1 - d, power);
    img.set(x, y, [Math.round(color[0] * a), Math.round(color[1] * a), Math.round(color[2] * a), Math.round(255 * a)]);
  }
  return img;
}

/** Shadow decals are alpha-blended black: alpha falloff only. */
function shadowDecal(): Image32 {
  const img = new Image32(64, 64, [0, 0, 0, 0]);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const d = Math.hypot(x - 31.5, y - 31.5) / 31.5;
    img.set(x, y, [0, 0, 0, d >= 1 ? 0 : Math.round(200 * Math.pow(1 - d, 0.8))]);
  }
  return img;
}

function trackMarks(): Image32 {
  const img = new Image32(64, 64, [0, 0, 0, 0]);
  for (const x0 of [10, 42]) for (let y = 0; y < 64; y++) for (let x = x0; x < x0 + 12; x++) {
    const edge = Math.min(x - x0, x0 + 11 - x);
    img.set(x, y, [30, 25, 20, edge === 0 ? 70 : 120]);
  }
  return img;
}

function beam(color: RGBA): Image32 {
  const img = new Image32(64, 16, [0, 0, 0, 0]);
  for (let y = 0; y < 16; y++) {
    const f = Math.pow(1 - Math.abs(y - 7.5) / 8, 1.5);
    for (let x = 0; x < 64; x++) img.set(x, y, [Math.round(color[0] * f), Math.round(color[1] * f), Math.round(color[2] * f), Math.round(255 * f)]);
  }
  return img;
}

export function buildFxTextures(patchDataDir: string, skip: Set<string> = new Set()): Map<string, Image32> {
  const out = new Map<string, Image32>();
  for (const [name, kind] of collectFxTextureNames(patchDataDir)) {
    if (skip.has(name)) continue;
    let img: Image32;
    if (kind === "shadow") img = shadowDecal();
    else if (kind === "track") img = trackMarks();
    else if (kind === "beam") img = beam(tintFor(name));
    else img = blob(tintFor(name));
    out.set(name, img);
  }
  return out;
}

export function writeFxTextures(patchDataDir: string, outDir: string, skip?: Set<string>): { textures: number; bytes: number } {
  const dir = join(outDir, "Art", "Textures");
  mkdirSync(dir, { recursive: true });
  let n = 0, bytes = 0;
  for (const [name, img] of buildFxTextures(patchDataDir, skip)) {
    const buf = encodeTga(img, true);
    writeFileSync(join(dir, name), buf);
    n++; bytes += buf.length;
  }
  return { textures: n, bytes };
}

if (process.argv[1] && /fx-textures\.ts$/.test(process.argv[1])) {
  const [patch, out] = process.argv.slice(2);
  if (!patch || !out) { console.error("usage: fx-textures.ts <patchDataDir> <outDir>"); process.exit(2); }
  const r = writeFxTextures(patch, out);
  console.log(`${r.textures} textures, ${(r.bytes / 1e6).toFixed(2)} MB`);
}
