// net-smoke.js — the virtual LAN between browsers (web/net): signaling server, WebRTC DataChannels,
// relay fallback. No engine involved.
//
// Starts web/net/server.ts on a free port, builds gxnet.js, serves a blank page with it, and opens
// SEPARATE browser contexts (separate profiles: BroadcastChannel cannot carry anything between them):
//   A, B   room "lan" over WebRTC (iceServers: [] — host candidates, localhost): a broadcast from A
//          reaches B, unicast A->B and B->A, and the stats show the DataChannel path was used
//   C      room "other": must not receive A's broadcast
//   D, E   room "relay" with forceRelay: broadcast + unicast both ways over the server
// usage: node tools/asset-pipeline/net-smoke.js            prints "NET SMOKE: OK"; exit 2 on failure
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const repo = path.resolve(__dirname, '..', '..');
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const failures = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

  // gxnet.js + a blank page, served over http (WebRTC and WebSocket need a real origin)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gxnet-'));
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(repo, 'web/net/build.ts'), dir]);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>gxnet</title><script src="gxnet.js"></script>');
  const pagePort = await freePort();
  const page = http.createServer((req, res) => {
    const f = path.join(dir, req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
    fs.createReadStream(f).pipe(res);
  }).listen(pagePort);

  const wsPort = await freePort();
  const server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(repo, 'web/net/server.ts'), String(wsPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  await new Promise((r) => server.stdout.once('data', r));

  const browser = await chromium.launch({ headless: true });
  const open = async (name, room, options) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (/GXNet/.test(m.text())) console.log(`[${name}] ${m.text()}`); });
    p.on('pageerror', (e) => { console.log(`[${name}] PAGEERROR ${e}`); failures.push(`${name}: page error ${e}`); });
    await p.goto(`http://localhost:${pagePort}/`);
    const ip = await p.evaluate(async ([url, o]) => {
      window.got = [];
      GXNet.onPacket((src, srcPort, destPort, bytes) => window.got.push({ src, srcPort, destPort, text: new TextDecoder().decode(bytes) }));
      return (await GXNet.connect(url, o)).ip;
    }, [`ws://localhost:${wsPort}/net/${room}`, options]);
    console.log(`[${name}] ${room}: ${ip.join('.')}`);
    return { name, p, ip, u32: ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0 };
  };
  const send = (who, destIP, destPort, srcPort, text) =>
    who.p.evaluate(([d, dp, sp, t]) => GXNet.send(d, dp, sp, new TextEncoder().encode(t)), [destIP, destPort, srcPort, text]);
  const got = (who) => who.p.evaluate(() => window.got);
  const stats = (who) => who.p.evaluate(() => GXNet.stats());
  const waitFor = async (who, pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred(await got(who))) return true; await who.p.waitForTimeout(100); }
    return false;
  };

  try {
    const rtc = { iceServers: [] };
    const A = await open('A', 'lan', rtc);
    const B = await open('B', 'lan', rtc);
    const C = await open('C', 'other', rtc);
    // wait for the DataChannel
    let open2 = false;
    for (let i = 0; i < 100 && !open2; i++) { open2 = (await stats(A)).rtcOpen === 1 && (await stats(B)).rtcOpen === 1; if (!open2) await A.p.waitForTimeout(100); }
    check(open2, 'A<->B DataChannel open');

    await send(A, 0xffffffff, 8086, 8086, 'hello lan');
    check(await waitFor(B, (g) => g.some((x) => x.text === 'hello lan' && x.src === A.u32 && x.destPort === 8086 && x.srcPort === 8086)), 'broadcast A -> B (src IP and ports)');
    await send(A, B.u32, 8088, 8087, 'to B');
    check(await waitFor(B, (g) => g.some((x) => x.text === 'to B' && x.destPort === 8088 && x.srcPort === 8087)), 'unicast A -> B');
    await send(B, A.u32, 8087, 8088, 'to A');
    check(await waitFor(A, (g) => g.some((x) => x.text === 'to A' && x.src === B.u32)), 'unicast B -> A');
    const sa = await stats(A), sb = await stats(B);
    console.log('stats A', JSON.stringify(sa), 'B', JSON.stringify(sb));
    check(sa.sentRtc >= 2 && sa.sentRelay === 0 && sb.recvRtc >= 2 && sb.recvRelay === 0, 'A/B traffic went over WebRTC, not the relay');
    await A.p.waitForTimeout(500);
    check((await got(C)).length === 0, 'room "other" received nothing');

    const D = await open('D', 'relay', { forceRelay: true });
    const E = await open('E', 'relay', { forceRelay: true });
    await send(D, (D.u32 & 0xffffff00 | 255) >>> 0, 8086, 8086, 'relay bcast');
    check(await waitFor(E, (g) => g.some((x) => x.text === 'relay bcast' && x.src === D.u32)), 'relay: subnet broadcast D -> E');
    await send(D, E.u32, 9000, 9001, 'relay to E');
    await send(E, D.u32, 9001, 9000, 'relay to D');
    check(await waitFor(E, (g) => g.some((x) => x.text === 'relay to E' && x.destPort === 9000 && x.srcPort === 9001)), 'relay: unicast D -> E');
    check(await waitFor(D, (g) => g.some((x) => x.text === 'relay to D' && x.src === E.u32)), 'relay: unicast E -> D');
    const sd = await stats(D);
    console.log('stats D', JSON.stringify(sd));
    check(sd.sentRelay >= 2 && sd.sentRtc === 0 && sd.recvRelay >= 1, 'D/E traffic went over the relay');

    // a peer leaving: A closes, B is told
    await A.p.close();
    let left = false;
    for (let i = 0; i < 50 && !left; i++) { left = (await stats(B)).peers === 0; if (!left) await B.p.waitForTimeout(100); }
    check(left, 'B saw A leave');
  } catch (e) {
    failures.push(String(e));
  } finally {
    await browser.close();
    server.kill();
    page.close();
  }
  if (failures.length) { console.error('=== NET SMOKE: FAIL ===\n' + failures.join('\n')); process.exit(2); }
  console.log('NET SMOKE: OK');
})().catch((e) => { console.error('NET SMOKE FAILED', e); process.exit(2); });
