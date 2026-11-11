// The share code of the renderer (ui/share/*.js) without a window: the parts that are plain logic.
// Each of those files is one closure that hangs its part on window.ShareKit and reads the app's
// globals only when called, so it loads into a bare context that has just what a test hands in.
// At the end, main's memory of which share already raised its pop-up (main/sharepop.js).
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const pages = new WeakMap();   // the context a ShareKit was loaded into, for what a file puts on window beside it (window.Share)
function load(files, globals = {}) {
  const ctx = vm.createContext(Object.defineProperties({ console, setTimeout, clearTimeout }, Object.getOwnPropertyDescriptors(globals)));   // a getter stays a getter
  ctx.window = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'share', f), 'utf8'), ctx, { filename: f });
  pages.set(ctx.ShareKit, ctx);
  return ctx.ShareKit;
}
const js = (v) => JSON.stringify(v);   // values made inside the context are compared as text

// C1: a pointer picture has to fit one data-channel message
{
  const sent = [], K = load(['kit.js', 'control.js']);
  K.sessions = { dc: (_sess, label, msg) => { sent.push({ label, msg }); return true; } };
  const sess = { pc: { sctp: { maxMessageSize: 262144 } }, ctl: { give: 'on' } };
  K.control.owner = { sess, token: 'tok' };
  const pic = (n) => ({ token: 'tok', w: 16, h: 16, pw: 32, ph: 32, hx: 1, hy: 2, png: 'A'.repeat(n) });
  const size = (n) => { const c = pic(n); return JSON.stringify({ t: 'cur', w: c.w, h: c.h, pw: c.pw, ph: c.ph, hx: c.hx, hy: c.hy, png: c.png }).length; };
  K.control.onCursor(pic(400));
  ok('C1 a small picture goes out on ctl, without the token', sent.length === 1 && sent[0].label === 'ctl' && Object.keys(sent[0].msg).join() === 't,w,h,pw,ph,hx,hy,png' && sent[0].msg.t === 'cur' && sent[0].msg.png.length === 400);
  const fill = 262144 - size(0);
  K.control.onCursor(pic(fill));
  ok('C1 a message of exactly the size the connection takes goes out', size(fill) === 262144 && sent.length === 2);
  K.control.onCursor(pic(fill + 1)); K.control.onCursor(pic(300000));
  ok('C1 one byte more is left out, and so is the largest picture main lets through', sent.length === 2);
  sess.pc.sctp = null;
  K.control.onCursor(pic(fill + 1)); K.control.onCursor(pic(fill));
  ok('C1 a connection that does not say its size is taken at 262144 bytes', K.DC_FIT === 262144 && sent.length === 3);
  sess.pc.sctp = { maxMessageSize: 1000 };
  K.control.onCursor(pic(2000)); K.control.onCursor(pic(400));
  ok('C1 the size the connection gives is the one that counts', sent.length === 4);
  K.control.onCursor({ ...pic(400), token: 'other' }); sess.ctl.give = 'off'; K.control.onCursor(pic(400));
  ok('C1 and a picture still goes out only with the token of the grant, while control is on', sent.length === 4);
}

// T1: what each viewer's encoder gets, by the size of the audience
{
  const K = load(['kit.js', 'tune.js'], { console: { error() {} } }), t = K.tune;   // quiet: one case below makes the sender refuse
  ok('T1 the caps: six sessions, four contacts get my screen', K.MAX_SESSIONS === 6 && t.MAX_AUDIENCE === 4);
  ok('T1 one viewer and two get the one-to-one values', js(t.tier(1, false)) === '{"kbps":8000,"fps":30,"maxW":2560}' && js(t.tier(2, false)) === js(t.tier(1, false)));
  ok('T1 and their encoder object is the one a single share always had', js(t.encoding(t.tier(1, false))) === '{"maxBitrate":8000000,"maxFramerate":30}' && js(t.encoding(t.tier(2, false))) === '{"maxBitrate":8000000,"maxFramerate":30}');
  ok('T1 three viewers: 5 Mb/s, 20 fps, 1920 wide', js(t.tier(3, false)) === '{"kbps":5000,"fps":20,"maxW":1920}');
  ok('T1 four and more: 4 Mb/s, 15 fps, 1920 wide', js(t.tier(4, false)) === '{"kbps":4000,"fps":15,"maxW":1920}' && js(t.tier(6, false)) === js(t.tier(4, false)));
  ok('T1 the viewer who controls keeps 30 fps and at least 5 Mb/s', js(t.tier(4, true)) === '{"kbps":5000,"fps":30,"maxW":1920}' && js(t.tier(3, true)) === '{"kbps":5000,"fps":30,"maxW":1920}' && js(t.tier(1, true)) === js(t.tier(1, false)));
  // a session as tune.sender sees it: the clone's width, and a sender that records what it is given
  const fake = (width) => { const set = []; return { set, width, closed: false, scaled: false, screenTrack: { getSettings() { return { width: this.w() }; }, w: null }, screenSender: { getParameters: () => ({ transactionId: 'tx', encodings: [{ active: true, maxBitrate: 1 }] }), setParameters: async (p) => { set.push(js(p)); } } }; };
  const run = async (x, tier) => { x.screenTrack.w = () => x.width; await t.sender(x, tier); return x.set[x.set.length - 1]; };
  (async () => {
    const a = fake(1920);
    ok('T1 sender: a one-viewer share gets exactly the two values, in the parameters it read', await run(a, t.tier(1, false)) === '{"transactionId":"tx","encodings":[{"maxBitrate":8000000,"maxFramerate":30}]}' && a.scaled === false);
    ok('T1 sender: a clone as wide as the tier allows is not scaled', await run(a, t.tier(4, false)) === '{"transactionId":"tx","encodings":[{"maxBitrate":4000000,"maxFramerate":15}]}' && a.scaled === false);
    const b = fake(2560);
    ok('T1 sender: a wider one is scaled down to the tier, by its own width', await run(b, t.tier(3, false)) === `{"transactionId":"tx","encodings":[{"maxBitrate":5000000,"maxFramerate":20,"scaleResolutionDownBy":${2560 / 1920}}]}` && b.scaled === true);
    ok('T1 sender: back at two viewers the scaling is taken off again (the key stays, at 1)', await run(b, t.tier(2, false)) === '{"transactionId":"tx","encodings":[{"maxBitrate":8000000,"maxFramerate":30,"scaleResolutionDownBy":1}]}');
    b.width = 3840;
    ok('T1 sender: the width is read again on every call', await run(b, t.tier(3, false)) === '{"transactionId":"tx","encodings":[{"maxBitrate":5000000,"maxFramerate":20,"scaleResolutionDownBy":2}]}');
    const c = fake(1920); let refused = 0; c.screenSender.setParameters = async () => { refused++; throw new Error('refused'); };
    let threw = false; try { await run(c, t.tier(1, false)); } catch { threw = true; }
    const d = fake(1920); d.screenSender = null; await run(d, t.tier(1, false));
    ok('T1 sender: a set that keeps being refused is given up after three tries and not thrown on; a session without a screen sender is left alone', threw === false && refused === 3 && d.set.length === 0);
    const e = fake(1920), take = e.screenSender.setParameters; let asked = 0;
    e.screenSender.setParameters = async (p) => { if (++asked === 1) throw new Error('modified RTCP parameters'); return take(p); };   // a negotiation changed them underneath, once
    ok('T1 sender: a set refused once is read and set again', await run(e, t.tier(3, false)) === '{"transactionId":"tx","encodings":[{"maxBitrate":5000000,"maxFramerate":20}]}' && asked === 2 && e.set.length === 1);
    const f = fake(1920), waiting = []; f.screenTrack.w = () => 1920;
    f.screenSender.setParameters = (p) => new Promise((res, rej) => waiting.push({ p: js(p), res, rej }));
    const older = t.sender(f, t.tier(4, false)), newer = t.sender(f, t.tier(2, false));
    waiting[0].rej(new Error('refused')); waiting[1].res(); await older; await newer;
    ok('T1 sender: a refused set is not tried again once a later call has taken over', waiting.length === 2 && waiting[1].p === '{"transactionId":"tx","encodings":[{"maxBitrate":8000000,"maxFramerate":30}]}');
  })().catch((e) => { console.log('FAIL  T1 sender threw:', e.stack); process.exitCode = 1; });
}

// A1: the audience, counted, in words and as the picker lists it
{
  const names = { a: 'Ann', b: 'Bob', c: 'Cy', d: 'Dee', e: 'Eve' }, sessions = {};
  let paints = 0;
  const K = load(['kit.js', 'tune.js', 'cast.js'], { contact: (pub) => (names[pub] ? { pub, name: names[pub] } : undefined) });
  K.sessions = { get: (pub) => sessions[pub] || null, all: () => Object.values(sessions) }; K.control = { owner: null }; K.clip = { link: null }; K.paint = () => { paints++; };
  const cast = K.cast, m = cast.members, put = (pub, state) => m.set(pub, { state, mode: 'one', timer: null });
  ok('A1 nobody: count 0', cast.count() === 0 && cast.text(false) === 'Sharing your screen');
  put('b', 'live');
  ok('A1 one viewer', cast.count() === 1 && cast.text(false) === 'Sharing your screen with Bob');
  put('a', 'joining');
  ok('A1 two, by name, joining counts', cast.count() === 2 && cast.text(false) === 'Sharing your screen with Ann and Bob');
  put('c', 'live');
  ok('A1 three', cast.count() === 3 && cast.text(false) === 'Sharing your screen with Ann, Bob and Cy');
  m.get('c').state = 'away';
  ok('A1 one who is away is not counted and is named apart', cast.count() === 2 && cast.text(false) === 'Sharing your screen with Ann and Bob (Cy reconnecting)');
  sessions.b = { pub: 'b', screenTrack: {}, remote: { rec: false }, ctl: { give: 'on' } }; K.control.owner = { sess: sessions.b, token: 't' };
  ok('A1 who controls', cast.text(false) === 'Sharing your screen with Ann and Bob (Cy reconnecting) · Bob controls it');
  sessions.a = { pub: 'a', screenTrack: {}, remote: { rec: true }, ctl: { give: 'off' } };
  ok('A1 who records', cast.text(false) === 'Sharing your screen with Ann and Bob (Cy reconnecting) · Bob controls it · Ann records');
  sessions.b.remote.rec = true;
  ok('A1 two who record', cast.text(false).endsWith(' · Ann and Bob record'));
  const anon = cast.text(true);
  ok('A1 where this window is in the picture the line names nobody', anon === 'Sharing your screen with 2 contacts (1 reconnecting) · controlled · recorded' && !/Ann|Bob|Cy/.test(anon));
  sessions.b.ctl.give = 'asked'; sessions.b.remote.rec = false; sessions.a.remote.rec = false;
  ok('A1 a request that is only asked is not control', cast.text(false) === 'Sharing your screen with Ann and Bob (Cy reconnecting)');
  sessions.b.ctl.give = 'on'; K.clip.link = { sess: sessions.b, role: 'give' };
  ok('A1 the clipboard that is shared with whoever controls', cast.text(false) === 'Sharing your screen with Ann and Bob (Cy reconnecting) · Bob controls it · clipboard shared' && cast.text(true) === 'Sharing your screen with 2 contacts (1 reconnecting) · controlled · clipboard shared');
  K.clip.link = { sess: sessions.a, role: 'take' };
  ok('A1 a clipboard I share as the viewer of someone else\'s screen is not in the line about mine', !/clipboard/.test(cast.text(false)));
  sessions.b.ctl.give = 'asked'; K.clip.link = null;
  m.delete('a'); m.delete('c');
  ok('A1 one contact, anonymous', cast.text(true) === 'Sharing your screen with 1 contact');
  // the picker
  const contacts = [{ pub: 'e', name: 'Eve', status: 'offline' }, { pub: 'b', name: 'Bob', status: 'online' }, { pub: 'a', name: 'Ann', status: 'online' }, { pub: 'c', name: 'Cy', status: 'connecting' }, { pub: 'd', name: 'Dee', status: 'online' }];
  m.clear();
  let r = cast.rows(contacts, 'a');
  ok('A1 picker: rows by name', r.map((x) => x.name).join() === 'Ann,Bob,Cy,Dee,Eve');
  ok('A1 picker: with no audience the open chat is ticked, nothing else', r.map((x) => +x.ticked).join('') === '10000');
  ok('A1 picker: a contact who is not online is marked and cannot be ticked', r.map((x) => x.state).join() === ',,offline,,offline' && r.map((x) => +x.free).join('') === '11010');
  ok('A1 picker: an open chat whose contact is offline is not ticked', cast.rows(contacts, 'e').every((x) => !x.ticked));
  put('b', 'live'); put('d', 'joining'); put('e', 'away');
  r = cast.rows(contacts, 'a');
  ok('A1 picker: with an audience it is the audience that is ticked, not the open chat', r.map((x) => +x.ticked).join('') === '01011');
  ok('A1 picker: watching, joining, reconnecting', r.map((x) => x.state).join() === ',watching,offline,joining…,reconnecting…');
  ok('A1 picker: one of the audience who is offline can stay ticked or be ticked again', r[4].free === true && cast.locked(r[4].free, false, 2) === false);
  ok('A1 picker: at four ticked every box without a tick is locked, the ticked ones are not', cast.locked(true, false, 4) && !cast.locked(true, true, 4) && !cast.locked(true, false, 3) && cast.locked(false, false, 0));
  K.tune.MAX_AUDIENCE = 1;
  ok('A1 picker: the limit is read when asked', cast.locked(true, false, 1) && !cast.locked(true, false, 0));
  K.tune.MAX_AUDIENCE = 4;
  // what a sharer says about its audience
  const told = { remote: { cast: 0 } };
  cast.onTold(told, { t: 'cast', n: 3 }); const three = told.remote.cast;
  cast.onTold(told, { t: 'cast', n: 16 }); const top = told.remote.cast;
  const bad = [17, -1, 2.5, '3', null, undefined, {}].map((n) => { cast.onTold(told, { t: 'cast', n }); return told.remote.cast; });
  ok('A1 a viewer keeps the count it is told only when it is a whole number from 0 to 16', three === 3 && top === 16 && bad.every((n) => n === 0) && paints === 9);
}

