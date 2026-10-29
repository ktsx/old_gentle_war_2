/**
 * cameos.ts — procedural cameos for the command bar and the selection portrait.
 *
 * The corpus' MappedImages give every unit, building, upgrade and power a picture (ButtonImage —
 * 60x48 on the command bar — and SelectPortrait, 120x96 in the right HUD) inside textures the free
 * set does not have. mapped-images.ts draws a labelled tile for each rectangle; for the images the
 * INIs use as cameos this draws a readable icon instead, in the same rectangle:
 *
 *   background  the side's colour (America blue, China red, GLA sand, neutral steel), lit from the top
 *   silhouette  by what the image stands for —
 *                 infantry / vehicle / aircraft / structure  (Object KindOf, else EditorSorting)
 *                 upgrade (chevrons), special power (burst), general's promotion (medal),
 *                 orders: sell ($), stop (square), other commands (diamond)
 *   label       the display name in the 5x7 pixel font, one line (2x on the big 120x96 images)
 *
 * What an image stands for is read from the INIs: Object blocks (SelectPortrait, ButtonImage,
 * Side, KindOf, EditorSorting, DisplayName), CommandButton blocks (ButtonImage, Command, Object,
 * Upgrade, TextLabel) and Upgrade blocks (ButtonImage, DisplayName); labels resolve through the
 * patch's generals.str. Objects win over buttons over upgrades when an image is shared.
 *
 * The INI scan here goes by indentation (top-level blocks start in column 0, their own properties
 * are indented by at most two spaces): inventory.ts' block parser ends some objects early.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Image32, RGBA } from "./tga.ts";
import { drawText, textWidth, GLYPH_W, GLYPH_H } from "./pixelfont.ts";
import { parseStr } from "./strings.ts";

export type CameoKind = "infantry" | "vehicle" | "aircraft" | "structure" | "upgrade" | "power" | "science" | "sell" | "stop" | "order";
export type CameoSide = "America" | "China" | "GLA" | "neutral";
export interface CameoInfo { kind: CameoKind; side: CameoSide; label: string }

interface Block { kind: string; name: string; props: Map<string, string> }

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ini$/i.test(e)) out.push(p);
  }
  return out;
}

const KINDS = /^(Object|ObjectReskin|CommandButton|Upgrade)\s+(\S+)/;

/** Top-level blocks of the wanted kinds with their first shallow `Key = value` properties. */
function scan(iniDir: string): Block[] {
  const out: Block[] = [];
  for (const f of walk(iniDir)) {
    let cur: Block | null = null;
    for (const raw of readFileSync(f, "latin1").split(/\r?\n/)) {
      const line = raw.replace(/;.*$/, "").replace(/\/\/.*$/, "");
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) {                       // column 0: a block opens or closes
        const m = KINDS.exec(line.trim());
        if (m) { cur = { kind: m[1], name: m[2], props: new Map() }; out.push(cur); continue; }
        if (/^End\b/i.test(line.trim())) { cur = null; continue; }
        continue;
      }
      if (!cur) continue;
      const m = /^( {0,2}|\t)(\w+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !cur.props.has(m[2].toLowerCase())) cur.props.set(m[2].toLowerCase(), m[3]);
    }
  }
  return out;
}

const sideOf = (side: string | undefined): CameoSide | undefined => {
  if (!side) return undefined;
  if (/america/i.test(side)) return "America";
  if (/china/i.test(side)) return "China";
  if (/gla/i.test(side)) return "GLA";
  return "neutral";
};
/** Image names start with the side: SA… America, SN… China, SU… GLA (SS… shared). */
const sideFromImage = (name: string): CameoSide =>
  /^SA/i.test(name) ? "America" : /^SN/i.test(name) ? "China" : /^SU/i.test(name) ? "GLA" : "neutral";
/** The object's side; when that says nothing (Civilian, a cinematic copy), the image's prefix. */
const pickSide = (side: string | undefined, image: string): CameoSide => {
  const s = sideOf(side);
  return s && s !== "neutral" ? s : sideFromImage(image);
};

