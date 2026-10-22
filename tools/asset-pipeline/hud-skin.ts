#!/usr/bin/env node --experimental-strip-types
/**
 * hud-skin.ts — the free asset set's control-bar skin: one 512x512 atlas per faction
 * (gxhud_<side>.tga), the MappedImage definitions for its parts, and our own
 * ControlBarScheme.ini that wires them into the engine (positions of the money display,
 * power bar and side buttons, the background ImageParts, button images per state).
 *
 * All art is procedural (plates, bevels, glyphs) and lives in the same 800x600 geometry
 * that assets-free/windows/ControlBar.wnd.json (gen-hud-layouts.ts) uses — HUD below
 * is the single source of truth for both.
 *
 * Usage (standalone, for a look at the atlases):
 *   node --experimental-strip-types tools/asset-pipeline/hud-skin.ts <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Image32, encodeTga, type RGBA } from "./tga.ts";
import { drawText, textWidth } from "./pixelfont.ts";

// ---------------------------------------------------------------------------
// Geometry (800x600 layout space)
// ---------------------------------------------------------------------------
export const HUD = {
  barTop: 440, barHeight: 160,                     // the bar art covers y 440..600
  radar: [8, 448, 158, 142] as const,              // LeftHUD
  expBar: [172, 448, 10, 142] as const,            // GeneralsExp (vertical)
  sideX: 188, sideW: 38, sideH: 26,                // side button column
  sideY: { options: 448, worker: 478, beacon: 508, chat: 538 },
  general: [188, 568, 38, 22] as const,
  minMax: [188, 594, 38, 5] as const,              // off the bottom edge, hidden anyway
  uAttack: [140, 412, 36, 18] as const,            // above the bar (retail position)
  money: [232, 446, 100, 18] as const,
  power: [340, 450, 254, 10] as const,
  grid: { x: 234, y: 470, cols: 6, rows: 3, w: 58, h: 40, gap: 2 },
  rightHud: [600, 446, 196, 150] as const,
  portrait: [608, 452, 120, 88] as const,          // inside rightHud
  upgradeY: 548,
};
export const SIDES = ["USA", "China", "GLA"] as const;
export type Side = typeof SIDES[number];

/** PlayerTemplate "Side" names (PlayerTemplate.ini) → our skin. The engine picks a scheme by exact side name. */
export const SIDE_SCHEMES: Record<string, Side> = {
  America: "USA", AmericaSuperWeaponGeneral: "USA", AmericaLaserGeneral: "USA", AmericaAirForceGeneral: "USA",
  China: "China", ChinaTankGeneral: "China", ChinaInfantryGeneral: "China", ChinaNukeGeneral: "China", Boss: "China",
  GLA: "GLA", GLAToxinGeneral: "GLA", GLADemolitionGeneral: "GLA", GLAStealthGeneral: "GLA",
  Observer: "USA", Civilian: "USA",
};

const ACCENT: Record<Side, RGBA> = { USA: [70, 125, 225, 255], China: [215, 65, 55, 255], GLA: [125, 175, 60, 255] };

// palette
const STEEL: RGBA = [38, 43, 53, 255], STEEL_DK: RGBA = [26, 29, 36, 255], STEEL_LT: RGBA = [58, 65, 80, 255];
const EDGE_LT: RGBA = [96, 106, 128, 255], EDGE_DK: RGBA = [14, 16, 20, 255], OUTLINE: RGBA = [8, 9, 12, 255];
const SLOT: RGBA = [16, 18, 23, 255], TEXT: RGBA = [222, 226, 232, 255], TEXT_DIM: RGBA = [120, 128, 142, 255];

