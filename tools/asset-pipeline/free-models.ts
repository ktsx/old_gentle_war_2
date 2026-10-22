#!/usr/bin/env node --experimental-strip-types
/**
 * free-models.ts — the first procedural W3D models of the free asset set, plus their texture.
 *
 * Each model is a mesh-only .w3d (w3d.ts) named after the retail model the corpus Object INIs
 * reference in their day/undamaged condition state, so the templates work unchanged:
 *
 *   AmericaCommandCenter   ABBtCmdHQ        NBConYard      ChinaCommandCenter
 *   AmericaVehicleDozer    AVCONSTDOZ_A     NVCONSTDOZ_A   ChinaVehicleDozer
 *   AmericaInfantryRanger  AIRngr_SKN       NICNSC_SKN     ChinaInfantryRedguard
 *   AmericaPowerPlant      ABPWRPLANT       NBPwrPlant     ChinaPowerPlant
 *   AmericaBarracks        ABBARRACKS       NBBarracks     ChinaBarracks
 *   AmericaSupplyCenter    ABSupplyCT       NBSupCent      ChinaSupplyCenter
 *   AmericaWarFactory      ABWarFact        NBWarFact      ChinaWarFactory
 *   AmericaTankCrusader    AVLeopard        NVBtMstr       ChinaTankBattleMaster
 *   AmericaVehicleHumvee   AVHUMMER
 *
 * Units are world units (1 map cell = 10), Z up, X forward (object angle 0 faces +X). Sizes follow
 * the templates' Geometry (command centre 120×140×49, dozer 30×20×15, infantry r7 h13).
 *
 * All models share one 256×256 atlas, Art/Textures/ZHCAGxUnits.tga: the ZHCA prefix makes
 * W3DAssetManager blend the owner's house colour into pixels by (255 − alpha), so the panels drawn
 * with low alpha take the player colour and everything else stays as painted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Image32, encodeTga, type RGBA } from "./tga.ts";
import { MeshBuilder, MESH_FLAG, encodeW3D, type Mesh, type Region, type Vec3 } from "./w3d.ts";

export const UNIT_TEXTURE = "ZHCAGxUnits.tga";
/** The same atlas scorched (DAMAGED states) and charred (REALLYDAMAGED / RUBBLE states). */
export const UNIT_TEXTURE_DAMAGED = "ZHCAGxUnitsD.tga";
export const UNIT_TEXTURE_RUBBLE = "ZHCAGxUnitsE.tga";
const ATLAS = 256, CELL = 64;

/** Atlas cells (column, row) → inset region, so bilinear filtering never bleeds into a neighbour. */
function R(col: number, row: number): Region { return { x: col * CELL + 3, y: row * CELL + 3, w: CELL - 6, h: CELL - 6 }; }
const TEX = {
  concrete: R(0, 0), roof: R(1, 0), housePanel: R(2, 0), metal: R(3, 0),
  yellow: R(0, 1), tread: R(1, 1), glass: R(2, 1), redConcrete: R(3, 1),
  olive: R(0, 2), skin: R(1, 2), black: R(2, 2), khaki: R(3, 2),
  houseStripe: R(0, 3), tileRoof: R(1, 3), steel: R(2, 3), hazard: R(3, 3),
};

// --- texture -------------------------------------------------------------------------------
function noise(img: Image32, x0: number, y0: number, w: number, h: number, base: RGBA, amp: number, seed: number) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const d = Math.round((rnd() - 0.5) * 2 * amp);
    img.set(x, y, [clamp(base[0] + d), clamp(base[1] + d), clamp(base[2] + d), base[3]]);
  }
}
const clamp = (v: number) => Math.max(0, Math.min(255, v));
function cell(col: number, row: number): [number, number] { return [col * CELL, row * CELL]; }

