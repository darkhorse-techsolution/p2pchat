// The assistant bridge (main/bridge.js): who a name means, the token and file modes, the four methods over a real
// local socket, waiting for a message, the limits, and turning it off. No window, no engine: a fake api.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { createBridge, resolve, msgOut, sockPathFor } = require('../main/bridge.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) return false; await sleep(10); } return true; };

const FRED = 'fOIEbc-Daaaa1111', PC = 'bUcOv4CKbbbb2222', TWO = 'bUcOv4ZZcccc3333';

// B1: who "Fred" is
{
  const cs = [{ pub: FRED, name: 'Fred Kaasik' }, { pub: PC, name: 'Windows PC' }, { pub: TWO, name: 'fred two' }];
  ok('B1 the exact id', resolve(cs, PC).name === 'Windows PC');
  ok('B1 an id prefix of 6 or more characters', resolve(cs, 'fOIEbc').name === 'Fred Kaasik');
  ok('B1 an id prefix that fits two: refused with both', throws(() => resolve(cs, 'bUcOv4'), /starts the id of 2 contacts: Windows PC \(id bUcOv4CK\), fred two \(id bUcOv4ZZ\)/));
  ok('B1 a prefix under 6 characters is not taken as an id', throws(() => resolve(cs, 'bUcO'), /no contact matches "bUcO"/));
  ok('B1 the exact name, any case', resolve(cs, 'windows pc').pub === PC);
  ok('B1 the exact name wins over a name that contains it', resolve(cs, 'FRED TWO').pub === TWO);
  ok('B1 the one name that contains it', resolve(cs, 'kaasik').pub === FRED);
  ok('B1 two names contain it: refused, never guessed', throws(() => resolve(cs, 'fred'), /"fred" matches 2 contacts/));
  ok('B1 nothing given', throws(() => resolve(cs, '  '), /say which contact/));
  ok('B1 no match', throws(() => resolve(cs, 'zzz'), /no contact matches "zzz"/));
}

// B2: what a message looks like to the assistant
{
  ok('B2 an image is a line, never its bytes', msgOut({ id: 'a', from: 'peer', ts: 1, kind: 'image', w: 1920, h: 1080, bytes: 5, status: 'delivered' }).text === '[image 1920x1080]');
  const c = msgOut({ id: 'b', from: 'me', ts: 2, kind: 'code', text: 'x()', lang: 'js', status: 'pending' });
  ok('B2 code keeps its language; "me" stays me', c.lang === 'js' && c.from === 'me' && c.text === 'x()');
  const cp = msgOut({ id: 'c', from: 'peer', ts: 3, kind: 'caption', text: 'So the first slide is the roadmap.', lang: '', status: 'delivered' });
  ok('B2 a caption keeps its kind and its text', cp.kind === 'caption' && cp.text === 'So the first slide is the roadmap.' && cp.from === 'them' && cp.lang === undefined);
  ok('B2 a contact\'s message is from "them"', msgOut({ from: 'peer', kind: 'text', text: 'hi' }).from === 'them');
}

// B3: where the socket goes
{
  ok('B3 Windows: a named pipe', /^\\\\\.\\pipe\\p2pchat-bridge-[0-9a-f]{16}$/.test(sockPathFor('C:\\Users\\x\\AppData\\Roaming\\P2P Chat', 'win32')));
  ok('B3 macOS/Linux: bridge.sock in the data folder', sockPathFor('/Users/x/Library/Application Support/P2P Chat', 'darwin') === '/Users/x/Library/Application Support/P2P Chat/bridge.sock');
  const long = '/' + 'd'.repeat(120);
  ok('B3 a data folder too long for a socket path: the temp folder', sockPathFor(long, 'darwin').startsWith(os.tmpdir()) && Buffer.byteLength(sockPathFor(long, 'darwin')) <= 104);
}

