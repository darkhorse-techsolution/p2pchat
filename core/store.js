'use strict';
// Everything that persists, in one encrypted vault file. The key comes from
// the caller (main.js wraps it with the OS keychain via Electron safeStorage).
//
// Data model:
//   identity      { pub, priv, name }          long-term X25519 keypair
//   port          number                        fixed listen port so contacts' saved address stays valid
//   contacts      { [pubId]: { pub, name, host, port, verified, added, token, renamed, myAddr, theirAddr } }
//                 myAddr = my relay address for this contact {pub, priv}; theirAddr = theirs for me
//   conversations { [pubId]: { messages, mySeq, theirSeq, unread } }
//   invites       { [token]: { at, addr } }    tokens I issued, pending; addr = one-time relay intro address; expire after INVITE_TTL
//   settings      { hotkey, discovery, theme }
//
// A message: { id, seq, from: 'me'|'peer', ts, kind: 'text'|'code'|'image', text, lang, status }
//   seq is the sender's own counter for that conversation. Both sides store both
//   directions, so either side can rebuild the whole conversation for the other.
//   kind 'image' adds { mime, w, h, bytes } and has text ''. The bytes themselves are
//   not in the vault: they sit as one sealed file per message in <vault>-blobs/<contact>/<id>,
//   because the vault is rewritten whole on every change and screenshots are megabytes.
//
// Every lookup keyed by something a peer or the renderer supplied goes through
// Object.hasOwn: a plain object answers truthy for "constructor", "__proto__",
// "toString"... and that was once enough to walk through the invite gate.

const fs = require('node:fs');
const path = require('node:path');
const kc = require('./crypto.js');

const ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;       // base64url of 32 bytes
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;    // base64url of 16 bytes, what issueInvite makes
const MSG_ID_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;
const WIN_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;   // a message id becomes a file name; these are devices on Windows
const INVITE_TTL = 24 * 3600 * 1000;
const MAX_INVITES = 50;
const MAX_TEXT_CHARS = 100000;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_SEQ = 2 ** 31;
const MAX_MESSAGES = 20000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_EDGE = 16384;

const pubId = (pub) => (Buffer.isBuffer(pub) ? pub.toString('base64url') : String(pub));
const isId = (s) => typeof s === 'string' && ID_SHAPE.test(s);
const has = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

// Normalise a message record from the wire (msg frame or hist chunk). Returns
// null for anything that is not exactly the shape we store.
function sanitizeMsg(m, now = Date.now()) {
  if (!m || typeof m !== 'object') return null;
  if (!Number.isSafeInteger(m.seq) || m.seq < 1 || m.seq > MAX_SEQ) return null;
  if (typeof m.text !== 'string' || m.text.length > MAX_TEXT_CHARS || Buffer.byteLength(m.text, 'utf8') > MAX_TEXT_BYTES) return null;
  const id = typeof m.id === 'string' && MSG_ID_SHAPE.test(m.id) && !WIN_DEVICE.test(m.id) ? m.id : kc.newId();
  let ts = Number(m.ts);
  if (!Number.isFinite(ts) || ts < 0 || ts > now + 86400000) ts = now;
  const out = { id, seq: m.seq, ts: Math.floor(ts), kind: m.kind === 'code' ? 'code' : 'text', text: m.text, lang: typeof m.lang === 'string' ? m.lang.slice(0, 24) : '' };
  if (m.kind === 'image') {
    const img = sanitizeImage(m);
    if (!img) return null;
    Object.assign(out, img, { kind: 'image', text: '', lang: '' });
  }
  return out;
}

// The metadata of an image message. The bytes are validated separately when
// they arrive (size must match, content must start like the declared type).
function sanitizeImage(m) {
  if (!m || !IMAGE_MIMES.has(m.mime)) return null;
  const dim = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_IMAGE_EDGE;
  if (!dim(m.w) || !dim(m.h) || !Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX_BLOB_BYTES) return null;
  return { mime: m.mime, w: m.w, h: m.h, bytes: m.bytes };
}

class Store {
  constructor(file, key) {
    this.file = file;
    this.key = key;
    this.data = null;
    this.saveTimer = null;
    this.blobDir = path.join(path.dirname(file), path.basename(file).replace(/\.[^.]*$/, '') + '-blobs');
  }

  load() {
    if (fs.existsSync(this.file)) {
      this.data = kc.vaultOpen(this.key, fs.readFileSync(this.file));
      for (const k of ['contacts', 'conversations', 'invites']) if (!this.data[k] || typeof this.data[k] !== 'object') this.data[k] = {};
      for (const [t, v] of Object.entries(this.data.invites)) if (typeof v === 'number') this.data.invites[t] = { at: v }; // pre-relay format
      this.pruneInvites();
    } else {
      const kp = kc.newKeypair();
      this.data = {
        identity: { pub: kp.pub.toString('base64url'), priv: kp.priv.toString('base64url'), name: '' },
        port: 0, contacts: {}, conversations: {}, invites: {},
      };
      this.save();
    }
    return this;
  }

