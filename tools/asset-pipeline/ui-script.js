// ui-script.js — drive the menus step by step in headless Chromium and screenshot along the way.
// Boots like smoke.js (Begin), then runs a script of steps separated by ';':
//
//   click X,Y        left click (viewport 1024x768)
//   wheel X,Y,DY     move to X,Y and scroll the wheel by DY pixels (positive = down)
//   key NAME         keyboard press (Playwright key names: Escape, Enter, ArrowDown, ...)
//   wait MS          pause
//   waitfor MS REGEX wait (at most MS) until a console line logged after this step starts matches
//                    REGEX — e.g. "waitfor 150000 inGame=1 isPaused=0" (TICK-DIAG, needs ?diag=1)
//                    instead of a fixed pause for a map load; fails the script when it times out
//   shot FILE        screenshot
//   type TEXT        type TEXT into whatever has focus
//   js EXPR          evaluate EXPR in the page and print the JSON result (UI_EXPECT can match it); no ';' inside — it splits steps
//   reload           reload the page and boot again (same profile: IndexedDB saves survive)
//   mem              print the wasm heap and JS heap size
//   stack N          pause the page N times through the DevTools protocol and print the JS/wasm
//                    stacks (names with the RelWithDebInfo build) — for a page that stopped
//                    drawing; screenshots of a stuck page time out, this does not
//
// Every step waits 1.5 s afterwards. Exit code 2 when the page logs FATAL / PAGEERROR, or when a
// UI_EXPECT="substr;substr" line never appears in the console (use with ?diag=1 traces).
// usage: node ui-script.js <url> "<steps>" [bootWaitMs]
//   e.g. node ui-script.js "http://localhost:8888/GeneralsZH.html" "click 512,412;shot opt.png;key Escape;shot menu.png"
const { chromium } = require('playwright');

(async () => {
  const [url, steps, bootWait] = process.argv.slice(2);
  if (!url || !steps) { console.error('usage: node ui-script.js <url> "<steps>" [bootWaitMs]'); process.exit(2); }
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const t0 = Date.now();
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
  const fatal = [];
  const all = [];
  page.on('console', (m) => {
    const t = m.text();
    all.push(t);
    if (/FATAL C\+\+ CRASH|Assertion|abort\(/.test(t)) fatal.push(t);
    if (/GBM_SELECTED|GCM_SELECTED|FATAL|MessageBox|KEYS: meta|QUITMENU:|GAMELOGIC: startNewGame|SAVEGAME:|RECORDER:|SHELL:/.test(t)) console.log(`${stamp()} ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => { fatal.push(String(e)); console.log(`${stamp()} [PAGEERROR] ${String(e.stack || e).slice(0, 4000)}`); });
  // attach the debugger before the main thread gets busy (see hang-stack.js)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  const boot = async () => {
    await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { timeout: 180000 });
    await page.click('#gx-start');
    await page.waitForTimeout(Number(bootWait || 9000));
    await page.mouse.move(100, 100); await page.mouse.move(400, 300, { steps: 10 }); await page.waitForTimeout(1000);
  };
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await boot();
  for (const step of steps.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [op, arg = ''] = [step.split(' ')[0], step.slice(step.indexOf(' ') + 1)];
    if (op === 'click') {
      const [x, y] = arg.split(',').map(Number);
      await page.mouse.move(x, y); await page.waitForTimeout(200);
      await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
    } else if (op === 'wheel') {
      const [x, y, dy] = arg.split(',').map(Number);
      await page.mouse.move(x, y); await page.waitForTimeout(200); await page.mouse.wheel(0, dy);
    } else if (op === 'key') {
      await page.keyboard.press(arg);
    } else if (op === 'waitfor') {
      const sp = arg.indexOf(' ');
      const limit = Date.now() + Number(arg.slice(0, sp)), re = new RegExp(arg.slice(sp + 1));
      const from = all.length;
      while (Date.now() < limit && !all.slice(from).some((l) => re.test(l))) await page.waitForTimeout(250);
      if (!all.slice(from).some((l) => re.test(l))) fatal.push(`waitfor timed out: ${arg}`);
    } else if (op === 'type') {
      await page.keyboard.type(arg, { delay: 60 });
    } else if (op === 'js') {
      // evaluate an expression in the page and print it — e.g. "js FS.readdir('/userdata')"
      try { const line = `js: ${JSON.stringify(await page.evaluate(arg))}`; all.push(line); console.log(`${stamp()} ${line}`.slice(0, 4000)); }
      catch (e) { console.log(`${stamp()} js failed: ${String(e).split('\n')[0]}`); }
    } else if (op === 'reload') {
      // same browser context, so IndexedDB (/userdata: saves, options) survives
      await page.reload({ waitUntil: 'domcontentloaded' });
      await boot();
    } else if (op === 'wait') {
      await page.waitForTimeout(Number(arg));
    } else if (op === 'shot') {
      try { await page.screenshot({ path: arg, timeout: 20000 }); } catch (e) { console.log(`${stamp()} screenshot ${arg} failed: ${String(e).split('\n')[0]}`); }
    } else if (op === 'mem') {
      const m = await page.evaluate(() => {
        const mod = window.Module || {};
        const heap = mod.HEAPU8 ? mod.HEAPU8.length : (mod.wasmMemory ? mod.wasmMemory.buffer.byteLength : -1);
        const js = performance.memory ? performance.memory.usedJSHeapSize : -1;
        return { heapMB: Math.round(heap / 1048576), jsHeapMB: Math.round(js / 1048576) };
      }).catch((e) => ({ error: String(e) }));
      console.log(`${stamp()} mem ${JSON.stringify(m)}`);
    } else if (op === 'stack') {
      for (let i = 0; i < Number(arg || 3); i++) {
        const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
        await cdp.send('Debugger.pause');
        const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 15000))]);
        if (!ev) { console.log(`${stamp()} stack ${i}: no pause (main thread not in JS?)`); break; }
        console.log(`${stamp()} --- stack ${i} (${ev.callFrames.length} frames) ---`);
        for (const f of ev.callFrames.slice(0, 40)) console.log(`    ${f.functionName || '(anonymous)'}`);
        await cdp.send('Debugger.resume');
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else {
      console.error(`unknown step: ${step}`); process.exit(2);
    }
    console.log(`${stamp()} step: ${step}`);
    await page.waitForTimeout(1500);
  }
  await browser.close();
  for (const want of (process.env.UI_EXPECT || '').split(';').filter(Boolean)) {
    if (!all.some((l) => l.includes(want))) fatal.push(`expected console line not seen: ${want}`);
  }
  if (fatal.length) { console.error('=== UI SCRIPT: FAIL ===\n' + fatal.join('\n')); process.exit(2); }
  console.log('=== UI SCRIPT: OK ===');
})().catch((e) => { console.error('ui-script failed:', e); process.exit(1); });