export function buildUnitAtlas(): Image32 {
  const img = new Image32(ATLAS, ATLAS, [90, 90, 90, 255]);
  let [x, y] = cell(0, 0);                                     // concrete wall with a window band
  noise(img, x, y, CELL, CELL, [168, 166, 158, 255], 6, 1);
  img.fillRect(x, y + 22, CELL, 14, [52, 60, 72, 255]);
  for (let i = 0; i < CELL; i += 8) img.fillRect(x + i, y + 22, 2, 14, [150, 148, 140, 255]);
  img.fillRect(x, y + 58, CELL, 6, [120, 118, 110, 255]);
  [x, y] = cell(1, 0);                                         // flat roof with vents
  noise(img, x, y, CELL, CELL, [128, 128, 124, 255], 5, 2);
  img.plate(x + 8, y + 8, 20, 14, [96, 96, 96, 255], [120, 120, 120, 255], [60, 60, 60, 255]);
  img.plate(x + 36, y + 30, 18, 18, [96, 96, 96, 255], [120, 120, 120, 255], [60, 60, 60, 255]);
  [x, y] = cell(2, 0);                                         // house-colour panel (mostly player colour)
  noise(img, x, y, CELL, CELL, [200, 200, 200, 48], 10, 3);
  img.strokeRect(x, y, CELL, CELL, [40, 40, 40, 255]);
  [x, y] = cell(3, 0);                                         // dark machinery
  noise(img, x, y, CELL, CELL, [70, 72, 76, 255], 8, 4);
  for (let i = 4; i < CELL; i += 12) img.fillRect(x, y + i, CELL, 2, [50, 52, 56, 255]);
  [x, y] = cell(0, 1);                                         // dozer yellow
  noise(img, x, y, CELL, CELL, [214, 168, 40, 255], 7, 5);
  img.fillRect(x, y + 52, CELL, 4, [120, 90, 20, 255]);
  [x, y] = cell(1, 1);                                         // tracks / rubber
  noise(img, x, y, CELL, CELL, [48, 46, 44, 255], 6, 6);
  for (let i = 0; i < CELL; i += 8) img.fillRect(x + i, y, 3, CELL, [30, 30, 30, 255]);
  [x, y] = cell(2, 1);                                         // glass
  img.vGradient(x, y, CELL, CELL, [90, 130, 170, 255], [30, 50, 80, 255]);
  img.fillRect(x + 6, y + 6, 10, 40, [160, 200, 230, 255]);
  [x, y] = cell(3, 1);                                         // red-brown concrete (China)
  noise(img, x, y, CELL, CELL, [140, 92, 72, 255], 7, 7);
  img.fillRect(x, y + 24, CELL, 12, [60, 44, 40, 255]);
  for (let i = 0; i < CELL; i += 10) img.fillRect(x + i, y + 24, 3, 12, [130, 86, 66, 255]);
  [x, y] = cell(0, 2);                                         // olive fabric
  noise(img, x, y, CELL, CELL, [92, 104, 68, 255], 9, 8);
  [x, y] = cell(1, 2);                                         // skin
  noise(img, x, y, CELL, CELL, [214, 170, 136, 255], 5, 9);
  img.fillRect(x + 18, y + 26, 8, 4, [60, 40, 30, 255]); img.fillRect(x + 38, y + 26, 8, 4, [60, 40, 30, 255]);
  [x, y] = cell(2, 2);                                         // black (boots, rifle, helmet)
  noise(img, x, y, CELL, CELL, [34, 34, 36, 255], 5, 10);
  [x, y] = cell(3, 2);                                         // khaki (China infantry) with a red band
  noise(img, x, y, CELL, CELL, [140, 128, 90, 255], 8, 11);
  img.fillRect(x, y + 8, CELL, 6, [170, 30, 30, 255]);
  [x, y] = cell(0, 3);                                         // full house colour stripe
  img.fillRect(x, y, CELL, CELL, [255, 255, 255, 0]);
  [x, y] = cell(1, 3);                                         // tiled roof
  noise(img, x, y, CELL, CELL, [120, 50, 40, 255], 6, 12);
  for (let i = 0; i < CELL; i += 8) img.fillRect(x, y + i, CELL, 2, [80, 30, 24, 255]);
  [x, y] = cell(2, 3);                                         // steel blade
  img.vGradient(x, y, CELL, CELL, [190, 192, 196, 255], [110, 112, 118, 255]);
  [x, y] = cell(3, 3);                                         // hazard stripes
  img.fillRect(x, y, CELL, CELL, [220, 180, 40, 255]);
  for (let i = -CELL; i < CELL; i += 16) for (let r = 0; r < CELL; r++) img.fillRect(x + ((i + r) % CELL + CELL) % CELL, y + r, 1, 1, [30, 30, 30, 255]);
  return img;
}

