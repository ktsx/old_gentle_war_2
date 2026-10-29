#!/usr/bin/env node --experimental-strip-types
/**
 * map.ts — write SAGE `.map` files (the "chunky" DataChunk format) from a
 * compact JSON spec, so the free asset set can carry a playable map without
 * WorldBuilder.
 *
 * Format (GeneralsMD/Code/GameEngine/Source/Common/System/DataChunk.cpp):
 *
 *   "CkMp"  u32 tocCount  { u8 len, name bytes, u32 id }*     table of contents: chunk names AND dict keys
 *   chunks: { u32 tocId, u16 version, i32 dataSize, data }     nested chunks live inside the parent's data
 *   Dict:   u16 count { i32 tocId<<8 | type, value }            type 0 bool(u8) 1 int 2 real(f32) 3 ascii 4 unicode
 *   AsciiString: u16 len + bytes;  UnicodeString: u16 len + UTF-16LE
 *
 * Chunk layouts are those of the engine's parsers (WorldHeightMap.cpp,
 * SidesList.cpp, PolygonTrigger.cpp, TerrainLogic.cpp) and the WorldBuilder
 * writer (WHeightMapEdit.cpp saveToFile), at the versions the current engine
 * writes: HeightMapData 4, BlendTileData 8, WorldInfo 1, SidesList 3 (with an
 * empty PlayerScriptsList), ObjectsList/Object 3, PolygonTriggers 4,
 * GlobalLighting 3, WaypointsList 1.
 *
 * Spec:
 * {
 *   "name": "gxtest",
 *   "playable": [64, 64],           // cells inside the border (1 cell = 10 world units)
 *   "border": 8,                    // border cells on each side
 *   "height": 20,                   // flat height value (0..255; world z = value * 10/16)
 *   "heightNoise": 2,               // optional +/- bumps (deterministic)
 *   "terrain": { "name": "GxGrass", "tiles": 2 },  // TerrainType INI name; texture is tiles*64 px square
 *   "timeOfDay": "afternoon",           // morning | afternoon | evening | night: picks the lighting and,
 *                                       // at night, every object's NIGHT models (variants.ts)
 *   "weather": "snowy",                 // optional: SNOW models; with "snowfall": true a map.ini turns
 *   "snowfall": true,                   //   the snow particles on (Weather SnowEnabled)
 *   "players": [
 *     { "name": "GxPlayer", "faction": "FactionAmerica", "human": true,
 *       "displayName": "Player", "color": [0, 80, 255], "start": [32, 32] }   // start in playable cells
 *   ],
 *   "camera": [32, 32],             // InitialCameraPosition waypoint, playable cells
 *   "waypoints": [ { "name": "Foo", "at": [10, 10] } ],
 *   "objects": [ { "template": "AmericaCommandCenter", "at": [30, 30], "angle": 0, "owner": "GxPlayer", "health": 50 } ]
 * }
 *
 * Usage:
 *   node --experimental-strip-types map.ts build <spec.json> <out.map>
 *   node --experimental-strip-types map.ts dump <file.map>          # list chunks (sanity check / inspect retail maps)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Image32 } from "./tga.ts";

export interface MapPlayer {
  name: string;
  faction: string;
  human?: boolean;
  displayName?: string;
  color?: [number, number, number];
  start?: [number, number];
  startMoney?: number;
}
export interface MapObjectSpec {
  template: string;
  at: [number, number];
  z?: number;
  angle?: number;
  owner?: string;
  /** initial health in percent (objectInitialHealth); below 70 the DAMAGED model shows, below 35 REALLYDAMAGED */
  health?: number;
}
export interface MapSpec {
  name: string;
  playable: [number, number];
  border?: number;
  height?: number;
  heightNoise?: number;
  terrain: { name: string; tiles?: number };
  timeOfDay?: "morning" | "afternoon" | "evening" | "night";
  weather?: "normal" | "snowy";
  snowfall?: boolean;
  players: MapPlayer[];
  camera?: [number, number];
  waypoints?: { name: string; at: [number, number] }[];
  objects?: MapObjectSpec[];
}

