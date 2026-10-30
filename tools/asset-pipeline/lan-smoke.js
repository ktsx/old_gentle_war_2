// lan-smoke.js — two engines play a LAN game against each other in headless Chromium.
//
// usage: node lan-smoke.js <engine url (GeneralsZH.html)> [net url]
//   without a net url both pages share one browser context and the shell's BroadcastChannel
//   carries the virtual LAN (?virtual_net); with one (ws://host:port/net/room) each page gets its
//   own context and the packets go over gxnet.js (WebRTC, server relay as fallback).
//
// Host: MULTIPLAYER > NETWORK > CREATE GAME, waits for the client, PLAY GAME. Client: MULTIPLAYER >
// NETWORK, picks the game in the list, JOIN GAME, ACCEPT. Both must reach a running match
// ("inGame=1 isPaused=0", ?diag=1) and keep advancing logic frames together. Exit 2 on failure.
const { chromium } = require('playwright');

const engine = process.argv[2] || 'http://localhost:8888/GeneralsZH.html';
const net = process.argv[3] || '';
const S = 1024 / 800;                       // layouts are 800x600, the page 1024x768
const at = (x, y) => [Math.round(x * S), Math.round(y * S)];
const P = {
  multiplayer: at(400, 250), network: at(400, 250),
  host: at(537, 568), join: at(701, 568), firstGame: at(120, 96),
  start: at(696, 564),
};

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
  const shared = net ? null : await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const failures = [];
  const open = async (who, ip) => {
    const ctx = shared || await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    const lines = [];
    page.on('console', (m) => {
      const t = m.text();
      lines.push(t);
      if (/LAN|SHELL: (push|doPush)|GAMELOGIC: startNewGame:ENTER|NETWORK|NET:|FATAL|inGame=1|Virtual|GXNet/.test(t) && !/TICK-DIAG/.test(t)) console.log(`${stamp()} [${who}] ${t.slice(0, 220)}`);
    });
    page.on('pageerror', (e) => { lines.push(`[PAGEERROR] ${e}`); console.log(`${stamp()} [${who}] PAGEERROR ${String(e).slice(0, 200)}`); });
    const q = net ? `diag=1&net=${encodeURIComponent(net)}` : `diag=1&virtual_net&ip=${ip}`;
    await page.goto(`${engine}?${q}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForSelector('#gx-loading.gx-await-start #gx-start', { state: 'visible', timeout: 180000 });
    try { await page.click('#gx-start', { timeout: 5000 }); } catch { await page.keyboard.press('Space'); }
    const p = { who, page, lines };
    p.waitFor = async (re, ms, from = 0) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (lines.slice(from).some((l) => re.test(l))) return true;
        await page.waitForTimeout(250);
      }
      return false;
    };
    p.click = async (xy, label) => { await page.mouse.click(xy[0], xy[1]); console.log(`${stamp()} [${who}] click ${label}`); await page.waitForTimeout(1200); };
    return p;
  };

  const host = await open('host', '10.0.0.2');
  const client = await open('client', '10.0.0.3');
  for (const p of [host, client]) {
    if (!(await p.waitFor(/SHELL: doPush 'Menus\/MainMenu.wnd' -> created/, 120000))) failures.push(`${p.who}: no main menu`);
    await p.page.waitForTimeout(4000);
    await p.click(P.multiplayer, 'MULTIPLAYER');
    await p.click(P.network, 'NETWORK');
    if (!(await p.waitFor(/doPush 'Menus\/LanLobbyMenu.wnd' -> created/, 20000))) failures.push(`${p.who}: no LAN lobby`);
  }
  await host.page.waitForTimeout(2500);
  await host.click(P.host, 'CREATE GAME');
  if (!(await host.waitFor(/doPush 'Menus\/LanGameOptionsMenu.wnd' -> created/, 20000))) failures.push('host: no game room');
  await host.page.screenshot({ path: 'lan-host-room.png' });

  // the client's lobby lists the game once the host's announcements arrive
  await client.page.waitForTimeout(6000);
  await client.page.screenshot({ path: 'lan-client-lobby.png' });
  await client.click(P.firstGame, 'first game');
  await client.click(P.join, 'JOIN GAME');
  if (!(await client.waitFor(/doPush 'Menus\/LanGameOptionsMenu.wnd' -> created/, 20000))) failures.push('client: did not get into the game room');
  await client.page.waitForTimeout(3000);
  await client.click(P.start, 'ACCEPT');
  await host.page.waitForTimeout(4000);
  await host.page.screenshot({ path: 'lan-host-ready.png' });
  await host.click(P.start, 'PLAY GAME');

  for (const p of [host, client]) {
    const ok = await p.waitFor(/inGame=1 isPaused=0/, 240000);
    if (!ok) failures.push(`${p.who}: match did not start`);
    await p.page.screenshot({ path: `lan-${p.who}-game.png` });
  }
  // both sides advance: logic frames keep rising in lockstep
  const frame = (p) => { const m = [...p.lines].reverse().map((l) => /logicFrame=(\d+)/.exec(l)).find(Boolean); return m ? Number(m[1]) : -1; };
  const f0 = [frame(host), frame(client)];
  await host.page.waitForTimeout(20000);
  const f1 = [frame(host), frame(client)];
  console.log(`${stamp()} logic frames host ${f0[0]} -> ${f1[0]}, client ${f0[1]} -> ${f1[1]}`);
  if (!(f1[0] > f0[0] && f1[1] > f0[1])) failures.push(`logic stalled (host ${f0[0]}->${f1[0]}, client ${f0[1]}->${f1[1]})`);
  for (const p of [host, client]) if (p.lines.some((l) => /FATAL C\+\+ CRASH|\[PAGEERROR\]/.test(l))) failures.push(`${p.who}: crash / page error`);
  await browser.close();
  if (failures.length) { console.error('=== LAN SMOKE: FAIL ===\n' + failures.join('\n')); process.exit(2); }
  console.log('=== LAN SMOKE: OK ===');
})().catch((e) => { console.error('LAN SMOKE FAILED', e); process.exit(1); });