/**
 * The atlas after a fight: every cell darkened, soot splats and cracks drawn over it. Soot raises
 * the alpha too, so a sooty house-colour panel shows soot rather than player colour.
 * `level` 0..1 — 0.45 for DAMAGED, 1 for REALLYDAMAGED/RUBBLE.
 */
export function scorchAtlas(src: Image32, level: number, seed: number): Image32 {
  const img = new Image32(ATLAS, ATLAS, [0, 0, 0, 0]);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const dark = 1 - 0.3 - 0.15 * level;                                   // 0.7 damaged, 0.55 rubble
  const splats: [number, number, number][] = [];
  for (let i = 0; i < 10 + 26 * level; i++) splats.push([rnd() * ATLAS, rnd() * ATLAS, 6 + rnd() * (10 + 12 * level)]);
  for (let y = 0; y < ATLAS; y++) for (let x = 0; x < ATLAS; x++) {
    const [r, g, b, a] = src.get(x, y);
    let soot = 0;
    for (const [cx, cy, rad] of splats) {
      // wrap within the 64-px cell so a splat never crosses into a neighbouring material
      const dx = ((x - cx) % CELL + CELL * 1.5) % CELL - CELL / 2, dy = ((y - cy) % CELL + CELL * 1.5) % CELL - CELL / 2;
      const d = Math.hypot(dx, dy) / rad;
      if (d < 1) soot = Math.max(soot, Math.pow(1 - d, 1.4) * (0.6 + 0.4 * level));
    }
    const k = dark * (1 - 0.9 * soot);
    img.set(x, y, [clamp(Math.round(r * k)), clamp(Math.round(g * k)), clamp(Math.round(b * k)), clamp(Math.round(a + (255 - a) * soot))]);
  }
  for (let i = 0; i < 6 + 14 * level; i++) {                              // cracks: short dark jagged polylines
    let x = Math.floor(rnd() * ATLAS), y = Math.floor(rnd() * ATLAS);
    const cx0 = Math.floor(x / CELL) * CELL, cy0 = Math.floor(y / CELL) * CELL;
    for (let k = 0; k < 4 + rnd() * 4; k++) {
      const nx = clamp(Math.min(cx0 + CELL - 1, Math.max(cx0, x + Math.round((rnd() - 0.5) * 14))));
      const ny = clamp(Math.min(cy0 + CELL - 1, Math.max(cy0, y + Math.round((rnd() - 0.5) * 14))));
      img.line(x, y, nx, ny, [24, 22, 20, 255]);
      x = nx; y = ny;
    }
  }
  return img;
}

// --- damage states ---------------------------------------------------------------------------
function meshBounds(m: Mesh) {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of m.verts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
  return { lo, hi };
}

/** The same model with another name and texture (DAMAGED: scorched walls, nothing fell yet). */
function retextured(m: Mesh, name: string, texture: string): Mesh {
  return { ...m, name, texture };
}

/**
 * REALLYDAMAGED / RUBBLE: the model squashed to `squash` of its height, leaning a little, with
 * rubble heaps around the footprint for buildings, all in the charred texture.
 */