// ---------------------------------------------------------------------------
// Atlas regions
// ---------------------------------------------------------------------------
interface Region { name: string; x: number; y: number; w: number; h: number }
const REG = {
  barL: { x: 0, y: 0, w: 400, h: 160 }, barR: { x: 0, y: 160, w: 400, h: 160 },
  rightHud: { x: 0, y: 320, w: 196, h: 150 },
  // side buttons: 4 states (enabled, hilite, pushed, disabled) per purpose
  side: { x: 200, y: 320, step: 40, w: 38, h: 26, rows: { options: 320, worker: 348, beacon: 376, chat: 404 } },
  general: { x: 200, y: 432, step: 40, w: 38, h: 22 },
  minMax: { x: 200, y: 458, step: 40, w: 38, h: 22 },
  uAttack: { x: 200, y: 484, step: 40, w: 36, h: 18 },
  queue: { x: 364, y: 320, w: 36, h: 36 },
  cameo: { x: 404, y: 320, w: 58, h: 40 },         // empty command-button plate
  frame: { x: 404, y: 364, w: 58, h: 40 },         // CommandMarkerImage (frame only, transparent inside)
  power: { x: 404, y: 410, w: 8, h: 10, step: 12 }, // G, Y, R
  expFg: { x: 444, y: 410, w: 10, h: 16 },
  panel: { x: 404, y: 440, w: 64, h: 64 },         // generic plate (PowerPurchaseImage etc.)
  genArrow: { x: 472, y: 410, w: 16, h: 16 },
};

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function rivet(img: Image32, x: number, y: number) {
  img.set(x, y, EDGE_LT); img.set(x + 1, y, STEEL_DK); img.set(x, y + 1, STEEL_DK); img.set(x + 1, y + 1, EDGE_DK);
}

/** Bar body: brushed dark steel with a top edge, a light seam under the status strip and screw rivets. */
function drawBar(img: Image32, side: Side) {
  const W = 800, H = HUD.barHeight;
  const bar = new Image32(W, H);
  bar.vGradient(0, 0, W, H, [44, 49, 60, 255], [28, 31, 38, 255]);
  // subtle horizontal brushing
  for (let y = 0; y < H; y += 3) bar.blendRect(0, y, W, 1, [255, 255, 255, 6]);
  // top edge: accent line + light bevel
  bar.fillRect(0, 0, W, 1, EDGE_LT); bar.fillRect(0, 1, W, 2, ACCENT[side]); bar.fillRect(0, 3, W, 1, STEEL_DK);
  bar.fillRect(0, H - 1, W, 1, EDGE_DK);
  // recessed slots where the windows sit (so transparent windows show a framed hole)
  const slot = (r: readonly [number, number, number, number], pad = 3) =>
    { bar.plate(r[0] - pad, r[1] - HUD.barTop - pad, r[2] + 2 * pad, r[3] + 2 * pad, STEEL_LT, EDGE_LT, EDGE_DK, OUTLINE);
      bar.slot(r[0] - 1, r[1] - HUD.barTop - 1, r[2] + 2, r[3] + 2, SLOT, EDGE_LT, EDGE_DK); };
  slot(HUD.radar); slot(HUD.expBar, 2); slot(HUD.money, 2); slot(HUD.power, 2);
  // command grid plate
  const g = HUD.grid;
  const gw = g.cols * (g.w + g.gap) - g.gap, gh = g.rows * (g.h + g.gap) - g.gap;
  bar.plate(g.x - 4, g.y - HUD.barTop - 4, gw + 8, gh + 8, STEEL_DK, EDGE_DK, EDGE_LT, OUTLINE);
  // side button column plate
  bar.plate(HUD.sideX - 3, HUD.sideY.options - HUD.barTop - 3, HUD.sideW + 6, (HUD.general[1] + HUD.general[3]) - HUD.sideY.options + 6, STEEL, EDGE_LT, EDGE_DK, OUTLINE);
  // right HUD plate (the RightHUD window draws its own art on top; this is the frame)
  const r = HUD.rightHud;
  bar.plate(r[0] - 3, r[1] - HUD.barTop - 3, r[2] + 6, r[3] + 6, STEEL_LT, EDGE_LT, EDGE_DK, OUTLINE);
  // rivets along the top edge
  for (let x = 12; x < W; x += 56) rivet(bar, x, 6);
  for (let x = 12; x < W; x += 56) rivet(bar, x, H - 8);
  img.copy(bar, 0, 0, 400, 160, REG.barL.x, REG.barL.y);
  img.copy(bar, 400, 0, 400, 160, REG.barR.x, REG.barR.y);
}

