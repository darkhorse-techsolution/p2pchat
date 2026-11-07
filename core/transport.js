'use strict';
// Sockets only. Knows nothing about keys or messages.
//   Transport: listens on one fixed port, dials peers, optional LAN discovery.
//   Conn: one TCP socket carrying length-prefixed JSON frames.
// Same machine or same LAN. No NAT traversal.

const net = require('node:net');
const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const MAX_FRAME = 256 * 1024;
const DISCOVERY_PORT = 48888;
const DISCOVERY_ADDR = '239.255.48.88';

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_FRAME) throw new Error(`frame too large (${body.length} bytes)`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Frames are queued and drained through `handler`, never emitted into a void.
// A consumer that swaps handlers across an await boundary (the handshake does)
// would otherwise lose any frame that arrived in the same TCP chunk.
class Conn extends EventEmitter {
  constructor(sock, direction) {
    super();
    this.sock = sock;
    this.direction = direction; // 'in' | 'out'
    this.remote = { host: sock.remoteAddress, port: sock.remotePort };
    this.closed = false;
    this.queue = [];
    this.handler = null;
    let buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10000);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len > MAX_FRAME) return this.fail(new Error('oversized frame'));
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let obj;
        try { obj = JSON.parse(body.toString('utf8')); } catch { return this.fail(new Error('malformed frame')); }
        this.queue.push(obj);
        this.flush();
      }
    });
    // emit('error') with no listener throws out of the socket callback and takes
    // the main process down. Any LAN host can trigger that before the handshake.
    sock.on('error', (e) => this.#err(e));
    sock.on('close', () => { this.closed = true; this.emit('close'); });
  }
  setHandler(fn) { this.handler = fn; this.flush(); }
  flush() {
    while (this.handler && this.queue.length) {
      const f = this.queue.shift();
      try { this.handler(f); } catch (e) { this.fail(e); return; }
    }
  }
  // `cb` fires once the frame has been handed to the kernel (or with an error):
  // the engine paces bulk transfers on it instead of filling the write buffer.
  send(obj, cb) {
    if (this.closed) { if (cb) cb(new Error('closed')); return; }
    this.sock.write(encodeFrame(obj), cb);
  }
  fail(err) { this.#err(err); this.close(); }
  #err(e) { this.lastError = e; if (this.listenerCount('error')) this.emit('error', e); }
  close() { if (!this.closed) this.sock.destroy(); }
}

class Transport extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.port = 0;
    this.host = lanAddress();
    this.discovery = null;
    this.discoveryTimer = null;
  }

  async listen(port) {
    this.server = net.createServer((sock) => this.emit('conn', new Conn(sock, 'in')));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  dial(host, port, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(t); resolve(new Conn(sock, 'out')); });
      sock.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  // Multicast announce. Off unless the user turns it on: it advertises your
  // public key to everyone on the network.
  startDiscovery(payloadFn) {
    if (this.discovery) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.discovery = sock;
    sock.on('error', (e) => { this.emit('error', new Error(`discovery: ${e.message}`)); this.stopDiscovery(); });
    sock.on('message', (msg, rinfo) => {
      try { const o = JSON.parse(msg.toString('utf8')); if (o.t === 'announce') this.emit('discovered', o, rinfo); } catch {}
    });
    sock.bind(DISCOVERY_PORT, () => {
      try { sock.setBroadcast(true); sock.addMembership(DISCOVERY_ADDR); } catch (e) { this.emit('error', e); }
      const beat = () => {
        const payload = Buffer.from(JSON.stringify({ t: 'announce', ...payloadFn() }));
        sock.send(payload, DISCOVERY_PORT, DISCOVERY_ADDR, () => {});
      };
      beat();
      this.discoveryTimer = setInterval(beat, 3000);
    });
  }

  stopDiscovery() {
    clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    if (this.discovery) { try { this.discovery.close(); } catch {} this.discovery = null; }
  }

  close() {
    this.stopDiscovery();
    if (this.server) this.server.close();
  }
}

module.exports = { Transport, Conn, lanAddress };
