#!/usr/bin/env node --experimental-strip-types
/**
 * build.ts — build the launcher into <out> (default web/launcher/dist):
 *   index.html, manifest.webmanifest   copied
 *   launcher.js, sw.js                 launcher.ts / sw.ts with the types stripped (node:module)
 *   icon-192.png, icon-512.png         drawn here (a red star on a gold ring), no image tools needed
 * No bundler and no dependencies: Node 22.13+ (module.stripTypeScriptTypes).
 *
 * The output goes next to GeneralsZH.html / .js / .wasm and assets/ — it is the site's index.
 *
 * Usage: node --experimental-strip-types web/launcher/build.ts [out]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import * as nodeModule from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "dist"));
mkdirSync(out, { recursive: true });

const strip = (nodeModule as any).stripTypeScriptTypes as ((src: string, opts?: object) => string) | undefined;
if (!strip) throw new Error("node:module has no stripTypeScriptTypes (needs Node 22.13 or newer)");

for (const f of ["index.html", "manifest.webmanifest"]) copyFileSync(join(here, f), join(out, f));
for (const f of ["launcher", "sw"]) {
  const js = strip(readFileSync(join(here, `${f}.ts`), "utf8"), { mode: "strip" });
  writeFileSync(join(out, `${f}.js`), js);
}

// ---- icons ---------------------------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Five-point star, unit circle, point up. */
const star: [number, number][] = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.382 : 1;
  return [Math.cos(a) * r, Math.sin(a) * r];
});
function inPoly(x: number, y: number, p: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
type RGB = [number, number, number];
const BG: RGB = [10, 10, 10], GOLD: RGB = [240, 210, 122], RED: RGB = [179, 38, 30];
/** Colour at a point of the icon, in [-1, 1] coordinates (maskable: the art stays inside 80%). */
function shade(x: number, y: number): RGB {
  const r = Math.hypot(x, y);
  if (r > 0.62 && r < 0.72) return GOLD;
  if (inPoly(x / 0.52, (y - 0.02) / 0.52, star)) return RED;
  return BG;
}
function icon(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = shade(((x + (sx + 0.5) / SS) / size) * 2 - 1, ((y + (sy + 0.5) / SS) / size) * 2 - 1);
      r += c[0]; g += c[1]; b += c[2];
    }
    const o = (y * size + x) * 4, n = SS * SS;
    px[o] = Math.round(r / n); px[o + 1] = Math.round(g / n); px[o + 2] = Math.round(b / n); px[o + 3] = 255;
  }
  return png(size, px);
}
for (const s of [192, 512]) writeFileSync(join(out, `icon-${s}.png`), icon(s));

console.log(`launcher built into ${out}`);