function objectKind(p: Map<string, string>): CameoKind {
  const kinds = (p.get("kindof") ?? "").toUpperCase().split(/\s+/);
  if (kinds.includes("AIRCRAFT")) return "aircraft";
  if (kinds.includes("INFANTRY")) return "infantry";
  if (kinds.includes("STRUCTURE")) return "structure";
  if (kinds.includes("VEHICLE")) return "vehicle";
  const sort = (p.get("editorsorting") ?? "").toUpperCase();
  if (sort.includes("INFANTRY")) return "infantry";
  if (sort.includes("STRUCTURE") || sort.includes("SYSTEM")) return "structure";
  if (sort.includes("VEHICLE")) return "vehicle";
  return "order";
}

function commandKind(cmd: string): CameoKind {
  if (/UPGRADE/.test(cmd)) return "upgrade";
  if (/SPECIAL_POWER|FIRE_WEAPON|COMBATDROP|OVERCHARGE/.test(cmd)) return "power";
  if (/PURCHASE_SCIENCE/.test(cmd)) return "science";
  if (/^SELL$/.test(cmd)) return "sell";
  if (/^STOP$/.test(cmd)) return "stop";
  return "order";
}

/** "&Crusader Tank" -> "Crusader Tank", "Stop: S" -> "Stop" (the hotkey hint); empty when unknown. */
function cleanLabel(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/&/g, "").replace(/\\n|\n/g, " ").replace(/[^\x20-\x7e]/g, "")
    .replace(/:\s*\S?\s*$/, "").replace(/\s+/g, " ").trim();
}

/** "SNNukeLaunch" -> "Nuke Launch", "GLAVehicleTechnical" -> "Technical": a name to show when no label resolves. */
function humanize(id: string, isImage: boolean): string {
  let n = id.replace(/_L$/i, "").replace(/^(AirF|Lazr|SupW|Nuke|Tank|Infa|Chem|Demo|Slth|Boss|GC|CINE)_/i, "");
  if (isImage) n = n.replace(/^S[ANUSC]C?(?=[A-Z])/, "");
  n = n.replace(/^(America|China|GLA)(Vehicle|Infantry|Jet|Tank|Building|Unit)?/, "");
  return n.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/_/g, " ").trim();
}

