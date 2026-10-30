#!/usr/bin/env node --experimental-strip-types
/**
 * server.ts — signaling + relay server for the virtual LAN between browsers (web/net/client.ts).
 *
 * A room is a virtual LAN: ws://host:port/net/<room>. Each peer that joins gets a virtual IP
 * 10.77.0.N (N = 2..254, unique in the room) and the list of the peers already there; the others
 * hear of the join / leave. The server then:
 *   - forwards signaling (JSON text frames {type:"signal", to:<ip u32>, data:…}) for WebRTC
 *     setup — SDP offers / answers and ICE candidates — stamping the sender's IP as "from";
 *   - relays game packets (binary frames) when no DataChannel is open between two peers (no
 *     STUN / TURN path, strict NATs, or forced for tests): 8-byte header destIP u32, destPort u16,
 *     srcPort u16 (big-endian) + payload. The server rewrites the first 4 bytes to the sender's IP
 *     before forwarding, so the receiver gets {srcIP, destPort, srcPort, payload}. destIP
 *     255.255.255.255 or 10.77.0.255 goes to everyone else in the room.
 *
 * Messages to a client (text frames): {type:"welcome", ip, peers:[ip…]}, {type:"join", ip},
 * {type:"leave", ip}, {type:"signal", from, data}, {type:"error", message}.
 *
 * WebSocket (RFC 6455) is implemented here by hand to keep the server dependency-free: handshake,
 * text / binary frames up to 2^53 bytes, client masking, ping / pong / close. Fragmented messages
 * are rejected (browsers do not fragment the small messages sent here).
 *
 * Usage: node --experimental-strip-types web/net/server.ts [port]   (default 8789; PORT env too)
 */
import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const SUBNET = (10 << 24) | (77 << 16);           // 10.77.0.0/24
const BROADCAST = 0xffffffff >>> 0;
const SUBNET_BROADCAST = (SUBNET | 255) >>> 0;
const MAX_FRAME = 1 << 20;                                // a game packet is < 1.5 KB; signaling a few KB

export const ipString = (ip: number) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".");

// ---------------------------------------------------------------------------------------------
// minimal WebSocket connection
// ---------------------------------------------------------------------------------------------
class WsConn {
  socket: Duplex;
  buf = Buffer.alloc(0);
  closed = false;
  onText: (s: string) => void = () => {};
  onBinary: (b: Buffer) => void = () => {};
  onClose: () => void = () => {};

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > MAX_FRAME) { this.close(1009); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (!fin || op === 0) { this.close(1003); return; }        // no fragmentation
      if (op === 1) this.onText(payload.toString("utf8"));
      else if (op === 2) this.onBinary(Buffer.from(payload));
      else if (op === 8) { this.close(1000); return; }
      else if (op === 9) this.frame(10, payload);              // ping -> pong
      // op 10 (pong): ignore
    }
  }

  frame(op: number, payload: Buffer) {
    if (this.closed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n])
      : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }
  sendText(s: string) { this.frame(1, Buffer.from(s, "utf8")); }
  sendBinary(b: Buffer) { this.frame(2, b); }
  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.frame(8, p);
    this.socket.end();
    this.finish();
  }
}

// ---------------------------------------------------------------------------------------------
// rooms
// ---------------------------------------------------------------------------------------------
interface Peer { ip: number; ws: WsConn }
const rooms = new Map<string, Map<number, Peer>>();

function join(room: string, ws: WsConn, log: (s: string) => void) {
  let peers = rooms.get(room);
  if (!peers) rooms.set(room, (peers = new Map()));
  let n = 2;
  while (n <= 254 && peers.has((SUBNET | n) >>> 0)) n++;
  if (n > 254) { ws.sendText(JSON.stringify({ type: "error", message: "room full" })); ws.close(1013); return; }
  const ip = (SUBNET | n) >>> 0;
  const me: Peer = { ip, ws };
  ws.sendText(JSON.stringify({ type: "welcome", ip, peers: [...peers.keys()] }));
  for (const p of peers.values()) p.ws.sendText(JSON.stringify({ type: "join", ip }));
  peers.set(ip, me);
  log(`join  room=${room} ip=${ipString(ip)} peers=${peers.size}`);

  ws.onText = (s) => {
    let m: any;
    try { m = JSON.parse(s); } catch { return; }
    if (m && m.type === "signal") {
      const to = peers!.get(m.to >>> 0);
      if (to) to.ws.sendText(JSON.stringify({ type: "signal", from: ip, data: m.data }));
    }
  };
  ws.onBinary = (b) => {
    if (b.length < 8) return;
    const dest = b.readUInt32BE(0);
    b.writeUInt32BE(ip, 0);                                       // receiver learns the source
    if (dest === BROADCAST || dest === SUBNET_BROADCAST) {
      for (const p of peers!.values()) if (p.ip !== ip) p.ws.sendBinary(b);
    } else {
      const to = peers!.get(dest);
      if (to && to.ip !== ip) to.ws.sendBinary(b);
    }
  };
  ws.onClose = () => {
    if (peers!.get(ip) !== me) return;
    peers!.delete(ip);
    for (const p of peers!.values()) p.ws.sendText(JSON.stringify({ type: "leave", ip }));
    if (!peers!.size) rooms.delete(room);
    log(`leave room=${room} ip=${ipString(ip)} peers=${peers!.size}`);
  };
}

export function startServer(port: number, log: (s: string) => void = (s) => console.log(s)) {
  const server = createServer((req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("WebSocket endpoint: /net/<room>\n");
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const m = /^\/net\/([A-Za-z0-9_.-]{1,64})\/?(\?.*)?$/.exec(req.url ?? "");
    const key = req.headers["sec-websocket-key"];
    if (!m || typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    (socket as any).setNoDelay?.(true);
    join(m[1], new WsConn(socket), log);
  });
  server.listen(port, () => log(`gxnet server on :${(server.address() as any).port} (ws://host:port/net/<room>)`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer(Number(process.argv[2] ?? process.env.PORT ?? 8789));
}
