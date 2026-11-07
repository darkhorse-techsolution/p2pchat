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
// Reads from app.js: S, $, toast, contact, ipcErr, renderContacts. Exposes window.Share.
(() => {
  let s = null;                       // the active session, or null
  const newSid = () => Math.random().toString(36).slice(2, 12);
  const MAX_W = 1920, MAX_H = 1200, FPS = 15, VIDEO_KBPS = 2500;

  const ice = () => window.api.iceConfig(); // read per session, so a Settings change applies to the next share
  const send = (sess, f) => window.api.share(sess.pub, { sid: sess.id, ...f }).catch((e) => { toast(ipcErr(e), 'err'); if (/offline/.test(ipcErr(e))) close('offline'); });

  async function create(pub, id) {
    const cfg = await ice();
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: cfg.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    const sess = { pub, id: id || newSid(), pc, polite: S.me.pub < pub, makingOffer: false, ignoreOffer: false, settingAnswer: false,
      local: new MediaStream(), screenTrack: null, micTrack: null, screenSender: null, micSender: null,
      remote: { stream: null, screen: false, mic: false, mode: 'one' }, mode: 'one', askedBack: false, muted: false, stats: '', path: '', statsTimer: null, since: Date.now() };
    pc.onnegotiationneeded = async () => {
      try { sess.makingOffer = true; await pc.setLocalDescription(); send(sess, { op: 'sdp', description: pc.localDescription.toJSON() }); }
      catch (e) { console.error('negotiation', e); }
      finally { sess.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => send(sess, { op: 'ice', candidate: candidate ? candidate.toJSON() : null });
    pc.ontrack = (e) => {
      sess.remote.stream = e.streams[0] || sess.remote.stream || new MediaStream();
      if (!e.streams[0]) sess.remote.stream.addTrack(e.track);
      e.track.onmute = () => render(); e.track.onunmute = () => render(); e.track.onended = () => render();
      attachRemote(); render();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { toast('Screen share connection failed. Check the call server in Settings.', 'err'); close('failed'); }
      else render();
    };
    sess.statsTimer = setInterval(() => pollStats(sess), 2000);
    s = sess;
    return sess;
  }

  function attachRemote() {
    const v = $('viewerVideo');
    if (s && s.remote.stream && v.srcObject !== s.remote.stream) { v.srcObject = s.remote.stream; v.muted = s.muted; v.play().catch(() => {}); }
  }

  async function pollStats(sess) {
    if (!sess.pc || sess.pc.connectionState === 'closed') return;
    try {
      const st = await sess.pc.getStats();
      let inB = 0, outB = 0, fps = 0, w = 0, h = 0, path = '';
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') { inB = r.bytesReceived || 0; fps = r.framesPerSecond || 0; w = r.frameWidth || 0; h = r.frameHeight || 0; }
        if (r.type === 'outbound-rtp' && r.kind === 'video') outB = r.bytesSent || 0;
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) { const rc = st.get(r.remoteCandidateId), lc = st.get(r.localCandidateId); path = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay') ? 'via call server' : 'direct'; }
      });
      const now = Date.now(), dt = (now - (sess.lastT || now)) / 1000 || 1;
      const kbpsIn = sess.lastIn !== undefined ? Math.round((inB - sess.lastIn) * 8 / 1000 / dt) : 0, kbpsOut = sess.lastOut !== undefined ? Math.round((outB - sess.lastOut) * 8 / 1000 / dt) : 0;
      sess.lastIn = inB; sess.lastOut = outB; sess.lastT = now; sess.path = path;
      sess.stats = (sess.remote.screen ? `${w}×${h} · ${fps} fps · ${(kbpsIn / 1000).toFixed(1)} Mb/s in` : '') + (sess.screenTrack ? `${sess.remote.screen ? ' · ' : ''}${(kbpsOut / 1000).toFixed(1)} Mb/s out` : '') + (path ? ` · ${path}` : '');
      $('viewerStats').textContent = sess.stats;
      $('sharePill').title = sess.stats;
    } catch {}
  }

  // --- my side ---------------------------------------------------------------------
  async function start(pub, mode) {
    const c = contact(pub);
    if (!c) return;
    if (c.status !== 'online') { toast(`${c.name} is offline: a screen share needs them connected`, 'err'); return; }
    if (s && s.pub !== pub) { toast(`End the share with ${contact(s.pub)?.name || 'the other contact'} first`, 'err'); return; }
    const perm = await window.api.screenPermission();   // macOS: ask before trying, with instructions instead of a capture error
    if (perm !== 'ok') { window.showScreenPermission(perm); return; }
    const sess = s || await create(pub);
    sess.mode = mode || sess.mode;
    if (sess.screenTrack) return;
    let screen;
    try { screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: FPS, max: 30 } }, audio: false }); }
    catch (e) { toast(`Could not capture the screen: ${e.message}`, 'err'); if (!sess.remote.screen && !sess.remote.mic) close('capture'); return; }
    const track = screen.getVideoTracks()[0];
    track.contentHint = 'detail';
    try { await track.applyConstraints({ width: { max: MAX_W }, height: { max: MAX_H }, frameRate: { ideal: FPS, max: 30 } }); } catch {}
    track.onended = () => { if (s === sess && sess.screenTrack === track) stopSharing(); }; // the OS ended the capture
    sess.screenTrack = track; sess.local.addTrack(track);
    sess.screenSender = sess.pc.addTrack(track, sess.local);
    try { const p = sess.screenSender.getParameters(); p.encodings = [{ maxBitrate: VIDEO_KBPS * 1000, maxFramerate: 30 }]; await sess.screenSender.setParameters(p); } catch {}
    await addMic(sess, true);
    sendState(sess); render(); renderContacts();
  }

  async function addMic(sess, quiet) {
    if (sess.micTrack) return true;
    if (!(await window.api.micPermission())) { if (!quiet) toast('Microphone access was not allowed; sharing without sound', 'err'); return false; }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const t = mic.getAudioTracks()[0];
      sess.micTrack = t; sess.local.addTrack(t); sess.micSender = sess.pc.addTrack(t, sess.local);
      return true;
    } catch (e) { if (!quiet) toast(`Microphone: ${e.message}`, 'err'); return false; }
  }

  function dropTrack(sess, which) {
    const t = sess[which + 'Track'], snd = sess[which + 'Sender'];
    if (snd) { try { sess.pc.removeTrack(snd); } catch {} }
    if (t) { t.stop(); sess.local.removeTrack(t); }
    sess[which + 'Track'] = null; sess[which + 'Sender'] = null;
  }

  function stopSharing() {
    if (!s) return;
    dropTrack(s, 'screen'); dropTrack(s, 'mic');
    sendState(s);
    if (!s.remote.screen && !s.remote.mic) close('stopped'); else { render(); renderContacts(); }
  }

  async function toggleMic() {
    if (!s) return;
    if (s.micTrack) { s.micTrack.enabled = !s.micTrack.enabled; }
    else await addMic(s, false);
    sendState(s); render();
  }

  const sendState = (sess) => send(sess, { op: 'state', screen: !!sess.screenTrack, mic: !!(sess.micTrack && sess.micTrack.enabled), mode: sess.mode });

  function close(why) {
    if (!s) return;
    const sess = s; s = null;
    clearInterval(sess.statsTimer);
    dropTrack(sess, 'screen'); dropTrack(sess, 'mic');
    try { sess.pc.close(); } catch {}
    const v = $('viewerVideo'); v.srcObject = null;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (why === 'bye') toast(`${contact(sess.pub)?.name || 'They'} ended the screen share`);
    if (why === 'offline') toast('Screen share ended: the contact went offline', 'err');
    render(); renderContacts();
  }
  function end() { if (!s) return; send(s, { op: 'bye' }); close('ended'); }

  // --- their side ---------------------------------------------------------------------
  async function onFrame(ev) {
    try {
      if (ev.op === 'bye') { if (s && s.pub === ev.pub) close('bye'); return; }
      if (!s) {
        // a share starts with a `state` (sent as soon as the tracks exist) followed by the offer; either opens the session here
        const opens = (ev.op === 'sdp' && ev.description.type === 'offer') || (ev.op === 'state' && (ev.screen || ev.mic));
        if (!opens) return; // stale ice/state after a bye
        await create(ev.pub, ev.sid);
      } else if (s.pub !== ev.pub) { if (ev.op === 'sdp' || ev.op === 'state') window.api.share(ev.pub, { sid: ev.sid, op: 'bye' }).catch(() => {}); return; } // busy with someone else
      if (ev.op === 'sdp') {
        const d = ev.description, pc = s.pc;
        const readyForOffer = !s.makingOffer && (pc.signalingState === 'stable' || s.settingAnswer);
        const collision = d.type === 'offer' && !readyForOffer;
        s.ignoreOffer = !s.polite && collision;
        if (s.ignoreOffer) return;
        s.settingAnswer = d.type === 'answer';
        await pc.setRemoteDescription(d);
        s.settingAnswer = false;
        if (d.type === 'offer') { await pc.setLocalDescription(); send(s, { op: 'sdp', description: pc.localDescription.toJSON() }); }
      } else if (ev.op === 'ice') {
        try { await s.pc.addIceCandidate(ev.candidate === null ? undefined : ev.candidate); } catch (e) { if (!s.ignoreOffer) console.warn('ice', e.message); }
      } else if (ev.op === 'state') {
        const was = s.remote.screen;
        s.remote.screen = ev.screen; s.remote.mic = ev.mic; s.remote.mode = ev.mode;
        if (ev.screen && !was) { attachRemote(); if (S.current !== ev.pub) toast(`${contact(ev.pub)?.name || 'A contact'} is sharing their screen: open that chat to watch`); }
        if (ev.mode === 'two' && ev.screen && !s.screenTrack && !s.askedBack) { s.askedBack = true; $('shareBackName').textContent = contact(ev.pub)?.name || 'They'; show('mShareBack'); }
        if (!ev.screen && !ev.mic && !s.screenTrack && !s.micTrack) { close('stopped'); return; }
        render(); renderContacts();
      }
    } catch (e) { console.error('share frame', e); }
  }
  function onStatus(ev) { if (s && ev.pub === s.pub && ev.status !== 'online') close('offline'); }

  // --- UI ---------------------------------------------------------------------
  function render() {
    const pub = S.current, mine = s && s.pub === pub;
    const sharing = !!(mine && s.screenTrack), watching = !!(mine && s.remote.screen);
    const btn = $('btnShare'); btn.textContent = sharing ? '■ Stop sharing' : '⇡ Share screen'; btn.classList.toggle('on', sharing);
    btn.title = sharing ? 'Stop sending your screen' : `Send your screen${S.settings.shareMode === 'two' ? ' and ask for theirs (two way)' : ''} to this contact, one click`;
    $('btnShareMode').classList.toggle('hidden', sharing);
    const micBtn = $('btnMic'); micBtn.classList.toggle('hidden', !mine); if (mine) { const on = !!(s.micTrack && s.micTrack.enabled); micBtn.textContent = on ? '🎙' : '🎙̸'; micBtn.classList.toggle('on', on); micBtn.title = on ? 'Mute your microphone' : s.micTrack ? 'Unmute your microphone' : 'Talk: send your microphone'; }
    const pill = $('sharePill'); const state = !mine ? '' : s.pc.connectionState === 'connected' || s.pc.connectionState === 'completed' ? (sharing && watching ? 'Both screens' : sharing ? 'Sharing' : watching ? 'Watching' : 'Voice') : s.pc.connectionState === 'failed' ? 'Failed' : 'Connecting…';
    pill.classList.toggle('hidden', !state); pill.textContent = state; pill.className = 'share-pill ' + (sharing ? 'sharing' : watching ? 'watching' : 'idle');
    const viewer = $('viewer'); viewer.classList.toggle('hidden', !watching);
    if (watching) { $('viewerName').textContent = `${contact(pub)?.name || ''}'s screen`; $('viewerShareBack').classList.toggle('hidden', sharing); $('viewerTalk').textContent = s.micTrack && s.micTrack.enabled ? '🎙 Talking' : '🎙 Talk'; $('viewerMute').textContent = s.muted ? '🔇' : '🔊'; attachRemote(); }
    document.getElementById('chat').classList.toggle('with-viewer', watching);
  }
  const sessionPub = () => (s ? s.pub : null);

  $('btnShare').onclick = () => { if (!S.current) return; if (s && s.pub === S.current && s.screenTrack) stopSharing(); else start(S.current, S.settings.shareMode === 'two' ? 'two' : 'one'); };
  $('btnShareMode').onclick = (e) => { e.stopPropagation(); const m = $('shareMenu'); m.classList.toggle('hidden'); m.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (S.settings.shareMode || 'one'))); };
  $('shareMenu').querySelectorAll('button').forEach((b) => (b.onclick = async () => { $('shareMenu').classList.add('hidden'); S.settings.shareMode = await window.api.setPref('shareMode', b.dataset.mode); render(); toast(b.dataset.mode === 'two' ? 'Two way: your contact will be asked to share their screen too' : 'One way: only your screen is sent', 'ok'); }));
  document.addEventListener('click', () => $('shareMenu').classList.add('hidden'));
  $('btnMic').onclick = toggleMic;
  $('viewerTalk').onclick = toggleMic;
  $('viewerMute').onclick = () => { if (!s) return; s.muted = !s.muted; $('viewerVideo').muted = s.muted; render(); };
  $('viewerShareBack').onclick = () => { if (s) start(s.pub, 'two'); };
  $('viewerFull').onclick = () => { const v = $('viewerVideo'); if (document.fullscreenElement) document.exitFullscreen(); else v.requestFullscreen().catch(() => {}); };
  $('viewerEnd').onclick = end;
  $('shareBackYes').onclick = () => { window.closeModal(); if (s) start(s.pub, 'two'); };
  $('shareBackNo').onclick = () => window.closeModal();

  // debug surface for the UI test (test/ui/share.sh): session internals and audio RTP counters
  const debug = () => (s ? { sid: s.id, mode: s.mode, askedBack: s.askedBack, polite: s.polite, signaling: s.pc.signalingState, conn: s.pc.connectionState, remote: { screen: s.remote.screen, mic: s.remote.mic, mode: s.remote.mode }, local: { screen: !!s.screenTrack, mic: !!(s.micTrack && s.micTrack.enabled) }, path: s.path } : null);
  async function audio() {
    if (!s) return null;
    const out = { in: null, out: null };
    (await s.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.in = { packets: r.packetsReceived, energy: r.totalAudioEnergy, level: r.audioLevel };
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.out = { packets: r.packetsSent, bytes: r.bytesSent };
    });
    return out;
  }
  window.Share = { onFrame, onStatus, render, end, sessionPub, active: () => !!s, debug, audio };
})();
