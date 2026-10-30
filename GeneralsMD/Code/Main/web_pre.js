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

// GeneralsX @feature WebPort 2026-10-29 — asset sets kept in the browser (web/launcher).
//
// GeneralsZH.html?assets=opfs:<set> plays from the archives the launcher stored in the origin
// private file system, gx-assets/<set>/ (the free set it downloaded, or the player's own .big
// files). Before main() runs, each file becomes a blob: URL in window.GX_assetUrls (keys lower
// case); BigVFS::Mount_Archive reads through those instead of the server's assets/ directory.
// Synchronous XHR with a Range header works on blob: URLs and needs no network.
Module['preRun'].push(function gxAssetSetPreRun() {
  // Bracket access and promise chains throughout: the Release build runs this through Closure
  // (ADVANCED), which would rename the OPFS API's property names it has no externs for.
  var m = /^opfs:([A-Za-z0-9_-]+)$/.exec(new URLSearchParams(location.search).get('assets') || '');
  if (!m) return;
  var set = m[1];
  var storage = navigator['storage'];
  if (!storage || !storage['getDirectory']) {
    console.warn('[GeneralsX] no origin private file system: cannot use asset set ' + set);
    return;
  }
  addRunDependency('gx-asset-set');
  try {
    var stage = document.getElementById('gx-stage');
    if (stage) stage.textContent = 'Opening game files';
  } catch (e) { /* no shell UI */ }
  var urls = {};
  var count = 0;
  var done = function () {
    window['GX_assetUrls'] = urls;
    console.log('[GeneralsX] asset set ' + set + ': ' + count + ' archives');
    removeRunDependency('gx-asset-set');
  };
  storage['getDirectory']()
    .then(function (root) { return root['getDirectoryHandle']('gx-assets'); })
    .then(function (top) { return top['getDirectoryHandle'](set); })
    .then(function (dir) {
      var it = dir['values']();
      var step = function () {
        return it['next']().then(function (r) {
          if (r['done']) return;
          var entry = r['value'];
          if (entry['kind'] !== 'file' || !/\.big$/i.test(entry['name'])) return step();
          return entry['getFile']().then(function (file) {
            urls[entry['name'].toLowerCase()] = URL.createObjectURL(file);
            count++;
            return step();
          });
        });
      };
      return step();
    })
    .catch(function (e) { console.warn('[GeneralsX] asset set ' + set + ' unavailable:', e); })
    .then(done);
});
