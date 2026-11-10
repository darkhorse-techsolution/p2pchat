const fs = require('node:fs');
const crypto = require('node:crypto');
const { Store } = require('../core/store.js');
const { Transport } = require('../core/transport.js');
const { Engine } = require('../core/engine.js');
const DIR = require('node:path').join(require('node:os').tmpdir(), 'p2pchat-test-vaults');
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000, label = '') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } console.log('      (timeout waiting:', label, ')'); return false; };
const KEYS = { alice: crypto.randomBytes(32), bob: crypto.randomBytes(32) };
async function boot(who, opts = {}) {
  const store = new Store(`${DIR}/${who}.vault`, KEYS[who]).load();
  if (!store.identity().name) store.setName(who[0].toUpperCase() + who.slice(1));
  const e = new Engine(store, new Transport(), opts);
  e.on('error', (x) => console.log(`      [${who} error] ${x.message}`));
  await e.start();
  return e;
}
(async () => {
  let alice = await boot('alice'), bob = await boot('bob');
  const A = alice.me.pub.toString('base64url'), B = bob.me.pub.toString('base64url');
  ok('both listen on fixed persisted ports', alice.store.data.port === alice.transport.port && bob.transport.port > 0);

  // 1. invite -> add -> connect
  const inv = alice.invite();
  bob.addContact(inv);
  ok('bob stored alice as a contact', !!bob.store.contact(A));
  ok('both come online', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 6000, 'online'));
  ok('alice auto-added bob via the invite token', !!alice.store.contact(B) && alice.store.contact(B).name === 'Bob');
  ok('alice learned bob\'s listen port from the handshake', alice.store.contact(B).port === bob.transport.port);
  ok('token is single-use (consumed)', Object.keys(alice.store.data.invites).length === 0);
  ok('safety numbers agree and are per-contact-stable', alice.safetyNumber(B) === bob.safetyNumber(A) && alice.safetyNumber(B).split('\n').length === 2);

  // 2. messages both ways + delivered
  const got = []; bob.on('message', ({ msg }) => { if (msg.from === 'peer') got.push(msg); });
  const m1 = alice.sendMessage(B, { kind: 'text', text: 'hello bob' });
  ok('alice->bob stored', await waitFor(() => got.length === 1 && got[0].text === 'hello bob', 3000, 'a->b'));
  ok('alice sees delivered after ack', await waitFor(() => alice.store.conv(B).messages[0].status === 'delivered', 3000, 'ack'));
  const gotA = []; alice.on('message', ({ msg }) => { if (msg.from === 'peer') gotA.push(msg); });
  bob.sendMessage(A, { kind: 'code', text: 'const x = 1;\nconsole.log(x);', lang: 'js' });
  ok('code message arrives with kind + lang', await waitFor(() => gotA.length === 1 && gotA[0].kind === 'code' && gotA[0].lang === 'js' && gotA[0].text.includes('console.log'), 3000, 'code'));
  ok('bob unread count incremented', bob.store.conv(A).unread === 1);

  // 3. bob goes offline; alice sends 3; bob returns with same vault -> catch-up
  bob.stop();
  ok('alice sees bob offline', await waitFor(() => alice.status(B) === 'offline', 6000, 'offline'));
  for (let i = 1; i <= 3; i++) alice.sendMessage(B, { kind: 'text', text: `offline ${i}` });
  ok('messages stored as pending while peer offline', alice.store.pendingOutgoing(B, 1).length === 3 && alice.store.conv(B).messages.filter(m => m.status === 'pending').length === 3);
  bob = await boot('bob');
  ok('bob identity persisted across restart', bob.me.pub.toString('base64url') === B);
  ok('bob still has alice as contact + history', !!bob.store.contact(A) && bob.store.conv(A).messages.length === 2);
  ok('reconnects automatically', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 10000, 'reconnect'));
  ok('offline messages caught up in order', await waitFor(() => {
    const t = bob.store.conv(A).messages.filter(m => m.from === 'peer').map(m => m.text);
    return t.join('|') === 'hello bob|offline 1|offline 2|offline 3';
  }, 5000, 'catchup'));
  ok('alice marks them delivered', await waitFor(() => alice.store.conv(B).messages.every(m => m.status === 'delivered'), 3000, 'delivered'));
  ok('no duplicates after catch-up', bob.store.conv(A).messages.length === 5);

  // 4. bob loses history, restores from alice
  bob.store.wipeConversation(A);
  ok('bob wiped', bob.store.conv(A).messages.length === 0);
  let restored = 0; bob.on('history', ({ added }) => { restored += added; });
  bob.requestHistory(A);
  ok('history restored from peer', await waitFor(() => bob.store.conv(A).messages.length === 5, 5000, 'restore'));
  const rb = bob.store.conv(A).messages;
  ok('restored directions are mirrored correctly', rb.filter(m => m.from === 'peer').length === 4 && rb.filter(m => m.from === 'me').length === 1 && rb.find(m => m.from === 'me').kind === 'code');
  ok('restore is idempotent', (bob.requestHistory(A), await sleep(500), bob.store.conv(A).messages.length === 5));

  // 5. simultaneous dial -> exactly one live connection each
  const ac = alice.peers.get(B).conn, bc = bob.peers.get(A).conn;
  ac.close();
  ok('both drop', await waitFor(() => alice.status(B) !== 'online' && bob.status(A) !== 'online', 5000, 'drop'));
  ok('both come back with one connection each', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online' && alice.peers.size === 1 && bob.peers.size === 1, 12000, 'recover'));
  alice.sendMessage(B, { kind: 'text', text: 'after recovery' });
  ok('traffic flows on the surviving connection', await waitFor(() => bob.store.conv(A).messages.some(m => m.text === 'after recovery'), 3000, 'post-recovery'));

  // 6. unknown stranger with no token is refused
  const stranger = await boot('alice2' in KEYS ? 'alice2' : (KEYS.alice2 = crypto.randomBytes(32), 'alice2'));
  const fakeInvite = require('../core/crypto.js').makeInvite({ host: '127.0.0.1', port: alice.transport.port, pub: alice.me.pub, name: 'Alice', token: 'x'.repeat(16) });
  stranger.addContact(fakeInvite);
  await sleep(2500);
  ok('stranger with forged token never gets online', stranger.status(A) !== 'online' && !alice.store.contact(stranger.me.pub));
  stranger.stop();

  // --- review fixes ---
  const kc = require('../core/crypto.js');
  const net = require('node:net');

  // R1: prototype-name token must not open the gate
  const mallory = await boot('mallory' in KEYS ? 'mallory' : (KEYS.mallory = crypto.randomBytes(32), 'mallory'));
  mallory.store.upsertContact(A, { name: 'Alice', host: '127.0.0.1', port: alice.transport.port, token: 'constructor' });
  await sleep(2500);
  ok('R1 token "constructor" does not make a stranger a contact', mallory.status(A) !== 'online' && !alice.store.contact(mallory.me.pub));
  mallory.stop();

  // R2: forged hs1 claiming bob's static must not touch bob's contact record or live session
  const bobPortBefore = alice.store.contact(B).port, bobNameBefore = alice.store.contact(B).name;
  const forged = { frame: (() => {
    const { dh, hkdf, aeadSeal, nonce12, ZERO } = kc._internals;
    const e = kc.newKeypair(), eve = kc.newKeypair();
    const es = dh(e.priv, e.pub, alice.me.pub);
    const c1 = aeadSeal(hkdf(es, ZERO, 'hs1a', 32), nonce12(0), e.pub, bob.me.pub);          // claims to be bob
    const ssWrong = dh(eve.priv, eve.pub, alice.me.pub);                                       // but cannot derive ss
    const c2 = aeadSeal(hkdf(Buffer.concat([es, ssWrong]), ZERO, 'hs1b', 32), nonce12(1), c1, Buffer.from(JSON.stringify({ token: '', name: 'EVIL', port: 1 })));
    return { t: 'hs1', e: e.pub.toString('base64url'), c1: c1.toString('base64'), c2: c2.toString('base64') };
  })() };
  await new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: alice.transport.port }, () => {
      const body = Buffer.from(JSON.stringify(forged.frame)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
      sock.write(Buffer.concat([head, body]));
    });
    sock.on('close', resolve); sock.on('error', resolve); setTimeout(() => { sock.destroy(); resolve(); }, 2500);
  });
  ok('R2 forged hs1 with a claimed static is rejected and bob\'s record untouched', alice.store.contact(B).port === bobPortBefore && alice.store.contact(B).name === bobNameBefore && alice.status(B) === 'online');

  // R2b: replayed genuine hs1 gets no further than hs2 (no commit without key confirmation)
  await new Promise((resolve) => {
    const h = kc.initiate(bob.me, alice.me.pub, '', { name: 'Bob', port: 9 });
    const sock = net.createConnection({ host: '127.0.0.1', port: alice.transport.port }, () => {
      const body = Buffer.from(JSON.stringify(h.frame)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
      sock.write(Buffer.concat([head, body]));
    });
    setTimeout(() => { sock.destroy(); resolve(); }, 1500);
  });
  ok('R2b hs1 without a confirming frame changes nothing', alice.store.contact(B).port === bobPortBefore && alice.status(B) === 'online' && alice.peers.size === 1);

  // R3: unsolicited hist is ignored; solicited hist with junk records is sanitized
  const pb = bob.peers.get(A);
  const before = alice.store.conv(B).messages.length, mySeqBefore = alice.store.conv(B).mySeq;
  pb.conn.send(kc.seal(pb.session, { k: 'hist', i: 0, n: 1, messages: [{ from: 'peer', seq: 2 ** 53, ts: Date.now() - 86400000, kind: 'text', text: 'I agree to pay 5000' }] }));
  await sleep(600);
  ok('R3 unsolicited hist frame is dropped', alice.store.conv(B).messages.length === before && alice.store.conv(B).mySeq === mySeqBefore && !alice.store.conv(B).messages.some(m => /agree to pay/.test(m.text)));
  ok('R3 bob and alice still connected after junk', alice.status(B) === 'online');

  // R4: junk bytes before the handshake must not crash the process
  let crashed = false; const onUncaught = () => { crashed = true; }; process.on('uncaughtException', onUncaught);
  for (const payload of [Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{{{')])]) {
    await new Promise((resolve) => { const sock = net.createConnection({ host: '127.0.0.1', port: alice.transport.port }, () => sock.write(payload)); sock.on('close', resolve); sock.on('error', resolve); setTimeout(() => { sock.destroy(); resolve(); }, 800); });
  }
  await sleep(300); process.off('uncaughtException', onUncaught);
  ok('R4 junk bytes pre-handshake do not crash the main process', !crashed && alice.status(B) === 'online');

  // R5: remove + re-add continues the sequence above what the peer holds
  alice.removeContact(B);
  await waitFor(() => bob.status(A) !== 'online', 5000, 'bob sees drop');
  alice.addContact(bob.invite());
  ok('R5 reconnected after re-add', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 10000, 're-add'));
  await sleep(500);
  const bobCountBefore = bob.store.conv(A).messages.length;
  alice.sendMessage(B, { kind: 'text', text: 'hi again after re-add' });
  ok('R5 new message after re-add is stored by the peer, not dropped as a duplicate seq', await waitFor(() => bob.store.conv(A).messages.some(m => m.text === 'hi again after re-add'), 3000, 're-add msg') && bob.store.conv(A).messages.length === bobCountBefore + 1);
  ok('R5 and shown delivered only because it really was', await waitFor(() => alice.store.conv(B).messages.find(m => m.text === 'hi again after re-add')?.status === 'delivered', 3000, 're-add ack'));

  // R6: oversized message is refused up front and does not start a reconnect loop
  let threw = ''; try { alice.sendMessage(B, { kind: 'text', text: 'é'.repeat(40000) }); } catch (e) { threw = e.message; }
  await sleep(1500);
  ok('R6 70 KB message refused with a clear error, connection intact', /too long/.test(threw) && alice.status(B) === 'online');

  // R7: issued invites expire and are capped
  for (let i = 0; i < 60; i++) alice.invite();
  ok('R7 invite table capped', Object.keys(alice.store.data.invites).length <= 50);

  // 8. image messages (screenshots): the record travels as a message, the bytes are pulled in parts
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300 * 1024)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(150 * 1024)]);
  const im = alice.sendImage(B, { mime: 'image/png', data: png, w: 1920, h: 1080 });
  ok('I1 image record holds metadata only; bytes are in a sealed file, not the vault', im.kind === 'image' && im.bytes === png.length && im.w === 1920 && im.text === '' && !('data' in im) && alice.store.blob(B, im.id).equals(png) && JSON.stringify(alice.store.data).length < 60000);
  ok('I1 bob receives the record, then the bytes, intact', await waitFor(() => bob.store.conv(A).messages.some((m) => m.id === im.id && m.kind === 'image' && m.w === 1920 && m.h === 1080) && !!bob.store.blob(A, im.id) && bob.store.blob(A, im.id).equals(png), 8000, 'image'));
  ok('I1 bob\'s file on disk is sealed (header + no payload in the clear)', (() => { const f = fs.readFileSync(`${DIR}/bob-blobs/${A}/${im.id}`); return f.subarray(0, 5).toString() === 'P2PB1' && !f.includes(png.subarray(8, 40)); })());
  ok('I1 alice sees it delivered', await waitFor(() => alice.store.conv(B).messages.find((m) => m.id === im.id)?.status === 'delivered', 3000, 'image ack'));
  ok('I1 oversized and wrong-type images are refused up front', (() => { let a = '', b = '', c = ''; try { alice.sendImage(B, { mime: 'image/png', data: Buffer.alloc(9 * 1024 * 1024), w: 1, h: 1 }); } catch (e) { a = e.message; } try { alice.sendImage(B, { mime: 'image/gif', data: png, w: 1, h: 1 }); } catch (e) { b = e.message; } try { alice.sendImage(B, { mime: 'image/png', data: jpg, w: 1, h: 1 }); } catch (e) { c = e.message; } return /too large/.test(a) && /unsupported/.test(b) && /unsupported/.test(c); })());
  const { sanitizeMsg } = require('../core/store.js');
  ok('I1 wire records with bogus image metadata are dropped', sanitizeMsg({ seq: 1, text: '', kind: 'image', mime: 'image/png', w: 0, h: 5, bytes: 10 }) === null && sanitizeMsg({ seq: 1, text: '', kind: 'image', mime: 'image/png', w: 5, h: 5, bytes: 9 * 1024 * 1024 }) === null && sanitizeMsg({ seq: 1, text: '', kind: 'image', mime: 'text/html', w: 5, h: 5, bytes: 10 }) === null && sanitizeMsg({ seq: 1, text: 'x', kind: 'image', mime: 'image/jpeg', w: 5, h: 5, bytes: 10 })?.text === '');

  // I2: a blob frame nobody asked for is ignored
  const pa = alice.peers.get(B);
  pa.conn.send(kc.seal(pa.session, { k: 'blob', id: 'unasked000000000', i: 0, n: 1, d: jpg.subarray(0, 10 * 1024).toString('base64') }));
  await sleep(400);
  ok('I2 unsolicited blob frame is ignored and the session survives', !bob.store.hasBlob(A, 'unasked000000000') && bob.status(A) === 'online');

  // I3: sent while the peer is offline: the record queues like any message, the bytes follow on reconnect
  bob.stop();
  ok('I3 bob offline', await waitFor(() => alice.status(B) === 'offline', 6000, 'offline for image'));
  const im2 = alice.sendImage(B, { mime: 'image/jpeg', data: jpg, w: 1280, h: 720 });
  bob = await boot('bob');
  ok('I3 queued image arrives with its bytes after reconnect', await waitFor(() => !!bob.store.blob(A, im2.id) && bob.store.blob(A, im2.id).equals(jpg), 12000, 'queued image'));

  // I4: restore from peer: records come through hist, bytes are pulled afterwards
  bob.store.wipeConversation(A);
  ok('I4 wipe also removes the image files', !fs.existsSync(`${DIR}/bob-blobs/${A}`));
  bob.requestHistory(A);
  ok('I4 restored conversation has both images with bytes', await waitFor(() => !!bob.store.blob(A, im.id) && bob.store.blob(A, im.id).equals(png) && !!bob.store.blob(A, im2.id) && bob.store.blob(A, im2.id).equals(jpg), 12000, 'restore images'));

  // I5: a burst of asks is answered with one part in flight, paced: the sender's write buffer stays bounded, the session survives
  const pbF = bob.peers.get(A), wroteBefore = alice.peers.get(B).conn.sock.bytesWritten;
  for (let k = 0; k < 100; k++) pbF.conn.send(kc.seal(pbF.session, { k: 'breq', id: im.id, i: 0 }));
  await sleep(1200);
  const flood = alice.peers.get(B) ? alice.peers.get(B).conn.sock.bytesWritten - wroteBefore : -1;
  ok(`I5 100 asks for one part in a burst cost the sender one part on the wire (${Math.round(flood / 1024)} KB), session intact`, flood > 100 * 1024 && flood < 1024 * 1024 && alice.status(B) === 'online' && bob.status(A) === 'online');

  // I6: more than one scan's worth of missing images (scan = 50 newest) all arrive, live and after a restore
  for (let k = 0; k < 60; k++) alice.sendImage(B, { kind: 'image', mime: 'image/png', data: Buffer.concat([png.subarray(0, 8), crypto.randomBytes(512)]), w: 8, h: 8 });
  ok('I6 60 small images delivered live with their bytes', await waitFor(() => bob.store.conv(A).messages.filter((m) => m.kind === 'image').length === 62 && bob.store.missingBlobs(A, 1000).length === 0, 20000, '60 live images'));
  bob.store.wipeConversation(A);
  bob.requestHistory(A);
  ok('I6 restore pulls all 62 images, not only the newest 50', await waitFor(() => bob.store.conv(A).messages.filter((m) => m.kind === 'image').length === 62 && bob.store.missingBlobs(A, 1000).length === 0, 25000, 'restore 62'));
  ok('I6 image bytes are counted per contact', bob.store.blobBytes(A) > 450 * 1024 && bob.store.blobBytes(A) < 600 * 1024);

  // I7: past the per-contact quota nothing is pulled on its own; a user fetch still works
  bob.stop(); await waitFor(() => alice.status(B) === 'offline', 6000, 'bob off for quota');
  bob = await boot('bob', { blobQuota: 64 * 1024 });   // bob already holds far more than this for alice
  ok('I7 reconnected with a tiny quota', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 10000, 'reconnect quota'));
  const im3 = alice.sendImage(B, { mime: 'image/jpeg', data: jpg, w: 1280, h: 720 });
  await waitFor(() => bob.store.conv(A).messages.some((m) => m.id === im3.id), 5000, 'im3 record');
  await sleep(600);
  ok('I7 the record arrives but the bytes are not pulled (status quota)', bob.store.conv(A).messages.some((m) => m.id === im3.id) && !bob.store.hasBlob(A, im3.id) && bob.imageStatus(A, im3.id) === 'quota');
  bob.fetchImage(A, im3.id);
  ok('I7 fetchImage pulls it on request', await waitFor(() => !!bob.store.blob(A, im3.id) && bob.store.blob(A, im3.id).equals(jpg), 8000, 'forced fetch'));

  // I8: a damaged blob file reads as missing and is pulled again
  const im2File = `${DIR}/bob-blobs/${A}/${im2.id}`;
  fs.writeFileSync(im2File, Buffer.from('P2PB1 garbage garbage garbage garbage'));
  ok('I8 a file that does not open is dropped on read', bob.store.blob(A, im2.id) === null && !fs.existsSync(im2File) && !bob.store.hasBlob(A, im2.id));
  fs.writeFileSync(im2File, Buffer.alloc(0));
  ok('I8 a zero-length file reads as missing', !bob.store.hasBlob(A, im2.id) && bob.store.missingBlobs(A, 100).includes(im2.id));
  bob.fetchImage(A, im2.id);
  ok('I8 re-pulled on request', await waitFor(() => !!bob.store.blob(A, im2.id) && bob.store.blob(A, im2.id).equals(jpg), 8000, 're-pull'));

  // I9: when the bytes cannot be written, no record is created (no placeholder-forever on either side)
  const bobDirA = `${DIR}/bob-blobs/${A}`;
  fs.chmodSync(bobDirA, 0o500);
  const countBefore = bob.store.conv(A).messages.length;
  let ghost = ''; try { bob.sendImage(A, { mime: 'image/jpeg', data: jpg, w: 1, h: 1 }); } catch (e) { ghost = e.message; }
  fs.chmodSync(bobDirA, 0o700);
  ok('I9 sendImage fails cleanly when the blob cannot be written: no record added', /EACCES|EPERM|permission/i.test(ghost) && bob.store.conv(A).messages.length === countBefore);

  // I10: restore-from-peer with non-ASCII history: chunks are sized in bytes, so no frame exceeds the cap
  for (let k = 0; k < 6; k++) alice.sendMessage(B, { kind: 'text', text: 'Ж'.repeat(20000) + k });
  ok('I10 six 40 KB Cyrillic messages delivered live', await waitFor(() => bob.store.conv(A).messages.filter((m) => m.text.startsWith('ЖЖЖ')).length === 6, 8000, 'cyrillic live'));
  bob.store.wipeConversation(A);
  bob.requestHistory(A);
  ok('I10 restore carries them in byte-sized chunks, connection intact', await waitFor(() => bob.store.conv(A).messages.filter((m) => m.text.startsWith('ЖЖЖ')).length === 6, 10000, 'cyrillic restore') && alice.status(B) === 'online');

  // S1: screen-share signaling frames: live only, shape-checked, never stored
  const { sanitizeShare } = require('../core/engine.js');
  const gotShare = []; bob.on('share', (f) => gotShare.push(f));
  alice.sendShare(B, { op: 'sdp', sid: 'abc', description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' } });
  alice.sendShare(B, { op: 'ice', sid: 'abc', candidate: { candidate: 'candidate:1 1 udp 2 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' } });
  alice.sendShare(B, { op: 'ice', sid: 'abc', candidate: null });
  alice.sendShare(B, { op: 'state', sid: 'abc', screen: true, mic: 'yes', mode: 'two', rec: 1, junk: 1 });
  ok('S1 share frames arrive in order with only the known fields', await waitFor(() => gotShare.length === 4, 3000, 'share frames') && gotShare[0].op === 'sdp' && gotShare[0].description.type === 'offer' && gotShare[0].pub === A && gotShare[1].candidate.sdpMLineIndex === 0 && gotShare[2].candidate === null && gotShare[3].screen === true && gotShare[3].mic === true && gotShare[3].mode === 'two' && gotShare[3].rec === true && !('junk' in gotShare[3]));
  ok('S1 nothing of it was stored', !bob.store.conv(A).messages.some((m) => m.kind === 'share' || /candidate:/.test(m.text)) && !JSON.stringify(bob.store.data).includes('candidate:1'));
  let shareErr = ''; try { alice.sendShare(B, { op: 'nope', sid: 'abc' }); } catch (e) { shareErr = e.message; }
  ok('S1 unknown op refused locally; oversized sdp and bad candidate dropped', /bad share/.test(shareErr) && sanitizeShare({ op: 'sdp', sid: 'x', description: { type: 'offer', sdp: 'x'.repeat(100001) } }) === null && sanitizeShare({ op: 'ice', sid: 'x', candidate: 'str' }) === null && sanitizeShare({ op: 'bye', sid: 'x'.repeat(33) }) === null);
  ok('S1 the protocol version v is kept when it is an integer from 1 to 99 and left out otherwise', sanitizeShare({ op: 'state', sid: 'x', screen: true, v: 2 }).v === 2 && [0, 100, '2'].every((v) => { const f = sanitizeShare({ op: 'state', sid: 'x', screen: true, v }); return f !== null && !('v' in f); }));
  const pbS = bob.peers.get(A); const beforeJunk = gotShare.length;
  pbS.conn.send(kc.seal(pbS.session, { k: 'share', op: 'sdp', sid: 'zzz', description: { type: 'offer' } }));
  await sleep(300);
  ok('S1 a malformed share frame from the wire is ignored, session intact', gotShare.length === beforeJunk && bob.status(A) === 'online' && alice.status(A === B ? A : B) === 'online');
  bob.stop(); await waitFor(() => alice.status(B) === 'offline', 6000, 'bob off for share');
  let offErr = ''; try { alice.sendShare(B, { op: 'bye', sid: 'abc' }); } catch (e) { offErr = e.message; }
  ok('S1 sending to an offline peer fails at once (no queueing of live frames)', /offline/.test(offErr));
  bob = await boot('bob', { blobQuota: 64 * 1024 });
  ok('S1 reconnected', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 10000, 'reconnect after share'));

  // 7. vault is encrypted on disk
  const raw = fs.readFileSync(`${DIR}/alice.vault`);
  ok('vault bytes contain no plaintext', !raw.includes('hello bob') && !raw.includes('console.log') && raw.subarray(0,5).toString() === 'P2PV2');
  ok('vault key material is not in the vault file in the clear', !raw.includes(alice.me.priv.toString('base64url')));

  alice.stop(); bob.stop();
  await sleep(300);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL  harness threw:', e.stack); process.exit(1); });
