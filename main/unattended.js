'use strict';
// Unattended access: a contact that the owner of this machine picked may start a share of its screen,
// and control of it, with nobody here to click. The owner switches it on per contact and sets a
// password for that contact (contact info); it is off for everyone else. This file is the gate, both
// ends of it, and nothing more: the share and the control are the ordinary ones (ui/share), started
// by the page once the gate has opened, and a notice stays on this machine's screen for as long as
// such a session runs (main/accesscard.js).
//
// The exchange rides the chat's encrypted channel as `ua` frames, so it comes from that contact's
// key and from nobody else. The password is never sent and never stored:
//   ask   { id }                  visitor: I want in
//   chal  { id, salt, nonce }     host: the salt of your password, and a nonce made for this one try
//   proof { id, mac }             visitor: HMAC(scrypt(password, salt); nonce, both keys, id)
//   ok    { id }                  host: my screen is on its way
//   no    { id, why, wait? }      host: not now, and why
// The host keeps scrypt(password, salt) in its vault and compares. A nonce is good for one proof and
// for a minute. Wrong proofs are counted per contact: MAX_WRONG in a row lock that contact out, each
// time for twice as long. The count lives in memory: only this machine's owner can restart the app.
// Kept apart from main.js so that it can be tested without a window.
const crypto = require('node:crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };   // 32 MB and about 0.1 s per guess
const MIN_PASS = 8, MAX_PASS = 128;
const MAX_WRONG = 5, LOCK_MS = 10 * 60 * 1000, LOCK_MAX_MS = 6 * 3600 * 1000;
const CHAL_MS = 60000;    // a nonce is good this long
const ASK_MS = 12000;     // the visitor waits this long for the challenge: a host that is 0.9.0 or older never answers
const START_MS = 45000;   // ... and this long for the answer to its proof: the host starts its capture first
const WHYS = new Set(['off', 'locked', 'wrong', 'expired', 'busy', 'perm', 'capture', 'unavailable']);

const b64 = (b) => b.toString('base64url');
const derive = (password, salt) => new Promise((res, rej) => crypto.scrypt(Buffer.from(String(password).normalize('NFKC'), 'utf8'), salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
// Both keys and the id are part of what is signed: a proof made for one host, or one try, is no proof anywhere else.
const macOf = (key, nonce, visitor, host, id) => crypto.createHmac('sha256', key).update(JSON.stringify(['p2pchat-unattended-1', nonce, visitor, host, id])).digest();

// store: contact(pub), upsertContact(pub, fields). me(): this machine's key, as contacts know it.
// send(pub, frame): throws when that contact is offline. ready(pub): '' or why a share cannot start now.
// start(pub): the page starts the share, resolves { ok, why }. stop(pub): the page ends an unattended
// session with that contact, if one runs. notify(ev): told to the owner (wrong passwords, lockouts).
function createUnattended({ store, me, send, ready, start, stop, notify, log, now = Date.now }) {
  const say = (pub, f) => { try { send(pub, f); return true; } catch { return false; } };

  // --- host: this machine is the one being accessed ---------------------------------------
  const chal = new Map();    // pub -> { id, nonce, until }: the one try that is open for that contact
  const wrong = new Map();   // pub -> { n, locks, until }
  const lockedFor = (pub) => { const w = wrong.get(pub); return w && w.until > now() ? Math.ceil((w.until - now()) / 1000) : 0; };
  const view = (pub) => { const c = store.contact(pub), u = c && c.ua; return u ? { on: true, set: u.set || 0, last: u.last || 0 } : { on: false }; };

  // A new password ends the session that runs under the old one, and so does switching it off.
  async function setPassword(pub, password) {
    if (!store.contact(pub)) throw new Error('unknown contact');
    const pw = String(password ?? '').normalize('NFKC');
    if (pw.length < MIN_PASS) throw new Error(`The password needs at least ${MIN_PASS} characters`);
    if (pw.length > MAX_PASS) throw new Error(`The password can have at most ${MAX_PASS} characters`);
    const salt = crypto.randomBytes(16), key = await derive(pw, salt);
    if (!store.contact(pub)) throw new Error('unknown contact');   // removed while the key was derived
    store.upsertContact(pub, { ua: { v: 1, salt: b64(salt), key: b64(key), set: now(), last: 0 } });
    wrong.delete(pub); chal.delete(pub); stop(pub);
    log.info('unattended access: on for', pub.slice(0, 8));
    return view(pub);
  }
  function clear(pub) {
    const c = store.contact(pub);
    if (c && c.ua) { store.upsertContact(pub, { ua: null }); log.info('unattended access: off for', pub.slice(0, 8)); }
    wrong.delete(pub); chal.delete(pub); stop(pub);
    return view(pub);
  }

  async function onHost(pub, f) {
    const c = store.contact(pub), cfg = c && c.ua;
    const no = (why, wait) => say(pub, wait ? { op: 'no', id: f.id, why, wait } : { op: 'no', id: f.id, why });
    if (f.op === 'ask') {
      if (!cfg) return no('off');
      if (lockedFor(pub)) return no('locked', lockedFor(pub));
      const why = ready(pub);
      if (why) return no(WHYS.has(why) ? why : 'unavailable');
      const nonce = b64(crypto.randomBytes(32));
      chal.set(pub, { id: f.id, nonce, until: now() + CHAL_MS });
      return say(pub, { op: 'chal', id: f.id, salt: cfg.salt, nonce });
    }
    const ch = chal.get(pub);
    chal.delete(pub);                                         // one proof per nonce, right or wrong
    if (!cfg) return no('off');
    if (!ch || ch.id !== f.id || ch.until < now()) return no('expired');
    if (lockedFor(pub)) return no('locked', lockedFor(pub));
    const want = macOf(Buffer.from(cfg.key, 'base64url'), ch.nonce, pub, me(), f.id), got = Buffer.from(f.mac, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      const w = wrong.get(pub) || { n: 0, locks: 0, until: 0 };
      w.n++;
      if (w.n >= MAX_WRONG) { w.n = 0; w.locks++; w.until = now() + Math.min(LOCK_MAX_MS, LOCK_MS * 2 ** (w.locks - 1)); }
      wrong.set(pub, w);
      const wait = lockedFor(pub);
      log.info('unattended access: wrong password from', pub.slice(0, 8), wait ? `locked for ${wait} s` : `${MAX_WRONG - w.n} left`);
      notify({ pub, what: wait ? 'locked' : 'wrong', wait, left: wait ? 0 : MAX_WRONG - w.n });
      return wait ? no('locked', wait) : no('wrong');
    }
    wrong.delete(pub);
    let r;
    try { r = await start(pub); } catch (e) { log.error('unattended access: start', e); r = { ok: false, why: 'capture' }; }
    const still = store.contact(pub);
    if (!still || !still.ua) { stop(pub); return no('off'); }   // switched off while the capture was starting
    if (!r || !r.ok) { log.info('unattended access: could not start for', pub.slice(0, 8), (r && r.why) || ''); return no(r && WHYS.has(r.why) ? r.why : 'capture'); }
    store.upsertContact(pub, { ua: { ...still.ua, last: now() } });
    log.info('unattended access: session started for', pub.slice(0, 8));
    return say(pub, { op: 'ok', id: f.id });
  }

  // --- visitor: this machine connects to a contact's ---------------------------------------
  const out = new Map();     // pub -> { id, password, stage, timer, done }: the one try that is out to that contact
  function connect(pub, password) {
    return new Promise((resolve) => {
      if (!store.contact(pub)) return resolve({ ok: false, why: 'unavailable' });
      if (out.has(pub)) return resolve({ ok: false, why: 'inflight' });
      const o = { id: crypto.randomBytes(8).toString('hex'), password: String(password ?? ''), stage: 'ask', timer: null };
      o.done = (r) => { if (out.get(pub) !== o) return; out.delete(pub); clearTimeout(o.timer); o.password = null; resolve(r); };
      out.set(pub, o);
      o.timer = setTimeout(() => o.done({ ok: false, why: 'noanswer' }), ASK_MS);
      if (!say(pub, { op: 'ask', id: o.id })) o.done({ ok: false, why: 'offline' });
    });
  }
  async function onVisitor(pub, f) {
    const o = out.get(pub);
    if (!o || o.id !== f.id) return;
    if (f.op === 'no') return o.done(f.wait ? { ok: false, why: f.why, wait: f.wait } : { ok: false, why: f.why });
    if (f.op === 'ok') { if (o.stage === 'proof') o.done({ ok: true }); return; }
    // One challenge per try: each proof is one more guess at the password for whoever holds the other end.
    if (o.stage !== 'ask') return;
    o.stage = 'deriving';
    const password = o.password; o.password = null;
    let key;
    try { key = await derive(password, Buffer.from(f.salt, 'base64url')); } catch (e) { log.error('unattended access: derive', e); return o.done({ ok: false, why: 'unavailable' }); }
    if (out.get(pub) !== o) return;                            // given up meanwhile
    o.stage = 'proof';
    clearTimeout(o.timer); o.timer = setTimeout(() => o.done({ ok: false, why: 'noanswer' }), START_MS);
    if (!say(pub, { op: 'proof', id: o.id, mac: b64(macOf(key, f.nonce, me(), pub, o.id)) })) o.done({ ok: false, why: 'offline' });
  }

  // one `ua` frame from a contact (the engine checked its shape)
  function onFrame(ev) {
    const run = ev.op === 'ask' || ev.op === 'proof' ? onHost : onVisitor;
    return run(ev.pub, ev).catch((e) => log.error('unattended access', e));
  }
  // a contact went offline: a try that was out to it is over, and so is the one it had open here
  function onOffline(pub) { const o = out.get(pub); if (o) o.done({ ok: false, why: 'offline' }); chal.delete(pub); }

  return { setPassword, clear, view, connect, onFrame, onOffline, status: () => ({ open: chal.size, out: out.size, locked: [...wrong.keys()].filter((p) => lockedFor(p)).length }) };
}

module.exports = { createUnattended, MIN_PASS, MAX_WRONG, LOCK_MS, CHAL_MS };
