#!/usr/bin/env node --experimental-strip-types
/**
 * w3d.ts — a minimal writer for Westwood .w3d model files (mesh-only), plus a small
 * procedural mesh builder, for the free asset set.
 *
 * Format (GeneralsMD/Code/Libraries/Source/WWVegas/WW3D2/w3d_file.h): a file is a sequence of
 * chunks {u32 id, u32 size}; bit 31 of `size` marks a chunk that contains sub-chunks. A mesh is
 *
 *   MESH
 *     MESH_HEADER3           W3dMeshHeader3Struct (116 bytes)
 *     VERTICES               n × Vector3
 *     VERTEX_NORMALS         n × Vector3
 *     TRIANGLES              t × W3dTriStruct (3 × u32 indices, u32 attributes, plane normal, dist)
 *     VERTEX_SHADE_INDICES   n × u32
 *     MATERIAL_INFO          pass/vertex-material/shader/texture counts
 *     VERTEX_MATERIALS       VERTEX_MATERIAL { VERTEX_MATERIAL_NAME, VERTEX_MATERIAL_INFO }
 *     SHADERS                W3dShaderStruct (16 bytes)
 *     TEXTURES               TEXTURE { TEXTURE_NAME }
 *     MATERIAL_PASS          VERTEX_MATERIAL_IDS, SHADER_IDS, TEXTURE_STAGE { TEXTURE_IDS, STAGE_TEXCOORDS }
 *
 * The engine names the render object `<ContainerName>.<MeshName>`, or just `<MeshName>` when the
 * container is empty, and W3DModelDraw loads `Art/W3D/<Model>.w3d` on demand and asks for a render
 * object of the same name — so a mesh-only file whose MeshName is the model name is enough for a
 * static model. Animations the INI refers to simply fail to load (W3DModelDraw tolerates a null
 * animation handle). Front faces are counter-clockwise seen from outside: the engine's plane
 * normal is cross(v1 − v0, v2 − v0) (meshgeometry.cpp Compute_Plane).
 *
 * House colour: W3DAssetManager::Recolor_Asset recolours textures whose name starts with "ZHC";
 * with a 4th letter 'A' the texture's alpha channel is the amount of house colour blended in
 * (alpha 255 = untouched, alpha 0 = fully house colour).
 */
import { readFileSync } from "node:fs";

// --- chunk ids (w3d_file.h) ---------------------------------------------------------------
export const CHUNK = {
  MESH: 0x00000000,
  VERTICES: 0x00000002,
  VERTEX_NORMALS: 0x00000003,
  MESH_USER_TEXT: 0x0000000c,
  MESH_HEADER3: 0x0000001f,
  TRIANGLES: 0x00000020,
  VERTEX_SHADE_INDICES: 0x00000022,
  MATERIAL_INFO: 0x00000028,
  SHADERS: 0x00000029,
  VERTEX_MATERIALS: 0x0000002a,
  VERTEX_MATERIAL: 0x0000002b,
  VERTEX_MATERIAL_NAME: 0x0000002c,
  VERTEX_MATERIAL_INFO: 0x0000002d,
  TEXTURES: 0x00000030,
  TEXTURE: 0x00000031,
  TEXTURE_NAME: 0x00000032,
  MATERIAL_PASS: 0x00000038,
  VERTEX_MATERIAL_IDS: 0x00000039,
  SHADER_IDS: 0x0000003a,
  TEXTURE_STAGE: 0x00000048,
  TEXTURE_IDS: 0x00000049,
  STAGE_TEXCOORDS: 0x0000004a,
} as const;

export const W3D_NAME_LEN = 16;
export const MESH_FLAG = {
  COLLISION_TYPE_PHYSICAL: 0x00000010,
  COLLISION_TYPE_PROJECTILE: 0x00000020,
  COLLISION_TYPE_VIS: 0x00000040,
  COLLISION_TYPE_CAMERA: 0x00000080,
  HIDDEN: 0x00001000,
  CAST_SHADOW: 0x00008000,
} as const;
const VERTEX_CHANNEL_LOCATION = 1, VERTEX_CHANNEL_NORMAL = 2, FACE_CHANNEL_FACE = 1;

