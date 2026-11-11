'use strict';
// Screen share: the sessions. The registry (one session per contact), each session's peer connection,
// the signaling that rides the chat's `share` frames, the data channels, the stats poll, and the one
// function that ends a session. What a peer sends is kept by track kind (remote.video, remote.audio):
// which MediaStream a track came on is never read, so their screen and their voice may come on one
// stream or on two.
//
// Reads from app.js: S, toast, contact, ipcErr, renderContacts. Reads at call time: K.tune, K.paint,
// K.paintStats, K.viewer, K.rec, K.cast, and K.control (in ui/share.js until it has a file of its own).
(() => {
  const K = window.ShareKit;
  const newSid = () => Math.random().toString(36).slice(2, 12);

  // --- sessions ---------------------------------------------------------------------
  // One session per contact, keyed by the contact's public key: that is all a released peer's bye
  // names, and two peers that start at the same moment keep a sid each.
  const map = new Map();

  // A frame can still be on its way when its session ends here: the sharer's `state` while the viewer
  // presses End, an answer while Stop and Share are clicked in a row. Taken for a new one it opens a
  // session nobody is behind ("Connecting" for 30 s, then "did not connect"), or lands in the session
  // opened next. So the sids of a session that closed here are kept per contact for as long as the
  // connect watchdog would wait, and a frame that carries one of them is dropped. A registry build
  // never uses a sid again, so any frame with `v` and a kept sid is a leftover. A released peer (no
  // `v`) answers by contact, not by sid: if its side outlived a close it was not told about, it goes
  // on under the old sid, also toward a session opened next. Its frames are dropped only after a
  // close that a bye went with, either way: then its side is gone as well.
  const gone = new Map();   // pub -> Map(sid -> { until, bye })
  function remember(sess, why) {
    const now = Date.now(), kept = gone.get(sess.pub) || new Map(), bye = ['ended', 'timeout', 'bye', 'refused'].includes(why);
    for (const [sid, g] of kept) if (g.until <= now) kept.delete(sid);
    for (const sid of [sess.id, ...sess.peerSids]) kept.set(sid, { until: now + K.CONNECT_MS, bye });
    gone.set(sess.pub, kept);
  }
  function leftover(ev) {
    const kept = gone.get(ev.pub), g = kept && kept.get(ev.sid);
    if (!g) return false;
    if (g.until <= Date.now()) { kept.delete(ev.sid); if (!kept.size) gone.delete(ev.pub); return false; }
    return g.bye || Number.isInteger(ev.v);
  }

  // Synchronous: the slot is taken in the task that decides to open it, so two frames, or a frame and
  // a click, never open two sessions with one contact. The peer connection needs the ICE servers from
  // main and follows behind `ready`; frames that arrive before it wait in the inbox.
  function open(pub, sid, inbound) {
    const had = map.get(pub);
    if (had) return had;
    if (map.size >= K.MAX_SESSIONS) return null;
    let markSeen;
    const sess = { pub, id: sid || newSid(), pc: null, polite: S.me.pub < pub, makingOffer: false, ignoreOffer: false, settingAnswer: false,
      local: new MediaStream(), screenTrack: null, micTrack: null, screenSender: null, micSender: null, micStream: null,
      remote: { video: null, audio: null, view: null, audioEl: null, screen: false, mic: false, mode: 'one', rec: false }, mode: 'one', rec: null, recStarting: false, recWanted: !!S.settings.recordShares, askedBack: false, muted: false, stats: '', path: '', statsTimer: null, since: Date.now(),
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
      const t = e.track, r = sess.remote;
      if (t.kind === 'video') { if (r.video !== t) { r.video = t; r.view = new MediaStream([t]); } K.tune.receiver(e.receiver, 'video'); }   // view: what the video element plays, the picture alone
      else { r.audio = t; K.tune.receiver(e.receiver, 'audio'); K.viewer.audioFor(sess); }
      t.onmute = () => K.paint(); t.onunmute = () => K.paint(); t.onended = () => K.paint();
      K.rec.sync(sess); K.paint();
    };
    pc.ondatachannel = (e) => adoptChannel(sess, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { sess.everConnected = true; clearTimeout(sess.connectTimer); sess.connectTimer = null; }
      if (pc.connectionState === 'failed') { toast(`Screen share with ${K.nameOf(sess.pub)} failed. Check the call server in Settings.`, 'err'); close(sess, 'failed'); }
      else K.paint();
    };
    sess.statsTimer = setInterval(() => pollStats(sess), 2000);
  }

  // A track the peer took off the connection stays on its transceiver for good, muted. The stream it came
  // on dropped it by itself; that stream is not read any more, so the track is forgotten here. Kept, it
  // would be recorded or shown in place of a track of their next share that has not arrived yet when the
  // `state` frame announces it. Run with an answer in place: the directions are then the agreed ones.
  function dropGone(sess) {
    const r = sess.remote, live = (t) => sess.pc.getTransceivers().some((tr) => tr.receiver.track === t && (tr.currentDirection === 'sendrecv' || tr.currentDirection === 'recvonly'));
    if (r.video && !live(r.video)) { r.video = null; r.view = null; }
    if (r.audio && !live(r.audio)) r.audio = null;
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
      K.paintStats(sess);
      if ((sess.polls = (sess.polls || 0) + 1) % 5 === 0) window.api.log(`${sess.id} ${sess.stats}`   // every 10 s, the last 2 s window, to the app log on both sides
        + (q.out ? ` | rx ${q.rx}>${q.out} drop ${q.drop} loss ${q.loss} proc ${q.procMs} e2e ${q.e2eMs}/${q.e2eWorst} voice ${q.voiceMs}+${q.voiceDevMs} (+${q.voiceHoldMs} sync) ${q.dec || '?'}` : '')
        + (q.encN ? ` | tx ${q.outW}x${q.outH} tgt ${kb(q.target)} bwe ${kb(q.avail)} pace ${q.paceMs} key ${q.keys} huge ${q.huge} ${q.impl || '?'} ${q.svc || '-'}` : '')
        + ` | ctl ${q.ctlOut}>${q.ctlIn} buf ${q.moveBuf}`).catch(() => {});
    } catch {}
  }

  const sendState = (sess) => send(sess, { op: 'state', screen: !!sess.screenTrack, mic: !!(sess.micTrack && sess.micTrack.enabled), mode: sess.mode, rec: !!sess.rec });

  // The one way a session ends, whoever ends it. It sends nothing: End, the limit reply and the connect
  // watchdog say bye themselves before they call it.
  function close(sess, why) {
    if (sess.closed) return;
    sess.closed = true;                 // first: everything that was waiting on this session checks it and stops
    if (map.get(sess.pub) === sess) map.delete(sess.pub);
    remember(sess, why);
    clearInterval(sess.statsTimer); clearTimeout(sess.connectTimer);
    sess.markSeen();
    // every part of the share code lets go of the session, in this order
    K.control.sessionClosed(sess);
    K.rec.stop(sess);                   // before their tracks end, so the last piece is whole
    K.cast.sessionClosed(sess, why);
    K.viewer.sessionClosed(sess);
    if (sess.pc) { try { sess.pc.close(); } catch {} }
    const name = K.nameOf(sess.pub);
    if (why === 'bye') toast(`${name} ended the screen share`);
    if (why === 'offline') toast(`Screen share ended: ${name} went offline`, 'err');
    if (why === 'refused') toast(`${name} cannot take the screen share right now (they are in another one)`, 'err');
    K.paint(); renderContacts();
  }
  function end(sess) { send(sess, { op: 'bye' }); close(sess, 'ended'); }

  // --- their side ---------------------------------------------------------------------
  // Routing is synchronous and in arrival order; the work behind it runs one frame at a time per session.
  function onFrame(ev) {
    if (leftover(ev)) return;
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
        dropGone(sess);
      } else if (ev.op === 'ice') {
        try { await pc.addIceCandidate(ev.candidate === null ? undefined : ev.candidate); } catch (e) { if (!sess.ignoreOffer && !sess.closed) console.warn('ice', e.message); }
      } else if (ev.op === 'state') onState(sess, ev);
    } catch (e) { if (!sess.closed) throw e; }   // a connection that closed under the call is not an error
  }
  function onState(sess, ev) {
    const was = sess.remote.screen, wasRec = sess.remote.rec;
    sess.remote.screen = ev.screen; sess.remote.mic = ev.mic; sess.remote.mode = ev.mode; sess.remote.rec = !!ev.rec;
    if (sess.remote.rec && !wasRec && sess.screenTrack) toast(`${contact(ev.pub)?.name || 'Your contact'} is recording your screen share`);
    if (ev.screen && !was && S.current !== ev.pub) toast(`${contact(ev.pub)?.name || 'A contact'} is sharing their screen: open that chat to watch`);
    if (!ev.screen && (sess.ctl.take || sess.ctl.asked)) { K.control.stopTaking(sess); clearTimeout(sess.ctl.askTimer); sess.ctl.asked = false; }
    if (ev.mode === 'two' && ev.screen && !sess.screenTrack && !sess.askedBack) { sess.askedBack = true; K.viewer.askBack(sess); }
    if (!ev.screen && !ev.mic && !sess.screenTrack && !sess.micTrack) { close(sess, 'stopped'); return; }
    K.rec.sync(sess); K.paint(); renderContacts();
  }
  function onStatus(ev) { const sess = map.get(ev.pub); if (sess && ev.status !== 'online') close(sess, 'offline'); }

  // --- data channels ----------------------------------------------------------------
  function adoptChannel(sess, ch) {
    ch.onmessage = (e) => K.control.onData(sess, e.data);
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
})();
