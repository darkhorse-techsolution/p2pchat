const kc = require('../core/crypto.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };

const alice = { ...kc.newKeypair(), name: 'Alice' };
const bob = { ...kc.newKeypair(), name: 'Bob' };
const token = kc.newToken();

// happy path: alice initiates knowing bob's static + a token bob issued
const h1 = kc.initiate(alice, bob.pub, token, {name:'Alice',port:1});
const r = kc.respond(bob, h1.frame, (pub, tok) => tok === token, {name:'Bob',port:2});
const f = kc.finish(alice, h1.state, r.frame);
ok('responder learned initiator static + name', r.peer.pub.equals(alice.pub) && r.peer.name === 'Alice');
ok('initiator learned responder name', f.peer.name === 'Bob' && f.peer.pub.equals(bob.pub));
ok('safety numbers equal', r.session.safetyNumber === f.session.safetyNumber);
ok('safety number is two 30-digit halves', /^(\d{5} ){5}\d{5}\n(\d{5} ){5}\d{5}$/.test(r.session.safetyNumber));
ok('safety number stable across sessions (depends on statics only)',
  kc.safetyNumber(alice.pub, bob.pub) === r.session.safetyNumber);

// message both directions
const m1 = kc.seal(f.session, { k: 'text', text: 'hi bob' });
ok('a->b', kc.open(r.session, m1).text === 'hi bob');
const m2 = kc.seal(r.session, { k: 'text', text: 'hi alice' });
ok('b->a', kc.open(f.session, m2).text === 'hi alice');

// second session gets different keys (fresh ephemerals)
const h1b = kc.initiate(alice, bob.pub, token, {name:'Alice',port:1});
const rb = kc.respond(bob, h1b.frame, () => true, {name:'Bob',port:2});
const fb = kc.finish(alice, h1b.state, rb.frame);
ok('fresh session keys per connection', !fb.session.send.equals(f.session.send) && rb.session.safetyNumber === r.session.safetyNumber);

// bad token refused
ok('unknown peer with bad token refused', (() => {
  const h = kc.initiate(alice, bob.pub, 'wrong', {name:'Alice'});
  try { kc.respond(bob, h.frame, (p, t) => t === token, {name:'Bob',port:2}); return false; } catch (e) { return /refused/.test(e.message); }
})());
// known contact accepted without token
ok('known contact accepted by pubkey', (() => {
  const h = kc.initiate(alice, bob.pub, '', {name:'Alice'});
  try { kc.respond(bob, h.frame, (p) => p.equals(alice.pub), {name:'Bob',port:2}); return true; } catch { return false; }
})());
// wrong responder (eve answering with her key) must fail at finish
ok('impostor responder rejected at finish', (() => {
  const eve = kc.newKeypair();
  const h = kc.initiate(alice, bob.pub, token, {name:'Alice',port:1});
  // eve cannot even open hs1 (needs bob.priv); simulate her forging an hs2 anyway
  try { kc.finish(alice, h.state, { e: eve.pub.toString('base64url'), c: Buffer.alloc(40).toString('base64') }); return false; }
  catch (e) { return /not who the invite said/.test(e.message); }
})());
// eve cannot open hs1 addressed to bob
ok('hs1 unreadable without responder private key', (() => {
  const eve = kc.newKeypair();
  const h = kc.initiate(alice, bob.pub, token, {name:'Alice',port:1});
  try { kc.respond(eve, h.frame, () => true, {name:'Eve'}); return false; } catch (e) { return /could not prove/.test(e.message); }
})());
// tamper
ok('tampered message rejected, chain intact', (() => {
  const good = kc.seal(f.session, { k: 'text', text: 'x' });
  const bad = { ...good, c: Buffer.from('zz' + good.c).toString('base64') };
  try { kc.open(r.session, bad); return false; } catch {}
  return kc.open(r.session, good).text === 'x';
})());
// vault roundtrip
const vk = require('node:crypto').randomBytes(32);
const blob = kc.vaultSeal(vk, { a: 1, nested: { b: [1, 2, 3] } });
ok('vault roundtrip', JSON.stringify(kc.vaultOpen(vk, blob)) === JSON.stringify({ a: 1, nested: { b: [1, 2, 3] } }));
ok('vault wrong key rejected', (() => { try { kc.vaultOpen(require('node:crypto').randomBytes(32), blob); return false; } catch { return true; } })());
// invite
const inv = kc.makeInvite({ host: '10.0.0.5', port: 4444, pub: bob.pub, name: 'Bob', token });
const p = kc.parseInvite(inv);
ok('invite roundtrip', p.host === '10.0.0.5' && p.port === 4444 && p.pub.equals(bob.pub) && p.name === 'Bob' && p.token === token);
ok('v1 invite rejected', (() => { try { kc.parseInvite('p2pchat1:abc'); return false; } catch { return true; } })());

// --- review fixes ---
ok('prototype-name token refused', (() => {
  for (const tok of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const h = kc.initiate(alice, bob.pub, tok, { name: 'Alice' });
    try { kc.respond(bob, h.frame, (p, t) => t === token, { name: 'Bob' }); return false; } catch (e) { if (!/refused/.test(e.message)) return false; }
  }
  return true;
})());
ok('token with illegal characters never reaches accept()', (() => {
  let called = false;
  const h = kc.initiate(alice, bob.pub, 'a b/c', { name: 'Alice' });
  try { kc.respond(bob, h.frame, () => { called = true; return true; }, { name: 'Bob' }); } catch {}
  return !called;
})());
// Builds hs1 the way an attacker would: fresh ephemeral, es with the responder's
// real static, c1 claiming SOMEONE ELSE's static, c2 under a key they cannot
// derive (they lack that static's private key).
function forgeHs1(claimedPub, responderPub, meta) {
  const { dh, hkdf, aeadSeal, nonce12, ZERO } = kc._internals;
  const e = kc.newKeypair(), eve = kc.newKeypair();
  const es = dh(e.priv, e.pub, responderPub);
  const c1 = aeadSeal(hkdf(es, ZERO, 'hs1a', 32), nonce12(0), e.pub, claimedPub);
  const ssWrong = dh(eve.priv, eve.pub, responderPub);
  const c2 = aeadSeal(hkdf(Buffer.concat([es, ssWrong]), ZERO, 'hs1b', 32), nonce12(1), c1, Buffer.from(JSON.stringify({ token: '', ...meta })));
  return { t: 'hs1', e: e.pub.toString('base64url'), c1: c1.toString('base64'), c2: c2.toString('base64') };
}
ok('hs1 claiming a static without its private key is rejected', (() => {
  let acceptCalled = false;
  try { kc.respond(bob, forgeHs1(alice.pub, bob.pub, { name: 'Alice?', port: 1 }), () => { acceptCalled = true; return true; }, { name: 'Bob' }); return false; }
  catch (e) { return /does not hold the private key/.test(e.message) && !acceptCalled; }
})());
// BoringSSL (Electron) refuses a JWK whose d and x disagree; OpenSSL (system Node) accepts
// it. The protocol must not depend on that: a mismatched pair must either fail to build
// or produce an hs1 the responder rejects.
ok('a mismatched keypair cannot impersonate a static (either runtime)', (() => {
  let h;
  try { h = kc.initiate({ pub: alice.pub, priv: kc.newKeypair().priv }, bob.pub, '', { name: 'x' }); } catch (e) { return /JWK/.test(e.message); }
  try { kc.respond(bob, h.frame, () => true, { name: 'Bob' }); return false; } catch (e) { return /does not hold the private key/.test(e.message); }
})());
ok('hs1 static is not visible on the wire', (() => {
  const h = kc.initiate(alice, bob.pub, token, { name: 'Alice' });
  const wire = JSON.stringify(h.frame);
  return !wire.includes(alice.pub.toString('base64url')) && !wire.includes('Alice');
})());
