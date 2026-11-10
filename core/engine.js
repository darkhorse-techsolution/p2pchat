'use strict';
// Ties crypto, store and transport together. One Engine per app instance.
//
//   start()                 listen on the saved port, dial every contact, keep retrying
//   invite()                issue a one-time token and return the invite string
//   addContact(invite)      parse, save, dial
//   sendMessage(pub, m)     store first (status pending), deliver now or on next connect
//   requestHistory(pub)     ask the peer for their copy of the whole conversation
//
// Wire protocol after the handshake, all inside the encrypted channel:
//   sync   { have }               have = highest seq I hold from you -> you resend what I lack
//   msg    { id, seq, ts, kind, text, lang, mime?, w?, h?, bytes? }
//   ack    { seq }
//   hreq   {}                     please send me your copy of our history
//   hist   { i, n, messages }     one chunk of it; only honoured while an hreq is outstanding
//   name   { name }
//   addr   { addr }               my relay address for you; dial this when LAN fails
//   typing {}
//   breq   { id, i }              send me part i of the bytes of image message `id` (I hold its record)
//   blob   { id, i, n, d }        that part, base64; n = parts in total, 0 = "I do not have it"
//   share  { op, v?, ... }        screen-share / call signaling (WebRTC SDP, ICE, state, bye): live only, never stored;
//                                 v = the sender's share protocol version (absent up to 0.7.1)
//
// An image message is small on every path above (record only), so frames stay
// under the 256 KB cap and catch-up and history need nothing new. Whoever holds
// a record without its bytes pulls them with breq, one part at a time: the next
// ask goes out when the previous part is in, so the sender never has more than
// one part in flight per peer, however many asks arrive. Pulls start after a
// live msg, after a hist merge, and on every connect for anything still missing.
//
// Two transports carry the same frames: direct TCP on the LAN, and channels
// through a relay (core/relay.js) when the peers cannot reach each other.
// Each contact gets its own relay address on each side, exchanged inside the
// encrypted channel, so the relay sees random addresses, never identities.

const { EventEmitter } = require('node:events');
const kc = require('./crypto.js');
const { pubId, isId, sanitizeMsg, sanitizeImage, MAX_TEXT_BYTES, MAX_TEXT_CHARS, MAX_BLOB_BYTES, MSG_ID_SHAPE } = require('./store.js');
const { RelayTransport } = require('./relay.js');
const link = require('./relaylink.js');

const HIST_CHUNK_BYTES = 140 * 1024;   // UTF-8 bytes per chunk: sealed + base64 it is ~187 KB, and ~250 KB once the relay wraps it (caps: 256 KB / 300 KB)
const HIST_MAX_PARTS = 500;
const RETRY_MIN = 2000;
const RETRY_MAX = 60000;
const HS_TIMEOUT = 6000;
const CONFIRM_TIMEOUT = 8000;
const LAN_DIAL_TIMEOUT = 1500;   // LAN first, briefly; then the relay
const DIRECT_UPGRADE_MS = 30000; // while relayed, retry a known LAN address this often
const BLOB_PART = 96 * 1024;     // raw bytes per blob frame: after base64, sealing and base64 again it is ~175 KB
const BLOB_MAX_PARTS = Math.ceil(MAX_BLOB_BYTES / BLOB_PART);
const BLOB_STALL = 30000;        // no part for this long = give up on this pull; the next trigger retries it
const BLOB_SCAN = 50;            // image records without bytes queued per scan; scans repeat while pulls succeed
const BLOB_QUOTA = 512 * 1024 * 1024; // auto-pull stops past this many image bytes per contact (fetchImage still works)
const BLOB_SERVE_MIN_MS = 25;    // at most one part per 25 ms per peer when serving: bounds what a flood of asks can cost