/** Right HUD: portrait slot, upgrade cameo row, faction emblem. */
function drawRightHud(img: Image32, side: Side) {
  const r = REG.rightHud, a = ACCENT[side];
  img.vGradient(r.x, r.y, r.w, r.h, [46, 52, 64, 255], [30, 34, 42, 255]);
  img.strokeRect(r.x, r.y, r.w, r.h, EDGE_LT);
  const px = HUD.portrait[0] - HUD.rightHud[0], py = HUD.portrait[1] - HUD.rightHud[1];
  img.slot(r.x + px - 1, r.y + py - 1, HUD.portrait[2] + 2, HUD.portrait[3] + 2, SLOT, EDGE_LT, EDGE_DK);
  // emblem: accent roundel with the side's name
  const ex = r.x + 162, ey = r.y + 50;
  img.disc(ex, ey, 24, STEEL_DK); img.ring(ex, ey, 24, EDGE_LT); img.ring(ex, ey, 20, a);
  const label = side.toUpperCase();
  const sc = label.length > 3 ? 1 : 2;
  drawText(img, ex - Math.floor(textWidth(label, sc) / 2), ey - 3 * sc, label, TEXT, sc);
  // upgrade cameo slots
  const uy = HUD.upgradeY - HUD.rightHud[1];
  for (let i = 0; i < 5; i++) img.slot(r.x + px + i * 24, r.y + uy, 22, 22, SLOT, EDGE_LT, EDGE_DK);
  img.fillRect(r.x + 8, r.y + r.h - 8, r.w - 16, 1, a);
}

type State = "on" | "hi" | "push" | "off";
function buttonPlate(img: Image32, x: number, y: number, w: number, h: number, state: State, accent: RGBA) {
  const fill: RGBA = state === "hi" ? [62, 70, 88, 255] : state === "push" ? [28, 31, 38, 255] : state === "off" ? [30, 32, 38, 255] : STEEL;
  const lt: RGBA = state === "push" ? EDGE_DK : state === "hi" ? [140, 150, 175, 255] : EDGE_LT;
  const dk: RGBA = state === "push" ? EDGE_LT : EDGE_DK;
  img.plate(x, y, w, h, fill, lt, dk, OUTLINE);
  if (state === "hi") img.fillRect(x + 2, y + h - 3, w - 4, 1, accent);
}
const glyphColor = (state: State): RGBA => state === "off" ? TEXT_DIM : TEXT;

/** Simple icons for the side buttons. */
function icon(img: Image32, kind: string, cx: number, cy: number, c: RGBA) {
  switch (kind) {
    case "options": // gear: ring + 4 teeth + hub
      img.ring(cx, cy, 6, c); img.ring(cx, cy, 5, c);
      for (const [dx, dy] of [[0, -8], [0, 8], [-8, 0], [8, 0], [-6, -6], [6, 6], [-6, 6], [6, -6]]) img.fillRect(cx + dx - 1, cy + dy - 1, 3, 3, c);
      img.disc(cx, cy, 2, c);
      break;
    case "worker": // hard hat + wrench
      img.disc(cx - 2, cy - 1, 6, c); img.fillRect(cx - 10, cy + 2, 16, 2, c);
      img.line(cx + 4, cy + 7, cx + 10, cy + 1, c); img.line(cx + 5, cy + 8, cx + 11, cy + 2, c);
      break;
    case "beacon": // map pin
      img.disc(cx, cy - 3, 5, c); img.line(cx - 4, cy - 1, cx, cy + 8, c); img.line(cx + 4, cy - 1, cx, cy + 8, c); img.line(cx - 3, cy, cx, cy + 8, c); img.line(cx + 3, cy, cx, cy + 8, c);
      img.disc(cx, cy - 3, 2, STEEL_DK);
      break;
    case "chat": // speech bubble
      img.fillRect(cx - 8, cy - 6, 16, 10, c); img.fillRect(cx - 4, cy + 4, 4, 3, c); img.fillRect(cx - 5, cy - 3, 10, 1, STEEL_DK); img.fillRect(cx - 5, cy, 7, 1, STEEL_DK);
      break;
    case "star": { // five-point star
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) { const rr = i % 2 ? 4 : 9, ang = -Math.PI / 2 + (i * Math.PI) / 5; pts.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]); }
      for (let i = 0; i < 10; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % 10]; img.line(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), c); }
      img.disc(cx, cy, 3, c);
      break;
    }
    case "chevron":
      for (let i = 0; i < 2; i++) { img.line(cx - 8, cy + 3 + i, cx, cy - 4 + i, c); img.line(cx, cy - 4 + i, cx + 8, cy + 3 + i, c); }
      break;
    case "attack": // crosshair
      img.ring(cx, cy, 6, c); img.fillRect(cx - 8, cy, 17, 1, c); img.fillRect(cx, cy - 8, 1, 17, c); img.disc(cx, cy, 1, c);
      break;
  }
}