function client(p) {
  const s = net.createConnection(p); s.setEncoding('utf8'); s.on('error', () => {});
  let buf = '', n = 0; const byId = new Map(), loose = [], wantLoose = [];
  s.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id != null && byId.has(m.id)) { byId.get(m.id)(m); byId.delete(m.id); } else if (wantLoose.length) wantLoose.shift()(m); else loose.push(m);
    }
  });
  return { sock: s, closed: new Promise((r) => s.on('close', r)), write: (o) => s.write(typeof o === 'string' ? o : JSON.stringify(o) + '\n'),
    loose: () => new Promise((r) => (loose.length ? r(loose.shift()) : wantLoose.push(r))),
    req: (method, params) => new Promise((r) => { const id = ++n; byId.set(id, r); s.write(JSON.stringify({ id, method, params }) + '\n'); }) };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pbridge-'));
  const sent = [], statuses = [];
  const contacts = [{ pub: FRED, name: 'Fred', status: 'online', unread: 2, last: { from: 'peer', ts: 2, kind: 'text', text: 'hi there' } }, { pub: PC, name: 'PC', status: 'offline', unread: 0, last: null }];
  const conv = { [FRED]: [], [PC]: [] };
  for (let i = 0; i < 35; i++) conv[FRED].push({ id: 'm' + i, seq: i, from: i % 2 ? 'me' : 'peer', ts: 1000 + i, kind: 'text', text: `message ${i}`, lang: '', status: 'delivered' });
  conv[FRED][33] = { id: 'm33', from: 'peer', ts: 1033, kind: 'image', w: 800, h: 600, bytes: 9, text: '', status: 'delivered' };
  conv[FRED][34] = { id: 'm34', from: 'me', ts: 1034, kind: 'code', text: 'print(1)', lang: 'py', status: 'delivered' };
  const api = { contacts: () => contacts, conversation: (pub) => conv[pub],
    send: (pub, m) => { sent.push({ pub, ...m }); const msg = { id: 'n' + sent.length, from: 'me', ts: 2000, kind: m.kind, text: m.text, lang: m.lang, status: 'pending' }; conv[pub].push(msg); return msg; } };
  const log = { info() {}, error() {} };
  const b = createBridge({ dir, log, version: '0.13.0', api, onStatus: (s) => statuses.push(s) });

  ok('B4 off by default: nothing listens, no bridge.json', !b.status().on && !fs.existsSync(b.infoFile));
  b.setEnabled(true);
  ok('B4 on: bridge.json is written', await waitFor(() => fs.existsSync(b.infoFile)));
  const info = JSON.parse(fs.readFileSync(b.infoFile, 'utf8'));
  ok('B4 bridge.json holds the socket path and a long token', typeof info.path === 'string' && typeof info.token === 'string' && info.token.length >= 40 && info.version === '0.13.0');
  if (process.platform !== 'win32') {
    ok('B4 bridge.json is readable by this user only (0600)', (fs.statSync(b.infoFile).mode & 0o777) === 0o600);
    ok('B4 the socket is this user\'s only (0600)', (fs.statSync(info.path).mode & 0o777) === 0o600);
  }

  // B5: the token
  let c = client(info.path);
  c.write({ auth: 'wrong' });
  ok('B5 a wrong token is refused and the connection closed', (await c.loose()).error === 'bad token' && (await c.closed, true));
  c = client(info.path);
  c.write({ id: 1, method: 'contacts' });
  ok('B5 a request before the token is refused too', (await c.loose()).error === 'bad token' && (await c.closed, true));
  ok('B5 nobody counts as connected after those', b.status().connected === 0);
  const a = client(info.path);
  a.write({ auth: info.token });
  const hello = await a.loose();
  ok('B5 the right token: ok, with the app and its version', hello.ok === true && hello.app === 'P2P Chat' && hello.version === '0.13.0');
  ok('B5 connected = 1, and the UI is told', b.status().connected === 1 && statuses.some((s) => s.on && s.connected === 1));

  // B6: the methods
  const cs = (await a.req('contacts')).result;
  ok('B6 contacts: both, with id, status, unread and the last message from "them"', cs.length === 2 && cs[0].id === FRED && cs[0].unread === 2 && cs[0].last.from === 'them' && cs[1].status === 'offline' && cs[1].last === null);
  let r = (await a.req('messages', { contact: 'fred' })).result;
  ok('B6 messages: the latest 30 of 35 by default, oldest first', r.total === 35 && r.messages.length === 30 && r.messages[0].id === 'm5' && r.messages[29].id === 'm34');
  ok('B6 messages: who wrote each, the image as a line, the code with its language', r.messages[28].text === '[image 800x600]' && r.messages[29].lang === 'py' && r.messages[29].from === 'me' && r.messages[0].from === 'me');
  r = (await a.req('messages', { contact: FRED, limit: 3 })).result;
  ok('B6 messages: a limit', r.messages.length === 3 && r.messages[2].id === 'm34');
  r = (await a.req('messages', { contact: FRED, limit: 5000 })).result;
  ok('B6 messages: the limit is capped (all 35 here, under the cap of 200)', r.messages.length === 35);
  ok('B6 messages: an unknown contact is an error, not a guess', /no contact matches "nobody"/.test((await a.req('messages', { contact: 'nobody' })).error));
  r = (await a.req('send', { contact: 'Fred', text: 'on my way' })).result;
  ok('B6 send: the engine gets a plain text message', sent.length === 1 && sent[0].pub === FRED && sent[0].kind === 'text' && sent[0].text === 'on my way' && sent[0].lang === '');
  ok('B6 send: the answer names the contact and the message', r.contact.name === 'Fred' && r.message.text === 'on my way' && r.message.from === 'me');
  ok('B6 send: the UI is told who got a message from Claude', statuses.some((s) => s.sent && s.sent.name === 'Fred'));
  await a.req('send', { contact: 'PC', text: 'ls -la', code: true, language: 'sh' });
  ok('B6 send: as code, with its language', sent[1].pub === PC && sent[1].kind === 'code' && sent[1].lang === 'sh');
  ok('B6 send: empty text is refused', /nothing to send/.test((await a.req('send', { contact: 'Fred', text: '   ' })).error) && sent.length === 2);
  ok('B6 an unknown method is an error', /unknown method/.test((await a.req('settings', {})).error));

  // B7: waiting for a message
  let w = a.req('wait', { timeoutMs: 5000 });
  await sleep(30);
  b.onMessage(FRED, { id: 'x1', from: 'me', ts: 3000, kind: 'text', text: 'mine', status: 'pending' });
  b.onMessage(FRED, { id: 'x2', from: 'peer', ts: 3001, kind: 'text', text: 'see you', status: 'delivered' });
  r = (await w).result;
  ok('B7 wait: the next message from a contact; my own does not count', r.contact.name === 'Fred' && r.message.text === 'see you' && r.message.from === 'them');
  w = a.req('wait', { contact: 'PC', timeoutMs: 5000 });
  let done = false; w.then(() => { done = true; });
  await sleep(30);
  b.onMessage(FRED, { id: 'x3', from: 'peer', ts: 3002, kind: 'text', text: 'not for this wait' });
  await sleep(50);
  ok('B7 wait for one contact: another contact\'s message does not end it', !done);
  b.onMessage(PC, { id: 'x4', from: 'peer', ts: 3003, kind: 'text', text: 'from the pc' });
  r = (await w).result;
  ok('B7 wait for one contact: that contact\'s message does', r.contact.name === 'PC' && r.message.text === 'from the pc');
  const t0 = Date.now(); r = (await a.req('wait', { timeoutMs: 10 })).result;
  ok('B7 wait: a timeout says so (and is at least 1 s)', r.timeout === true && r.waitedMs === 1000 && Date.now() - t0 >= 950);
  const gone = client(info.path); gone.write({ auth: info.token }); await gone.loose();
  gone.req('wait', { timeoutMs: 60000 }); await sleep(30); gone.sock.destroy(); await gone.closed; await sleep(20);
  ok('B7 a waiter whose client left is dropped: a message later throws nothing', (() => { try { b.onMessage(FRED, { id: 'x5', from: 'peer', ts: 1, kind: 'text', text: 'late' }); return true; } catch { return false; } })());

  // B8: limits
  const raws = [client(info.path), client(info.path), client(info.path)];   // + the one authenticated = 4
  await sleep(50);
  const fifth = client(info.path);
  ok('B8 a fifth connection is closed at once', await Promise.race([fifth.closed.then(() => true), sleep(1000).then(() => false)]));
  raws.forEach((x) => x.sock.destroy()); await sleep(50);
  const big = client(info.path); big.write({ auth: info.token }); await big.loose();
  big.write('x'.repeat(300 * 1024));
  ok('B8 a line over 256 KB closes that connection', await Promise.race([big.closed.then(() => true), sleep(2000).then(() => false)]));
  ok('B8 the other client is still served', (await a.req('contacts')).result.length === 2);

  // B9: off, and on again with a new token
  b.setEnabled(false);
  ok('B9 off: the connected client is closed', await Promise.race([a.closed.then(() => true), sleep(1000).then(() => false)]));
  ok('B9 off: bridge.json is gone', !fs.existsSync(b.infoFile));
  if (process.platform !== 'win32') ok('B9 off: the socket file is gone', !fs.existsSync(info.path));
  ok('B9 off: the status says so, and the UI is told', !b.status().on && b.status().connected === 0 && statuses[statuses.length - 1].on === false);
  b.setEnabled(true);
  await waitFor(() => fs.existsSync(b.infoFile));
  const info2 = JSON.parse(fs.readFileSync(b.infoFile, 'utf8'));
  ok('B9 on again: a new token', info2.token !== info.token);
  const old = client(info2.path); old.write({ auth: info.token });
  ok('B9 the old token opens nothing', (await old.loose()).error === 'bad token');
  b.stop('test');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.log('FAIL  bridge test threw:', e.stack); process.exitCode = 1; });
