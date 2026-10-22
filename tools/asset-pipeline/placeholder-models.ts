#!/usr/bin/env node --experimental-strip-types
/**
 * placeholder-models.ts — a stand-in .w3d for every faction model the corpus references that
 * free-models.ts does not draw by hand.
 *
 * A missing model draws nothing: an enemy Paladin, a Tomahawk, a supply truck, a sentry drone,
 * a missile in flight — all invisible, and unselectable. This reads the vanilla faction INIs
 * (America/China/GLA Vehicle, Infantry, Air, MiscUnit; FactionBuilding; FactionUnit; WeaponObjects) and, for
 * every object, takes the first Draw module's condition states: the undamaged model, the
 * DAMAGED one and the REALLYDAMAGED one (night/snow variants are skipped). Each gets a shape
 * sized from the template's Geometry and styled by its Side and KindOf:
 *
 *   STRUCTURE  — a walled block with a roof in the faction's building style
 *   INFANTRY   — the infantry figure with the faction's uniform
 *   AIRCRAFT   — fuselage, wings and a tail fin
 *   VEHICLE    — hull on tracks with a cab (and a turret when the template draws with W3DTankDraw)
 *   PROJECTILE — a thin dart
 *   anything else — a box
 *
 * House colour comes from the shared atlas like the hand-made models. Damage states reuse
 * free-models' scorched/collapsed derivation, so the same Object INI works unchanged.
 *
 * Usage: node --experimental-strip-types placeholder-models.ts <patchDataDir> <outDir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeshBuilder, encodeW3D, type Mesh, type Region } from "./w3d.ts";
import {
  ATLAS, CHINA, GLA, PICKABLE, TEX, UNIT_TEXTURE, UNIT_TEXTURE_DAMAGED, UNIT_TEXTURE_RUBBLE, USA,
  body, buildFreeModels, collapsed, infantry, retextured, tank, type Style,
} from "./free-models.ts";

const FACTION_INIS = [
  "AmericaVehicle.ini", "AmericaInfantry.ini", "AmericaAir.ini", "AmericaMiscUnit.ini",
  "ChinaVehicle.ini", "ChinaInfantry.ini", "ChinaAir.ini", "ChinaMiscUnit.ini",
  "GLAVehicle.ini", "GLAInfantry.ini", "GLAAir.ini", "GLAMiscUnit.ini",
  "FactionBuilding.ini", "FactionUnit.ini", "WeaponObjects.ini",
];

export interface ObjectSpec {
  name: string;
  side: string;
  kinds: Set<string>;
  draw: string;                                  // first Draw module class (W3DModelDraw, W3DTankDraw, ...)
  geometry: { type: string; major: number; minor: number; height: number };
  model?: string;                                // undamaged
  damaged?: string;                              // DAMAGED (buildings)
  rubble?: string;                               // REALLYDAMAGED / RUBBLE (buildings) or the vehicle wreck
}

/** Object blocks from the faction INIs: Side, KindOf, Geometry and the first draw module's models by state. */
export function parseFactionObjects(patchDataDir: string): ObjectSpec[] {
  const out: ObjectSpec[] = [];
  for (const ini of FACTION_INIS) {
    const text = readFileSync(join(patchDataDir, "INI", "Object", ini), "latin1");
    const lines = text.split(/\r?\n/);
    let cur: ObjectSpec | null = null;
    let drawIndex = -1, state: string[] | null = null;
    for (const raw of lines) {
      const line = raw.replace(/;.*$/, "").trim();
      if (!line) continue;
      const mObj = /^Object\s+(\w+)/.exec(line);
      if (mObj) {
        cur = { name: mObj[1], side: "", kinds: new Set(), draw: "", geometry: { type: "BOX", major: 10, minor: 10, height: 10 } };
        drawIndex = -1; state = null;
        continue;
      }
      if (!cur) continue;
      if (/^End$/i.test(line) && raw.search(/\S/) === 0) { out.push(cur); cur = null; continue; }   // top-level End closes the object
      let m: RegExpExecArray | null;
      if ((m = /^Side\s*=\s*(\w+)/i.exec(line))) cur.side = m[1];
      else if ((m = /^KindOf\s*=\s*(.*)$/i.exec(line))) for (const k of m[1].split(/\s+/)) cur.kinds.add(k.toUpperCase());
      else if ((m = /^Geometry\s*=\s*(\w+)/i.exec(line))) cur.geometry.type = m[1].toUpperCase();
      else if ((m = /^GeometryMajorRadius\s*=\s*([\d.]+)/i.exec(line))) cur.geometry.major = Number(m[1]);
      else if ((m = /^GeometryMinorRadius\s*=\s*([\d.]+)/i.exec(line))) cur.geometry.minor = Number(m[1]);
      else if ((m = /^GeometryHeight\s*=\s*([\d.]+)/i.exec(line))) cur.geometry.height = Number(m[1]);
      else if ((m = /^Draw\s*=\s*(\w+)/i.exec(line))) { drawIndex++; if (drawIndex === 0) cur.draw = m[1]; state = null; }
      else if (drawIndex === 0) {
        if (/^DefaultConditionState/i.test(line)) state = [];
        else if ((m = /^ConditionState\s*=\s*(.*)$/i.exec(line))) state = m[1].toUpperCase().split(/\s+/).filter(Boolean);
        else if ((m = /^Model\s*=\s*(\S+)/i.exec(line)) && state) {
          const model = m[1];
          if (/^none$/i.test(model)) continue;
          const has = (f: string) => state!.includes(f);
          if (has("NIGHT") || has("SNOW")) continue;
          if (has("REALLYDAMAGED")) { if (!cur.rubble) cur.rubble = model; }
          else if (has("DAMAGED")) { if (!cur.damaged) cur.damaged = model; }
          else if (!cur.model && (state.length === 0 || has("NONE") || state.every((f) => /^(NONE)$/.test(f)))) cur.model = model;
          else if (!cur.model) cur.model = model;    // no plain state: first model wins
        }
      }
    }
  }
  return out;
}

