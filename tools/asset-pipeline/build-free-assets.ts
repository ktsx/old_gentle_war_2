#!/usr/bin/env node --experimental-strip-types
/**
 * build-free-assets.ts — assemble a bootable, EA-file-free asset set for the
 * web engine (see assets-free/README.md).
 *
 * Inputs:
 *   assets-free/overlay/      our own files (Language.ini, HeaderTemplate.ini, Default/*.ini stubs)
 *   assets-free/windows/      .wnd layouts as JSON (expanded by wnd.ts)
 *   GeneralsGamePatch corpus  Data/INI + generals.str, pinned (fetched into a cache dir or passed in)
 *
 * Output (<outDir>/assets/):
 *   INIZH.big     Data/INI/**, Data/English/{Language,HeaderTemplate,CommandMap}.ini, Data/English/generals.csf
 *   WindowZH.big  Window/Menus/*.wnd
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
  mkdirSync(join(iniStage, "Data", "English"), { recursive: true });
  mkdirSync(join(wndStage, "Window", "Menus"), { recursive: true });

  // 1. INI corpus from the patch (not its multi-language .str files)
  cpSync(join(patchData, "INI"), join(iniStage, "Data", "INI"), { recursive: true });

  // 2. our overlay (stubs, language/font definitions) — wins over the corpus
  cpSync(join(freeRoot, "overlay"), iniStage, { recursive: true });

  // 3. strings: multi-language generals.str -> Data/English/generals.csf
  const entries = parseStr(readFileSync(join(patchData, "generals.str"), "utf8"), "US");
  writeFileSync(join(iniStage, "Data", "English", "generals.csf"), buildCsf(entries, "US"));
  console.log(`generals.csf: ${entries.length} labels`);

  // 4. window layouts
  const wndDir = join(freeRoot, "windows");
  for (const f of readdirSync(wndDir).filter((n) => n.endsWith(".wnd.json"))) {
    const spec = JSON.parse(readFileSync(join(wndDir, f), "utf8"));
    writeFileSync(join(wndStage, "Window", "Menus", spec.file), buildWnd(spec));
    console.log(`${spec.file}: built`);
  }

  // 5. archives
  const assets = join(outDir, "assets");
  mkdirSync(assets, { recursive: true });
  const n1 = packDir(iniStage, join(assets, "INIZH.big"));
  const n2 = packDir(wndStage, join(assets, "WindowZH.big"));
  console.log(`INIZH.big: ${n1} files (${statSync(join(assets, "INIZH.big")).size} bytes)`);
  console.log(`WindowZH.big: ${n2} files`);
  rmSync(stage, { recursive: true, force: true });
}

main();
