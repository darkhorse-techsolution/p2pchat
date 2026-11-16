// A local door for an assistant on this computer (Claude Code, through mcp/p2pchat-mcp.js): list the contacts, read
// a chat, send a message as the user, wait for the next one. Text only: no shared screens, no files, no settings.
// Off unless the user turns it on in Settings. Reachable only from this computer: a Unix socket (mode 0600) on macOS
// and Linux, a named pipe on Windows. A connection must first present the token from bridge.json, a file only this
// user can read; the token is new at every start, so an old copy of it opens nothing.
// Protocol: one JSON object per line. {"auth":token} -> {"ok":true,...}; then {"id","method","params"} ->
// {"id","result"} or {"id","error"}.
'use strict';
const net = require('node:net'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');

const MAX_LINE = 256 * 1024;          // one request line; the engine caps a message far lower
const MAX_CLIENTS = 4;
const MAX_READ = 200;                 // messages per read
const MAX_WAIT_MS = 10 * 60 * 1000;
const AUTH_MS = 5000;

function sockPathFor(dir, platform) {
  const tag = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\p2pchat-bridge-${tag}`;
  const p = path.join(dir, 'bridge.sock');
  return Buffer.byteLength(p) <= 100 ? p : path.join(os.tmpdir(), `p2pchat-bridge-${tag}.sock`);   // sun_path is 104 bytes on macOS
}

// Who the assistant means by "Fred": the exact id, an id prefix of 6 or more characters, the exact name (any case), or
// the one name that contains it. More than one match is refused with the candidates, never guessed.
function resolve(contacts, query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('say which contact: a name or an id from list_contacts');
  const exact = contacts.find((c) => c.pub === q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  const pick = (list, how) => {
    if (list.length > 1) throw new Error(`"${q}" ${how} ${list.length} contacts: ${list.map((c) => `${c.name} (id ${c.pub.slice(0, 8)})`).join(', ')}. Use the id.`);
    return list[0] || null;
  };
  const hit = (q.length >= 6 ? pick(contacts.filter((c) => c.pub.startsWith(q)), 'starts the id of') : null)
    || pick(contacts.filter((c) => String(c.name || '').toLowerCase() === lower), 'is the name of')
    || pick(contacts.filter((c) => String(c.name || '').toLowerCase().includes(lower)), 'matches');
  if (!hit) throw new Error(`no contact matches "${q}"`);
  return hit;
}

// What the assistant sees of a message: who wrote it, when, and its text. An image is a line, never its bytes.
function msgOut(m) {
  const o = { id: m.id, from: m.from === 'me' ? 'me' : 'them', ts: m.ts, kind: m.kind, status: m.status };
  o.text = m.kind === 'image' ? `[image ${m.w || '?'}x${m.h || '?'}]` : String(m.text || '');
  if (m.kind === 'code' && m.lang) o.lang = m.lang;
  return o;
}

function contactOut(c) {
  const l = c.last;
  return { id: c.pub, name: c.name, status: c.status, unread: c.unread || 0,
    last: l ? { from: l.from === 'me' ? 'me' : 'them', ts: l.ts, kind: l.kind, text: l.kind === 'image' ? '[image]' : String(l.text || '') } : null };
}

// api: contacts() -> the contact views the chat window gets; conversation(pub) -> that chat's message records;
// send(pub, {kind, text, lang}) -> the engine's sendMessage. onStatus({on, connected, sent?, error?}) feeds the UI.
function createBridge({ dir, platform = process.platform, log, version = '', api, onStatus = () => {} }) {
  const infoFile = path.join(dir, 'bridge.json');
  let server = null, token = null, where = '';
  const open = new Set();             // every socket, authenticated or not
  const clients = new Set();          // the ones that presented the token
  const waiters = new Set();          // { pub | null, sock, timer, done(result) }

  const status = () => ({ on: !!server, connected: clients.size });
  const tell = (extra = {}) => { try { onStatus({ ...status(), ...extra }); } catch {} };
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const named = (c) => ({ id: c.pub, name: c.name, status: c.status });

  const methods = {
    contacts: () => api.contacts().map(contactOut),
    messages: ({ contact, limit } = {}) => {
      const c = resolve(api.contacts(), contact);
      const n = Math.min(MAX_READ, Math.max(1, Number.isInteger(limit) ? limit : 30));
      const all = api.conversation(c.pub);
      return { contact: named(c), total: all.length, messages: all.slice(-n).map(msgOut) };
    },
    send: ({ contact, text, code, language } = {}) => {
      const c = resolve(api.contacts(), contact);
      if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to send: the text is empty');
      const msg = api.send(c.pub, { kind: code ? 'code' : 'text', text, lang: code ? String(language || '') : '' });
      log.info('bridge', `assistant sent a message to ${c.pub.slice(0, 8)}`);
      tell({ sent: { name: c.name } });
      return { contact: named(c), message: msgOut(msg) };
    },
    wait: ({ contact, timeoutMs } = {}, sock) => {
      const c = contact ? resolve(api.contacts(), contact) : null;
      const ms = Math.min(MAX_WAIT_MS, Math.max(1000, Number(timeoutMs) || 60000));
      return new Promise((done) => {
        const w = { pub: c ? c.pub : null, sock, done: (r) => { if (!waiters.delete(w)) return; clearTimeout(w.timer); done(r); } };
        w.timer = setTimeout(() => w.done({ timeout: true, waitedMs: ms }), ms);
        waiters.add(w);
      });
    },
  };

  async function run(req, reply, sock) {
    const id = req.id ?? null;
    const fn = typeof req.method === 'string' && Object.hasOwn(methods, req.method) ? methods[req.method] : null;
    if (!fn) { reply({ id, error: `unknown method ${String(req.method).slice(0, 40)}` }); return; }
    try { const result = await fn(req.params || {}, sock); if (result !== null) reply({ id, result }); }
    catch (e) { reply({ id, error: String((e && e.message) || e).slice(0, 500) }); }
  }

  function serve(sock) {
    if (open.size >= MAX_CLIENTS) { sock.destroy(); return; }
    open.add(sock);
    let buf = '', authed = false;
    const authTimer = setTimeout(() => { if (!authed) sock.destroy(); }, AUTH_MS);
    const reply = (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); };
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { reply({ error: 'not JSON' }); sock.end(); return; }
        if (!authed) {
          if (!token || !req || typeof req.auth !== 'string' || !same(req.auth, token)) { reply({ error: 'bad token' }); log.info('bridge', 'refused a connection without the right token'); sock.end(); return; }
          authed = true; clearTimeout(authTimer); clients.add(sock);
          if (clients.size === 1) log.info('bridge', 'assistant connected');
          reply({ ok: true, app: 'P2P Chat', version });
          tell();
          continue;
        }
        run(req, reply, sock);
      }
      if (buf.length > MAX_LINE) sock.destroy();
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(authTimer);
      open.delete(sock);
      for (const w of [...waiters]) if (w.sock === sock) w.done(null);
      if (clients.delete(sock)) { if (!clients.size) log.info('bridge', 'assistant disconnected'); tell(); }
    });
  }

  function writeInfo() {
    const tmp = infoFile + '.tmp';
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, path: where, token, pid: process.pid, app: 'P2P Chat', version }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, infoFile);
    try { fs.chmodSync(infoFile, 0o600); } catch {}
  }
  const dropSocketFile = () => { if (platform === 'win32' || !where) return; try { if (fs.lstatSync(where).isSocket()) fs.unlinkSync(where); } catch {} };

  function start() {
    if (server) return;
    token = crypto.randomBytes(32).toString('base64url');
    where = sockPathFor(dir, platform);
    dropSocketFile();                 // left by a crash; the single-instance lock means no live copy owns it
    const s = server = net.createServer(serve);
    s.on('error', (e) => { log.error('bridge', e.message); if (server === s) { stop('error'); tell({ error: e.message }); } });
    s.listen(where, () => {
      if (server !== s) return;
      if (platform !== 'win32') { try { fs.chmodSync(where, 0o600); } catch (e) { log.error('bridge', 'chmod', e.message); } }
      try { writeInfo(); } catch (e) { log.error('bridge', 'bridge.json', e.message); stop('error'); tell({ error: e.message }); return; }
      log.info('bridge', 'on');
      tell();
    });
  }

  function stop(why = '') {
    const s = server;
    server = null; token = null;
    for (const w of [...waiters]) w.done(null);
    for (const sock of open) sock.destroy();
    open.clear(); clients.clear();
    if (s) { try { s.close(); } catch {} log.info('bridge', 'off', why); }
    try { fs.unlinkSync(infoFile); } catch {}
    dropSocketFile();
    tell();
  }

  // Every message the engine stores (both ways) passes here; only a new one from a contact wakes a waiter.
  function onMessage(pub, msg) {
    if (!msg || msg.from !== 'peer' || !waiters.size) return;
    const c = api.contacts().find((x) => x.pub === pub);
    for (const w of [...waiters]) if (!w.pub || w.pub === pub) w.done({ contact: c ? named(c) : { id: pub, name: 'a contact', status: 'online' }, message: msgOut(msg) });
  }

  return { setEnabled: (on) => (on ? start() : stop('setting')), stop, onMessage, status, infoFile };
}

module.exports = { createBridge, resolve, msgOut, sockPathFor };
