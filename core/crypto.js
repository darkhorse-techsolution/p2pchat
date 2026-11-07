'use strict';
// Primitives and the handshake. Node built-ins only.
//
// Identity is a long-term X25519 keypair, kept in the encrypted vault, so a
// contact is the same contact after a restart. Each connection runs an IK-shaped
// handshake (the initiator already knows the responder's static key, from the
// invite or the contact list) with fresh ephemerals on both sides, mixing
// es, ss, ee and se into the session keys. That gives per-session forward
// secrecy and mutual authentication. Within a session, a symmetric ratchet
// derives one key per message and zeroes it after use.
//
// Not a Double Ratchet: no DH re-keying inside a session, so no post-compromise
// security within one session. Reconnecting starts a new session.

const crypto = require('node:crypto');

// Electron bundles BoringSSL: 28 ciphers, no ChaCha. aes-256-gcm exists in
// every runtime this will meet and is hardware-accelerated on Apple Silicon.
const AEAD = 'aes-256-gcm';
if (!crypto.getCiphers().includes(AEAD)) {
  throw new Error(`this runtime has no ${AEAD}; available: ${crypto.getCiphers().length} ciphers`);
}

const ZERO = Buffer.alloc(32);
const info = (s) => Buffer.from(`p2pchat/v2/${s}`);
const hkdf = (ikm, salt, label, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info(label), len));
const sha256 = (...parts) => parts.reduce((h, p) => h.update(p), crypto.createHash('sha256')).digest();

const rawPub = (kp) => Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url');
const rawPriv = (kp) => Buffer.from(kp.privateKey.export({ format: 'jwk' }).d, 'base64url');

function importPub(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 32) throw new Error('public key must be 32 bytes');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: buf.toString('base64url') }, format: 'jwk' });
}
function importPriv(priv, pub) {
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: priv.toString('base64url'), x: pub.toString('base64url') },
    format: 'jwk',
  });
}

function newKeypair() {
  const kp = crypto.generateKeyPairSync('x25519');
  return { pub: rawPub(kp), priv: rawPriv(kp) };
}

function dh(priv, pub, theirPub) {
  const s = crypto.diffieHellman({ privateKey: importPriv(priv, pub), publicKey: importPub(theirPub) });
  if (s.every((b) => b === 0)) throw new Error('degenerate shared secret');
  return s;
}