function collapsed(m: Mesh, name: string, texture: string, squash: number, heaps: boolean): Mesh {
  const { lo, hi } = meshBounds(m);
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  const lean = 0.08;                                                      // x shift per unit of height
  const verts: Vec3[] = m.verts.map(([x, y, z]) => [x + (z - lo[2]) * squash * lean, y, lo[2] + (z - lo[2]) * squash]);
  const normals: Vec3[] = m.normals.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z / squash) || 1;                          // normals scale by the inverse
    return [x / l, y / l, (z / squash) / l];
  });
  const out: Mesh = { ...m, name, texture, verts, normals: normals, uvs: [...m.uvs], tris: [...m.tris] };
  if (heaps) {
    const b = new MeshBuilder(name, texture, ATLAS, m.flags ?? 0);
    const rx = (hi[0] - lo[0]) / 2, ry = (hi[1] - lo[1]) / 2;
    let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + rnd() * 0.6, d = 0.75 + rnd() * 0.35;
      const hx = cx + Math.cos(ang) * rx * d, hy = cy + Math.sin(ang) * ry * d;
      const w = 6 + rnd() * Math.min(14, rx * 0.3), h = 3 + rnd() * Math.min(9, (hi[2] - lo[2]) * 0.2);
      b.frustum([hx - w, hy - w * 0.8, lo[2]], [hx + w, hy + w * 0.8, lo[2] + h], w * 0.55, { side: TEX.concrete, top: TEX.metal });
    }
    const base = out.verts.length;
    out.verts.push(...b.verts); out.normals.push(...b.normals); out.uvs.push(...b.uvs);
    for (const [a, c, d] of b.tris) out.tris.push([a + base, c + base, d + base]);
  }
  return out;
}

/** Which damage-state render objects the corpus INIs reference for each of our models. */
const DAMAGE_STATES: Record<string, { damaged?: string; rubble?: string; squash: number; heaps: boolean }> = {
  // buildings: ConditionState DAMAGED → _D, REALLYDAMAGED RUBBLE → _E
  ABBtCmdHQ: { damaged: "ABBtCmdHQ_D", rubble: "ABBtCmdHQ_E", squash: 0.4, heaps: true },
  NBConYard: { damaged: "NBConYard_D", rubble: "NBConYard_E", squash: 0.4, heaps: true },
  ABPWRPLANT: { damaged: "ABPWRPLANT_D", rubble: "ABPWRPLANT_E", squash: 0.4, heaps: true },
  NBPwrPlant: { damaged: "NBPwrPlant_D", rubble: "NBPwrPlant_E", squash: 0.4, heaps: true },
  ABBARRACKS: { damaged: "ABBarracks_D", rubble: "ABBarracks_E", squash: 0.45, heaps: true },
  NBBarracks: { damaged: "NBBarracks_D", rubble: "NBBarracks_E", squash: 0.45, heaps: true },
  ABSupplyCT: { damaged: "ABSupplyCT_D", rubble: "ABSupplyCT_E", squash: 0.45, heaps: true },
  NBSupCent: { damaged: "NBSupCent_D", rubble: "NBSupCent_E", squash: 0.45, heaps: true },
  ABWarFact: { damaged: "ABWarFact_D", rubble: "ABWarFact_E", squash: 0.4, heaps: true },
  NBWarFact: { damaged: "NBWarFact_D", rubble: "NBWarFact_E", squash: 0.4, heaps: true },
  // vehicles: only REALLYDAMAGED swaps the model (a wreck, no heaps)
  AVLeopard: { rubble: "AVLeopard_D", squash: 0.75, heaps: false },
  NVBtMstr: { rubble: "NVBtMstr_D", squash: 0.75, heaps: false },
  AVHUMMER: { rubble: "AVHUMMER_D", squash: 0.7, heaps: false },
  AVCONSTDOZ_A: { rubble: "AVCONSTDOZ_AD", squash: 0.75, heaps: false },
  NVCONSTDOZ_A: { rubble: "NVCONSTDOZ_AD", squash: 0.75, heaps: false },
};

// --- models ----------------------------------------------------------------------------------
const PICKABLE = MESH_FLAG.COLLISION_TYPE_PHYSICAL | MESH_FLAG.COLLISION_TYPE_VIS;

