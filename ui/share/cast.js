'use strict';
// Screen share: what I send. The app has one capture of the display and one microphone, each held by an
// owner (K.capture, K.mic). A session never gets the device's own track: it gets a clone (its lease) and
// stops only that, so one capture can go to several contacts and ending one share never cuts another.
// The device stops when its last lease is given back and nothing is being started. K.cast is the audience:
// an entry per contact who gets my screen, from the click that adds them until their share ends. Up to
// K.tune.MAX_AUDIENCE of them watch the one capture; they see my screen and hear my microphone, not each other.
//
// Reads from app.js: toast, contact, renderContacts, window.showScreenPermission. Reads K.sessions, K.tune,
// K.control, K.clip, K.nameOf and K.paint at call time.
(() => {
  const K = window.ShareKit;
  // members: pub -> { state: 'joining' | 'live' | 'away', mode, timer, back }; adding: add() and talk() calls in flight;
  // leasing: the add() calls among them that have not taken their lease of the capture yet
  const cast = K.cast = { members: new Map(), adding: 0, leasing: 0 };
  const drop = (pub) => { const m = cast.members.get(pub); if (m) { clearTimeout(m.timer); clearTimeout(m.back); cast.members.delete(pub); } };

  // --- the two devices ---------------------------------------------------------------
  // Starting a device takes several awaits (the permission, then the device), so every call that arrives
  // while one start runs waits for that same start: one click or ten, one capture. `open` resolves to
  // { track }, or to { err }: the text each caller that is not quiet shows, '' when the user was told already.
  function source(open, stopped, held) {
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
    // Not while a call is on its way to a lease of this device (`held`): it would find the device gone.
    o.settle = () => { if (o.state === 'live' && o.leases.size === 0 && !held()) o.stopSrc(); };
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
    mic.audienceOn = true;                              // a new capture starts with the microphone on; after that only a mute or a click changes it
    return { track };
  }, () => {
    for (const pub of [...cast.members.keys()]) drop(pub);
    window.api.captureEnded().catch(() => {});           // main forgets the shared display, and with it any control of it
  }, () => cast.leasing > 0);   // held only for an add() that has not taken its lease: one that waits on the microphone (a permission prompt can stay open for minutes) holds the microphone, not the screen
  const mic = K.mic = source(async () => {
    if (!(await window.api.micPermission())) return { err: 'Microphone access was not allowed; sharing without sound' };
    try { return { track: (await navigator.mediaDevices.getUserMedia(K.tune.micConstraints())).getAudioTracks()[0] }; }
    catch (e) { return { err: `Microphone: ${e.message}` }; }
  }, null, () => cast.adding > 0);
  mic.audienceOn = true;   // the microphone is one switch for everyone who gets my screen; a session where I only watch has its own

  // --- the audience ------------------------------------------------------------------
  cast.count = () => [...cast.members.values()].filter((m) => m.state === 'joining' || m.state === 'live').length;
  const idle = (sess) => !sess.remote.screen && !sess.remote.mic && !sess.screenTrack && !sess.micTrack;   // nothing flows either way
  // The encoder values a session gets: by the size of the audience, and whether this viewer drives my screen.
  const tierOf = (sess) => K.tune.tier(cast.count(), !!K.control.owner && K.control.owner.sess === sess && sess.ctl.give === 'on');
  // on every change of the audience or of who controls: each viewer's encoder is set again, nothing is renegotiated
  function retier() { for (const x of K.sessions.all()) if (x.screenSender) K.tune.sender(x, tierOf(x)); }
  // viewers are told how many watch: this one (its channel just opened), or all of them
  function tell(sess) { for (const x of sess ? [sess] : K.sessions.all()) if (x.screenTrack) K.sessions.dc(x, 'ctl', { t: 'cast', n: cast.count() }); }
  function onTold(sess, m) { sess.remote.cast = Number.isInteger(m.n) && m.n >= 0 && m.n <= 16 ? m.n : 0; K.paint(); }

  function attachMic(sess) {
    const t = mic.lease(sess);
    if (!t) return false;
    const st = K.tune.streamFor(sess, 'audio');
    t.enabled = sess.screenTrack ? mic.audienceOn : true;    // toward someone who gets my screen it starts as the audience's switch stands
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
    if (c.status !== 'online') { toast(`${K.hushed() ? 'That contact' : c.name} is offline: a screen share needs them connected`, 'err'); return false; }
    const had = cast.members.get(pub);
    if (had && (had.state === 'joining' || had.state === 'live')) return true;
    if (cast.count() >= K.tune.MAX_AUDIENCE) { toast(`A screen share goes to at most ${K.tune.MAX_AUDIENCE} contacts at once`, 'err'); return false; }
    const fresh = !K.sessions.get(pub), sess = K.sessions.get(pub) || K.sessions.open(pub, null, false);
    if (!sess) { toast('Too many screen shares at once', 'err'); return false; }
    const me = { state: 'joining', mode, timer: null, back: null };
    drop(pub); cast.members.set(pub, me); cast.adding++; cast.leasing++;
    const gone = () => sess.closed || cast.members.get(pub) !== me;
    let leased = false; const took = () => { if (!leased) { leased = true; cast.leasing--; } };   // this call no longer holds the capture: it has its lease, or it gave up
    try {
      const ok = await capture.acquire();
      await sess.ready;
      if (!ok || gone()) {
        if (cast.members.get(pub) === me) cast.members.delete(pub);
        // Only a session this call opened, and that the contact has not spoken in: one that their own share
        // is just arriving in (the offer is there, the `state` frame not yet) looks as idle and is theirs.
        if (fresh && !sess.seen && !sess.closed && idle(sess)) K.sessions.close(sess, 'capture');
        return false;
      }
      sess.mode = mode || sess.mode;
      const hadMic = !!sess.micTrack;                         // a microphone this session has from before: I talked to them while watching
      const t = capture.lease(sess); took();
      t.contentHint = K.tune.hint(false);
      sess.screenTrack = t; sess.local.addTrack(t);
      K.sessions.openChannels(sess);                          // in the same task as addTrack: one negotiation covers both
      sess.screenSender = sess.pc.addTrack(t, K.tune.streamFor(sess, 'video'));
      K.tune.codecs(sess.pc, sess.screenSender);
      if (!sess.micTrack && mic.state === 'live' && !K.tune.SPLIT_MIC) attachMic(sess);   // a microphone that is on already rides the same offer
      await K.tune.sender(sess, tierOf(sess));
      if (gone()) return false;
      if (!sess.micTrack) {
        const got = await mic.acquire(true);
        if (gone()) return false;
        if (got && K.tune.SPLIT_MIC) { await sess.peerSeen; if (gone()) return false; }   // a stream of its own only for a peer known to sort tracks by kind
        if (got && !sess.micTrack) attachMic(sess);
      }
      // A mute the user set is lifted only by a click on a microphone button. So a contact whose microphone
      // I had muted while watching them does not get it switched on by joining: the mute wins, for the whole
      // audience (the microphone is one switch for everyone who gets my screen), and the user is told.
      // Everyone else gets the switch as it stands. Whichever add() ends first, the outcome is the same.
      if (hadMic && sess.micTrack && !sess.micTrack.enabled && mic.audienceOn) {
        mic.audienceOn = false;
        for (const x of K.sessions.all()) if (x !== sess && x.screenTrack && x.micTrack && x.micTrack.enabled) { x.micTrack.enabled = false; K.sessions.sendState(x); }
        if (cast.members.size >= 2) toast('Microphone muted for everyone you share with');
      }
      if (sess.micTrack) sess.micTrack.enabled = mic.audienceOn;
      me.state = 'live';
      K.sessions.sendState(sess);                             // after the microphone attempt: a peer that starts recording on this frame gets the sound too
      retier(); tell();
      K.paint(); renderContacts();
      return true;
    } finally { took(); cast.adding--; capture.settle(); mic.settle(); }
  }

  // Stop sending my screen to this contact. The session stays while they still send something.
  function remove(pub) {
    const sess = K.sessions.get(pub);
    drop(pub);
    if (sess) {
      K.control.endGive(sess, 'stopped');
      detach(sess, 'screen'); detach(sess, 'mic');
      K.sessions.sendState(sess);
      if (!sess.remote.screen && !sess.remote.mic) K.sessions.close(sess, 'stopped');
    }
    capture.settle(); mic.settle();
    retier(); tell();
    K.paint(); renderContacts();
  }
  // The picker's answer: these contacts get my screen and nobody else. New ones join one way. One that is
  // away stays as it is: it comes back by itself or drops out when its time is up.
  function set(pubs) {
    for (const pub of [...cast.members.keys()]) if (!pubs.includes(pub)) remove(pub);
    for (const pub of pubs) if (!cast.members.has(pub)) add(pub, 'one');
  }
  function stop(why) {
    for (const pub of new Set([...cast.members.keys(), ...[...capture.leases.keys()].map((x) => x.pub)])) remove(pub);
    capture.stopSrc();
    if (why === 'capture') toast('Screen sharing stopped: the capture ended', 'err');
  }

  // The microphone button: on a session without one it starts the microphone, after that it mutes and
  // unmutes. For a contact who gets my screen it is the audience's switch: everyone who gets my screen
  // hears me or nobody does, also when the share began without a microphone and the button starts it.
  // Where I only watch, it is that session's own.
  async function talk(sess) {
    if (!sess.micTrack) {
      cast.adding++;
      try {
        const got = await mic.acquire(false);
        await sess.ready;
        if (sess.closed) return;
        const all = !!sess.screenTrack;                       // this contact gets my screen: the click is for the whole audience
        if (got && all) mic.audienceOn = true;
        for (const x of all ? K.sessions.all().filter((y) => y.screenTrack) : [sess]) {
          if (!got || x.closed || x.micTrack) continue;       // a second click waited on the same start and finds it attached
          if (K.tune.SPLIT_MIC) { await x.peerSeen; if (x.closed || x.micTrack) continue; }
          attachMic(x);
          if (x !== sess) K.sessions.sendState(x);
        }
      } finally { cast.adding--; capture.settle(); mic.settle(); }   // both: a share that ended while this call was in flight left its capture for it to stop
      K.sessions.sendState(sess);
    } else if (sess.screenTrack) {
      mic.audienceOn = !mic.audienceOn;
      for (const x of K.sessions.all()) if (x.screenTrack && x.micTrack) { x.micTrack.enabled = mic.audienceOn; K.sessions.sendState(x); }
      if (cast.members.size >= 2) toast(mic.audienceOn ? 'Microphone on for everyone you share with' : 'Microphone muted for everyone you share with');
    } else { sess.micTrack.enabled = !sess.micTrack.enabled; K.sessions.sendState(sess); }
    K.paint();
  }

  // A session closes: its leases go back, and a device nobody else holds stops. A viewer that went offline
  // while others still get my screen stays in the audience as away for a while, and is added again when
  // it is back (peerOnline). The paint is the caller's.
  function sessionClosed(sess, why) {
    capture.release(sess); mic.release(sess);
    sess.screenTrack = sess.micTrack = sess.screenSender = sess.micSender = null;
    const pub = sess.pub, m = cast.members.get(pub);
    if (m && why === 'offline' && m.state === 'live' && capture.state === 'live') { m.state = 'away'; m.timer = setTimeout(() => { if (cast.members.get(pub) === m) { drop(pub); K.paint(); renderContacts(); } }, K.REJOIN_MS); }
    else drop(pub);
    capture.settle(); mic.settle();   // the last viewer gone: the capture stops and takes whoever is away with it
    retier(); tell();
  }
  // A contact of the audience who was away is connected again: it gets my screen back, in the mode it had.
  // Not at once: an app that has just started is connected before its window can take a share frame, and
  // what a share sends first would be lost there (its viewer would stay empty). One that is gone again
  // by then stays away until its time is up.
  function peerOnline(pub) {
    const m = cast.members.get(pub);
    if (!m || m.state !== 'away' || m.back) return;
    m.back = setTimeout(() => {
      m.back = null;
      if (cast.members.get(pub) !== m || contact(pub)?.status !== 'online') return;
      drop(pub);
      if (capture.state === 'live') add(pub, m.mode).then(() => K.paint());
    }, K.BACK_MS);
  }

  // The user removes this contact from the contact list. It leaves the audience in whatever state it is
  // (watching, being added, away, about to be added again) and every session with it ends, also one
  // where I only watch: with the session go control, a request that is still open and the clipboard.
  // Without this the removal looks like a viewer that dropped out, and a contact that connects again
  // inside the minute would be given the screen again with no click.
  function forget(pub) {
    drop(pub);                                   // an add() that is in flight finds its entry gone and stops there
    const sess = K.sessions.get(pub);
    if (sess) K.sessions.end(sess);
    capture.settle(); mic.settle();
    retier(); tell();
    K.paint(); renderContacts();
  }

  // --- the audience, in words and as a list ---------------------------------------------------
  const byName = (a, b) => a.localeCompare(b);
  const listed = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '');
  // The line of the audience bar. `anon`: this window is part of the picture the viewers get, so it names nobody.
  function text(anon) {
    const here = [], away = [], rec = [];
    for (const [pub, m] of cast.members) {
      (m.state === 'away' ? away : here).push(K.nameOf(pub));
      const x = K.sessions.get(pub); if (x && x.screenTrack && x.remote.rec) rec.push(K.nameOf(pub));
    }
    const own = K.control.owner, driver = own && own.sess.ctl.give === 'on' ? K.nameOf(own.sess.pub) : '', n = (k) => `${k} contact${k === 1 ? '' : 's'}`;
    return 'Sharing your screen' + (here.length ? ` with ${anon ? n(here.length) : listed(here.sort(byName))}` : '')
      + (away.length ? ` (${anon ? away.length : listed(away.sort(byName))} reconnecting)` : '')
      + (driver ? (anon ? ' · controlled' : ` · ${driver} controls it`) : '')
      + (K.clip.link && K.clip.link.role === 'give' ? ' · clipboard shared' : '')
      + (rec.length ? (anon ? ' · recorded' : ` · ${listed(rec.sort(byName))} record${rec.length === 1 ? 's' : ''}`) : '');
  }
  // The picker's rows, by name. Ticked when it opens: the audience, or with none the open chat. `free`:
  // the box can be ticked at all (a contact who is offline cannot be added; one in the audience can stay).
  const rows = (contacts, open) => [...contacts].sort((a, b) => byName(a.name, b.name)).map((c) => {
    const m = cast.members.get(c.pub), online = c.status === 'online';
    return { pub: c.pub, name: c.name, free: !!m || online, ticked: m ? true : !cast.members.size && c.pub === open && online,
      state: m ? (m.state === 'live' ? 'watching' : m.state === 'joining' ? 'joining…' : 'reconnecting…') : online ? '' : 'offline' };
  });
  // a box that takes no tick: not free, or the audience is full with `n` ticked
  const locked = (free, ticked, n) => !ticked && (!free || n >= K.tune.MAX_AUDIENCE);

  Object.assign(cast, { add, attachMic, detach, remove, set, stop, talk, retier, tell, onTold, sessionClosed, peerOnline, forget, text, rows, locked });
})();