// L1: the capture stops with its last lease, also when that lease goes while a microphone is being started (the microphone call does not hold the screen)
{
  let answerMic = null, ended = 0;
  const made = [], track = (kind) => { const t = { kind, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; }, clone: () => track(kind), applyConstraints: async () => {} }; made.push(t); return t; };
  const K = load(['kit.js', 'tune.js', 'cast.js'], { toast() {}, renderContacts() {},
    navigator: { mediaDevices: { getDisplayMedia: async () => ({ getVideoTracks: () => [track('video')] }), getUserMedia: () => new Promise((res) => { answerMic = () => res({ getAudioTracks: () => [track('audio')] }); }) } },
    api: { screenPermission: async () => 'ok', micPermission: async () => true, captureEnded: async () => { ended++; return true; } } });
  K.paint = () => {}; K.sessions = { sendState() {}, all: () => [] }; K.control = { owner: null };
  (async () => {
    const sess = { pub: 'b', closed: false, ready: Promise.resolve(), screenTrack: null, micTrack: null };
    const live = await K.capture.acquire();
    sess.screenTrack = K.capture.lease(sess);
    const talking = K.cast.talk(sess);                       // the microphone button: its start waits on the device
    await new Promise((r) => setTimeout(r, 5));
    K.capture.release(sess); sess.screenTrack = null; sess.closed = true; K.capture.settle();   // the share ends meanwhile
    ok('L1 a capture whose last lease went during a microphone start stops then: that call waits for the microphone, not for the screen', live === true && K.cast.adding === 1 && K.capture.state === 'idle' && K.capture.leases.size === 0 && ended === 1);
    answerMic(); await talking;
    ok('L1 and when the call ends no device is left on, main told once', K.cast.adding === 0 && K.capture.state === 'idle' && K.mic.state === 'idle' && ended === 1 && made.length === 3 && made.every((t) => t.readyState === 'ended'));
  })().catch((e) => { console.log('FAIL  L1 threw:', e.stack); process.exitCode = 1; });
}

// L2: a Share click whose capture does not start closes only the session it opened itself
{
  const closed = [], held = new Map();
  let perm = null;
  const K = load(['kit.js', 'tune.js', 'cast.js'], { toast() {}, renderContacts() {}, contact: (pub) => ({ pub, name: pub, status: 'online' }), showScreenPermission() {},
    api: { screenPermission: () => new Promise((res) => { perm = () => res('denied'); }), captureEnded: async () => true } });
  K.paint = () => {}; K.control = { owner: null };
  const mk = (pub, seen) => ({ pub, seen, closed: false, ready: Promise.resolve(), remote: { screen: false, mic: false }, screenTrack: null, micTrack: null });
  K.sessions = { get: (pub) => held.get(pub) || null, open: (pub) => { const x = mk(pub, false); held.set(pub, x); return x; }, all: () => [...held.values()], close: (x, why) => { x.closed = true; closed.push(`${x.pub}:${why}`); } };
  (async () => {
    held.set('theirs', mk('theirs', true));                     // their offer is in, their state frame is not: nothing flows yet
    const a = K.cast.add('theirs', 'one'), b = K.cast.add('mine', 'one'), c = K.cast.add('both', 'one');
    held.get('both').seen = true;                               // a session this click opened, and their own share arrives in it meanwhile
    await new Promise((r) => setTimeout(r, 5)); perm();
    const r = [await a, await b, await c];
    ok('L2 no capture: every call fails and nobody is left in the audience', r.join() === 'false,false,false' && K.cast.members.size === 0 && K.cast.adding === 0 && K.capture.state === 'idle');
    ok('L2 the session the click opened for nothing is closed; one the contact opened, or spoke in meanwhile, is not', closed.join() === 'mine:capture' && !held.get('theirs').closed && !held.get('both').closed);
  })().catch((e) => { console.log('FAIL  L2 threw:', e.stack); process.exitCode = 1; });
}

// The control code (share/control.js) in a world that records what it sends, shows and asks main for.
// Time and timers are the test's: `now` is what Date.now() gives, a timer runs only when the test fires it.
function controlWorld() {
  const w = { now: 1e12, sent: [], toasts: [], dialogs: [], asks: [], grants: [], revoked: [], timers: [], synced: [], settings: {}, ticked: true, keys: 0 };
  w.K = load(['kit.js', 'tune.js', 'control.js'], { S: { settings: w.settings }, toast: (t) => w.toasts.push(t), ipcErr: (e) => String((e && e.message) || e), contact: (pub) => ({ pub, name: pub[0].toUpperCase() + pub.slice(1) }),
    Date: { now: () => w.now }, setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; w.timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; },
    api: { controlGrant: (pub, clip) => new Promise((res) => w.grants.push({ pub, clip, res })), controlRevoke: async (token) => { w.revoked.push(token); return true; }, input() {} } });
  w.K.sessions = { dc: (sess, _label, msg) => { w.sent.push(`${sess.pub}:${JSON.stringify(msg)}`); return true; } };
  w.K.viewer = { bound: null, applyCtl() {}, showAsk: (sess, o) => { w.dialogs.push(sess.pub); w.asks.push(o); }, clipTicked: () => w.ticked, syncKeys: () => { w.keys++; } };   // clipTicked: the clipboard box of the dialog, as the test leaves it
  w.K.clip = { link: null, sync: (sess) => w.synced.push(sess.pub), off() {} };
  w.K.cast = { retier() {}, members: new Map() }; w.K.paint = () => {}; w.K.unprompt = () => {};
  w.sess = (pub) => ({ pub, closed: false, screenTrack: { contentHint: '' }, remote: { screen: true }, ctl: { give: 'off', take: false, asked: false, askTimer: null, flush: null, move: null, cursor: null, token: null, giveClip: false, takeClip: false, askedClip: false } });
  w.from = (sess, msg) => w.K.control.onMessage(sess, msg);       // a message of theirs, as the session hands it on
  return w;
}
const tick = () => new Promise((r) => setImmediate(r));

// R3: a grant that comes back for a request that was withdrawn does not answer the request made after it
{
  (async () => {
    const w = controlWorld(), C = w.K.control, bob = w.sess('bob');
    w.from(bob, { t: 'req' }); C.allow(); await tick();
    w.from(bob, { t: 'rel' }); w.from(bob, { t: 'req' });       // lets go while main starts the grant, asks anew: a second dialog
    const open = C.pending && C.pending.sess === bob && bob.ctl.give === 'asked' && w.dialogs.length === 2;
    w.sent.length = 0; w.grants[0].res({ ok: true, token: 'stale' }); await tick();
    ok('R3 the stale grant is handed back, and the open request stays asked with nothing said to the viewer', open && w.revoked.join() === 'stale' && C.owner === null && C.pending && C.pending.sess === bob && bob.ctl.give === 'asked' && w.sent.length === 0);
    C.allow(); await tick(); w.grants[1].res({ ok: true, token: 'fresh' }); await tick();
    ok('R3 Allow on that dialog then grants it', C.owner && C.owner.token === 'fresh' && bob.ctl.give === 'on' && w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":0}');
    const v = controlWorld(), D = v.K.control, cy = v.sess('cy');
    v.from(cy, { t: 'req' }); D.allow(); await tick(); v.from(cy, { t: 'rel' }); v.sent.length = 0;
    v.grants[0].res({ ok: true, token: 'stale' }); await tick();
    ok('R3 with no new request the stale grant still ends in a plain no', v.revoked.join() === 'stale' && cy.ctl.give === 'off' && v.sent.join() === 'cy:{"t":"ctl","on":false,"why":"notsharing"}');
  })().catch((e) => { console.log('FAIL  R3 threw:', e.stack); process.exitCode = 1; });
}

// R4: a request that is taken back starts the same cooldown as a Deny; one that ran out unanswered does not
{
  const w = controlWorld(), C = w.K.control, bob = w.sess('bob');
  for (let i = 0; i < 50; i++) { w.from(bob, { t: 'req' }); w.from(bob, { t: 'rel' }); }
  w.from(bob, { t: 'req' });
  ok('R4 fifty-one requests with fifty withdrawals in between open the dialog once', w.dialogs.length === 1 && C.pending === null && bob.ctl.give === 'off');
  w.now += w.K.DENY_COOLDOWN_MS - 1; w.from(bob, { t: 'req' }); const early = w.dialogs.length;
  w.now += 2; w.from(bob, { t: 'req' });
  ok('R4 and the next one comes up when the cooldown is over, not before', early === 1 && w.dialogs.length === 2 && C.pending && C.pending.sess === bob);
  w.sent.length = 0; w.timers.filter((t) => t.on && t.ms === w.K.tune.GIVE_ASK_MS).forEach((t) => t.fn());   // nobody answers: the dialog gives up
  w.now += 1000; w.from(bob, { t: 'req' });
  ok('R4 a request that ran out is told so, and the next one opens the dialog at once: nobody had seen the first', w.sent.join() === 'bob:{"t":"ctl","on":false,"why":"expired"}' && w.dialogs.length === 3 && C.pending && C.pending.sess === bob);
}

// R5: a prompt closes its own modal, also when another one was opened on top of it
{
  const st = { open: null, hidden: new Set(['mSettings', 'mControl', 'backdrop']), closes: 0 };
  const K = load(['kit.js'], { $: (id) => ({ classList: { contains: (c) => c === 'hidden' && st.hidden.has(id), add: () => st.hidden.add(id) } }), get openModal() { return st.open; },
    closeModal: () => { st.closes++; st.hidden.add(st.open); st.hidden.add('backdrop'); st.open = null; } });   // as ui/app.js closes "the open modal"
  const show = (id) => { st.open = id; st.hidden.delete(id); st.hidden.delete('backdrop'); };
  show('mControl'); K.unprompt('mControl');
  ok('R5 a prompt that is the open modal is closed the way the app closes one', st.closes === 1 && st.hidden.has('mControl') && st.hidden.has('backdrop') && st.open === null);
  show('mControl'); show('mSettings'); K.unprompt('mControl');
  ok('R5 with another modal opened over it only the prompt goes: that modal and the backdrop stay', st.closes === 1 && st.hidden.has('mControl') && !st.hidden.has('mSettings') && !st.hidden.has('backdrop') && st.open === 'mSettings');
  K.unprompt('mControl');
  ok('R5 a prompt that is not on screen closes nothing', st.closes === 1 && st.open === 'mSettings' && !st.hidden.has('mSettings'));
}

// R6: Allow is disarmed from the moment the dialog can be seen: when it opens, and again when the window is shown or focused
{
  const els = new Map(), timers = [], win = {}; let active = null;
  const $ = (id) => { if (!els.has(id)) { const hid = new Set(); els.set(id, { id, disabled: false, textContent: '', title: '', style: {}, classList: { contains: (c) => hid.has(c), add: (c) => hid.add(c), remove: (c) => hid.delete(c), toggle() {} }, focus() { active = id; }, addEventListener() {}, requestVideoFrameCallback() {} }); } return els.get(id); };
  const K = load(['kit.js', 'tune.js', 'viewer.js'], { $, S: { current: null }, contact: () => ({ verified: true }), toast() {}, document: { addEventListener() {} },
    addEventListener: (t, f) => { win[t] = f; }, setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; } });
  const run = (ms) => { for (const t of timers.splice(0)) if (t.on && t.ms <= ms) t.fn(); else if (t.on) timers.push(t); };   // fires what is due within ms, keeps the rest
  const sess = { pub: 'bobbobbobbob' }; $('mControl').classList.add('hidden');
  K.control = { pending: { sess }, isTaking: () => false }; K.clip = { poke() {} }; K.prompt = (id) => $(id).classList.remove('hidden');
  K.viewer.showAsk(sess);
  const atOpen = $('controlYes').disabled; run(60); const focusAtOpen = active; run(K.ARM_MS);
  ok('R6 the dialog opens with Allow disarmed and the keyboard on Deny, and arms after K.ARM_MS', atOpen === true && focusAtOpen === 'controlNo' && $('controlYes').disabled === false && $('controlWho').textContent === '(verified, key bobbobbo)');
  active = 'input';                                             // the window was hidden: showing it puts the keyboard in the composer (ui/app.js)
  K.viewer.seen();
  const again = $('controlYes').disabled; run(60); const focusAgain = active, still = $('controlYes').disabled; run(K.ARM_MS);
  ok('R6 shown again with the request still open: disarmed anew for K.ARM_MS, the keyboard back on Deny', again === true && focusAgain === 'controlNo' && still === true && $('controlYes').disabled === false);
  active = 'input'; win.focus();
  ok('R6 the same when the window gets the focus', $('controlYes').disabled === true && (run(60), active) === 'controlNo');
  run(K.ARM_MS); K.control.pending = null; active = 'input'; K.viewer.seen(); win.focus(); run(K.ARM_MS);
  ok('R6 with no request pending nothing is touched', $('controlYes').disabled === false && active === 'input' && timers.length === 0);
}