function commandCenterUSA(): Mesh {
  const b = new MeshBuilder("ABBtCmdHQ", UNIT_TEXTURE, ATLAS, PICKABLE);
  b.box([-56, -64, 0], [56, 64, 3], { side: TEX.metal, top: TEX.roof });                  // apron
  b.box([-46, -52, 3], [34, 52, 30], { side: TEX.concrete, top: TEX.roof, front: TEX.housePanel }); // main block
  b.box([-30, -26, 30], [18, 26, 42], { side: TEX.concrete, top: TEX.roof });              // upper storey
  b.box([22, -44, 3], [46, -20, 56], { side: TEX.concrete, top: TEX.metal });              // tower
  b.cylinder(34, -32, 56, 78, 1.6, 8, { side: TEX.metal, top: TEX.metal });                // mast
  b.box([30, -36, 60], [38, -28, 62], { side: TEX.hazard, top: TEX.metal });               // mast platform
  b.box([34, -14, 3], [36, 14, 20], { side: TEX.metal, top: TEX.metal });                  // bay door
  b.box([34, -50, 22], [36, 50, 27], { side: TEX.houseStripe, top: TEX.metal });           // house-colour band
  b.box([-20, 10, 42], [-6, 22, 48], { side: TEX.metal, top: TEX.metal });                 // roof plant
  b.box([-44, -60, 3], [-30, -54, 12], { side: TEX.hazard, top: TEX.metal });              // generator
  return b.mesh();
}

function commandCenterChina(): Mesh {
  const b = new MeshBuilder("NBConYard", UNIT_TEXTURE, ATLAS, PICKABLE);
  b.box([-58, -60, 0], [58, 60, 3], { side: TEX.metal, top: TEX.roof });
  b.box([-48, -50, 3], [40, 50, 26], { side: TEX.redConcrete, top: TEX.tileRoof, front: TEX.housePanel });
  b.frustum([-52, -54, 26], [44, 54, 34], 12, { side: TEX.tileRoof, top: TEX.tileRoof });  // hip roof
  b.box([-24, -24, 34], [12, 24, 46], { side: TEX.redConcrete, top: TEX.tileRoof });        // second tier
  b.frustum([-28, -28, 46], [16, 28, 54], 10, { side: TEX.tileRoof, top: TEX.tileRoof });
  b.cylinder(-36, 36, 26, 50, 3, 10, { side: TEX.metal, top: TEX.black });                 // chimney
  b.box([40, -16, 3], [42, 16, 18], { side: TEX.metal, top: TEX.metal });                  // bay door
  b.box([40, -46, 20], [42, 46, 25], { side: TEX.houseStripe, top: TEX.metal });           // house-colour band
  b.box([-48, -58, 3], [-32, -52, 11], { side: TEX.hazard, top: TEX.metal });
  return b.mesh();
}

function dozer(name: string, paint: Region): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  b.box([-14, -10.5, 0], [11, -6.5, 6], { side: TEX.tread, top: TEX.tread, bottom: TEX.tread });   // tracks
  b.box([-14, 6.5, 0], [11, 10.5, 6], { side: TEX.tread, top: TEX.tread, bottom: TEX.tread });
  b.box([-12, -7, 4], [9, 7, 11], { side: paint, top: paint, front: TEX.metal, back: TEX.metal }); // hull
  b.box([-11, -7.2, 7.5], [8, 7.2, 10], { side: TEX.houseStripe, top: paint });                   // house-colour band
  b.box([-9, -5.5, 11], [1, 5.5, 17], { side: TEX.glass, top: paint, back: paint });               // cab
  b.cylinder(-6, 5, 11, 20, 0.9, 6, { side: TEX.black, top: TEX.black });                          // exhaust
  b.box([3, -7.5, 8], [13, -6, 10], { side: TEX.metal, top: TEX.metal });                          // blade arms
  b.box([3, 6, 8], [13, 7.5, 10], { side: TEX.metal, top: TEX.metal });
  b.box([13, -12, 0.5], [15.5, 12, 9.5], { side: TEX.hazard, top: TEX.steel, front: TEX.steel }); // blade
  return b.mesh();
}

