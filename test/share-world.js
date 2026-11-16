// Shared harness for the share-code tests: load the renderer's share closures (ui/share/*.js) into a bare
// vm context with just the globals a test hands in, and build a windowless "page" (pageWorld) with stand-in
// DOM elements, captured timers and stubbed window.api. Used by share-test.js and speed-test.js.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const pages = new WeakMap();   // the context a ShareKit was loaded into, for what a file puts on window beside it (window.Share)
function load(files, globals = {}) {
  const ctx = vm.createContext(Object.defineProperties({ console, setTimeout, clearTimeout }, Object.getOwnPropertyDescriptors(globals)));   // a getter stays a getter
  ctx.window = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'share', f), 'utf8'), ctx, { filename: f });
  pages.set(ctx.ShareKit, ctx);
  return ctx.ShareKit;
}

function pageWorld(extra = {}) {
  const w = { els: new Map(), toasts: [], timers: [], sent: [], live: [], connect: async () => ({ ok: true }), S: { me: { pub: 'me' }, current: null, contacts: [], settings: {}, capture: { supported: true }, protection: true } };
  w.$ = (id) => { if (!w.els.has(id)) { const cls = new Set(); w.els.set(id, { id, textContent: '', title: '', className: '', disabled: false, checked: false, style: {}, dataset: {}, srcObject: null, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); } },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {}, requestVideoFrameCallback() {}, focus() {}, play: async () => {}, appendChild() {}, append() {}, remove() {} }); } return w.els.get(id); };
  w.K = load(['kit.js', 'tune.js', 'session.js', 'cast.js', 'control.js', 'clip.js', 'record.js', 'viewer.js', 'unattended.js', '../share.js'], { $: w.$, S: w.S, toast: (t) => w.toasts.push(t), ipcErr: (e) => String((e && e.message) || e), renderContacts() {}, closeLightbox() {}, show() {}, closeModal() {},
    contact: (pub) => w.S.contacts.find((c) => c.pub === pub), document: { getElementById: w.$, addEventListener() {}, createElement: () => w.$('made' + w.els.size), body: w.$('body') }, addEventListener() {}, performance: { now: () => 0 },
    setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; w.timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; }, setInterval: () => 0, clearInterval() {},
    MediaStream: class { constructor() { this.t = []; } addTrack(t) { this.t.push(t); } removeTrack() {} },
    api: { share: async (pub, f) => { w.sent.push(`${pub}:${f.op}`); return true; }, iceConfig: async () => ({ iceServers: [] }), controlRevoke: async () => true, log: async () => true, keysRemote: async () => false, fullscreen: async (on) => on, captureEnded: async () => true, recordStop: async () => null,
      uaLive: async (o) => { w.live.push(o); return o.pubs.length; }, uaConnect: (pub, pass) => w.connect(pub, pass) }, ...extra });
  w.Share = pages.get(w.K).Share;
  // a session as session.js makes one, put into the registry by hand: `out` says my screen goes to that contact
  w.sess = (pub, out, theirs = false) => { const x = { pub, id: 's-' + pub, pc: null, closed: false, peerSids: new Set(), statsTimer: null, connectTimer: null, markSeen() {}, ready: Promise.resolve(), inbox: Promise.resolve(), seen: true, everConnected: true, screenTrack: out ? { stop() {}, contentHint: '' } : null, micTrack: null, screenSender: null, micSender: null, local: {}, mode: 'one', rec: null, stats: '',
    remote: { screen: theirs, mic: false, mode: 'one', rec: false, cast: 0, video: null, audio: null, view: null, audioEl: null }, ctl: { give: 'off', take: false, asked: false, askTimer: null, flush: null, dc: null, mv: null, cp: null, chans: [], sent: 0, recv: 0, cursor: null, token: null, giveClip: false, takeClip: false, askedClip: false } };
    w.K.sessions.map.set(pub, x); w.S.contacts.push({ pub, name: pub[0].toUpperCase() + pub.slice(1), status: 'online' }); if (out) w.K.cast.members.set(pub, { state: 'live', mode: 'one', timer: null, back: null }); return x; };
  return w;
}

module.exports = { pages, load, pageWorld };