// R7: the cooldown after a Deny belongs to the contact, not to the session
{
  const w = controlWorld(), C = w.K.control, bob = w.sess('bob'), cy = w.sess('cy');
  w.from(bob, { t: 'req' }); C.deny('denied');
  w.now += 2000;
  const again = w.sess('bob');                                  // he ended the share, I shared again: a new session with the same contact
  w.sent.length = 0; w.from(again, { t: 'req' });
  ok('R7 Deny, a new session two seconds later, the same contact asks: no dialog, a plain no', w.dialogs.length === 1 && C.pending === null && again.ctl.give === 'off' && w.sent.join() === 'bob:{"t":"ctl","on":false}');
  w.from(cy, { t: 'req' });
  ok('R7 another contact is not held off by it', w.dialogs.join() === 'bob,cy' && C.pending && C.pending.sess === cy);
  C.deny('denied'); w.now += w.K.DENY_COOLDOWN_MS - 2000 + 1; w.from(again, { t: 'req' });
  ok('R7 ten seconds after the Deny the first contact gets the dialog again', w.dialogs.join() === 'bob,cy,bob' && C.pending.sess === again);
}

// R8: what a peer can trigger without being asked is said once per session in a cooldown
{
  const w = controlWorld(), C = w.K.control, alice = w.sess('alice');
  for (let i = 0; i < 20; i++) w.from(alice, { t: 'ctl', on: true });     // I watch Alice and never asked
  ok('R8 twenty grants nobody asked for: none taken, each handed back, one toast', alice.ctl.take === false && C.taking === null && w.sent.length === 20 && w.sent.every((x) => x === 'alice:{"t":"rel"}') && w.toasts.join() === 'Alice allowed control after your request ran out: ask again');
  for (let i = 0; i < 20; i++) w.from(alice, { t: 'ctl', on: false });
  ok('R8 twenty refusals of nothing: one toast more', w.toasts.length === 2 && w.toasts[1] === 'Alice did not allow control');
  w.K.viewer.bound = alice; w.sent.length = 0; C.ask(alice); w.from(alice, { t: 'ctl', on: false, why: 'busy' }); C.ask(alice); w.from(alice, { t: 'ctl', on: false });
  ok('R8 an answer to a request I did make is always shown', w.toasts.slice(2).join('|') === "Alice's screen is being controlled by someone else|Alice did not allow control" && alice.ctl.asked === false);
  w.now += w.K.DENY_COOLDOWN_MS + 1; w.from(alice, { t: 'ctl', on: true }); w.from(alice, { t: 'ctl', on: true });
  ok('R8 after the cooldown the next unasked one is said again, once', w.toasts.length === 5);
  const v = controlWorld(), D = v.K.control, bob = v.sess('bob'), cy = v.sess('cy'), dee = v.sess('dee');
  v.from(bob, { t: 'req' });
  for (let i = 0; i < 20; i++) v.from(cy, { t: 'req' });
  v.from(dee, { t: 'req' });
  ok('R8 twenty requests of a second viewer while the first one\'s dialog is open: twenty times busy, one toast per asker', v.dialogs.join() === 'bob' && v.sent.filter((x) => x === 'cy:{"t":"ctl","on":false,"why":"busy"}').length === 20 && v.toasts.join('|') === 'Cy also asked for control|Dee also asked for control' && D.pending.sess === bob);
}

// N1: the clip channel: what may open it, what it carries, and what it may not
{
  const got = [], K = load(['kit.js', 'session.js']);
  K.clip = { onPart: (sess, m) => got.push(`part:${sess.pub}:${m.i}`), off: (sess, why) => got.push(`off:${sess.pub}:${why}`), channelClosed: (sess) => got.push(`closed:${sess.pub}`) };
  K.control = { onMessage: (sess, m) => got.push(`control:${m.t}`) }; K.cast = { onTold: () => got.push('cast'), tell() {} }; K.tune = { MOVE_BUF: 1024 };
  const chan = (label) => ({ label, readyState: 'open', bufferedAmount: 0, out: [], send(d) { this.out.push(d); }, addEventListener() {} });
  const mk = () => ({ pub: 'bob', ctl: { dc: null, mv: null, cp: null, chans: [], sent: 0, recv: 0, askedClip: false, takeClip: false } });
  const say = (ch, m) => ch.onmessage({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  let sess = mk(), ch = chan('clip');
  K.sessions.adopt(sess, ch, true);
  ok('N1 a clip channel a peer opens while I have offered it nothing gets no handler and no slot', ch.onmessage === undefined && sess.ctl.cp === null && sess.ctl.chans.length === 0);
  sess.ctl.askedClip = true; K.sessions.adopt(sess, ch, true);
  ok('N1 with my offer out to that peer it is taken', typeof ch.onmessage === 'function' && sess.ctl.cp === ch);
  sess = mk(); sess.ctl.takeClip = true; ch = chan('clip'); K.sessions.adopt(sess, ch, true);
  ok('N1 and with the offer taken up', sess.ctl.cp === ch);
  sess = mk(); ch = chan('clip'); K.sessions.adopt(sess, ch);
  ok('N1 the one this side opens itself is always its own', sess.ctl.cp === ch);
  const x = chan('x'); K.sessions.adopt(sess, x, true);
  ok('N1 any other label is still left alone', x.onmessage === undefined);
  const ctl = chan('ctl'), mv = chan('move'); K.sessions.adopt(sess, ctl, true); K.sessions.adopt(sess, mv, true);
  say(ch, { t: 'clip', id: 1, i: 0, n: 1, d: 'a' });
  ok('N1 a clip message on the clip channel reaches the link', got.join() === 'part:bob:0' && sess.ctl.recv === 1);
  for (const m of [{ t: 'req' }, { t: 'req', clip: 1 }, { t: 'ctl', on: true, clip: 1 }, { t: 'm', x: 0.5, y: 0.5 }, { t: 'k', c: 'KeyA', d: 1 }, { t: 'clipoff' }, { t: 'cast', n: 3 }, { t: 'rel' }]) say(ch, m);
  ok('N1 nothing else does: no request, answer, input or clipoff is read from it', got.length === 1 && sess.ctl.recv === 9);
  say(ctl, { t: 'clip', id: 1, i: 0, n: 1, d: 'a' }); say(mv, { t: 'clip', id: 1, i: 0, n: 1, d: 'a' });
  ok('N1 a clip message on ctl or move is dropped', got.length === 1);
  say(ctl, { t: 'clipoff' });
  ok('N1 clipoff on ctl ends the clipboard of that session, as the peer\'s doing', got[1] === 'off:bob:peer');
  say(ch, 'x'.repeat(K.DC_MAX + 1)); say(ch, 'not json'); ch.onmessage({ data: new ArrayBuffer(8) });
  ok('N1 a clip message that is too long, not JSON or not text is dropped as on any channel', got.length === 2);
  ok('N1 text goes out on the clip channel only, and only while there is one', K.sessions.dc(sess, 'clip', { t: 'clip' }) === true && ch.out.length === 1 && ctl.out.length === 0 && mv.out.length === 0 && K.sessions.dc(mk(), 'clip', { t: 'clip' }) === false);
  ch.readyState = 'closed';
  ok('N1 and not on one that closed', K.sessions.dc(sess, 'clip', { t: 'clip' }) === false && ch.out.length === 1);
  ch.readyState = 'open';
  const second = chan('clip'); K.sessions.adopt(sess, second);
  ok('N1 the slot is the first channel while that one is open', sess.ctl.cp === ch);
  second.onclose();
  ok('N1 a channel that is not the slot closes without ending anything', sess.ctl.cp === ch && got.length === 2);
  ch.readyState = 'closed'; const third = chan('clip'); K.sessions.adopt(sess, third);
  ok('N1 a closed one gives the slot to the next', sess.ctl.cp === third);
  ch.onclose();
  ok('N1 and its late close event does not end the link of the new one', sess.ctl.cp === third && got.length === 2);
  third.onclose();
  ok('N1 the slot\'s channel closing clears the slot and ends the link', sess.ctl.cp === null && got[2] === 'closed:bob');
}

// The clipboard link of the renderer (share/clip.js) in a world that records what it asks main for and what it sends.
function clipWorld() {
  const w = { sent: [], starts: [], stops: [], applied: [], pokes: [], notes: [], made: [], settings: {}, applyOk: true };
  w.K = load(['kit.js', 'clip.js'], { S: { settings: w.settings }, api: {
    clipStart: (o) => new Promise((res) => w.starts.push({ o, res })), clipStop: async (id) => { w.stops.push(id); return true; },
    clipApply: async (id, text) => { w.applied.push({ id, text }); return w.applyOk; }, clipPoke: async (id) => { w.pokes.push(id); return true; } } });
  w.K.paint = () => {}; w.K.viewer = { bound: null, clipNote: (k) => w.notes.push(k) };
  w.K.sessions = { adopt: (sess, ch) => { sess.ctl.cp = ch; },
    dc: (sess, label, msg) => { const ch = label === 'clip' ? sess.ctl.cp : sess.ctl.dc; if (!ch || ch.readyState !== 'open') return false; w.sent.push({ to: sess.pub, label, msg }); return true; } };
  w.sess = (pub) => ({ pub, closed: false, pc: { createDataChannel: (label) => { const ch = { label, readyState: 'open', bufferedAmount: 0, close() { this.readyState = 'closed'; } }; w.made.push(ch); return ch; } },
    ctl: { give: 'off', take: false, giveClip: false, takeClip: false, token: null, cp: null, dc: { readyState: 'open' } } });
  // a session in which control with the clipboard is on, as the sharer or as the viewer, and main has answered
  w.give = async (pub, id) => { const sess = w.sess(pub); Object.assign(sess.ctl, { give: 'on', giveClip: true, token: 'tok-' + pub }); w.K.clip.sync(sess); w.starts[w.starts.length - 1].res({ ok: true, id }); await tick(); return sess; };
  w.take = async (pub, id) => { const sess = w.sess(pub); Object.assign(sess.ctl, { take: true, takeClip: true }); sess.ctl.cp = { label: 'clip', readyState: 'open', bufferedAmount: 0 }; w.K.clip.sync(sess); w.starts[w.starts.length - 1].res({ ok: true, id }); await tick(); return sess; };
  w.ctlSent = () => w.sent.filter((x) => x.label === 'ctl').map((x) => `${x.to}:${JSON.stringify(x.msg)}`).join('|');
  return w;
}
const waitFor = async (cond, ms = 400) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5)); return cond(); };

