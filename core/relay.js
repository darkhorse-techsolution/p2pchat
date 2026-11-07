'use strict';
// Client side of the relay: one encrypted link to the relay, kept alive and
// reconnected with backoff; addresses bound on it; logical channels that look
// exactly like a TCP Conn to the engine (send / setHandler / flush / close,
// 'close' and 'error' events, direction, remote).

const net = require('node:net');
const { EventEmitter } = require('node:events');
const kc = require('./crypto.js');
const link = require('./relaylink.js');

const PING_MS = 25_000;
const RETRY_MIN = 2_000;
const RETRY_MAX = 60_000;
const OPEN_TIMEOUT = 8_000;
const MAX_LINK_FRAME = 300 * 1024;   // what relay/server.js accepts; one byte over and it drops the whole link

class RelayConn extends EventEmitter {
  constructor(transport, ch, direction, toAddr) {
    super();
    this.transport = transport;
    this.ch = ch;
    this.direction = direction;
    this.remote = { host: 'relay', port: 0, addr: toAddr || '' };
    this.closed = false;
    this.queue = [];
    this.handler = null;
    this.lastError = null;
  }
  setHandler(fn) { this.handler = fn; this.flush(); }
  flush() {
    while (this.handler && this.queue.length) {
      const f = this.queue.shift();
      try { this.handler(f); } catch (e) { this.fail(e); return; }
    }
  }
  push(frame) { this.queue.push(frame); this.flush(); }
  // Throws for a frame the relay would refuse, so the caller closes this channel
  // instead of the relay closing the link (and every other channel on it).
  send(obj, cb) {
    if (this.closed) { if (cb) cb(new Error('closed')); return; }
    const ctl = { k: 'data', ch: this.ch, f: obj };
    const plain = Buffer.byteLength(JSON.stringify(ctl), 'utf8');
    if (plain * 4 / 3 + 96 > MAX_LINK_FRAME) throw new Error(`frame too large for the relay (${plain} bytes)`);
    this.transport.sendCtl(ctl, cb);
  }
  fail(err) { this.lastError = err; if (this.listenerCount('error')) this.emit('error', err); this.close(); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.transport.conns.delete(this.ch);
    this.transport.sendCtl({ k: 'close', ch: this.ch });
    this.emit('close');
  }
  // called by the transport when the relay (or the link) ends the channel
  remoteClose(why) {
    if (this.closed) return;
    this.closed = true;
    this.transport.conns.delete(this.ch);
    if (why) this.lastError = new Error(why);
    this.emit('close');
  }
}

class RelayTransport extends EventEmitter {
  constructor(address) {
    super();
    this.address = address;                   // relay://host:port/pub
    this.target = link.parseRelayAddress(address);
    this.sock = null;
    this.session = null;
    this.nonce = null;
    this.up = false;
    this.wanted = false;
    this.addresses = new Map();               // pub -> { pub, priv }
    this.conns = new Map();                   // ch -> RelayConn
    this.pendingOpens = new Map();            // ch -> { resolve, reject, timer }
    this.retryWait = RETRY_MIN;
    this.retryTimer = null;
    this.pingTimer = null;
  }