function drawButtons(img: Image32, side: Side) {
  const a = ACCENT[side];
  const states: State[] = ["on", "hi", "push", "off"];
  for (const [purpose, y] of Object.entries(REG.side.rows)) {
    states.forEach((st, i) => {
      const x = REG.side.x + i * REG.side.step;
      buttonPlate(img, x, y, REG.side.w, REG.side.h, st, a);
      icon(img, purpose, x + REG.side.w / 2, y + REG.side.h / 2 + (st === "push" ? 1 : 0), glyphColor(st));
    });
  }
  states.forEach((st, i) => {
    const g = REG.general, x = g.x + i * g.step;
    buttonPlate(img, x, g.y, g.w, g.h, st, a); icon(img, "star", x + g.w / 2, g.y + g.h / 2, st === "off" ? TEXT_DIM : [240, 200, 70, 255]);
    const m = REG.minMax, mx = m.x + i * m.step;
    if (i < 3) { buttonPlate(img, mx, m.y, m.w, m.h, st, a); icon(img, "chevron", mx + m.w / 2, m.y + m.h / 2, glyphColor(st)); }
    const u = REG.uAttack, ux = u.x + i * u.step;
    if (i < 3) { buttonPlate(img, ux, u.y, u.w, u.h, st, a); icon(img, "attack", ux + u.w / 2, u.y + u.h / 2, [230, 90, 70, 255]); }
  });
  // queue button plate (QueueButtonImage): recessed slot with a faint accent frame
  const q = REG.queue;
  img.slot(q.x, q.y, q.w, q.h, [24, 27, 33, 255], EDGE_LT, EDGE_DK); img.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2, STEEL_DK);
  // empty command-button plate
  const c = REG.cameo;
  img.plate(c.x, c.y, c.w, c.h, [34, 38, 47, 255], EDGE_LT, EDGE_DK, OUTLINE);
  for (let yy = c.y + 4; yy < c.y + c.h - 4; yy += 4) for (let xx = c.x + 4; xx < c.x + c.w - 4; xx += 4) img.set(xx, yy, STEEL_LT);
  // command marker frame: transparent inside, accent outline
  const f = REG.frame;
  img.fillRect(f.x, f.y, f.w, f.h, [0, 0, 0, 0]); img.strokeRect(f.x, f.y, f.w, f.h, a); img.strokeRect(f.x + 1, f.y + 1, f.w - 2, f.h - 2, [a[0], a[1], a[2], 140]);
  // power points
  const p = REG.power;
  ([[60, 200, 90], [230, 190, 50], [225, 60, 50]] as [number, number, number][]).forEach((col, i) => {
    const x = p.x + i * p.step;
    img.vGradient(x, p.y, p.w, p.h, [col[0], col[1], col[2], 255], [col[0] >> 1, col[1] >> 1, col[2] >> 1, 255]);
    img.fillRect(x, p.y, 1, p.h, EDGE_DK);
  });
  // exp bar foreground
  const e = REG.expFg;
  img.vGradient(e.x, e.y, e.w, e.h, [255, 220, 110, 255], [200, 150, 40, 255]); img.fillRect(e.x, e.y, 1, e.h, [255, 240, 180, 255]);
  // generic plate
  const pl = REG.panel;
  img.plate(pl.x, pl.y, pl.w, pl.h, STEEL, EDGE_LT, EDGE_DK, OUTLINE);
  // gen arrow (rank-up marker)
  const ga = REG.genArrow;
  for (let i = 0; i < 8; i++) img.fillRect(ga.x + 7 - i, ga.y + 2 + i, 2 * i + 1, 1, [240, 200, 70, 255]);
  img.fillRect(ga.x + 5, ga.y + 10, 6, 5, [240, 200, 70, 255]);
}

export function buildAtlas(side: Side): Image32 {
  const img = new Image32(512, 512, [0, 0, 0, 0]);
  drawBar(img, side);
  drawRightHud(img, side);
  drawButtons(img, side);
  return img;
}

// ---------------------------------------------------------------------------
// INI text
// ---------------------------------------------------------------------------
function mapped(name: string, tex: string, x: number, y: number, w: number, h: number): string {
  return `MappedImage ${name}\n  Texture = ${tex}\n  TextureWidth = 512\n  TextureHeight = 512\n  Coords = Left:${x} Top:${y} Right:${x + w} Bottom:${y + h}\n  Status = NONE\nEnd\n`;
}

