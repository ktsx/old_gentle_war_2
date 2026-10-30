/**
 * client.ts — virtual UDP LAN between browsers: window.GXNet (built to gxnet.js by build.ts).
 *
 * The engine's UDP sockets become packets on a virtual 10.77.0.0/24 network shared by everyone
 * in a room of the signaling server (web/net/server.ts, ws://host:8789/net/<room>):
 *
 *   connect(url, opts?)  -> Promise<{ ip: [10, 77, 0, N] }>   joins the room, gets a virtual IP
 *   send(destIP, destPort, srcPort, bytes)                     destIP as u32; 255.255.255.255 or
 *                                                              x.x.x.255 = everyone in the room
 *   onPacket(cb(srcIP, srcPort, destPort, bytes))              every packet addressed to us
 *   stats()              -> { peers, rtcOpen, sentRtc, sentRelay, recvRtc, recvRelay }
 *
 * Path of a packet: a WebRTC DataChannel to that peer (unordered, no retransmits — UDP-like) when
 * it is open; otherwise the server relays it over the WebSocket. Both carry the same 8-byte header
 * (destIP u32, destPort u16, srcPort u16, big-endian) + payload. Over a DataChannel the receiver
 * knows the source IP from the channel; the relay writes it into the header's first 4 bytes.
 *
 * Peer setup: whoever has the lower virtual IP makes the offer (so exactly one side does); SDP and
 * ICE candidates go through the server. ICE servers: opts.iceServers, default Google STUN. With no
 * direct path (strict NATs, no TURN) the channel never opens and traffic stays on the relay.
 * opts.forceRelay skips WebRTC altogether (tests, or networks that block it).
 *
 * Plain script, no modules: the result is a global, set with bracket names so minifiers leave it.
 */

interface ConnectOptions { forceRelay?: boolean; iceServers?: RTCIceServer[] }
type PacketHandler = (srcIP: number, srcPort: number, destPort: number, bytes: Uint8Array) => void;

interface Peer { ip: number; pc: RTCPeerConnection | null; dc: RTCDataChannel | null; pending: RTCIceCandidateInit[] }

