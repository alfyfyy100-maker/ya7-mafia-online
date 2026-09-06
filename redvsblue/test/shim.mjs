/* محاكي محلي لغرفة Durable Object: خادم WebSocket بسيط (RFC6455) يمرّر
   الاتصالات إلى RedVsBlueRoom من worker.js نفسه، للاختبار بلا Cloudflare. */
import http from 'node:http';
import crypto from 'node:crypto';

class FakeWS {
  constructor() { this.listeners = {}; this.peer = null; this._bridge = null; this.closed = false; this.queue = []; }
  get bridge() { return this._bridge; }
  set bridge(b) { this._bridge = b; if (b) { for (const m of this.queue.splice(0)) b.sendText(m); } }
  accept() {}
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  emit(t, ev) { for (const f of this.listeners[t] || []) { try { f(ev); } catch (e) { console.error('listener error', e); } } }
  send(data) { if (this.closed) throw new Error('closed'); if (this._bridge) this._bridge.sendText(String(data)); else this.queue.push(String(data)); }
  close(code, reason) { if (this.closed) return; this.closed = true; if (this.bridge) this.bridge.close(code || 1000, reason || ''); this.emit('close', { code: code || 1000, reason }); }
}
globalThis.WebSocketPair = class { constructor() { const a = new FakeWS(), b = new FakeWS(); a.peer = b; b.peer = a; this[0] = a; this[1] = b; } };
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
const RealResponse = globalThis.Response;
globalThis.Response = class FakeResponse {
  constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.webSocket = init && init.webSocket; this.headers = new Headers(init && init.headers); }
  static json(o, init) { return new RealResponse(JSON.stringify(o), init); }
};

const mod = await import('file://' + (process.env.WORKER || new URL('../../worker.js', import.meta.url).pathname));
const rooms = new Map();
const PORT = Number(process.env.PORT || 8787);

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('shim ok'); });
server.on('upgrade', async (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const m = (req.url || '').match(/^\/redvsblue\/room\/([A-Z0-9]{6})\/ws/i);
  if (!key || !m) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const code = m[1].toUpperCase();
  let room = rooms.get(code);
  if (!room) { room = new mod.RedVsBlueRoom({ waitUntil: p => p && p.catch && p.catch(() => {}) }, {}); rooms.set(code, room); }
  const fakeReq = { url: 'http://127.0.0.1:' + PORT + req.url, headers: { get: h => h.toLowerCase() === 'upgrade' ? 'websocket' : null } };
  let resp;
  try { resp = await room.fetch(fakeReq); } catch (e) { console.error('room.fetch error', e); socket.destroy(); return; }

  const client = resp.webSocket;         // pair[0]
  const serverEnd = client && client.peer; // pair[1] — الطرف الذي تتعامل معه الغرفة
  if (!serverEnd) { socket.destroy(); return; }
  let open = true;
  const bridge = {
    sendText(s) { if (!open) return; try { socket.write(frame(1, Buffer.from(s, 'utf8'))); } catch (e) {} },
    close(codeNum) { if (!open) return; open = false; try { const b = Buffer.alloc(2); b.writeUInt16BE(codeNum || 1000); socket.write(frame(8, b)); } catch (e) {} setTimeout(() => socket.destroy(), 50); },
  };

  serverEnd.bridge = bridge;
  if (serverEnd.closed) { bridge.close(1000); return; }
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) { const mk = buf.subarray(off - 4, off); const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mk[i & 3]; payload = out; }
      buf = buf.subarray(off + len);
      if (!fin) continue;
      if (op === 1) { serverEnd.emit('message', { data: payload.toString('utf8') }); }
      else if (op === 8) { if (open) { open = false; try { socket.write(frame(8, payload.subarray(0, 2))); } catch (e) {} } socket.end(); if (!serverEnd.closed) { serverEnd.closed = true; serverEnd.emit('close', { code: 1000 }); } }
      else if (op === 9) { try { socket.write(frame(10, payload)); } catch (e) {} }
    }
  });
  const gone = () => { if (!serverEnd.closed) { serverEnd.closed = true; serverEnd.emit('close', { code: 1006 }); } open = false; };
  socket.on('close', gone); socket.on('error', gone);
});
server.listen(PORT, '127.0.0.1', () => console.log('shim listening on', PORT));
