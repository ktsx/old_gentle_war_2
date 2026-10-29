// Launcher smoke test (web/launcher): the asset sets kept in the browser and the offline app shell.
// usage: node launcher-smoke.js <site url, e.g. http://localhost:8888/> <dir with own .big files>
//
//   1. free set: Download stores assets/*.big in OPFS, Play boots the engine to the main menu
//      reading only those (no request for assets/*.big after Play).
//   2. offline: the service worker serves the launcher and the engine, the stored set plays.
//   3. own files: the file picker copies .big files into OPFS, Play boots on them.
//
// Every phase must reach "SHELL: doPush 'Menus/MainMenu.wnd' -> created" (the engine pages run
// with ?diag=1, which the launcher passes through). Exit 2 on failure.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const site = (process.argv[2] || 'http://localhost:8888/').replace(/\/?$/, '/');
const ownDir = process.argv[3];
const MENU = "SHELL: doPush 'Menus/MainMenu.wnd' -> created";
const BOOT_MS = 180000;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=4096'],
  });
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
  const lines = [];
  const failures = [];
  const log = (s) => { const l = `${stamp()} ${s}`; lines.push(l); console.log(l); };
  page.on('console', (m) => {
    const t = m.text();
    lines.push(`${stamp()} [${m.type()}] ${t.slice(0, 300)}`);
    if (/LAUNCHER:|\[GeneralsX\] asset set|SHELL: doPush|FATAL|not in the selected asset set|service worker/.test(t)) console.log(`${stamp()} ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => { const l = `[PAGEERROR] ${String(e).slice(0, 300)}`; lines.push(`${stamp()} ${l}`); console.log(`${stamp()} ${l}`); });
  let bigRequests = [];
  context.on('request', (r) => { if (/\/assets\/[^/?]+\.big(\?|$)/i.test(r.url())) bigRequests.push(r.url()); });

  const waitLine = async (re, ms, from = 0) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (lines.slice(from).some((l) => re.test(l))) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  /** Click a launcher Play button, Begin on the engine page, wait for the main menu. */
  const playTo = async (button, label) => {
    await page.waitForSelector(`${button}:not([disabled])`, { timeout: 30000 });
    bigRequests = [];
    const from = lines.length;
    await Promise.all([page.waitForURL(/GeneralsZH\.html/, { timeout: 30000 }), page.click(button)]);
    log(`[LSMOKE] ${label}: engine page ${page.url().replace(site, '')}`);
    await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { state: 'visible', timeout: BOOT_MS });
    try { await page.click('#gx-start', { timeout: 5000 }); } catch { await page.keyboard.press('Space'); }
    const ok = await waitLine(new RegExp(MENU.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), BOOT_MS, from);
    const crash = lines.slice(from).find((l) => /FATAL C\+\+ CRASH|\[PAGEERROR\]/.test(l));
    if (!ok) failures.push(`${label}: main menu not reached`);
    if (crash) failures.push(`${label}: ${crash}`);
    log(`[LSMOKE] ${label}: ${ok ? 'main menu' : 'NO MAIN MENU'}; assets/*.big requests after Play: ${bigRequests.length}`);
    await page.screenshot({ path: `launcher-${label}.png` });
    return ok;
  };

  const openLauncher = async (label) => {
    const from = lines.length;
    await page.goto(site + 'index.html?diag=1', { waitUntil: 'load', timeout: 60000 });
    if (!(await waitLine(/LAUNCHER: ready/, 30000, from))) failures.push(`${label}: launcher not ready`);
    log(`[LSMOKE] ${label}: free="${await page.textContent('#free-status')}" own="${await page.textContent('#own-status')}"`);
  };

  // ---- 1. free set -------------------------------------------------------------------------
  await openLauncher('free');
  {
    const from = lines.length;
    await page.click('#free-download');
    if (!(await waitLine(/LAUNCHER: free set stored/, 120000, from))) failures.push('free: download did not finish');
    await page.waitForSelector('#free-status.ok', { timeout: 30000 }).catch(() => failures.push('free: status not "ready"'));
  }
  // the service worker precaches the shell on install; let it settle before going offline
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 240; i++) {
      const c = await caches.open('gx-shell-v1');
      if (await c.match('GeneralsZH.wasm')) return `active, ${(await c.keys()).length} cached`;
      await new Promise((r) => setTimeout(r, 500));
    }
    return `active=${!!reg.active}, engine NOT cached`;
  });
  log(`[LSMOKE] service worker: ${sw}`);
  if (/NOT cached/.test(sw)) failures.push(`service worker: ${sw}`);
  if (await playTo('#free-play', 'free') && bigRequests.length) failures.push(`free: ${bigRequests.length} assets/*.big requests (should read OPFS)`);

  // ---- 2. offline --------------------------------------------------------------------------
  await context.setOffline(true);
  await openLauncher('offline');
  if (await playTo('#free-play', 'offline') && bigRequests.length) failures.push(`offline: ${bigRequests.length} assets/*.big requests`);
  await context.setOffline(false);

  // ---- 3. own files ------------------------------------------------------------------------
  if (ownDir) {
    await openLauncher('own');
    const files = fs.readdirSync(ownDir).filter((f) => /\.big$/i.test(f)).map((f) => path.join(ownDir, f));
    const from = lines.length;
    await page.setInputFiles('#own-pick', files);
    if (!(await waitLine(/LAUNCHER: own files stored/, 120000, from))) failures.push('own: copy did not finish');
    log(`[LSMOKE] own: "${await page.textContent('#own-status')}"`);
    if (await playTo('#own-play', 'own') && bigRequests.length) failures.push(`own: ${bigRequests.length} assets/*.big requests`);
  }

  await browser.close();
  if (failures.length) {
    console.error('=== CONSOLE (tail 60) ===\n' + lines.slice(-60).join('\n'));
    console.error('=== LAUNCHER SMOKE: FAIL ===\n' + failures.join('\n'));
    process.exit(2);
  }
  console.log('=== LAUNCHER SMOKE: OK ===');
})().catch((e) => { console.error('LAUNCHER SMOKE FAILED', e); process.exit(1); });