  start() { this.wanted = true; this.#connect(); }
  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer); clearInterval(this.pingTimer);
    if (this.sock) this.sock.destroy();
  }

  bind(address) { this.addresses.set(address.pub, address); if (this.up) this.#sendBind(address); }
  unbind(pub) { this.addresses.delete(pub); if (this.up) this.sendCtl({ k: 'unbind', addr: pub }); }

  dial(toAddr, timeoutMs = OPEN_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.up) return reject(new Error('relay link is down'));
      if (!link.isAddr(toAddr)) return reject(new Error('bad relay address'));
      const ch = link.newChannelId();
      const timer = setTimeout(() => { this.pendingOpens.delete(ch); reject(new Error('relay open timeout')); }, timeoutMs);
      this.pendingOpens.set(ch, { resolve, reject, timer, toAddr });
      this.sendCtl({ k: 'open', ch, to: toAddr });
    });
  }

  sendCtl(obj, cb) {
    if (!this.up || !this.session) { if (cb) cb(new Error('relay link is down')); return; }
    try { this.#raw(kc.seal(this.session, obj), cb); } catch (e) { this.#down(e); }
  }

  #raw(obj, cb) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
    this.sock.write(Buffer.concat([head, body]), cb);
  }

  #sendBind(address) { this.sendCtl({ k: 'bind', addr: address.pub, sig: link.bindProof(address, this.nonce) }); }

  #connect() {
    if (!this.wanted || this.sock) return;
    const sock = net.createConnection({ host: this.target.host, port: this.target.port });
    this.sock = sock;
    let buf = Buffer.alloc(0);
    let state = null;
    const hsTimer = setTimeout(() => { if (!this.up) this.#down(new Error('relay handshake timeout')); }, 10_000);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 20_000);
    sock.once('connect', () => {
      const h = link.clientHello(this.target.pub);
      state = h.state;
      this.#raw(h.frame);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len > 300 * 1024) return this.#down(new Error('oversized relay frame'));
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
        let obj; try { obj = JSON.parse(body.toString('utf8')); } catch { return this.#down(new Error('malformed relay frame')); }
        try {
          if (!this.session) {
            if (obj.t !== 'lk2') throw new Error('expected lk2 from relay');
            const { session, nonce } = link.clientFinish(state, obj);
            this.session = session; this.nonce = nonce; this.up = true; this.retryWait = RETRY_MIN;
            clearTimeout(hsTimer);
            for (const a of this.addresses.values()) this.#sendBind(a);
            this.pingTimer = setInterval(() => this.sendCtl({ k: 'ping' }), PING_MS);
            this.emit('up');
            continue;
          }
          if (obj.t !== 'enc') throw new Error('unexpected relay frame');
          this.#onCtl(kc.open(this.session, obj));
        } catch (e) { return this.#down(e); }
      }
    });
    sock.on('error', (e) => this.#down(e));
    sock.on('close', () => this.#down(new Error('relay link closed')));
  }

  #onCtl(m) {
    switch (m.k) {
      case 'pong': break;
      case 'bound': this.emit('bound', m.addr); break;
      case 'err': {
        if (m.ch && this.pendingOpens.has(m.ch)) { const p = this.pendingOpens.get(m.ch); clearTimeout(p.timer); this.pendingOpens.delete(m.ch); p.reject(new Error(`relay: ${m.why}`)); }
        else this.emit('error', new Error(`relay: ${m.why}${m.addr ? ` (${m.addr.slice(0, 8)}…)` : ''}`));
        break;
      }
      case 'opened': {
        const p = this.pendingOpens.get(m.ch); if (!p) return;
        clearTimeout(p.timer); this.pendingOpens.delete(m.ch);
        const c = new RelayConn(this, m.ch, 'out', p.toAddr);
        this.conns.set(m.ch, c); p.resolve(c);
        break;
      }
      case 'unreachable': {
        const p = this.pendingOpens.get(m.ch); if (!p) return;
        clearTimeout(p.timer); this.pendingOpens.delete(m.ch); p.reject(new Error('peer is not connected to the relay'));
        break;
      }
      case 'incoming': {
        if (!link.isChannelId(m.ch) || this.conns.has(m.ch)) return;
        const c = new RelayConn(this, m.ch, 'in', '');
        this.conns.set(m.ch, c);
        this.emit('conn', c);
        break;
      }
      case 'data': { const c = this.conns.get(m.ch); if (c && m.f && typeof m.f === 'object') c.push(m.f); break; }
      case 'closed': { const c = this.conns.get(m.ch); if (c) c.remoteClose('peer closed'); break; }
    }
  }

  #down(err) {
    const wasUp = this.up;
    this.up = false; this.session = null; this.nonce = null;
    clearInterval(this.pingTimer); this.pingTimer = null;
    if (this.sock) { const s = this.sock; this.sock = null; s.removeAllListeners(); s.on('error', () => {}); s.destroy(); }
    for (const p of this.pendingOpens.values()) { clearTimeout(p.timer); p.reject(new Error('relay link is down')); }
    this.pendingOpens.clear();
    for (const c of [...this.conns.values()]) c.remoteClose('relay link lost');
    this.conns.clear();
    if (wasUp) this.emit('down', err);
    if (this.wanted && !this.retryTimer) {
      const wait = this.retryWait; this.retryWait = Math.min(RETRY_MAX, wait * 2);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.#connect(); }, wait);
    }
  }
}

module.exports = { RelayTransport, RelayConn };