// X1: the link follows control, and nothing else starts it
{
  (async () => {
    let w = clipWorld(), clip = w.K.clip, bob = w.sess('bob');
    clip.sync(bob);
    ok('X1 no control, no link: main is not asked', clip.link === null && w.starts.length === 0);
    bob.ctl.give = 'on'; bob.ctl.token = 'tok'; clip.sync(bob);
    ok('X1 control without the clipboard flag: no link', clip.link === null && w.starts.length === 0);
    bob.ctl.give = 'asked'; bob.ctl.giveClip = true; clip.sync(bob);
    ok('X1 the flag without control being on (only asked): no link', clip.link === null && w.starts.length === 0);
    bob.ctl.give = 'on'; w.settings.clipboardSync = false; clip.sync(bob);
    ok('X1 control and flag but my switch off: no link', clip.link === null && w.starts.length === 0);
    w.settings.clipboardSync = true; bob.closed = true; clip.sync(bob);
    ok('X1 a closed session: no link', clip.link === null && w.starts.length === 0);
    bob.closed = false; clip.sync(bob);
    ok('X1 control on with the flag: the link is there at once, the sharer opens the clip channel, main is asked with the grant token', clip.link && clip.link.sess === bob && clip.link.role === 'give' && clip.link.id === null && w.made.length === 1 && w.made[0].label === 'clip' && bob.ctl.cp === w.made[0] && js(w.starts[0].o) === '{"pub":"bob","role":"give","token":"tok"}');
    clip.sync(bob);
    ok('X1 a second sync starts no second link', w.starts.length === 1 && w.made.length === 1);
    w.starts[0].res({ ok: true, id: '7' }); await tick();
    ok('X1 main answered: the link has its id', clip.link.id === '7');
    bob.ctl.give = 'off'; clip.sync(bob);
    ok('X1 control ends: the link ends in main, the peer is told, the channel is closed, both flags are gone', clip.link === null && w.stops.join() === '7' && w.ctlSent() === 'bob:{"t":"clipoff"}' && w.made[0].readyState === 'closed' && bob.ctl.cp === null && bob.ctl.giveClip === false && bob.ctl.takeClip === false);
    bob.ctl.give = 'on'; clip.sync(bob);
    ok('X1 off is final: control on again under the old flags starts nothing', clip.link === null && w.starts.length === 1);

    w = clipWorld(); clip = w.K.clip; const alice = w.sess('alice');
    alice.ctl.take = true; clip.sync(alice);
    ok('X1 viewer: driving without the flag starts nothing', clip.link === null);
    alice.ctl.takeClip = true; clip.sync(alice);
    ok('X1 viewer: driving with the flag starts a take link, opens no channel and names no token', clip.link.role === 'take' && w.made.length === 0 && js(w.starts[0].o) === '{"pub":"alice","role":"take","token":null}');
    w.starts[0].res({ ok: true, id: '3' }); await tick();
    alice.ctl.take = false; clip.sync(alice);
    ok('X1 viewer: I stop driving and the link ends', clip.link === null && w.stops.join() === '3' && alice.ctl.takeClip === false);

    w = clipWorld(); clip = w.K.clip; let sess = w.sess('bob'); Object.assign(sess.ctl, { give: 'on', giveClip: true, token: 't' });
    clip.sync(sess); w.starts[0].res({ ok: false, reason: 'nogrant' }); await tick();
    ok('X1 main says no: no link, flags gone, the peer told, the channel closed', clip.link === null && sess.ctl.giveClip === false && w.ctlSent() === 'bob:{"t":"clipoff"}' && w.made[0].readyState === 'closed' && w.stops.length === 0);
    w = clipWorld(); clip = w.K.clip; sess = w.sess('bob'); Object.assign(sess.ctl, { give: 'on', giveClip: true, token: 't' });
    clip.sync(sess); clip.off(sess, 'user'); w.starts[0].res({ ok: true, id: '9' }); await tick();
    ok('X1 switched off while main was asked: what main started is stopped again', clip.link === null && w.stops.join() === '9');
    w = clipWorld(); clip = w.K.clip; sess = w.sess('bob'); Object.assign(sess.ctl, { give: 'on', giveClip: true, token: 't' }); sess.pc.createDataChannel = () => { throw new Error('closed'); };
    clip.sync(sess);
    ok('X1 no channel can be opened: no link, and main is not asked', clip.link === null && w.starts.length === 0 && sess.ctl.giveClip === false);

    // one link per app
    w = clipWorld(); clip = w.K.clip; const first = await w.give('bob', '1'); const other = w.sess('cy'); Object.assign(other.ctl, { take: true, takeClip: true });
    w.sent.length = 0; clip.sync(other);
    ok('X1 a second session that had agreed while another has the link: told no, its flags cleared, the first link untouched', clip.link.sess === first && clip.link.id === '1' && other.ctl.takeClip === false && w.ctlSent() === 'cy:{"t":"clipoff"}' && w.starts.length === 1);
    w.sent.length = 0; clip.off(other, 'peer'); clip.channelClosed(other); clip.onPart(other, { t: 'clip', id: 1, i: 0, n: 1, d: 'x' }); await tick();
    ok('X1 what that other session does about a clipboard leaves the link alone', clip.link.sess === first && w.sent.length === 0 && w.applied.length === 0);

    // every way it ends
    for (const [why, tellsPeer, tellsMain] of [['user', true, true], ['setting', true, true], ['peer', false, true], ['main', true, false], ['failed', true, true]]) {
      w = clipWorld(); clip = w.K.clip; sess = await w.give('bob', '5'); w.sent.length = 0;
      clip.off(sess, why);
      ok(`X1 off (${why}): link gone, flags gone, channel closed${tellsPeer ? ', peer told' : ', nothing said back to the peer'}${tellsMain ? ', main told' : ', main not asked again'}`, clip.link === null && !sess.ctl.giveClip && w.made[0].readyState === 'closed' && (w.ctlSent() === 'bob:{"t":"clipoff"}') === tellsPeer && (w.stops.join() === '5') === tellsMain);
    }
    w = clipWorld(); clip = w.K.clip; sess = await w.give('bob', '5'); w.sent.length = 0; sess.closed = true; clip.sync(sess);
    ok('X1 the session closed: the link ends in main and nothing is sent into the closed session', clip.link === null && w.stops.join() === '5' && w.sent.length === 0);
    w = clipWorld(); clip = w.K.clip; sess = await w.give('bob', '5'); w.sent.length = 0; clip.channelClosed(sess);
    ok('X1 the clip channel closed under the link: off, as the peer\'s doing', clip.link === null && w.stops.join() === '5' && w.sent.length === 0);
    w = clipWorld(); clip = w.K.clip; sess = await w.take('alice', '5'); w.sent.length = 0; clip.off(sess, 'user');
    ok('X1 the viewer\'s side tells the peer and leaves the closing of the channel to the side that opened it', w.ctlSent() === 'alice:{"t":"clipoff"}' && sess.ctl.cp === null);
  })().catch((e) => { console.log('FAIL  X1 threw:', e.stack); process.exitCode = 1; });
}

