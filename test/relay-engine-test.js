// Two engines that cannot reach each other on the LAN talk through a local relay.
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto');
const { Store } = require('../core/store.js'); const { Transport } = require('../core/transport.js'); const { Engine } = require('../core/engine.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000, label = '') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } console.log('      (timeout:', label, ')'); return false; };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p2prelay-eng-'));
const KEYS = { alice: crypto.randomBytes(32), bob: crypto.randomBytes(32) };
async function boot(who) {
  const store = new Store(`${DIR}/${who}.vault`, KEYS[who]).load();
  if (!store.identity().name) store.setName(who[0].toUpperCase() + who.slice(1));
  const e = new Engine(store, new Transport());
  e.on('error', (x) => console.log(`      [${who} error] ${x.message}`));
  await e.start(); return e;
}
function startRelay(port) {
  const r = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'server.js'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(DIR, 'relay')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; r.stdout.on('data', (d) => { out += d; }); r.stderr.on('data', (d) => { out += d; });
  r.address = async () => { await waitFor(() => /relay:\/\/\S+/.test(out), 5000, 'relay'); return (out.match(/relay:\/\/\S+/) || [''])[0]; };
  return r;
}
(async () => {
  const PORT = 20000 + Math.floor(Math.random() * 30000);
  let relay = startRelay(PORT);
  const RELAY = await relay.address();
  ok('relay up', RELAY.startsWith('relay://'));

  const alice = await boot('alice'), bob = await boot('bob');
  const A = alice.me.pub.toString('base64url'), B = bob.me.pub.toString('base64url');
  alice.setRelay(RELAY);
  ok('alice relay link comes up', await waitFor(() => alice.relayStatus() === 'up', 5000, 'alice relay'));

  // invite carries relay + intro address; strip the LAN part to force the relay path
  const invRaw = alice.invite();
  const kc = require('../core/crypto.js');
  const parsed = kc.parseInvite(invRaw);
  ok('invite carries the relay and a one-time intro address', parsed.relay === RELAY && parsed.addr.length === 43);
  const relayOnly = kc.makeInvite({ host: '', port: 0, pub: parsed.pub, name: parsed.name, token: parsed.token, relay: parsed.relay, addr: parsed.addr });
  ok('bob has no relay yet', bob.relayStatus() === 'off');
  bob.addContact(relayOnly);
  ok('bob adopted the relay from the invite', await waitFor(() => bob.relayStatus() === 'up', 5000, 'bob relay'));
  ok('bob has no LAN route to alice', !bob.store.contact(A).host);
  ok('both online through the relay', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 8000, 'online via relay'));
  ok('connection is a relay channel, not TCP', alice.peers.get(B).conn.remote.host === 'relay' && bob.peers.get(A).conn.remote.host === 'relay');

  // dedicated per-contact addresses exchanged; intro address consumed and unbound
  ok('dedicated addresses exchanged inside the channel', await waitFor(() => bob.store.contact(A).theirAddr && bob.store.contact(A).theirAddr !== parsed.addr && alice.store.contact(B).theirAddr, 4000, 'addr exchange'));
  ok('intro address no longer bound on alice', !alice.relay.addresses.has(parsed.addr) && Object.keys(alice.store.data.invites).length === 0);
  ok('alice recorded no LAN address for bob (relay inbound must not write host=relay)', !alice.store.contact(B).host || alice.store.contact(B).host !== 'relay');

  // messages both ways
  const gotB = []; bob.on('message', ({ msg }) => { if (msg.from === 'peer') gotB.push(msg.text); });
  alice.sendMessage(B, { kind: 'text', text: 'over the relay' });
  ok('a->b via relay', await waitFor(() => gotB.includes('over the relay'), 3000, 'a->b'));
  const gotA = []; alice.on('message', ({ msg }) => { if (msg.from === 'peer') gotA.push(msg.text); });
  bob.sendMessage(A, { kind: 'code', text: 'print(1)', lang: 'py' });
  ok('b->a via relay', await waitFor(() => gotA.includes('print(1)'), 3000, 'b->a'));
  ok('delivered ticks', await waitFor(() => alice.store.conv(B).messages.find(m => m.text === 'over the relay').status === 'delivered', 3000, 'ack'));

  // an image through the relay: the record is a msg, the bytes are pulled in 96 KB parts, every frame under the relay's cap
  const shot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(700 * 1024)]);
  const im = alice.sendImage(B, { mime: 'image/jpeg', data: shot, w: 2560, h: 1600 });
  ok('700 KB image via relay: record, then 8 parts, bytes intact', await waitFor(() => !!bob.store.blob(A, im.id) && bob.store.blob(A, im.id).equals(shot), 10000, 'image via relay'));

  // reconnect through the DEDICATED address after a drop (intro is gone)
  bob.peers.get(A).conn.close();
  ok('drop seen', await waitFor(() => bob.status(A) !== 'online', 4000, 'drop'));
  ok('reconnect via dedicated relay addresses', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 10000, 'reconnect'));
  ok('exactly one connection each', alice.peers.size === 1 && bob.peers.size === 1);

  // relay dies: both offline; relay returns on the same key: both back
  relay.kill('SIGTERM'); await sleep(300);
  ok('relay loss -> peers offline', await waitFor(() => alice.status(B) !== 'online' && bob.status(A) !== 'online', 5000, 'relay loss'));
  ok('relay status reflects it', alice.relayStatus() === 'connecting');
  alice.sendMessage(B, { kind: 'text', text: 'sent while relay was down' });
  relay = startRelay(PORT); await relay.address();
  alice.kick(); bob.kick();
  ok('relay back (same identity) -> links and peers recover', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 15000, 'recover'));
  ok('queued message delivered after recovery', await waitFor(() => gotB.includes('sent while relay was down'), 5000, 'catch-up'));

  // LAN first: give bob alice's real LAN address; next connection should be direct TCP
  bob.store.upsertContact(A, { host: '127.0.0.1', port: alice.transport.port });
  bob.peers.get(A).conn.close();
  await waitFor(() => bob.status(A) !== 'online', 4000, 'drop2');
  ok('reconnects', await waitFor(() => alice.status(B) === 'online' && bob.status(A) === 'online', 10000, 'reconnect2'));
  // the relay channel may come up first; the direct one wins the tie-break once it completes
  const viaTcp = await waitFor(() => (bob.peers.get(A)?.conn.remote.host !== 'relay') && (alice.peers.get(B)?.conn.remote.host !== 'relay'), 8000, 'direct wins');
  ok('LAN route preferred when it exists (both sides settle on direct)', viaTcp);

  // setRelay('') turns it off cleanly
  alice.setRelay('');
  ok('relay off', alice.relayStatus() === 'off' && alice.relay === null);
  let bad = ''; try { alice.setRelay('relay://nope'); } catch (e) { bad = e.message; }
  ok('bad relay address rejected', /relay address/.test(bad));

  alice.stop(); bob.stop(); relay.kill('SIGTERM'); await sleep(200);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL  harness threw:', e.stack); process.exit(1); });