function infantry(name: string, uniform: Region, helmet: Region): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  for (const s of [-1, 1]) {
    b.box([-2.2, s * 1.0 - 1.0, 0], [2.4, s * 1.0 + 1.0, 1.3], { side: TEX.black, top: TEX.black });        // boots
    b.box([-1.4, s * 1.1 - 1.0, 1.3], [1.4, s * 1.1 + 1.0, 6.4], { side: uniform, top: uniform });           // legs
    b.box([-1.2, s * 3.6 - 0.7, 6.0], [1.2, s * 3.6 + 0.7, 10.6], { side: uniform, top: uniform });          // arms
    b.box([-1.0, s * 3.6 - 0.6, 5.0], [1.0, s * 3.6 + 0.6, 6.0], { side: TEX.skin, top: TEX.skin });         // hands
  }
  b.box([-2.0, -2.9, 6.4], [2.0, 2.9, 11.0], { side: uniform, top: uniform, front: TEX.housePanel });       // torso
  b.box([-1.5, -1.5, 11.0], [1.5, 1.5, 13.3], { side: TEX.skin, top: TEX.skin });                           // head
  b.frustum([-2.0, -2.0, 13.0], [2.0, 2.0, 14.6], 0.9, { side: helmet, top: helmet });                      // helmet
  b.box([0.0, -2.0, 8.6], [7.5, -1.2, 9.6], { side: TEX.black, top: TEX.black, bottom: TEX.black });        // rifle
  return b.mesh();
}

// --- the rest of a starting base ------------------------------------------------------------
// Sizes follow each template's Geometry (major/minor radius, height); USA = concrete + flat roofs,
// China = red-brown walls + tiled hip roofs. Model names are the templates' day/undamaged state.
type Style = { wall: Region; roof: Region; hip: boolean };
const USA: Style = { wall: TEX.concrete, roof: TEX.roof, hip: false };
const CHINA: Style = { wall: TEX.redConcrete, roof: TEX.tileRoof, hip: true };

/** A building body: slab, walls, roof (flat or hipped), a house-colour band and a door on +X. */
function body(b: MeshBuilder, hx: number, hy: number, h: number, st: Style, door = true) {
  b.box([-hx - 4, -hy - 4, 0], [hx + 4, hy + 4, 2], { side: TEX.metal, top: TEX.roof });
  b.box([-hx, -hy, 2], [hx, hy, h], { side: st.wall, top: st.roof, front: TEX.housePanel });
  if (st.hip) b.frustum([-hx - 3, -hy - 3, h], [hx + 3, hy + 3, h + 7], 9, { side: st.roof, top: st.roof });
  b.box([hx - 1, -hy + 4, h - 4], [hx + 1, hy - 4, h - 1], { side: TEX.houseStripe, top: TEX.metal });
  if (door) b.box([hx - 1, -8, 2], [hx + 1, 8, Math.min(14, h - 4)], { side: TEX.metal, top: TEX.metal });
}
function flagpole(b: MeshBuilder, x: number, y: number, z0: number) {
  b.cylinder(x, y, z0, z0 + 26, 0.8, 6, { side: TEX.metal, top: TEX.metal });
  b.box([x, y - 0.3, z0 + 19], [x + 9, y + 0.3, z0 + 25], { side: TEX.houseStripe, top: TEX.houseStripe });
}

