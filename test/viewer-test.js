// The viewer's own window, its toolbar and the keys (0.11.0), without Electron and without a real window:
// ui/share/kit.js and viewer.js over stand-in documents, main/keygrab.js over a stand-in helper process,
// main/accesscard.js over a stand-in window, and the few lines of main/main.js that decide what the page
// may open and ask for, taken from its text.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createKeyGrab, parseLine, passArg } = require('../main/keygrab.js');
const { createAccessCard } = require('../main/accesscard.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const tick = () => new Promise((r) => setImmediate(r));
const js = (v) => JSON.stringify(v);

function load(files, globals = {}) {
  const ctx = vm.createContext(Object.defineProperties({ console }, Object.getOwnPropertyDescriptors(globals)));
  ctx.window = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'share', f), 'utf8'), ctx, { filename: f });
  return ctx.ShareKit;
}

// --- stand-ins for the DOM ----------------------------------------------------------------------
function mkEl(id) {
  const cls = new Set(), lis = {};
  const e = { id, textContent: '', title: '', className: '', style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, dataset: {}, srcObject: null, children: [], parentNode: null, lis,
    classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); } },
    addEventListener: (t, f, o) => { (lis[t] ||= []).push(f); if (o && o.signal) o.signal.addEventListener('abort', () => { lis[t] = (lis[t] || []).filter((x) => x !== f); }); }, removeEventListener: (t, f) => { lis[t] = (lis[t] || []).filter((x) => x !== f); },
    wipe() { for (const k of Object.keys(lis)) delete lis[k]; e.onclick = null; e.ondblclick = null; },   // what Chromium does to an element whose window was destroyed around it
    fire(t, ev = {}) { for (const f of lis[t] || []) f({ preventDefault() {}, stopPropagation() {}, ...ev }); },
    requestVideoFrameCallback() {}, focus() {}, play: async () => {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
    appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = e; e.children.push(c); return c; },
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = e; const i = e.children.indexOf(ref); e.children.splice(i < 0 ? e.children.length : i, 0, c); return c; },
    remove() { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((x) => x !== e); e.parentNode = null; } };
  return e;
}
function mkDoc(name) {
  const lis = {}, d = { name, title: '', activeElement: null, lis, body: mkEl('body'), head: mkEl('head'), documentElement: mkEl('html'), links: [],
    createElement: (tag) => { const e = mkEl(tag); e.tag = tag; return e; }, querySelectorAll: (q) => (/stylesheet/.test(q) ? d.links : []),
    addEventListener: (t, f) => { (lis[t] ||= []).push(f); },
    key(t, ev) { const e = { type: t, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...ev }; for (const f of lis[t] || []) f(e); return e; } };
  return d;
}
// A page with the viewer loaded: the chat's document, what window.open hands out, and what the page asks main for.
function world({ platform = 'linux', settings = {}, open = true } = {}) {
  const w = { doc: mkDoc('chat'), els: new Map(), sent: [], asked: [], toasts: [], timers: [], opened: [], kids: [], winLis: {}, keysAnswer: true };
  w.doc.links = [{ href: 'file:///app/ui/theme.css' }, { href: 'file:///app/ui/app.css' }]; w.doc.documentElement.dataset.theme = 'light';
  w.$ = (id) => { if (!w.els.has(id)) w.els.set(id, mkEl(id)); return w.els.get(id); };
  const chat = mkEl('chat'); chat.appendChild(w.$('viewer')); chat.appendChild(w.$('viewerAway')); w.chat = chat;
  w.$('backdrop').classList.add('hidden');
  w.S = { current: null, settings: { fullHotkey: 'Control+Super+Return', hotkey: 'Control+Super+X', modeHotkey: 'Control+Super+Backspace', ...settings }, me: { pub: 'me' } };
  w.nav = { keyboard: { locks: 0, unlocks: 0, lock() { this.locks++; return Promise.resolve(); }, unlock() { this.unlocks++; } } };   // the chat window's own keyboard lock
  w.sessions = new Map();
  w.sess = (pub, screen = true) => { const x = { pub, closed: false, remote: { screen, view: { of: pub } }, ctl: { take: false, cursor: null } }; w.sessions.set(pub, x); return x; };
  w.K = load(['kit.js', 'tune.js', 'viewer.js'], { $: w.$, S: w.S, document: w.doc, AbortController, contact: (pub) => ({ name: pub[0].toUpperCase() + pub.slice(1) }), toast: (t) => w.toasts.push(t), ipcErr: String, prettyHotkey: (a) => a,
    addEventListener: (t, f) => { (w.winLis[t] ||= []).push(f); }, navigator: w.nav,
    setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; w.timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; }, performance: { now: () => 0 },
    open: (url, name, feat) => {
      w.opened.push([url, name, feat].join());
      if (!open) return null;
      const lis = {}, kid = { closed: false, document: mkDoc('own'), lis, addEventListener: (t, f) => { (lis[t] ||= []).push(f); }, navigator: { keyboard: { locks: 0, unlocks: 0, lock() { this.locks++; return Promise.resolve(); }, unlock() { this.unlocks++; } } } };
      w.kids.push(kid); return kid;
    },
    api: { platform, keysRemote: async (on) => { w.asked.push(`keys ${on}`); return on && w.keysAnswer; }, fullscreen: async (on) => { w.asked.push(`full ${on}`); return on; }, setPref: async (k, v) => { w.asked.push(`pref ${k} ${v}`); return v; },
      viewerClose: async () => { w.asked.push('close window'); return true; }, viewerFront: async () => true, runHotkey: async (kind) => { w.asked.push(`hotkey ${kind}`); return true; } } });
  const K = w.K;
  K.sessions = { get: (pub) => w.sessions.get(pub) || null, dc: (sess, label, msg) => { w.sent.push(`${sess.pub}:${label}:${js(msg)}`); return true; } };
  K.control = { isTaking: () => !!K.viewer.bound && K.viewer.bound.ctl.take, pending: null }; K.clip = { poke() {} }; K.paint = () => K.viewer.rebind();
  w.fold = () => w.timers.filter((t) => t.on && (t.ms === 3500 || t.ms === 1800 || t.ms === 4000)).forEach((t) => { t.on = false; t.fn(); });
  return w;
}