// A share frame is forwarded to the UI as is, after this shape check: the WebRTC
// stack in the renderer parses the SDP and candidates, we only bound them.
const SHARE_OPS = new Set(['sdp', 'ice', 'state', 'bye']);
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
function sanitizeShare(m) {
  if (!m || typeof m !== 'object' || !SHARE_OPS.has(m.op)) return null;
  const sid = str(m.sid, 32); if (!sid) return null;
  const out = { op: m.op, sid };
  if (Number.isInteger(m.v) && m.v >= 1 && m.v <= 99) out.v = m.v;   // optional: left out when malformed, a frame is never refused over it
  if (m.op === 'sdp') {
    const d = m.description;
    if (!d || typeof d !== 'object' || !['offer', 'answer'].includes(d.type) || str(d.sdp, 100000) === null) return null;
    out.description = { type: d.type, sdp: d.sdp };
  } else if (m.op === 'ice') {
    const c = m.candidate;
    if (c === null) out.candidate = null;
    else {
      if (!c || typeof c !== 'object' || str(c.candidate, 2048) === null) return null;
      out.candidate = { candidate: c.candidate, sdpMid: str(c.sdpMid, 64) ?? null, sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null, usernameFragment: str(c.usernameFragment, 256) ?? null };
    }
  } else if (m.op === 'state') {
    out.screen = !!m.screen; out.mic = !!m.mic; out.mode = m.mode === 'two' ? 'two' : 'one'; out.rec = !!m.rec;
  }
  return out;
}

