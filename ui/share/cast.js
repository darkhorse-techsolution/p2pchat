'use strict';
// Screen share: what I send. The app has one capture of the display and one microphone, each held by an
// owner (K.capture, K.mic). A session never gets the device's own track: it gets a clone (its lease) and
// stops only that, so one capture can go to several contacts and ending one share never cuts another.
// The device stops when its last lease is given back and nothing is being started. K.cast is who gets my
// screen: an entry per contact from the click on Share until that contact's share ends.
//
// Reads from app.js: toast, contact, renderContacts, window.showScreenPermission. Reads K.sessions, K.tune,
// K.control.endGive and K.paint at call time.
(() => {
  const K = window.ShareKit;
  const cast = K.cast = { members: new Map(), adding: 0 };   // adding: add() and talk() calls in flight

  // --- the two devices ---------------------------------------------------------------
  // Starting a device takes several awaits (the permission, then the device), so every call that arrives
  // while one start runs waits for that same start: one click or ten, one capture. `open` resolves to
  // { track }, or to { err }: the text each caller that is not quiet shows, '' when the user was told already.
  function source(open, stopped) {
    const o = { state: 'idle', src: null, pending: null, leases: new Map() };
    o.acquire = async (quiet) => {
      if (o.state === 'live') return true;
      if (!o.pending) {
        o.state = 'starting';
        o.pending = open().catch((e) => ({ err: e.message })).then((r) => { o.pending = null; o.src = r.track || null; o.state = o.src ? 'live' : 'idle'; return r; });
      }
      const r = await o.pending;
      if (!r.track && r.err && !quiet) toast(r.err, 'err');
      return o.state === 'live';
    };
    o.lease = (sess) => {
      if (o.state !== 'live') return null;
      let t = o.leases.get(sess);
      if (!t) { t = o.src.clone(); o.leases.set(sess, t); }
      return t;
    };
    o.release = (sess) => { const t = o.leases.get(sess); if (t) { o.leases.delete(sess); t.stop(); } };
    // Not while a share or a microphone is being started: that call has not taken its lease yet and
    // would find the device gone.
    o.settle = () => { if (o.state === 'live' && o.leases.size === 0 && cast.adding === 0) o.stopSrc(); };
    o.stopSrc = () => { const t = o.src; if (!t) return; t.onended = null; t.stop(); o.src = null; o.state = 'idle'; if (stopped) stopped(); };   // stop() fires no `ended`, so nothing waits for one
    return o;
  }
  const capture = K.capture = source(async () => {
    const perm = await window.api.screenPermission();   // macOS: ask before trying, with instructions instead of a capture error
    if (perm !== 'ok') { window.showScreenPermission(perm); return { err: '' }; }
    let track;
    try { track = (await navigator.mediaDevices.getDisplayMedia(K.tune.displayConstraints())).getVideoTracks()[0]; }
    catch (e) { toast(`Could not capture the screen: ${e.message}`, 'err'); return { err: '' }; }
    await K.tune.capture(track);
    track.onended = () => stop('capture');              // the OS ended the capture
    return { track };
  }, () => {
    for (const m of cast.members.values()) clearTimeout(m.timer);
    cast.members.clear();
    window.api.captureEnded().catch(() => {});           // main forgets the shared display, and with it any control of it
  });
  const mic = K.mic = source(async () => {
    if (!(await window.api.micPermission())) return { err: 'Microphone access was not allowed; sharing without sound' };
    try { return { track: (await navigator.mediaDevices.getUserMedia(K.tune.micConstraints())).getAudioTracks()[0] }; }
    catch (e) { return { err: `Microphone: ${e.message}` }; }
  });
  mic.audienceOn = true;

  // --- the audience ------------------------------------------------------------------
  cast.count = () => [...cast.members.values()].filter((m) => m.state === 'joining' || m.state === 'live').length;
  const idle = (sess) => !sess.remote.screen && !sess.remote.mic && !sess.screenTrack && !sess.micTrack;   // nothing flows either way

  function attachMic(sess) {
    const t = mic.lease(sess);
    if (!t) return false;
    const st = K.tune.streamFor(sess, 'audio');
    st.addTrack(t); sess.micSender = sess.pc.addTrack(t, st); sess.micTrack = t; sess.micStream = st;
    return true;
  }
  function detach(sess, which) {
    const t = sess[which + 'Track'], snd = sess[which + 'Sender'], st = which === 'mic' ? sess.micStream : sess.local;
    if (snd && sess.pc) { try { sess.pc.removeTrack(snd); } catch {} }
    (which === 'mic' ? mic : capture).release(sess);
    if (t && st) st.removeTrack(t);
    sess[which + 'Track'] = null; sess[which + 'Sender'] = null;
  }

  // Send my screen (and my microphone, when it can be had) to this contact. The audience entry and the
  // count of calls in flight are set before the first await, so a second click finds the first one, and
  // neither device is stopped under a call that has not taken its lease yet. After every await the call
  // checks that the session is still open and still its own: Stop or a closed session ends it there,
  // and nothing more is attached.
  async function add(pub, mode) {
    const c = contact(pub);
    if (!c) return false;
    if (c.status !== 'online') { toast(`${c.name} is offline: a screen share needs them connected`, 'err'); return false; }
    const had = cast.members.get(pub);
    if (had && (had.state === 'joining' || had.state === 'live')) return true;
    const other = K.sessions.all().find((x) => x.pub !== pub);
    if (other) { toast(`End the share with ${contact(other.pub)?.name || 'the other contact'} first`, 'err'); return false; }
    if (cast.count() >= K.tune.MAX_AUDIENCE) { toast(`A screen share goes to at most ${K.tune.MAX_AUDIENCE} contacts at once`, 'err'); return false; }
    const sess = K.sessions.get(pub) || K.sessions.open(pub, null, false);
    if (!sess) { toast('Too many screen shares at once', 'err'); return false; }
    const me = { state: 'joining', mode, timer: null };
    cast.members.set(pub, me); cast.adding++;
    const gone = () => sess.closed || cast.members.get(pub) !== me;
    try {
      const ok = await capture.acquire();
      await sess.ready;
      if (!ok || gone()) {
        if (cast.members.get(pub) === me) cast.members.delete(pub);
        if (!sess.closed && idle(sess)) K.sessions.close(sess, 'capture');   // a session opened for this share and nothing else
        return false;
      }
      sess.mode = mode || sess.mode;
      const t = capture.lease(sess);
      t.contentHint = K.tune.hint(false);
      sess.screenTrack = t; sess.local.addTrack(t);
      K.sessions.openChannels(sess);                          // in the same task as addTrack: one negotiation covers both
      sess.screenSender = sess.pc.addTrack(t, K.tune.streamFor(sess, 'video'));
      K.tune.codecs(sess.pc, sess.screenSender);
      if (!sess.micTrack && mic.state === 'live' && !K.tune.SPLIT_MIC) attachMic(sess);   // a microphone that is on already rides the same offer
      await K.tune.sender(sess);
      if (gone()) return false;
      if (!sess.micTrack) {
        const got = await mic.acquire(true);
        if (gone()) return false;
        if (got && K.tune.SPLIT_MIC) { await sess.peerSeen; if (gone()) return false; }   // a stream of its own only for a peer known to sort tracks by kind
        if (got && !sess.micTrack) attachMic(sess);
      }
      me.state = 'live';
      K.sessions.sendState(sess);                             // after the microphone attempt: a peer that starts recording on this frame gets the sound too
      K.paint(); renderContacts();
      return true;
    } finally { cast.adding--; capture.settle(); mic.settle(); }
  }

  // Stop sending my screen to this contact. The session stays while they still send something.
  function remove(pub) {
    const m = cast.members.get(pub), sess = K.sessions.get(pub);
    if (m) { clearTimeout(m.timer); cast.members.delete(pub); }
    if (sess) {
      K.control.endGive(sess, 'stopped');
      detach(sess, 'screen'); detach(sess, 'mic');
      K.sessions.sendState(sess);
      if (!sess.remote.screen && !sess.remote.mic) K.sessions.close(sess, 'stopped');
    }
    capture.settle(); mic.settle();
    K.paint(); renderContacts();
  }
  function stop(why) {
    for (const pub of new Set([...cast.members.keys(), ...[...capture.leases.keys()].map((x) => x.pub)])) remove(pub);
    capture.stopSrc();
    if (why === 'capture') toast('Screen sharing stopped: the capture ended', 'err');
  }

  // The microphone button: on a session without one it starts the microphone, after that it mutes and unmutes.
  async function talk(sess) {
    if (sess.micTrack) sess.micTrack.enabled = !sess.micTrack.enabled;
    else {
      cast.adding++;
      try {
        const got = await mic.acquire(false);
        await sess.ready;
        if (sess.closed) return;
        if (got && K.tune.SPLIT_MIC) { await sess.peerSeen; if (sess.closed) return; }
        if (got && !sess.micTrack) attachMic(sess);           // a second click waited on the same start and finds it attached
      } finally { cast.adding--; mic.settle(); }
    }
    K.sessions.sendState(sess); K.paint();
  }

  // a session closes: its leases go back, and a device nobody else holds stops
  function sessionClosed(sess) {
    capture.release(sess); mic.release(sess);
    sess.screenTrack = sess.micTrack = sess.screenSender = sess.micSender = null;
    const m = cast.members.get(sess.pub);
    if (m) { clearTimeout(m.timer); cast.members.delete(sess.pub); }
    capture.settle(); mic.settle();
  }

  Object.assign(cast, { add, attachMic, detach, remove, stop, talk, sessionClosed });
})();
