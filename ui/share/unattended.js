'use strict';
// Screen share: unattended access, the page's part of both roles. The gate is in main
// (main/unattended.js): it checks the password a contact was given and only then calls start() here.
//
// Host (this machine is the one being accessed): start() sends that contact this screen the ordinary
// way (K.cast.add). The microphone (and this computer's sound, and captions) go too only when the owner
// turned on "unattended audio" in Settings: otherwise nobody is here to say that the room may be heard,
// so the screen goes alone. When audio does go, the notice on screen says so and offers to mute it. The
// contact is kept in `hosted` until that share ends, for whatever reason. While it is hosted, its
// request for control is allowed without the dialog (share/control.js asks hosts()): the owner of
// this machine gave that answer beforehand, in the contact's info. Main is told who is hosted on
// every change and keeps a notice on the screen for as long as anyone is (main/accesscard.js).
// A hosted contact that drops out is not added again by itself: it connects anew, with the password.
//
// Visitor (this machine connects to a contact's): the dialog that asks for the password, and the
// request for control that goes out by itself once their screen is here.
//
// Reads from app.js: S, $, toast, contact, ipcErr, show, openModal, window.closeModal. Reads K.cast,
// K.control, K.sessions, K.tune, K.nameOf and K.paint at call time.
(() => {
  const K = window.ShareKit;

  // --- host ---------------------------------------------------------------------------------
  const hosted = new Set();      // contacts connected to this machine unattended
  const say = (line) => window.api.log(`unattended: ${line}`).catch(() => {});   // to the app log: who was let in, and what became of it
  const starting = new Set();    // contacts whose unattended share is being started
  let told = '';
  // Settings, "In an unattended session, also send your microphone, this computer's sound and captions":
  // off by default. When on, an unattended share carries audio exactly as a share the owner starts.
  const withAudio = () => typeof S !== 'undefined' && !!(S.settings && S.settings.unattendedAudio);
  // What this machine is actually sending to the hosted contacts right now: whether the microphone is on
  // (and so whether its sound and captions ride with it). null when no hosted session carries audio.
  function audio() {
    if (!withAudio() || !hosted.size) return null;
    let has = false, on = false;
    for (const p of hosted) { const x = K.sessions.get(p); if (x && x.micTrack) { has = true; if (x.micTrack.enabled) on = true; } }
    if (!has) return null;
    return { on, sound: on && !!(K.capture && K.capture.sound), cap: on && !!(S.settings && S.settings.captionsOut) };
  }
  // The notice is part of the picture every viewer gets, so it names the contact only when that
  // contact is the whole audience; with anyone else watching it counts. When audio goes out it says so.
  function sync() {
    const n = hosted.size, only = n === 1 && K.cast.members.size === 1 ? K.nameOf([...hosted][0]) : '';
    const base = !n ? '' : only ? `${only} is connected to this computer` : n === 1 ? 'A contact is connected to this computer' : `${n} contacts are connected to this computer`;
    const a = audio();
    const suffix = !n || !a ? '' : a.on ? ` · microphone on${a.sound ? ' + sound' : ''}${a.cap ? ' + captions' : ''}` : ' · microphone muted';
    const text = base + suffix;
    const now = JSON.stringify([[...hosted].sort(), text, a ? a.on : null]);
    if (now === told) return;
    told = now;
    window.api.uaLive({ pubs: [...hosted], text, audio: a ? { on: a.on } : null }).catch(() => {});
  }
  // The Mute button on the notice: flips the microphone for everyone connected unattended (one microphone,
  // one switch, like the share bar). Reuses the ordinary audience mute through a session that carries it.
  function muteToggle() {
    const pub = [...hosted].find((p) => { const x = K.sessions.get(p); return x && x.micTrack; });
    if (!pub) return;
    K.cast.talk(K.sessions.get(pub));
    sync();
  }
  // main: the password was right. Resolves { ok } or { ok: false, why } with a reason the visitor is told.
  async function start(pub) {
    pub = String(pub || '');
    if (!contact(pub)) return { ok: false, why: 'unavailable' };
    if (hosted.has(pub)) return { ok: true };
    if (starting.has(pub)) return { ok: false, why: 'busy' };
    const inAudience = K.cast.members.has(pub);
    if ((!inAudience && K.cast.count() >= K.tune.MAX_AUDIENCE) || (!K.sessions.get(pub) && K.sessions.map.size >= K.MAX_SESSIONS)) return { ok: false, why: 'busy' };
    starting.add(pub);
    let ok = false;
    try { ok = await K.cast.add(pub, 'one', withAudio() ? {} : { mic: false }); } catch (e) { console.error('unattended start', e); }
    if (!starting.delete(pub)) { if (ok) K.cast.remove(pub); return { ok: false, why: 'off' }; }   // stopped while the capture was starting
    if (!ok) return { ok: false, why: 'capture' };
    hosted.add(pub); say(`hosting ${pub.slice(0, 8)}`);
    toast(`${K.label(pub, 'A contact')} connected with unattended access`);
    sync(); K.paint();
    return { ok: true };
  }
  // main: end the unattended session with this contact (switched off, new password), or with everyone (Disconnect on the notice)
  function stop(pub) {
    for (const p of pub ? [String(pub)] : [...hosted, ...starting]) {
      if (!hosted.has(p) && !starting.has(p)) continue;
      starting.delete(p);
      K.cast.remove(p);                                   // through drop(): left() takes it out of `hosted`
    }
  }
  // share/cast.js: this contact no longer gets my screen
  function left(pub) { if (hosted.delete(pub)) { say(`no longer hosting ${pub.slice(0, 8)}`); toast('Unattended access ended'); sync(); } }
  // share/control.js: what became of a hosted contact's request for control ('' = it is on)
  const said = (pub, why) => say(`control for ${pub.slice(0, 8)}: ${why ? `not given (${why})` : 'on'}`);
  // main: a wrong password, or a lockout after too many
  function onNote(ev) {
    const name = K.label(ev.pub, 'A contact');
    if (ev.what === 'locked') toast(`${name} gave a wrong unattended-access password too often and is locked out for ${Math.ceil((ev.wait || 0) / 60)} min`, 'err');
    else if (ev.what === 'wrong') toast(`${name} gave a wrong unattended-access password (${ev.left} ${ev.left === 1 ? 'try' : 'tries'} left)`, 'err');
  }

  // --- visitor ------------------------------------------------------------------------------
  const wanted = new Map();      // pub -> ms: until then control of their screen is asked for by itself
  const WANT_MS = 90000;
  // Called where either half of what a request needs can arrive: their `state` frame, the control channel.
  function maybeAsk(sess) {
    const until = wanted.get(sess.pub);
    if (!until) return;
    if (Date.now() > until) { wanted.delete(sess.pub); return; }
    const ch = sess.ctl.dc;
    if (!sess.remote.screen || !ch || ch.readyState !== 'open' || sess.ctl.take || sess.ctl.asked) return;
    wanted.delete(sess.pub);
    window.api.log(`unattended: their screen is here, asking for control (${sess.id})`).catch(() => {});
    K.control.ask(sess);
  }
  const WHY = {
    off: (n) => `${n} has not switched on unattended access for you.`,
    noanswer: (n) => `No answer from ${n}'s app. Unattended access needs version 0.10.0 or newer there.`,
    wrong: () => 'Wrong password.',
    locked: (_n, r) => `Too many wrong passwords. Try again in ${Math.max(1, Math.ceil((r.wait || 60) / 60))} min.`,
    expired: () => 'That took too long. Try again.',
    busy: (n) => `${n}'s computer is busy with other screen shares.`,
    perm: (n) => `${n}'s computer has not allowed P2P Chat to capture its screen yet.`,
    capture: (n) => `${n}'s computer could not start its screen capture.`,
    offline: (n) => `${n} is offline.`,
    inflight: () => 'Already connecting.',
    unavailable: (n) => `${n}'s computer cannot be reached that way right now.`,
  };
  let dialogFor = null, busy = false;
  function paintDialog(err) {
    $('uaGo').disabled = busy; $('uaGo').textContent = busy ? 'Connecting…' : 'Connect'; $('uaPass').disabled = busy;
    if (err !== undefined) { $('uaErr').textContent = err; $('uaErr').classList.toggle('hidden', !err); }
  }
  function openDialog(pub) {
    const c = contact(pub);
    if (!c) return;
    if (c.status !== 'online') { toast(`${c.name} is offline: unattended access needs their app running and connected`, 'err'); return; }
    dialogFor = pub; $('uaName').textContent = c.name; $('uaPass').value = '';
    paintDialog('');
    show('mUa');
  }
  async function go() {
    const pub = dialogFor, pass = $('uaPass').value;
    if (!pub || busy) return;
    if (!pass) { paintDialog('Enter the password they set for you.'); return; }
    const name = K.nameOf(pub);
    busy = true; paintDialog('');
    if ($('uaCtl').checked) wanted.set(pub, Date.now() + WANT_MS); else wanted.delete(pub);
    let r;
    try { r = await window.api.uaConnect(pub, pass); } catch (e) { r = { ok: false, why: 'unavailable', message: ipcErr(e) }; }
    busy = false; $('uaPass').value = '';
    if (r && r.ok) {
      paintDialog('');
      if (openModal === 'mUa') window.closeModal();
      toast(`Connected to ${name}'s computer${S.current === pub ? '' : ': open that chat to see it'}`, 'ok');
      const sess = K.sessions.get(pub); if (sess) maybeAsk(sess);
    } else {
      wanted.delete(pub);
      const say = (r && Object.hasOwn(WHY, r.why) ? WHY[r.why](name, r) : '') || (r && r.message) || 'Could not connect.';
      paintDialog(say);
      if (openModal !== 'mUa') toast(say, 'err'); else setTimeout(() => $('uaPass').focus(), 30);
    }
  }
  $('shareUaOpen').onclick = () => { $('shareMenu').classList.add('hidden'); if (S.current) openDialog(S.current); };
  $('uaGo').onclick = go;
  $('uaPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });

  K.unattended = { start, stop, left, said, sync, muteToggle, onNote, maybeAsk, openDialog, hosts: (pub) => hosted.has(pub), hosted: () => [...hosted], wanted: () => [...wanted.keys()] };
})();
