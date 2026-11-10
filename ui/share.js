'use strict';
// Screen share with voice, between the two apps, over WebRTC.
//
// Signaling (SDP, ICE, a small state message, bye) rides the chat's end-to-end
// channel as `share` frames, so the DTLS fingerprints that key the media are
// authenticated by the same long-term keys as the messages. Media is DTLS-SRTP
// straight between the peers, or through the TURN server from Settings when the
// NATs will not let it through.
//
// One session at a time. Either side can add or drop its screen or its mic at
// any moment (one-way, two-way, talk-back) because the connection uses the
// "perfect negotiation" pattern: the side with the lower public key is polite
// and yields on an offer collision; the other keeps its offer.
//
// Remote control: the viewer can ask to drive the sharer's mouse and keyboard. The
// sharer answers a dialog and can stop it at any moment. Events ride two data channels
// on the same connection: "ctl" (reliable: requests, answers, buttons, keys, wheel) and
// "move" (unordered, no retransmits: pointer moves, where only the latest matters). The
// sharer's app hands them to the main process, which posts them to the OS (main/input.js).
// Only a whole display is ever shared, so coordinates are fractions of that display.
//
// Reads from app.js: S, $, toast, contact, ipcErr, renderContacts, show. Reads K.nameOf and the limits
// (share/kit.js) and K.tune (share/tune.js: every latency and quality value). Exposes window.Share and
// K.sessions, the registry of running sessions.
(() => {
  const K = window.ShareKit;
  const newSid = () => Math.random().toString(36).slice(2, 12);

  // --- sessions ---------------------------------------------------------------------
  // One session per contact, keyed by the contact's public key: that is all a released peer's bye
  // names, and two peers that start at the same moment keep a sid each.
  const map = new Map();
  const cur = () => map.get(S.current) || null;                                             // the session of the open chat
  const pick = (pub) => map.get(pub) || cur() || map.values().next().value || null;         // ... else the oldest
  const giving = (state) => [...map.values()].find((x) => x.ctl.give === state) || null;    // the session that asked for ('asked') or has ('on') control of my screen

  // Synchronous: the slot is taken in the task that decides to open it, so two frames, or a frame and
  // a click, never open two sessions with one contact. The peer connection needs the ICE servers from
  // main and follows behind `ready`; frames that arrive before it wait in the inbox.
  function open(pub, sid, inbound) {
    const had = map.get(pub);
    if (had) return had;
    if (map.size >= K.MAX_SESSIONS) return null;
    let markSeen;
    const sess = { pub, id: sid || newSid(), pc: null, polite: S.me.pub < pub, makingOffer: false, ignoreOffer: false, settingAnswer: false,
      local: new MediaStream(), screenTrack: null, micTrack: null, screenSender: null, micSender: null,
      remote: { stream: null, screen: false, mic: false, mode: 'one', rec: false }, mode: 'one', rec: null, recStarting: false, recWanted: !!S.settings.recordShares, askedBack: false, muted: false, stats: '', path: '', statsTimer: null, since: Date.now(),
      closed: false, ready: null, inbox: Promise.resolve(), peerSids: new Set(), seen: false, ver: 0, peerSeen: new Promise((r) => { markSeen = r; }), markSeen, everConnected: false, connectTimer: null,
      ctl: { give: 'off', take: false, asked: false, askTimer: null, dc: null, mv: null, chans: [], move: null, moveAt: 0, flush: null, sent: 0, recv: 0, cursor: null } };
    map.set(pub, sess);
    // the ICE config is read per session, so a Settings change applies to the next share
    sess.ready = window.api.iceConfig().then((cfg) => { if (!sess.closed) build(sess, cfg); }).catch((e) => { console.error('share session', e); close(sess, 'failed'); });
    if (inbound) armConnect(sess);
    return sess;
  }

  function build(sess, cfg) {
    const pc = sess.pc = new RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: cfg.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    pc.onnegotiationneeded = async () => {
      if (sess.closed) return;
      try { sess.makingOffer = true; await pc.setLocalDescription(); if (sess.closed) return; send(sess, { op: 'sdp', description: pc.localDescription.toJSON() }); armConnect(sess); }
      catch (e) { if (!sess.closed) console.error('negotiation', e); }
      finally { sess.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => send(sess, { op: 'ice', candidate: candidate ? candidate.toJSON() : null });
    pc.ontrack = (e) => {
      sess.remote.stream = e.streams[0] || sess.remote.stream || new MediaStream();
      if (!e.streams[0]) sess.remote.stream.addTrack(e.track);
      K.tune.receiver(e.receiver, e.track.kind);
      e.track.onmute = () => render(); e.track.onunmute = () => render(); e.track.onended = () => render();
      attachRemote(sess); render();
    };
    pc.ondatachannel = (e) => adoptChannel(sess, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { sess.everConnected = true; clearTimeout(sess.connectTimer); sess.connectTimer = null; }
      if (pc.connectionState === 'failed') { toast(`Screen share with ${K.nameOf(sess.pub)} failed. Check the call server in Settings.`, 'err'); close(sess, 'failed'); }
      else render();
    };
    sess.statsTimer = setInterval(() => pollStats(sess), 2000);
  }

  // Signaling never retries and a connection reports failure only once it has started, so a lost offer
  // would sit at "Connecting" for good. Armed by the first offer or the first frame, not by open():
  // the capture can take any time to start before there is an offer to send.
  function armConnect(sess) {
    if (sess.closed || sess.everConnected || sess.connectTimer) return;
    sess.connectTimer = setTimeout(() => {
      sess.connectTimer = null;
      if (sess.closed || sess.everConnected) return;
      toast(`Screen share with ${K.nameOf(sess.pub)} did not connect`, 'err');
      send(sess, { op: 'bye' }); close(sess, 'timeout');
    }, K.CONNECT_MS);
  }

  // Every frame says which share protocol this build speaks (v). A peer whose frames carry none is 0.7.1 or older.
  function send(sess, f) {
    if (sess.closed) return;
    window.api.share(sess.pub, { sid: sess.id, v: K.PROTO, ...f }).catch((e) => {
      if (sess.closed) return;
      toast(ipcErr(e), 'err'); if (/offline/.test(ipcErr(e))) close(sess, 'offline');
    });
  }

  function attachRemote(sess) {
    const v = $('viewerVideo');
    if (sess.remote.stream && v.srcObject !== sess.remote.stream) { v.srcObject = sess.remote.stream; v.muted = sess.muted; v.play().catch(() => {}); }
  }

  async function pollStats(sess) {
    if (!sess.pc || sess.pc.connectionState === 'closed') return;
    try {
      const st = await sess.pc.getStats();
      if (sess.closed) return;
      let inB = 0, outB = 0, fps = 0, w = 0, h = 0, path = '', rtt = -1, codec = '';
      const codecOf = (r) => { const c = r.codecId && st.get(r.codecId); return c && c.mimeType ? c.mimeType.replace(/^video\//i, '') : ''; };
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') { inB = r.bytesReceived || 0; fps = r.framesPerSecond || 0; w = r.frameWidth || 0; h = r.frameHeight || 0; codec = codecOf(r) || codec; }
        if (r.type === 'outbound-rtp' && r.kind === 'video') { outB = r.bytesSent || 0; codec = codec || codecOf(r); }
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) { const rc = st.get(r.remoteCandidateId), lc = st.get(r.localCandidateId); path = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay') ? 'via call server' : 'direct'; if (typeof r.currentRoundTripTime === 'number') rtt = Math.round(r.currentRoundTripTime * 1000); }
      });
      const now = Date.now(), dt = (now - (sess.lastT || now)) / 1000 || 1;
      const kbpsIn = sess.lastIn !== undefined ? Math.round((inB - sess.lastIn) * 8 / 1000 / dt) : 0, kbpsOut = sess.lastOut !== undefined ? Math.round((outB - sess.lastOut) * 8 / 1000 / dt) : 0;
      sess.lastIn = inB; sess.lastOut = outB; sess.lastT = now; sess.path = path; sess.rtt = rtt; sess.codec = codec;
      const q = K.tune.readout(sess, st), kb = (b) => (typeof b === 'number' ? `${Math.round(b / 1000)}k` : '-');
      sess.stats = (sess.remote.screen ? `${w}×${h} · ${fps} fps · ${(kbpsIn / 1000).toFixed(1)} Mb/s in` + (q.out ? ` · buf ${q.bufMs} (+${q.holdMs} sync) want ${q.wantMs} dec ${q.decMs} ms · shown +${q.shownMs} ms · nack ${q.nack} frz ${q.freeze}` : '') : '')
        + (sess.screenTrack ? `${sess.remote.screen ? ' · ' : ''}${(kbpsOut / 1000).toFixed(1)} Mb/s out` + (q.encN ? ` · enc ${Math.round(q.inFps || 0)}>${Math.round(q.encFps || 0)} fps ${q.encMs} ms skip ${q.skip}${q.limit && q.limit !== 'none' ? ' ' + q.limit : ''} ${q.hint}` : '') : '')
        + (codec ? ` · ${codec}` : '') + (rtt >= 0 ? ` · ${rtt} ms` : '') + (path ? ` · ${path}` : '');
      $('viewerStats').textContent = sess.stats;
      $('sharePill').title = sess.stats;
      if ((sess.polls = (sess.polls || 0) + 1) % 5 === 0) window.api.log(`${sess.id} ${sess.stats}`   // every 10 s, the last 2 s window, to the app log on both sides
        + (q.out ? ` | rx ${q.rx}>${q.out} drop ${q.drop} loss ${q.loss} proc ${q.procMs} e2e ${q.e2eMs}/${q.e2eWorst} voice ${q.voiceMs}+${q.voiceDevMs} (+${q.voiceHoldMs} sync) ${q.dec || '?'}` : '')
        + (q.encN ? ` | tx ${q.outW}x${q.outH} tgt ${kb(q.target)} bwe ${kb(q.avail)} pace ${q.paceMs} key ${q.keys} huge ${q.huge} ${q.impl || '?'} ${q.svc || '-'}` : '')
        + ` | ctl ${q.ctlOut}>${q.ctlIn} buf ${q.moveBuf}`).catch(() => {});
    } catch {}
  }

  // --- my side ---------------------------------------------------------------------
  async function start(pub, mode) {
    const c = contact(pub);
    if (!c) return;
    if (c.status !== 'online') { toast(`${c.name} is offline: a screen share needs them connected`, 'err'); return; }
    const busy = () => { const o = [...map.values()].find((x) => x.pub !== pub); if (o) toast(`End the share with ${contact(o.pub)?.name || 'the other contact'} first`, 'err'); return !!o; };
    if (busy()) return;
    const perm = await window.api.screenPermission();   // macOS: ask before trying, with instructions instead of a capture error
    if (perm !== 'ok') { window.showScreenPermission(perm); return; }
    if (busy()) return;                                     // someone else's share arrived while macOS was asked
    const sess = open(pub, null, false);                    // the session with this contact if there is one; never null right after busy()
    await sess.ready;
    if (sess.closed) return;
    sess.mode = mode || sess.mode;
    if (sess.screenTrack) return;
    let screen;
    try { screen = await navigator.mediaDevices.getDisplayMedia(K.tune.displayConstraints()); }
    catch (e) { toast(`Could not capture the screen: ${e.message}`, 'err'); if (!sess.remote.screen && !sess.remote.mic) close(sess, 'capture'); return; }
    const track = screen.getVideoTracks()[0];
    // The session ended while the capture was starting, or a second click got its capture in first:
    // a track the session does not hold is one nothing would ever stop.
    if (sess.closed || sess.screenTrack) { track.stop(); return; }
    track.contentHint = K.tune.hint(sess.ctl.give === 'on');
    await K.tune.capture(track);
    if (sess.closed || sess.screenTrack) { track.stop(); return; }
    track.onended = () => { if (!sess.closed && sess.screenTrack === track) stopSharing(sess); }; // the OS ended the capture
    sess.screenTrack = track; sess.local.addTrack(track);
    openChannels(sess);                                     // in the same task as addTrack: one negotiation covers both
    sess.screenSender = sess.pc.addTrack(track, K.tune.streamFor(sess, 'video'));
    K.tune.codecs(sess.pc, sess.screenSender);
    await K.tune.sender(sess);
    if (sess.closed) return;                                // close() stopped the track it found on the session
    await addMic(sess, true);
    if (sess.closed) return;
    sendState(sess); render(); renderContacts();
  }

  async function addMic(sess, quiet) {
    if (sess.micTrack) return true;
    const allowed = await window.api.micPermission();
    if (sess.closed) return false;
    if (!allowed) { if (!quiet) toast('Microphone access was not allowed; sharing without sound', 'err'); return false; }
    try {
      const mic = await navigator.mediaDevices.getUserMedia(K.tune.micConstraints());
      const t = mic.getAudioTracks()[0];
      if (sess.closed || sess.micTrack) { t.stop(); return !!sess.micTrack; }   // closed meanwhile, or an overlapping call attached its microphone first: this one would stay open for good
      sess.micTrack = t; sess.local.addTrack(t); sess.micSender = sess.pc.addTrack(t, K.tune.streamFor(sess, 'audio'));
      return true;
    } catch (e) { if (!quiet) toast(`Microphone: ${e.message}`, 'err'); return false; }
  }

  function dropTrack(sess, which) {
    const t = sess[which + 'Track'], snd = sess[which + 'Sender'];
    if (snd) { try { sess.pc.removeTrack(snd); } catch {} }
    if (t) { t.stop(); sess.local.removeTrack(t); }
    sess[which + 'Track'] = null; sess[which + 'Sender'] = null;
  }

  function stopSharing(sess) {
    if (sess.ctl.give !== 'off') giveUp(sess, 'stopped');
    dropTrack(sess, 'screen'); dropTrack(sess, 'mic');
    sendState(sess);
    if (!sess.remote.screen && !sess.remote.mic) close(sess, 'stopped'); else { render(); renderContacts(); }
  }

  async function toggleMic(sess) {
    if (sess.micTrack) { sess.micTrack.enabled = !sess.micTrack.enabled; }
    else { await sess.ready; if (!sess.closed) await addMic(sess, false); }
    if (sess.closed) return;
    sendState(sess); render();
  }

  const sendState = (sess) => send(sess, { op: 'state', screen: !!sess.screenTrack, mic: !!(sess.micTrack && sess.micTrack.enabled), mode: sess.mode, rec: !!sess.rec });

  // The one way a session ends, whoever ends it. It sends nothing: End, the limit reply and the connect
  // watchdog say bye themselves before they call it.
  function close(sess, why) {
    if (sess.closed) return;
    sess.closed = true;                 // first: everything that was waiting on this session checks it and stops
    if (map.get(sess.pub) === sess) map.delete(sess.pub);
    clearInterval(sess.statsTimer); clearTimeout(sess.connectTimer);
    sess.markSeen();
    // control, both roles
    if (sess.ctl.give === 'on') window.api.controlRevoke().catch(() => {});
    clearTimeout(sess.ctl.flush); clearTimeout(sess.ctl.askTimer);
    if (!$('mControl').classList.contains('hidden')) window.closeModal();
    $('viewerVideo').classList.remove('ctl'); $('viewerVideo').removeEventListener(K.tune.MOVE_EV, onMove);
    if (sess.rec) stopRecording(sess);                      // before their tracks end, so the last piece is whole
    dropTrack(sess, 'screen'); dropTrack(sess, 'mic');
    const v = $('viewerVideo'); v.srcObject = null;
    if (theater) setFull(false);
    if (sess.pc) { try { sess.pc.close(); } catch {} }
    const name = K.nameOf(sess.pub);
    if (why === 'bye') toast(`${name} ended the screen share`);
    if (why === 'offline') toast(`Screen share ended: ${name} went offline`, 'err');
    if (why === 'refused') toast(`${name} cannot take the screen share right now (they are in another one)`, 'err');
    render(); renderContacts();
  }
  function end(sess) { send(sess, { op: 'bye' }); close(sess, 'ended'); }

  // --- their side ---------------------------------------------------------------------
  // Routing is synchronous and in arrival order; the work behind it runs one frame at a time per session.
  function onFrame(ev) {
    let sess = map.get(ev.pub);
    if (ev.op === 'bye') {
      // only for this session: a late bye of an earlier one carries a sid this one has never seen
      if (sess && (ev.sid === sess.id || sess.peerSids.has(ev.sid))) close(sess, !sess.everConnected && !(sess.pc && sess.pc.remoteDescription) ? 'refused' : 'bye');
      return;
    }
    // a share starts with the offer, or with a `state` once the tracks exist; either opens the session here
    const opens = (ev.op === 'sdp' && ev.description.type === 'offer') || (ev.op === 'state' && (ev.screen || ev.mic));
    // A peer keeps one sid for a whole session. A sid it has not used in this one means its side is
    // gone (restart, reload, a close that never reached us) and this is a new session or a leftover.
    if (sess && sess.peerSids.size > 0 && ev.sid !== sess.id && !sess.peerSids.has(ev.sid)) {
      if (!opens) return;
      close(sess, 'replaced'); sess = null;
    }
    if (!sess) {
      if (!opens) return;               // stale ice/state after a bye
      sess = open(ev.pub, ev.sid, true);
      if (!sess) { window.api.share(ev.pub, { sid: ev.sid, op: 'bye', v: K.PROTO }).catch(() => {}); return; }   // at the limit: busy with someone else
    }
    sess.peerSids.add(ev.sid);
    if (!sess.seen) { sess.seen = true; sess.ver = Number.isInteger(ev.v) ? ev.v : 0; sess.markSeen(); }
    sess.inbox = sess.inbox.then(() => handle(sess, ev)).catch((e) => console.error('share frame', e));
  }
  async function handle(sess, ev) {
    await sess.ready;
    if (sess.closed) return;            // a frame that waited on a session that closed is dropped
    const pc = sess.pc;
    try {
      if (ev.op === 'sdp') {
        armConnect(sess);
        const d = ev.description;
        const readyForOffer = !sess.makingOffer && (pc.signalingState === 'stable' || sess.settingAnswer);
        const collision = d.type === 'offer' && !readyForOffer;
        sess.ignoreOffer = !sess.polite && collision;
        if (sess.ignoreOffer) return;
        sess.settingAnswer = d.type === 'answer';
        try { await pc.setRemoteDescription(d); } finally { sess.settingAnswer = false; }
        if (sess.closed) return;
        if (d.type === 'offer') { await pc.setLocalDescription(); if (sess.closed) return; send(sess, { op: 'sdp', description: pc.localDescription.toJSON() }); }
      } else if (ev.op === 'ice') {
        try { await pc.addIceCandidate(ev.candidate === null ? undefined : ev.candidate); } catch (e) { if (!sess.ignoreOffer && !sess.closed) console.warn('ice', e.message); }
      } else if (ev.op === 'state') onState(sess, ev);
    } catch (e) { if (!sess.closed) throw e; }   // a connection that closed under the call is not an error
  }
  function onState(sess, ev) {
    const was = sess.remote.screen, wasRec = sess.remote.rec;
    sess.remote.screen = ev.screen; sess.remote.mic = ev.mic; sess.remote.mode = ev.mode; sess.remote.rec = !!ev.rec;
    if (sess.remote.rec && !wasRec && sess.screenTrack) toast(`${contact(ev.pub)?.name || 'Your contact'} is recording your screen share`);
    if (ev.screen && !was) { attachRemote(sess); if (S.current !== ev.pub) toast(`${contact(ev.pub)?.name || 'A contact'} is sharing their screen: open that chat to watch`); }
    if (!ev.screen && (sess.ctl.take || sess.ctl.asked)) { stopTaking(sess); clearTimeout(sess.ctl.askTimer); sess.ctl.asked = false; }
    if (ev.mode === 'two' && ev.screen && !sess.screenTrack && !sess.askedBack) { sess.askedBack = true; $('shareBackName').textContent = contact(ev.pub)?.name || 'They'; show('mShareBack'); }
    if (!ev.screen && !ev.mic && !sess.screenTrack && !sess.micTrack) { close(sess, 'stopped'); return; }
    render(); renderContacts();
  }
  function onStatus(ev) { const sess = map.get(ev.pub); if (sess && ev.status !== 'online') close(sess, 'offline'); }

  // --- remote control ----------------------------------------------------------------
  function adoptChannel(sess, ch) {
    ch.onmessage = (e) => onCtl(sess, e.data);
    ch.onerror = (e) => console.warn('channel', ch.label, e.error ? e.error.message : e);
    if (ch.label === 'ctl' && !sess.ctl.dc) sess.ctl.dc = ch;
    if (ch.label === 'move' && !sess.ctl.mv) sess.ctl.mv = ch;
    sess.ctl.chans.push(ch);
  }
  function openChannels(sess) {   // the sharer opens them; the other side gets them through ondatachannel
    if (!sess.ctl.dc) adoptChannel(sess, sess.pc.createDataChannel('ctl'));
    if (!sess.ctl.mv) adoptChannel(sess, sess.pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 }));
  }
  function sendCtl(sess, msg, viaMove) {
    const ch = viaMove ? sess.ctl.mv : sess.ctl.dc;
    if (!ch || ch.readyState !== 'open') return false;
    if (viaMove && ch.bufferedAmount > K.tune.MOVE_BUF) return false;
    try { ch.send(JSON.stringify(msg)); sess.ctl.sent++; return true; } catch { return false; }
  }
  K.sessions = { map, get: (pub) => map.get(pub) || null, all: () => [...map.values()], open, close, end, send, sendState,
    dc: (sess, label, msg) => sendCtl(sess, msg, label === 'move'), adopt: adoptChannel, openChannels, onFrame, onStatus };
  function onCtl(sess, data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    sess.ctl.recv++;
    const name = K.nameOf(sess.pub);
    switch (m.t) {
      case 'cur':   // the shape of their pointer: drawn as my own while I control
        sess.ctl.cursor = cursorCss(m);
        if (sess.ctl.take) $('viewerVideo').style.cursor = sess.ctl.cursor;
        return;
      case 'req':   // they want my mouse and keyboard
        if (!sess.screenTrack) { sendCtl(sess, { t: 'ctl', on: false, why: 'notsharing' }); return; }
        if (sess.ctl.give === 'on') { sendCtl(sess, { t: 'ctl', on: true }); return; }
        if (sess.ctl.give === 'asked') return;
        sess.ctl.give = 'asked'; $('controlName').textContent = name; show('mControl'); render();
        return;
      case 'ctl': { // their answer about my control of their screen
        clearTimeout(sess.ctl.askTimer); sess.ctl.asked = false;
        if (m.on) {
          if (!sess.ctl.take) { startTaking(sess); toast(`You control ${name}'s screen: click the video, then your mouse and keyboard act there (Esc and shortcuts too). Click outside the video to type here again.`, 'ok'); }
        } else {
          const was = sess.ctl.take; stopTaking(sess);
          const why = m.why === 'accessibility' ? `${name}'s Mac has to allow P2P Chat under Accessibility first (they were shown where). Ask again once it is on.`
            : m.why === 'wayland' ? `${name}'s Linux session is Wayland: no remote control there`
            : m.why === 'helper' ? `${name}'s app could not start its input helper`
            : m.why === 'notsharing' ? '' : was ? `${name} stopped your control` : `${name} did not allow control`;
          if (why) toast(why, was ? '' : 'err');
        }
        render(); return;
      }
      case 'rel':   // they let go of my screen
        if (sess.ctl.give !== 'off') giveUp(sess, 'released');
        return;
      case 'm': case 'b': case 'w': case 'k': case 'r':
        if (sess.ctl.give === 'on' && sess.screenTrack) window.api.input(m);
        return;
    }
  }
  // sharer: the dialog's Allow
  // The shared picture carries no pointer, so a Mac sharer's helper reports the system cursor image
  // whenever it changes (main/input.js onCursor); it rides the reliable channel and becomes the
  // viewer's own pointer over the video. Other sharers leave the viewer a plain arrow.
  function cursorCss(m) {
    const n = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
    const w = n(m.w, 128), h = n(m.h, 128), pw = n(m.pw, 512), ph = n(m.ph, 512), hx = n(m.hx, 128), hy = n(m.hy, 128);
    if (!w || !h || pw === null || ph === null || hx === null || hy === null) return '';
    if (typeof m.png !== 'string' || m.png.length > 300000 || !/^[A-Za-z0-9+/]+=*$/.test(m.png)) return '';
    const url = `url("data:image/png;base64,${m.png}")`, k = Math.max(1, Math.round(pw / w));
    return `${k > 1 ? `-webkit-image-set(${url} ${k}x)` : url} ${Math.min(hx, w - 1)} ${Math.min(hy, h - 1)}, default`;
  }
  function onCursor(c) { const sess = giving('on'); if (sess && c && typeof c === 'object') sendCtl(sess, { t: 'cur', w: c.w, h: c.h, pw: c.pw, ph: c.ph, hx: c.hx, hy: c.hy, png: c.png }); }
  async function giveControl(sess) {
    if (sess.closed || !sess.screenTrack) { sess.ctl.give = 'off'; sendCtl(sess, { t: 'ctl', on: false, why: 'notsharing' }); render(); return; }
    let r; try { r = await window.api.controlGrant(); } catch (e) { r = { ok: false, reason: 'helper', message: ipcErr(e) }; }
    if (sess.closed) return;
    const name = K.nameOf(sess.pub);
    if (r && r.ok) {
      sess.ctl.give = 'on';
      try { if (sess.screenTrack) sess.screenTrack.contentHint = K.tune.hint(true); } catch {}
      sendCtl(sess, { t: 'ctl', on: true });
      toast(`${name} now uses your mouse and keyboard. ✋ Stop control next to the Sharing pill ends it.`);
    } else {
      sess.ctl.give = 'off';
      sendCtl(sess, { t: 'ctl', on: false, why: (r && r.reason) || 'helper' });
      toast((r && r.message) || 'Control could not be allowed', 'err');
    }
    render();
  }
  // sharer: control of my screen ends (Deny, ✋, they released it, the share stops, the helper died)
  function giveUp(sess, why) {
    const was = sess.ctl.give; sess.ctl.give = 'off';
    if (was === 'on') { window.api.controlRevoke().catch(() => {}); try { if (sess.screenTrack) sess.screenTrack.contentHint = K.tune.hint(false); } catch {} }
    if (why !== 'released' && was !== 'off') sendCtl(sess, { t: 'ctl', on: false, why: why === 'denied' ? undefined : why === 'stopped' ? 'stopped' : 'helper' });
    if (!$('mControl').classList.contains('hidden')) window.closeModal();
    if (was === 'on') toast(why === 'released' ? `${K.nameOf(sess.pub)} stopped controlling your screen` : why === 'stopped' ? 'Remote control stopped' : `Remote control stopped: ${why}`);
    render();
  }
  function onControl(ev) { const sess = giving('on'); if (sess && !ev.on) giveUp(sess, ev.why || 'the input helper stopped'); }
  // viewer: ask for their mouse and keyboard, or let go
  function askControl(sess) {
    if (!sess.remote.screen) return;
    if (sess.ctl.take) { stopTaking(sess); sendCtl(sess, { t: 'rel' }); toast('You no longer control their screen'); render(); return; }
    if (sess.ctl.asked) return;
    if (!sendCtl(sess, { t: 'req' })) { toast('Not connected yet: try again in a moment', 'err'); return; }
    sess.ctl.asked = true;
    sess.ctl.askTimer = setTimeout(() => { if (sess.ctl.asked) { sess.ctl.asked = false; if (!sess.closed) { toast(`${K.nameOf(sess.pub)} has not answered`); render(); } } }, K.tune.ASK_MS);
    render();
  }
  function startTaking(sess) {
    sess.ctl.take = true; sess.ctl.move = null; sess.ctl.moveAt = 0;
    clearTimeout(sess.ctl.flush); sess.ctl.flush = null;
    const v = $('viewerVideo'); v.classList.add('ctl'); v.style.cursor = sess.ctl.cursor || ''; v.focus();
    v.addEventListener(K.tune.MOVE_EV, onMove);
  }
  function stopTaking(sess) {
    clearTimeout(sess.ctl.flush); sess.ctl.flush = null; sess.ctl.move = null;
    if (sess.ctl.take) { sess.ctl.take = false; sendCtl(sess, { t: 'r' }); }
    const v = $('viewerVideo'); v.classList.remove('ctl'); v.style.cursor = ''; sess.ctl.cursor = null;
    v.removeEventListener(K.tune.MOVE_EV, onMove);
  }
  const taking = () => { const sess = pick(); return sess && sess.ctl.take && sess.remote.screen ? sess : null; };   // the session whose screen I drive right now, or null
  // where on their display the pointer is: fractions of the video picture (object-fit: contain leaves bars)
  function at(e) {
    const v = $('viewerVideo'), r = v.getBoundingClientRect();
    const vw = v.videoWidth || r.width || 1, vh = v.videoHeight || r.height || 1;
    const k = Math.min(r.width / vw, r.height / vh) || 1, cw = vw * k, ch = vh * k;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    const c = (x) => Math.min(1, Math.max(0, x));
    return { x: +c((e.clientX - ox) / cw).toFixed(4), y: +c((e.clientY - oy) / ch).toFixed(4) };
  }
  const onMove = (e) => { const sess = taking(); if (sess) K.tune.sendMove(sess, { t: 'm', ...at(e) }); };
  const keysGoRemote = () => ((document.activeElement === $('viewerVideo') || theater) && $('backdrop').classList.contains('hidden') ? taking() : null);

  // --- full screen ----------------------------------------------------------------------
  // The window itself goes full screen (main: simple fullscreen on macOS, setFullScreen
  // elsewhere) and the viewer covers the page. Esc, the button or a double-click leave.
  let theater = false;
  function applyTheater(on) {
    theater = !!on; document.body.classList.toggle('theater', theater);
    const b = $('viewerFull'); b.textContent = theater ? '⤡' : '⤢'; b.title = theater ? 'Leave full screen (Esc)' : 'Full screen (Esc leaves, unless you are controlling their screen)';
  }
  async function setFull(on) {
    on = on === undefined ? !theater : !!on;
    const sess = pick();
    if (on && !(sess && sess.remote.screen)) return;
    if (on === theater) return;
    let got = false; try { got = await window.api.fullscreen(on); } catch (e) { toast(ipcErr(e), 'err'); }
    applyTheater(!!got);
  }
  function onFullscreen(ev) { const sess = pick(); applyTheater(!!ev.on && !!(sess && sess.remote.screen)); }

  // --- recording what they send ----------------------------------------------------
  // MediaRecorder on a snapshot of the remote stream (their screen, their voice), 1 s pieces
  // handed to the main process, which appends them to a .webm in the Videos folder. Wanted
  // by the viewer's button for this share, or by the Settings switch for every share, the
  // running one included; the state frame carries `rec` so the sharer sees it.
  let lastRecording = null;
  const REC_MIME = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
  const fmtClock = (ms) => { const t = Math.floor(ms / 1000); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const recReady = (sess) => { const st = sess.remote.stream; return !!(sess.remote.screen && st && st.getVideoTracks().length && (!sess.remote.mic || st.getAudioTracks().length)); };
  async function startRecording(sess) {
    if (sess.rec || sess.recStarting || !recReady(sess)) return;
    if (!REC_MIME) { toast('Recording is not supported here', 'err'); sess.recWanted = false; return; }
    sess.recStarting = true;
    let id, file;
    try {
      ({ id, file } = await window.api.recordStart(sess.pub));
      if (sess.closed) { window.api.recordStop(id).catch(() => {}); return; }   // the share ended while the file was being created: main removes the empty file
      const stream = new MediaStream(sess.remote.stream.getTracks());   // a snapshot: tracks added later never disturb the recorder
      const recorder = new MediaRecorder(stream, { mimeType: REC_MIME, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 96_000 });
      const rec = { id, file, recorder, since: Date.now(), bytes: 0, q: Promise.resolve(), timer: null, failed: '' };
      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        rec.q = rec.q.then(async () => {   // pieces reach the file in order
          if (rec.failed) return;
          try { rec.bytes = await window.api.recordChunk(id, new Uint8Array(await e.data.arrayBuffer())); }
          catch (err) { rec.failed = ipcErr(err); if (recorder.state !== 'inactive') recorder.stop(); }
        });
      };
      recorder.onerror = (e) => { rec.failed = rec.failed || (e.error && e.error.message) || 'recorder error'; if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.onstop = () => finishRecording(sess, rec);
      recorder.start(1000);
      rec.timer = setInterval(() => { if (sess.rec === rec && !sess.closed && S.current === sess.pub) renderRec(sess); }, 1000);
      sess.rec = rec;
      sendState(sess); render();
    } catch (e) {
      if (id && !sess.rec) window.api.recordStop(id).catch(() => {});   // the file exists but nothing records into it: left open it would count toward main's two recordings for good
      toast(`Recording did not start: ${ipcErr(e)}`, 'err'); sess.recWanted = false;
    }
    finally { sess.recStarting = false; }
  }
  function stopRecording(sess) { const rec = sess.rec; if (!rec) return; if (rec.recorder.state !== 'inactive') rec.recorder.stop(); else finishRecording(sess, rec); }
  async function finishRecording(sess, rec) {
    if (sess.rec !== rec) return;
    sess.rec = null; clearInterval(rec.timer);
    if (rec.failed) sess.recWanted = false;   // no retry loop on a disk that is full
    await rec.q;
    let saved = null; try { saved = await window.api.recordStop(rec.id); } catch {}
    if (saved) lastRecording = saved.file;
    if (rec.failed) toast(`Recording stopped: ${rec.failed}${saved ? ` (${fmtBytes(saved.bytes)} kept)` : ''}`, 'err');
    else if (saved) toast(`Recording saved (${fmtBytes(saved.bytes)}): ${saved.file}`, 'ok');
    if (!sess.closed) { sendState(sess); render(); }
  }
  function syncRecording(sess) {
    if (sess.recWanted && !sess.rec) startRecording(sess);      // waits for the tracks if they are not there yet
    else if (sess.rec && (!sess.recWanted || !sess.remote.screen)) stopRecording(sess);
  }
  function renderRec(sess) {
    const b = $('viewerRec'), on = !!sess.rec; b.classList.toggle('on', on);
    b.textContent = on ? `● ${fmtClock(Date.now() - sess.rec.since)}${sess.rec.bytes ? ' · ' + fmtBytes(sess.rec.bytes) : ''}` : '● Record';
    b.title = on ? 'Stop recording (the file is kept)' : 'Record what you see and hear from them to a file';
  }
  function onSettings() { for (const sess of map.values()) { sess.recWanted = !!S.settings.recordShares; syncRecording(sess); if (S.current === sess.pub) renderRec(sess); } }

  // --- UI ---------------------------------------------------------------------
  function render() {
    const pub = S.current, sess = cur(), mine = !!sess, conn = mine && sess.pc ? sess.pc.connectionState : '';   // no pc yet: still connecting
    const sharing = !!(mine && sess.screenTrack), watching = !!(mine && sess.remote.screen);
    const btn = $('btnShare'); btn.textContent = sharing ? '■ Stop sharing' : '⇡ Share screen'; btn.classList.toggle('on', sharing);
    btn.title = sharing ? 'Stop sending your screen' : `Send your screen${S.settings.shareMode === 'two' ? ' and ask for theirs (two way)' : ''} to this contact, one click`;
    $('btnShareMode').classList.toggle('hidden', sharing);
    const micBtn = $('btnMic'); micBtn.classList.toggle('hidden', !mine); if (mine) { const on = !!(sess.micTrack && sess.micTrack.enabled); micBtn.textContent = on ? '🎙' : '🎙̸'; micBtn.classList.toggle('on', on); micBtn.title = on ? 'Mute your microphone' : sess.micTrack ? 'Unmute your microphone' : 'Talk: send your microphone'; }
    const pill = $('sharePill'); const state = !mine ? '' : conn === 'connected' || conn === 'completed' ? (sharing && watching ? 'Both screens' : sharing ? 'Sharing' : watching ? 'Watching' : 'Voice') + (sharing && sess.remote.rec ? ' · recorded' : '') + (sharing && sess.ctl.give === 'on' ? ' · controlled' : '') : conn === 'failed' ? 'Failed' : 'Connecting…';
    pill.classList.toggle('hidden', !state); pill.textContent = state; pill.className = 'share-pill ' + (sharing ? 'sharing' : watching ? 'watching' : 'idle');
    $('btnStopCtl').classList.toggle('hidden', !(sharing && sess.ctl.give === 'on'));
    const viewer = $('viewer'); viewer.classList.toggle('hidden', !watching);
    if (watching) {
      $('viewerName').textContent = `${contact(pub)?.name || ''}'s screen`; $('viewerShareBack').classList.toggle('hidden', sharing); $('viewerTalk').textContent = sess.micTrack && sess.micTrack.enabled ? '🎙 Talking' : '🎙 Talk'; $('viewerMute').textContent = sess.muted ? '🔇' : '🔊'; attachRemote(sess);
      const cb = $('viewerCtl'); cb.textContent = sess.ctl.take ? '🖱 Controlling' : sess.ctl.asked ? '🖱 Asking…' : '🖱 Control'; cb.classList.toggle('on', sess.ctl.take);
      cb.title = sess.ctl.take ? 'Stop controlling their screen' : sess.ctl.asked ? 'Waiting for their answer' : 'Ask to use their mouse and keyboard';
    }
    document.getElementById('chat').classList.toggle('with-viewer', watching);
    if (mine) renderRec(sess);
    if (theater && !watching) setFull(false);
    for (const x of map.values()) syncRecording(x);
  }
  const sessionPub = () => { const sess = pick(); return sess ? sess.pub : null; };

  $('btnShare').onclick = () => { if (!S.current) return; const sess = cur(); if (sess && sess.screenTrack) stopSharing(sess); else start(S.current, S.settings.shareMode === 'two' ? 'two' : 'one'); };
  $('btnShareMode').onclick = (e) => { e.stopPropagation(); const m = $('shareMenu'); m.classList.toggle('hidden'); m.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (S.settings.shareMode || 'one'))); };
  $('shareMenu').querySelectorAll('button').forEach((b) => (b.onclick = async () => { $('shareMenu').classList.add('hidden'); S.settings.shareMode = await window.api.setPref('shareMode', b.dataset.mode); render(); toast(b.dataset.mode === 'two' ? 'Two way: your contact will be asked to share their screen too' : 'One way: only your screen is sent', 'ok'); }));
  document.addEventListener('click', () => $('shareMenu').classList.add('hidden'));
  $('btnMic').onclick = () => { const sess = cur(); if (sess) toggleMic(sess); };
  $('viewerTalk').onclick = () => { const sess = cur(); if (sess) toggleMic(sess); };
  $('viewerMute').onclick = () => { const sess = cur(); if (!sess) return; sess.muted = !sess.muted; $('viewerVideo').muted = sess.muted; render(); };
  $('viewerShareBack').onclick = () => { const sess = cur(); if (sess) start(sess.pub, 'two'); };
  $('viewerFull').onclick = () => setFull();
  $('viewerVideo').ondblclick = () => { if (!taking()) setFull(); };   // while controlling, two clicks are theirs
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && theater && !keysGoRemote()) { e.stopPropagation(); setFull(false); } }, true);
  $('viewerRec').onclick = () => { const sess = cur(); if (!sess) return; sess.recWanted = !sess.rec; syncRecording(sess); renderRec(sess); };
  $('viewerEnd').onclick = () => { const sess = cur(); if (sess) end(sess); };
  $('shareBackYes').onclick = () => { window.closeModal(); const sess = pick(); if (sess) start(sess.pub, 'two'); };
  $('shareBackNo').onclick = () => window.closeModal();
  // remote control: the viewer's input on the video goes to their machine while it is on
  $('viewerCtl').onclick = () => { const sess = cur(); if (sess) askControl(sess); };
  $('btnStopCtl').onclick = () => { const sess = giving('on'); if (sess) giveUp(sess, 'stopped'); };
  // the dialog belongs to the session that asked, whichever chat is open
  $('controlYes').onclick = () => { window.closeModal(); const sess = giving('asked'); if (sess) giveControl(sess); };
  $('controlNo').onclick = () => { window.closeModal(); const sess = giving('asked'); if (sess) giveUp(sess, 'denied'); };
  {
    const v = $('viewerVideo');
    const tick = (_t, md) => {   // per shown frame: last packet in -> on screen, and the sharer's capture stamp -> on screen
      const sess = pick();
      if (sess && typeof md.receiveTime === 'number') {
        const f = sess.pic || (sess.pic = { n: 0, show: 0, c: 0, e2e: 0, worst: 0 });
        f.n++; f.show += md.expectedDisplayTime - md.receiveTime;
        if (typeof md.captureTime === 'number') { const e = md.expectedDisplayTime - md.captureTime; f.c++; f.e2e += e; if (e > f.worst) f.worst = e; }
      }
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
    v.addEventListener('pointerdown', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); v.focus(); try { v.setPointerCapture(e.pointerId); } catch {} const p = at(e); sess.ctl.move = null; sendCtl(sess, { t: 'm', ...p }); sendCtl(sess, { t: 'b', b: e.button, d: 1, ...p }); });
    v.addEventListener('pointerup', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); sendCtl(sess, { t: 'b', b: e.button, d: 0, ...at(e) }); });
    v.addEventListener('wheel', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; sendCtl(sess, { t: 'w', dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...at(e) }); }, { passive: false });
    v.addEventListener('contextmenu', (e) => { if (taking()) e.preventDefault(); });
    const onKey = (e) => { const sess = keysGoRemote(); if (!sess) return; e.preventDefault(); e.stopPropagation(); if (e.repeat) return; sendCtl(sess, { t: 'k', c: e.code, d: e.type === 'keydown' ? 1 : 0 }); };
    document.addEventListener('keydown', onKey, true); document.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', () => { const sess = taking(); if (sess) sendCtl(sess, { t: 'r' }); });   // nothing stays pressed over there when this window loses the keyboard
  }

  // debug surface for the UI test (test/ui/share.sh): session internals and audio RTP counters
  const debug = (pub) => { const x = pick(pub); return x ? { sid: x.id, ver: x.ver, mode: x.mode, rec: !!x.rec, recFile: x.rec ? x.rec.file : null, recBytes: x.rec ? x.rec.bytes : 0, remoteRec: x.remote.rec, theater, askedBack: x.askedBack, polite: x.polite, signaling: x.pc ? x.pc.signalingState : null, conn: x.pc ? x.pc.connectionState : null, remote: { screen: x.remote.screen, mic: x.remote.mic, mode: x.remote.mode }, local: { screen: !!x.screenTrack, mic: !!(x.micTrack && x.micTrack.enabled) }, path: x.path, rtt: x.rtt, codec: x.codec, q: x.q || null,
    enc: x.screenSender ? x.screenSender.getParameters().encodings[0] || null : null,
    ctl: { give: x.ctl.give, take: x.ctl.take, asked: x.ctl.asked, sent: x.ctl.sent, recv: x.ctl.recv, chans: x.ctl.chans.map((c) => `${c.label}:${c.readyState}`) } } : null; };
  const debugAll = () => ({ sessions: Object.fromEntries([...map.values()].map((x) => [x.pub.slice(0, 8), debug(x.pub)])) });
  async function audio() {
    const sess = pick();
    if (!sess || !sess.pc) return null;
    const out = { in: null, out: null };
    (await sess.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.in = { packets: r.packetsReceived, energy: r.totalAudioEnergy, level: r.audioLevel };
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.out = { packets: r.packetsSent, bytes: r.bytesSent };
    });
    return out;
  }
  window.Share = { onFrame, onStatus, onSettings, onFullscreen, onControl, onCursor, render, end: () => { const sess = cur(); if (sess) end(sess); }, setFull, sessionPub, active: () => map.size > 0, lastRecording: () => lastRecording, debug, debugAll, audio,
    inject: (m) => { const sess = taking(); return sess ? sendCtl(sess, m, m && m.t === 'm') : false; } };   // test hook: send one control message as the viewer's input would
})();
