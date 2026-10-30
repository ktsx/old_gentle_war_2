/**
 * launcher.ts — the start page: choose the game files, then open the engine page.
 *
 * Archives are kept in the origin private file system (OPFS), one directory per set:
 *   gx-assets/free/   the free asset set, downloaded from assets/ (assets/manifest.json lists it)
 *   gx-assets/own/    the player's own .big files, copied in from a folder or file picker
 * "Play" opens GeneralsZH.html?assets=opfs:<set>; web_pre.js turns the set's files into blob: URLs
 * the engine's BigVFS reads with synchronous Range XHRs (no network: offline works).
 * "Stream" opens the engine on the server's assets/ directly, as before.
 *
 * Built to launcher.js by build.ts (types stripped, no bundler).
 */

interface ManifestArchive { name: string; size: number; sha256: string }
interface Manifest { set: string; version: string; archives: ManifestArchive[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ROOT = "gx-assets";

/** Archives the engine mounts (EmscriptenMain.cpp startup_archives) — the ones worth copying. */
const ENGINE_ARCHIVES = [
  "INI.big", "Textures.big", "W3D.big", "maps.big", "Window.big", "English.big", "shaders.big", "Terrain.big",
  "INIZH.big", "TexturesZH.big", "W3DZH.big", "W3DEnglishZH.big", "MapsZH.big", "WindowZH.big",
  "EnglishZH.big", "ShadersZH.big", "TerrainZH.big",
  "Audio.big", "AudioEnglish.big", "Music.big", "AudioZH.big", "AudioEnglishZH.big", "MusicZH.big",
];
/** Without these Zero Hour does not start. */
const REQUIRED_OWN = ["INIZH.big", "W3DZH.big", "TexturesZH.big", "WindowZH.big", "MapsZH.big", "EnglishZH.big"];

const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

function setStatus(id: string, text: string, kind: "" | "ok" | "warn" | "err" = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

async function setDir(set: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const top = await root.getDirectoryHandle(ROOT, { create });
    return await top.getDirectoryHandle(set, { create });
  } catch {
    return null;
  }
}

async function listSet(set: string): Promise<Map<string, File>> {
  const out = new Map<string, File>();
  const dir = await setDir(set);
  if (!dir) return out;
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    if (entry.kind === "file" && /\.big$/i.test(entry.name)) out.set(entry.name.toLowerCase(), await (entry as FileSystemFileHandle).getFile());
  }
  return out;
}

async function removeSet(set: string) {
  try {
    const root = await navigator.storage.getDirectory();
    const top = await root.getDirectoryHandle(ROOT);
    await top.removeEntry(set, { recursive: true });
  } catch { /* nothing stored */ }
}

/** Copy a stream into gx-assets/<set>/<name>, reporting bytes. */
async function store(set: string, name: string, data: ReadableStream<Uint8Array>, onBytes: (n: number) => void) {
  const dir = (await setDir(set, true))!;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await (fh as any).createWritable();
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await w.write(value);
    onBytes(value.byteLength);
  }
  await w.close();
}

const VERSION_KEY = "gx-free-version";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };

function play(query: string) {
  // pass the diagnostics flag and a network room (?net=ws://host:8789/net/<room>, web/net) through
  const own = new URLSearchParams(location.search);
  let q = query;                                         // kept literal: "assets=opfs:free"
  for (const k of ["diag", "net"]) { const v = own.get(k); if (v) q += `&${k}=${encodeURIComponent(v)}`; }
  location.href = `GeneralsZH.html?${q}`;
}

// ------------------------------------------------------------------------------------------
// free set
// ------------------------------------------------------------------------------------------
let manifest: Manifest | null = null;

async function refreshFree() {
  const have = await listSet("free");
  const stored = read(VERSION_KEY);
  const complete = !!manifest && manifest.archives.every((a) => have.get(a.name.toLowerCase())?.size === a.size);
  $<HTMLButtonElement>("free-remove").disabled = have.size === 0;
  if (!manifest) {
    setStatus("free-status", have.size ? `Stored (${have.size} archives) — the server's list is unavailable (offline?)` : "The server's list of free archives is unavailable.", have.size ? "warn" : "err");
    $<HTMLButtonElement>("free-play").disabled = have.size === 0;
    $<HTMLButtonElement>("free-download").disabled = true;
    return;
  }
  const total = manifest.archives.reduce((n, a) => n + a.size, 0);
  if (complete && stored === manifest.version) {
    setStatus("free-status", `Ready to play offline — ${fmt(total)}, version ${manifest.version}`, "ok");
    $<HTMLButtonElement>("free-download").disabled = true;
  } else if (have.size) {
    setStatus("free-status", `An update is available (${fmt(total)}).`, "warn");
    $<HTMLButtonElement>("free-download").disabled = false;
  } else {
    setStatus("free-status", `Not downloaded — ${fmt(total)}.`);
    $<HTMLButtonElement>("free-download").disabled = false;
  }
  $<HTMLButtonElement>("free-play").disabled = !complete;
}