/** Every region as a MappedImage, prefixed Gx<Side>_. */
export function mappedImagesIni(side: Side): string {
  const tex = `gxhud_${side.toLowerCase()}.tga`, P = `Gx${side}_`;
  const out: string[] = [`; generated by tools/asset-pipeline/hud-skin.ts — control bar skin parts (${side})`, ""];
  const add = (n: string, r: { x: number; y: number; w: number; h: number }) => out.push(mapped(P + n, tex, r.x, r.y, r.w, r.h));
  add("BarL", REG.barL); add("BarR", REG.barR); add("RightHud", REG.rightHud);
  const st = ["", "H", "P", "I"]; // enabled, hilite, pushed, disabled (retail suffix convention)
  for (const [purpose, y] of Object.entries(REG.side.rows)) {
    const n = purpose[0].toUpperCase() + purpose.slice(1);
    st.forEach((s, i) => add(n + s, { x: REG.side.x + i * REG.side.step, y, w: REG.side.w, h: REG.side.h }));
  }
  st.forEach((s, i) => add("General" + s, { x: REG.general.x + i * REG.general.step, y: REG.general.y, w: REG.general.w, h: REG.general.h }));
  ["", "H", "P"].forEach((s, i) => add("MinMax" + s, { x: REG.minMax.x + i * REG.minMax.step, y: REG.minMax.y, w: REG.minMax.w, h: REG.minMax.h }));
  ["", "H", "P"].forEach((s, i) => add("UAttack" + s, { x: REG.uAttack.x + i * REG.uAttack.step, y: REG.uAttack.y, w: REG.uAttack.w, h: REG.uAttack.h }));
  add("Queue", REG.queue); add("Cameo", REG.cameo); add("Frame", REG.frame); add("Panel", REG.panel); add("GenArrow", REG.genArrow); add("ExpBar", REG.expFg);
  ["G", "Y", "R"].forEach((s, i) => add("Power" + s, { x: REG.power.x + i * REG.power.step, y: REG.power.y, w: REG.power.w, h: REG.power.h }));
  return out.join("\n");
}

/** W3DPowerDraw looks these names up directly (W3DControlBar.cpp); they are side-independent. */
export function powerPointsIni(): string {
  const tex = "gxhud_usa.tga";
  return ["; generated by tools/asset-pipeline/hud-skin.ts — power bar points used by W3DPowerDraw", "",
    mapped("PowerPointG", tex, REG.power.x, REG.power.y, REG.power.w, REG.power.h),
    mapped("PowerPointY", tex, REG.power.x + REG.power.step, REG.power.y, REG.power.w, REG.power.h),
    mapped("PowerPointR", tex, REG.power.x + 2 * REG.power.step, REG.power.y, REG.power.w, REG.power.h)].join("\n");
}

