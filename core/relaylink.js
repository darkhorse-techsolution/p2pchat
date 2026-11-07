'use strict';
// Encrypted link between an app and a relay (NK pattern: the client knows the
// relay's static key from the relay address, the relay learns nothing about the
// client). Everything that crosses the link is then sealed with the same
// per-message ratchet the app uses between peers. The relay sees only random
// addresses and ciphertext; the network sees only ciphertext.
//
// Relay address string:  relay://host:port/<relay static pub, base64url>
//
// Inside the link, control messages are plain objects with a `k`:
//   bind   { addr, sig }        addr = ed25519 pub; sig over nonce||addr proves ownership
//   bound  { addr } | err { addr?, ch?, why }
//   unbind { addr }
//   open   { ch, to }           caller picks a random 16-byte ch
//   opened { ch } | unreachable { ch } | incoming { ch }
//   data   { ch, f }            f = an app frame (hs1 / hs2 / enc), forwarded verbatim
//   close  { ch } | closed { ch }
//   ping   {} | pong {}

const crypto = require('node:crypto');
const kc = require('./crypto.js');
const { dh, hkdf, aeadSeal, aeadOpen, nonce12, ZERO, sha256 } = kc._internals;

const ADDR_RE = /^relay:\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})\/([A-Za-z0-9_-]{43})$/;

function parseRelayAddress(s) {
  const m = ADDR_RE.exec(String(s || '').trim());
  if (!m) throw new Error('not a relay address (relay://host:port/key)');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new Error('bad relay port');
  return { host: m[1].replace(/^\[|\]$/g, ''), port, pub: Buffer.from(m[3], 'base64url') };
}
const formatRelayAddress = ({ host, port, pub }) => `relay://${host.includes(':') ? `[${host}]` : host}:${port}/${pub.toString('base64url')}`;

function session(ck, transcript, iAmClient) {
  const out = hkdf(ck, transcript, 'link', 64);
  const a = Buffer.from(out.subarray(0, 32)), b = Buffer.from(out.subarray(32));
  out.fill(0);
  return { send: iAmClient ? a : b, recv: iAmClient ? b : a, sendN: 0, recvN: 0 };
}

// Client step 1.
function clientHello(relayPub) {
  const e = kc.newKeypair();
  const es = dh(e.priv, e.pub, relayPub);
  const k = hkdf(es, ZERO, 'lk1', 32);
  const c = aeadSeal(k, nonce12(0), e.pub, Buffer.from(JSON.stringify({ v: 1 })));
  k.fill(0);
  return { frame: { t: 'lk1', e: e.pub.toString('base64url'), c: c.toString('base64') }, state: { e, es, relayPub } };
}

// Relay step. `me` is the relay's static keypair. Returns the session and the
// nonce that bind proofs must sign.
function relayRespond(me, frame) {
  const ce = Buffer.from(String(frame.e || ''), 'base64url');
  if (ce.length !== 32) throw new Error('bad client ephemeral');
  const es = dh(me.priv, me.pub, ce);
  const k1 = hkdf(es, ZERO, 'lk1', 32);
  let hello;
  try { hello = JSON.parse(aeadOpen(k1, nonce12(0), ce, Buffer.from(String(frame.c || ''), 'base64')).toString('utf8')); }
  catch { k1.fill(0); es.fill(0); throw new Error('client does not know this relay\'s key'); }
  k1.fill(0);
  if (hello.v !== 1) { es.fill(0); throw new Error('unsupported link version'); }
  const e = kc.newKeypair();
  const ee = dh(e.priv, e.pub, ce);
  const transcript = sha256(ce, me.pub, e.pub);
  const ck = hkdf(Buffer.concat([es, ee]), transcript, 'lkck', 32);
  es.fill(0); ee.fill(0);
  const nonce = crypto.randomBytes(16);
  const k2 = hkdf(ck, ZERO, 'lk2', 32);
  const c = aeadSeal(k2, nonce12(0), e.pub, Buffer.from(JSON.stringify({ nonce: nonce.toString('base64url') })));
  k2.fill(0);
  const s = session(ck, transcript, false);
  ck.fill(0);
  return { frame: { t: 'lk2', e: e.pub.toString('base64url'), c: c.toString('base64') }, session: s, nonce };
}

// Client step 2. Returns the session and the relay's nonce.
function clientFinish(state, frame) {
  const re = Buffer.from(String(frame.e || ''), 'base64url');
  if (re.length !== 32) throw new Error('bad relay ephemeral');
  const ee = dh(state.e.priv, state.e.pub, re);
  const transcript = sha256(state.e.pub, state.relayPub, re);
  const ck = hkdf(Buffer.concat([state.es, ee]), transcript, 'lkck', 32);
  state.es.fill(0); ee.fill(0); state.e.priv.fill(0);
  const k2 = hkdf(ck, ZERO, 'lk2', 32);
  let inner;
  try { inner = JSON.parse(aeadOpen(k2, nonce12(0), re, Buffer.from(String(frame.c || ''), 'base64')).toString('utf8')); }
  catch { k2.fill(0); ck.fill(0); throw new Error('relay is not the one the address names'); }
  k2.fill(0);
  const nonce = Buffer.from(String(inner.nonce || ''), 'base64url');
  if (nonce.length !== 16) { ck.fill(0); throw new Error('bad relay nonce'); }
  const s = session(ck, transcript, true);
  ck.fill(0);
  return { session: s, nonce };
}

// --- addresses: an address is an ed25519 public key; owning it means signing ---
function newAddress() {
  const kp = crypto.generateKeyPairSync('ed25519');
  return {
    pub: Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64url'),
    priv: Buffer.from(kp.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64url'),
  };
}
const isAddr = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
function bindProof(address, nonce) {
  const key = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: address.priv, x: address.pub }, format: 'jwk' });
  return crypto.sign(null, Buffer.concat([nonce, Buffer.from(address.pub, 'base64url')]), key).toString('base64url');
}
function verifyBind(addrPub, sig, nonce) {
  if (!isAddr(addrPub) || typeof sig !== 'string') return false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: addrPub }, format: 'jwk' });
    return crypto.verify(null, Buffer.concat([nonce, Buffer.from(addrPub, 'base64url')]), key, Buffer.from(sig, 'base64url'));
  } catch { return false; }
}

const newChannelId = () => crypto.randomBytes(16).toString('base64url');
const isChannelId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);

module.exports = { parseRelayAddress, formatRelayAddress, clientHello, relayRespond, clientFinish, newAddress, isAddr, bindProof, verifyBind, newChannelId, isChannelId };
