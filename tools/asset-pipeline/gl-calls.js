// gl-calls.js — WebGL calls per frame in a running game, by function (headless Chromium).
//
// usage: node gl-calls.js <engine url, e.g. ...GeneralsZH.html?diag=1&args=-file+Maps/gxtest.map>
//   GL_LIMITS="texParameteri=20;enableVertexAttribArray=60"  fail (exit 2) when a function's calls
//                                                            per frame exceed its limit
// Every WebGL2 method is wrapped before the page loads; counting runs for 10 s once the map runs.
// Call counts do not depend on the (software) GPU, unlike frame times in CI: a cheap guard for the
// shim's state caching (gles3_fvf.cpp attribute cache, gles3_wrapper.cpp samplers).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1024, height: 768 } });
  const lines = []; p.on('console', (m) => lines.push(m.text()));
  await p.addInitScript(() => {
    window.__gl = {}; window.__count = false;
    const P = WebGL2RenderingContext.prototype;
    for (const k of Object.getOwnPropertyNames(P)) {
      let d; try { d = Object.getOwnPropertyDescriptor(P, k); } catch (e) { continue; }
      if (!d || typeof d.value !== 'function') continue;
      const f = d.value;
      P[k] = function () { if (window.__count) window.__gl[k] = (window.__gl[k] || 0) + 1; return f.apply(this, arguments); };
    }
  });
  await p.goto(process.argv[2]);
  await p.waitForSelector('#gx-loading.gx-await-start #gx-start', { state: 'visible', timeout: 240000 });
  await p.click('#gx-start');
  const end = Date.now() + 300000;
  while (Date.now() < end && !lines.some((l) => /inGame=1 isPaused=0/.test(l))) await p.waitForTimeout(500);
  await p.waitForTimeout(3000);
  const n = await p.evaluate(async () => {
    let frames = 0; window.__gl = {}; window.__count = true;
    await new Promise((r) => { const t0 = performance.now(); const tick = () => { frames++; if (performance.now() - t0 < 10000) requestAnimationFrame(tick); else r(); }; requestAnimationFrame(tick); });
    window.__count = false; return { frames, gl: window.__gl };
  });
  const per = Object.fromEntries(Object.entries(n.gl).map(([k, v]) => [k, v / n.frames]));
  const total = Object.values(per).reduce((a, b) => a + b, 0);
  console.log(`GL CALLS: ${Math.round(total)} per frame over ${n.frames} frames (draws ${Math.round((per.drawElements || 0) + (per.drawArrays || 0) + (per.drawElementsInstanced || 0))})`);
  for (const [k, v] of Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(Math.round(v)).padStart(7), k);
  await b.close();
  const bad = [];
  for (const kv of (process.env.GL_LIMITS || '').split(';').filter(Boolean)) {
    const [k, lim] = kv.split('=');
    if ((per[k] || 0) > Number(lim)) bad.push(`${k}: ${Math.round(per[k])} per frame > ${lim}`);
  }
  if (!n.frames) bad.push('no frames counted');
  if (bad.length) { console.error('GL CALLS: FAIL\n' + bad.join('\n')); process.exit(2); }
  console.log('GL CALLS: OK');
})();