export type Vec3 = [number, number, number];
export type UV = [number, number];

// --- byte sink -------------------------------------------------------------------------------
class Sink {
  private chunks: Buffer[] = [];
  private cur = Buffer.alloc(4096);
  private pos = 0;
  get length() { return this.chunks.reduce((n, b) => n + b.length, 0) + this.pos; }
  private need(n: number) {
    if (this.pos + n <= this.cur.length) return;
    this.chunks.push(this.cur.subarray(0, this.pos));
    this.cur = Buffer.alloc(Math.max(4096, n)); this.pos = 0;
  }
  u8(v: number) { this.need(1); this.cur.writeUInt8(v & 0xff, this.pos); this.pos += 1; }
  u32(v: number) { this.need(4); this.cur.writeUInt32LE(v >>> 0, this.pos); this.pos += 4; }
  i32(v: number) { this.need(4); this.cur.writeInt32LE(v | 0, this.pos); this.pos += 4; }
  f32(v: number) { this.need(4); this.cur.writeFloatLE(v, this.pos); this.pos += 4; }
  vec3(v: Vec3) { this.f32(v[0]); this.f32(v[1]); this.f32(v[2]); }
  rgb(r: number, g: number, b: number) { this.u8(r); this.u8(g); this.u8(b); this.u8(0); }
  /** Fixed-size, zero-padded ASCII field (W3D_NAME_LEN style). */
  fixed(s: string, len: number) {
    if (Buffer.byteLength(s, "latin1") >= len) throw new Error(`name too long for ${len}-byte field: ${s}`);
    const b = Buffer.alloc(len); b.write(s, "latin1"); this.bytes(b);
  }
  bytes(b: Buffer) { this.need(b.length); b.copy(this.cur, this.pos); this.pos += b.length; }
  /** NUL-terminated string padded to a multiple of 4 (how the W3D exporter writes names). */
  cstr(s: string) {
    const n = Buffer.byteLength(s, "latin1") + 1, pad = (4 - (n % 4)) % 4;
    const b = Buffer.alloc(n + pad); b.write(s, "latin1"); this.bytes(b);
  }
  finish(): Buffer { this.chunks.push(this.cur.subarray(0, this.pos)); const out = Buffer.concat(this.chunks); this.chunks = [out]; this.cur = Buffer.alloc(0); this.pos = 0; return out; }
}

/** Builds a chunk: `body` writes into a fresh sink; the header is prefixed with the final size. */
function chunk(out: Sink, id: number, body: (s: Sink) => void, hasSubChunks = false) {
  const s = new Sink(); body(s);
  const data = s.finish();
  out.u32(id); out.u32((data.length | (hasSubChunks ? 0x80000000 : 0)) >>> 0); out.bytes(data);
}