export const MAP_XY_FACTOR = 10; // world units per cell (MapObject.h)
const TIME_OF_DAY: Record<string, number> = { morning: 1, afternoon: 2, evening: 3, night: 4 };
const FLAG_VAL = 0x7ada0000; // blended-tile record terminator (WorldHeightMap.h); unused with one texture

// Dict::DataType (no TS enum: node strip-only mode)
const DICT_BOOL = 0, DICT_INT = 1, DICT_REAL = 2, DICT_ASCII = 3, DICT_UNICODE = 4;
type DictValue = { t: 0; v: boolean } | { t: 1; v: number } | { t: 2; v: number } | { t: 3; v: string } | { t: 4; v: string };
export type Dict = Record<string, DictValue>;
export const D = {
  bool: (v: boolean): DictValue => ({ t: DICT_BOOL, v }),
  int: (v: number): DictValue => ({ t: DICT_INT, v }),
  real: (v: number): DictValue => ({ t: DICT_REAL, v }),
  str: (v: string): DictValue => ({ t: DICT_ASCII, v }),
  wstr: (v: string): DictValue => ({ t: DICT_UNICODE, v }),
};

/** Growable little-endian byte sink. */
class ByteSink {
  private buf = Buffer.alloc(64 * 1024);
  private len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = Buffer.alloc(cap);
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }
  get length() { return this.len; }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  u16(v: number) { this.ensure(2); this.buf.writeUInt16LE(v & 0xffff, this.len); this.len += 2; }
  i32(v: number) { this.ensure(4); this.buf.writeInt32LE(v | 0, this.len); this.len += 4; }
  u32(v: number) { this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; }
  f32(v: number) { this.ensure(4); this.buf.writeFloatLE(v, this.len); this.len += 4; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  patchI32(at: number, v: number) { this.buf.writeInt32LE(v | 0, at); }
  toBuffer(): Buffer { return Buffer.from(this.buf.subarray(0, this.len)); }
}

/** DataChunkOutput equivalent: chunks are written to a body, the TOC is prepended at the end. */
export class ChunkWriter {
  private toc = new Map<string, number>();
  private nextId = 1;
  private body = new ByteSink();
  private stack: number[] = []; // positions of size placeholders

  id(name: string): number {
    let id = this.toc.get(name);
    if (id === undefined) { id = this.nextId++; this.toc.set(name, id); }
    return id;
  }
  open(name: string, version: number) {
    this.body.u32(this.id(name));
    this.body.u16(version);
    this.stack.push(this.body.length);
    this.body.i32(0);
  }
  close() {
    const at = this.stack.pop();
    if (at === undefined) throw new Error("close() without open()");
    this.body.patchI32(at, this.body.length - at - 4);
  }
  int(v: number) { this.body.i32(v); }
  real(v: number) { this.body.f32(v); }
  byte(v: number) { this.body.u8(v); }
  bytes(b: Uint8Array) { this.body.bytes(b); }
  ascii(s: string) { const b = Buffer.from(s, "latin1"); this.body.u16(b.length); this.body.bytes(b); }
  unicode(s: string) { this.body.u16(s.length); this.body.bytes(Buffer.from(s, "utf16le")); }
  dict(d: Dict) {
    const keys = Object.keys(d);
    this.body.u16(keys.length);
    for (const k of keys) {
      const e = d[k];
      this.body.i32((this.id(k) << 8) | e.t);
      switch (e.t) {
        case DICT_BOOL: this.body.u8(e.v ? 1 : 0); break;
        case DICT_INT: this.body.i32(e.v); break;
        case DICT_REAL: this.body.f32(e.v); break;
        case DICT_ASCII: this.ascii(e.v); break;
        case DICT_UNICODE: this.unicode(e.v); break;
      }
    }
  }
  finish(): Buffer {
    if (this.stack.length) throw new Error(`${this.stack.length} chunk(s) left open`);
    const head = new ByteSink();
    head.bytes(Buffer.from("CkMp", "latin1"));
    head.u32(this.toc.size);
    for (const [name, id] of this.toc) {
      const b = Buffer.from(name, "latin1");
      head.u8(b.length); head.bytes(b); head.u32(id);
    }
    return Buffer.concat([head.toBuffer(), this.body.toBuffer()]);
  }
}

