#!/usr/bin/env node
'use strict';
// P2P Chat relay. Forwards encrypted frames between two apps that cannot reach
// each other directly (both behind NAT). It stores nothing, and it cannot read
// anything: addresses are random keys, frames are end-to-end ciphertext, and
// the link to each app is itself encrypted. What it does see: each app's IP,
// and which random addresses talk to which.
//
//   node relay/server.js --port 4433 --host relay.example.com [--data ./relay-data]
//
// Prints the relay address to paste into the app. Zero dependencies.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const kc = require('../core/crypto.js');
const link = require('../core/relaylink.js');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const PORT = Number(arg('port', 4433));
const HOST = arg('host', '0.0.0.0');
const PUBLIC_HOST = arg('public-host', arg('host', 'localhost'));
const DATA = arg('data', path.join(process.cwd(), 'relay-data'));

const MAX_FRAME = 300 * 1024;        // app frames are <= 256 KB, plus envelope
const MAX_BINDS = 256;
const MAX_CHANNELS = 64;
const IDLE_MS = 90_000;
const HANDSHAKE_MS = 8_000;
const MAX_LINKS_PER_IP = 32;

// --- identity: one X25519 keypair, generated on first run ------------------
function loadIdentity() {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, 'relay-key.json');
  if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { pub: Buffer.from(j.pub, 'base64url'), priv: Buffer.from(j.priv, 'base64url') }; }
  const kp = kc.newKeypair();
  fs.writeFileSync(file, JSON.stringify({ pub: kp.pub.toString('base64url'), priv: kp.priv.toString('base64url') }), { mode: 0o600 });
  return kp;
}
const me = loadIdentity();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const links = new Set();
const bound = new Map();     // addr -> Link
const channels = new Map();  // ch -> { a: Link, b: Link }
const perIp = new Map();     // ip -> count

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_FRAME) throw new Error('frame too large');
  const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

class Link {
  constructor(sock) {
    this.sock = sock;
    this.ip = sock.remoteAddress;
    this.session = null;
    this.nonce = null;
    this.addrs = new Set();
    this.chs = new Set();
    this.lastSeen = Date.now();
    this.closed = false;
    let buf = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 20_000);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len > MAX_FRAME) return this.drop('oversized frame');
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
        let obj; try { obj = JSON.parse(body.toString('utf8')); } catch { return this.drop('malformed frame'); }
        this.lastSeen = Date.now();
        try { this.onFrame(obj); } catch (e) { return this.drop(e.message); }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => this.teardown());
    this.hsTimer = setTimeout(() => { if (!this.session) this.drop('handshake timeout'); }, HANDSHAKE_MS);
  }

  raw(obj) { if (!this.closed) { try { this.sock.write(encodeFrame(obj)); } catch { this.drop('write failed'); } } }
  send(obj) { if (this.session) this.raw(kc.seal(this.session, obj)); }
  drop(why) { if (!this.closed) { log('drop', this.ip, why); this.sock.destroy(); } }

  onFrame(f) {
    if (!this.session) {
      if (f.t !== 'lk1') throw new Error('expected lk1');
      const { frame, session, nonce } = link.relayRespond(me, f);
      this.session = session; this.nonce = nonce; clearTimeout(this.hsTimer);
      this.raw(frame);
      return;
    }
    if (f.t !== 'enc') throw new Error('expected enc');
    const m = kc.open(this.session, f);
    switch (m.k) {
      case 'ping': this.send({ k: 'pong' }); break;
      case 'bind': {
        if (!link.isAddr(m.addr)) return this.send({ k: 'err', addr: m.addr, why: 'bad address' });
        if (this.addrs.size >= MAX_BINDS) return this.send({ k: 'err', addr: m.addr, why: 'too many addresses' });
        if (!link.verifyBind(m.addr, m.sig, this.nonce)) return this.send({ k: 'err', addr: m.addr, why: 'bad proof' });
        const prev = bound.get(m.addr);
        if (prev && prev !== this) { prev.addrs.delete(m.addr); prev.send({ k: 'err', addr: m.addr, why: 'bound elsewhere' }); }
        bound.set(m.addr, this); this.addrs.add(m.addr);
        this.send({ k: 'bound', addr: m.addr });
        break;
      }
      case 'unbind': if (this.addrs.delete(m.addr) && bound.get(m.addr) === this) bound.delete(m.addr); break;
      case 'open': {
        if (!link.isChannelId(m.ch) || channels.has(m.ch)) return this.send({ k: 'err', ch: m.ch, why: 'bad channel id' });
        if (this.chs.size >= MAX_CHANNELS) return this.send({ k: 'err', ch: m.ch, why: 'too many channels' });
        const target = link.isAddr(m.to) ? bound.get(m.to) : null;
        if (!target || target === this || target.closed) return this.send({ k: 'unreachable', ch: m.ch });
        if (target.chs.size >= MAX_CHANNELS) return this.send({ k: 'unreachable', ch: m.ch });
        channels.set(m.ch, { a: this, b: target }); this.chs.add(m.ch); target.chs.add(m.ch);
        target.send({ k: 'incoming', ch: m.ch });
        this.send({ k: 'opened', ch: m.ch });
        break;
      }
      case 'data': {
        const c = channels.get(m.ch);
        if (!c || (c.a !== this && c.b !== this)) return;
        if (!m.f || typeof m.f !== 'object') return;
        (c.a === this ? c.b : c.a).send({ k: 'data', ch: m.ch, f: m.f });
        break;
      }
      case 'close': this.closeChannel(m.ch, true); break;
      default: throw new Error('unknown control message');
    }
  }

  closeChannel(ch, notifyOther) {
    const c = channels.get(ch);
    if (!c || (c.a !== this && c.b !== this)) return;
    channels.delete(ch); c.a.chs.delete(ch); c.b.chs.delete(ch);
    if (notifyOther) (c.a === this ? c.b : c.a).send({ k: 'closed', ch });
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hsTimer);
    for (const ch of [...this.chs]) this.closeChannel(ch, true);
    for (const a of this.addrs) if (bound.get(a) === this) bound.delete(a);
    links.delete(this);
    perIp.set(this.ip, (perIp.get(this.ip) || 1) - 1);
  }
}

const server = net.createServer((sock) => {
  const ip = sock.remoteAddress;
  const n = (perIp.get(ip) || 0) + 1;
  if (n > MAX_LINKS_PER_IP) { sock.destroy(); return; }
  perIp.set(ip, n);
  links.add(new Link(sock));
});
setInterval(() => { const now = Date.now(); for (const l of links) if (now - l.lastSeen > IDLE_MS) l.drop('idle'); }, 15_000).unref();

server.listen(PORT, HOST, () => {
  const address = link.formatRelayAddress({ host: PUBLIC_HOST, port: PORT, pub: me.pub });
  log(`relay listening on ${HOST}:${PORT}`);
  log(`relay address (paste into the app): ${address}`);
  fs.writeFileSync(path.join(DATA, 'relay-address.txt'), address + '\n');
});
server.on('error', (e) => { console.error('relay failed:', e.message); process.exit(1); });

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