  // Write to a temp file, fsync it, then rename over the vault: a power cut
  // leaves either the old vault or the new one, never a truncated identity.
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, kc.vaultSeal(this.key, this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }

  // A save that fails on the timer (disk full, permissions) must not escape as an
  // uncaught exception: report it, and keep trying on later changes.
  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { this.save(); this.lastSaveError = null; }
      catch (e) { this.lastSaveError = e; if (this.onSaveError) this.onSaveError(e); }
    }, 150);
  }

  identity() {
    const id = this.data.identity;
    return { pub: Buffer.from(id.pub, 'base64url'), priv: Buffer.from(id.priv, 'base64url'), name: id.name };
  }
  setName(name) { this.data.identity.name = String(name).slice(0, 64); this.saveSoon(); }

  // --- contacts
  contact(pub) { const id = pubId(pub); return isId(id) && has(this.data.contacts, id) ? this.data.contacts[id] : null; }
  contacts() { return Object.values(this.data.contacts); }
  upsertContact(pub, fields) {
    const id = pubId(pub);
    if (!isId(id)) throw new Error('bad contact id');
    const c = has(this.data.contacts, id) ? this.data.contacts[id] : { pub: id, name: '', host: '', port: 0, verified: false, added: Date.now() };
    Object.assign(c, fields);
    this.data.contacts[id] = c;
    if (!has(this.data.conversations, id)) this.data.conversations[id] = { messages: [], mySeq: 0, theirSeq: 0, unread: 0 };
    this.saveSoon();
    return c;
  }
  removeContact(pub) {
    const id = pubId(pub);
    if (!isId(id)) return;
    delete this.data.contacts[id];
    delete this.data.conversations[id];
    this.#dropBlobDir(id);
    this.saveSoon();
  }

  // --- invites
  // `addr` is the one-time relay intro address the invitee will dial; it is
  // bound on the relay until the token is consumed or expires.
  issueInvite(addr) {
    const token = kc.newToken();
    this.data.invites[token] = { at: Date.now(), addr: addr || null };
    this.pruneInvites(); // after adding, so the cap counts the new one
    this.saveSoon();
    return token;
  }
  invites() { this.pruneInvites(); return Object.entries(this.data.invites).map(([token, v]) => ({ token, at: v.at, addr: v.addr || null })); }
  hasInvite(token) { return typeof token === 'string' && TOKEN_SHAPE.test(token) && has(this.data.invites, token) && Date.now() - this.data.invites[token].at < INVITE_TTL; }
  consumeInvite(token) {
    if (!this.hasInvite(token)) return false;
    const v = this.data.invites[token];
    delete this.data.invites[token];
    this.saveSoon();
    return v;
  }
  pruneInvites() {
    const now = Date.now();
    const live = Object.entries(this.data.invites).filter(([t, v]) => TOKEN_SHAPE.test(t) && v && now - v.at < INVITE_TTL).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_INVITES);
    if (live.length !== Object.keys(this.data.invites).length) { this.data.invites = Object.fromEntries(live); this.saveSoon(); }
  }
  settings() { return (this.data.settings ||= {}); }

  // --- conversations
  conv(pub) {
    const id = pubId(pub);
    if (!isId(id)) throw new Error('bad contact id');
    if (!has(this.data.conversations, id)) this.data.conversations[id] = { messages: [], mySeq: 0, theirSeq: 0, unread: 0 };
    return this.data.conversations[id];
  }

  addOutgoing(pub, { id, kind, text, lang, mime, w, h, bytes }) {
    const c = this.conv(pub);
    const msg = { id: id || kc.newId(), seq: ++c.mySeq, from: 'me', ts: Date.now(), kind, text, lang: lang || '', status: 'pending' };
    if (kind === 'image') Object.assign(msg, { mime, w, h, bytes });
    c.messages.push(msg);
    this.#trim(pub, c);
    this.saveSoon();
    return msg;
  }

  // Record a sanitized message from the peer. Idempotent on message id.
  addIncoming(pub, m) {
    const c = this.conv(pub);
    if (c.messages.some((x) => x.id === m.id)) return null;
    const msg = { ...m, from: 'peer', status: 'delivered' };
    c.messages.push(msg);
    c.theirSeq = Math.max(c.theirSeq, m.seq);
    c.unread += 1;
    c.messages.sort((a, b) => a.ts - b.ts);
    this.#trim(pub, c);
    this.saveSoon();
    return msg;
  }

  markDelivered(pub, upToSeq) {
    const c = this.conv(pub);
    let changed = false;
    for (const m of c.messages) {
      if (m.from === 'me' && m.seq <= upToSeq && m.status !== 'delivered') { m.status = 'delivered'; changed = true; }
    }
    if (changed) this.saveSoon();
  }

  // The peer told us how many of ours it holds. A fresh conversation on our
  // side (after remove + re-add) must continue above that, or the peer will
  // silently drop our new messages as duplicates of old sequence numbers.
  bumpMySeq(pub, n) {
    const c = this.conv(pub);
    if (Number.isSafeInteger(n) && n > c.mySeq && n < MAX_SEQ) { c.mySeq = n; this.saveSoon(); }
  }

  pendingOutgoing(pub, afterSeq) { return this.conv(pub).messages.filter((m) => m.from === 'me' && m.seq > afterSeq); }
  clearUnread(pub) { const c = this.conv(pub); if (c.unread) { c.unread = 0; this.saveSoon(); } }

  // Merge the peer's copy of the conversation (their 'me' is our 'peer').
  // Records must already be sanitized. Never overwrites what we hold.
  mergeHistory(pub, theirMessages) {
    const c = this.conv(pub);
    const seen = new Set(c.messages.map((x) => x.id));
    let added = 0;
    for (const t of theirMessages) {
      if (seen.has(t.id) || c.messages.length >= MAX_MESSAGES) continue;
      const from = t.from === 'me' ? 'peer' : 'me';
      c.messages.push({ ...t, from, status: 'delivered' });
      seen.add(t.id);
      if (from === 'me') c.mySeq = Math.max(c.mySeq, t.seq); else c.theirSeq = Math.max(c.theirSeq, t.seq);
      added++;
    }
    if (added) { c.messages.sort((a, b) => a.ts - b.ts); this.saveSoon(); }
    return added;
  }

  wipeConversation(pub) {
    const id = pubId(pub);
    if (!isId(id)) return;
    this.data.conversations[id] = { messages: [], mySeq: 0, theirSeq: 0, unread: 0 };
    this.#dropBlobDir(id);
    this.saveSoon();
  }

  // --- image bytes ---------------------------------------------------------------
  // Both path parts are validated shapes (contact id, message id), never raw input.
  #blobPath(pub, id) {
    const cid = pubId(pub);
    if (!isId(cid) || typeof id !== 'string' || !MSG_ID_SHAPE.test(id) || WIN_DEVICE.test(id)) throw new Error('bad blob ref');
    return path.join(this.blobDir, cid, id);
  }
  // "Held" means a file that is at least a header: a zero-length file left by a
  // crash between write and flush must read as missing, so it gets pulled again.
  hasBlob(pub, id) { try { return fs.statSync(this.#blobPath(pub, id)).size > 17; } catch { return false; } }
  // A file that exists but does not open (truncated, wrong key) is removed, so the
  // record goes back to "missing" and the next trigger re-pulls it instead of
  // showing a broken image forever.
  blob(pub, id) {
    let f; try { f = this.#blobPath(pub, id); } catch { return null; }
    let buf; try { buf = fs.readFileSync(f); } catch { return null; }
    try { return kc.blobOpen(this.key, id, buf); }
    catch { this.#unlinkBlob(pub, f, buf.length); return null; }
  }
  // Written like the vault: data, fsync, then rename into place.
  putBlob(pub, id, data) {
    const f = this.#blobPath(pub, id);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const sealed = kc.blobSeal(this.key, id, data);
    let before = 0; try { before = fs.statSync(f).size; } catch {}
    const fd = fs.openSync(f + '.tmp', 'w', 0o600);
    try { fs.writeSync(fd, sealed); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(f + '.tmp', f);
    const c = this.conv(pub);
    c.blobBytes = Math.max(0, this.blobBytes(pub) - before) + sealed.length;
    this.saveSoon();
  }
  // Bytes of image files held for this contact (both directions). Counted in the
  // conversation record; rebuilt from the directory when the count is missing.
  blobBytes(pub) {
    const c = this.conv(pub);
    if (!Number.isSafeInteger(c.blobBytes) || c.blobBytes < 0) {
      let sum = 0;
      try { const dir = path.join(this.blobDir, pubId(pub)); for (const f of fs.readdirSync(dir)) { try { sum += fs.statSync(path.join(dir, f)).size; } catch {} } } catch {}
      c.blobBytes = sum;
    }
    return c.blobBytes;
  }
  // Image messages whose bytes we do not hold, oldest first, at most `limit` of the newest.
  missingBlobs(pub, limit) {
    return this.conv(pub).messages.filter((m) => m.kind === 'image' && !this.hasBlob(pub, m.id)).slice(-limit).map((m) => m.id);
  }
  #unlinkBlob(pub, f, size) {
    try { fs.rmSync(f, { force: true }); } catch {}
    const c = this.conv(pub);
    if (Number.isSafeInteger(c.blobBytes)) { c.blobBytes = Math.max(0, c.blobBytes - (size || 0)); this.saveSoon(); }
  }
  #dropBlobDir(id) { try { fs.rmSync(path.join(this.blobDir, id), { recursive: true, force: true }); } catch {} }

  #trim(pub, c) {
    if (c.messages.length <= MAX_MESSAGES) return;
    for (const m of c.messages.splice(0, c.messages.length - MAX_MESSAGES)) {
      if (m.kind !== 'image') continue;
      let f, size = 0; try { f = this.#blobPath(pub, m.id); size = fs.statSync(f).size; } catch { continue; }
      this.#unlinkBlob(pub, f, size);
    }
  }
}

module.exports = { Store, pubId, isId, sanitizeMsg, sanitizeImage, MAX_TEXT_BYTES, MAX_TEXT_CHARS, MAX_BLOB_BYTES, MSG_ID_SHAPE };
