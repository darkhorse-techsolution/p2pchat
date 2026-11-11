// The share code of the renderer (ui/share/*.js) without a window: the parts that are plain logic.
// Each of those files is one closure that hangs its part on window.ShareKit and reads the app's
// globals only when called, so it loads into a bare context that has just what a test hands in.
// At the end, main's memory of which share already raised its pop-up (main/sharepop.js).
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
function load(files, globals = {}) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  ctx.window = ctx;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'share', f), 'utf8'), ctx, { filename: f });
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
  K.sessions = { get: (pub) => sessions[pub] || null, all: () => Object.values(sessions) }; K.control = { owner: null }; K.paint = () => { paints++; };
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

// L1: the capture stops with its last lease, also when that lease goes while a microphone is being started
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
    ok('L1 a capture whose last lease went during a microphone start is not stopped under that call', live === true && K.cast.adding === 1 && K.capture.state === 'live' && K.capture.leases.size === 0);
    answerMic(); await talking;
    ok('L1 and is stopped when the call ends: no device left on, main told once', K.cast.adding === 0 && K.capture.state === 'idle' && K.mic.state === 'idle' && ended === 1 && made.length === 3 && made.every((t) => t.readyState === 'ended'));
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
  const w = { now: 1e12, sent: [], toasts: [], dialogs: [], grants: [], revoked: [], timers: [] };
  w.K = load(['kit.js', 'tune.js', 'control.js'], { toast: (t) => w.toasts.push(t), ipcErr: (e) => String((e && e.message) || e), contact: (pub) => ({ pub, name: pub[0].toUpperCase() + pub.slice(1) }),
    Date: { now: () => w.now }, setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; w.timers.push(t); return t; }, clearTimeout: (t) => { if (t) t.on = false; },
    api: { controlGrant: (pub) => new Promise((res) => w.grants.push({ pub, res })), controlRevoke: async (token) => { w.revoked.push(token); return true; }, input() {} } });
  w.K.sessions = { dc: (sess, _label, msg) => { w.sent.push(`${sess.pub}:${JSON.stringify(msg)}`); return true; } };
  w.K.viewer = { bound: null, applyCtl() {}, showAsk: (sess) => w.dialogs.push(sess.pub) };
  w.K.cast = { retier() {} }; w.K.paint = () => {}; w.K.unprompt = () => {};
  w.sess = (pub) => ({ pub, closed: false, screenTrack: { contentHint: '' }, remote: { screen: true }, ctl: { give: 'off', take: false, asked: false, askTimer: null, flush: null, move: null, cursor: null, token: null, deniedAt: 0 } });
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
    ok('R3 Allow on that dialog then grants it', C.owner && C.owner.token === 'fresh' && bob.ctl.give === 'on' && w.sent.join() === 'bob:{"t":"ctl","on":true}');
    const v = controlWorld(), D = v.K.control, cy = v.sess('cy');
    v.from(cy, { t: 'req' }); D.allow(); await tick(); v.from(cy, { t: 'rel' }); v.sent.length = 0;
    v.grants[0].res({ ok: true, token: 'stale' }); await tick();
    ok('R3 with no new request the stale grant still ends in a plain no', v.revoked.join() === 'stale' && cy.ctl.give === 'off' && v.sent.join() === 'cy:{"t":"ctl","on":false,"why":"notsharing"}');
  })().catch((e) => { console.log('FAIL  R3 threw:', e.stack); process.exitCode = 1; });
}

// R4: a request that is taken back or runs out starts the same cooldown as a Deny
{
  const w = controlWorld(), C = w.K.control, bob = w.sess('bob');
  for (let i = 0; i < 50; i++) { w.from(bob, { t: 'req' }); w.from(bob, { t: 'rel' }); }
  w.from(bob, { t: 'req' });
  ok('R4 fifty-one requests with fifty withdrawals in between open the dialog once', w.dialogs.length === 1 && C.pending === null && bob.ctl.give === 'off');
  w.now += w.K.DENY_COOLDOWN_MS - 1; w.from(bob, { t: 'req' }); const early = w.dialogs.length;
  w.now += 2; w.from(bob, { t: 'req' });
  ok('R4 and the next one comes up when the cooldown is over, not before', early === 1 && w.dialogs.length === 2 && C.pending && C.pending.sess === bob);
  w.sent.length = 0; w.timers.filter((t) => t.on && t.ms === w.K.tune.GIVE_ASK_MS).forEach((t) => t.fn());   // nobody answers: the dialog gives up
  w.from(bob, { t: 'req' }); const afterExpiry = w.dialogs.length;
  w.now += w.K.DENY_COOLDOWN_MS + 1; w.from(bob, { t: 'req' });
  ok('R4 a request that ran out is told so, and asking again is held off for the cooldown as well', w.sent[0] === 'bob:{"t":"ctl","on":false,"why":"expired"}' && afterExpiry === 2 && w.dialogs.length === 3);
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