function schemeBlock(sideName: string, skin: Side): string {
  const P = `Gx${skin}_`, a = ACCENT[skin];
  const ul = (r: readonly [number, number, number, number]) => `X:${r[0]} Y:${r[1]}`;
  const lr = (r: readonly [number, number, number, number]) => `X:${r[0] + r[2]} Y:${r[1] + r[3]}`;
  const side = (y: number): readonly [number, number, number, number] => [HUD.sideX, y, HUD.sideW, HUD.sideH];
  return `ControlBarScheme Gx${sideName}8x6
  ScreenCreationRes X:800 Y:600
  Side ${sideName}
  QueueButtonImage ${P}Queue
  RightHUDImage ${P}RightHud
  CommandBarBorderColor R:${a[0]} G:${a[1]} B:${a[2]} A:255
  BuildUpClockColor R:0 G:0 B:0 A:160
  ButtonBorderBuildColor R:67 G:108 B:190 A:255
  ButtonBorderActionColor R:1 G:175 B:2 A:255
  ButtonBorderUpgradeColor R:208 G:108 B:0 A:255
  ButtonBorderSystemColor R:207 G:195 B:2 A:255
  GenBarButtonIn ${P}GeneralH
  GenBarButtonOn ${P}General
  ToggleButtonUpIn ${P}MinMaxH
  ToggleButtonUpOn ${P}MinMax
  ToggleButtonUpPushed ${P}MinMaxP
  ToggleButtonDownIn ${P}MinMaxH
  ToggleButtonDownOn ${P}MinMax
  ToggleButtonDownPushed ${P}MinMaxP
  OptionsButtonEnable ${P}Options
  OptionsButtonHightlited ${P}OptionsH
  OptionsButtonPushed ${P}OptionsP
  OptionsButtonDisabled ${P}OptionsI
  IdleWorkerButtonEnable ${P}Worker
  IdleWorkerButtonHightlited ${P}WorkerH
  IdleWorkerButtonPushed ${P}WorkerP
  IdleWorkerButtonDisabled ${P}WorkerI
  BuddyButtonEnable ${P}Chat
  BuddyButtonHightlited ${P}ChatH
  BuddyButtonPushed ${P}ChatP
  BuddyButtonDisabled ${P}ChatI
  BeaconButtonEnable ${P}Beacon
  BeaconButtonHightlited ${P}BeaconH
  BeaconButtonPushed ${P}BeaconP
  BeaconButtonDisabled ${P}BeaconI
  GeneralButtonEnable ${P}General
  GeneralButtonHightlited ${P}GeneralH
  GeneralButtonPushed ${P}GeneralP
  GeneralButtonDisabled ${P}GeneralI
  UAttackButtonEnable ${P}UAttack
  UAttackButtonHightlited ${P}UAttackH
  UAttackButtonPushed ${P}UAttackP
  MinMaxButtonEnable ${P}MinMax
  MinMaxButtonHightlited ${P}MinMaxH
  MinMaxButtonPushed ${P}MinMaxP
  MinMaxUL ${ul(HUD.minMax)}
  MinMaxLR ${lr(HUD.minMax)}
  GeneralUL ${ul(HUD.general)}
  GeneralLR ${lr(HUD.general)}
  UAttackUL ${ul(HUD.uAttack)}
  UAttackLR ${lr(HUD.uAttack)}
  OptionsUL ${ul(side(HUD.sideY.options))}
  OptionsLR ${lr(side(HUD.sideY.options))}
  WorkerUL ${ul(side(HUD.sideY.worker))}
  WorkerLR ${lr(side(HUD.sideY.worker))}
  ChatUL ${ul(side(HUD.sideY.chat))}
  ChatLR ${lr(side(HUD.sideY.chat))}
  BeaconUL ${ul(side(HUD.sideY.beacon))}
  BeaconLR ${lr(side(HUD.sideY.beacon))}
  PowerBarUL ${ul(HUD.power)}
  PowerBarLR ${lr(HUD.power)}
  ExpBarForegroundImage ${P}ExpBar
  MoneyUL ${ul(HUD.money)}
  MoneyLR ${lr(HUD.money)}
  GenArrow ${P}GenArrow
  CommandMarkerImage ${P}Frame
  ImagePart
    Position X:0 Y:${HUD.barTop}
    Size X:400 Y:${HUD.barHeight}
    ImageName ${P}BarL
    Layer 4
  End
  ImagePart
    Position X:400 Y:${HUD.barTop}
    Size X:400 Y:${HUD.barHeight}
    ImageName ${P}BarR
    Layer 4
  End
  PowerPurchaseImage ${P}Panel
End
`;
}

/** Our ControlBarScheme.ini: one scheme per PlayerTemplate side, each pointing at its faction's skin. */
export function controlBarSchemeIni(): string {
  const out = ["; generated by tools/asset-pipeline/hud-skin.ts — free asset set control bar schemes",
    "; (replaces the corpus file: the retail schemes reference retail art). Geometry: hud-skin.ts HUD.", ""];
  for (const [sideName, skin] of Object.entries(SIDE_SCHEMES)) out.push(schemeBlock(sideName, skin));
  return out.join("\n");
}

/** Write atlases + INIs into a stage directory laid out like the archive (Art/Textures, Data/INI). */
export function writeHudSkin(texDir: string, iniDir: string): string[] {
  mkdirSync(join(texDir, "Art", "Textures"), { recursive: true });
  mkdirSync(join(iniDir, "Data", "INI", "MappedImages", "HandCreated"), { recursive: true });
  const names: string[] = [];
  for (const side of SIDES) {
    const tga = `gxhud_${side.toLowerCase()}.tga`;
    writeFileSync(join(texDir, "Art", "Textures", tga), encodeTga(buildAtlas(side), true));
    writeFileSync(join(iniDir, "Data", "INI", "MappedImages", "HandCreated", `GxHud${side}.ini`), mappedImagesIni(side));
    names.push(tga);
  }
  writeFileSync(join(iniDir, "Data", "INI", "MappedImages", "HandCreated", "GxHudPower.ini"), powerPointsIni());
  writeFileSync(join(iniDir, "Data", "INI", "ControlBarScheme.ini"), controlBarSchemeIni());
  return names;
}

if (process.argv[1] && /hud-skin\.ts$/.test(process.argv[1])) {
  const out = process.argv[2];
  if (!out) { console.error("usage: hud-skin.ts <outDir>"); process.exit(2); }
  console.log(writeHudSkin(out, out).join("\n"));
}
