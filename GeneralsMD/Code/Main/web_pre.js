// GeneralsX @build WebPort 2026-10-21 — IDBFS mount as a runtime dependency.
//
// This file is linked with --pre-js, so it is compiled TOGETHER with the
// Emscripten runtime: `FS`, `IDBFS`, `addRunDependency` and
// `removeRunDependency` here are the same symbols the runtime uses, and
// Closure (Release profile) renames them consistently. The previous
// implementation lived in web_shell.html — outside the compiled module — and
// had to guess the minified names of FS.mkdir/mount/syncfs by scanning
// Function.prototype.toString(); in the v0.5.2 Release build that guess
// failed ("IDBFS mount failed"), so saves and options silently did not persist.
//
// What this does, before main() runs:
//   1. creates /userdata in MEMFS
//   2. mounts IDBFS over it (the engine's user-data dir — GlobalData.cpp)
//   3. loads previously saved data from IndexedDB (FS.syncfs(true)) and holds
//      the runtime until that completes (addRunDependency/removeRunDependency)
// After main() takes over, the C++ side flushes with FS.syncfs(false) — see
// GX_FlushIdbfs in EmscriptenMain.cpp.
Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push(function gxIdbfsPreRun() {
  try { FS.mkdir('/userdata'); } catch (e) { /* already exists */ }
  try {
    FS.mount(IDBFS, {}, '/userdata');
  } catch (e) {
    console.warn('[GeneralsX] IDBFS mount failed:', e);
    return;
  }
  addRunDependency('idbfs-load');
  try {
    var stage = document.getElementById('gx-stage');
    if (stage) stage.textContent = 'Loading saved data';
  } catch (e) { /* no shell UI — fine */ }
  FS.syncfs(true, function (err) {
    if (err) console.warn('[GeneralsX] IDBFS load failed:', err);
    else console.log('[GeneralsX] IDBFS load complete');
    removeRunDependency('idbfs-load');
  });
});