// X2: text in and out of the link
{
  (async () => {
    let w = clipWorld(), clip = w.K.clip, sess = await w.give('bob', '4');
    const parts = () => w.sent.filter((x) => x.label === 'clip').map((x) => x.msg);
    clip.onLocal({ type: 'clip', id: '99', text: 'not my link' }); clip.onLocal({ type: 'clip', id: '4' }); clip.onLocal(null); await tick();
    ok('X2 an event of another link, or with no text, sends nothing', parts().length === 0);
    const long = 'a'.repeat(4096) + 'b'.repeat(4096) + 'c'.repeat(1808);
    clip.onLocal({ type: 'clip', id: '4', text: long }); await waitFor(() => clip.link.tx === 1);
    const p = parts();
    ok('X2 a copied text goes out in parts of 4096 units, numbered, under one id', p.length === 3 && p.every((m, i) => m.t === 'clip' && m.i === i && m.n === 3 && m.id === p[0].id) && p.map((m) => m.d.length).join() === '4096,4096,1808' && p.map((m) => m.d).join('') === long && clip.link.tx === 1);
    clip.onLocal({ type: 'clip', id: '4', text: 'short' }); await waitFor(() => clip.link.tx === 2);
    ok('X2 the next text has another id and one part', parts().length === 4 && parts()[3].n === 1 && parts()[3].id !== p[0].id && parts()[3].d === 'short');
    clip.onLocal({ type: 'clip', id: '4', text: 'x'.repeat(4096 * 16 + 1) }); await tick(); await tick();
    ok('X2 a text of more than 16 parts is not sent at all', parts().length === 4 && clip.link.tx === 2);
    sess.ctl.cp.bufferedAmount = 5000; clip.onLocal({ type: 'clip', id: '4', text: 'waits' }); await new Promise((r) => setTimeout(r, 60));
    const held = parts().length; sess.ctl.cp.bufferedAmount = 0; await waitFor(() => clip.link.tx === 3);
    ok('X2 a part goes out only when the channel has nothing queued', held === 4 && parts().length === 5 && parts()[4].d === 'waits');
    sess.ctl.cp.bufferedAmount = 5000; clip.onLocal({ type: 'clip', id: '4', text: 'never' }); await tick(); clip.off(sess, 'user'); await new Promise((r) => setTimeout(r, 60));
    ok('X2 a text that was waiting when the clipboard went off is not sent', parts().length === 5);
    clip.onLocal({ type: 'clip', id: '4', text: 'after off' }); await tick();
    ok('X2 and nothing is sent once the link is gone', parts().length === 5);
    w = clipWorld(); clip = w.K.clip; sess = await w.give('bob', '4');
    sess.ctl.cp.bufferedAmount = 5000; clip.onLocal({ type: 'clip', id: '4', text: 'copied under the first grant' }); await tick(); clip.off(sess, 'user');
    Object.assign(sess.ctl, { giveClip: true, token: 'tok2' }); clip.sync(sess); w.starts[w.starts.length - 1].res({ ok: true, id: '5' }); await tick(); await new Promise((r) => setTimeout(r, 80));
    ok('X2 nor does it go out under the next link of that session, on its new channel', clip.link && clip.link.id === '5' && w.made.length === 2 && parts().length === 0 && clip.link.tx === 0);
    w = clipWorld(); clip = w.K.clip; sess = await w.give('bob', '4');
    clip.onLocal({ type: 'clip', id: '4', note: 'big' }); clip.onLocal({ type: 'clip', id: '4', note: 'refused' }); clip.onLocal({ type: 'clip', id: '4', note: 'whatever' });
    ok('X2 a copy main would not share is counted and shown, not sent', clip.link.skipped === 2 && w.notes.join() === 'big,refused' && parts().length === 0);
    clip.onLocal({ type: 'clip', id: '4', off: true, why: 'setting' });
    ok('X2 main ended the link: off here too, the peer told, main not asked again', clip.link === null && w.ctlSent() === 'bob:{"t":"clipoff"}' && w.stops.length === 0);

    // their text
    w = clipWorld(); clip = w.K.clip; sess = await w.take('alice', '6');
    const part = (id, i, n, d) => clip.onPart(sess, { t: 'clip', id, i, n, d });
    part(1, 0, 3, 'aa'); part(1, 1, 3, 'bb'); const early = w.applied.length; part(1, 2, 3, 'cc'); await tick();
    ok('X2 their parts are put together in order and handed to main with the link id, once whole', early === 0 && js(w.applied) === '[{"id":"6","text":"aabbcc"}]' && clip.link.rx === 1);
    w.applied.length = 0;
    part(2, 0, 2, 'aa'); part(2, 0, 2, 'AA'); part(2, 1, 2, 'BB'); await tick();
    ok('X2 a part 0 starts over', js(w.applied) === '[{"id":"6","text":"AABB"}]');
    w.applied.length = 0;
    part(3, 1, 2, 'bb'); part(4, 0, 3, 'aa'); part(4, 2, 3, 'cc'); part(4, 1, 3, 'bb'); part(5, 0, 2, 'aa'); part(6, 1, 2, 'bb'); part(7, 0, 2, 'aa'); part(7, 1, 3, 'bb'); await tick();
    ok('X2 a part with no start, out of order, of another id or another count drops the text', w.applied.length === 0);
    for (const m of [{ id: 8, i: 0, n: 17, d: 'a' }, { id: 8, i: 0, n: 0, d: 'a' }, { id: 8, i: 1, n: 1, d: 'a' }, { id: 8, i: -1, n: 1, d: 'a' }, { id: 8, i: 0, n: 1, d: 'x'.repeat(4097) }, { id: 8, i: 0, n: 1, d: 7 }, { id: '8', i: 0, n: 1, d: 'a' }, { id: 8, i: 0.5, n: 1, d: 'a' }, { id: 8, i: 0, n: 1 }]) clip.onPart(sess, { t: 'clip', ...m });
    await tick();
    ok('X2 a part that breaks a bound is dropped: 17 parts, none, an index past the count, 4097 units, no string, no integer', w.applied.length === 0);
    w.K.CLIP_MAX = 5000; part(9, 0, 2, 'x'.repeat(4096)); part(9, 1, 2, 'x'.repeat(4096)); await tick(); w.K.CLIP_MAX = 65536;
    ok('X2 a text that grows past the bound is dropped whole, never cut', w.applied.length === 0);
    const stranger = w.sess('cy'); clip.onPart(stranger, { t: 'clip', id: 10, i: 0, n: 1, d: 'from someone else' }); await tick();
    ok('X2 a part from a session that does not have the link is ignored', w.applied.length === 0);
    const rx = clip.link.rx; w.applyOk = false; part(11, 0, 1, 'main says no'); await tick();
    ok('X2 a text main refuses is not counted as received', w.applied.length === 1 && rx === 2 && clip.link.rx === rx);
    w = clipWorld(); clip = w.K.clip; sess = w.sess('alice'); Object.assign(sess.ctl, { take: true, takeClip: true }); clip.sync(sess);
    clip.onPart(sess, { t: 'clip', id: 1, i: 0, n: 1, d: 'too early' }); await tick();
    ok('X2 nothing is taken before main has answered for the link', w.applied.length === 0);
    clip.off(sess, 'peer'); clip.onPart(sess, { t: 'clip', id: 2, i: 0, n: 1, d: 'too late' }); await tick();
    ok('X2 and nothing after it is off', w.applied.length === 0);

    // the poke
    w = clipWorld(); clip = w.K.clip; sess = await w.take('alice', '6');
    clip.poke();
    ok('X2 no poke while their screen is not the one on screen', w.pokes.length === 0);
    w.K.viewer.bound = sess; clip.poke();
    ok('X2 a poke with their screen on screen asks main for one look', w.pokes.join() === '6');
    clip.off(sess, 'user'); clip.poke();
    ok('X2 no poke without a link', w.pokes.length === 1);
    w = clipWorld(); clip = w.K.clip; sess = await w.give('bob', '6'); w.K.viewer.bound = sess; clip.poke();
    ok('X2 the sharer\'s side never pokes', w.pokes.length === 0);
  })().catch((e) => { console.log('FAIL  X2 threw:', e.stack); process.exitCode = 1; });
}

// X3: the clipboard in the control handshake: offered, ticked, answered, and only then on
{
  (async () => {
    // sharer
    let w = controlWorld(), C = w.K.control, bob = w.sess('bob');
    w.from(bob, { t: 'req', clip: 1 });
    ok('X3 a request that offers the clipboard, my switch on: the dialog offers it', js(w.asks[0]) === '{"clip":true,"why":""}' && C.pending.clip === true);
    C.allow(); await tick();
    ok('X3 Allow with the box ticked asks main for a grant with the clipboard', w.grants[0].pub === 'bob' && w.grants[0].clip === true && bob.ctl.giveClip === false);
    w.grants[0].res({ ok: true, token: 'tok' }); await tick();
    ok('X3 granted: the answer says clip:1, the flag is set, the link is told', w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":1}' && bob.ctl.giveClip === true && w.synced.join() === 'bob' && /Clipboard text is shared both ways\.$/.test(w.toasts[0]));
    w.sent.length = 0; w.from(bob, { t: 'req', clip: 1 });
    ok('X3 asked again while it is on: the same answer', w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":1}');
    w.synced.length = 0; C.endGive(bob, 'stopped');
    ok('X3 control ends: the flag is cleared and the link is told, after the peer was', bob.ctl.giveClip === false && w.synced.join() === 'bob' && w.sent[w.sent.length - 1] === 'bob:{"t":"ctl","on":false,"why":"stopped"}');

    w = controlWorld(); C = w.K.control; bob = w.sess('bob'); w.ticked = false;
    w.from(bob, { t: 'req', clip: 1 }); C.allow(); await tick(); w.grants[0].res({ ok: true, token: 'tok' }); await tick();
    ok('X3 the box unticked: a grant without the clipboard, clip:0, no flag', w.grants[0].clip === false && w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":0}' && bob.ctl.giveClip === false && !/Clipboard/.test(w.toasts[0]));

    w = controlWorld(); C = w.K.control; bob = w.sess('bob');
    w.from(bob, { t: 'req' }); C.allow(); await tick(); w.grants[0].res({ ok: true, token: 'tok' }); await tick();
    ok('X3 a request without the offer (a released peer): the dialog says so, and whatever the box holds, no clipboard', js(w.asks[0]) === '{"clip":false,"why":"peer"}' && w.grants[0].clip === false && w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":0}' && bob.ctl.giveClip === false);
    for (const v of [true, '1', 2, {}, 0]) { const u = controlWorld(), s = u.sess('bob'); u.from(s, { t: 'req', clip: v }); ok(`X3 only clip:1 is an offer (${JSON.stringify(v)} is not)`, u.asks[0].clip === false && u.asks[0].why === 'peer'); }

    w = controlWorld(); C = w.K.control; bob = w.sess('bob'); w.settings.clipboardSync = false;
    w.from(bob, { t: 'req', clip: 1 }); C.allow(); await tick(); w.grants[0].res({ ok: true, token: 'tok' }); await tick();
    ok('X3 my switch off: not offered in the dialog, which names my Settings, and not granted', js(w.asks[0]) === '{"clip":false,"why":"off"}' && w.grants[0].clip === false && bob.ctl.giveClip === false && w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":0}');

    w = controlWorld(); C = w.K.control; bob = w.sess('bob'); w.K.clip.link = { sess: {} };
    w.from(bob, { t: 'req', clip: 1 });
    ok('X3 the clipboard is shared in another session already: not offered, and the dialog says so', js(w.asks[0]) === '{"clip":false,"why":"busy"}');

    w = controlWorld(); C = w.K.control; bob = w.sess('bob');
    w.from(bob, { t: 'req', clip: 1 }); C.allow(); await tick(); w.settings.clipboardSync = false; w.grants[0].res({ ok: true, token: 'tok' }); await tick();
    ok('X3 the switch went off while main started the grant: control yes, clipboard no', bob.ctl.give === 'on' && bob.ctl.giveClip === false && w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":0}');
    w = controlWorld(); C = w.K.control; bob = w.sess('bob');
    w.from(bob, { t: 'req', clip: 1 }); C.allow(); await tick(); w.K.clip.link = { sess: {} }; w.grants[0].res({ ok: true, token: 'tok' }); await tick();
    ok('X3 another session took the link meanwhile: control yes, clipboard no', bob.ctl.giveClip === false && w.sent.join() === 'bob:{"t":"ctl","on":true,"clip":0}');
    w = controlWorld(); C = w.K.control; bob = w.sess('bob');
    w.from(bob, { t: 'req', clip: 1 }); C.allow(); await tick(); w.grants[0].res({ ok: false, reason: 'accessibility', message: 'no' }); await tick();
    ok('X3 a grant that fails gives no clipboard', bob.ctl.give === 'off' && bob.ctl.giveClip === false);
    w = controlWorld(); C = w.K.control; bob = w.sess('bob');
    w.from(bob, { t: 'req', clip: 1 }); C.deny('denied');
    ok('X3 Deny: no grant asked, no flag', w.grants.length === 0 && bob.ctl.giveClip === false && w.sent.join() === 'bob:{"t":"ctl","on":false}');

    // viewer
    w = controlWorld(); C = w.K.control; let alice = w.sess('alice');
    C.ask(alice);
    ok('X3 viewer: the request offers the clipboard while my switch is on', w.sent.join() === 'alice:{"t":"req","clip":1}' && alice.ctl.askedClip === true);
    w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: offered and answered with clip:1: I drive, the flag is set, the link is told', alice.ctl.take === true && alice.ctl.takeClip === true && alice.ctl.askedClip === false && w.synced.includes('alice') && /Clipboard text is shared both ways until control ends\.$/.test(w.toasts[0]));
    w.synced.length = 0; w.from(alice, { t: 'ctl', on: false, why: 'stopped' });
    ok('X3 viewer: their control ends and my flag with it', alice.ctl.take === false && alice.ctl.takeClip === false && w.synced.join() === 'alice');

    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice); w.sent.length = 0;
    w.from(alice, { t: 'ctl', on: true, clip: 0 });
    ok('X3 viewer: answered without the clipboard: I drive, no flag, nothing said back', alice.ctl.take === true && alice.ctl.takeClip === false && w.sent.length === 0);
    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice); w.sent.length = 0;
    w.from(alice, { t: 'ctl', on: true });
    ok('X3 viewer: a released sharer answers with no clip field: I drive, no flag', alice.ctl.take === true && alice.ctl.takeClip === false && w.sent.length === 0);

    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); w.settings.clipboardSync = false; C.ask(alice);
    ok('X3 viewer: with my switch off the request offers nothing', w.sent.join() === 'alice:{"t":"req"}' && alice.ctl.askedClip === false);
    w.sent.length = 0; w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: a clip:1 I did not ask for is not taken up, and they are told at once', alice.ctl.take === true && alice.ctl.takeClip === false && w.sent.join() === 'alice:{"t":"clipoff"}');

    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice); w.settings.clipboardSync = false; w.sent.length = 0;
    w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: my switch went off between request and answer: no flag, and they are told', alice.ctl.take === true && alice.ctl.takeClip === false && w.sent.join() === 'alice:{"t":"clipoff"}');
    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice); w.K.clip.link = { sess: {} }; w.sent.length = 0;
    w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: another session took the link meanwhile: no flag, and they are told', alice.ctl.takeClip === false && w.sent.join() === 'alice:{"t":"clipoff"}');
    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); w.K.clip.link = { sess: {} }; C.ask(alice);
    ok('X3 viewer: while another session has the link the request offers nothing', w.sent.join() === 'alice:{"t":"req"}');
    w.K.clip.link = null; w.sent.length = 0; w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: and a clip:1 in the answer to that request is not taken up though the link is free by then: I did not offer it', alice.ctl.take === true && alice.ctl.takeClip === false && w.sent.join() === 'alice:{"t":"clipoff"}');

    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); w.sent.length = 0;
    w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: a grant with the clipboard that nobody asked for starts neither', alice.ctl.take === false && alice.ctl.takeClip === false && w.sent.join() === 'alice:{"t":"rel"}' && w.synced.length === 0);
    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice);
    w.timers.filter((t) => t.on && t.ms === w.K.tune.ASK_MS).forEach((t) => t.fn()); w.sent.length = 0;
    w.from(alice, { t: 'ctl', on: true, clip: 1 });
    ok('X3 viewer: nor one that answers a request that ran out', alice.ctl.take === false && alice.ctl.takeClip === false && alice.ctl.askedClip === false && w.sent.join() === 'alice:{"t":"rel"}');
    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice); w.from(alice, { t: 'ctl', on: true, clip: 1 }); w.synced.length = 0;
    C.ask(alice);
    ok('X3 viewer: letting go clears the flag and tells the link', alice.ctl.take === false && alice.ctl.takeClip === false && w.synced.join() === 'alice');
    w = controlWorld(); C = w.K.control; alice = w.sess('alice'); C.ask(alice); w.from(alice, { t: 'ctl', on: true, clip: 1 }); w.synced.length = 0;
    C.sessionClosed(alice);
    ok('X3 a session that closes clears both flags and tells the link', alice.ctl.takeClip === false && alice.ctl.giveClip === false && w.synced.length >= 1);
  })().catch((e) => { console.log('FAIL  X3 threw:', e.stack); process.exitCode = 1; });
}