function powerPlant(name: string, st: Style, hx: number, hy: number, h: number): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  body(b, hx, hy - 10, h * 0.45, st, false);
  if (st.hip) {                                               // China: three chimney stacks
    for (const y of [-hy + 12, 0, hy - 12]) b.cylinder(-hx * 0.3, y, 2, h, 4.5, 10, { side: TEX.metal, top: TEX.black });
  } else {                                                    // USA: two cooling towers
    for (const y of [-hy * 0.45, hy * 0.45]) {
      b.cylinder(-hx * 0.2, y, 2, h * 0.6, hx * 0.55, 12, { side: TEX.concrete, top: TEX.metal });
      b.cylinder(-hx * 0.2, y, h * 0.6, h, hx * 0.42, 12, { side: TEX.concrete, top: TEX.black });
    }
  }
  b.box([hx - 14, -hy + 2, 2], [hx - 2, -hy + 12, 10], { side: TEX.hazard, top: TEX.metal });   // transformer
  b.box([hx - 14, hy - 12, 2], [hx - 2, hy - 2, 10], { side: TEX.hazard, top: TEX.metal });
  return b.mesh();
}

function barracks(name: string, st: Style, hx: number, hy: number, h: number): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  body(b, hx, hy, h, st);
  for (const y of [-hy * 0.6, 0, hy * 0.6]) b.box([-hx - 1, y - 5, 6], [-hx + 1, y + 5, 12], { side: TEX.glass, top: TEX.metal });  // windows
  flagpole(b, hx - 6, hy - 6, st.hip ? h + 7 : h);
  return b.mesh();
}

function supplyCenter(name: string, st: Style, hx: number, hy: number, h: number): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  body(b, hx * 0.55, hy, h, st);
  b.box([-hx - 4, -hy - 4, 0], [hx + 4, hy + 4, 1.5], { side: TEX.metal, top: TEX.roof });     // yard
  for (const y of [-hy * 0.5, hy * 0.5]) b.cylinder(hx * 0.7, y, 1.5, h + 8, hx * 0.2, 12, { side: TEX.metal, top: TEX.steel }); // silos
  b.box([hx * 0.55, -6, 1.5], [hx * 0.9, 6, 4], { side: TEX.hazard, top: TEX.steel });          // conveyor
  return b.mesh();
}

function warFactory(name: string, st: Style, hx: number, hy: number, h: number): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  body(b, hx, hy, h, st, false);
  b.box([hx - 1, -hy * 0.5, 2], [hx + 1, hy * 0.5, h - 6], { side: TEX.metal, top: TEX.metal });   // bay door
  b.box([hx - 10, -hy * 0.5 - 2, h - 6], [hx + 2, hy * 0.5 + 2, h - 3], { side: TEX.hazard, top: TEX.metal });
  b.box([-hx * 0.6, -hy * 0.4, (st.hip ? h + 7 : h)], [hx * 0.2, hy * 0.4, (st.hip ? h + 7 : h) + 6], { side: TEX.metal, top: TEX.roof }); // crane housing
  b.cylinder(-hx * 0.7, hy * 0.6, 2, h + 18, 2, 8, { side: TEX.metal, top: TEX.black });          // stack
  return b.mesh();
}

function tank(name: string, paint: Region, hx: number, hy: number, h: number, turret: number): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  b.box([-hx, -hy, 0], [hx, -hy + 4, h * 0.5], { side: TEX.tread, top: TEX.tread, bottom: TEX.tread });   // tracks
  b.box([-hx, hy - 4, 0], [hx, hy, h * 0.5], { side: TEX.tread, top: TEX.tread, bottom: TEX.tread });
  b.box([-hx + 1, -hy + 3, 2], [hx - 1, hy - 3, h * 0.65], { side: paint, top: paint });                 // hull
  b.box([-hx + 1, -hy + 3.2, h * 0.35], [hx - 1, hy - 2.8, h * 0.5], { side: TEX.houseStripe, top: paint }); // house band
  b.frustum([-turret, -turret, h * 0.65], [turret * 0.6, turret, h], 1.5, { side: paint, top: paint });  // turret
  b.box([turret * 0.6, -0.8, h * 0.78], [hx + 10, 0.8, h * 0.9], { side: TEX.metal, top: TEX.metal, bottom: TEX.metal }); // barrel
  return b.mesh();
}

