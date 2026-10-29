#!/usr/bin/env node --experimental-strip-types
/**
 * build-free-assets.ts — assemble a bootable, EA-file-free asset set for the
 * web engine (see assets-free/README.md).
 *
 * Inputs:
 *   assets-free/overlay/      our own files (Language.ini, HeaderTemplate.ini, Default/*.ini stubs)
 *   assets-free/windows/      .wnd layouts as JSON (expanded by wnd.ts)
 *   assets-free/maps/         .map specs as JSON (written by map.ts)
 *   GeneralsGamePatch corpus  Data/INI + generals.str, pinned (fetched into a cache dir or passed in)
 *
 * Output (<outDir>/assets/):
 *   INIZH.big     Data/INI/**, Data/English/{Language,HeaderTemplate,CommandMap}.ini, Data/English/generals.csf
 *   WindowZH.big  Window/Menus/*.wnd, Window/*.wnd (in-game HUD)
 *   TexturesZH.big Art/Textures/*.tga (tga.ts placeholders, hud-skin.ts atlases, mapped-images.ts labelled
 *                 placeholder atlases for every corpus MappedImage texture, fx-textures.ts particle/shadow/
 *                 track/beam sprites, free-models.ts unit atlas), Art/Terrain/*.tga
 *   MapsZH.big    Maps/<name>/<name>.map
 *   W3DZH.big     Art/W3D/*.w3d (free-models.ts: procedural models named after the corpus' retail model names;
 *                 placeholder-models.ts: sized stand-ins for every other faction model the INIs reference)
 *
 * Usage:
 *   node --experimental-strip-types tools/asset-pipeline/build-free-assets.ts <outDir> [--patch <dir>] [--cache <dir>]
 *
 * --patch  path to a GeneralsGamePatch checkout; otherwise one is cloned (depth 1, pinned) into --cache
 *          (default: <outDir>/.cache/GeneralsGamePatch).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseStr, buildCsf } from "./strings.ts";
import { buildWnd } from "./wnd.ts";
import { packDir } from "./big.ts";
import { encodeTga, writeFreeImages } from "./tga.ts";
import { writeHudSkin } from "./hud-skin.ts";
import { writePlaceholderAtlases } from "./mapped-images.ts";
import { writeFxTextures } from "./fx-textures.ts";
import { buildMap, buildMapPreview, mapCacheEntry, buildMapCacheIni } from "./map.ts";
import { writeFreeModels } from "./free-models.ts";
import { writePlaceholderModels } from "./placeholder-models.ts";

const PATCH_REPO = "https://github.com/TheSuperHackers/GeneralsGamePatch.git";
const PATCH_COMMIT = "6c7f40d6af6a4babb77a33a4502ec7656446c13e"; // 2026-09-18
const PATCH_DATA = "Patch104pZH/GameFilesEdited/Data";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const freeRoot = join(repoRoot, "assets-free");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ensurePatch(cacheDir: string): string {
  const dir = join(cacheDir, "GeneralsGamePatch");
  const stamp = join(dir, ".pinned-commit");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === PATCH_COMMIT) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  console.log(`fetching GeneralsGamePatch @ ${PATCH_COMMIT.slice(0, 9)} ...`);
  // blobless clone of the default branch, then check out the pinned commit (fetches only what it needs)
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", PATCH_REPO, dir], { stdio: "inherit" });
  execFileSync("git", ["-C", dir, "sparse-checkout", "set", PATCH_DATA], { stdio: "inherit" });
  execFileSync("git", ["-C", dir, "checkout", PATCH_COMMIT], { stdio: "inherit" });
  writeFileSync(stamp, PATCH_COMMIT + "\n");
  return dir;
}

function main() {
  const outDir = resolve(process.argv[2] ?? "free-assets-out");
  const cacheDir = resolve(arg("--cache") ?? join(outDir, ".cache"));
  const patchDir = arg("--patch") ? resolve(arg("--patch")!) : ensurePatch(cacheDir);
  const patchData = join(patchDir, PATCH_DATA);
  if (!existsSync(join(patchData, "INI"))) throw new Error(`no INI corpus at ${patchData}`);

  const stage = join(cacheDir, "stage"); // scratch lives with the cache (outDir may be a synced/mounted folder)
  rmSync(stage, { recursive: true, force: true });
  const iniStage = join(stage, "ini");
  const wndStage = join(stage, "wnd");
  const texStage = join(stage, "tex");
  const mapStage = join(stage, "maps");
  const w3dStage = join(stage, "w3d");
  mkdirSync(join(iniStage, "Data", "English"), { recursive: true });
  mkdirSync(join(wndStage, "Window", "Menus"), { recursive: true });

  // 1. INI corpus from the patch (not its multi-language .str files)
  cpSync(join(patchData, "INI"), join(iniStage, "Data", "INI"), { recursive: true });

  // 2. our overlay (stubs, language/font definitions) — wins over the corpus
  cpSync(join(freeRoot, "overlay"), iniStage, { recursive: true });

  // 3. strings: multi-language generals.str -> Data/English/generals.csf
  const entries = [
    ...parseStr(readFileSync(join(patchData, "generals.str"), "utf8"), "US"),
    ...parseStr(readFileSync(join(freeRoot, "strings.str"), "utf8"), "US"),   // our own labels (GX:*)
    ...parseStr(readFileSync(join(freeRoot, "command-strings.str"), "utf8"), "US"),   // hotkey names (gen-command-map.ts)
  ];
  writeFileSync(join(iniStage, "Data", "English", "generals.csf"), buildCsf(entries, "US"));
  console.log(`generals.csf: ${entries.length} labels`);

  // 4. window layouts
  const wndDir = join(freeRoot, "windows");
  for (const f of readdirSync(wndDir).filter((n) => n.endsWith(".wnd.json"))) {
    const spec = JSON.parse(readFileSync(join(wndDir, f), "utf8"));
    const dir = join(wndStage, "Window", spec.dir ?? "Menus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, spec.file), buildWnd(spec));
    console.log(`${spec.dir ?? "Menus"}/${spec.file}: built`);
  }

  // 5. placeholder images + the control bar skin (atlases, MappedImages, our ControlBarScheme.ini — the
  //    scheme replaces the corpus file, which references retail art)
  console.log(`textures: ${writeFreeImages(texStage).join(", ")}`);
  console.log(`hud skin: ${writeHudSkin(texStage, iniStage).join(", ")}`);
  // every texture the corpus MappedImages reference, as labelled placeholder atlases (mapped-images.ts)
  const ph = writePlaceholderAtlases(patchData, texStage);
  console.log(`placeholder atlases: ${ph.textures} textures, ${(ph.bytes / 1e6).toFixed(1)} MB`);
  // particles, shadow decals, track marks, beams (fx-textures.ts) — anything already written wins
  const have = new Set(readdirSync(join(texStage, "Art", "Textures")).map((n) => n.toLowerCase()));
  const fx = writeFxTextures(patchData, texStage, have);
  console.log(`fx textures: ${fx.textures} textures, ${(fx.bytes / 1e6).toFixed(2)} MB`);

  // 6. models (their shared texture goes into TexturesZH.big)
  console.log(`models: ${writeFreeModels(w3dStage, texStage).join(", ")}`);
  const placeholders = writePlaceholderModels(patchData, w3dStage);
  console.log(`placeholder models: ${placeholders.models} (${(placeholders.bytes / 1e6).toFixed(2)} MB) for the rest of the faction rosters`);

  // 7. maps
  const mapDir = join(freeRoot, "maps");
  const mapCache: string[] = [];
  for (const f of readdirSync(mapDir).filter((n) => n.endsWith(".map.json"))) {
    const spec = JSON.parse(readFileSync(join(mapDir, f), "utf8"));
    const dir = join(mapStage, "Maps", spec.name);
    mkdirSync(dir, { recursive: true });
    const buf = buildMap(spec);
    writeFileSync(join(dir, `${spec.name}.map`), buf);
    writeFileSync(join(dir, `${spec.name}.tga`), encodeTga(buildMapPreview(spec)));
    console.log(`Maps/${spec.name}/${spec.name}.map: ${buf.length} bytes (+ preview tga)`);
    mapCache.push(mapCacheEntry(spec, buf));
  }
  // the standard-map list the skirmish/map-select menus read (MapCache::updateCache)
  writeFileSync(join(mapStage, "Maps", "MapCache.ini"), buildMapCacheIni(mapCache));
  console.log(`Maps/MapCache.ini: ${mapCache.length} maps`);

  // 8. archives
  const assets = join(outDir, "assets");
  mkdirSync(assets, { recursive: true });
  const n1 = packDir(iniStage, join(assets, "INIZH.big"));
  const n2 = packDir(wndStage, join(assets, "WindowZH.big"));
  const n3 = packDir(texStage, join(assets, "TexturesZH.big"));
  const n4 = packDir(mapStage, join(assets, "MapsZH.big"));
  const n5 = packDir(w3dStage, join(assets, "W3DZH.big"));
  console.log(`INIZH.big: ${n1} files (${statSync(join(assets, "INIZH.big")).size} bytes)`);
  console.log(`WindowZH.big: ${n2} files`);
  console.log(`TexturesZH.big: ${n3} files`);
  console.log(`MapsZH.big: ${n4} files`);
  console.log(`W3DZH.big: ${n5} files`);
  rmSync(stage, { recursive: true, force: true });
}

main();
