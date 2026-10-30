// perf-probe.js — where does the time go? Boot and map load (synchronous archive reads) and a
// CPU profile of the running game, in headless Chromium.
//
// usage: node perf-probe.js <engine url> [profileMs] [out.json]
//   e.g. node perf-probe.js "http://localhost:8888/GeneralsZH.html?diag=1&args=-file+Maps/gxtest.map" 15000
// Prints:
//   - synchronous XHRs (count, bytes, ms blocked) before Ready, during the map load, in game
//   - frame times in game (requestAnimationFrame deltas: median, p95, max)
//   - the top functions by self time of a CPU profile taken in game (names need the
//     RelWithDebInfo build, ci-latest)
const { chromium } = require('playwright');
const fs = require('fs');

const url = process.argv[2];
const profileMs = Number(process.argv[3] || 15000);
const out = process.argv[4];

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--js-flags=--max-old-space-size=4096'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);
  const lines = [];
  page.on('console', (m) => lines.push(m.text()));
  await page.addInitScript(() => {
    const X = XMLHttpRequest.prototype, open = X.open, send = X.send, setHdr = X.setRequestHeader;
    window.__xhr = [];
    window.__phase = 'boot';
    X.open = function (method, u, async) { this.__sync = async === false; this.__url = String(u); return open.apply(this, arguments); };
    X.setRequestHeader = function (k, v) { if (/range/i.test(k)) this.__range = v; return setHdr.apply(this, arguments); };
    X.send = function () {
      if (!this.__sync) return send.apply(this, arguments);
      const t = performance.now();
      try { return send.apply(this, arguments); } finally {
        const ms = performance.now() - t;
        let bytes = 0;
        try { const r = this.response; bytes = r && r.byteLength !== undefined ? r.byteLength : (this.responseText || '').length; } catch (e) { /* type */ }
        window.__xhr.push({ phase: window.__phase, url: this.__url.split('/').pop().split('?')[0], range: this.__range || '', ms, bytes });
      }
    };
  });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { state: 'visible', timeout: 240000 });
  const tReady = Date.now();
  await page.evaluate(() => { window.__phase = 'load'; });
  try { await page.click('#gx-start', { timeout: 5000 }); } catch { await page.keyboard.press('Space'); }
  const waitLine = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (lines.some((l) => re.test(l))) return true; await page.waitForTimeout(250); } return false; };
  const inGame = await waitLine(/inGame=1 isPaused=0/, 300000);
  const tGame = Date.now();
  await page.evaluate(() => { window.__phase = 'game'; });
  console.log(`ready after ${((tReady - t0) / 1000).toFixed(1)} s, in game ${inGame ? 'after ' + ((tGame - tReady) / 1000).toFixed(1) + ' s more' : 'NEVER'}`);

  // frame times + CPU profile in game
  await page.evaluate((ms) => {
    window.__frames = [];
    let last = performance.now();
    const end = last + ms;
    const tick = (t) => { window.__frames.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, profileMs);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(profileMs);
  const { profile } = await cdp.send('Profiler.stop');

  const xhr = await page.evaluate(() => window.__xhr);
  const frames = (await page.evaluate(() => window.__frames)).slice(1).sort((a, b) => a - b);
  const q = (p) => frames.length ? frames[Math.min(frames.length - 1, Math.floor(p * frames.length))].toFixed(1) : '-';

  for (const ph of ['boot', 'load', 'game']) {
    const xs = xhr.filter((x) => x.phase === ph);
    const ms = xs.reduce((n, x) => n + x.ms, 0), bytes = xs.reduce((n, x) => n + x.bytes, 0);
    console.log(`sync XHR ${ph}: ${xs.length} requests, ${(bytes / 1e6).toFixed(2)} MB, ${(ms / 1000).toFixed(2)} s blocked`);
    const byFile = {};
    for (const x of xs) { const k = x.url; byFile[k] = byFile[k] || { n: 0, ms: 0, bytes: 0 }; byFile[k].n++; byFile[k].ms += x.ms; byFile[k].bytes += x.bytes; }
    for (const [k, v] of Object.entries(byFile).sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)) console.log(`   ${k}: ${v.n} reads, ${(v.bytes / 1e6).toFixed(2)} MB, ${v.ms.toFixed(0)} ms`);
  }
  console.log(`frames in game: ${frames.length} in ${profileMs / 1000} s — median ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${frames.length ? frames[frames.length - 1].toFixed(0) : '-'} ms`);

  // self time per function
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  let total = 0;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const name = n.callFrame.functionName || `(${n.callFrame.url.split('/').pop() || 'anon'})`;
    const d = dt[i] || 0;
    total += d;
    self.set(name, (self.get(name) || 0) + d);
  });
  console.log(`CPU profile (${(total / 1e6).toFixed(1)} s sampled), top self time:`);
  for (const [name, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 35)) console.log(`  ${(100 * us / total).toFixed(1).padStart(5)}%  ${name.slice(0, 110)}`);
  if (out) fs.writeFileSync(out, JSON.stringify({ xhr, frames, profile }));
  await browser.close();
})().catch((e) => { console.error('PERF PROBE FAILED', e); process.exit(1); });