// Y1: in full screen while I drive their screen, main is told that the app's own keys go there too
{
  const els = new Map(), told = [];
  const $ = (id) => { if (!els.has(id)) { const cls = new Set(); els.set(id, { id, textContent: '', title: '', style: {}, srcObject: null, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); } }, focus() {}, play: async () => {}, addEventListener() {}, removeEventListener() {}, requestVideoFrameCallback() {} }); } return els.get(id); };
  const S = { current: 'alice' }, sess = { pub: 'alice', closed: false, remote: { screen: true, view: {} }, ctl: { take: false, cursor: null } };
  const K = load(['kit.js', 'tune.js', 'viewer.js'], { $, S, contact: () => ({}), toast() {}, ipcErr: String, document: { addEventListener() {}, body: { classList: $('body').classList } }, addEventListener() {},
    api: { keysRemote: async (on) => { told.push(on); return on; }, fullscreen: async (on) => on } });
  let taking = false;
  K.sessions = { get: (pub) => (pub === 'alice' ? sess : null), dc: () => true }; K.control = { isTaking: () => taking && K.viewer.bound === sess, pending: null }; K.clip = { poke() {} };
  K.viewer.rebind();
  ok('Y1 watching, not driving, not in full screen: main is told nothing', K.viewer.bound === sess && K.viewer.keysWanted === false && told.length === 0);
  K.viewer.onFullscreen({ on: true });
  ok('Y1 full screen without control: nothing', K.viewer.theater === true && told.length === 0);
  taking = true; K.viewer.syncKeys();
  ok('Y1 control begins in full screen: main is told once', K.viewer.keysWanted === true && told.join() === 'true');
  K.viewer.syncKeys(); K.viewer.rebind(); K.viewer.onFullscreen({ on: true });
  ok('Y1 and not again while nothing changes', told.length === 1);
  K.viewer.onFullscreen({ on: false });
  ok('Y1 full screen ends: off', K.viewer.keysWanted === false && told.join() === 'true,false');
  K.viewer.onFullscreen({ on: true });
  ok('Y1 full screen again while still driving: on', told.join() === 'true,false,true');
  taking = false; K.viewer.syncKeys();
  ok('Y1 control ends: off', K.viewer.keysWanted === false && told.join() === 'true,false,true,false');
  taking = true; K.viewer.syncKeys(); S.current = 'bob'; K.viewer.rebind();
  ok('Y1 another chat is opened (their screen is no longer the one on screen): off, and full screen goes', K.viewer.bound === null && K.viewer.keysWanted === false && told.join() === 'true,false,true,false,true,false');
  S.current = 'alice'; K.viewer.rebind(); K.viewer.theater = false; taking = true; K.viewer.syncKeys();
  ok('Y1 driving outside full screen: main is not told', K.viewer.keysWanted === false && told.length === 6);
}

// Y2: both ends of control ask for the key routing to be looked at again
{
  const w = controlWorld(), C = w.K.control, alice = w.sess('alice');
  C.ask(alice); const k0 = w.keys; w.from(alice, { t: 'ctl', on: true });
  ok('Y2 control begins: the viewer looks at where the app\'s keys go', alice.ctl.take === true && w.keys === k0 + 1);
  const k1 = w.keys; w.from(alice, { t: 'ctl', on: false, why: 'stopped' });
  ok('Y2 the sharer stops it: looked at again', alice.ctl.take === false && w.keys > k1);
  C.ask(alice); w.from(alice, { t: 'ctl', on: true }); const k2 = w.keys; C.ask(alice);
  ok('Y2 I let go: looked at again', alice.ctl.take === false && w.keys > k2);
  C.ask(alice); w.from(alice, { t: 'ctl', on: true }); const k3 = w.keys; C.sessionClosed(alice);
  ok('Y2 the session closes: looked at again', w.keys > k3);
}

// F1: a contact that is removed from the contact list is out of the audience for good
{
  const ended = [], timers = [], added = [], held = new Map();
  const K = load(['kit.js', 'tune.js', 'cast.js'], { toast() {}, renderContacts() {}, contact: (pub) => { added.push(pub); return { pub, name: pub, status: 'online' }; },
    setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; } });
  K.paint = () => {}; K.control = { owner: null }; K.clip = { link: null };
  K.sessions = { get: (pub) => held.get(pub) || null, all: () => [...held.values()], end: (x) => { ended.push(x.pub); held.delete(x.pub); x.closed = true; K.cast.sessionClosed(x, 'ended'); } };
  const cast = K.cast, forget = cast.forget || (() => {}), mk = (pub) => { const x = { pub, closed: false, screenTrack: null, micTrack: null }; held.set(pub, x); return x; };
  cast.members.set('live', { state: 'live', mode: 'one', timer: null, back: null }); mk('live');
  cast.members.set('joining', { state: 'joining', mode: 'one', timer: null, back: null }); mk('joining');
  const timer = () => { const t = { fn() {}, ms: K.REJOIN_MS, on: true }; timers.push(t); return t; };   // the timer an away entry has, as sessionClosed sets it
  cast.members.set('away', { state: 'away', mode: 'one', timer: timer(), back: null });
  cast.members.set('back', { state: 'away', mode: 'one', timer: timer(), back: null });
  cast.peerOnline('back');                                      // it is connected again: its screen comes back in K.BACK_MS
  mk('watched');                                                // a contact whose screen I only watch
  for (const pub of ['live', 'joining', 'away', 'back', 'watched', 'nobody']) forget(pub);
  ok('F1 forgotten in every state: no member left, whether watching, being added, away or about to come back', cast.members.size === 0);
  ok('F1 every session with such a contact is ended, the one where I only watch too', ended.sort().join() === 'joining,live,watched' && held.size === 0);
  ok('F1 the timers of the away entries are cleared', timers.length === 3 && timers.every((t) => !t.on));
  added.length = 0; for (const t of timers.filter((x) => x.on)) t.fn(); cast.peerOnline('away'); cast.peerOnline('back'); cast.peerOnline('live');
  for (const t of timers.slice(3)) t.fn();
  ok('F1 and nothing adds that key again when it connects once more', cast.members.size === 0 && added.length === 0 && timers.length === 3);
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8'), rm = app.slice(app.indexOf("$('infoRemove').onclick"));
  ok('F1 the Remove button tells the share code before the contact is removed', rm.indexOf('window.Share.forget(S.current)') > 0 && rm.indexOf('window.Share.forget(S.current)') < rm.indexOf('window.api.removeContact(S.current)'));
}

// F2: the "share yours too" prompt never takes the place of a prompt that is up, and opens disarmed
{
  const els = new Map(), timers = [], shown = []; let active = null;
  const $ = (id) => { if (!els.has(id)) { const cls = new Set(['hidden']); els.set(id, { id, disabled: false, textContent: '', title: '', style: {}, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle() {} }, focus() { active = id; }, addEventListener() {}, requestVideoFrameCallback() {} }); } return els.get(id); };
  const up = (id) => !$(id).classList.contains('hidden');
  let open = null;
  const K = load(['kit.js', 'tune.js', 'viewer.js'], { $, S: { current: null }, contact: (pub) => ({ name: pub[0].toUpperCase() + pub.slice(1) }), toast() {}, document: { addEventListener() {} }, addEventListener() {}, closeLightbox() {},
    show: (id) => { shown.push(id); open = id; $('backdrop').classList.remove('hidden'); $(id).classList.remove('hidden'); }, closeModal: () => { if (!open) return; $(open).classList.add('hidden'); $('backdrop').classList.add('hidden'); open = null; },
    get openModal() { return open; }, setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; } });
  const run = (ms) => { for (const t of timers.splice(0)) if (t.on && t.ms <= ms) t.fn(); else if (t.on) timers.push(t); };
  K.control = { pending: null, isTaking: () => false }; K.clip = { poke() {} };
  const dee = { pub: 'dee', askedBack: true }, eve = { pub: 'eve', askedBack: true };
  K.viewer.askBack(dee);
  const atOpen = $('shareBackYes').disabled; run(60); const focus = active; run(K.ARM_MS);
  ok('F2 the prompt opens for the session that asked, with its Yes disarmed and the keyboard on "Just watch"; armed after K.ARM_MS', up('mShareBack') && K.viewer.backFor === dee && $('shareBackName').textContent === 'Dee' && atOpen === true && focus === 'shareBackNo' && $('shareBackYes').disabled === false);
  K.viewer.askBack(eve);
  ok('F2 a second contact asking while it is up does not take it over: still Dee\'s, still armed as it was', K.viewer.backFor === dee && $('shareBackName').textContent === 'Dee' && $('shareBackYes').disabled === false && shown.join() === 'mShareBack');
  ok('F2 and that second session may ask again with its next state frame', eve.askedBack === false && dee.askedBack === true);
  active = 'input'; K.viewer.seen();
  const again = $('shareBackYes').disabled; run(60);
  ok('F2 the window is shown or focused with the prompt up: disarmed anew, the keyboard back on "Just watch"', again === true && active === 'shareBackNo');
  run(K.ARM_MS); K.unprompt('mShareBack'); K.viewer.backFor = null; active = 'input'; K.viewer.seen(); run(K.ARM_MS);
  ok('F2 with no prompt up, nothing is touched', $('shareBackYes').disabled === false && active === 'input' && timers.length === 0);
  for (const [what, set, unset] of [['the control dialog is up', () => { K.control.pending = { sess: dee }; K.prompt('mControl'); }, () => { K.control.pending = null; K.unprompt('mControl'); }], ['a control request is open, its dialog put aside', () => { K.control.pending = { sess: dee }; }, () => { K.control.pending = null; }], ['the picker is up', () => K.prompt('mCast'), () => K.unprompt('mCast')]]) {
    set(); eve.askedBack = true; const n = shown.length; K.viewer.askBack(eve);
    ok(`F2 while ${what} the prompt does not open, and the session may ask again`, !up('mShareBack') && K.viewer.backFor === null && shown.length === n && eve.askedBack === false);
    unset();
  }
  K.prompt('mControl');
  const refused = [K.prompt('mShareBack'), K.prompt('mCast')];
  ok('F2 nothing is shown in place of the control dialog: it stays up until it is answered', refused.join() === 'false,false' && up('mControl') && !up('mShareBack') && !up('mCast') && open === 'mControl');
  K.unprompt('mControl'); K.prompt('mShareBack');
  ok('F2 the control dialog itself still takes the place of another prompt', K.prompt('mControl') === true && up('mControl') && !up('mShareBack'));
}

