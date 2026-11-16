// Screen-share speed and reliability work (0.12.0): the ICE config that prefers a direct path, the codec
// the Settings choice puts first, the adaptive receive buffer, and the reconnect that restarts ICE instead
// of dropping a session that was up. No window: tune.js over stand-ins, session.js's reconnect driven
// through a fake RTCPeerConnection, and iceConfig read from the text of main/main.js.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const js = (v) => JSON.stringify(v);
const tick = () => new Promise((r) => setImmediate(r));

function loadTune(S) {
  const codecs = [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }, { mimeType: 'video/VP9' }, { mimeType: 'video/AV1' }, { mimeType: 'video/rtx' }];
  const ctx = vm.createContext({ console, S, RTCRtpReceiver: { getCapabilities: () => ({ codecs }) } });
  ctx.window = ctx;
  for (const f of ['kit.js', 'tune.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'share', f), 'utf8'), ctx, { filename: f });
  return ctx.ShareKit;
}

// P1: the codec the offer puts first follows the Settings choice
{
  const order = (mode) => {
    const K = loadTune({ settings: { videoCodec: mode } });
    let picked = null;
    const sender = {}, pc = { getTransceivers: () => [{ sender, setCodecPreferences: (list) => { picked = list.map((c) => c.mimeType.replace('video/', '')); } }] };
    K.tune.codecs(pc, sender);
    return picked;
  };
  ok('P1 smooth (default): H.264 first, then VP9, the rest after', js(order('smooth')) === js(['H264', 'VP9', 'VP8', 'AV1', 'rtx']));
  ok('P1 sharp: VP9 first, then H.264', js(order('sharp')) === js(['VP9', 'H264', 'VP8', 'AV1', 'rtx']));
  ok('P1 anything else is treated as smooth', js(order('')) === js(['H264', 'VP9', 'VP8', 'AV1', 'rtx']) && js(order(undefined)) === js(['H264', 'VP9', 'VP8', 'AV1', 'rtx']));
  // no capabilities, no transceiver, no setCodecPreferences: no throw
  const K = loadTune({ settings: {} });
  ok('P1 nothing to set: no throw', (() => { try { K.tune.codecs({ getTransceivers: () => [] }, {}); return true; } catch { return false; } })());
}

// P2: the receive buffer by path and by whether I control the screen
{
  const K = loadTune({ settings: {} });
  const mk = () => { const r = { set: [] }; Object.defineProperty(r, 'jitterBufferTarget', { set: (v) => r.set.push(v) }); Object.defineProperty(r, 'playoutDelayHint', { set: () => {} }); return { remote: { videoReceiver: r }, ctl: { take: false }, path: '', bufSet: undefined, r }; };
  const last = (s) => s.r.set[s.r.set.length - 1];
  let s = mk(); K.tune.setBuffer(s);
  ok('P2 path not known yet: a little cushion so a lossy start does not freeze', last(s) === 80);
  s = mk(); s.path = 'direct'; K.tune.setBuffer(s);
  ok('P2 direct, watching: almost nothing', last(s) === 30);
  s = mk(); s.path = 'direct'; s.ctl.take = true; K.tune.setBuffer(s);
  ok('P2 direct, controlling: nothing', last(s) === 0);
  s = mk(); s.path = 'via call server'; K.tune.setBuffer(s);
  ok('P2 relayed, watching: a cushion against loss', last(s) === 140);
  s = mk(); s.path = 'via call server'; s.ctl.take = true; K.tune.setBuffer(s);
  ok('P2 relayed, controlling: a smaller cushion, the pointer stays live', last(s) === 50);
  // set only when it changes, and the sharer (no receiver) is a no-op
  s = mk(); s.path = 'via call server'; K.tune.setBuffer(s); K.tune.setBuffer(s); K.tune.setBuffer(s);
  ok('P2 the same value is not set again', s.r.set.length === 1);
  s.ctl.take = true; K.tune.setBuffer(s);
  ok('P2 but a change is', s.r.set.length === 2 && last(s) === 50);
  const sharer = { remote: { videoReceiver: null }, ctl: { take: false }, path: 'direct' };
  ok('P2 no receiver (the sharer side): nothing happens, no throw', (() => { try { K.tune.setBuffer(sharer); return true; } catch { return false; } })());
}

// P3: the ICE config prefers a direct path (public STUN as a backup), and relay-only keeps the IP off third parties
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8'), lines = src.split('\n');
  const line = (re) => (lines.find((x) => re.test(x)) || '').trim();
  const block = (re) => { const i = lines.findIndex((x) => re.test(x)); if (i < 0) return ''; let j = i; while (lines[j] !== '}') j++; return lines.slice(i, j + 1).join('\n'); };
  const run = (relayOnly, host) => {
    const ctx = vm.createContext({ settings: () => ({ callsRelayOnly: relayOnly }), turnCfg: () => ({ host, user: 'u', pass: 'p' }) });
    vm.runInContext(`${line(/^const PUBLIC_STUN = /)} ${block(/^function iceConfig\(\) \{/)} this.cfg = iceConfig();`, ctx);
    return ctx.cfg;
  };
  const on = run(false, 'box:3478');
  const urls = on.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  ok('P3 not relay-only: the policy is all, the box is there, and public STUN is added as a backup', on.iceTransportPolicy === 'all' && urls.some((u) => /^turn:box/.test(u)) && urls.some((u) => /stun:box/.test(u)) && urls.some((u) => /stun\.l\.google\.com/.test(u)) && urls.some((u) => /cloudflare/.test(u)));
  const relay = run(true, 'box:3478');
  const rurls = relay.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
  ok('P3 relay-only: the policy is relay and no public STUN is contacted (the IP stays off third parties)', relay.iceTransportPolicy === 'relay' && !rurls.some((u) => /google|cloudflare/.test(u)) && rurls.some((u) => /^turn:box/.test(u)));
  const none = run(false, '');
  ok('P3 no call server set: still offers public STUN for a direct path', none.iceTransportPolicy === 'all' && none.iceServers.length === 1 && none.iceServers[0].urls.some((u) => /google/.test(u)));
}