(function () {
  let ws: WebSocket | null = null;
  let myIP = 0;
  let opts: ConnectOptions = {};
  const peers = new Map<number, Peer>();
  const handlers: PacketHandler[] = [];
  const st = { sentRtc: 0, sentRelay: 0, recvRtc: 0, recvRelay: 0 };

  const octets = (ip: number) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255];
  const isBroadcast = (ip: number) => (ip >>> 0) === 0xffffffff || (ip & 255) === 255;

  function packet(destIP: number, destPort: number, srcPort: number, bytes: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + bytes.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, destIP >>> 0);
    dv.setUint16(4, destPort & 0xffff);
    dv.setUint16(6, srcPort & 0xffff);
    out.set(bytes, 8);
    return out;
  }

  function deliver(srcIP: number, data: ArrayBuffer, viaRtc: boolean) {
    if (data.byteLength < 8) return;
    const dv = new DataView(data);
    const destPort = dv.getUint16(4), srcPort = dv.getUint16(6);
    const bytes = new Uint8Array(data, 8);
    if (viaRtc) st.recvRtc++; else st.recvRelay++;
    for (const h of handlers) {
      try { h(srcIP >>> 0, srcPort, destPort, bytes); } catch (e) { console.warn("[GXNet] handler failed", e); }
    }
  }

  function signal(to: number, data: unknown) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", to, data }));
  }

  function closePeer(p: Peer) {
    try { p.dc?.close(); } catch { /* closed */ }
    try { p.pc?.close(); } catch { /* closed */ }
    p.dc = null; p.pc = null;
  }

  function attachChannel(p: Peer, dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    p.dc = dc;
    dc.onopen = () => console.log(`[GXNet] direct channel to ${octets(p.ip).join(".")} open`);
    dc.onclose = () => { if (p.dc === dc) p.dc = null; };
    dc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) deliver(p.ip, e.data, true); };
  }

  function makePc(p: Peer): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }] });
    p.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) signal(p.ip, { candidate: e.candidate.toJSON() }); };
    pc.ondatachannel = (e) => attachChannel(p, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") console.warn(`[GXNet] no direct path to ${octets(p.ip).join(".")}: using the relay`);
    };
    return pc;
  }

  async function addPeer(ip: number) {
    if (peers.has(ip)) return;
    const p: Peer = { ip, pc: null, dc: null, pending: [] };
    peers.set(ip, p);
    if (opts.forceRelay || typeof RTCPeerConnection === "undefined") return;
    if (myIP < ip) {
      const pc = makePc(p);
      attachChannel(p, pc.createDataChannel("gx", { ordered: false, maxRetransmits: 0 }));
      await pc.setLocalDescription(await pc.createOffer());
      signal(ip, { sdp: pc.localDescription });
    }
  }

  async function onSignal(from: number, data: any) {
    if (opts.forceRelay) return;
    let p = peers.get(from);
    if (!p) { p = { ip: from, pc: null, dc: null, pending: [] }; peers.set(from, p); }
    try {
      if (data.sdp) {
        const pc = p.pc ?? makePc(p);
        await pc.setRemoteDescription(data.sdp);
        for (const c of p.pending.splice(0)) await pc.addIceCandidate(c);
        if (data.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          signal(from, { sdp: pc.localDescription });
        }
      } else if (data.candidate) {
        if (p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate);
        else p.pending.push(data.candidate);
      }
    } catch (e) {
      console.warn("[GXNet] signaling failed", e);
    }
  }

  function connect(url: string, options: ConnectOptions = {}): Promise<{ ip: number[] }> {
    opts = options;
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(url);
      sock.binaryType = "arraybuffer";
      ws = sock;
      let welcomed = false;
      sock.onerror = () => { if (!welcomed) reject(new Error(`GXNet: cannot reach ${url}`)); };
      sock.onclose = () => {
        if (!welcomed) reject(new Error(`GXNet: ${url} closed`));
        else console.warn("[GXNet] signaling server connection closed");
        for (const p of peers.values()) closePeer(p);
        peers.clear();
      };
      sock.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {                       // relayed packet, srcIP stamped
          deliver(new DataView(e.data).getUint32(0), e.data, false);
          return;
        }
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "welcome") {
          myIP = m.ip >>> 0;
          welcomed = true;
          for (const ip of m.peers) void addPeer(ip >>> 0);
          console.log(`[GXNet] joined as ${octets(myIP).join(".")} (${m.peers.length} peers)`);
          resolve({ ip: octets(myIP) });
        } else if (m.type === "join") {
          void addPeer(m.ip >>> 0);
        } else if (m.type === "leave") {
          const p = peers.get(m.ip >>> 0);
          if (p) { closePeer(p); peers.delete(p.ip); }
        } else if (m.type === "signal") {
          void onSignal(m.from >>> 0, m.data);
        } else if (m.type === "error") {
          console.warn("[GXNet] server: " + m.message);
          if (!welcomed) reject(new Error("GXNet: " + m.message));
        }
      };
    });
  }

  function send(destIP: number, destPort: number, srcPort: number, bytes: Uint8Array) {
    destIP = destIP >>> 0;
    const pkt = packet(destIP, destPort, srcPort, bytes);
    const targets = isBroadcast(destIP) ? [...peers.values()] : peers.has(destIP) ? [peers.get(destIP)!] : [];
    let relay = targets.length === 0 && !isBroadcast(destIP);      // unknown host: let the server decide
    for (const p of targets) {
      if (p.dc && p.dc.readyState === "open") {
        try { p.dc.send(pkt); st.sentRtc++; continue; } catch { /* fall back */ }
      }
      relay = true;
      if (isBroadcast(destIP)) {
        // one relayed copy per peer without a channel, addressed to that peer
        const one = packet(p.ip, destPort, srcPort, bytes);
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(one); st.sentRelay++; }
        relay = false;
      }
    }
    if (relay && ws && ws.readyState === WebSocket.OPEN) { ws.send(pkt); st.sentRelay++; }
  }

  function stats() {
    let rtcOpen = 0;
    for (const p of peers.values()) if (p.dc && p.dc.readyState === "open") rtcOpen++;
    return { peers: peers.size, rtcOpen, sentRtc: st.sentRtc, sentRelay: st.sentRelay, recvRtc: st.recvRtc, recvRelay: st.recvRelay };
  }

  (window as any)["GXNet"] = {
    "connect": connect,
    "send": send,
    "onPacket": (cb: PacketHandler) => { handlers.push(cb); },
    "stats": stats,
    "ip": () => octets(myIP),
  };
})();