// The audience code (share/cast.js) with devices and sessions that only record: add, remove, talk and set run for real.
function castWorld() {
  const w = { toasts: [], states: [], held: new Map(), made: [], gdm: 0, ended: 0, micGate: null, closed: [], offline: new Set() };
  const track = (kind) => { const t = { kind, enabled: true, readyState: 'live', contentHint: '', stop() { this.readyState = 'ended'; }, clone: () => track(kind), applyConstraints: async () => {}, getSettings: () => ({ width: 1920 }) }; w.made.push(t); return t; };
  w.K = load(['kit.js', 'tune.js', 'cast.js'], { toast: (t) => w.toasts.push(t), renderContacts() {}, S: { capture: { supported: true }, protection: true }, contact: (pub) => ({ pub, name: pub[0].toUpperCase() + pub.slice(1), status: w.offline.has(pub) ? 'offline' : 'online' }), showScreenPermission() {}, console: { warn() {}, error() {}, log() {} },
    navigator: { mediaDevices: { getDisplayMedia: async () => { w.gdm++; return { getVideoTracks: () => [track('video')] }; }, getUserMedia: async () => { if (w.micGate) await w.micGate; return { getAudioTracks: () => [track('audio')] }; } } },
    api: { screenPermission: async () => 'ok', micPermission: async () => w.micOk !== false, captureEnded: async () => { w.ended++; return true; } } });
  w.K.paint = () => {}; w.K.control = { owner: null, endGive() {} }; w.K.clip = { link: null };
  w.mk = (pub) => { const x = { pub, closed: false, seen: false, ready: Promise.resolve(), mode: 'one', local: { addTrack() {}, removeTrack() {} }, screenTrack: null, micTrack: null, screenSender: null, micSender: null, micStream: null, scaled: false, remote: { screen: false, mic: false, rec: false }, ctl: { give: 'off' },
    pc: { addTrack: (t) => ({ track: t, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }), removeTrack() {}, getTransceivers: () => [] } }; w.held.set(pub, x); return x; };
  w.K.sessions = { get: (pub) => w.held.get(pub) || null, open: (pub) => w.mk(pub), all: () => [...w.held.values()], openChannels() {}, dc: () => true, sendState: (x) => w.states.push(`${x.pub}:${x.micTrack ? +x.micTrack.enabled : '-'}`),
    close: (x, why) => { x.closed = true; w.held.delete(x.pub); w.closed.push(`${x.pub}:${why}`); w.K.cast.sessionClosed(x, why); } };
  w.mic = (pub) => { const x = w.held.get(pub); return x && x.micTrack ? (x.micTrack.enabled ? 'on' : 'muted') : 'none'; };
  // a contact whose screen I watch, to whom I talked and then muted myself
  w.watchMuted = async (pub) => { const x = w.mk(pub); x.remote.screen = true; await w.K.cast.talk(x); await w.K.cast.talk(x); return x; };
  return w;
}
const idle = async () => { for (let i = 0; i < 25; i++) await tick(); };

// F3: a mute the user set is lifted only by a click on a microphone button
{
  (async () => {
    let w = castWorld(), cast = w.K.cast;
    await cast.add('bob', 'one');
    ok('F3 a share starts with the microphone on', w.mic('bob') === 'on' && w.K.mic.audienceOn === true);
    const dee = await w.watchMuted('dee'); const s0 = w.states.length, t0 = w.toasts.length;
    ok('F3 (a contact I watch, talked to, then muted)', w.mic('dee') === 'muted' && w.K.mic.audienceOn === true && dee.screenTrack === null);
    await cast.add('dee', 'one');
    ok('F3 she joins the audience: her mute stays, and it mutes the audience, which is one switch', w.mic('dee') === 'muted' && w.mic('bob') === 'muted' && w.K.mic.audienceOn === false);
    ok('F3 every member is told and the user sees the toast', w.states.slice(s0).includes('bob:0') && w.states.slice(s0).includes('dee:0') && w.toasts.slice(t0).join() === 'Microphone muted for everyone you share with');
    await cast.talk(w.held.get('bob'));
    ok('F3 a click on the microphone button lifts it, for everyone', w.mic('bob') === 'on' && w.mic('dee') === 'on' && w.K.mic.audienceOn === true);

    // the picker starts Bob (new) and Dee (muted) together: the same outcome whichever add ends first
    const outcomes = [];
    for (const first of ['bob', 'dee']) {
      w = castWorld(); cast = w.K.cast; await w.watchMuted('dee'); const bob = w.mk('bob');
      let go; const gate = new Promise((r) => { go = r; }); (first === 'bob' ? w.held.get('dee') : bob).ready = gate;   // the other one's connection is ready later
      const both = Promise.all([cast.add('bob', 'one'), cast.add('dee', 'one')]); await idle(); go(); await both;
      outcomes.push(`${w.mic('bob')},${w.mic('dee')},${w.K.mic.audienceOn},${w.toasts.filter((t) => /muted for everyone/.test(t)).length}`);
    }
    ok('F3 Bob and the muted Dee ticked together: both muted, switch off, one toast, in either order', outcomes[0] === 'muted,muted,false,1' && outcomes[1] === outcomes[0]);

    // an audience of one that the user muted; a second joins while the first leaves
    w = castWorld(); cast = w.K.cast; await cast.add('bob', 'one'); await cast.talk(w.held.get('bob'));
    const muted = w.mic('bob') === 'muted' && w.K.mic.audienceOn === false;
    const cy = w.mk('cy'); let go; cy.ready = new Promise((r) => { go = r; });
    const joining = cast.add('cy', 'one'); await idle(); cast.remove('bob'); go(); await joining;
    ok('F3 a muted audience stays muted when its only member leaves while the next one joins', muted && w.mic('cy') === 'muted' && w.K.mic.audienceOn === false && w.gdm === 1);
    cast.stop('user'); await idle(); await cast.add('eve', 'one');
    ok('F3 a new capture starts with the microphone on again', w.gdm === 2 && w.mic('eve') === 'on' && w.K.mic.audienceOn === true);

    w = castWorld(); cast = w.K.cast; await w.watchMuted('dee'); const t1 = w.toasts.length; await cast.add('dee', 'one');
    ok('F3 the muted contact as the only member: muted, and no toast about everyone', w.mic('dee') === 'muted' && w.K.mic.audienceOn === false && w.toasts.length === t1);
    await cast.add('bob', 'one');
    ok('F3 whoever joins after that gets the switch as it stands', w.mic('bob') === 'muted');
  })().catch((e) => { console.log('FAIL  F3 threw:', e.stack); process.exitCode = 1; });
}

// The whole share code of the page (every file of ui/share and ui/share.js) over elements that only keep
// what is set on them: for what the paint writes and what window.Share answers.
function pageWorld(extra = {}) {
  const w = { els: new Map(), toasts: [], timers: [], sent: [], S: { me: { pub: 'me' }, current: null, contacts: [], settings: {}, capture: { supported: true }, protection: true } };
  w.$ = (id) => { if (!w.els.has(id)) { const cls = new Set(); w.els.set(id, { id, textContent: '', title: '', className: '', disabled: false, checked: false, style: {}, dataset: {}, srcObject: null, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); } },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {}, requestVideoFrameCallback() {}, focus() {}, play: async () => {}, appendChild() {}, append() {}, remove() {} }); } return w.els.get(id); };
  w.K = load(['kit.js', 'tune.js', 'session.js', 'cast.js', 'control.js', 'clip.js', 'record.js', 'viewer.js', '../share.js'], { $: w.$, S: w.S, toast: (t) => w.toasts.push(t), ipcErr: (e) => String((e && e.message) || e), renderContacts() {}, closeLightbox() {}, show() {}, closeModal() {},
    contact: (pub) => w.S.contacts.find((c) => c.pub === pub), document: { getElementById: w.$, addEventListener() {}, createElement: () => w.$('made' + w.els.size), body: w.$('body') }, addEventListener() {}, performance: { now: () => 0 },
    setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; w.timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; }, setInterval: () => 0, clearInterval() {},
    MediaStream: class { constructor() { this.t = []; } addTrack(t) { this.t.push(t); } removeTrack() {} },
    api: { share: async (pub, f) => { w.sent.push(`${pub}:${f.op}`); return true; }, iceConfig: async () => ({ iceServers: [] }), controlRevoke: async () => true, log: async () => true, keysRemote: async () => false, fullscreen: async (on) => on, captureEnded: async () => true, recordStop: async () => null }, ...extra });
  w.Share = pages.get(w.K).Share;
  // a session as session.js makes one, put into the registry by hand: `out` says my screen goes to that contact
  w.sess = (pub, out, theirs = false) => { const x = { pub, id: 's-' + pub, pc: null, closed: false, peerSids: new Set(), statsTimer: null, connectTimer: null, markSeen() {}, ready: Promise.resolve(), inbox: Promise.resolve(), seen: true, everConnected: true, screenTrack: out ? { stop() {}, contentHint: '' } : null, micTrack: null, screenSender: null, micSender: null, local: {}, mode: 'one', rec: null, stats: '',
    remote: { screen: theirs, mic: false, mode: 'one', rec: false, cast: 0, video: null, audio: null, view: null, audioEl: null }, ctl: { give: 'off', take: false, asked: false, askTimer: null, flush: null, dc: null, mv: null, cp: null, chans: [], sent: 0, recv: 0, cursor: null, token: null, giveClip: false, takeClip: false, askedClip: false } };
    w.K.sessions.map.set(pub, x); w.S.contacts.push({ pub, name: pub[0].toUpperCase() + pub.slice(1), status: 'online' }); if (out) w.K.cast.members.set(pub, { state: 'live', mode: 'one', timer: null, back: null }); return x; };
  return w;
}