function styleFor(side: string): { st: Style; paint: Region; helmet: Region } {
  if (/china/i.test(side)) return { st: CHINA, paint: TEX.khaki, helmet: TEX.khaki };
  if (/gla/i.test(side)) return { st: GLA, paint: TEX.rust, helmet: TEX.scarf };
  return { st: USA, paint: TEX.olive, helmet: TEX.olive };
}

function structure(name: string, o: ObjectSpec): Mesh {
  const { st } = styleFor(o.side);
  const g = o.geometry;
  const hx = g.type === "BOX" ? g.major : g.major, hy = g.type === "BOX" ? g.minor : g.major;
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  if (g.type === "CYLINDER") {
    b.cylinder(0, 0, 0, Math.max(4, g.height * 0.85), g.major, 12, { side: st.wall, top: st.roof });
    b.cylinder(0, 0, g.height * 0.85, Math.max(5, g.height), g.major * 0.9, 12, { side: TEX.houseStripe, top: st.roof });
  } else {
    body(b, Math.max(6, hx - 2), Math.max(6, hy - 2), Math.max(8, g.height), st, hx > 12);
  }
  return b.mesh();
}

function vehicle(name: string, o: ObjectSpec): Mesh {
  const { paint } = styleFor(o.side);
  const g = o.geometry;
  const hx = Math.max(6, g.major), hy = Math.max(4, g.type === "BOX" ? g.minor : g.major), h = Math.max(5, g.height);
  if (/TankDraw/i.test(o.draw) || /OverlordTankDraw/i.test(o.draw)) return tank(name, paint, hx, hy, h, Math.min(hy * 0.7, hx * 0.45));
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  for (const x of [-hx + 1, hx - 6]) for (const y of [-hy, hy - 3]) b.box([x, y, 0], [x + 5, y + 3, h * 0.45], { side: TEX.tread, top: TEX.tread, bottom: TEX.tread });
  b.box([-hx + 1, -hy + 1, h * 0.25], [hx - 1, hy - 1, h * 0.7], { side: paint, top: paint, front: TEX.metal });
  b.box([-hx + 1, -hy + 1.2, h * 0.4], [hx - 1, hy - 0.8, h * 0.55], { side: TEX.houseStripe, top: paint });
  b.box([hx * 0.1, -hy + 1.5, h * 0.7], [hx * 0.7, hy - 1.5, h], { side: TEX.glass, top: paint, back: paint });
  return b.mesh();
}

