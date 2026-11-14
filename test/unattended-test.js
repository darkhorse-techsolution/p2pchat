// Unattended access in the main process, without a window: the gate (main/unattended.js), both ends,
// wired to each other through the engine's shape check (sanitizeUa) the way the encrypted channel does.
const { createUnattended, MIN_PASS, MAX_WRONG, LOCK_MS, CHAL_MS } = require('../main/unattended.js');
const { sanitizeUa } = require('../core/engine.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, error(...a) { console.error(...a); } };

const HOST = 'H'.repeat(43), VIS = 'V'.repeat(43), OTHER = 'O'.repeat(43);
function fakeStore(pubs) {
  const contacts = Object.fromEntries(pubs.map((p) => [p, { pub: p, name: p[0] }]));
  return { contacts, contact: (p) => (Object.hasOwn(contacts, p) ? contacts[p] : null), upsertContact: (p, f) => Object.assign(contacts[p], f) };
}
// Two machines. Every frame goes through the shape check; `tap` sees it first and may change or drop it.
function pair() {
  const w = { clock: 1000000, frames: [], starts: [], stops: [], notes: [], startAnswer: { ok: true }, ready: '', tap: null, online: true };
  const deliver = (to, from, f) => {
    if (!w.online) throw new Error('they are offline');
    let g = sanitizeUa(f); if (!g) throw new Error('bad frame');
    w.frames.push({ from, ...g });
    if (w.tap) g = w.tap(from, g);
    if (g) setTimeout(() => to().onFrame({ pub: from, ...g }), 0);
  };
  w.hstore = fakeStore([VIS, OTHER]); w.vstore = fakeStore([HOST]);
  w.host = createUnattended({ store: w.hstore, me: () => HOST, send: (pub, f) => deliver(() => w.vis, HOST, f), ready: () => w.ready,
    start: async (pub) => { w.starts.push(pub); return w.startAnswer; }, stop: (pub) => w.stops.push(pub), notify: (ev) => w.notes.push(ev), log: quiet, now: () => w.clock });
  w.vis = createUnattended({ store: w.vstore, me: () => VIS, send: (pub, f) => deliver(() => w.host, VIS, f), ready: () => '',
    start: async () => ({ ok: false }), stop() {}, notify() {}, log: quiet, now: () => w.clock });
  return w;
}

(async () => {
  // U1: the password is set on the host and nothing of it is kept in the clear
  let w = pair();
  ok('U1 off by default', w.host.view(VIS).on === false);
  let err = ''; try { await w.host.setPassword(VIS, 'short'); } catch (e) { err = e.message; }
  ok(`U1 a password under ${MIN_PASS} characters is refused`, /at least 8/.test(err) && w.host.view(VIS).on === false);
  err = ''; try { await w.host.setPassword('X'.repeat(43), 'long enough password'); } catch (e) { err = e.message; }
  ok('U1 an unknown contact cannot be given one', /unknown contact/.test(err));
  const v1 = await w.host.setPassword(VIS, 'correct horse battery');
  const rec = w.hstore.contacts[VIS].ua;
  ok('U1 set: the view says on, the record holds a salt and a derived key', v1.on === true && rec.v === 1 && rec.salt.length === 22 && rec.key.length === 43 && !JSON.stringify(rec).includes('correct'));
  ok('U1 a new password ends a session under the old one', w.stops.length === 1 && w.stops[0] === VIS);

  // U2: the right password opens the gate, and the password never crosses the wire
  let r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U2 right password: ok, and the host started the share for that contact', r.ok === true && w.starts.length === 1 && w.starts[0] === VIS);
  ok('U2 four frames: ask, chal, proof, ok', w.frames.map((f) => f.op).join() === 'ask,chal,proof,ok');
  ok('U2 no frame carries the password or the stored key', !JSON.stringify(w.frames).includes('correct') && !JSON.stringify(w.frames).includes(rec.key));
  ok('U2 the host notes when it was last used', w.hstore.contacts[VIS].ua.last === w.clock);

  // U3: a wrong password is refused, counted, and told to the owner
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery');
  r = await w.vis.connect(HOST, 'wrong password 1');
  ok('U3 wrong password: refused as wrong, nothing started', r.ok === false && r.why === 'wrong' && w.starts.length === 0);
  ok('U3 the owner is told, with the tries left', w.notes.length === 1 && w.notes[0].what === 'wrong' && w.notes[0].left === MAX_WRONG - 1 && w.notes[0].pub === VIS);
  for (let i = 2; i < MAX_WRONG; i++) await w.vis.connect(HOST, `wrong password ${i}`);
  r = await w.vis.connect(HOST, `wrong password ${MAX_WRONG}`);
  ok(`U3 wrong ${MAX_WRONG} times in a row: locked, with the wait`, r.ok === false && r.why === 'locked' && r.wait === LOCK_MS / 1000 && w.notes[w.notes.length - 1].what === 'locked');
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U3 locked: the right password is refused too, and no challenge goes out', r.ok === false && r.why === 'locked' && w.starts.length === 0 && w.frames[w.frames.length - 2].op === 'ask');
  w.clock += LOCK_MS + 1000;
  for (let i = 1; i < MAX_WRONG; i++) await w.vis.connect(HOST, `wrong again ${i}`);
  r = await w.vis.connect(HOST, 'wrong again last');
  ok('U3 the second lockout is twice as long', r.why === 'locked' && r.wait === 2 * LOCK_MS / 1000);
  w.clock += 2 * LOCK_MS + 1000;
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U3 after the lock the right password works', r.ok === true && w.starts.length === 1);

  // U4: a nonce is good for one proof
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery');
  r = await w.vis.connect(HOST, 'correct horse battery');
  const proof = w.frames.find((f) => f.op === 'proof');
  w.host.onFrame({ pub: VIS, op: 'proof', id: proof.id, mac: proof.mac }); await tick(20);
  ok('U4 the same proof again: expired, nothing started twice', w.frames[w.frames.length - 1].op === 'no' && w.frames[w.frames.length - 1].why === 'expired' && w.starts.length === 1);
  // ... and for a minute
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery');
  w.tap = (from, f) => { if (f.op === 'chal') w.clock += CHAL_MS + 1; return f; };
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U4 a proof that comes after the nonce ran out: expired', r.ok === false && r.why === 'expired' && w.starts.length === 0);
  // a proof made for another host or another contact is no proof here
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery'); await w.host.setPassword(OTHER, 'correct horse battery');
  r = await w.vis.connect(HOST, 'correct horse battery');
  const p2 = w.frames.find((f) => f.op === 'proof'), c2 = w.frames.find((f) => f.op === 'chal');
  w.host.onFrame({ pub: OTHER, op: 'ask', id: p2.id }); await tick(20);
  w.host.onFrame({ pub: OTHER, op: 'proof', id: p2.id, mac: p2.mac }); await tick(20);
  ok('U4 a proof from one contact does not open the gate for another (same password, own salt and key)', w.starts.length === 1 && w.frames[w.frames.length - 1].why === 'wrong' && w.hstore.contacts[OTHER].ua.salt !== c2.salt);

  // U5: off, switched off, not ready, capture failed
  w = pair();
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U5 a contact it is not switched on for: off, and no challenge', r.ok === false && r.why === 'off' && w.frames.length === 2);
  await w.host.setPassword(VIS, 'correct horse battery'); w.host.clear(VIS);
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U5 switched off again: off, the record is gone, a running session is ended', r.why === 'off' && w.hstore.contacts[VIS].ua === null && w.stops.length === 2);
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery'); w.ready = 'perm';
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U5 the host cannot capture right now: said before any challenge', r.why === 'perm' && w.frames.length === 2);
  w.ready = ''; w.startAnswer = { ok: false, why: 'busy' };
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U5 the share did not start: the reason reaches the visitor, and it is not counted as wrong', r.ok === false && r.why === 'busy' && w.notes.length === 0);
  w.startAnswer = { ok: false, why: 'something else' };
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U5 an unknown reason goes out as capture', r.why === 'capture');
  // switched off while the capture was starting
  const slow = pair();
  let release; const held = new Promise((res) => { release = res; });
  const sh = createUnattended({ store: slow.hstore, me: () => HOST, send: (pub, f) => slow.frames.push({ from: HOST, ...sanitizeUa(f) }), ready: () => '',
    start: async (pub) => { slow.starts.push(pub); await held; return { ok: true }; }, stop: (pub) => slow.stops.push(pub), notify() {}, log: quiet, now: () => slow.clock });
  await sh.setPassword(VIS, 'correct horse battery');
  sh.onFrame({ pub: VIS, op: 'ask', id: '00112233445566aa' }); await tick(5);
  const ch = slow.frames.find((f) => f.op === 'chal');
  const crypto = require('node:crypto');
  const key = await new Promise((res) => crypto.scrypt(Buffer.from('correct horse battery'), Buffer.from(slow.hstore.contacts[VIS].ua.salt, 'base64url'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (_e, k) => res(k)));
  const mac = crypto.createHmac('sha256', key).update(JSON.stringify(['p2pchat-unattended-1', ch.nonce, VIS, HOST, '00112233445566aa'])).digest().toString('base64url');
  sh.onFrame({ pub: VIS, op: 'proof', id: '00112233445566aa', mac }); await tick(150);
  ok('U5 the stored key is scrypt(password, salt) and the proof an HMAC over nonce, both keys and the id', slow.starts.length === 1);
  const stopsBefore = slow.stops.length;
  sh.clear(VIS); release(); await tick(20);
  ok('U5 switched off while the capture started: answered off, and the session is stopped', slow.frames[slow.frames.length - 1].op === 'no' && slow.frames[slow.frames.length - 1].why === 'off' && slow.stops.length >= stopsBefore + 2);

  // U6: the visitor's side
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery');
  const first = w.vis.connect(HOST, 'correct horse battery'), second = await w.vis.connect(HOST, 'correct horse battery');
  ok('U6 one try at a time per contact', second.ok === false && second.why === 'inflight' && (await first).ok === true);
  w = pair(); w.online = false;
  r = await w.vis.connect(HOST, 'correct horse battery');
  ok('U6 the contact is offline: said at once', r.ok === false && r.why === 'offline');
  r = await w.vis.connect(OTHER, 'correct horse battery');
  ok('U6 not a contact here: nothing is sent', r.ok === false && r.why === 'unavailable' && w.frames.length === 0);
  // a second challenge for the same try gets no second proof
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery');
  let chals = 0;
  w.tap = (from, f) => { if (f.op === 'chal' && ++chals === 1) setTimeout(() => w.vis.onFrame({ pub: HOST, op: 'chal', id: f.id, salt: 'A'.repeat(22), nonce: 'B'.repeat(43) }), 5); return f; };   // lands while the first one's key is being derived
  r = await w.vis.connect(HOST, 'correct horse battery'); await tick(200);
  ok('U6 a second challenge for the same try gets no second proof', w.frames.filter((f) => f.op === 'proof').length === 1 && r.ok === true);
  // an ok that no proof was sent for opens nothing on the visitor's side
  w = pair(); await w.host.setPassword(VIS, 'correct horse battery');
  w.tap = (from, f) => { if (f.op === 'ask') { setTimeout(() => w.vis.onFrame({ pub: HOST, op: 'ok', id: f.id }), 0); return null; } return f; };
  const early = w.vis.connect(HOST, 'correct horse battery'); await tick(30);
  w.vis.onOffline(HOST);
  r = await early;
  ok('U6 an ok before any proof is ignored; the contact going offline ends the try', r.ok === false && r.why === 'offline');
  ok('U6 status counts what is open', w.vis.status().out === 0 && w.host.status().open === 0);

  // U7: the shape check of the frames
  ok('U7 ask and ok carry an id of 16 hex and nothing else', JSON.stringify(sanitizeUa({ op: 'ask', id: 'ab'.repeat(8), salt: 'x', extra: 1 })) === '{"op":"ask","id":"abababababababab"}' && sanitizeUa({ op: 'ask', id: 'AB'.repeat(8) }) === null && sanitizeUa({ op: 'ask' }) === null);
  ok('U7 chal needs a 16-byte salt and a 32-byte nonce in base64url', sanitizeUa({ op: 'chal', id: 'ab'.repeat(8), salt: 'A'.repeat(22), nonce: 'B'.repeat(43) }) !== null && sanitizeUa({ op: 'chal', id: 'ab'.repeat(8), salt: 'A'.repeat(21), nonce: 'B'.repeat(43) }) === null && sanitizeUa({ op: 'chal', id: 'ab'.repeat(8), salt: 'A'.repeat(22), nonce: 'B+'.repeat(21) + 'B' }) === null);
  ok('U7 proof needs a 32-byte mac', sanitizeUa({ op: 'proof', id: 'ab'.repeat(8), mac: 'C'.repeat(43) }) !== null && sanitizeUa({ op: 'proof', id: 'ab'.repeat(8), mac: 'C'.repeat(44) }) === null && sanitizeUa({ op: 'proof', id: 'ab'.repeat(8), mac: {} }) === null);
  ok('U7 no: an unknown reason becomes unavailable, a wait is a whole number of seconds up to a day', sanitizeUa({ op: 'no', id: 'ab'.repeat(8), why: '__proto__', wait: 1.5 }).why === 'unavailable' && sanitizeUa({ op: 'no', id: 'ab'.repeat(8), why: 'locked', wait: 600 }).wait === 600 && !('wait' in sanitizeUa({ op: 'no', id: 'ab'.repeat(8), why: 'locked', wait: 1e9 })));
  ok('U7 anything else is no frame', sanitizeUa({ op: 'start', id: 'ab'.repeat(8) }) === null && sanitizeUa(null) === null && sanitizeUa('ask') === null);
})().catch((e) => { console.error(e); process.exitCode = 1; });