// F4: where the viewers read this window, and there is more than one of them, nothing outside the dialog and the picker names a contact
{
  (async () => {
    const world = (capturable, viewers) => { const w = pageWorld(); w.S.protection = !capturable; for (const pub of viewers) w.sess(pub, true); return w; };
    let w = world(true, ['bob', 'cy']);
    ok('F4 hushed: the window shows in captures and my screen goes to two contacts', w.K.hushed() === true && w.K.label('bob', 'A viewer') === 'A viewer');
    ok('F4 not with one viewer, and not with a window that captures leave out', world(true, ['bob']).K.hushed() === false && world(false, ['bob', 'cy']).K.hushed() === false && world(false, ['bob', 'cy']).K.label('bob', 'A viewer') === 'Bob');
    const run = async (capturable, viewers) => {
      const w = world(capturable, viewers), K = w.K, Share = w.Share, out = {}, bob = K.sessions.get('bob');
      out.marks = viewers.map((p) => Share.live(p)).join();
      K.control.owner = { sess: bob, token: 't' }; bob.ctl.give = 'on'; w.S.current = viewers[1] || null; K.paint();
      out.stop = w.$('btnStopCtl').textContent;
      w.toasts.length = 0; K.control.endGive(bob, 'released');
      const cy = K.sessions.get('cy'); if (cy) { K.control.pending = { sess: bob, timer: null }; K.control.onMessage(cy, { t: 'req' }); K.control.pending = null; }   // a second viewer asks while the first one's dialog is open
      bob.remote.rec = false; K.sessions.onFrame({ pub: 'bob', sid: bob.id, op: 'state', screen: false, mic: true, mode: 'one', rec: true }); await idle();
      w.S.contacts.push({ pub: 'off', name: 'Offie', status: 'offline' }); await K.cast.add('off', 'one');
      out.toasts = w.toasts.splice(0).join(' | ');
      // the three ways a session's end is told; the audience shrinks by that very session before the toast
      for (const why of ['bye', 'offline', 'refused']) { const x = w.sess('end' + why, true); K.sessions.close(x, why); }
      out.ends = w.toasts.splice(0).join(' | ');
      return out;
    };
    const two = await run(true, ['bob', 'cy']), one = await run(true, ['bob']), safe = await run(false, ['bob', 'cy']);
    ok('F4 hushed: no mark on the rows my screen goes to, no name on Stop control', two.marks === ',' && two.stop === '✋ Stop control');
    ok('F4 hushed: the toasts about control, recording and an offline contact name nobody', two.toasts === 'The viewer stopped controlling your screen | Another viewer also asked for control | A viewer is recording your screen share | That contact is offline: a screen share needs them connected');
    ok('F4 hushed: nor do the toasts about a share that ended, also when it was the second-last viewer', two.ends === 'A contact ended the screen share | Screen share ended: a contact went offline | A contact cannot take the screen share right now (they are in another one)');
    ok('F4 one viewer: marks, the name on the button and in the toasts, as before', one.marks === 'out' && one.stop === '✋ Stop control (Bob)' && one.toasts === 'Bob stopped controlling your screen | Bob is recording your screen share | Offie is offline: a screen share needs them connected');
    ok('F4 a window that is not in the picture: everything named, as before', safe.marks === 'out,out' && safe.stop === '✋ Stop control (Bob)' && safe.toasts === 'Bob stopped controlling your screen | Cy also asked for control | Bob is recording your screen share | Offie is offline: a screen share needs them connected' && safe.ends === 'Endbye ended the screen share | Screen share ended: Endoffline went offline | Endrefused cannot take the screen share right now (they are in another one)');
    // a share that fails, and one that never connects
    for (const [capturable, want] of [[true, 'Screen share with a contact did not connect | Screen share with a contact failed. Check the call server in Settings.'], [false, 'Screen share with Dee did not connect | Screen share with Eve failed. Check the call server in Settings.']]) {
      const pcs = [], x = pageWorld({ RTCPeerConnection: function () { const pc = { connectionState: 'new', close() {}, getStats: async () => new Map() }; pcs.push(pc); return pc; } }); x.S.protection = !capturable; x.sess('bob', true); x.sess('cy', true);
      x.S.contacts.push({ pub: 'dee', name: 'Dee', status: 'online' }, { pub: 'eve', name: 'Eve', status: 'online' });
      x.K.sessions.open('dee', 'sid1', true); x.timers.filter((t) => t.on && t.ms === x.K.CONNECT_MS).forEach((t) => t.fn());
      const eve = x.K.sessions.open('eve', 'sid2', false); await eve.ready; pcs[pcs.length - 1].connectionState = 'failed'; pcs[pcs.length - 1].onconnectionstatechange();
      ok(`F4 ${capturable ? 'hushed: a share that does not connect or fails names nobody' : 'not hushed: those two toasts name the contact'}`, x.toasts.join(' | ') === want);
    }
  })().catch((e) => { console.log('FAIL  F4 threw:', e.stack); process.exitCode = 1; });
}

// F5: the capture is held for an add() only until it has its lease, not while it waits on the microphone
{
  (async () => {
    let w = castWorld(), cast = w.K.cast, open; w.micGate = new Promise((r) => { open = r; });   // the first share ever: the OS asks about the microphone and nobody answers
    const adding = cast.add('bob', 'one'); await idle();
    const mid = `${w.K.capture.state},${w.K.mic.state},${cast.adding},${cast.leasing},${!!w.held.get('bob').screenTrack}`;
    cast.remove('bob'); await idle();
    ok('F5 Stop sharing while the microphone prompt is open: the capture stops at once, main is told', mid === 'live,starting,1,0,true' && w.K.capture.state === 'idle' && w.ended === 1 && w.made.filter((t) => t.kind === 'video').every((t) => t.readyState === 'ended'));
    ok('F5 the microphone start is still that call\'s, and held for it', w.K.mic.state === 'starting' && cast.adding === 1);
    open(); const r = await adding; await idle();
    ok('F5 when the prompt is answered the call ends with nothing left on', r === false && cast.adding === 0 && cast.leasing === 0 && w.K.mic.state === 'idle' && w.made.every((t) => t.readyState === 'ended') && cast.members.size === 0);

    w = castWorld(); cast = w.K.cast; await cast.add('cy', 'one');
    const bob = w.mk('bob'); let go; bob.ready = new Promise((res) => { go = res; });
    const second = cast.add('bob', 'one'); await idle(); cast.remove('cy'); await idle();
    ok('F5 an add() that has not taken its lease yet still holds the capture when the only other viewer leaves', cast.leasing === 1 && w.K.capture.state === 'live' && w.K.capture.leases.size === 0);
    go(); const r2 = await second;
    ok('F5 and gets its lease from that same capture', r2 === true && w.gdm === 1 && cast.leasing === 0 && w.K.capture.leases.size === 1 && cast.members.get('bob').state === 'live');
    w = castWorld(); cast = w.K.cast; const dee = w.mk('dee'); let free; dee.ready = new Promise((res) => { free = res; });
    const third = cast.add('dee', 'one'); await idle(); cast.remove('dee'); free(); const r3 = await third; await idle();
    ok('F5 an add() that gives up before its lease lets go of the capture as well', r3 === false && cast.leasing === 0 && cast.adding === 0 && w.K.capture.state === 'idle');
  })().catch((e) => { console.log('FAIL  F5 threw:', e.stack); process.exitCode = 1; });
}

// F6: the microphone button of a share that began without a microphone starts it for everyone who gets my screen
{
  (async () => {
    const w = castWorld(), cast = w.K.cast; w.micOk = false;
    await cast.add('bob', 'one'); await cast.add('cy', 'one');
    const dee = w.mk('dee'); dee.remote.screen = true;          // someone whose screen I only watch
    ok('F6 (a broadcast that began without a microphone)', w.mic('bob') === 'none' && w.mic('cy') === 'none' && cast.members.size === 2);
    w.micOk = true; w.states.length = 0; await cast.talk(w.held.get('bob'));
    ok('F6 the button in one viewer\'s chat starts it for every viewer', w.mic('bob') === 'on' && w.mic('cy') === 'on' && w.K.mic.leases.size === 2 && w.K.mic.audienceOn === true);
    ok('F6 each of them is told', w.states.includes('bob:1') && w.states.includes('cy:1'));
    ok('F6 a contact I only watch is not given it', w.mic('dee') === 'none');
    await cast.talk(w.held.get('cy'));
    ok('F6 the next click is the audience switch, as before', w.mic('bob') === 'muted' && w.mic('cy') === 'muted');
    await cast.talk(dee);
    ok('F6 the button of a contact I only watch starts it for that contact alone', w.mic('dee') === 'on' && w.K.mic.leases.size === 3 && w.mic('bob') === 'muted');
  })().catch((e) => { console.log('FAIL  F6 threw:', e.stack); process.exitCode = 1; });
}

// F7: a picker answer that swaps the whole audience goes on with the capture that runs
{
  (async () => {
    let w = castWorld(), cast = w.K.cast;
    cast.set(['bob', 'cy']); await idle();
    const before = `${w.gdm},${w.K.capture.leases.size},${[...cast.members.keys()].join()}`;
    cast.set(['dee', 'eve']); await idle();
    ok('F7 every member unticked and two new ones ticked: the new audience gets the same capture', before === '1,2,bob,cy' && w.gdm === 1 && w.ended === 0 && w.K.capture.state === 'live' && w.K.capture.leases.size === 2 && [...cast.members].map(([p, m]) => `${p}:${m.state}`).join() === 'dee:live,eve:live');
    ok('F7 the device track never stopped; the two old leases did', w.made.filter((t) => t.kind === 'video' && t.readyState === 'live').length === 3 && w.made.filter((t) => t.kind === 'video').length === 5);
    cast.set([]); await idle();
    ok('F7 an answer with nobody ticked stops the capture', w.K.capture.state === 'idle' && w.ended === 1 && cast.leasing === 0 && cast.members.size === 0);
    w = castWorld(); cast = w.K.cast; cast.set(['bob']); await idle(); w.offline.add('zed');
    cast.set(['zed']); await idle();
    ok('F7 a swap whose new contact cannot be added does not leave the capture on', w.K.capture.state === 'idle' && w.ended === 1 && cast.leasing === 0 && cast.members.size === 0);
  })().catch((e) => { console.log('FAIL  F7 threw:', e.stack); process.exitCode = 1; });
}

// F8: the chat button stops a member of the audience in whatever state: watching, away, or still being added
{
  const w = pageWorld(), K = w.K, btn = w.$('btnShare');
  w.sess('bob', true); K.capture.state = 'live';
  w.S.contacts.push({ pub: 'cy', name: 'Cy', status: 'offline' }, { pub: 'dee', name: 'Dee', status: 'online' }, { pub: 'eve', name: 'Eve', status: 'online' });
  K.cast.members.set('cy', { state: 'away', mode: 'one', timer: null, back: null }); K.cast.members.set('dee', { state: 'joining', mode: 'one', timer: null, back: null });
  const text = (pub) => { w.S.current = pub; K.paint(); return btn.textContent; };
  ok('F8 the button reads Stop sharing in the chat of a watching, an away and a joining member; Add to share for anyone else', [text('bob'), text('cy'), text('dee'), text('eve')].join() === '■ Stop sharing,■ Stop sharing,■ Stop sharing,＋ Add to share');
  w.S.current = 'cy'; w.toasts.length = 0; btn.onclick();
  ok('F8 a click in the away member\'s chat takes it out of the audience: no "offline" toast, nothing added', !K.cast.members.has('cy') && w.toasts.length === 0 && K.cast.members.size === 2);
  w.S.current = 'dee'; btn.onclick();
  ok('F8 a click in the chat of a member that is still being added takes it out as well', !K.cast.members.has('dee') && K.cast.members.size === 1 && w.toasts.length === 0);
  ok('F8 and the button is back to Add to share there', text('cy') === '＋ Add to share' && text('dee') === '＋ Add to share');
}

// P1: one pop-up per incoming share, per contact
{
  const { createSharePops } = require('../main/sharepop.js');
  const p = createSharePops(), st = (pub, sid, screen = true) => ({ op: 'state', pub, sid, screen });
  ok('P1 the first state frame with a screen pops up, the next ones of that share do not', p.wants(st('a', '1')) && !p.wants(st('a', '1')) && !p.wants(st('a', '1')));
  ok('P1 a second contact sharing meanwhile pops up once and does not bring the first back', p.wants(st('b', '2')) && !p.wants(st('a', '1')) && !p.wants(st('b', '2')) && !p.wants(st('a', '1')));
  ok('P1 a state frame without a screen, an offer and a candidate pop nothing', !p.wants(st('c', '3', false)) && !p.wants({ op: 'sdp', pub: 'c', sid: '3' }) && !p.wants({ op: 'ice', pub: 'c', sid: '3' }) && p.size() === 2);
  ok('P1 a share that gets its screen later pops then', p.wants(st('c', '3')) && !p.wants(st('c', '3')));
  ok('P1 the next share of a contact (a new sid) pops up again', p.wants(st('a', '4')) && !p.wants(st('a', '4')));
  ok('P1 a bye forgets the contact', !p.wants({ op: 'bye', pub: 'a', sid: '4' }) && p.size() === 2 && p.wants(st('a', '4')));
}