function humvee(name: string): Mesh {
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  for (const x of [-9, 8]) for (const y of [-7, 4]) b.box([x, y, 0], [x + 5, y + 3, 5], { side: TEX.tread, top: TEX.tread, bottom: TEX.tread }); // wheels
  b.box([-13, -6, 3], [13, 6, 7.5], { side: TEX.olive, top: TEX.olive, front: TEX.metal });            // body
  b.box([-6, -5.5, 7.5], [7, 5.5, 11.5], { side: TEX.glass, top: TEX.olive, back: TEX.olive });        // cab
  b.box([-12, -6.2, 5], [12, 6.2, 6.5], { side: TEX.houseStripe, top: TEX.olive });                    // house band
  b.cylinder(-2, 0, 11.5, 13.5, 1.2, 6, { side: TEX.black, top: TEX.black });                          // gun mount
  return b.mesh();
}

export function buildFreeModels(): Record<string, Mesh> {
  const models = [
    commandCenterUSA(), commandCenterChina(),
    powerPlant("ABPWRPLANT", USA, 22, 30, 46), powerPlant("NBPwrPlant", CHINA, 27, 34, 40),
    barracks("ABBARRACKS", USA, 55, 45, 20), barracks("NBBarracks", CHINA, 36, 44, 30),
    supplyCenter("ABSupplyCT", USA, 44, 45, 24), supplyCenter("NBSupCent", CHINA, 52, 47, 30),
    warFactory("ABWarFact", USA, 53, 60, 40), warFactory("NBWarFact", CHINA, 57, 61, 30),
    tank("AVLeopard", TEX.olive, 15, 10, 10, 6), tank("NVBtMstr", TEX.khaki, 13, 9, 10, 7),
    humvee("AVHUMMER"),
    dozer("AVCONSTDOZ_A", TEX.yellow), dozer("NVCONSTDOZ_A", TEX.redConcrete),
    infantry("AIRngr_SKN", TEX.olive, TEX.olive), infantry("NICNSC_SKN", TEX.khaki, TEX.khaki),
  ];
  for (const m of [...models]) {
    const d = DAMAGE_STATES[m.name];
    if (!d) continue;
    if (d.damaged) models.push(retextured(m, d.damaged, UNIT_TEXTURE_DAMAGED));
    if (d.rubble) models.push(collapsed(m, d.rubble, UNIT_TEXTURE_RUBBLE, d.squash, d.heaps));
  }
  return Object.fromEntries(models.map((m) => [m.name, m]));
}

/** Writes Art/W3D/<model>.w3d under `w3dDir` and the three Art/Textures/ZHCAGxUnits*.tga atlases under `texDir`. */
export function writeFreeModels(w3dDir: string, texDir: string): string[] {
  const out: string[] = [];
  const dir = join(w3dDir, "Art", "W3D");
  mkdirSync(dir, { recursive: true });
  for (const [name, mesh] of Object.entries(buildFreeModels())) {
    const buf = encodeW3D([mesh]);
    writeFileSync(join(dir, `${name}.w3d`), buf);
    out.push(`${name}.w3d (${mesh.tris.length} tris)`);
  }
  const tdir = join(texDir, "Art", "Textures");
  mkdirSync(tdir, { recursive: true });
  const atlas = buildUnitAtlas();
  writeFileSync(join(tdir, UNIT_TEXTURE), encodeTga(atlas, true));
  writeFileSync(join(tdir, UNIT_TEXTURE_DAMAGED), encodeTga(scorchAtlas(atlas, 0.45, 21), true));
  writeFileSync(join(tdir, UNIT_TEXTURE_RUBBLE), encodeTga(scorchAtlas(atlas, 1, 22), true));
  out.push(UNIT_TEXTURE, UNIT_TEXTURE_DAMAGED, UNIT_TEXTURE_RUBBLE);
  return out;
}

if (process.argv[1] && /free-models\.ts$/.test(process.argv[1])) {
  const [out] = process.argv.slice(2);
  if (!out) { console.error("usage: free-models.ts <outDir>"); process.exit(2); }
  console.log(writeFreeModels(out, out).join("\n"));
}