// --- mesh data -----------------------------------------------------------------------------
export interface Mesh {
  /** MeshName (≤ 15 chars). For a mesh-only model this is the render-object name the INI's `Model =` uses. */
  name: string;
  container?: string;
  texture: string;          // e.g. "ZHCAGxUnits.tga"
  verts: Vec3[];
  normals: Vec3[];
  uvs: UV[];
  tris: [number, number, number][];
  flags?: number;           // MESH_FLAG.* (collision type, CAST_SHADOW)
  diffuse?: [number, number, number];
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: Vec3, b: Vec3) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a: Vec3): Vec3 { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

export function encodeW3D(meshes: Mesh[]): Buffer {
  const out = new Sink();
  for (const m of meshes) writeMesh(out, m);
  return out.finish();
}

function writeMesh(out: Sink, m: Mesh) {
  const n = m.verts.length, t = m.tris.length;
  if (m.normals.length !== n || m.uvs.length !== n) throw new Error(`${m.name}: normals/uvs must match vertex count`);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of m.verts) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let radius = 0;
  for (const v of m.verts) radius = Math.max(radius, Math.hypot(...sub(v, center)));
  const [dr, dg, db] = m.diffuse ?? [255, 255, 255];

  chunk(out, CHUNK.MESH, (mesh) => {
    chunk(mesh, CHUNK.MESH_HEADER3, (s) => {
      s.u32((4 << 16) | 2);                       // W3D_MAKE_VERSION(4,2)
      s.u32(m.flags ?? 0);
      s.fixed(m.name, W3D_NAME_LEN);
      s.fixed(m.container ?? "", W3D_NAME_LEN);
      s.u32(t); s.u32(n); s.u32(1); s.u32(0);     // NumTris, NumVertices, NumMaterials, NumDamageStages
      s.i32(0); s.u32(0); s.u32(0);               // SortLevel, PrelitVersion, FutureCounts[1]
      s.u32(VERTEX_CHANNEL_LOCATION | VERTEX_CHANNEL_NORMAL); s.u32(FACE_CHANNEL_FACE);
      s.vec3(min); s.vec3(max); s.vec3(center); s.f32(radius);
    });
    chunk(mesh, CHUNK.VERTICES, (s) => { for (const v of m.verts) s.vec3(v); });
    chunk(mesh, CHUNK.VERTEX_NORMALS, (s) => { for (const v of m.normals) s.vec3(norm(v)); });
    chunk(mesh, CHUNK.TRIANGLES, (s) => {
      for (const [a, b, c] of m.tris) {
        const p0 = m.verts[a], nrm = norm(cross(sub(m.verts[b], p0), sub(m.verts[c], p0)));
        s.u32(a); s.u32(b); s.u32(c); s.u32(0); s.vec3(nrm); s.f32(dot(p0, nrm));
      }
    });
    chunk(mesh, CHUNK.VERTEX_SHADE_INDICES, (s) => { for (let i = 0; i < n; i++) s.u32(i); });
    chunk(mesh, CHUNK.MATERIAL_INFO, (s) => { s.u32(1); s.u32(1); s.u32(1); s.u32(1); });
    chunk(mesh, CHUNK.VERTEX_MATERIALS, (s) => {
      chunk(s, CHUNK.VERTEX_MATERIAL, (vm) => {
        chunk(vm, CHUNK.VERTEX_MATERIAL_NAME, (x) => x.cstr(`${m.name}_mat`));
        chunk(vm, CHUNK.VERTEX_MATERIAL_INFO, (x) => {
          x.u32(0);                          // attributes: plain UV mapping
          x.rgb(255, 255, 255);              // ambient
          x.rgb(dr, dg, db);                 // diffuse
          x.rgb(0, 0, 0);                    // specular
          x.rgb(0, 0, 0);                    // emissive
          x.f32(1); x.f32(1); x.f32(0);      // shininess, opacity, translucency
        });
      }, true);
    }, true);
    chunk(mesh, CHUNK.SHADERS, (s) => {
      // DepthCompare LEQUAL(3), DepthMask on(1), ColorMask, DestBlend ZERO(0), FogFunc, PriGradient MODULATE(1),
      // SecGradient off(0), SrcBlend ONE(1), Texturing on(1), DetailColor(0), DetailAlpha(0), preset, AlphaTest off(0), post-detail ×2, pad
      for (const b of [3, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0]) s.u8(b);
    });
    chunk(mesh, CHUNK.TEXTURES, (s) => {
      chunk(s, CHUNK.TEXTURE, (tx) => chunk(tx, CHUNK.TEXTURE_NAME, (x) => x.cstr(m.texture)), true);
    }, true);
    chunk(mesh, CHUNK.MATERIAL_PASS, (s) => {
      chunk(s, CHUNK.VERTEX_MATERIAL_IDS, (x) => x.u32(0));
      chunk(s, CHUNK.SHADER_IDS, (x) => x.u32(0));
      chunk(s, CHUNK.TEXTURE_STAGE, (st) => {
        chunk(st, CHUNK.TEXTURE_IDS, (x) => x.u32(0));
        chunk(st, CHUNK.STAGE_TEXCOORDS, (x) => { for (const [u, v] of m.uvs) { x.f32(u); x.f32(v); } });
      }, true);
    }, true);
  }, true);
}