// K1: an accelerator held against a key event
{
  const K = load(['kit.js'], { $: () => null, S: { settings: { fullHotkey: 'Control+Super+Return', hotkey: 'Control+Super+X', modeHotkey: 'Command+Alt+Backspace' } }, api: { platform: 'win32' } });
  const ev = (code, m = '') => ({ code, key: code, ctrlKey: m.includes('c'), metaKey: m.includes('m'), altKey: m.includes('a'), shiftKey: m.includes('s') });
  ok('K1 Control+Super+Return: the modifiers and both Enter keys', js(K.accel('Control+Super+Return', false)) === js({ ctrl: true, meta: true, alt: false, shift: false, codes: ['Enter', 'NumpadEnter'], key: '' }));
  ok('K1 CommandOrControl is Command on a Mac and Control elsewhere', K.accel('CommandOrControl+K', true).meta === true && K.accel('CommandOrControl+K', true).ctrl === false && K.accel('CmdOrCtrl+K', false).ctrl === true);
  ok('K1 a letter, a digit, a function key and a named key', K.accel('Alt+k').codes.join() === 'KeyK' && K.accel('Shift+7').codes.join() === 'Digit7,Numpad7' && K.accel('F11').codes.join() === 'F11' && K.accel('Command+Alt+V', true).codes.join() === 'KeyV');
  ok('K1 nothing but modifiers, or nothing at all, is no accelerator', K.accel('Control+Alt') === null && K.accel('') === null && K.accel(undefined) === null);
  ok('K1 the full-screen hotkey is picked out, on either Enter key', K.hotkeyOf(ev('Enter', 'cm')) === 'fullHotkey' && K.hotkeyOf(ev('NumpadEnter', 'cm')) === 'fullHotkey');
  ok('K1 and the other two', K.hotkeyOf(ev('KeyX', 'cm')) === 'hotkey' && K.hotkeyOf(ev('Backspace', 'ma')) === 'modeHotkey');
  ok('K1 one modifier more or less is another combination', K.hotkeyOf(ev('Enter', 'cms')) === '' && K.hotkeyOf(ev('Enter', 'c')) === '' && K.hotkeyOf(ev('Enter')) === '' && K.hotkeyOf(ev('KeyY', 'cm')) === '');
  const bare = load(['kit.js'], { $: () => null, S: {}, api: {} });
  ok('K1 no settings yet: no hotkey, no throw', bare.hotkeyOf(ev('Enter', 'cm')) === '');
}

// O1: the viewer in a window of its own
{
  const w = world({ settings: { viewerWindow: true } }), K = w.K, bob = w.sess('bob');
  w.S.current = 'bob'; K.viewer.rebind();
  const kid = w.kids[0], d = kid && kid.document;
  ok('O1 one window is opened, blank, under the name main lets through', w.opened.join(' | ') === 'about:blank,p2p-viewer,popup');
  ok('O1 the whole section is moved into it, the very element', !!d && w.$('viewer').parentNode === d.body && !w.chat.children.includes(w.$('viewer')) && K.viewer.away() === true);
  ok('O1 with the page\'s style sheets, its theme and the class the layout hangs on', d.head.children.map((c) => `${c.rel} ${c.href}`).join(' | ') === 'stylesheet file:///app/ui/theme.css | stylesheet file:///app/ui/app.css' && d.documentElement.dataset.theme === 'light' && d.body.className === 'viewer-win');
  ok('O1 named after whose screen it is', d.title === "Bob's screen" && w.$('viewerVideo').srcObject === bob.remote.view);
  K.viewer.rebind(); K.viewer.rebind();
  ok('O1 painting again opens no second window', w.opened.length === 1);
  K.viewer.echo('hello', 'ok');
  ok('O1 what the app says is put into that window too', d.body.children[0].children.length === 1 && d.body.children[0].children[0].textContent === 'hello' && d.body.children[0].children[0].className === 'toast ok');
  K.viewer.themed('dark');
  ok('O1 and a change of theme reaches it', d.documentElement.dataset.theme === 'dark');
}

// O2: a window of its own keeps the screen it shows; a chat with another share takes it over
{
  const w = world({ settings: { viewerWindow: true } }), K = w.K, bob = w.sess('bob'), cy = w.sess('cy'); w.sess('dee', false);
  w.S.current = 'bob'; K.viewer.rebind();
  w.S.current = 'dee'; K.viewer.rebind();
  ok('O2 a chat without a share is opened: the window still shows the screen it had', K.viewer.bound === bob && K.viewer.away() === true && w.opened.length === 1);
  w.S.current = null; K.viewer.rebind();
  ok('O2 no chat open at all: the same', K.viewer.bound === bob);
  bob.ctl.take = true; w.sent.length = 0; w.S.current = 'cy'; K.viewer.rebind();
  ok('O2 a chat with a share is opened: the window shows that one, and nothing stays pressed on the first', K.viewer.bound === cy && w.sent.join() === 'bob:ctl:{"t":"r"}' && w.kids[0].document.title === "Cy's screen" && w.opened.length === 1);
  const off = world(), b2 = off.sess('bob'); off.sess('dee', false);
  off.S.current = 'bob'; off.K.viewer.rebind(); off.S.current = 'dee'; off.K.viewer.rebind();
  ok('O2 in the chat, as before: the viewer follows the open chat and lets go of a share that is not its', off.K.viewer.bound === null && off.opened.length === 0 && b2.remote.screen === true);
}