function aeadSeal(key, nonce, aad, plaintext) {
  const c = crypto.createCipheriv(AEAD, key, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}
function aeadOpen(key, nonce, aad, sealed) {
  if (sealed.length < 16) throw new Error('ciphertext too short');
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const d = crypto.createDecipheriv(AEAD, key, nonce, { authTagLength: 16 });
  d.setAAD(aad, { plaintextLength: ct.length });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

const nonce12 = (n) => { const b = Buffer.alloc(12); b.writeUInt32BE(n, 8); return b; };

// --- handshake ---------------------------------------------------------------

// What each side tells the other inside the encrypted handshake payload.
const cleanMeta = (m) => ({ name: String((m && m.name) || '').slice(0, 64), port: Number((m && m.port) || 0) | 0 });

// Initiator step. Knows responder static `rs`. hs1 carries the initiator's
// static encrypted under es, then the payload encrypted under es||ss. Opening
// the payload therefore proves the initiator holds the private key of the
// static it claims, which is what lets the responder trust `s` at all.
function initiate(me, rs, token, meta) {
  const e = newKeypair();
  const es = dh(e.priv, e.pub, rs);
  const ss = dh(me.priv, me.pub, rs);
  const kA = hkdf(es, ZERO, 'hs1a', 32);
  const kB = hkdf(Buffer.concat([es, ss]), ZERO, 'hs1b', 32);
  const c1 = aeadSeal(kA, nonce12(0), e.pub, me.pub);
  const payload = Buffer.from(JSON.stringify({ token: String(token || ''), ...cleanMeta(meta) }));
  const c2 = aeadSeal(kB, nonce12(1), c1, payload);
  kA.fill(0); kB.fill(0); ss.fill(0);
  return {
    frame: { t: 'hs1', e: e.pub.toString('base64url'), c1: c1.toString('base64'), c2: c2.toString('base64') },
    state: { e, es, rs, token: String(token || '') },
  };
}

// Responder step. Opens hs1, learns the initiator static and proves it holds
// its private key. `accept(initiatorPub, token)` decides whether this peer may
// connect. The caller must still withhold side effects until the initiator's
// first encrypted frame opens: a captured hs1 can be replayed verbatim.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{0,64}$/;
function respond(me, frame, accept, meta) {
  const ie = Buffer.from(String(frame.e || ''), 'base64url');
  if (ie.length !== 32) throw new Error('bad ephemeral');
  const c1 = Buffer.from(String(frame.c1 || ''), 'base64');
  const c2 = Buffer.from(String(frame.c2 || ''), 'base64');
  const es = dh(me.priv, me.pub, ie);
  const kA = hkdf(es, ZERO, 'hs1a', 32);
  let is;
  try { is = aeadOpen(kA, nonce12(0), ie, c1); }
  catch { kA.fill(0); es.fill(0); throw new Error('handshake failed: initiator could not prove knowledge of our key'); }
  kA.fill(0);
  if (is.length !== 32) { es.fill(0); throw new Error('bad initiator static'); }
  if (is.equals(me.pub)) { es.fill(0); throw new Error('peer static equals ours'); }

  const ss = dh(me.priv, me.pub, is);
  const kB = hkdf(Buffer.concat([es, ss]), ZERO, 'hs1b', 32);
  let inner;
  try { inner = JSON.parse(aeadOpen(kB, nonce12(1), c1, c2).toString('utf8')); }
  catch { kB.fill(0); es.fill(0); ss.fill(0); throw new Error('handshake failed: initiator does not hold the private key for the static it claims'); }
  kB.fill(0);
  const token = typeof inner.token === 'string' && TOKEN_SHAPE.test(inner.token) ? inner.token : null;
  if (token === null || !accept(is, token)) { es.fill(0); ss.fill(0); throw new Error('connection refused: unknown peer and no valid invite token'); }

  const e = newKeypair();
  const ee = dh(e.priv, e.pub, ie);
  const se = dh(me.priv, me.pub, ie);
  const transcript = sha256(ie, is, me.pub, e.pub, Buffer.from(token));
  const ck = hkdf(Buffer.concat([es, ss, ee, se]), transcript, 'ck', 32);
  [es, ss, ee, se].forEach((b) => b.fill(0));

  const k2 = hkdf(ck, ZERO, 'hs2', 32);
  const payload = Buffer.from(JSON.stringify(cleanMeta(meta)));
  const sealed = aeadSeal(k2, nonce12(0), e.pub, payload);
  k2.fill(0);

  const session = deriveSession(ck, is, me.pub, transcript, false);
  ck.fill(0);
  return {
    frame: { t: 'hs2', e: e.pub.toString('base64url'), c: sealed.toString('base64') },
    peer: { pub: is, name: String(inner.name || '').slice(0, 64), port: inner.port | 0, token },
    session,
  };
}

// Initiator finishes with hs2.
function finish(me, state, frame) {
  const re = Buffer.from(String(frame.e || ''), 'base64url');
  if (re.length !== 32) throw new Error('bad responder ephemeral');
  const ss = dh(me.priv, me.pub, state.rs);
  const ee = dh(state.e.priv, state.e.pub, re);
  const se = dh(state.e.priv, state.e.pub, state.rs); // same value the responder computed as se
  const transcript = sha256(state.e.pub, me.pub, state.rs, re, Buffer.from(String(state.token || '')));
  const ck = hkdf(Buffer.concat([state.es, ss, ee, se]), transcript, 'ck', 32);
  [state.es, ss, ee, se, state.e.priv].forEach((b) => b.fill(0));

  const k2 = hkdf(ck, ZERO, 'hs2', 32);
  let inner;
  try {
    inner = JSON.parse(aeadOpen(k2, nonce12(0), re, Buffer.from(String(frame.c || ''), 'base64')).toString('utf8'));
  } catch {
    throw new Error('handshake failed: responder is not who the invite said');
  } finally {
    k2.fill(0);
  }
  const session = deriveSession(ck, me.pub, state.rs, transcript, true);
  ck.fill(0);
  return { peer: { pub: state.rs, name: String(inner.name || '').slice(0, 64), port: inner.port | 0 }, session };
}

// One chain per direction. The initiator sends on chain A.
function deriveSession(ck, initiatorPub, responderPub, transcript, iAmInitiator) {
  const out = hkdf(ck, transcript, 'session', 64);
  const a = Buffer.from(out.subarray(0, 32));
  const b = Buffer.from(out.subarray(32));
  out.fill(0);
  return {
    send: iAmInitiator ? a : b,
    recv: iAmInitiator ? b : a,
    sendN: 0,
    recvN: 0,
    safetyNumber: safetyNumber(initiatorPub, responderPub),
  };
}

// 60 digits: 30 derived from each static key on its own, lower key first.
// Deriving from the pair would let an attacker who chooses BOTH substitute keys
// run a birthday search on one ~100-bit value; per-key halves make that ~2^100
// each. Stable per contact, so it is verified once. Two lines when displayed.
function safetyNumber(a, b) {
  const half = (k) => {
    const h = sha256(Buffer.from('p2pchat/v2/safety'), k);
    let d = '';
    for (let i = 0; i < 15; i++) d += (h.readUInt16BE(i * 2) % 100).toString().padStart(2, '0');
    return d.match(/.{1,5}/g).join(' ');
  };
  const low = Buffer.compare(a, b) < 0;
  return `${half(low ? a : b)}\n${half(low ? b : a)}`;
}

// --- per-message ratchet -----------------------------------------------------

function step(chain) {
  const out = hkdf(chain, ZERO, 'step', 64);
  const next = Buffer.from(out.subarray(0, 32));
  const key = Buffer.from(out.subarray(32));
  out.fill(0);
  return { next, key };
}

function seal(session, obj) {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const { next, key } = step(session.send);
  const n = session.sendN;
  const sealed = aeadSeal(key, nonce12(n), Buffer.from(`enc/${n}`), plaintext);
  key.fill(0); plaintext.fill(0); session.send.fill(0);
  session.send = next; session.sendN = n + 1;
  return { t: 'enc', n, c: sealed.toString('base64') };
}

function open(session, frame) {
  if (!Number.isInteger(frame.n)) throw new Error('missing counter');
  if (frame.n !== session.recvN) throw new Error(`out of order: expected ${session.recvN}, got ${frame.n}`);
  const { next, key } = step(session.recv);
  let obj;
  try {
    obj = JSON.parse(aeadOpen(key, nonce12(frame.n), Buffer.from(`enc/${frame.n}`), Buffer.from(String(frame.c || ''), 'base64')).toString('utf8'));
  } catch {
    key.fill(0); next.fill(0);
    throw new Error('decryption failed: tampered message or wrong peer');
  }
  key.fill(0); session.recv.fill(0);
  session.recv = next; session.recvN = frame.n + 1;
  return obj;
}

// --- vault (at-rest) ---------------------------------------------------------

function vaultSeal(key, obj) {
  const nonce = crypto.randomBytes(12);
  const sealed = aeadSeal(key, nonce, Buffer.from('vault'), Buffer.from(JSON.stringify(obj), 'utf8'));
  return Buffer.concat([Buffer.from('P2PV2'), nonce, sealed]);
}
function vaultOpen(key, buf) {
  if (buf.subarray(0, 5).toString() !== 'P2PV2') throw new Error('not a vault file');
  const nonce = buf.subarray(5, 17);
  return JSON.parse(aeadOpen(key, nonce, Buffer.from('vault'), buf.subarray(17)).toString('utf8'));
}

// Image bytes: one sealed file per message, same key as the vault, own nonce.
// The AAD binds the file to its message id, so a blob renamed to another id does not open.
function blobSeal(key, id, data) {
  const nonce = crypto.randomBytes(12);
  return Buffer.concat([Buffer.from('P2PB1'), nonce, aeadSeal(key, nonce, Buffer.from(`blob/${id}`), data)]);
}
function blobOpen(key, id, buf) {
  if (buf.subarray(0, 5).toString() !== 'P2PB1') throw new Error('not a blob file');
  return aeadOpen(key, buf.subarray(5, 17), Buffer.from(`blob/${id}`), buf.subarray(17));
}

// --- invites -----------------------------------------------------------------

const INVITE_PREFIX = 'p2pchat3:';
const OLD_PREFIX = 'p2pchat2:';
// h/p: LAN address (may be empty). r: relay address string. a: one-time relay intro address.
function makeInvite({ host, port, pub, name, token, relay, addr }) {
  const body = JSON.stringify({ h: host || '', p: port | 0, k: pub.toString('base64url'), n: String(name).slice(0, 64), t: token, r: relay || '', a: addr || '' });
  return INVITE_PREFIX + Buffer.from(body, 'utf8').toString('base64url');
}
function parseInvite(text) {
  const s = String(text).trim();
  const prefix = s.startsWith(INVITE_PREFIX) ? INVITE_PREFIX : s.startsWith(OLD_PREFIX) ? OLD_PREFIX : null;
  if (!prefix) throw new Error('not a p2pchat invite');
  let o;
  try { o = JSON.parse(Buffer.from(s.slice(prefix.length), 'base64url').toString('utf8')); }
  catch { throw new Error('invite is corrupt'); }
  const pub = Buffer.from(String(o.k || ''), 'base64url');
  if (pub.length !== 32) throw new Error('invite has a bad key');
  const host = typeof o.h === 'string' ? o.h.slice(0, 253) : '';
  const port = Number.isInteger(o.p) && o.p >= 1 && o.p <= 65535 ? o.p : 0;
  const relay = typeof o.r === 'string' && /^relay:\/\/[A-Za-z0-9.\[\]:-]+:\d{1,5}\/[A-Za-z0-9_-]{43}$/.test(o.r) ? o.r : '';
  const addr = typeof o.a === 'string' && /^[A-Za-z0-9_-]{43}$/.test(o.a) ? o.a : '';
  if (!(host && port) && !(relay && addr)) throw new Error('invite has neither a LAN address nor a relay address');
  if (typeof o.t !== 'string' || o.t.length < 16) throw new Error('invite has no token');
  return { host, port, pub, name: String(o.n || 'peer').slice(0, 64), token: o.t, relay, addr };
}

const newToken = () => crypto.randomBytes(16).toString('base64url');
const newId = () => crypto.randomBytes(12).toString('base64url');

module.exports = {
  // low-level pieces, exported so tests can build hostile frames the way an attacker would
  _internals: { dh, hkdf, aeadSeal, aeadOpen, nonce12, ZERO, sha256 },
  TOKEN_SHAPE, newKeypair, initiate, respond, finish, seal, open, safetyNumber,
  vaultSeal, vaultOpen, blobSeal, blobOpen, makeInvite, parseInvite, newToken, newId, sha256,
};