// --- procedural builder ----------------------------------------------------------------------
/** A rectangle of the texture atlas in pixels, mapped onto a face; `v` grows downwards like the image. */
export interface Region { x: number; y: number; w: number; h: number }

export class MeshBuilder {
  verts: Vec3[] = []; normals: Vec3[] = []; uvs: UV[] = []; tris: [number, number, number][] = [];
  name: string; texture: string; atlas: number; flags: number;
  constructor(name: string, texture: string, atlas: number, flags = 0) { this.name = name; this.texture = texture; this.atlas = atlas; this.flags = flags; }

  /**
   * Atlas pixels → W3D texcoords. V runs bottom-up: the engine's TGA loader lands images with
   * the origin at the bottom-left (Targa::Load's "IML" mod) and the Max exporter writes
   * V = 1 − y accordingly, so v = 0 is the image's bottom row. (Found the hard way: with the
   * 512-px atlas every mesh sampled the empty lower half; at 256 px the flip merely swapped
   * rows 0..3 for 3..0 and still looked like a texture.)
   */
  private uv(r: Region, s: number, t: number): UV {
    return [(r.x + s * r.w) / this.atlas, 1 - (r.y + t * r.h) / this.atlas];
  }
  /**
   * A flat-shaded quad. a,b,c,d are the top-left, top-right, bottom-right and bottom-left corners
   * as seen from outside (so a→b is the texture's u axis and a→d its v axis); the triangles are
   * emitted counter-clockwise from that side, which is what the engine treats as front-facing.
   */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, r: Region, tile = 1) {
    const nrm = norm(cross(sub(d, a), sub(b, a)));
    const i = this.verts.length;
    this.verts.push(a, b, c, d);
    for (let k = 0; k < 4; k++) this.normals.push(nrm);
    this.uvs.push(this.uv(r, 0, 0), this.uv(r, tile, 0), this.uv(r, tile, tile), this.uv(r, 0, tile));
    this.tris.push([i, i + 2, i + 1], [i, i + 3, i + 2]);
    return this;
  }
  /**
   * Axis-aligned box from min to max. `side` texture goes on the four walls (u along the wall,
   * v top→bottom), `top` on the roof, `bottom` (optional) under it. Faces whose normal points
   * at a wall we don't want (e.g. the ground side) can be skipped with `bottom: null`.
   */
  box(min: Vec3, max: Vec3, tex: { side: Region; top: Region; bottom?: Region | null; front?: Region; back?: Region }) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const side = tex.side, front = tex.front ?? side, back = tex.back ?? side;
    // walls: corners listed CCW from outside, starting top-left of the texture
    this.quad([x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0], front);  // +X (front: angle 0 faces +X)
    this.quad([x0, y1, z1], [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], back);   // -X
    this.quad([x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0], side);   // +Y
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], side);   // -Y
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], tex.top); // +Z
    if (tex.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], tex.bottom); // -Z
    return this;
  }
  /** A box whose top face is shrunk by `inset` on every side (a hip roof / tapered tower). */
  frustum(min: Vec3, max: Vec3, inset: number, tex: { side: Region; top: Region }) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max, i = inset;
    const tl: Vec3 = [x0 + i, y1 - i, z1], tr: Vec3 = [x1 - i, y1 - i, z1], br: Vec3 = [x1 - i, y0 + i, z1], bl: Vec3 = [x0 + i, y0 + i, z1];
    this.quad(br, tr, [x1, y1, z0], [x1, y0, z0], tex.side);
    this.quad(tl, bl, [x0, y0, z0], [x0, y1, z0], tex.side);
    this.quad(tr, tl, [x0, y1, z0], [x1, y1, z0], tex.side);
    this.quad(bl, br, [x1, y0, z0], [x0, y0, z0], tex.side);
    this.quad(tl, tr, br, bl, tex.top);
    return this;
  }
  /** Vertical cylinder (z0..z1) with `seg` sides; smooth-shaded wall, flat caps. */
  cylinder(cx: number, cy: number, z0: number, z1: number, r: number, seg: number, tex: { side: Region; top: Region; bottom?: Region }) {
    const base = this.verts.length;
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2, nx = Math.cos(a), ny = Math.sin(a);
      this.verts.push([cx + r * nx, cy + r * ny, z1], [cx + r * nx, cy + r * ny, z0]);
      this.normals.push([nx, ny, 0], [nx, ny, 0]);
      this.uvs.push(this.uv(tex.side, k / seg, 0), this.uv(tex.side, k / seg, 1));
    }
    for (let k = 0; k < seg; k++) {
      const a = base + k * 2;
      // outward normal: cross(v1-v0, v2-v0) must point along (nx,ny): going around with increasing angle, top first
      this.tris.push([a, a + 1, a + 3], [a, a + 3, a + 2]);
    }
    const cap = (z: number, up: boolean, reg: Region) => {
      const c = this.verts.length;
      this.verts.push([cx, cy, z]); this.normals.push([0, 0, up ? 1 : -1]); this.uvs.push(this.uv(reg, 0.5, 0.5));
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        this.verts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]); this.normals.push([0, 0, up ? 1 : -1]);
        this.uvs.push(this.uv(reg, 0.5 + 0.5 * Math.cos(a), 0.5 - 0.5 * Math.sin(a)));
      }
      for (let k = 0; k < seg; k++) this.tris.push(up ? [c, c + 1 + k, c + 2 + k] : [c, c + 2 + k, c + 1 + k]);
    };
    cap(z1, true, tex.top);
    if (tex.bottom) cap(z0, false, tex.bottom);
    return this;
  }
  /** Translate everything built so far. */
  translate(dx: number, dy: number, dz: number) {
    this.verts = this.verts.map(([x, y, z]) => [x + dx, y + dy, z + dz]);
    return this;
  }
  /** Rotate everything built so far around Z (radians). */
  rotateZ(angle: number) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const rot = ([x, y, z]: Vec3): Vec3 => [x * c - y * s, x * s + y * c, z];
    this.verts = this.verts.map(rot); this.normals = this.normals.map(rot);
    return this;
  }
  mesh(diffuse?: [number, number, number]): Mesh {
    return { name: this.name, texture: this.texture, verts: this.verts, normals: this.normals, uvs: this.uvs, tris: this.tris, flags: this.flags, diffuse };
  }
}