// O3: the window goes when there is nothing left to show in it, or when it is asked to
{
  const w = world({ settings: { viewerWindow: true } }), K = w.K, bob = w.sess('bob');
  w.S.current = 'bob'; K.viewer.rebind();
  bob.remote.screen = false; K.viewer.rebind();
  ok('O3 their screen ends: the section is back in the chat, in its old place, and main is asked to close the window', K.viewer.away() === false && w.chat.children.map((c) => c.id).join() === 'viewer,viewerAway' && w.asked.includes('close window') && K.viewer.bound === null);
  ok('O3 the setting stays: the next share opens in a window again', w.S.settings.viewerWindow === true);
  bob.remote.screen = true; K.viewer.rebind();
  ok('O3 and it does', w.opened.length === 2 && K.viewer.away() === true);
  w.asked.length = 0; K.viewer.onWindow({ op: 'close' });
  ok('O3 the window\'s own close button: back into the chat, and the setting goes off', K.viewer.away() === false && w.S.settings.viewerWindow === false && w.asked.join() === 'pref viewerWindow false,close window' && K.viewer.bound === bob);
  w.asked.length = 0; w.$('viewerPop').onclick();
  ok('O3 the button in the bar opens it again and says so to main', K.viewer.away() === true && w.asked.join() === 'pref viewerWindow true' && w.opened.length === 3);
  K.viewer.onWindow({ op: 'close' }); K.viewer.onWindow({ op: 'close' });
  ok('O3 a close that comes twice is one', K.viewer.away() === false && w.S.settings.viewerWindow === false);
}

// O6: a window that went behind the page's back
{
  const w = world({ settings: { viewerWindow: true } }), K = w.K, bob = w.sess('bob');
  w.S.current = 'bob'; K.viewer.rebind();
  w.kids[0].closed = true; w.asked.length = 0;
  K.viewer.onWindow({ op: 'gone' });
  ok('O6 main says the window is gone: the viewer is taken out of the dead document and gets a new window, since that is still the setting', w.opened.length === 2 && w.$('viewer').parentNode === w.kids[1].document.body && K.viewer.away() === true && K.viewer.bound === bob && !w.asked.includes('close window'));
  // the dead window took every listener off the viewer's elements: they are put on again, once each
  const counts = () => ['pointerdown', 'pointerup', 'wheel', 'contextmenu', 'pointerenter'].map((t) => (w.$('viewerVideo').lis[t] || []).length).join('') + ' ' + ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].map((t) => (w.$('viewerTab').lis[t] || []).length).join('');
  const before = counts();
  let mine = 0; K.viewer.bind(() => { w.$('viewerEnd').onclick = () => mine++; });
  for (const id of ['viewerVideo', 'viewerTab', 'viewerBar', 'viewerFull', 'viewerPop', 'viewerFold', 'viewerEnd']) w.$(id).wipe();
  w.kids[1].closed = true; K.viewer.rebind();
  w.$('viewerEnd').onclick();
  ok('O6 the listeners a destroyed window took off the viewer are put on again: the buttons, the video, the tab, and what share.js hung on', before === '11111 1111' && counts() === before && typeof w.$('viewerFull').onclick === 'function' && typeof w.$('viewerPop').onclick === 'function' && typeof w.$('viewerVideo').ondblclick === 'function' && mine === 1);
  for (const id of ['viewerVideo', 'viewerTab']) { /* a window that only went away, with nothing taken off */ }
  w.kids[2].closed = true; K.viewer.rebind();
  ok('O6 and bound a second time without a wipe in between, nothing is on twice', counts() === before);
  w.kids[3].closed = true; w.S.settings.viewerWindow = false; K.viewer.rebind();
  ok('O6 noticed by a paint alone, with the setting off: back in the chat, in its old place', K.viewer.away() === false && w.chat.children.map((c) => c.id).join() === 'viewer,viewerAway' && w.opened.length === 4);
}

// O4: a window that cannot be opened leaves the viewer in the chat
{
  const w = world({ settings: { viewerWindow: true }, open: false }), K = w.K; w.sess('bob');
  w.S.current = 'bob'; K.viewer.rebind();
  ok('O4 no window: the viewer stays in the chat, the setting goes off, and it is said', K.viewer.away() === false && w.chat.children.includes(w.$('viewer')) && w.S.settings.viewerWindow === false && w.asked.join() === 'pref viewerWindow false' && /could not be opened/.test(w.toasts.join()));
  K.viewer.rebind();
  ok('O4 and it is not tried again with every paint', w.opened.length === 1);
}

// O5: full screen in its own window, and leaving it when the viewer changes places
{
  (async () => {
    const w = world({ settings: { viewerWindow: true } }), K = w.K; w.sess('bob');
    w.S.current = 'bob'; K.viewer.rebind();
    const d = w.kids[0].document;
    await K.viewer.setFull(true);
    ok('O5 full screen is asked of main and marked on the window that holds the viewer, not on the chat', w.asked.includes('full true') && d.body.classList.contains('theater') && !w.doc.body.classList.contains('theater'));
    w.asked.length = 0; K.viewer.setOwn(false);
    ok('O5 back into the chat from full screen: full screen ends first, in that window', K.viewer.theater === false && !d.body.classList.contains('theater') && w.asked.slice(0, 2).join() === 'pref viewerWindow false,full false' && w.asked.includes('close window'));
  })().catch((e) => { console.log('FAIL  O5 threw:', e.stack); process.exitCode = 1; });
}

