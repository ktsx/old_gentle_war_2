#!/usr/bin/env node --experimental-strip-types
/**
 * inventory.ts — dependency inventory for one (or more) game objects.
 *
 * Walks the SAGE INI data (extracted from INI.big / INIZH.big, or any folder
 * laid out as Data/INI/...) starting from an Object name and collects every
 * asset it references, transitively:
 *
 *   Object → Draw modules      → W3D models (Model=, Animation=, IdleAnimation=, *.SKL)
 *          → WeaponSet         → Weapon.ini  → FireFX/ProjectileObject/FireSound/...
 *          → Armor / Locomotor → Armor.ini / Locomotor.ini
 *          → Voice-, Sound-    → Voice.ini, SoundEffects.ini → AudioEvent → Sounds= → wav/mp3
 *          → SelectPortrait / ButtonImage / CommandSet → MappedImages → Image → Texture= (tga/dds)
 *          → FXList / ObjectCreationList / ParticleSystem → further Objects, sounds, textures
 *
 * Optionally, if a W3D folder is given, each referenced .w3d is opened and its
 * texture names (W3D_CHUNK_TEXTURE_NAME = 0x32) are added to the inventory.
 *
 * Output: a JSON report + a human summary listing exactly which files a
 * replacement/free asset set has to provide for that object to work.
 *
 * Usage:
 *   node --experimental-strip-types inventory.ts <iniRoot> <ObjectName>[,Object2,...] [--w3d <w3dDir>] [--json out.json] [--depth N]
 *     iniRoot = folder that contains "Data/INI" (case-insensitive)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// ----------------------------------------------------------------------------
// INI model: top-level blocks keyed by (kind, name); each keeps its raw lines.
// EA's files put every top-level block opener and its closing `End` in column 0,
// so a line-span scan is enough for inventory purposes (no full grammar).
// ----------------------------------------------------------------------------
export interface IniBlock {
  kind: string;      // Object, Weapon, AudioEvent, Image, CommandButton, ...
  name: string;
  file: string;
  lines: string[];   // body lines, comments stripped, trimmed, non-empty
}

const TOP_LEVEL_KINDS = new Set([
  "Object", "ObjectReskin", "Weapon", "Armor", "Locomotor", "AudioEvent", "DialogEvent",
  "MusicTrack", "Image", "CommandButton", "CommandSet", "FXList", "ParticleSystem",
  "ObjectCreationList", "Science", "Upgrade", "SpecialPower", "Animation", "DamageFX",
  "Crate", "PlayerTemplate", "EvaEvent",
]);

function stripComment(line: string): string {
  const i = line.indexOf(";");
  const j = line.indexOf("//");
  let cut = line.length;
  if (i >= 0) cut = Math.min(cut, i);
  if (j >= 0) cut = Math.min(cut, j);
  return line.slice(0, cut).trim();
}

export function parseIniFile(file: string): IniBlock[] {
  const text = readFileSync(file, "latin1");
  const blocks: IniBlock[] = [];
  let cur: IniBlock | null = null;
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    if (!cur) {
      const m = /^(\w+)\s+([^\s=]+)/.exec(line);
      if (m && TOP_LEVEL_KINDS.has(m[1])) {
        cur = { kind: m[1], name: m[2], file, lines: [] };
        depth = 0;
      }
      continue;
    }
    if (/^End\b/i.test(line)) {
      if (depth === 0) { blocks.push(cur); cur = null; } else depth--;
      continue;
    }
    cur.lines.push(line);
    // Nested blocks: openers that are followed by their own End. We only need
    // the depth count to find the top-level End, so count known module openers.
    if (isNestedOpener(line)) depth++;
  }
  return blocks;
}

const NESTED_OPENERS = /^(Draw|Body|Behavior|ClientBehavior|ClientUpdate|Die|Update|Collide|Damage|Create|Upgrade|SpecialPower|AI|Contain|DefaultConditionState|ConditionState|TransitionState|WeaponSet|ArmorSet|Prerequisites|Nugget|Blank|LightPulse|Sound|ParticleSystem|FXListAtBonePos|ViewShake|Tracer|AttachToBone|TerrainScorch|SoundRef|DeliverPayload|CreateObject|CreateDebris|ApplyRandomForce|ProductionUpdate|DockUpdate|AttachedParticleSystem|BuildBoneSystem|WeaponBonus|Locomotor|TurretSet|AltTurretSet|EvaEvent|Animation|Image)\b\s*(=|$)/i;
function isNestedOpener(line: string): boolean {
  // `Key = Value` with a plain value is not a block, except for the known module
  // openers (Draw = W3DModelDraw Tag, ConditionState = X, Behavior = ...).
  return NESTED_OPENERS.test(line) && !/^(Animation|Image|Sound|Locomotor|Upgrade|Damage)\s*=\s*\S/i.test(line);
}

function walkIni(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walkIni(p));
    else if (/\.ini$/i.test(n)) out.push(p);
  }
  return out;
}

function findIniDir(root: string): string {
  for (const cand of [join(root, "Data", "INI"), join(root, "data", "ini"), root]) {
    if (existsSync(cand)) return cand;
  }
  throw new Error(`no Data/INI under ${root}`);
}

export class IniDb {
  byKind = new Map<string, Map<string, IniBlock>>();
  constructor(root: string) {
    for (const f of walkIni(findIniDir(root))) {
      for (const b of parseIniFile(f)) {
        let m = this.byKind.get(b.kind);
        if (!m) this.byKind.set(b.kind, (m = new Map()));
        m.set(b.name.toLowerCase(), b);
      }
    }
  }
  get(kind: string, name: string): IniBlock | undefined {
    return this.byKind.get(kind)?.get(name.toLowerCase());
  }
  /** All `Key = value` pairs in a block whose key matches the regex. */
  values(b: IniBlock, keyRe: RegExp): string[] {
    const out: string[] = [];
    for (const l of b.lines) {
      const m = /^([\w]+)\s*=\s*(.+)$/.exec(l);
      if (m && keyRe.test(m[1])) out.push(m[2].trim());
    }
    return out;
  }
}