/** Image name -> what it stands for. */
export function collectCameos(patchDataDir: string): Map<string, CameoInfo> {
  const strings = new Map<string, string>();
  for (const e of parseStr(readFileSync(join(patchDataDir, "generals.str"), "utf8"), "US")) strings.set(e.label.toLowerCase(), e.text);
  const tr = (label: string | undefined) => (label ? cleanLabel(strings.get(label.toLowerCase())) : "");

  const blocks = scan(join(patchDataDir, "INI"));
  const objects = new Map<string, Block>();
  for (const b of blocks) if (b.kind === "Object") objects.set(b.name.toLowerCase(), b);

  const out = new Map<string, CameoInfo>();
  const put = (image: string | undefined, info: CameoInfo) => {
    if (!image) return;
    const key = image.toLowerCase();
    if (!out.has(key)) out.set(key, info);
  };

  // objects first: their portrait and button
  for (const b of blocks) {
    if (b.kind !== "Object") continue;
    const p = b.props;
    const image = p.get("selectportrait") ?? p.get("buttonimage");
    if (!image) continue;
    const info: CameoInfo = {
      kind: objectKind(p),
      side: pickSide(p.get("side"), image),
      label: tr(p.get("displayname")) || humanize(b.name, false),
    };
    put(p.get("selectportrait"), info);
    put(p.get("buttonimage"), info);
  }
  // command buttons: what they build or do
  for (const b of blocks) {
    if (b.kind !== "CommandButton") continue;
    const p = b.props;
    const image = p.get("buttonimage");
    if (!image) continue;
    const cmd = (p.get("command") ?? "").toUpperCase();
    const obj = p.get("object") ? objects.get(p.get("object")!.toLowerCase()) : undefined;
    if (obj && /UNIT_BUILD|DOZER_CONSTRUCT/.test(cmd)) {
      put(image, {
        kind: objectKind(obj.props),
        side: pickSide(obj.props.get("side"), image),
        label: tr(obj.props.get("displayname")) || tr(p.get("textlabel")) || humanize(image, true),
      });
      continue;
    }
    put(image, { kind: commandKind(cmd), side: sideFromImage(image), label: tr(p.get("textlabel")) || humanize(image, true) });
  }
  // upgrades not reached through a button
  for (const b of blocks) {
    if (b.kind !== "Upgrade") continue;
    const image = b.props.get("buttonimage");
    if (image) put(image, { kind: "upgrade", side: sideFromImage(image), label: tr(b.props.get("displayname")) || humanize(image, true) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------------------------

const SIDE_COLOR: Record<CameoSide, RGBA> = {
  America: [46, 82, 150, 255],
  China: [150, 44, 40, 255],
  GLA: [138, 112, 58, 255],
  neutral: [74, 82, 94, 255],
};
const mix = (a: RGBA, b: RGBA, t: number): RGBA =>
  [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), 255];

/** A shape drawn into a 32x24 design box, scaled by `s` and placed at (ox, oy). */
class Pen {
  img: Image32; ox: number; oy: number; s: number; c: RGBA;
  constructor(img: Image32, ox: number, oy: number, s: number, c: RGBA) { this.img = img; this.ox = ox; this.oy = oy; this.s = s; this.c = c; }
  rect(x: number, y: number, w: number, h: number) { this.img.fillRect(this.ox + Math.round(x * this.s), this.oy + Math.round(y * this.s), Math.max(1, Math.round(w * this.s)), Math.max(1, Math.round(h * this.s)), this.c); }
  disc(cx: number, cy: number, r: number) {
    const R = r * this.s, X = this.ox + cx * this.s, Y = this.oy + cy * this.s;
    for (let y = Math.floor(Y - R); y <= Math.ceil(Y + R); y++)
      for (let x = Math.floor(X - R); x <= Math.ceil(X + R); x++)
        if ((x + 0.5 - X) ** 2 + (y + 0.5 - Y) ** 2 <= R * R) this.img.set(x, y, this.c);
  }
  line(x0: number, y0: number, x1: number, y1: number, t: number) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * this.s * 2) + 1;
    for (let i = 0; i <= n; i++) { const f = i / n; this.disc(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, t / 2); }
  }
  /** Rows from y0 to y1 whose half-width runs linearly from w0 to w1 around cx. */
  taper(cx: number, y0: number, y1: number, w0: number, w1: number) {
    const rows = Math.max(1, Math.round((y1 - y0) * this.s));
    for (let i = 0; i < rows; i++) {
      const f = rows === 1 ? 0 : i / (rows - 1), hw = (w0 + (w1 - w0) * f) * this.s;
      const y = this.oy + Math.round(y0 * this.s) + i, x = this.ox + cx * this.s;
      this.img.fillRect(Math.round(x - hw), y, Math.max(1, Math.round(2 * hw)), 1, this.c);
    }
  }
}

function silhouette(p: Pen, kind: CameoKind) {
  switch (kind) {
    case "infantry":
      p.disc(16, 4, 3); p.rect(13, 8, 6, 8); p.rect(10, 9, 12, 2); p.rect(13, 16, 2, 7); p.rect(17, 16, 2, 7); p.rect(19, 7, 9, 1.5);
      break;
    case "vehicle":
      p.rect(3, 17, 26, 5); p.rect(5, 12, 22, 6); p.rect(11, 7, 10, 6); p.rect(20, 9, 11, 2);
      break;
    case "aircraft":
      p.taper(16, 2, 22, 1.5, 2.5); p.taper(16, 8, 14, 2, 14); p.taper(16, 18, 22, 1.5, 6);
      break;
    case "structure":
      p.taper(16, 2, 9, 2, 14); p.rect(4, 9, 24, 14); p.rect(14, 15, 4, 8); p.rect(7, 12, 4, 3); p.rect(21, 12, 4, 3);
      break;
    case "upgrade":
      p.line(8, 12, 16, 4, 3); p.line(16, 4, 24, 12, 3); p.line(8, 21, 16, 13, 3); p.line(16, 13, 24, 21, 3);
      break;
    case "power":
      p.disc(16, 12, 5);
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; p.line(16, 12, 16 + Math.cos(a) * 11, 12 + Math.sin(a) * 11, 2); }
      break;
    case "science":
      p.taper(16, 0, 8, 6, 3); p.disc(16, 14, 8);
      break;
    case "sell": {
      // a large '$' from the pixel font
      p.rect(15, 1, 2, 22); p.rect(9, 4, 14, 3); p.rect(9, 4, 3, 8); p.rect(9, 10, 14, 3); p.rect(20, 10, 3, 8); p.rect(9, 16, 14, 3);
      break;
    }
    case "stop":
      p.rect(8, 4, 16, 16);
      break;
    default:
      p.taper(16, 2, 12, 0.5, 9); p.taper(16, 12, 22, 9, 0.5);
  }
}