// T1: the toolbar in full screen folds into a tab by itself, and nothing of it is at the bottom
{
  (async () => {
    const w = world(), K = w.K; w.sess('bob'); w.S.current = 'bob'; K.viewer.rebind();
    const box = w.$('viewer'), folded = () => box.classList.contains('folded');
    await K.viewer.setFull(true);
    ok('T1 full screen starts with the toolbar open, so that it is seen once', K.viewer.theater === true && folded() === false);
    w.fold();
    ok('T1 and folds it by itself a moment later', folded() === true);
    w.$('viewerTab').fire('pointerdown', { clientX: 500 }); w.$('viewerTab').fire('pointerup', { clientX: 500 });
    ok('T1 a click on the tab opens it', folded() === false);
    w.$('viewerBar').fire('pointerenter'); w.fold();
    ok('T1 it stays open while the pointer is on it', folded() === false);
    w.$('viewerBar').fire('pointerleave'); w.fold();
    ok('T1 and folds again after the pointer left', folded() === true);
    w.$('viewerTab').fire('pointerdown', { clientX: 500 }); w.$('viewerTab').fire('pointermove', { clientX: 700 }); w.$('viewerTab').fire('pointerup', { clientX: 700 });
    ok('T1 a drag moves the tab along the top edge and does not open the toolbar', folded() === true && box.style.props['--tab-x'] === '700px');
    w.$('viewerTab').fire('pointerdown', { clientX: 700 }); w.$('viewerTab').fire('pointermove', { clientX: 5000 }); w.$('viewerTab').fire('pointerup', {});
    ok('T1 never past the edge', box.style.props['--tab-x'] === '970px');
    w.$('viewerTab').fire('pointerdown', { clientX: 1 }); w.$('viewerTab').fire('pointerup', {}); w.$('viewerFold').onclick();
    ok('T1 the fold button in the toolbar folds it at once', folded() === true);
    await K.viewer.setFull(false);
    ok('T1 out of full screen the bar is the plain bar again', K.viewer.theater === false && folded() === false);
    const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.css'), 'utf8');
    const theater = css.split('\n').filter((l) => /^body\.theater[^{]*\.viewer-(bar|tab)[^{]*\{/.test(l));
    ok('T1 the style sheet pins the full-screen toolbar and its tab to the top, never to the bottom', theater.length >= 3 && theater.every((l) => !/[{;\s]bottom\s*:/.test(l)) && theater.some((l) => /top:\s*8px/.test(l)));
  })().catch((e) => { console.log('FAIL  T1 threw:', e.stack); process.exitCode = 1; });
}

// Y1: which keys go over, and the app's own hotkeys where the page holds the whole keyboard
{
  (async () => {
    const w = world({ platform: 'win32' }), K = w.K, bob = w.sess('bob'); w.S.current = 'bob'; K.viewer.rebind();
    bob.ctl.take = true; await K.viewer.setFull(true); await tick();
    ok('Y1 full screen while their screen is driven: main is asked for the keys, and the keyboard lock is taken', w.asked.includes('keys true') && K.viewer.keysWanted === true && w.K.viewer.locked() === true);
    ok('Y1 and it is said once, with the way out', w.toasts.filter((t) => /Every key goes to their screen/.test(t)).length === 1 && /Control\+Super\+Return leaves full screen/.test(w.toasts.join()));
    w.sent.length = 0;
    w.doc.key('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true }); w.doc.key('keydown', { code: 'Tab', key: 'Tab', metaKey: true }); w.doc.key('keyup', { code: 'Tab', key: 'Tab', metaKey: true }); w.doc.key('keyup', { code: 'MetaLeft', key: 'Meta' });
    ok('Y1 the Windows key and a key with it go over like any other', w.sent.join(' ') === 'bob:ctl:{"t":"k","c":"MetaLeft","d":1} bob:ctl:{"t":"k","c":"Tab","d":1} bob:ctl:{"t":"k","c":"Tab","d":0} bob:ctl:{"t":"k","c":"MetaLeft","d":0}');
    w.sent.length = 0; w.asked.length = 0;
    w.doc.key('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true }); w.doc.key('keydown', { code: 'MetaLeft', key: 'Meta', ctrlKey: true, metaKey: true });
    const hit = w.doc.key('keydown', { code: 'Enter', key: 'Enter', ctrlKey: true, metaKey: true });
    ok('Y1 the full-screen hotkey is this machine\'s: not sent, what went over of it is let go, and main runs it', hit.prevented === true && w.sent[2] === 'bob:ctl:{"t":"r"}' && w.sent.length === 3 && w.asked.join() === 'hotkey fullHotkey');
    w.sent.length = 0; w.doc.key('keyup', { code: 'Enter', key: 'Enter', ctrlKey: true, metaKey: true }); w.doc.key('keyup', { code: 'MetaLeft', key: 'Meta', ctrlKey: true }); w.doc.key('keyup', { code: 'ControlLeft', key: 'Control' });
    ok('Y1 and the keys of it that come up afterwards are not sent either: they are down nowhere over there', w.sent.length === 0);
    w.doc.key('keyup', { code: 'KeyQ', key: 'q' });
    ok('Y1 nor is the way up of a key that was held since before', w.sent.length === 0);
    w.sent.length = 0;
    w.doc.key('keydown', { code: 'KeyA', key: 'a' }); w.doc.key('keydown', { code: 'KeyA', key: 'a', repeat: true }); w.doc.key('keydown', { code: 'KeyA', key: 'a', repeat: true }); w.doc.key('keyup', { code: 'KeyA', key: 'a' });
    ok('Y1 a held key goes over again for each repeat, marked as one', w.sent.join(' ') === 'bob:ctl:{"t":"k","c":"KeyA","d":1} bob:ctl:{"t":"k","c":"KeyA","d":1,"rep":1} bob:ctl:{"t":"k","c":"KeyA","d":1,"rep":1} bob:ctl:{"t":"k","c":"KeyA","d":0}');
    w.sent.length = 0;
    w.doc.key('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }); w.doc.key('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true, repeat: true }); w.doc.key('keydown', { code: 'ControlRight', key: 'Control', ctrlKey: true, repeat: true });
    ok('Y1 a held modifier is one press', w.sent.join(' ') === 'bob:ctl:{"t":"k","c":"ShiftLeft","d":1}');
    w.sent.length = 0; w.asked.length = 0;
    w.doc.key('keydown', { code: 'Enter', key: 'Enter', ctrlKey: true, metaKey: true, repeat: true });
    ok('Y1 a hotkey that is held does not run again and again', w.asked.length === 0);
    const kb = w.nav.keyboard;
    // in a window, not in full screen: the OS acts on the hotkey itself, and where its last key still reaches the page it is not sent on
    const q = world({ platform: 'linux' }), qb = q.sess('bob'); q.S.current = 'bob'; q.K.viewer.rebind(); qb.ctl.take = true; q.doc.activeElement = q.$('viewerVideo');
    q.doc.key('keydown', { code: 'KeyA', key: 'a' }); q.doc.key('keydown', { code: 'Enter', key: 'Enter', ctrlKey: true, metaKey: true });
    ok('Y1 not in full screen either: a key goes over, the hotkey\'s own key does not', q.sent.join(' ') === 'bob:ctl:{"t":"k","c":"KeyA","d":1} bob:ctl:{"t":"r"}' && q.asked.join() === 'hotkey fullHotkey' && q.K.viewer.keysWanted === false);
    await K.viewer.setFull(false); await tick();
    ok('Y1 full screen ends: the lock is given back', K.viewer.locked() === false && kb.unlocks >= 1 && w.asked.includes('keys false'));
    // main says no (the window is not in full screen): no lock
    const n = world({ platform: 'win32' }), nb = n.sess('bob'); n.S.current = 'bob'; n.K.viewer.rebind(); nb.ctl.take = true; n.keysAnswer = false;
    await n.K.viewer.setFull(true); await tick();
    ok('Y1 main says no: no lock, no word about system keys', n.K.viewer.locked() === false && n.nav.keyboard.locks === 0 && n.toasts.length === 0);
    // macOS: Chromium has no lock there; main's grab hands the keys in
    const m = world({ platform: 'darwin' }), mb = m.sess('bob'); m.S.current = 'bob'; m.K.viewer.rebind(); mb.ctl.take = true;
    await m.K.viewer.setFull(true); await tick();
    ok('Y1 macOS: the page takes no keyboard lock', m.nav.keyboard.locks === 0 && m.K.viewer.locked() === false && m.K.viewer.keysWanted === true);
    m.sent.length = 0;
    m.K.viewer.onGrabKey({ c: 'MetaLeft', d: 1 }); m.K.viewer.onGrabKey({ c: 'Tab', d: 1 }); m.K.viewer.onGrabKey({ c: 'Tab', d: 1, rep: 1 }); m.K.viewer.onGrabKey({ c: 'Tab', d: 0 }); m.K.viewer.onGrabKey({ r: true }); m.K.viewer.onGrabKey(null); m.K.viewer.onGrabKey({ c: 7, d: 1 });
    ok('Y1 macOS: the keys main\'s grab reports go over, repeats marked, and a hotkey that went by lets go over there', m.sent.join(' ') === 'bob:ctl:{"t":"k","c":"MetaLeft","d":1} bob:ctl:{"t":"k","c":"Tab","d":1} bob:ctl:{"t":"k","c":"Tab","d":1,"rep":1} bob:ctl:{"t":"k","c":"Tab","d":0} bob:ctl:{"t":"r"}');
    mb.ctl.take = false; m.sent.length = 0; m.K.viewer.onGrabKey({ c: 'KeyA', d: 1 });
    ok('Y1 macOS: a key that arrives after control ended goes nowhere', m.sent.length === 0);
    m.K.viewer.tip(); m.K.viewer.tip();
    ok('Y1 macOS: the word about system keys is said when the grab is on, once', m.toasts.filter((t) => /Every key goes to their screen/.test(t)).length === 1);
  })().catch((e) => { console.log('FAIL  Y1 threw:', e.stack); process.exitCode = 1; });
}
// Y2: in a window of its own the keys are those of that window, and the chat's stay the chat's
{
  (async () => {
    const w = world({ platform: 'win32', settings: { viewerWindow: true } }), K = w.K, bob = w.sess('bob'); w.S.current = 'bob'; K.viewer.rebind();
    const kid = w.kids[0], d = kid.document; bob.ctl.take = true; d.activeElement = w.$('viewerVideo');
    w.sent.length = 0;
    w.doc.key('keydown', { code: 'KeyA', key: 'a' });
    const there = d.key('keydown', { code: 'KeyB', key: 'b' });
    ok('Y2 a key typed in the chat is not theirs; one typed on the video in its own window is', w.sent.join() === 'bob:ctl:{"t":"k","c":"KeyB","d":1}' && there.prevented === true);
    w.$('backdrop').classList.remove('hidden'); w.sent.length = 0; d.key('keydown', { code: 'KeyC', key: 'c' });
    ok('Y2 a dialog open in the chat does not take the keys of the viewer\'s own window', w.sent.length === 1);
    w.$('backdrop').classList.add('hidden');
    await K.viewer.setFull(true); await tick();
    ok('Y2 the keyboard lock is asked of the window that holds the viewer', kid.navigator.keyboard.locks === 1 && K.viewer.locked() === true);
    w.sent.length = 0; (kid.lis.blur || []).forEach((f) => f());
    ok('Y2 that window loses the keyboard: nothing stays pressed over there', w.sent.join() === 'bob:ctl:{"t":"r"}');
    w.sent.length = 0; (w.winLis.blur || []).forEach((f) => f());
    ok('Y2 the chat\'s window losing it means nothing while the viewer is elsewhere', w.sent.length === 0);
    w.sent.length = 0; const esc = d.key('keydown', { code: 'Escape', key: 'Escape' });
    ok('Y2 Esc is theirs while I drive their screen in full screen', w.sent.join() === 'bob:ctl:{"t":"k","c":"Escape","d":1}' && K.viewer.theater === true && esc.prevented === true);
    bob.ctl.take = false; K.viewer.applyCtl(); d.key('keydown', { code: 'Escape', key: 'Escape' }); await tick();
    ok('Y2 and leaves full screen when I only watch', K.viewer.theater === false);
  })().catch((e) => { console.log('FAIL  Y2 threw:', e.stack); process.exitCode = 1; });
}

// G1: the lines of the macOS key grab, and the hotkeys it is told to let through
{
  ok('G1 a key down and up, named as the DOM names it', js(parseLine('k 55 1')) === js({ c: 'MetaLeft', d: 1 }) && js(parseLine('k 48 0')) === js({ c: 'Tab', d: 0 }) && js(parseLine('k 0 1')) === js({ c: 'KeyA', d: 1 }));
  ok('G1 an auto-repeat is marked', js(parseLine('k 51 1 1')) === js({ c: 'Backspace', d: 1, rep: 1 }) && js(parseLine('k 51 0 1')) === js({ c: 'Backspace', d: 0 }));
  ok('G1 a hotkey that went by', js(parseLine('r')) === js({ r: true }) && js(parseLine('r\r')) === js({ r: true }));
  ok('G1 and which one', js(parseLine('x 2')) === js({ hot: 2 }) && parseLine('x') === null && parseLine('x 12') === null && parseLine('x a') === null && parseLine('x 1 1') === null);
  ok('G1 anything else is no key', [' ', 'k', 'k 55', 'k 999 1', 'k 55 2', 'k -1 1', 'k 55 1 1 1', 'x 55 1', 'r 1', 'k 5a 1', 'cursor 1 2 3'].every((l) => parseLine(l) === null));
  ok('G1 the default hotkeys as the helper takes them', passArg('Command+Alt+Return') === '36:12' && passArg('Command+Alt+V') === '9:12' && passArg('Command+Alt+Backspace') === '51:12');
  ok('G1 every modifier name, and keys by letter, digit and name', passArg('Control+Shift+K') === '40:3' && passArg('CommandOrControl+1') === '18:8' && passArg('Super+Space') === '49:8' && passArg('Option+F5') === '96:4' && passArg('Meta+Up') === '126:8');
  ok('G1 no key, or a key the table lacks: nothing is passed', passArg('Command+Alt') === '' && passArg('') === '' && passArg('Command+§') === '' && passArg(null) === '');
}

// G2: the grab is started, kept alive and ended; its keys are handed on; it never starts untrusted
{
  (async () => {
    const mk = (over = {}) => {
      const g = { spawns: [], keys: [], notes: [], asks: 0, trusted: true, procs: [], log: [] };
      const spawnFn = (cmd, args) => {
        const l = {}, h = (o) => ({ on: (t, f) => { (o[t] ||= []).push(f); }, once: (t, f) => { (o[t] ||= []).push(f); } });
        const p = { cmd, args, wrote: [], ended: false, killed: false, lis: l, out: {}, err: {}, stdinLis: {}, stdin: { write: (s) => { if (p.ended) throw new Error('closed'); p.wrote.push(s); }, end: () => { p.ended = true; }, on: () => {} }, kill: () => { p.killed = true; } };
        Object.assign(p, h(l)); p.stdout = h(p.out); p.stderr = h(p.err);
        p.say = (s) => (p.out.data || []).forEach((f) => f(Buffer.from(s))); p.warn = (s) => (p.err.data || []).forEach((f) => f(Buffer.from(s))); p.exit = (c) => (l.exit || []).forEach((f) => f(c, null));
        g.spawns.push(args.join(' ')); g.procs.push(p); return p;
      };
      g.hot = []; g.grab = createKeyGrab({ log: { info: (...a) => g.log.push(a.join(' ')), error: (...a) => g.log.push(a.join(' ')) }, helpersDir: '/h', platform: 'darwin', trusted: () => g.trusted, ask: () => { g.asks++; }, onKey: (ev) => g.keys.push(js(ev)), onNote: (s) => g.notes.push(s), onHotkey: (k) => g.hot.push(k), spawnFn, exists: () => true, ...over });
      return g;
    };
    const HK = { hotkey: 'Command+Alt+V', modeHotkey: 'Command+Alt+Backspace', fullHotkey: 'Command+Alt+Return' };
    let g = mk();
    ok('G2 started with the hotkeys it must let through', g.grab.set(true, HK) === true && g.spawns.join() === 'grab 9:12 51:12 36:12' && g.procs[0].cmd === '/h/p2pchat-input' && g.grab.status().on === true);
    ok('G2 asked for again with the same hotkeys: the one that runs', g.grab.set(true, HK) === true && g.spawns.length === 1);
    g.procs[0].warn('ready grab tap=hid hotkeys=3\n');
    ok('G2 the helper has the keyboard: said to the page', g.notes.join() === 'on');
    g.procs[0].say('k 55 1\nk 48 1\nk 4'); g.procs[0].say('8 0\nnoise\nk 55 0\nr\n');
    ok('G2 its keys are handed on in order, also one that came in two pieces; anything else is dropped', g.keys.join(' ') === '{"c":"MetaLeft","d":1} {"c":"Tab","d":1} {"c":"Tab","d":0} {"c":"MetaLeft","d":0} {"r":true}' && g.grab.status().keys === 5);
    g.procs[0].say('r\nx 2\nx 0\nx 7\nx\n'); g.keys.length = 0;
    ok('G2 a hotkey of the app that went by is run here by its name; a number it was never told is nothing', g.hot.join() === 'fullHotkey,hotkey');
    const few = mk(); few.grab.set(true, { hotkey: '', modeHotkey: 'Command+Alt+Backspace', fullHotkey: 'Command+Alt+Return' }); few.procs[0].say('x 0\nx 1\nx 2\n'); few.grab.stop('test');
    ok('G2 with a hotkey that has no key the numbers still name the right ones', few.spawns.join() === 'grab 51:12 36:12' && few.hot.join() === 'modeHotkey,fullHotkey');
    ok('G2 no key is written to the log', !g.log.join(' ').includes('MetaLeft') && !/k 55|k 48/.test(g.log.join(' ')));
    g.grab.set(true, { hotkey: 'Command+Alt+V', modeHotkey: 'Command+Alt+Backspace', fullHotkey: 'Control+Shift+F' });
    ok('G2 a hotkey changed: the old helper is ended and a new one knows the new key', g.procs[0].wrote.join('') === 'q\n' && g.procs[0].ended === true && g.spawns[1] === 'grab 9:12 51:12 3:3');
    g.procs[0].say('k 0 1\n');
    ok('G2 a helper that was ended is not listened to any more', g.keys.length === 0);
    g.grab.set(false);
    ok('G2 off: asked to end, stdin closed', g.procs[1].wrote.join('') === 'q\n' && g.procs[1].ended === true && g.grab.status().on === false);
    g.keys.length = 0; g.procs[1].exit(0);
    ok('G2 its exit after that is nothing to report', g.keys.length === 0);
    // it ends by itself
    g = mk(); g.grab.set(true, HK); g.procs[0].exit(0);
    ok('G2 a helper that ends by itself: what it held is let go over there, and it can be started again', g.keys.join() === '{"r":true}' && g.grab.status().on === false && g.grab.set(true, HK) === true && g.spawns.length === 2);
    g.grab.stop('test');
    // the beat
    g = mk({ beatMs: 5 }); g.grab.set(true, HK); await new Promise((r) => setTimeout(r, 40));
    const beats = g.procs[0].wrote.filter((x) => x === 'h\n').length; g.grab.stop('test'); const after = g.procs[0].wrote.length; await new Promise((r) => setTimeout(r, 25));
    ok('G2 it hears from the app again and again while it runs, and not after', beats >= 2 && g.procs[0].wrote.length === after);
    // not trusted
    g = mk(); g.trusted = false;
    ok('G2 without Accessibility it does not start; macOS is asked once and the page is told each time', g.grab.set(true, HK) === false && g.grab.set(true, HK) === false && g.spawns.length === 0 && g.asks === 1 && g.notes.join() === 'accessibility,accessibility');
    g.trusted = true;
    ok('G2 and starts once it is allowed', g.grab.set(true, HK) === true && g.spawns.length === 1);
    g.procs[0].warn('err tap trusted=0\n');
    ok('G2 a helper that could not take the keyboard says so to the page', g.notes[g.notes.length - 1] === 'accessibility');
    g.grab.stop('test');
    // elsewhere, and without the helper
    ok('G2 not on Windows or Linux', mk({ platform: 'win32' }).grab.set(true, HK) === false && mk({ platform: 'linux' }).grab.set(true, HK) === false);
    g = mk({ exists: () => false });
    ok('G2 a build without the helper: no start, no throw', g.grab.set(true, HK) === false && g.spawns.length === 0);
  })().catch((e) => { console.log('FAIL  G2 threw:', e.stack); process.exitCode = 1; });
}

// N1: a click from the far side goes through the notice; a mouse at the machine does not
{
  (async () => {
    const made = [], ipc = {};
    class Win {
      constructor(o) { this.o = o; this.ignore = []; this.bounds = { x: 0, y: 0, width: o.width, height: o.height }; this.destroyed = false; this.lis = {}; made.push(this);
        this.webContents = { on() {}, once() {}, setWindowOpenHandler() {}, isLoading: () => false, send() {} }; }
      setContentProtection() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile() {} showInactive() {} moveTop() {} isVisible() { return true; }
      on(t, f) { this.lis[t] = f; } setBounds(b) { this.bounds = b; } getBounds() { return this.bounds; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
      setIgnoreMouseEvents(v) { this.ignore.push(v); }
    }
    const card = createAccessCard({ BrowserWindow: Win, ipcMain: { on: (n, f) => { ipc[n] = f; } }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1160 } }) }, preload: 'p', page: 'h', isMac: true, isLinux: false, onStop() {}, onGone() {}, log: { info() {}, error() {} } });
    ok('N1 no notice up: nothing to go through', card.through({ x: 960, y: 1100 }) === false);
    card.show({ text: 'Bob sees this screen', theme: 'dark' });
    const w = made[0], b = w.getBounds();
    ok('N1 the notice sits at the bottom centre of the shared display', b.width === 440 && b.height === 76 && b.x === 740 && b.y === 1160 - 76 - 14);
    ok('N1 a click from the far side beside it is none of its business', card.through({ x: 100, y: 100 }) === false && card.through({ x: b.x - 10, y: b.y + 20 }) === false && w.ignore.length === 0);
    ok('N1 one inside it: the notice lets the mouse through', card.through({ x: b.x + 200, y: b.y + 30 }) === true && w.ignore.join() === 'true');
    ok('N1 the button up that follows keeps it open, without a second switch', card.through({ x: b.x + 200, y: b.y + 30 }) === true && w.ignore.join() === 'true');
    await new Promise((r) => setTimeout(r, 450));
    ok('N1 and a moment later it takes the mouse again: Disconnect is this machine\'s to press', w.ignore.join() === 'true,false');
    card.through({ x: b.x + 5, y: b.y + 5 }); card.hide();
    await new Promise((r) => setTimeout(r, 450));
    ok('N1 a notice that went away meanwhile is not touched again', w.destroyed === true && w.ignore.join() === 'true,false,true' && card.through({ x: b.x + 5, y: b.y + 5 }) === false);
    ok('N1 no point, no throw', card.through(null) === false);
  })().catch((e) => { console.log('FAIL  N1 threw:', e.stack); process.exitCode = 1; });
}

// M1: what main lets the page open and ask for, from the text of main/main.js
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8'), lines = src.split('\n');
  const line = (re) => (lines.find((x) => re.test(x)) || '').trim();
  const block = (re) => { const i = lines.findIndex((x) => re.test(x)); if (i < 0) return ''; let j = i; while (lines[j] !== '}') j++; return lines.slice(i, j + 1).join('\n'); };
  // the window-open rule
  const rule = line(/win\.webContents\.setWindowOpenHandler\(/).replace(/^win\.webContents\.setWindowOpenHandler\(/, 'this.rule = (').replace(/\);$/, ');');
  let open = false; const ctx = vm.createContext({ viewerOpen: () => open, viewerOptions: () => ({ width: 1 }) }); vm.runInContext(rule, ctx);
  const act = (url, frameName) => ctx.rule({ url, frameName }).action;
  ok('M1 the page may open one window: blank, under the viewer\'s name', act('about:blank', 'p2p-viewer') === 'allow' && js(ctx.rule({ url: 'about:blank', frameName: 'p2p-viewer' }).overrideBrowserWindowOptions) === '{"width":1}');
  ok('M1 no other address, no other name', ['https://example.com/', 'file:///etc/passwd', 'about:blank#x', 'javascript:alert(1)', ''].every((u) => act(u, 'p2p-viewer') === 'deny') && act('about:blank', '') === 'deny' && act('about:blank', '_blank') === 'deny');
  open = true;
  ok('M1 and no second one while the first is open', act('about:blank', 'p2p-viewer') === 'deny');
  // the permissions
  const pctx = vm.createContext({ win: { isDestroyed: () => false, webContents: 'chat' }, viewerWin: { webContents: 'own' }, up: true });
  vm.runInContext(`const viewerOpen = () => up; ${line(/^\s*const ours = \(wc\) =>/)} ${line(/^\s*const stage = \(wc, perm\) =>/)} this.stage = stage; this.ours = ours;`, pctx);
  ok('M1 full screen and the keyboard lock: for the chat\'s window and the viewer\'s own', ['fullscreen', 'keyboardLock'].every((p) => pctx.stage('chat', p) && pctx.stage('own', p)));
  ok('M1 for nothing else, and for no other page', !pctx.stage('other', 'fullscreen') && !pctx.stage(null, 'keyboardLock') && ['media', 'display-capture', 'pointerLock', 'notifications', 'clipboard-read', 'geolocation'].every((p) => !pctx.stage('chat', p) && !pctx.stage('own', p)));
  pctx.up = false;
  ok('M1 a viewer window that is gone has no say', !pctx.stage('own', 'fullscreen') && pctx.stage('chat', 'fullscreen'));
  const handler = line(/setPermissionRequestHandler\(/);
  ok('M1 the screen and the microphone stay the chat page\'s alone', /stage\(wc, perm\) \|\| \(ours\(wc\) && \(perm === 'display-capture'/.test(handler));
  // one press, two ways in
  let now = 1000; const runs = []; const hctx = vm.createContext({ Date: { now: () => now }, SHORTCUTS: { hotkey: () => runs.push('hotkey'), modeHotkey: () => runs.push('mode'), fullHotkey: () => runs.push('full') } });
  vm.runInContext(`${line(/^const fired = /)} ${line(/^const fire = /)} this.fire = fire;`, hctx);
  hctx.fire('fullHotkey'); now += 50; hctx.fire('fullHotkey'); now += 100; hctx.fire('hotkey'); now += 500; hctx.fire('fullHotkey');
  ok('M1 a hotkey that comes from the OS and from the page within a moment runs once; a later press runs again', runs.join() === 'full,hotkey,full');
  ok('M1 the page can only name one of the three', /Object\.hasOwn\(SHORTCUTS, kind\) \? fire\(kind\) : false/.test(line(/^handle\('runHotkey'/)));
  // full screen through the page, and the plain way when the page says no
  const calls = []; let answer = true, isFs = false;
  const fctx = vm.createContext({ log: { info() {} }, setTimeout: (f) => f(), viewerFull: true });
  vm.runInContext(`${block(/^function pageFullscreen\(h, on\) \{/)} this.pageFullscreen = pageFullscreen; this.setWant = (v) => { viewerFull = v; };`, fctx);
  const h = { isDestroyed: () => false, isFullScreen: () => isFs, setFullScreen: (v) => { calls.push(`plain ${v}`); isFs = v; }, webContents: { executeJavaScript: (code, gesture) => { calls.push(`${/requestFullscreen/.test(code) ? 'enter' : 'leave'} gesture=${gesture}`); return Promise.resolve(answer); } } };
  (async () => {
    fctx.pageFullscreen(h, true); await tick(); await tick();
    ok('M1 full screen is asked of the page, with a user gesture, and the window is left to it', calls.join() === 'enter gesture=true');
    calls.length = 0; answer = false; fctx.pageFullscreen(h, true); await tick(); await tick();
    ok('M1 a page that says no: the plain window goes full screen', calls.join() === 'enter gesture=true,plain true');
    calls.length = 0; answer = true; fctx.setWant(false); fctx.pageFullscreen(h, false); await tick(); await tick();
    ok('M1 leaving: the page first, and the window after it if it is still full screen', calls.join() === 'leave gesture=true,plain false');
    // a click from the far side and the notice
    const through = []; let hidden = true;
    const nctx = vm.createContext({ NOTICE_THROUGH: false, protectionOn: true, captureSupport: () => ({ supported: hidden }), control: { status: () => ({ display: { bounds: { x: 100, y: 50, width: 1000, height: 500 } } }) }, accessCard: { through: (p) => through.push(`${p.x},${p.y}`) } });
    vm.runInContext(`${block(/^function noticeThrough\(ev\) \{/)} this.noticeThrough = noticeThrough;`, nctx);
    nctx.noticeThrough({ t: 'b', b: 0, d: 1, x: 0.5, y: 0.5 }); nctx.noticeThrough({ t: 'w', dx: 0, dy: 3, x: 0, y: 1 }); nctx.noticeThrough({ t: 'b', x: 7, y: -3 });
    ok('M1 a click or a scroll from the far side is given to the notice as a point of the shared display', through.join(' ') === '600,300 100,550 1100,50');
    through.length = 0; nctx.noticeThrough({ t: 'm', x: 0.5, y: 0.5 }); nctx.noticeThrough({ t: 'k', c: 'KeyA', d: 1 }); nctx.noticeThrough(null);
    ok('M1 a pointer move or a key is not', through.length === 0);
    hidden = false; nctx.noticeThrough({ t: 'b', x: 0.5, y: 0.5 });
    ok('M1 where the notice is in their picture it takes their click like anything else', through.length === 0);
    const inp = lines.findIndex((x) => /^ipcMain\.on\('input'/.test(x)), body = lines.slice(inp, inp + 6).join('\n');
    ok('M1 only an event with the token of the grant that is on reaches the notice, and before the helper posts it', /if \(g && !g\.pending && token === g\.token\) noticeThrough\(ev\);[^\n]*\n\s*grant\.input\(token, ev\);/.test(body));
  })().catch((e) => { console.log('FAIL  M1 threw:', e.stack); process.exitCode = 1; });
}