// ----------------------------------------------------------------------------
// W3D: collect texture names referenced by a .w3d file (chunk walker).
// ----------------------------------------------------------------------------
const W3D_CHUNK_TEXTURE_NAME = 0x32;
const W3D_CHUNK_HLOD_SUB_OBJECT = 0x704;
export function w3dReferences(buf: Buffer): { textures: Set<string>; subObjects: Set<string> } {
  const textures = new Set<string>();
  const subObjects = new Set<string>();
  const walk = (start: number, end: number) => {
    let p = start;
    while (p + 8 <= end) {
      const type = buf.readUInt32LE(p);
      const sizeField = buf.readUInt32LE(p + 4);
      const size = sizeField & 0x7fffffff;
      const hasSub = (sizeField & 0x80000000) !== 0;
      const body = p + 8;
      const next = Math.min(body + size, end);
      if (type === W3D_CHUNK_TEXTURE_NAME) {
        textures.add(buf.toString("latin1", body, buf.indexOf(0, body) >= 0 ? Math.min(buf.indexOf(0, body), next) : next));
      } else if (type === W3D_CHUNK_HLOD_SUB_OBJECT) {
        // W3dHLodSubObjectStruct: uint32 BoneIndex; char Name[32] ("Model.SubMesh")
        const s = buf.toString("latin1", body + 4, Math.min(body + 36, next));
        subObjects.add(s.split("\0")[0]);
      } else if (hasSub) {
        walk(body, next);
      }
      p = next;
    }
  };
  walk(0, buf.length);
  return { textures, subObjects };
}

// ----------------------------------------------------------------------------
// Inventory
// ----------------------------------------------------------------------------
export interface Inventory {
  objects: Set<string>;
  weapons: Set<string>;
  armors: Set<string>;
  locomotors: Set<string>;
  fxLists: Set<string>;
  particleSystems: Set<string>;
  ocls: Set<string>;
  audioEvents: Set<string>;
  commandSets: Set<string>;
  commandButtons: Set<string>;
  images: Set<string>;
  /** files (as the engine would look them up) */
  w3dFiles: Set<string>;
  textureFiles: Set<string>;
  audioFiles: Set<string>;
  unresolved: Set<string>;
}

const NONE = /^(none|null|)$/i;