/** Deterministic small integer noise in [-amp, amp]. */
function bump(x: number, y: number, amp: number): number {
  if (!amp) return 0;
  let h = (x * 374761393 + y * 668265263) ^ 0x5bd1e995;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % (2 * amp + 1)) - amp;
}

const rgb = (c: [number, number, number]) => ((c[0] & 0xff) << 16) | ((c[1] & 0xff) << 8) | (c[2] & 0xff);

export function buildMap(spec: MapSpec): Buffer {
  const border = spec.border ?? 8;
  const [pw, ph] = spec.playable;
  const width = pw + 2 * border;
  const height = ph + 2 * border;
  const cells = width * height;
  const baseHeight = spec.height ?? 20;
  const tiles = spec.terrain.tiles ?? 1;      // texture is tiles x tiles 64-px tiles
  const numTiles = tiles * tiles;
  const w = new ChunkWriter();
  /** playable-cell coordinates -> world units (border included) */
  const world = (p: [number, number]) => [(p[0] + border) * MAP_XY_FACTOR, (p[1] + border) * MAP_XY_FACTOR];

  // --- HeightMapData v4 ---------------------------------------------------
  w.open("HeightMapData", 4);
  w.int(width); w.int(height); w.int(border);
  w.int(1); w.int(pw); w.int(ph);         // one boundary: the playable area
  w.int(cells);
  const hm = new Uint8Array(cells);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    hm[y * width + x] = Math.max(0, Math.min(255, baseHeight + bump(x, y, spec.heightNoise ?? 0)));
  }
  w.bytes(hm);
  w.close();

  // --- BlendTileData v8 ---------------------------------------------------
  // One texture class covering every cell; tileNdx>>2 picks the source tile.
  w.open("BlendTileData", 8);
  w.int(cells);
  const tileNdx = new Int16Array(cells);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = ((x % tiles) + tiles * (y % tiles)) % numTiles;
    tileNdx[y * width + x] = t << 2;
  }
  w.bytes(new Uint8Array(tileNdx.buffer));
  w.bytes(new Uint8Array(cells * 2));      // blendTileNdx: 0 = no blend
  w.bytes(new Uint8Array(cells * 2));      // extraBlendTileNdx
  w.bytes(new Uint8Array(cells * 2));      // cliffInfoNdx
  w.bytes(new Uint8Array(height * ((width + 7) >> 3))); // cellCliffState bitfield (v8)
  w.int(numTiles);                         // numBitmapTiles
  w.int(1);                                // numBlendedTiles (entry 0 is the implicit "no blend")
  w.int(1);                                // numCliffInfo (entry 0 is the default)
  w.int(1);                                // numTextureClasses
  w.int(0); w.int(numTiles); w.int(tiles); w.int(0); w.ascii(spec.terrain.name); // firstTile, numTiles, width, legacy, name
  w.int(0);                                // numEdgeTiles
  w.int(0);                                // numEdgeTextureClasses
  // no blended-tile records (each would end with FLAG_VAL), no cliff infos
  w.close();

  // --- WorldInfo v1 ---------------------------------------------------------
  w.open("WorldInfo", 1);
  // Weather enum (GlobalData.h): 0 normal, 1 snowy — WorldHeightMap reads it into GlobalData::m_weather
  w.dict({ weather: D.int(spec.weather === "snowy" ? 1 : 0), mapName: D.str(spec.name) });
  w.close();

  // --- SidesList v3 (must precede ObjectsList) ------------------------------
  w.open("SidesList", 3);
  // Neutral = empty playerName/faction; every player's default team is "team"+playerName (SidesList::addPlayerByTemplate).
  const sides: Dict[] = [{ playerName: D.str(""), playerIsHuman: D.bool(false), playerDisplayName: D.wstr("Neutral"), playerFaction: D.str(""), playerAllies: D.str(""), playerEnemies: D.str("") }];
  const teams: Dict[] = [{ teamName: D.str("team"), teamOwner: D.str(""), teamIsSingleton: D.bool(true) }];
  const others = (me: MapPlayer) => spec.players.filter((p) => p !== me).map((p) => p.name).join(" ");
  for (const p of spec.players) {
    sides.push({
      playerName: D.str(p.name),
      playerIsHuman: D.bool(!!p.human),
      playerDisplayName: D.wstr(p.displayName ?? p.name),
      playerFaction: D.str(p.faction),
      playerAllies: D.str(""),
      playerEnemies: D.str(others(p)),
      playerColor: D.int(rgb(p.color ?? [0, 80, 255])),
      ...(p.startMoney !== undefined ? { playerStartMoney: D.int(p.startMoney) } : {}),
    });
    teams.push({ teamName: D.str(`team${p.name}`), teamOwner: D.str(p.name), teamIsSingleton: D.bool(true) });
  }
  w.int(sides.length);
  for (const s of sides) { w.dict(s); w.int(0); } // dict + empty build list
  w.int(teams.length);
  for (const t of teams) w.dict(t);
  w.open("PlayerScriptsList", 1);
  for (let i = 0; i < sides.length; i++) { w.open("ScriptList", 1); w.close(); }
  w.close();
  w.close();

  // --- ObjectsList v3 -------------------------------------------------------
  w.open("ObjectsList", 3);
  let waypointId = 1;
  const waypoint = (name: string, at: [number, number]) => {
    const [x, y] = world(at);
    w.open("Object", 3);
    w.real(x); w.real(y); w.real(0); w.real(0);
    w.int(0);
    w.ascii("*Waypoints/Waypoint");
    w.dict({ waypointID: D.int(waypointId++), waypointName: D.str(name) });
    w.close();
  };
  spec.players.forEach((p, i) => { if (p.start) waypoint(`Player_${i + 1}_Start`, p.start); });
  waypoint("InitialCameraPosition", spec.camera ?? spec.players.find((p) => p.start)?.start ?? [pw / 2, ph / 2]);
  for (const wp of spec.waypoints ?? []) waypoint(wp.name, wp.at);
  for (const o of spec.objects ?? []) {
    const [x, y] = world(o.at);
    w.open("Object", 3);
    w.real(x); w.real(y); w.real(o.z ?? 0); w.real(o.angle ?? 0);
    w.int(0);
    w.ascii(o.template);
    const props: Dict = { originalOwner: D.str(`team${o.owner ?? ""}`) };
    if (o.health !== undefined) props.objectInitialHealth = D.int(o.health);
    w.dict(props);
    w.close();
  }
  w.close();

  // --- PolygonTriggers v4 ---------------------------------------------------
  w.open("PolygonTriggers", 4);
  w.int(0);
  w.close();

  // --- GlobalLighting v3 ----------------------------------------------------
  // Per time of day: terrain light 0, object light 0, object lights 1..2, terrain lights 1..2 (9 reals each), then shadow colour.
  w.open("GlobalLighting", 3);
  w.int(TIME_OF_DAY[spec.timeOfDay ?? "afternoon"] ?? 2);
  const light = (ambient: number, diffuse: number, dir: [number, number, number]) => {
    w.real(ambient); w.real(ambient); w.real(ambient);
    w.real(diffuse); w.real(diffuse); w.real(diffuse);
    w.real(dir[0]); w.real(dir[1]); w.real(dir[2]);
  };
  const fill: [number, number, number] = [0.6, 0.6, -0.5];
  // one set per time of day (morning, afternoon, evening, night): ambient, sun colour, sun direction
  const TIMES: { amb: [number, number, number]; sun: [number, number, number]; dir: [number, number, number]; fill: number }[] = [
    { amb: [0.32, 0.32, 0.36], sun: [0.95, 0.88, 0.78], dir: [-0.8, -0.3, -0.5], fill: 0.25 },   // morning: low, warm
    { amb: [0.35, 0.35, 0.35], sun: [0.9, 0.9, 0.9], dir: [-0.6, -0.4, -0.7], fill: 0.3 },        // afternoon
    { amb: [0.3, 0.26, 0.26], sun: [0.95, 0.7, 0.5], dir: [0.8, -0.3, -0.5], fill: 0.2 },         // evening: low, orange
    { amb: [0.12, 0.14, 0.22], sun: [0.3, 0.36, 0.55], dir: [-0.3, 0.5, -0.8], fill: 0.12 },      // night: moonlight
  ];
  const lightRgb = (amb: [number, number, number], dif: [number, number, number], dir: [number, number, number]) => {
    w.real(amb[0]); w.real(amb[1]); w.real(amb[2]);
    w.real(dif[0]); w.real(dif[1]); w.real(dif[2]);
    w.real(dir[0]); w.real(dir[1]); w.real(dir[2]);
  };
  for (const t of TIMES) {
    lightRgb(t.amb, t.sun, t.dir);                                         // terrain[0]
    lightRgb([t.amb[0] + 0.05, t.amb[1] + 0.05, t.amb[2] + 0.05], t.sun, t.dir);   // objects[0]
    light(0, t.fill, fill); light(0, 0, fill);   // objects[1], objects[2]
    light(0, t.fill, fill); light(0, 0, fill);   // terrain[1], terrain[2]
  }
  w.int(0x7f000000);                     // shadow colour ARGB
  w.close();

  // --- WaypointsList v1 (links) ----------------------------------------------
  w.open("WaypointsList", 1);
  w.int(0);
  w.close();

  return w.finish();
}