async function downloadFree() {
  if (!manifest) return;
  const bar = $<HTMLProgressElement>("free-progress");
  const total = manifest.archives.reduce((n, a) => n + a.size, 0);
  let got = 0;
  bar.hidden = false; bar.max = total; bar.value = 0;
  $<HTMLButtonElement>("free-download").disabled = true;
  try {
    await removeSet("free");
    for (const a of manifest.archives) {
      setStatus("free-status", `Downloading ${a.name}…`);
      const res = await fetch(`assets/${a.name}`, { cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`${a.name}: HTTP ${res.status}`);
      await store("free", a.name, res.body, (n) => { got += n; bar.value = got; });
    }
    write(VERSION_KEY, manifest.version);
    console.log(`LAUNCHER: free set stored (${got} bytes)`);
  } catch (e) {
    setStatus("free-status", `Download failed: ${(e as Error).message}`, "err");
    bar.hidden = true;
    $<HTMLButtonElement>("free-download").disabled = false;
    return;
  }
  bar.hidden = true;
  await refreshFree();
  await refreshStorage();
}

// ------------------------------------------------------------------------------------------
// own files
// ------------------------------------------------------------------------------------------
async function refreshOwn() {
  const have = await listSet("own");
  const list = $("own-files");
  list.textContent = "";
  for (const name of ENGINE_ARCHIVES) {
    const f = have.get(name.toLowerCase());
    if (!f && !REQUIRED_OWN.includes(name)) continue;
    const li = document.createElement("li");
    li.textContent = f ? `${name} (${fmt(f.size)})` : name;
    if (f) li.className = "have";
    list.appendChild(li);
  }
  const missing = REQUIRED_OWN.filter((n) => !have.has(n.toLowerCase()));
  const size = [...have.values()].reduce((n, f) => n + f.size, 0);
  if (!have.size) setStatus("own-status", "No files stored.");
  else if (missing.length) setStatus("own-status", `${have.size} archives (${fmt(size)}) — missing ${missing.join(", ")}.`, "warn");
  else setStatus("own-status", `${have.size} archives stored (${fmt(size)}).`, "ok");
  $<HTMLButtonElement>("own-play").disabled = have.size === 0;
  $<HTMLButtonElement>("own-remove").disabled = have.size === 0;
}

async function importOwn(files: FileList | null) {
  if (!files || !files.length) return;
  const wanted = new Map(ENGINE_ARCHIVES.map((n) => [n.toLowerCase(), n]));
  // a folder pick lists everything below it: take the archives the engine mounts, top-most first
  const picks = [...files]
    .filter((f) => wanted.has(f.name.toLowerCase()))
    .sort((a, b) => ((a as any).webkitRelativePath || a.name).split("/").length - ((b as any).webkitRelativePath || b.name).split("/").length);
  const seen = new Set<string>();
  const chosen = picks.filter((f) => !seen.has(f.name.toLowerCase()) && seen.add(f.name.toLowerCase()));
  if (!chosen.length) {
    setStatus("own-status", "No Generals / Zero Hour .big archives among the chosen files.", "err");
    return;
  }
  try { await navigator.storage.persist(); } catch { /* best effort */ }
  const bar = $<HTMLProgressElement>("own-progress");
  const total = chosen.reduce((n, f) => n + f.size, 0);
  let got = 0;
  bar.hidden = false; bar.max = total; bar.value = 0;
  try {
    for (const f of chosen) {
      setStatus("own-status", `Copying ${f.name}…`);
      await store("own", wanted.get(f.name.toLowerCase())!, f.stream(), (n) => { got += n; bar.value = got; });
    }
    console.log(`LAUNCHER: own files stored (${chosen.length} archives, ${got} bytes)`);
  } catch (e) {
    setStatus("own-status", `Copy failed: ${(e as Error).message}`, "err");
  }
  bar.hidden = true;
  await refreshOwn();
  await refreshStorage();
}

// ------------------------------------------------------------------------------------------
async function refreshStorage() {
  try {
    const e = await navigator.storage.estimate();
    $("storage").textContent = `Browser storage: ${fmt(e.usage ?? 0)} used of ${fmt(e.quota ?? 0)}`;
  } catch { /* no estimate */ }
}

async function main() {
  if (!navigator.storage?.getDirectory) {
    setStatus("free-status", "This browser has no origin private file system: only streaming works.", "err");
    setStatus("own-status", "This browser has no origin private file system: only streaming works.", "err");
  }
  try {
    const res = await fetch("assets/manifest.json", { cache: "no-store" });
    if (res.ok) manifest = await res.json();
  } catch { /* offline */ }

  $("free-play").addEventListener("click", () => play("assets=opfs:free"));
  $("free-download").addEventListener("click", () => { void downloadFree(); });
  $("free-remove").addEventListener("click", async () => { await removeSet("free"); write(VERSION_KEY, null); await refreshFree(); await refreshStorage(); });
  $("own-play").addEventListener("click", () => play("assets=opfs:own"));
  $("own-remove").addEventListener("click", async () => { await removeSet("own"); await refreshOwn(); await refreshStorage(); });
  for (const id of ["own-folder", "own-pick"]) {
    const input = $<HTMLInputElement>(id);
    input.addEventListener("change", () => { void importOwn(input.files); input.value = ""; });
  }
  $("stream-play").addEventListener("click", () => play("assets=server"));

  // installable app: the browser offers it once the service worker is in place
  let deferred: any = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("install").hidden = false; });
  $("install").addEventListener("click", async () => { if (deferred) { deferred.prompt(); deferred = null; $("install").hidden = true; } });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(() => console.log("LAUNCHER: service worker registered"))
      .catch((e) => console.warn("LAUNCHER: service worker failed", e));
  }

  await Promise.all([refreshFree(), refreshOwn(), refreshStorage()]);
  console.log("LAUNCHER: ready");
}

void main();
