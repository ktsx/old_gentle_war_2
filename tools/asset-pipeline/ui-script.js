// ui-script.js — drive the menus step by step in headless Chromium and screenshot along the way.
// Boots like smoke.js (Begin), then runs a script of steps separated by ';':
//
//   click X,Y        left click (viewport 1024x768)
//   wheel X,Y,DY     move to X,Y and scroll the wheel by DY pixels (positive = down)
//   key NAME         keyboard press (Playwright key names: Escape, Enter, ArrowDown, ...)
//   wait MS          pause
//   shot FILE        screenshot
//
// Every step waits 1.5 s afterwards. Exit code 2 when the page logs FATAL / PAGEERROR.
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
  page.on('console', (m) => {
    const t = m.text();
    if (/FATAL C\+\+ CRASH|Assertion|abort\(/.test(t)) fatal.push(t);
    if (/GBM_SELECTED|GCM_SELECTED|FATAL|MessageBox|OPTIONS:/.test(t)) console.log(`${stamp()} ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => { fatal.push(String(e)); console.log(`${stamp()} [PAGEERROR] ${String(e.stack || e).slice(0, 4000)}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { timeout: 180000 });
  await page.click('#gx-start');
  await page.waitForTimeout(Number(bootWait || 9000));
  await page.mouse.move(100, 100); await page.mouse.move(400, 300, { steps: 10 }); await page.waitForTimeout(1000);
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
    } else if (op === 'wait') {
      await page.waitForTimeout(Number(arg));
    } else if (op === 'shot') {
      await page.screenshot({ path: arg });
    } else {
      console.error(`unknown step: ${step}`); process.exit(2);
    }
    console.log(`${stamp()} step: ${step}`);
    await page.waitForTimeout(1500);
  }
  await browser.close();
  if (fatal.length) { console.error('=== UI SCRIPT: FAIL ===\n' + fatal.join('\n')); process.exit(2); }
  console.log('=== UI SCRIPT: OK ===');
})().catch((e) => { console.error('ui-script failed:', e); process.exit(1); });