// P4: a session that was up and dropped restarts ICE and is kept; it is let go only if nothing comes back
{
  (async () => {
    const { pageWorld } = require('./share-world.js');
    const open = (pub) => {
      const pcs = [];
      const w = pageWorld({ RTCPeerConnection: function () { const pc = { connectionState: 'new', restarts: 0, close() {}, restartIce() { pc.restarts++; }, getStats: async () => new Map() }; pcs.push(pc); return pc; } });
      w.S.contacts.push({ pub, name: pub[0].toUpperCase() + pub.slice(1), status: 'online' });
      return { w, pcs };
    };
    const fire = (pc, state) => { pc.connectionState = state; pc.onconnectionstatechange(); };
    const timer = (w, ms) => w.timers.filter((t) => t.on && t.ms === ms);

    // 'bob': S.me.pub 'me' is not < 'bob', so this side is impolite and drives the ICE restart
    let { w, pcs } = open('bob');
    let sess = w.K.sessions.open('bob', 'sid', false); await sess.ready; const pc = pcs[0];
    fire(pc, 'connected'); w.toasts.length = 0;
    fire(pc, 'disconnected');
    ok('P4 a drop after it was up does not close the session', w.K.sessions.map.has('bob') && !sess.closed && /Reconnecting/.test(w.toasts.join()));
    fire(pc, 'disconnected'); fire(pc, 'disconnected');
    ok('P4 said once, however many times it flaps', w.toasts.filter((t) => /Reconnecting/.test(t)).length === 1);
    ok('P4 ICE is not restarted at once for a disconnect (it often heals itself)', pc.restarts === 0 && timer(w, w.K.ICE_WAIT_MS).length === 1);
    timer(w, w.K.ICE_WAIT_MS).forEach((t) => t.fn());
    ok('P4 after the wait, ICE is restarted to punch a fresh path', pc.restarts === 1);
    w.toasts.length = 0; fire(pc, 'connected');
    ok('P4 it comes back: reconnected, and the give-up timer is cancelled', /Reconnected/.test(w.toasts.join()) && sess.reconnectAt === 0 && timer(w, w.K.RECONNECT_MS).length === 0);

    // never comes back: let go after RECONNECT_MS, with a bye
    ({ w, pcs } = open('bob')); sess = w.K.sessions.open('bob', 'sid', false); await sess.ready; const pc2 = pcs[0];
    fire(pc2, 'connected'); fire(pc2, 'failed'); w.sent.length = 0;
    ok('P4 failed will not heal: ICE is restarted at once, not after the wait', timer(w, 0).length >= 1);
    const give = timer(w, w.K.RECONNECT_MS); give.forEach((t) => t.fn());
    ok('P4 nothing came back within the window: the session is let go, with a bye', sess.closed && w.sent.includes('bob:bye') && /dropped and could not reconnect/.test(w.toasts.join()));

    // the polite side waits for the offer, it does not restart ICE itself (no glare)
    ({ w, pcs } = open('aa')); sess = w.K.sessions.open('aa', 'sid', false); await sess.ready; const pc3 = pcs[0];   // 'me' < 'aa' is false too; use a pub that makes polite
    // force polite for this check
    sess.polite = true; fire(pc3, 'connected'); fire(pc3, 'failed');
    timer(w, 0).forEach((t) => t.fn()); timer(w, w.K.ICE_WAIT_MS).forEach((t) => t.fn());
    ok('P4 the polite side does not restart ICE (it waits for the offer): no glare', pc3.restarts === 0 && !sess.closed);

    // a session that never connected and fails still closes, as before
    ({ w, pcs } = open('cc')); sess = w.K.sessions.open('cc', 'sid', false); await sess.ready; const pc4 = pcs[0];
    fire(pc4, 'failed');
    ok('P4 a share that never connected and fails is closed, as before', sess.closed && /failed\. Check the call server/.test(w.toasts.join()));
  })().catch((e) => { console.log('FAIL  P4 threw:', e.stack); process.exitCode = 1; });
}
