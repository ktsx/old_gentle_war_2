/**
 * variants.ts — the NIGHT and SNOW models of every object the free set draws.
 *
 * Each Draw module lists a model per condition state, and night / snow maps switch every drawable
 * to its NIGHT / SNOW / SNOW NIGHT state (Object.cpp sets MODELCONDITION_NIGHT and _SNOW from the
 * map's time of day and weather): ABBarracks_N, ABBarracks_S, ABBarracks_DNS … The free set built
 * only the day models, so on such a map every building and most units drew nothing.
 *
 * For a state whose flags include NIGHT or SNOW, the same Draw module's state with the same flags
 * minus NIGHT / SNOW names the day model it stands for. A night variant is that mesh unchanged —
 * the map's night lighting does the rest; a snow variant swaps the plain unit atlas for a snowed
 * one (damaged / rubble textures stay, they are already dark). Models the free set does not draw
 * (no day mesh) are skipped.
 *
 * Usage (from build-free-assets.ts): writeVariantModels(patchDataDir, w3dDir, models); the snowed
 * atlas comes from snowAtlas(buildUnitAtlas()).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeW3D, type Mesh } from "./w3d.ts";
import { Image32 } from "./tga.ts";
import { ATLAS, UNIT_TEXTURE } from "./free-models.ts";

export const UNIT_TEXTURE_SNOW = "ZHCAGxUnitsS.tga";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.ini$/i.test(e)) out.push(p);
  }
  return out;
}

interface StateModel { flags: Set<string>; model: string }

/** Per Draw module: its condition states (not transitions) and their models. */
function drawModules(iniDir: string): StateModel[][] {
  const modules: StateModel[][] = [];
  for (const f of walk(join(iniDir, "Object"))) {
    let cur: StateModel[] | null = null;
    let flags: Set<string> | null = null;
    for (const raw of readFileSync(f, "latin1").split(/\r?\n/)) {
      const line = raw.replace(/;.*$/, "").trim();
      if (!line) continue;
      let m: RegExpExecArray | null;
      if (/^Object\s+\S+/.test(line) && raw.search(/\S/) === 0) { cur = null; flags = null; continue; }
      if ((m = /^Draw\s*=\s*(\w+)/i.exec(line))) { cur = []; modules.push(cur); flags = null; continue; }
      if (!cur) continue;
      if (/^DefaultConditionState\b/i.test(line)) flags = new Set();
      else if ((m = /^ConditionState\s*=\s*(.*)$/i.exec(line))) flags = new Set(m[1].toUpperCase().split(/\s+/).filter((f) => f && f !== "NONE"));
      else if (/^TransitionState\b/i.test(line)) flags = null;
      else if ((m = /^Model\s*=\s*(\S+)/i.exec(line)) && flags) {
        if (!/^none$/i.test(m[1])) cur.push({ flags, model: m[1] });
        flags = null;
      }
    }
  }
  return modules;
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Variant name -> { day model, snow? } for every NIGHT / SNOW state whose day model is known. */
export function collectVariants(patchDataDir: string, have: Map<string, Mesh>): Map<string, { base: string; snow: boolean }> {
  const out = new Map<string, { base: string; snow: boolean }>();
  for (const states of drawModules(join(patchDataDir, "INI"))) {
    for (const s of states) {
      if (!s.flags.has("NIGHT") && !s.flags.has("SNOW")) continue;
      const key = s.model.toLowerCase();
      if (have.has(key) || out.has(key)) continue;
      const dayFlags = new Set([...s.flags].filter((f) => f !== "NIGHT" && f !== "SNOW"));
      const day = states.find((d) => sameSet(d.flags, dayFlags));
      if (!day || !have.has(day.model.toLowerCase())) continue;
      out.set(key, { base: day.model.toLowerCase(), snow: s.flags.has("SNOW") });
    }
  }
  return out;
}

/** The unit atlas under snow: lighter overall, white drifts, cool tint. */
export function snowAtlas(src: Image32): Image32 {
  const img = new Image32(ATLAS, ATLAS, [0, 0, 0, 0]);
  let s = 31 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  for (let y = 0; y < ATLAS; y++) for (let x = 0; x < ATLAS; x++) {
    const [r, g, b, a] = src.get(x, y);
    const drift = 0.35 + 0.35 * (((x * 7 + y * 13) % 29) / 29) * 0.4 + rnd() * 0.12;   // patchy coverage
    const w = Math.min(0.85, drift);
    img.set(x, y, [
      Math.round(r + (236 - r) * w), Math.round(g + (240 - g) * w), Math.round(b + (248 - b) * w),
      a,   // keep the house-colour mask
    ]);
  }
  return img;
}

export function writeVariantModels(patchDataDir: string, w3dDir: string, models: Mesh[]): { models: number; bytes: number } {
  const have = new Map(models.map((m) => [m.name.toLowerCase(), m]));
  const dir = join(w3dDir, "Art", "W3D");
  mkdirSync(dir, { recursive: true });
  let n = 0, bytes = 0;
  for (const [name, v] of collectVariants(patchDataDir, have)) {
    const base = have.get(v.base)!;
    const texture = v.snow && base.texture === UNIT_TEXTURE ? UNIT_TEXTURE_SNOW : base.texture;
    // keep the INI's spelling of the name for the file (BigVFS keys are lower case anyway)
    const mesh: Mesh = { ...base, name, texture };
    const buf = encodeW3D([mesh]);
    writeFileSync(join(dir, `${name}.w3d`), buf);
    n++; bytes += buf.length;
  }
  return { models: n, bytes };
}