const looksLikeImage = (b, mime) => (mime === 'image/png'
  ? b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a
  : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

class Engine extends EventEmitter {
  constructor(store, transport, { blobQuota = BLOB_QUOTA } = {}) {
    super();
    this.store = store;
    this.transport = transport;
    this.blobQuota = blobQuota;
    store.onSaveError = (e) => this.emit('error', { message: `vault not saved: ${e.message}` });
    this.me = store.identity();
    this.peers = new Map();    // pubId -> { pub, conn, session, name, histPending }
    this.dialing = new Set();
    this.nextTry = new Map();  // pubId -> { at, wait }
    this.directTry = new Map(); // pubId -> last direct-upgrade attempt while relayed
    this.loop = null;
    this.discoveryToken = null;
    this.relay = null;
    transport.on('conn', (conn) => this.#inbound(conn));
    transport.on('error', (e) => this.emit('error', { message: e.message }));
    transport.on('discovered', (o, rinfo) => {
      try {
        const inv = kc.parseInvite(o.invite);
        if (inv.pub.equals(this.me.pub)) return;
        this.emit('discovered', { name: inv.name, invite: o.invite, host: rinfo.address, known: !!this.store.contact(inv.pub) });
      } catch {}
    });
  }

  async start() {
    let port = this.store.data.port || 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!port) port = 20000 + Math.floor(Math.random() * 40000);
      try { await this.transport.listen(port); break; } catch { port = 0; }
    }
    if (!this.transport.port) throw new Error('could not bind a listen port');
    if (this.store.data.port !== this.transport.port) { this.store.data.port = this.transport.port; this.store.saveSoon(); }
    this.loop = setInterval(() => this.#reconnectAll(), 1500);
    if (this.store.settings().relay) this.setRelay(this.store.settings().relay);
    this.#reconnectAll();
  }

  stop() {
    clearInterval(this.loop);
    for (const p of this.peers.values()) p.conn.close();
    if (this.relay) this.relay.stop();
    this.transport.close();
    this.store.save();
  }

  // --- relay ----------------------------------------------------------------

  setRelay(address) {
    const clean = String(address || '').trim();
    if (clean) link.parseRelayAddress(clean); // throws on a bad address
    if (this.relay) { this.relay.stop(); this.relay = null; }
    this.store.settings().relay = clean; this.store.saveSoon();
    if (!clean) { this.emit('relay', { status: 'off' }); return; }
    const r = new RelayTransport(clean);
    this.relay = r;
    r.on('conn', (conn) => this.#inbound(conn));
    r.on('up', () => { this.emit('relay', { status: 'up' }); for (const id of this.nextTry.keys()) this.nextTry.delete(id); this.#reconnectAll(); });
    r.on('down', (e) => this.emit('relay', { status: 'connecting', reason: e && e.message }));
    r.on('error', (e) => this.emit('error', { message: e.message }));
    for (const c of this.store.contacts()) if (c.myAddr) r.bind(c.myAddr);
    for (const inv of this.store.invites()) if (inv.addr) r.bind(inv.addr);
    r.start();
    this.emit('relay', { status: 'connecting' });
  }

  relayStatus() { return !this.relay ? 'off' : this.relay.up ? 'up' : 'connecting'; }

  // After sleep or a network change: drop the backoff and try everything now.
  kick() {
    this.nextTry.clear();
    for (const p of this.peers.values()) p.conn.close(); // half-open after sleep; keepalive would take minutes to notice
    if (this.relay && !this.relay.up) { this.relay.stop(); this.relay.start(); }
    this.#reconnectAll();
  }

  #myAddrFor(id) {
    const c = this.store.contact(id);
    if (!c) return null;
    if (!c.myAddr) { this.store.upsertContact(id, { myAddr: link.newAddress() }); if (this.relay) this.relay.bind(this.store.contact(id).myAddr); }
    return this.store.contact(id).myAddr;
  }

  // --- public API ------------------------------------------------------------

  invite() {
    const relay = this.store.settings().relay || '';
    const intro = relay ? link.newAddress() : null;
    const token = this.store.issueInvite(intro);
    if (intro && this.relay) this.relay.bind(intro);
    return kc.makeInvite({ host: this.transport.host, port: this.transport.port, pub: this.me.pub, name: this.me.name || 'peer', token, relay, addr: intro ? intro.pub : '' });
  }

  // One token per discovery session, re-issued only once it has been used.
  // Minting one per multicast beat would hand out a never-ending stream of them.
  discoveryInvite() {
    if (!this.discoveryToken || !this.store.hasInvite(this.discoveryToken)) { this.discoveryToken = this.store.issueInvite(null); }
    return kc.makeInvite({ host: this.transport.host, port: this.transport.port, pub: this.me.pub, name: this.me.name || 'peer', token: this.discoveryToken });
  }

  addContact(inviteText) {
    const inv = kc.parseInvite(inviteText);
    if (inv.pub.equals(this.me.pub)) throw new Error('that is your own invite');
    const existing = this.store.contact(inv.pub);
    if (inv.relay && !this.store.settings().relay) this.setRelay(inv.relay);
    const c = this.store.upsertContact(inv.pub, { name: existing?.name || inv.name, host: inv.host, port: inv.port, token: inv.token, theirAddr: inv.addr || existing?.theirAddr || '' });
    this.#myAddrFor(c.pub);
    this.emit('contact', { pub: c.pub });
    this.nextTry.delete(c.pub);
    this.#reconnectAll();
    return c;
  }

  removeContact(pub) {
    const id = pubId(pub);
    const p = this.peers.get(id);
    if (p) p.conn.close();
    this.store.removeContact(id);
    this.nextTry.delete(id);
    this.emit('contact', { pub: id });
  }

  renameContact(pub, name) { this.store.upsertContact(pub, { name: String(name).slice(0, 64), renamed: true }); this.emit('contact', { pub: pubId(pub) }); }
  setVerified(pub, v) { this.store.upsertContact(pub, { verified: !!v }); this.emit('contact', { pub: pubId(pub) }); }

  setMyName(name) {
    this.store.setName(name);
    this.me.name = this.store.identity().name;
    for (const p of this.peers.values()) this.#send(p, { k: 'name', name: this.me.name });
  }

  sendMessage(pub, { kind, text, lang }) {
    const id = pubId(pub);
    if (!this.store.contact(id)) throw new Error('unknown contact');
    const clean = String(text || '');
    if (!clean.trim()) throw new Error('empty message');
    if (clean.length > MAX_TEXT_CHARS || Buffer.byteLength(clean, 'utf8') > MAX_TEXT_BYTES) throw new Error(`message too long (limit ${MAX_TEXT_BYTES / 1024} KB)`);
    const msg = this.store.addOutgoing(id, { kind: kind === 'code' ? 'code' : 'text', text: clean, lang: String(lang || '').slice(0, 24) });
    this.emit('message', { pub: id, msg });
    const p = this.peers.get(id);
    if (p) this.#deliver(p, msg);
    return msg;
  }

  // The record goes out like any message; the bytes stay here until the peer pulls them.
  sendImage(pub, { mime, data, w, h }) {
    const id = pubId(pub);
    if (!this.store.contact(id)) throw new Error('unknown contact');
    if (!Buffer.isBuffer(data) || !data.length) throw new Error('empty image');
    if (data.length > MAX_BLOB_BYTES) throw new Error(`image too large (limit ${MAX_BLOB_BYTES / 1048576} MB)`);
    const img = sanitizeImage({ mime, w, h, bytes: data.length });
    if (!img || !looksLikeImage(data, img.mime)) throw new Error('unsupported image');
    // Bytes first: a record without bytes would be a placeholder forever, on both sides.
    const msgId = kc.newId();
    this.store.putBlob(id, msgId, data);
    const msg = this.store.addOutgoing(id, { id: msgId, kind: 'image', text: '', lang: '', ...img });
    this.emit('message', { pub: id, msg });
    const p = this.peers.get(id);
    if (p) this.#deliver(p, msg);
    return msg;
  }

  // Pull one image's bytes now, past the auto-pull quota if needed (a user action).
  fetchImage(pub, id) {
    const p = this.peers.get(pubId(pub));
    if (!p) throw new Error('they are offline; the image comes from their device');
    p.forceIds.add(id);
    this.#wantBlobs(p, [id], true);
  }

  // What the UI should say about an image record's bytes.
  imageStatus(pub, id) {
    const cid = pubId(pub);
    if (this.store.hasBlob(cid, id)) return 'have';
    const p = this.peers.get(cid);
    if (p && p.blobSkip.has(id)) return 'unavailable';
    const rec = this.store.conv(cid).messages.find((x) => x.id === id);
    if (rec && this.store.blobBytes(cid) + (rec.bytes || 0) > this.blobQuota) return 'quota';
    return p ? 'pending' : 'offline';
  }

  sendTyping(pub) { const p = this.peers.get(pubId(pub)); if (p) this.#send(p, { k: 'typing' }); }

  // Screen-share / call signaling: live only, so it needs the peer connected right now.
  sendShare(pub, payload) {
    const p = this.peers.get(pubId(pub));
    if (!p) throw new Error('they are offline');
    const f = sanitizeShare(payload);
    if (!f) throw new Error('bad share frame');
    this.#send(p, { k: 'share', ...f });
    return true;
  }

  requestHistory(pub) {
    const p = this.peers.get(pubId(pub));
    if (!p) throw new Error('peer is offline; history is fetched from the peer, not a server');
    p.histPending = true;
    this.#send(p, { k: 'hreq' });
  }

  status(pub) {
    const id = pubId(pub);
    if (this.peers.has(id)) return 'online';
    if (this.dialing.has(id)) return 'connecting';
    return 'offline';
  }

  safetyNumber(pub) { return kc.safetyNumber(this.me.pub, Buffer.from(pubId(pub), 'base64url')); }

  // --- connections -----------------------------------------------------------

  #reconnectAll() {
    const now = Date.now();
    for (const c of this.store.contacts()) {
      const p = this.peers.get(c.pub);
      if (p) {
        // Online through the relay but a LAN address is known (learned from a later
        // invite or handshake): try the direct path now and then. If it connects, the
        // tie-break in #sessionUp prefers it and drops the relayed channel.
        if (p.conn.remote.host === 'relay' && c.host && c.port && !this.dialing.has(c.pub) && now - (this.directTry.get(c.pub) || 0) > DIRECT_UPGRADE_MS) {
          this.directTry.set(c.pub, now);
          this.#dial(c, { directOnly: true });
        }
        continue;
      }
      if (this.dialing.has(c.pub)) continue;
      const nt = this.nextTry.get(c.pub);
      if (nt && now < nt.at) continue;
      const lan = !!(c.host && c.port), viaRelay = !!(this.relay && this.relay.up && c.theirAddr);
      if (!lan && !viaRelay) continue;
      this.#dial(c);
    }
  }

  async #dial(c, { directOnly = false } = {}) {
    this.dialing.add(c.pub);
    if (!directOnly) this.emit('status', { pub: c.pub, status: 'connecting' });
    let conn = null;
    try {
      conn = directOnly ? await this.transport.dial(c.host, c.port, LAN_DIAL_TIMEOUT) : await this.#dialAny(c);
      conn.on('error', () => {});
      const rs = Buffer.from(c.pub, 'base64url');
      const { frame, state } = kc.initiate(this.me, rs, c.token || '', { name: this.me.name, port: this.transport.port });
      conn.send(frame);
      const hs2 = await this.#awaitFrame(conn, 'hs2', HS_TIMEOUT);
      const { peer, session } = kc.finish(this.me, state, hs2);
      if (c.token) this.store.upsertContact(c.pub, { token: '' }); // one use
      this.#commitPeer(peer, conn, { port: peer.port });
      this.#sessionUp(peer, conn, session);
    } catch (e) {
      if (conn) conn.close();
      if (directOnly) return; // still online via the relay; nothing to report
      const prev = this.nextTry.get(c.pub);
      const wait = Math.min(RETRY_MAX, prev ? prev.wait * 2 : RETRY_MIN);
      this.nextTry.set(c.pub, { at: Date.now() + wait, wait });
      this.emit('status', { pub: c.pub, status: 'offline', reason: e.message });
    } finally {
      this.dialing.delete(c.pub);
    }
  }

  async #dialAny(c) {
    const lan = !!(c.host && c.port), viaRelay = !!(this.relay && this.relay.up && c.theirAddr);
    if (lan) {
      try { return await this.transport.dial(c.host, c.port, viaRelay ? LAN_DIAL_TIMEOUT : 4000); }
      catch (e) { if (!viaRelay) throw e; }
    }
    if (!viaRelay) throw new Error('no route to peer');
    return this.relay.dial(c.theirAddr);
  }

  // Inbound: nothing about the contact list or the live session changes until
  // the initiator's first encrypted frame opens under the derived keys. A
  // replayed hs1 gets an hs2 and then silence, and leaves no trace.
  async #inbound(conn) {
    conn.on('error', () => {});
    try {
      const hs1 = await this.#awaitFrame(conn, 'hs1', HS_TIMEOUT);
      const accept = (pub, token) => {
        if (this.store.contact(pub)) return true;
        const used = this.store.consumeInvite(token);
        if (used && used.addr && this.relay) this.relay.unbind(used.addr.pub);
        return !!used;
      };
      const { frame, peer, session } = kc.respond(this.me, hs1, accept, { name: this.me.name, port: this.transport.port });
      conn.send(frame);
      const first = await this.#awaitFrame(conn, 'enc', CONFIRM_TIMEOUT);
      const firstMsg = kc.open(session, first); // throws if the initiator cannot actually use the session
      const viaRelay = conn.remote.host === 'relay';
      this.#commitPeer(peer, conn, viaRelay ? {} : { host: conn.remote.host, port: peer.port });
      this.#sessionUp(peer, conn, session, firstMsg);
    } catch (e) {
      this.emit('info', { message: `rejected inbound from ${conn.remote.host}: ${e.message}` });
      conn.close();
    }
  }

  #commitPeer(peer, conn, addr) {
    const id = pubId(peer.pub);
    const c = this.store.contact(id);
    const fields = {};
    if (addr.host) fields.host = addr.host;
    if (addr.port) fields.port = addr.port;
    if (!c) { fields.name = peer.name || 'peer'; }
    else if (peer.name && peer.name !== c.name && !c.renamed) fields.name = peer.name;
    this.store.upsertContact(id, fields);
    if (!c || fields.name) this.emit('contact', { pub: id });
  }

  // Pull exactly one frame of `type` off the connection. Anything else before
  // the handshake completes is a protocol violation and ends the connection.
  #awaitFrame(conn, type, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { conn.handler = null; conn.off('close', onClose); reject(new Error(`timeout waiting for ${type}`)); }, ms);
      const onClose = () => { clearTimeout(t); reject(new Error(conn.lastError ? `closed: ${conn.lastError.message}` : 'closed during handshake')); };
      conn.once('close', onClose);
      conn.setHandler((f) => {
        clearTimeout(t); conn.off('close', onClose);
        conn.handler = null;
        if (f && f.t === type) resolve(f); else reject(new Error(`expected ${type}, got ${f && f.t}`));
      });
    });
  }

  #sessionUp(peer, conn, session, firstMsg) {
    const id = pubId(peer.pub);
    const existing = this.peers.get(id);
    if (existing && !existing.conn.closed) {
      // Both sides dialed at once. A direct connection beats a relayed one; among
      // equals, the one initiated by the lower key wins. Both sides see the same
      // two connections, so both reach the same verdict.
      const viaRelay = (c) => (c.remote.host === 'relay' ? 1 : 0);
      let newWins;
      if (viaRelay(conn) !== viaRelay(existing.conn)) newWins = viaRelay(conn) < viaRelay(existing.conn);
      else { const iAmLower = Buffer.compare(this.me.pub, peer.pub) < 0; newWins = (conn.direction === 'out') === iAmLower; }
      if (!newWins) { conn.close(); return; }
      existing.conn.removeAllListeners('close');
      existing.conn.close();
    }
    const p = { pub: id, conn, session, name: peer.name, histPending: false, blobQ: [], inblob: null, blobSkip: new Set(), forceIds: new Set(), out: null };
    this.peers.set(id, p);
    this.directTry.set(id, conn.remote.host === 'relay' ? Date.now() - DIRECT_UPGRADE_MS + 1500 : Date.now()); // relayed: first upgrade try on the next tick
    this.nextTry.delete(id);
    conn.on('close', () => {
      if (p.inblob) clearTimeout(p.inblob.timer);
      if (p.out) { clearTimeout(p.out.timer); p.out = null; }
      if (this.peers.get(id) === p) { this.peers.delete(id); this.emit('status', { pub: id, status: 'offline' }); }
    });
    this.emit('status', { pub: id, status: 'online' });
    this.#send(p, { k: 'sync', have: this.store.conv(id).theirSeq });
    const mine = this.#myAddrFor(id);
    if (mine) this.#send(p, { k: 'addr', addr: mine.pub });
    conn.setHandler((f) => this.#onFrame(p, f));
    if (firstMsg) this.#onMessage(p, firstMsg);
    this.#wantBlobs(p, this.store.missingBlobs(id, BLOB_SCAN));
  }

  // --- image bytes: pulled by whoever holds the record, one image and one part at a time per peer ----
  #wantBlobs(p, ids, force = false) {
    for (const id of ids) {
      if (force) p.blobSkip.delete(id);
      if (!(p.inblob && p.inblob.id === id) && !p.blobQ.includes(id) && !p.blobSkip.has(id)) p.blobQ.push(id);
    }
    this.#nextBlob(p);
  }
  #nextBlob(p) {
    if (p.inblob || p.conn.closed) return;
    while (p.blobQ.length) {
      const id = p.blobQ.shift();
      const rec = this.store.conv(p.pub).messages.find((x) => x.id === id && x.kind === 'image');
      if (!rec || this.store.hasBlob(p.pub, id)) continue;
      if (!p.forceIds.has(id) && this.store.blobBytes(p.pub) + rec.bytes > this.blobQuota) continue; // over quota: left as a record; fetchImage pulls it on request
      p.inblob = { id, bytes: rec.bytes, mime: rec.mime, n: Math.ceil(rec.bytes / BLOB_PART), parts: [], size: 0, timer: null };
      this.#blobAsk(p, 0);
      return;
    }
  }
  #blobAsk(p, i) {
    const b = p.inblob;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => { if (p.inblob === b) this.#blobDone(p, null); }, BLOB_STALL); // a stall timer: refreshed by every part
    this.#send(p, { k: 'breq', id: b.id, i });
  }
  #blobDone(p, data) {
    const b = p.inblob; p.inblob = null; clearTimeout(b.timer);
    p.forceIds.delete(b.id);
    let stored = false;
    if (data && data.length === b.bytes && looksLikeImage(data, b.mime)) {
      try { this.store.putBlob(p.pub, b.id, data); stored = true; this.emit('update', { pub: p.pub }); }
      catch (e) { this.emit('error', { message: `could not save image: ${e.message}` }); }
    }
    if (!stored) p.blobSkip.add(b.id); // not again this session; the next connect starts fresh
    // A scan lists only BLOB_SCAN ids: once the queue drains after a success, look again.
    if (stored && !p.blobQ.length) this.#wantBlobs(p, this.store.missingBlobs(p.pub, BLOB_SCAN));
    else this.#nextBlob(p);
  }
  // Serving side: one part per ask, one part in flight (the write callback clears
  // it), at most one part per BLOB_SERVE_MIN_MS. A receiver asks for part i+1 only
  // after part i arrived, so a second ask while one is in flight is never genuine.
  #serveBlob(p, id, i) {
    if (p.out && (p.out.busy || p.out.timer)) return;
    if (!p.out || p.out.id !== id) {
      const rec = this.store.conv(p.pub).messages.find((x) => x.id === id && x.kind === 'image');
      const data = rec ? this.store.blob(p.pub, id) : null;
      if (!data) { this.#send(p, { k: 'blob', id, i: 0, n: 0 }); return; }
      p.out = { id, data, busy: false, timer: null, last: p.out ? p.out.last : 0 };
    }
    const n = Math.ceil(p.out.data.length / BLOB_PART);
    if (i >= n) return;
    const wait = BLOB_SERVE_MIN_MS - (Date.now() - p.out.last);
    const write = () => {
      const o = p.out; if (!o || o.id !== id) return;
      o.busy = true; o.last = Date.now();
      this.#send(p, { k: 'blob', id, i, n, d: o.data.subarray(i * BLOB_PART, (i + 1) * BLOB_PART).toString('base64') }, () => {
        if (p.out !== o) return;
        o.busy = false;
        if (i + 1 >= n) p.out = { id: '', data: null, busy: false, timer: null, last: o.last }; // done: drop the decrypted copy, keep the pacing clock
      });
    };
    if (wait > 0) p.out.timer = setTimeout(() => { if (p.out) p.out.timer = null; write(); }, wait); else write();
  }

  #send(p, obj, cb) {
    try { p.conn.send(kc.seal(p.session, obj), cb); } catch (e) { this.emit('error', { message: e.message }); p.conn.close(); }
  }

  #deliver(p, msg) {
    const f = { k: 'msg', id: msg.id, seq: msg.seq, ts: msg.ts, kind: msg.kind, text: msg.text, lang: msg.lang };
    if (msg.kind === 'image') Object.assign(f, { mime: msg.mime, w: msg.w, h: msg.h, bytes: msg.bytes });
    this.#send(p, f);
  }

  #onFrame(p, frame) {
    if (!frame || frame.t !== 'enc') return;
    let m;
    try { m = kc.open(p.session, frame); } catch (e) { this.emit('error', { message: `${p.name || p.pub.slice(0, 8)}: ${e.message}` }); p.conn.close(); return; }
    this.#onMessage(p, m);
  }

  #onMessage(p, m) {
    if (!m || typeof m !== 'object') return;
    const id = p.pub;
    switch (m.k) {
      case 'sync': {
        const have = Number.isSafeInteger(m.have) && m.have >= 0 ? m.have : 0;
        this.store.markDelivered(id, have);
        this.store.bumpMySeq(id, have);
        for (const msg of this.store.pendingOutgoing(id, have)) this.#deliver(p, msg);
        this.emit('update', { pub: id });
        break;
      }
      case 'msg': {
        const clean = sanitizeMsg(m);
        if (!clean) break;
        const stored = this.store.addIncoming(id, clean);
        this.#send(p, { k: 'ack', seq: clean.seq });
        if (stored) { this.emit('message', { pub: id, msg: stored }); if (stored.kind === 'image') this.#wantBlobs(p, [stored.id]); }
        break;
      }
      case 'ack': {
        if (Number.isSafeInteger(m.seq)) { this.store.markDelivered(id, m.seq); this.emit('update', { pub: id }); }
        break;
      }
      case 'hreq': {
        const all = this.store.conv(id).messages;
        const chunks = [[]]; let size = 0;
        for (const msg of all) {
          const len = Buffer.byteLength(JSON.stringify(msg), 'utf8'); // bytes, not UTF-16 units: Cyrillic or CJK text is 2-3x longer on the wire
          if (size + len > HIST_CHUNK_BYTES && chunks[chunks.length - 1].length) { chunks.push([]); size = 0; }
          chunks[chunks.length - 1].push(msg); size += len;
        }
        chunks.slice(0, HIST_MAX_PARTS).forEach((messages, i) => this.#send(p, { k: 'hist', i, n: Math.min(chunks.length, HIST_MAX_PARTS), messages }));
        break;
      }
      case 'hist': {
        if (!p.histPending) break; // unsolicited: a peer must not be able to write our transcript
        const records = (Array.isArray(m.messages) ? m.messages : []).map((r) => { const s = sanitizeMsg(r); return s && (r.from === 'me' || r.from === 'peer') ? { ...s, from: r.from } : null; }).filter(Boolean);
        const added = this.store.mergeHistory(id, records);
        const part = (Number(m.i) | 0) + 1, parts = Math.max(1, Number(m.n) | 0);
        if (part >= parts) p.histPending = false;
        this.emit('history', { pub: id, added, part, parts });
        if (added) this.#wantBlobs(p, this.store.missingBlobs(id, BLOB_SCAN));
        break;
      }
      case 'breq': {
        if (typeof m.id === 'string' && MSG_ID_SHAPE.test(m.id) && Number.isInteger(m.i) && m.i >= 0 && m.i < BLOB_MAX_PARTS) this.#serveBlob(p, m.id, m.i);
        break;
      }
      case 'blob': {
        const b = p.inblob;
        if (!b || m.id !== b.id) break;                                   // nothing asked for, or not this one
        const n = Number(m.n), i = Number(m.i);
        if (n === 0) { this.#blobDone(p, null); break; }                 // the peer does not hold it either
        const part = Buffer.from(typeof m.d === 'string' ? m.d : '', 'base64');
        if (n !== b.n || i !== b.parts.length || !part.length || part.length > BLOB_PART || b.size + part.length > b.bytes) { this.#blobDone(p, null); break; }
        b.parts.push(part); b.size += part.length;
        if (i + 1 >= n) this.#blobDone(p, Buffer.concat(b.parts)); else this.#blobAsk(p, i + 1);
        break;
      }
      case 'name': { const name = String(m.name || '').slice(0, 64); if (name && !this.store.contact(id)?.renamed) { this.store.upsertContact(id, { name }); this.emit('contact', { pub: id }); } break; }
      case 'addr': { if (link.isAddr(m.addr) && this.store.contact(id)?.theirAddr !== m.addr) this.store.upsertContact(id, { theirAddr: m.addr }); break; }
      case 'typing': this.emit('typing', { pub: id }); break;
      case 'share': { const f = sanitizeShare(m); if (f) this.emit('share', { pub: id, ...f }); break; }
    }
  }
}

module.exports = { Engine, sanitizeShare };