// --- MapCache.ini ------------------------------------------------------------------------------
// The engine's standard-map list is not a directory scan: MapCache::updateCache reads
// Maps\MapCache.ini (Core/GameEngine/Source/GameClient/MapUtil.cpp, INIMapCache.cpp) for the maps
// shipped in the .big, and only user maps are scanned from disk. Without this file the skirmish
// menu has no maps. The map key is the long path, quoted-printable (non-alphanumerics as _XX).

/** The engine's own CRC (Common/crc.cpp): crc = (crc << 1) + byte + old-top-bit, per byte. */
/** map.ini beside the map: per-map INI overrides (here: snowfall). Empty when the map needs none. */
export function buildMapIni(spec: MapSpec): string {
  if (!spec.snowfall) return "";
  // (the web build draws the flakes as quads: dx8caps reports no point-sprite support)
  return "; generated by tools/asset-pipeline/map.ts\nWeather\n  SnowEnabled = Yes\nEnd\n";
}

export function engineCrc(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) crc = ((crc << 1) + b + (crc >>> 31)) >>> 0;
  return crc;
}

export function quotedPrintable(s: string): string {
  return [...s].map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "_" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))).join("");
}

export function mapCacheEntry(spec: MapSpec, buf: Buffer): string {
  const border = spec.border ?? 8;
  const [pw, ph] = spec.playable;
  const world = (p: [number, number]) => [(p[0] + border) * MAP_XY_FACTOR, (p[1] + border) * MAP_XY_FACTOR];
  const f = (v: number) => v.toFixed(2);
  const pos = (p: [number, number]) => { const [x, y] = world(p); return `X:${f(x)} Y:${f(y)} Z:0.00`; };
  const starts = spec.players.filter((p) => p.start);
  const cam = spec.camera ?? starts[0]?.start ?? [pw / 2, ph / 2];
  const lines = [
    `MapCache ${quotedPrintable(`Maps\\${spec.name}\\${spec.name}.map`)}`,
    `  fileSize = ${buf.length}`,
    `  fileCRC = ${engineCrc(buf)}`,
    `  timestampLo = 0`,
    `  timestampHi = 0`,
    `  isOfficial = yes`,
    `  isMultiplayer = ${starts.length >= 2 ? "yes" : "no"}`,
    `  numPlayers = ${starts.length}`,
    `  extentMin = X:0.00 Y:0.00 Z:0.00`,
    `  extentMax = X:${f(pw * MAP_XY_FACTOR)} Y:${f(ph * MAP_XY_FACTOR)} Z:0.00`,
    `  displayName = ${quotedPrintable(spec.name)}`,   // Zero Hour shows the file name + "(players)"; nameLookupTag omitted
    `  InitialCameraPosition = ${pos(cam)}`,
    ...starts.map((p, i) => `  Player_${i + 1}_Start = ${pos(p.start!)}`),
    `END`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * The 128×128 preview the skirmish/map-select menus show (Maps/<name>/<name>.tga; the engine
 * copies it to <UserData>/MapPreviews/ and loads it as a mapped image): the playable area in
 * terrain green with a darker border, buildings as blocks and units as dots in their owner's
 * colour. Start positions are overlaid by the menu itself.
 */
export function buildMapPreview(spec: MapSpec): Image32 {
  const SIZE = 128;
  const [pw, ph] = spec.playable, border = spec.border ?? 0;
  const w = pw + 2 * border, h = ph + 2 * border;
  const img = new Image32(SIZE, SIZE, [60, 78, 40, 255]);
  let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const sx = SIZE / w, sy = SIZE / h;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const cx = x / sx, cy = h - y / sy;                       // image rows run top→bottom, map y runs upwards
    const inside = cx >= border && cx < border + pw && cy >= border && cy < border + ph;
    const n = Math.round((rnd() - 0.5) * 14);
    img.set(x, y, inside ? [92 + n, 128 + n, 56 + n, 255] : [60 + n, 74 + n, 40 + n, 255]);
  }
  const colourOf = (owner?: string): [number, number, number] => {
    const p = spec.players.find((pl) => pl.name === owner);
    return p?.color ?? [200, 200, 200];
  };
  const footprint = (template: string) => /CommandCenter/.test(template) ? 13 : /WarFactory|ArmsDealer/.test(template) ? 11
    : /Barracks|Supply|PowerPlant/.test(template) ? 8 : /Hole/.test(template) ? 5 : 0;
  for (const o of spec.objects ?? []) {
    const [r, g, b] = colourOf(o.owner);
    const cx = Math.round((border + o.at[0]) * sx), cy = Math.round(SIZE - (border + o.at[1]) * sy);
    const f = footprint(o.template);
    if (f) {
      const hw = Math.max(2, Math.round(f * sx / 2)), hh = Math.max(2, Math.round(f * sy / 2));
      img.fillRect(cx - hw, cy - hh, 2 * hw, 2 * hh, [Math.round(r * 0.6 + 60), Math.round(g * 0.6 + 60), Math.round(b * 0.6 + 60), 255]);
      img.strokeRect(cx - hw, cy - hh, 2 * hw, 2 * hh, [r, g, b, 255]);
    } else {
      img.fillRect(cx - 1, cy - 1, 2, 2, [r, g, b, 255]);
    }
  }
  return img;
}

export function buildMapCacheIni(entries: string[]): string {
  return `; MapCache.ini — generated by tools/asset-pipeline/map.ts for the free asset set\n\n${entries.join("\n")}`;
}

/** Minimal reader: list chunks with name/version/size (nested chunks are not descended). */
export function dumpMap(buf: Buffer): string[] {
  let p = 0;
  const names = new Map<number, string>();
  if (buf.toString("latin1", 0, 4) !== "CkMp") throw new Error("not a chunky map (missing CkMp)");
  p = 4;
  const count = buf.readUInt32LE(p); p += 4;
  for (let i = 0; i < count; i++) {
    const len = buf[p++];
    const name = buf.toString("latin1", p, p + len); p += len;
    names.set(buf.readUInt32LE(p), name); p += 4;
  }
  const out = [`toc: ${count} names`];
  while (p + 10 <= buf.length) {
    const id = buf.readUInt32LE(p); const ver = buf.readUInt16LE(p + 4); const size = buf.readInt32LE(p + 6);
    out.push(`${names.get(id) ?? `#${id}`} v${ver} ${size} bytes`);
    p += 10 + size;
  }
  return out;
}

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "build" && a && b) {
    const spec = JSON.parse(readFileSync(a, "utf8")) as MapSpec;
    const buf = buildMap(spec);
    mkdirSync(dirname(b), { recursive: true });
    writeFileSync(b, buf);
    console.log(`${b}: ${buf.length} bytes, ${spec.playable[0]}x${spec.playable[1]} playable (+${spec.border ?? 8} border)`);
  } else if (cmd === "dump" && a) {
    console.log(dumpMap(readFileSync(a)).join("\n"));
  } else {
    console.error("usage: map.ts build <spec.json> <out.map> | dump <file.map>");
    process.exit(2);
  }
}

if (process.argv[1] && /map\.ts$/.test(process.argv[1])) main();