/** Leading words that say little on a cameo ("Construction Dozer" -> "Dozer") when the name does not fit. */
const FILLER = new Set(["CONSTRUCTION", "AMERICA", "AMERICAN", "CHINA", "CHINESE", "GLA", "TACTICAL", "UPGRADE"]);

/**
 * Fit a label. One line (a button): the name if it fits, else its first two words with the longest
 * one shortened a letter at a time (down to 3) — "War Factory" -> "WAR FACTO", "Nuclear Reactor" ->
 * "NUCL REAC" — so related buildings stay apart. Two lines (a portrait): word-wrapped.
 */
function labelLines(label: string, maxChars: number, maxLines: number): string[] {
  let words = label.toUpperCase().split(" ").filter(Boolean);
  while (words.length > 1 && words.join(" ").length > maxChars * maxLines && FILLER.has(words[0])) words = words.slice(1);
  if (!words.length) return [];
  if (maxLines === 1) {
    if (words.join(" ").length <= maxChars) return [words.join(" ")];
    let w = words.slice(0, 2);
    while (w.join(" ").length > maxChars) {
      let longest = 0;
      for (let i = 1; i < w.length; i++) if (w[i].length > w[longest].length) longest = i;
      if (w[longest].length <= 3) { w = w.slice(0, 1); break; }
      w[longest] = w[longest].slice(0, -1);
    }
    return [w.join(" ").slice(0, maxChars)];
  }
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= maxChars) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = word.slice(0, maxChars);
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

/** Draw the cameo for `info` into the rectangle (l, t, w, h) of an atlas. */
export function drawCameo(img: Image32, l: number, t: number, w: number, h: number, info: CameoInfo) {
  const base = SIDE_COLOR[info.side];
  const top = mix(base, [255, 255, 255, 255], 0.18), bottom = mix(base, [0, 0, 0, 255], 0.45);
  for (let y = 0; y < h; y++) img.fillRect(l, t + y, w, 1, mix(top, bottom, h > 1 ? y / (h - 1) : 0));
  img.strokeRect(l, t, w, h, mix(base, [0, 0, 0, 255], 0.7));
  img.fillRect(l + 1, t + 1, w - 2, 1, mix(base, [255, 255, 255, 255], 0.4));

  // A big image (120x96 — portraits, but some buttons use one too and get drawn at half size)
  // gets the 2x font, one line: legible either way.
  const big = w >= 100 && h >= 80;
  const fs = big ? 2 : 1;
  const bandH = (GLYPH_H + 3) * fs;
  const areaH = h - bandH - 2;
  const s = Math.max(0.5, Math.min((w - 8) / 32, areaH / 24) * (big ? 0.9 : 1));
  const ox = l + Math.round((w - 32 * s) / 2), oy = t + 2 + Math.round((areaH - 24 * s) / 2);
  const light: RGBA = [236, 238, 242, 255], shadow: RGBA = [10, 12, 16, 200];
  silhouette(new Pen(img, ox + 1, oy + 1, s, shadow), info.kind);
  silhouette(new Pen(img, ox, oy, s, light), info.kind);

  // label band
  const bandY = t + h - bandH;
  img.fillRect(l + 1, bandY, w - 2, bandH - 1, mix(base, [0, 0, 0, 255], 0.65));
  const maxChars = Math.max(1, Math.floor((w - 4) / ((GLYPH_W + 1) * fs)));
  const lines = labelLines(info.label, maxChars, 1);
  const y = bandY + Math.floor((bandH - GLYPH_H * fs) / 2);
  for (const ln of lines) drawText(img, l + Math.floor((w - textWidth(ln, fs)) / 2), y, ln, [240, 226, 170, 255], fs);
}
