/**
 * sw.ts — service worker of the launcher: keeps the app shell available offline.
 *
 * Cached (network first, the cached copy when the network fails): the launcher page, its script,
 * manifest and icons, and the engine page GeneralsZH.html / .js / .wasm. Precached on install, so
 * the first visit is enough to play offline afterwards.
 *
 * Not touched: the game archives. Stored sets live in OPFS (launcher.ts) and the engine reads them
 * through blob: URLs; streamed archives (assets/*.big) are fetched with synchronous Range XHRs,
 * which Chromium does not route through a service worker anyway. assets/manifest.json always goes
 * to the network (the launcher treats a failure as "offline").
 *
 * Built to sw.js by build.ts.
 */
/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE = "gx-shell-v1";
const SHELL = [
  "./", "index.html", "launcher.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "GeneralsZH.html", "GeneralsZH.js", "GeneralsZH.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // one by one: a missing optional file must not abort the whole install
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isShell(url: URL): boolean {
  if (url.origin !== self.location.origin) return false;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return false;
  const rel = url.pathname.slice(scope.pathname.length);
  return rel === "" || SHELL.includes(rel);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (!isShell(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // the query string (?assets=…, ?diag=1) selects behaviour in the page, not a different file
    const key = new Request(url.origin + url.pathname);
    try {
      const res = await fetch(req, { cache: "no-cache" });
      if (res.ok) await cache.put(key, res.clone());
      return res;
    } catch (e) {
      const hit = (await cache.match(key)) ?? (url.pathname.endsWith("/") ? await cache.match("index.html") : undefined);
      if (hit) return hit;
      throw e;
    }
  })());
});
