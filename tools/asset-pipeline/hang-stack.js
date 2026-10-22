// hang-stack.js — where is the engine stuck? Boots the page like smoke.js (Begin, keys, clicks),
// then, once the console has been silent for `quietMs`, pauses the page through the DevTools
// protocol and prints the JS/wasm call stack. Use it with the RelWithDebInfo build (ci-latest),
// whose wasm keeps function names; the Release build only yields function indices.
//
// usage: node hang-stack.js <url> [quietMs] [maxWaitMs]
//   SMOKE_KEYS / SMOKE_CLICKS as in smoke.js (clicks 2 s apart, viewport 1024x768)
//   SMOKE_PAUSE_AFTER=<regex>  pause quietMs after a console line matching this instead of waiting for silence
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  const quietMs = Number(process.argv[3] || 20000);
  const maxWaitMs = Number(process.argv[4] || 400000);
  if (!url) { console.error('usage: node hang-stack.js <url> [quietMs] [maxWaitMs]'); process.exit(2); }
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  let lastConsole = Date.now();
  let trigger = 0;
  const pauseAfter = process.env.SMOKE_PAUSE_AFTER ? new RegExp(process.env.SMOKE_PAUSE_AFTER) : null;
  page.on('console', (m) => {
    lastConsole = Date.now();
    const text = m.text();
    if (pauseAfter && !trigger && pauseAfter.test(text)) trigger = Date.now();
    if (/GAMELOGIC|LOAD: progress=100|TICK-DIAG|FATAL|PAGEERROR|MessageBox|GBM_SELECTED/.test(text)) console.log(`${stamp()} ${text.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => console.log(`${stamp()} [PAGEERROR] ${String(e).slice(0, 300)}`));
  // the debugger must be attached before the main thread gets busy: any CDP command that needs
  // the renderer's main thread blocks until it yields, only Debugger.pause interrupts running wasm
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { timeout: 180000 });
  await page.click('#gx-start'); console.log(`${stamp()} clicked Begin`);
  await page.waitForTimeout(6000);
  for (const k of (process.env.SMOKE_KEYS || '').split(';').filter(Boolean)) { await page.keyboard.press(k); await page.waitForTimeout(1500); }
  await page.mouse.move(100, 100); await page.waitForTimeout(200); await page.mouse.move(400, 300, { steps: 10 }); await page.waitForTimeout(1500);
  for (const pt of (process.env.SMOKE_CLICKS || '').split(';').filter(Boolean)) {
    const [cx, cy] = pt.split(',').map(Number);
    await page.mouse.move(cx, cy); await page.waitForTimeout(300);
    await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up();
    console.log(`${stamp()} clicked ${cx},${cy}`);
    await page.waitForTimeout(2000);
  }
  // wait for the trigger / the console to go quiet (the main thread is busy), then pause and dump the stack
  const tStart = Date.now();
  if (pauseAfter) {
    while (!(trigger && Date.now() - trigger >= quietMs) && Date.now() - tStart < maxWaitMs) await new Promise((r) => setTimeout(r, 250));
    console.log(`${stamp()} ${trigger ? 'trigger seen' : 'trigger not seen'} — pausing`);
  } else {
    while (Date.now() - lastConsole < quietMs && Date.now() - tStart < maxWaitMs) await new Promise((r) => setTimeout(r, 1000));
    console.log(`${stamp()} console quiet for ${((Date.now() - lastConsole) / 1000).toFixed(0)}s — pausing`);
  }
  for (let sample = 0; sample < Number(process.env.SMOKE_SAMPLES || 3); sample++) {
    const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
    await cdp.send('Debugger.pause');
    const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 15000))]);
    if (!ev) { console.log(`${stamp()} pause ${sample}: no Debugger.paused event (main thread not in JS?)`); break; }
    console.log(`${stamp()} --- stack sample ${sample} (${ev.callFrames.length} frames) ---`);
    for (const f of ev.callFrames.slice(0, 60)) {
      const loc = f.location ? `${(f.url || '').split('/').pop()}:${f.location.lineNumber}` : '';
      console.log(`  ${f.functionName || '(anonymous)'}  ${loc}`);
    }
    await cdp.send('Debugger.resume');
    await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_SAMPLE_GAP || 1500)));
  }
  await browser.close();
})().catch((e) => { console.error('hang-stack failed:', e); process.exit(1); });
