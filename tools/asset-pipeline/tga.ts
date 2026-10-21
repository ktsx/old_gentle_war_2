#!/usr/bin/env node --experimental-strip-types
/**
 * tga.ts — write uncompressed 32-bit TGA files (what the engine's Targa loader
 * reads from Art/Textures) and generate the handful of placeholder images the
 * free asset set uses.
 *
 * TGA type 2, 32 bpp, BGRA, origin top-left (image descriptor bit 5 set).
 *
 * Usage:
 *   node --experimental-strip-types tga.ts gen <outDir>     # writes the free-asset images into <outDir>/Art/Textures
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type RGBA = [number, number, number, number];

export class Image32 {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array; // RGBA, row-major, top-left origin
  constructor(width: number, height: number, fill: RGBA = [0, 0, 0, 0]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, fill);
  }
  set(x: number, y: number, c: RGBA) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3];
  }
  fillRect(x0: number, y0: number, w: number, h: number, c: RGBA) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
  /** 1-pixel frame inside the rect */
  strokeRect(x0: number, y0: number, w: number, h: number, c: RGBA) {
    this.fillRect(x0, y0, w, 1, c); this.fillRect(x0, y0 + h - 1, w, 1, c);
    this.fillRect(x0, y0, 1, h, c); this.fillRect(x0 + w - 1, y0, 1, h, c);
  }
}

export function encodeTga(img: Image32): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2;                       // uncompressed true-colour
  header.writeUInt16LE(img.width, 12);
  header.writeUInt16LE(img.height, 14);
  header[16] = 32;                     // bits per pixel
  header[17] = 0x28;                   // 8 alpha bits, top-left origin
  const px = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    px[i * 4] = img.data[i * 4 + 2];     // B
    px[i * 4 + 1] = img.data[i * 4 + 1]; // G
    px[i * 4 + 2] = img.data[i * 4];     // R
    px[i * 4 + 3] = img.data[i * 4 + 3]; // A
  }
  return Buffer.concat([header, px]);
}

/**
 * The free-asset images. Names are referenced by assets-free/overlay/Data/INI/MappedImages.
 *
 * gxlogo.tga (256x64): a colour-order probe as much as a logo — solid red left third,
 * green middle, blue right third, white frame. Any channel-order bug in the texture
 * path shows up as swapped stripes in the boot-smoke screenshot.
 */
export function generateFreeImages(): Record<string, Image32> {
  const logo = new Image32(256, 64, [16, 18, 24, 255]);
  logo.fillRect(4, 4, 82, 56, [220, 40, 40, 255]);
  logo.fillRect(87, 4, 82, 56, [40, 200, 70, 255]);
  logo.fillRect(170, 4, 82, 56, [50, 90, 230, 255]);
  logo.strokeRect(0, 0, 256, 64, [240, 240, 240, 255]);

  // button plate: 256x32, dark fill, light frame, slightly lighter top band
  const btn = new Image32(256, 32, [44, 50, 62, 255]);
  btn.fillRect(1, 1, 254, 6, [70, 78, 94, 255]);
  btn.strokeRect(0, 0, 256, 32, [150, 160, 180, 255]);
  const btnHi = new Image32(256, 32, [80, 100, 150, 255]);
  btnHi.fillRect(1, 1, 254, 6, [110, 130, 180, 255]);
  btnHi.strokeRect(0, 0, 256, 32, [220, 230, 250, 255]);
  const btnDis = new Image32(256, 32, [30, 30, 34, 255]);
  btnDis.strokeRect(0, 0, 256, 32, [70, 70, 76, 255]);

  // Terrain multiply passes (W3DShaderManager TerrainShader2Stage pass 2): the cloud map
  // TSCloudMed.tga and the "lightmap" noise TSNoiseUrb.tga are blended DESTCOLOR*ZERO over the
  // terrain, so a missing texture multiplies it to black. Supply bright, soft ones.
  const cloud = new Image32(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const n = smoothNoise(x / 32, y / 32, 3) * 0.6 + smoothNoise(x / 8, y / 8, 5) * 0.4;
    const v = Math.round(215 + 40 * n);
    cloud.set(x, y, [v, v, v, 255]);
  }
  const lightNoise = new Image32(256, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = Math.round(225 + 30 * noise(x, y, 11));
    lightNoise.set(x, y, [v, v, v, 255]);
  }
  return {
    "gxlogo.tga": logo, "gxbutton.tga": btn, "gxbutton_hi.tga": btnHi, "gxbutton_dis.tga": btnDis,
    "TSCloudMed.tga": cloud, "TSNoiseUrb.tga": lightNoise,
  };
}

/** Deterministic hash noise in [0, 1). */
function noise(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) ^ 0x5bd1e995;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Bilinear value noise in [0, 1) (periodic in 256-unit tiles is not required: the maps wrap on their own). */
function smoothNoise(x: number, y: number, seed = 0): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = noise(x0, y0, seed), b = noise(x0 + 1, y0, seed), c = noise(x0, y0 + 1, seed), d = noise(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/**
 * Terrain tile sheets live in Art/Terrain and are cut into 64x64 tiles by
 * WorldHeightMap::readTiles (a 128x128 sheet = 2x2 tiles). gxgrass.tga is a
 * procedural green with a faint 1-px darker cell edge so the height-map grid
 * stays visible while there is nothing else on the terrain.
 */
export function generateTerrainImages(): Record<string, Image32> {
  const size = 128;
  const grass = new Image32(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const n = noise(x >> 1, y >> 1) * 0.6 + noise(x >> 3, y >> 3, 7) * 0.4;
    const edge = x % 64 === 0 || y % 64 === 0;
    const k = edge ? 0.75 : 1;
    grass.set(x, y, [Math.round((70 + 40 * n) * k), Math.round((120 + 50 * n) * k), Math.round((45 + 30 * n) * k), 255]);
  }
  return { "gxgrass.tga": grass };
}

export function writeFreeImages(outDir: string): string[] {
  const names: string[] = [];
  const write = (sub: string, images: Record<string, Image32>) => {
    const dir = join(outDir, "Art", sub);
    mkdirSync(dir, { recursive: true });
    for (const [name, img] of Object.entries(images)) {
      writeFileSync(join(dir, name), encodeTga(img));
      names.push(`${sub}/${name}`);
    }
  };
  write("Textures", generateFreeImages());
  write("Terrain", generateTerrainImages());
  return names;
}

if (process.argv[1] && /tga\.ts$/.test(process.argv[1])) {
  const [cmd, outDir] = process.argv.slice(2);
  if (cmd === "gen" && outDir) console.log(writeFreeImages(outDir).join("\n"));
  else { console.error("usage: tga.ts gen <outDir>"); process.exit(2); }
}
