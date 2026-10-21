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

  return { "gxlogo.tga": logo, "gxbutton.tga": btn, "gxbutton_hi.tga": btnHi, "gxbutton_dis.tga": btnDis };
}

export function writeFreeImages(outDir: string): string[] {
  const dir = join(outDir, "Art", "Textures");
  mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  for (const [name, img] of Object.entries(generateFreeImages())) {
    writeFileSync(join(dir, name), encodeTga(img));
    names.push(name);
  }
  return names;
}

if (process.argv[1] && /tga\.ts$/.test(process.argv[1])) {
  const [cmd, outDir] = process.argv.slice(2);
  if (cmd === "gen" && outDir) console.log(writeFreeImages(outDir).join("\n"));
  else { console.error("usage: tga.ts gen <outDir>"); process.exit(2); }
}
