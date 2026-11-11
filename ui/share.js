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
// This file is the last share script and holds what is left: the paint of the header and the viewer
// bar, the buttons, the debug surface and window.Share. The sessions are in share/session.js, my
// outgoing screen and microphone in share/cast.js, remote control in share/control.js, recording in
// share/record.js, the video, full screen, the pointer and key listeners and the prompts in
// share/viewer.js; share/kit.js has the namespace (K) and share/tune.js every latency and quality value.
//
// Reads from app.js: S, $, toast, contact.
(() => {
  const K = window.ShareKit;
  const map = K.sessions.map;
  const cur = () => map.get(S.current) || null;                                             // the session of the open chat
  const pick = (pub) => map.get(pub) || cur() || map.values().next().value || null;         // ... else the oldest

  function onSettings() { for (const sess of map.values()) { sess.recWanted = !!S.settings.recordShares; K.rec.sync(sess); if (S.current === sess.pub) K.rec.paint(sess); } }

  // --- UI ---------------------------------------------------------------------
  // Only draws. What a share needs done is done where it happens (a recording in share/record.js, the
  // stats line in K.paintStats); the first line is the one exception: it points the video at the open
  // chat's share and leaves full screen when that share is gone.
  function render() {
    K.viewer.rebind();
    const pub = S.current, sess = cur(), mine = !!sess, conn = mine && sess.pc ? sess.pc.connectionState : '';   // no pc yet: still connecting
    const sharing = !!(mine && sess.screenTrack), watching = !!(mine && sess.remote.screen);
    const btn = $('btnShare'); btn.textContent = sharing ? '■ Stop sharing' : '⇡ Share screen'; btn.classList.toggle('on', sharing);
    btn.title = sharing ? 'Stop sending your screen' : `Send your screen${S.settings.shareMode === 'two' ? ' and ask for theirs (two way)' : ''} to this contact, one click`;
    $('btnShareMode').classList.toggle('hidden', sharing);
    const micBtn = $('btnMic'); micBtn.classList.toggle('hidden', !mine); if (mine) { const on = !!(sess.micTrack && sess.micTrack.enabled); micBtn.textContent = on ? '🎙' : '🎙̸'; micBtn.classList.toggle('on', on); micBtn.title = on ? 'Mute your microphone' : sess.micTrack ? 'Unmute your microphone' : 'Talk: send your microphone'; }
    const pill = $('sharePill'); const state = !mine ? '' : conn === 'connected' || conn === 'completed' ? (sharing && watching ? 'Both screens' : sharing ? 'Sharing' : watching ? 'Watching' : 'Voice') + (sharing && sess.remote.rec ? ' · recorded' : '') + (sharing && sess.ctl.give === 'on' ? ' · controlled' : '') : conn === 'failed' ? 'Failed' : 'Connecting…';
    pill.classList.toggle('hidden', !state); pill.textContent = state; pill.className = 'share-pill ' + (sharing ? 'sharing' : watching ? 'watching' : 'idle');
    // whoever drives my screen can be stopped from every chat; elsewhere than in their own the button says who it is
    const own = K.control.owner, driven = !!own && own.sess.ctl.give === 'on', stop = $('btnStopCtl');
    stop.classList.toggle('hidden', !driven); stop.textContent = driven && own.sess.pub !== pub ? `✋ Stop control (${K.nameOf(own.sess.pub)})` : '✋ Stop control';
    const viewer = $('viewer'); viewer.classList.toggle('hidden', !watching);
    if (watching) {
      $('viewerName').textContent = `${contact(pub)?.name || ''}'s screen`; $('viewerShareBack').classList.toggle('hidden', sharing); $('viewerTalk').textContent = sess.micTrack && sess.micTrack.enabled ? '🎙 Talking' : '🎙 Talk'; $('viewerMute').textContent = sess.muted ? '🔇' : '🔊';
      const cb = $('viewerCtl'); cb.textContent = sess.ctl.take ? '🖱 Controlling' : sess.ctl.asked ? '🖱 Asking…' : '🖱 Control'; cb.classList.toggle('on', sess.ctl.take);
      cb.title = sess.ctl.take ? 'Stop controlling their screen' : sess.ctl.asked ? 'Waiting for their answer' : 'Ask to use their mouse and keyboard';
    }
    document.getElementById('chat').classList.toggle('with-viewer', watching);
    if (mine) { K.rec.paint(sess); K.paintStats(sess); }   // the stats line too: the poll writes it only every 2 s, and not while this chat was closed
  }
  const sessionPub = () => { const sess = pick(); return sess ? sess.pub : null; };
  K.paint = render;
  K.paintStats = (sess) => { if (K.viewer.bound === sess) $('viewerStats').textContent = sess.stats; if (S.current === sess.pub) $('sharePill').title = sess.stats; };   // a session's stats line goes only where that session is on screen

  $('btnShare').onclick = () => { if (!S.current) return; const sess = cur(); if (sess && sess.screenTrack) K.cast.remove(S.current); else K.cast.add(S.current, S.settings.shareMode === 'two' ? 'two' : 'one'); };
  $('btnShareMode').onclick = (e) => { e.stopPropagation(); const m = $('shareMenu'); m.classList.toggle('hidden'); m.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (S.settings.shareMode || 'one'))); };
  $('shareMenu').querySelectorAll('button').forEach((b) => (b.onclick = async () => { $('shareMenu').classList.add('hidden'); S.settings.shareMode = await window.api.setPref('shareMode', b.dataset.mode); render(); toast(b.dataset.mode === 'two' ? 'Two way: your contact will be asked to share their screen too' : 'One way: only your screen is sent', 'ok'); }));
  document.addEventListener('click', () => $('shareMenu').classList.add('hidden'));
  $('btnMic').onclick = () => { const sess = cur(); if (sess) K.cast.talk(sess); };
  $('viewerTalk').onclick = () => { const sess = cur(); if (sess) K.cast.talk(sess); };
  $('viewerMute').onclick = () => { const sess = K.viewer.bound; if (!sess) return; sess.muted = !sess.muted; if (sess.remote.audioEl) sess.remote.audioEl.muted = sess.muted; render(); };
  $('viewerShareBack').onclick = () => { const sess = K.viewer.bound; if (sess) K.cast.add(sess.pub, 'two'); };
  $('viewerRec').onclick = () => { const sess = K.viewer.bound; if (sess) K.rec.toggle(sess); };
  $('viewerEnd').onclick = () => { const sess = K.viewer.bound; if (sess) K.sessions.end(sess); };
  // the prompt belongs to the session that asked: Yes shares with that contact or with nobody
  $('shareBackYes').onclick = () => { K.unprompt('mShareBack'); const sess = K.viewer.backFor; K.viewer.backFor = null; if (sess && !sess.closed) K.cast.add(sess.pub, 'two'); };
  $('shareBackNo').onclick = () => K.unprompt('mShareBack');
  // remote control: the viewer's input on the video goes to their machine while it is on
  $('viewerCtl').onclick = () => { const sess = K.viewer.bound; if (sess) K.control.ask(sess); };
  $('btnStopCtl').onclick = () => { const own = K.control.owner; if (own) K.control.endGive(own.sess, 'stopped'); };
  // the dialog belongs to the session that asked (K.control.pending), whichever chat is open
  $('controlYes').onclick = () => K.control.allow();
  $('controlNo').onclick = () => K.control.deny('denied');

  // debug surface for the UI test (test/ui/share.sh): session internals and audio RTP counters
  const debug = (pub) => { const x = pick(pub); return x ? { sid: x.id, ver: x.ver, mode: x.mode, rec: !!x.rec, recFile: x.rec ? x.rec.file : null, recBytes: x.rec ? x.rec.bytes : 0, remoteRec: x.remote.rec, theater: K.viewer.theater, askedBack: x.askedBack, polite: x.polite, signaling: x.pc ? x.pc.signalingState : null, conn: x.pc ? x.pc.connectionState : null, remote: { screen: x.remote.screen, mic: x.remote.mic, mode: x.remote.mode }, in: { video: !!x.remote.video, audio: !!x.remote.audio }, local: { screen: !!x.screenTrack, mic: !!(x.micTrack && x.micTrack.enabled) }, path: x.path, rtt: x.rtt, codec: x.codec, q: x.q || null,
    enc: x.screenSender ? x.screenSender.getParameters().encodings[0] || null : null,
    ctl: { give: x.ctl.give, take: x.ctl.take, asked: x.ctl.asked, sent: x.ctl.sent, recv: x.ctl.recv, chans: x.ctl.chans.map((c) => `${c.label}:${c.readyState}`) } } : null; };
  const debugAll = () => ({ sessions: Object.fromEntries([...map.values()].map((x) => [x.pub.slice(0, 8), debug(x.pub)])),
    capture: { state: K.capture.state, leases: K.capture.leases.size }, mic: { state: K.mic.state, leases: K.mic.leases.size, audienceOn: K.mic.audienceOn },
    cast: { members: Object.fromEntries([...K.cast.members].map(([pub, m]) => [pub.slice(0, 8), m.state])) },
    control: { owner: K.control.owner ? K.control.owner.sess.pub.slice(0, 8) : null, pending: K.control.pending ? K.control.pending.sess.pub.slice(0, 8) : null, taking: K.control.taking ? K.control.taking.pub.slice(0, 8) : null } });
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
  window.Share = { onFrame: (ev) => K.sessions.onFrame(ev), onStatus: (ev) => K.sessions.onStatus(ev), onSettings, onFullscreen: (ev) => K.viewer.onFullscreen(ev), onControl: (ev) => K.control.onHelper(ev), onCursor: (c) => K.control.onCursor(c), render, end: () => { const sess = cur(); if (sess) K.sessions.end(sess); }, setFull: (on) => K.viewer.setFull(on), sessionPub, active: () => map.size > 0, lastRecording: () => K.rec.last, debug, debugAll, audio,
    inject: (m) => (K.control.isTaking() ? K.sessions.dc(K.viewer.bound, m && m.t === 'm' ? 'move' : 'ctl', m) : false) };   // test hook: send one control message as the viewer's input would
})();
