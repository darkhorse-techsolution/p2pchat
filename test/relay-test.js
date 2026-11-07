// Relay server + two clients, headless. Run under Electron's runtime via test/run.sh.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const kc = require('../core/crypto.js');
const link = require('../core/relaylink.js');
const { RelayTransport } = require('../core/relay.js');

const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000, label = '') => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(40); } console.log('      (timeout:', label, ')'); return false; };
const once = (em, ev, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); em.once(ev, (v) => { clearTimeout(t); res(v); }); });

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2prelay-'));
  const PORT = 20000 + Math.floor(Math.random() * 30000);
  const relayExe = process.versions.electron ? process.execPath : process.execPath;
  const relay = spawn(relayExe, [path.join(__dirname, '..', 'relay', 'server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--data', dataDir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; relay.stdout.on('data', (d) => { out += d; }); relay.stderr.on('data', (d) => { out += d; });
  ok('relay prints its address', await waitFor(() => /relay:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}/.test(out), 5000, 'relay start'));
  const address = (out.match(/relay:\/\/\S+/) || [''])[0];
  ok('address file written', fs.existsSync(path.join(dataDir, 'relay-address.txt')));

  // two clients
  const A = new RelayTransport(address), B = new RelayTransport(address);
  const errs = []; A.on('error', (e) => errs.push('A:' + e.message)); B.on('error', (e) => errs.push('B:' + e.message));
  A.start(); B.start();
  ok('both links come up', await waitFor(() => A.up && B.up, 5000, 'links up'));

  // B binds an address; A dials it
  const bAddr = link.newAddress();
  B.bind(bAddr);
  ok('bind acknowledged', await once(B, 'bound').then((a) => a === bAddr.pub).catch(() => false));
  const incoming = once(B, 'conn');
  const ca = await A.dial(bAddr.pub);
  const cb = await incoming;
  ok('channel opened both ends with directions', ca.direction === 'out' && cb.direction === 'in' && ca.ch === cb.ch);

  // frames flow both ways, in order, through setHandler/queue
  const gotB = [], gotA = [];
  cb.setHandler((f) => gotB.push(f)); ca.setHandler((f) => gotA.push(f));
  for (let i = 0; i < 20; i++) ca.send({ t: 'x', i });
  cb.send({ t: 'y', hello: 'from b' });
  ok('20 frames A->B in order', await waitFor(() => gotB.length === 20 && gotB.every((f, i) => f.i === i), 3000, 'a->b'));
  ok('frame B->A', await waitFor(() => gotA.length === 1 && gotA[0].hello === 'from b', 3000, 'b->a'));

  // frames queued before a handler is attached are not lost
  const incoming2 = once(B, 'conn');
  const ca2 = await A.dial(bAddr.pub); const cb2 = await incoming2;
  ca2.send({ t: 'early', n: 1 }); ca2.send({ t: 'early', n: 2 });
  await sleep(300);
  const early = []; cb2.setHandler((f) => early.push(f));
  ok('frames before setHandler are queued, not dropped', early.length === 2 && early[1].n === 2);

  // close propagates
  const closedB = once(cb2, 'close');
  ca2.close();
  ok('close reaches the other end', await closedB.then(() => true).catch(() => false));

  // unreachable address
  let unreachable = '';
  try { await A.dial(link.newAddress().pub, 2000); } catch (e) { unreachable = e.message; }
  ok('dialing an unbound address fails fast with a clear reason', /not connected/.test(unreachable));

  // bind proof: a forged signature is rejected; address stays with the owner
  // eve signs nonce||bAddr.pub with HER key and presents it for bAddr (a mismatched JWK cannot even be built, so sign directly)
  const eveKp = require('node:crypto').generateKeyPairSync('ed25519');
  const forgedSig = require('node:crypto').sign(null, Buffer.concat([A.nonce, Buffer.from(bAddr.pub, 'base64url')]), eveKp.privateKey).toString('base64url');
  let bindErr = '';
  const onErr = (e) => { bindErr = e.message; }; A.on('error', onErr);
  A.sendCtl({ k: 'bind', addr: bAddr.pub, sig: forgedSig });
  await sleep(300); A.off('error', onErr);
  ok('forged bind proof rejected', /bad proof/.test(bindErr));
  const incoming3 = once(B, 'conn');
  const ca3 = await A.dial(bAddr.pub); await incoming3; ca3.close();
  ok('address still routes to its real owner', true);

  // a client that does not know the relay key cannot complete the link
  const bogus = new RelayTransport(link.formatRelayAddress({ host: '127.0.0.1', port: PORT, pub: kc.newKeypair().pub }));
  let bogusErr = ''; bogus.on('error', (e) => { bogusErr = e.message; });
  bogus.start(); await sleep(1500);
  ok('wrong relay key never comes up', !bogus.up);
  bogus.stop();

  // junk to the relay port must not kill the relay
  await new Promise((res) => { const s = net.createConnection({ host: '127.0.0.1', port: PORT }, () => s.write(Buffer.from([0xff, 0xff, 0xff, 0xff]))); s.on('close', res); s.on('error', res); setTimeout(() => { s.destroy(); res(); }, 800); });
  await new Promise((res) => { const s = net.createConnection({ host: '127.0.0.1', port: PORT }, () => { const b = Buffer.from('{"t":"lk1","e":"zz"}'); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); s.write(Buffer.concat([h, b])); }); s.on('close', res); s.on('error', res); setTimeout(() => { s.destroy(); res(); }, 800); });
  ok('relay survives junk and bad handshakes', relay.exitCode === null && A.up && B.up);

  // relay link loss: conns close, link reconnects, binds restored, dial works again
  const closedA = once(ca, 'close');
  B.sock.destroy();
  ok('link loss closes channels', await closedA.then(() => true).catch(() => false));
  ok('B reconnects and rebinds', await waitFor(() => B.up, 8000, 'reconnect') && await once(B, 'bound', 8000).then(() => true).catch(() => B.up));
  const incoming4 = once(B, 'conn', 8000);
  const ca4 = await A.dial(bAddr.pub, 8000); await incoming4;
  ok('dial works after reconnect', !!ca4 && !ca4.closed);

  // relay never sees plaintext: capture raw bytes on the wire for a known payload
  const sniffPort = PORT + 1;
  const captured = [];
  const sniffer = net.createServer((c) => { const up = net.createConnection({ host: '127.0.0.1', port: PORT }); c.on('data', (d) => { captured.push(d); up.write(d); }); up.on('data', (d) => { captured.push(d); c.write(d); }); c.on('close', () => up.destroy()); up.on('close', () => c.destroy()); c.on('error', () => {}); up.on('error', () => {}); });
  await new Promise((r) => sniffer.listen(sniffPort, '127.0.0.1', r));
  const S = new RelayTransport(link.formatRelayAddress({ host: '127.0.0.1', port: sniffPort, pub: link.parseRelayAddress(address).pub }));
  S.start(); await waitFor(() => S.up, 5000, 'sniffed link');
  const sAddr = link.newAddress(); S.bind(sAddr); await once(S, 'bound');
  const inc5 = once(S, 'conn'); const ca5 = await A.dial(sAddr.pub); const cb5 = await inc5;
  ca5.send({ t: 'enc', n: 0, c: 'SECRET-MARKER-' + 'q'.repeat(40) });
  await sleep(400);
  const wire = Buffer.concat(captured).toString('latin1');
  ok('wire bytes contain no control-message names or payload', !wire.includes('SECRET-MARKER') && !wire.includes('"k":"bind"') && !wire.includes('"k":"data"') && !wire.includes(sAddr.pub));
  cb5.close(); S.stop(); sniffer.close();

  ok('no unexpected client errors', errs.filter((e) => !/bad proof|relay link/.test(e)).length === 0);
  if (errs.length) console.log('      errors:', errs);

  A.stop(); B.stop(); relay.kill('SIGTERM');
  await sleep(200); fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL  harness threw:', e.stack); process.exit(1); });