function aircraft(name: string, o: ObjectSpec): Mesh {
  const { paint } = styleFor(o.side);
  const g = o.geometry;
  const hx = Math.max(8, g.major), hy = Math.max(6, g.type === "BOX" ? g.minor : g.major), h = Math.max(4, g.height);
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  b.box([-hx, -hy * 0.18, h * 0.3], [hx, hy * 0.18, h], { side: paint, top: paint, front: TEX.glass });               // fuselage
  b.box([-hx * 0.3, -hy, h * 0.55], [hx * 0.25, hy, h * 0.75], { side: TEX.houseStripe, top: paint, bottom: paint }); // wings
  b.box([-hx, -0.6, h], [-hx * 0.7, 0.6, h + hy * 0.4], { side: paint, top: paint });                                   // fin
  return b.mesh();
}

function dart(name: string, o: ObjectSpec): Mesh {
  const g = o.geometry;
  const hx = Math.max(3, g.major), r = Math.max(0.8, Math.min(g.minor, g.height) * 0.5);
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, 0);
  b.box([-hx, -r, -r], [hx, r, r], { side: TEX.steel, top: TEX.steel, bottom: TEX.steel, front: TEX.black });
  return b.mesh();
}

function plainBox(name: string, o: ObjectSpec): Mesh {
  const { paint } = styleFor(o.side);
  const g = o.geometry;
  const hx = Math.max(3, g.major), hy = Math.max(3, g.type === "BOX" ? g.minor : g.major), h = Math.max(3, g.height);
  const b = new MeshBuilder(name, UNIT_TEXTURE, ATLAS, PICKABLE);
  b.box([-hx, -hy, 0], [hx, hy, h], { side: paint, top: TEX.metal, front: TEX.housePanel });
  return b.mesh();
}

function shapeFor(name: string, o: ObjectSpec): Mesh {
  const { paint, helmet } = styleFor(o.side);
  if (o.kinds.has("INFANTRY")) return infantry(name, paint, helmet);
  if (o.kinds.has("PROJECTILE") || o.kinds.has("SMALL_MISSILE") || o.kinds.has("BALLISTIC_MISSILE")) return dart(name, o);
  if (o.kinds.has("AIRCRAFT")) return aircraft(name, o);
  if (o.kinds.has("VEHICLE") || o.kinds.has("HUGE_VEHICLE")) return vehicle(name, o);
  if (o.kinds.has("STRUCTURE")) return structure(name, o);
  return plainBox(name, o);
}

/** Placeholder meshes for every model the faction INIs name that `have` (lower-case names) does not cover. */
export function buildPlaceholderModels(patchDataDir: string, have: Set<string>): Mesh[] {
  const out: Mesh[] = [];
  const seen = new Set(have);
  for (const o of parseFactionObjects(patchDataDir)) {
    if (!o.model) continue;
    const base = seen.has(o.model.toLowerCase()) ? null : shapeFor(o.model, o);
    if (base) { out.push(base); seen.add(o.model.toLowerCase()); }
    const src = base ?? null;
    const building = o.kinds.has("STRUCTURE");
    if (o.damaged && !seen.has(o.damaged.toLowerCase()) && src) { out.push(retextured(src, o.damaged, UNIT_TEXTURE_DAMAGED)); seen.add(o.damaged.toLowerCase()); }
    if (o.rubble && !seen.has(o.rubble.toLowerCase()) && src) {
      out.push(collapsed(src, o.rubble, UNIT_TEXTURE_RUBBLE, building ? 0.4 : 0.75, building));
      seen.add(o.rubble.toLowerCase());
    }
  }
  return out;
}

export function writePlaceholderModels(patchDataDir: string, w3dDir: string): { models: number; bytes: number } {
  const dir = join(w3dDir, "Art", "W3D");
  mkdirSync(dir, { recursive: true });
  const have = new Set(Object.keys(buildFreeModels()).map((n) => n.toLowerCase()));
  let n = 0, bytes = 0;
  for (const m of buildPlaceholderModels(patchDataDir, have)) {
    const buf = encodeW3D([m]);
    writeFileSync(join(dir, `${m.name}.w3d`), buf);
    n++; bytes += buf.length;
  }
  return { models: n, bytes };
}

if (process.argv[1] && /placeholder-models\.ts$/.test(process.argv[1])) {
  const [patch, out] = process.argv.slice(2);
  if (!patch || !out) { console.error("usage: placeholder-models.ts <patchDataDir> <outDir>"); process.exit(2); }
  const r = writePlaceholderModels(patch, out);
  console.log(`${r.models} placeholder models, ${(r.bytes / 1e6).toFixed(2)} MB`);
}