export function inventory(db: IniDb, roots: string[], opts: { w3dDir?: string; maxDepth?: number } = {}): Inventory {
  const inv: Inventory = {
    objects: new Set(), weapons: new Set(), armors: new Set(), locomotors: new Set(), fxLists: new Set(),
    particleSystems: new Set(), ocls: new Set(), audioEvents: new Set(), commandSets: new Set(),
    commandButtons: new Set(), images: new Set(), w3dFiles: new Set(), textureFiles: new Set(),
    audioFiles: new Set(), unresolved: new Set(),
  };
  const maxDepth = opts.maxDepth ?? 3;

  const addModel = (name: string) => {
    const base = name.split(".")[0];                    // "AIRngr_SKL.AIRngr_STA" → AIRngr_SKL
    if (NONE.test(base)) return;
    inv.w3dFiles.add(`Art\\W3D\\${base}.w3d`);
  };

  const visitAudio = (name: string) => {
    if (NONE.test(name) || inv.audioEvents.has(name)) return;
    inv.audioEvents.add(name);
    const ev = db.get("AudioEvent", name) ?? db.get("DialogEvent", name) ?? db.get("MusicTrack", name);
    if (!ev) { inv.unresolved.add(`AudioEvent ${name}`); return; }
    for (const v of db.values(ev, /^(Sounds|Attack|Decay|Filename)$/i)) {
      for (const f of v.split(/\s+/)) {
        if (!f) continue;
        inv.audioFiles.add(ev.kind === "MusicTrack" || /\.mp3$/i.test(f) ? `Data\\Audio\\Tracks\\${f}` : `Data\\Audio\\Sounds\\${f.replace(/\.wav$/i, "")}.wav`);
      }
    }
  };

  const visitImage = (name: string) => {
    if (NONE.test(name) || inv.images.has(name)) return;
    inv.images.add(name);
    const im = db.get("Image", name);
    if (!im) { inv.unresolved.add(`Image ${name}`); return; }
    for (const t of db.values(im, /^Texture$/i)) inv.textureFiles.add(`Art\\Textures\\${t}`);
  };

  const visitFx = (name: string, depth: number) => {
    if (NONE.test(name) || inv.fxLists.has(name)) return;
    inv.fxLists.add(name);
    const fx = db.get("FXList", name);
    if (!fx) { inv.unresolved.add(`FXList ${name}`); return; }
    for (const v of db.values(fx, /^(Name)$/i)) {
      if (db.get("AudioEvent", v)) visitAudio(v);
      else if (db.get("ParticleSystem", v)) visitParticle(v, depth);
    }
    for (const v of db.values(fx, /^(Sound)$/i)) visitAudio(v);
  };

  const visitParticle = (name: string, depth: number) => {
    if (NONE.test(name) || inv.particleSystems.has(name)) return;
    inv.particleSystems.add(name);
    const ps = db.get("ParticleSystem", name);
    if (!ps) { inv.unresolved.add(`ParticleSystem ${name}`); return; }
    for (const t of db.values(ps, /^ParticleName$/i)) inv.textureFiles.add(`Art\\Textures\\${t}`);
    for (const n of db.values(ps, /^(SlaveSystem|AttachedSystem|PerParticleAttachedSystem)$/i)) visitParticle(n, depth);
  };

  const visitOcl = (name: string, depth: number) => {
    if (NONE.test(name) || inv.ocls.has(name)) return;
    inv.ocls.add(name);
    const o = db.get("ObjectCreationList", name);
    if (!o) { inv.unresolved.add(`ObjectCreationList ${name}`); return; }
    for (const v of db.values(o, /^(ObjectNames|DebrisNames|ObjectName)$/i)) for (const n of v.split(/\s+/)) visitObject(n, depth + 1);
    for (const v of db.values(o, /^(ModelNames)$/i)) for (const n of v.split(/\s+/)) addModel(n);
    for (const v of db.values(o, /^FXFinal$/i)) visitFx(v, depth);
  };

  const visitWeapon = (name: string, depth: number) => {
    if (NONE.test(name) || inv.weapons.has(name)) return;
    inv.weapons.add(name);
    const w = db.get("Weapon", name);
    if (!w) { inv.unresolved.add(`Weapon ${name}`); return; }
    for (const v of db.values(w, /^(FireSound|FireSoundPerClip|ProjectileDetonationSound)$/i)) visitAudio(v);
    for (const v of db.values(w, /^(FireFX|VeterancyFireFX|ProjectileDetonationFX|FireOCL|ProjectileDetonationOCL)$/i)) {
      // "VeterancyFireFX = HEROIC WeaponFX_x" → last token
      const n = v.split(/\s+/).pop()!;
      if (/OCL$/i.test(v) || db.get("ObjectCreationList", n)) visitOcl(n, depth); else visitFx(n, depth);
    }
    for (const v of db.values(w, /^ProjectileObject$/i)) visitObject(v, depth + 1);
  };

  const visitCommandSet = (name: string, depth: number) => {
    if (NONE.test(name) || inv.commandSets.has(name)) return;
    inv.commandSets.add(name);
    const cs = db.get("CommandSet", name);
    if (!cs) { inv.unresolved.add(`CommandSet ${name}`); return; }
    for (const v of db.values(cs, /^\d+$/)) {
      inv.commandButtons.add(v);
      const cb = db.get("CommandButton", v);
      if (!cb) { inv.unresolved.add(`CommandButton ${v}`); continue; }
      for (const img of db.values(cb, /^ButtonImage$/i)) visitImage(img);
      for (const o of db.values(cb, /^Object$/i)) if (depth < maxDepth) visitObject(o, depth + 1);
      for (const s of db.values(cb, /^UnitSpecificSound$/i)) visitAudio(s);
    }
  };

  const visitObject = (name: string, depth: number) => {
    if (NONE.test(name) || inv.objects.has(name) || depth > maxDepth) return;
    inv.objects.add(name);
    const o = db.get("Object", name) ?? db.get("ObjectReskin", name);
    if (!o) { inv.unresolved.add(`Object ${name}`); return; }
    // ObjectReskin X Parent — inherits parent; "Object Name" lines have no parent.
    for (const v of db.values(o, /^(Model|Animation|IdleAnimation|Turret|AltTurret|ParticleSysBone)$/i)) addModel(v.split(/\s+/)[0]);
    for (const v of db.values(o, /^(Weapon)$/i)) visitWeapon(v.split(/\s+/).pop()!, depth);
    for (const v of db.values(o, /^(Armor)$/i)) { const n = v.split(/\s+/).pop()!; inv.armors.add(n); if (!db.get("Armor", n)) inv.unresolved.add(`Armor ${n}`); }
    for (const v of db.values(o, /^Locomotor$/i)) for (const n of v.split(/\s+/).slice(1)) { inv.locomotors.add(n); if (!db.get("Locomotor", n)) inv.unresolved.add(`Locomotor ${n}`); }
    for (const v of db.values(o, /^(Voice\w*|Sound\w*|UnitSpecificSounds|\w+Sound)$/i)) if (!/^\w+\s*=|^\s*$/.test(v)) visitAudio(v.split(/\s+/).pop()!);
    for (const v of db.values(o, /^(SelectPortrait|ButtonImage)$/i)) visitImage(v);
    for (const v of db.values(o, /^CommandSet$/i)) visitCommandSet(v, depth);
    for (const v of db.values(o, /^(\w*FX|FXList\w*|\w*FXList|DeathFX|\w+FxList)$/i)) visitFx(v.split(/\s+/).pop()!, depth);
    for (const v of db.values(o, /^(\w*OCL|\w*ObjectCreationList\w*|\w*OCL\w*)$/i)) visitOcl(v.split(/\s+/).pop()!, depth);
    for (const v of db.values(o, /^(\w*ParticleSystem\w*|SystemName)$/i)) visitParticle(v.split(/\s+/).pop()!, depth);
    for (const v of db.values(o, /^(SpawnTemplateName|ObjectToSpawn|PayloadTemplateName|ProjectileObject|DebrisObject\w*|\w*ObjectName)$/i)) visitObject(v.split(/\s+/)[0], depth + 1);
    // "UnitSpecificSounds" nested block values are `Key = EventName` lines too.
    for (const l of o.lines) {
      const m = /^(\w+)\s*=\s*([\w-]+)$/.exec(l);
      if (m && db.get("AudioEvent", m[2])) visitAudio(m[2]);
    }
  };

  for (const r of roots) visitObject(r, 0);

  if (opts.w3dDir) {
    for (const f of [...inv.w3dFiles]) {
      const p = join(opts.w3dDir, f.split("\\").pop()!);
      const alt = join(opts.w3dDir, f.split("\\").pop()!.toLowerCase());
      const path = existsSync(p) ? p : existsSync(alt) ? alt : null;
      if (!path) { inv.unresolved.add(`W3D file ${f}`); continue; }
      const refs = w3dReferences(readFileSync(path));
      for (const t of refs.textures) inv.textureFiles.add(`Art\\Textures\\${t}`);
    }
  }
  return inv;
}

function main(argv: string[]): number {
  const [root, objects, ...rest] = argv;
  if (!root || !objects) { console.error("usage: inventory.ts <iniRoot> <Object[,Object]> [--w3d dir] [--json out] [--depth N]"); return 2; }
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const db = new IniDb(root);
  const kinds = [...db.byKind.entries()].map(([k, m]) => `${k}:${m.size}`).join(" ");
  console.error(`loaded blocks: ${kinds}`);
  const inv = inventory(db, objects.split(","), { w3dDir: flag("--w3d"), maxDepth: Number(flag("--depth") ?? 3) });
  const report: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(inv)) report[k] = [...(v as Set<string>)].sort();
  const out = flag("--json");
  if (out) { require("node:fs").writeFileSync(out, JSON.stringify(report, null, 2)); }
  console.log(`== Inventory for ${objects} ==`);
  for (const [k, v] of Object.entries(report)) {
    if (!v.length) continue;
    console.log(`\n${k} (${v.length}):`);
    for (const x of v) console.log(`  ${x}`);
  }
  return 0;
}

if (process.argv[1] && /inventory\.ts$/.test(process.argv[1])) process.exit(main(process.argv.slice(2)));
