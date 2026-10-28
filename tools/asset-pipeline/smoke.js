// Smoke test: load GeneralsZH.html in headless Chromium, collect console + page errors.
// usage: node smoke.js <url> <waitMs> <screenshot.png> [afterBeginMs] [--begin]
//   --begin            press the shell's Begin button once the engine is Ready, then wait afterBeginMs
//   SMOKE_KEYS=Space;Escape    keys to press after Begin
//   SMOKE_CLICKS=512,282;...   canvas clicks after Begin (viewport is 1024x768)
//   SMOKE_SETTLE_MS=60000      wait after the last click before the screenshot (e.g. a click that starts a game)
//   SMOKE_WAIT_FOR=<regex>     instead: wait until a console line after the last click matches (SMOKE_SETTLE_MS
//                              becomes the upper bound, default 150000), then 3 s more
//   SMOKE_EXPECT=a;b            console substrings that must appear (pair with ?diag=1)
//   SMOKE_FULL=1               print the whole console instead of head/tail
// exit 2 on FATAL C++ CRASH / page error / Begin never reached.
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2] || 'http://localhost:8888/GeneralsZH.html';
  const waitMs = Number(process.argv[3] || 40000);
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=4096'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const lines = []; globalThis.__smokeLines = lines;
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
  page.on('console', m => lines.push(`${stamp()} [${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', e => lines.push(`${stamp()} [PAGEERROR] ${String(e).slice(0, 500)}`));
  page.on('requestfailed', r => lines.push(`${stamp()} [REQFAIL] ${r.url()} ${r.failure()?.errorText}`));
  const statuses = {};
  page.on('response', r => { const s = r.status(); statuses[s] = (statuses[s] || 0) + 1; });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  // --begin: press the shell's Begin button once the engine reports Ready, then keep sampling.
  if (process.argv.includes('--begin')) {
    try {
      await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { state: 'visible', timeout: waitMs });
      // The shell hides the overlay on the first gesture anywhere; the button can vanish under the click.
      try { await page.click('#gx-start', { timeout: 5000 }); lines.push(`${stamp()} [SMOKE] clicked #gx-start`); }
      catch (e) { await page.keyboard.press('Space'); lines.push(`${stamp()} [SMOKE] #gx-start click raced the overlay; sent Space instead`); }
      await page.waitForTimeout(Number(process.argv[5] || 15000));
      // SMOKE_KEYS="Space;Escape" — key presses after Begin
      for (const k of (process.env.SMOKE_KEYS || '').split(';').filter(Boolean)) {
        await page.keyboard.press(k); lines.push(`${stamp()} [SMOKE] pressed ${k}`); await page.waitForTimeout(1500);
      }
      // wiggle the mouse so menus that wait for movement wake up
      await page.mouse.move(100, 100); await page.waitForTimeout(200); await page.mouse.move(400, 300, { steps: 10 }); await page.waitForTimeout(1500);
      // SMOKE_CLICKS="x,y;x,y" — canvas clicks after Begin, 2 s apart (coordinates in the 1024x768 viewport)
      for (const pt of (process.env.SMOKE_CLICKS || '').split(';').filter(Boolean)) {
        const [cx, cy] = pt.split(',').map(Number);
        await page.mouse.move(cx, cy); await page.waitForTimeout(300);
        await page.mouse.click(cx, cy, { delay: 150 }); // down and up a few frames apart, as a human would
        lines.push(`${stamp()} [SMOKE] clicked canvas ${cx},${cy}`);
        await page.waitForTimeout(2000);
      }
      // SMOKE_SETTLE_MS — keep sampling after the last click (a click that starts a game needs the load + first ticks)
      if (process.env.SMOKE_WAIT_FOR) {
        const re = new RegExp(process.env.SMOKE_WAIT_FOR);
        const from = lines.length, limit = Date.now() + Number(process.env.SMOKE_SETTLE_MS || 150000);
        while (Date.now() < limit && !lines.slice(from).some((l) => re.test(l))) await page.waitForTimeout(500);
        lines.push(`${stamp()} [SMOKE] ${lines.slice(from).some((l) => re.test(l)) ? 'saw' : 'gave up waiting for'} /${process.env.SMOKE_WAIT_FOR}/`);
        await page.waitForTimeout(3000);
      } else if (process.env.SMOKE_SETTLE_MS) await page.waitForTimeout(Number(process.env.SMOKE_SETTLE_MS));
    } catch (e) { lines.push(`${stamp()} [SMOKE] begin failed: ${String(e).slice(0, 200)}`); }
  } else {
    await page.waitForTimeout(waitMs);
  }
  const stage = await page.evaluate(() => ({
    stage: document.getElementById('gx-stage')?.textContent,
    label: document.getElementById('gx-label')?.textContent,
    counter: document.getElementById('gx-counter')?.textContent,
    error: document.getElementById('gx-error')?.style.display,
    errorDetail: document.getElementById('gx-error-detail')?.textContent?.slice(0, 500),
  }));
  await page.screenshot({ path: process.argv[4] || 'smoke.png' });
  console.log('=== UI STATE ===', JSON.stringify(stage, null, 1));
  console.log('=== HTTP STATUSES ===', JSON.stringify(statuses));
  console.log('=== CONSOLE (' + lines.length + ' lines, first 60 + last 40) ===');
  const show = (process.env.SMOKE_FULL || lines.length <= 100) ? lines : [...lines.slice(0, 60), '...', ...lines.slice(60, -40).filter(l => /\[SMOKE\]|FATAL|INI ERROR|LOAD:|GAMELOGIC:|\[MessageBox\]|PAGEERROR/.test(l)), ...lines.slice(-40)];
  console.log(show.join('\n'));
  await browser.close();
  const fatal = lines.filter(l => l.includes('FATAL C++ CRASH') || l.includes('[PAGEERROR]') || l.includes('begin failed'));
  // SMOKE_EXPECT="substr;substr" — each must appear in the console (use with ?diag=1 traces)
  for (const want of (process.env.SMOKE_EXPECT || '').split(';').filter(Boolean)) {
    if (!lines.some(l => l.includes(want))) fatal.push(`[SMOKE] expected console line not seen: ${want}`);
  }
  if (fatal.length) { console.error('=== SMOKE VERDICT: FAIL ===\n' + fatal.join('\n')); process.exit(2); }
  console.log('=== SMOKE VERDICT: OK (stage=' + stage.stage + ') ===');
})().catch(e => { console.error('SMOKE FAILED', e); console.error('=== CONSOLE (tail 60) ==='); console.error((globalThis.__smokeLines || []).slice(-60).join('\n')); process.exit(1); });