// --- reader for `dump` (sanity check of our own output) --------------------------------------
export function dumpW3D(buf: Buffer, indent = ""): string[] {
  const names = Object.fromEntries(Object.entries(CHUNK).map(([k, v]) => [v, k]));
  const lines: string[] = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const id = buf.readUInt32LE(p), raw = buf.readUInt32LE(p + 4), size = raw & 0x7fffffff, subs = (raw & 0x80000000) !== 0;
    const body = buf.subarray(p + 8, p + 8 + size);
    let extra = "";
    if (id === CHUNK.MESH_HEADER3) extra = ` name='${body.toString("latin1", 8, 24).replace(/\0+$/, "")}' container='${body.toString("latin1", 24, 40).replace(/\0+$/, "")}' tris=${body.readUInt32LE(40)} verts=${body.readUInt32LE(44)} flags=0x${body.readUInt32LE(4).toString(16)}`;
    if (id === CHUNK.TEXTURE_NAME || id === CHUNK.VERTEX_MATERIAL_NAME) extra = ` '${body.toString("latin1").replace(/\0+$/, "")}'`;
    lines.push(`${indent}${names[id] ?? "0x" + id.toString(16)} (${size} bytes)${extra}`);
    if (subs) lines.push(...dumpW3D(body, indent + "  "));
    p += 8 + size;
  }
  return lines;
}

if (process.argv[1] && /w3d\.ts$/.test(process.argv[1])) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "dump" && file) console.log(dumpW3D(readFileSync(file)).join("\n"));
  else { console.error("usage: w3d.ts dump <file.w3d>"); process.exit(2); }
}
