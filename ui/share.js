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
// Reads from app.js: S, $, toast, contact, ipcErr, renderContacts, show. Exposes window.Share.
(() => {
  let s = null;                       // the active session, or null
  const newSid = () => Math.random().toString(36).slice(2, 12);
  // Caps: VP9 screen content at up to 8 Mb/s and 30 fps, 2560 px wide. Congestion control brings
  // the rate down on a weak link; on a LAN or a good direct path text stays sharp and motion smooth.
  const MAX_W = 2560, MAX_H = 1600, FPS = 30, VIDEO_KBPS = 8000;
  const MOVE_MS = 16;                 // pointer moves are coalesced to one per frame
  const ASK_MS = 45000;               // a control request with no answer expires

  const ice = () => window.api.iceConfig(); // read per session, so a Settings change applies to the next share
  const send = (sess, f) => window.api.share(sess.pub, { sid: sess.id, ...f }).catch((e) => { toast(ipcErr(e), 'err'); if (/offline/.test(ipcErr(e))) close('offline'); });
  const nameOf = (pub) => contact(pub)?.name || 'Your contact';

  async function create(pub, id) {
    const cfg = await ice();
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: cfg.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    const sess = { pub, id: id || newSid(), pc, polite: S.me.pub < pub, makingOffer: false, ignoreOffer: false, settingAnswer: false,
      local: new MediaStream(), screenTrack: null, micTrack: null, screenSender: null, micSender: null,
      remote: { stream: null, screen: false, mic: false, mode: 'one', rec: false }, mode: 'one', rec: null, recStarting: false, recWanted: !!S.settings.recordShares, askedBack: false, muted: false, stats: '', path: '', statsTimer: null, since: Date.now(),
      ctl: { give: 'off', take: false, asked: false, askTimer: null, dc: null, mv: null, chans: [], move: null, flush: null, sent: 0, recv: 0 } };
    pc.onnegotiationneeded = async () => {
      try { sess.makingOffer = true; await pc.setLocalDescription(); send(sess, { op: 'sdp', description: pc.localDescription.toJSON() }); }
      catch (e) { console.error('negotiation', e); }
      finally { sess.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => send(sess, { op: 'ice', candidate: candidate ? candidate.toJSON() : null });
    pc.ontrack = (e) => {
      sess.remote.stream = e.streams[0] || sess.remote.stream || new MediaStream();
      if (!e.streams[0]) sess.remote.stream.addTrack(e.track);
      if (e.track.kind === 'video') lowLatency(e.receiver);
      e.track.onmute = () => render(); e.track.onunmute = () => render(); e.track.onended = () => render();
      attachRemote(); render();
    };
    pc.ondatachannel = (e) => adoptChannel(sess, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { toast('Screen share connection failed. Check the call server in Settings.', 'err'); close('failed'); }
      else render();
    };
    sess.statsTimer = setInterval(() => pollStats(sess), 2000);
    s = sess;
    return sess;
  }

  // The viewer plays what arrives as soon as it arrives: no jitter-buffer cushion for a share
  // that is driven live (Chromium hints; both ignored where unsupported).
  function lowLatency(receiver) {
    try { receiver.jitterBufferTarget = 0; } catch {}
    try { receiver.playoutDelayHint = 0; } catch {}
  }
  // VP9 first: its screen-content mode keeps text sharp at a given rate. The rest in Chromium's order.
  function preferCodecs(pc, sender) {
    try {
      const tr = pc.getTransceivers().find((t) => t.sender === sender);
      const caps = RTCRtpReceiver.getCapabilities('video');
      if (!tr || !tr.setCodecPreferences || !caps) return;
      const rank = (c) => (/vp9/i.test(c.mimeType) ? 0 : 1);
      tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
    } catch (e) { console.warn('codec preference', e.message); }
  }

  function attachRemote() {
    const v = $('viewerVideo');
    if (s && s.remote.stream && v.srcObject !== s.remote.stream) { v.srcObject = s.remote.stream; v.muted = s.muted; v.play().catch(() => {}); }
  }

  async function pollStats(sess) {
    if (!sess.pc || sess.pc.connectionState === 'closed') return;
    try {
      const st = await sess.pc.getStats();
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
      sess.stats = (sess.remote.screen ? `${w}×${h} · ${fps} fps · ${(kbpsIn / 1000).toFixed(1)} Mb/s in` : '') + (sess.screenTrack ? `${sess.remote.screen ? ' · ' : ''}${(kbpsOut / 1000).toFixed(1)} Mb/s out` : '')
        + (codec ? ` · ${codec}` : '') + (rtt >= 0 ? ` · ${rtt} ms` : '') + (path ? ` · ${path}` : '');
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
    try { screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: FPS, max: FPS } }, audio: false }); }
    catch (e) { toast(`Could not capture the screen: ${e.message}`, 'err'); if (!sess.remote.screen && !sess.remote.mic) close('capture'); return; }
    const track = screen.getVideoTracks()[0];
    track.contentHint = sess.ctl.give === 'on' ? 'motion' : 'detail';
    try { await track.applyConstraints({ width: { max: MAX_W }, height: { max: MAX_H }, frameRate: { ideal: FPS, max: FPS } }); } catch {}
    track.onended = () => { if (s === sess && sess.screenTrack === track) stopSharing(); }; // the OS ended the capture
    sess.screenTrack = track; sess.local.addTrack(track);
    openChannels(sess);                                     // in the same task as addTrack: one negotiation covers both
    sess.screenSender = sess.pc.addTrack(track, sess.local);
    preferCodecs(sess.pc, sess.screenSender);
    try { const p = sess.screenSender.getParameters(); p.encodings = [{ maxBitrate: VIDEO_KBPS * 1000, maxFramerate: FPS }]; await sess.screenSender.setParameters(p); } catch {}
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
    if (s.ctl.give !== 'off') giveUp(s, 'stopped');
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

  const sendState = (sess) => send(sess, { op: 'state', screen: !!sess.screenTrack, mic: !!(sess.micTrack && sess.micTrack.enabled), mode: sess.mode, rec: !!sess.rec });

  function close(why) {
    if (!s) return;
    const sess = s; s = null;
    clearInterval(sess.statsTimer);
    if (sess.ctl.give === 'on') window.api.controlRevoke().catch(() => {});
    clearInterval(sess.ctl.flush); clearTimeout(sess.ctl.askTimer);
    if (!$('mControl').classList.contains('hidden')) window.closeModal();
    $('viewerVideo').classList.remove('ctl');
    dropTrack(sess, 'screen'); dropTrack(sess, 'mic');
    try { sess.pc.close(); } catch {}
    if (sess.rec) stopRecording(sess);
    const v = $('viewerVideo'); v.srcObject = null;
    if (theater) setFull(false);
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
        const was = s.remote.screen, wasRec = s.remote.rec;
        s.remote.screen = ev.screen; s.remote.mic = ev.mic; s.remote.mode = ev.mode; s.remote.rec = !!ev.rec;
        if (s.remote.rec && !wasRec && s.screenTrack) toast(`${contact(ev.pub)?.name || 'Your contact'} is recording your screen share`);
        if (ev.screen && !was) { attachRemote(); if (S.current !== ev.pub) toast(`${contact(ev.pub)?.name || 'A contact'} is sharing their screen: open that chat to watch`); }
        if (!ev.screen && (s.ctl.take || s.ctl.asked)) { stopTaking(s); clearTimeout(s.ctl.askTimer); s.ctl.asked = false; }
        if (ev.mode === 'two' && ev.screen && !s.screenTrack && !s.askedBack) { s.askedBack = true; $('shareBackName').textContent = contact(ev.pub)?.name || 'They'; show('mShareBack'); }
        if (!ev.screen && !ev.mic && !s.screenTrack && !s.micTrack) { close('stopped'); return; }
        render(); renderContacts();
      }
    } catch (e) { console.error('share frame', e); }
  }
  function onStatus(ev) { if (s && ev.pub === s.pub && ev.status !== 'online') close('offline'); }

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
    if (viaMove && ch.bufferedAmount > 65536) return false;   // a slow link: drop moves rather than queue them
    try { ch.send(JSON.stringify(msg)); sess.ctl.sent++; return true; } catch { return false; }
  }
  function onCtl(sess, data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    sess.ctl.recv++;
    const name = nameOf(sess.pub);
    switch (m.t) {
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
  async function giveControl(sess) {
    if (sess !== s || !sess.screenTrack) { sess.ctl.give = 'off'; sendCtl(sess, { t: 'ctl', on: false, why: 'notsharing' }); render(); return; }
    let r; try { r = await window.api.controlGrant(); } catch (e) { r = { ok: false, reason: 'helper', message: ipcErr(e) }; }
    if (sess !== s) return;
    const name = nameOf(sess.pub);
    if (r && r.ok) {
      sess.ctl.give = 'on';
      try { if (sess.screenTrack) sess.screenTrack.contentHint = 'motion'; } catch {}   // smooth over sharp while they drive
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
    if (was === 'on') { window.api.controlRevoke().catch(() => {}); try { if (sess.screenTrack) sess.screenTrack.contentHint = 'detail'; } catch {} }
    if (why !== 'released' && was !== 'off') sendCtl(sess, { t: 'ctl', on: false, why: why === 'denied' ? undefined : why === 'stopped' ? 'stopped' : 'helper' });
    if (!$('mControl').classList.contains('hidden')) window.closeModal();
    if (was === 'on') toast(why === 'released' ? `${nameOf(sess.pub)} stopped controlling your screen` : why === 'stopped' ? 'Remote control stopped' : `Remote control stopped: ${why}`);
    render();
  }
  function onControl(ev) { if (s && s.ctl.give === 'on' && !ev.on) giveUp(s, ev.why || 'the input helper stopped'); }
  // viewer: ask for their mouse and keyboard, or let go
  function askControl() {
    if (!s || !s.remote.screen) return;
    if (s.ctl.take) { stopTaking(s); sendCtl(s, { t: 'rel' }); toast('You no longer control their screen'); render(); return; }
    if (s.ctl.asked) return;
    if (!sendCtl(s, { t: 'req' })) { toast('Not connected yet: try again in a moment', 'err'); return; }
    const sess = s; sess.ctl.asked = true;
    sess.ctl.askTimer = setTimeout(() => { if (sess.ctl.asked) { sess.ctl.asked = false; if (s === sess) { toast(`${nameOf(sess.pub)} has not answered`); render(); } } }, ASK_MS);
    render();
  }
  function startTaking(sess) {
    sess.ctl.take = true; sess.ctl.move = null;
    clearInterval(sess.ctl.flush);
    sess.ctl.flush = setInterval(() => { const m = sess.ctl.move; if (m) { sess.ctl.move = null; sendCtl(sess, m, true); } }, MOVE_MS);
    const v = $('viewerVideo'); v.classList.add('ctl'); v.focus();
  }
  function stopTaking(sess) {
    clearInterval(sess.ctl.flush); sess.ctl.flush = null; sess.ctl.move = null;
    if (sess.ctl.take) { sess.ctl.take = false; sendCtl(sess, { t: 'r' }); }
    $('viewerVideo').classList.remove('ctl');
  }
  const taking = () => !!(s && s.ctl.take && s.remote.screen);
  // where on their display the pointer is: fractions of the video picture (object-fit: contain leaves bars)
  function at(e) {
    const v = $('viewerVideo'), r = v.getBoundingClientRect();
    const vw = v.videoWidth || r.width || 1, vh = v.videoHeight || r.height || 1;
    const k = Math.min(r.width / vw, r.height / vh) || 1, cw = vw * k, ch = vh * k;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    const c = (x) => Math.min(1, Math.max(0, x));
    return { x: +c((e.clientX - ox) / cw).toFixed(4), y: +c((e.clientY - oy) / ch).toFixed(4) };
  }
  const keysGoRemote = () => taking() && (document.activeElement === $('viewerVideo') || theater) && $('backdrop').classList.contains('hidden');

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
    if (on && !(s && s.remote.screen)) return;
    if (on === theater) return;
    let got = false; try { got = await window.api.fullscreen(on); } catch (e) { toast(ipcErr(e), 'err'); }
    applyTheater(!!got);
  }
  function onFullscreen(ev) { applyTheater(!!ev.on && !!(s && s.remote.screen)); }

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
    try {
      const { id, file } = await window.api.recordStart(sess.pub);
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
      rec.timer = setInterval(() => { if (sess.rec === rec && s === sess && S.current === sess.pub) renderRec(sess); }, 1000);
      sess.rec = rec;
      sendState(sess); render();
    } catch (e) { toast(`Recording did not start: ${ipcErr(e)}`, 'err'); sess.recWanted = false; }
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
    if (s === sess) { sendState(sess); render(); }
  }
  function syncRecording() {
    if (!s) return;
    if (s.recWanted && !s.rec) startRecording(s);               // waits for the tracks if they are not there yet
    else if (s.rec && (!s.recWanted || !s.remote.screen)) stopRecording(s);
  }
  function renderRec(sess) {
    const b = $('viewerRec'), on = !!sess.rec; b.classList.toggle('on', on);
    b.textContent = on ? `● ${fmtClock(Date.now() - sess.rec.since)}${sess.rec.bytes ? ' · ' + fmtBytes(sess.rec.bytes) : ''}` : '● Record';
    b.title = on ? 'Stop recording (the file is kept)' : 'Record what you see and hear from them to a file';
  }
  function onSettings() { if (s) { s.recWanted = !!S.settings.recordShares; syncRecording(); if (S.current === s.pub) renderRec(s); } }

  // --- UI ---------------------------------------------------------------------
  function render() {
    const pub = S.current, mine = s && s.pub === pub;
    const sharing = !!(mine && s.screenTrack), watching = !!(mine && s.remote.screen);
    const btn = $('btnShare'); btn.textContent = sharing ? '■ Stop sharing' : '⇡ Share screen'; btn.classList.toggle('on', sharing);
    btn.title = sharing ? 'Stop sending your screen' : `Send your screen${S.settings.shareMode === 'two' ? ' and ask for theirs (two way)' : ''} to this contact, one click`;
    $('btnShareMode').classList.toggle('hidden', sharing);
    const micBtn = $('btnMic'); micBtn.classList.toggle('hidden', !mine); if (mine) { const on = !!(s.micTrack && s.micTrack.enabled); micBtn.textContent = on ? '🎙' : '🎙̸'; micBtn.classList.toggle('on', on); micBtn.title = on ? 'Mute your microphone' : s.micTrack ? 'Unmute your microphone' : 'Talk: send your microphone'; }
    const pill = $('sharePill'); const state = !mine ? '' : s.pc.connectionState === 'connected' || s.pc.connectionState === 'completed' ? (sharing && watching ? 'Both screens' : sharing ? 'Sharing' : watching ? 'Watching' : 'Voice') + (sharing && s.remote.rec ? ' · recorded' : '') + (sharing && s.ctl.give === 'on' ? ' · controlled' : '') : s.pc.connectionState === 'failed' ? 'Failed' : 'Connecting…';
    pill.classList.toggle('hidden', !state); pill.textContent = state; pill.className = 'share-pill ' + (sharing ? 'sharing' : watching ? 'watching' : 'idle');
    $('btnStopCtl').classList.toggle('hidden', !(sharing && s.ctl.give === 'on'));
    const viewer = $('viewer'); viewer.classList.toggle('hidden', !watching);
    if (watching) {
      $('viewerName').textContent = `${contact(pub)?.name || ''}'s screen`; $('viewerShareBack').classList.toggle('hidden', sharing); $('viewerTalk').textContent = s.micTrack && s.micTrack.enabled ? '🎙 Talking' : '🎙 Talk'; $('viewerMute').textContent = s.muted ? '🔇' : '🔊'; attachRemote();
      const cb = $('viewerCtl'); cb.textContent = s.ctl.take ? '🖱 Controlling' : s.ctl.asked ? '🖱 Asking…' : '🖱 Control'; cb.classList.toggle('on', s.ctl.take);
      cb.title = s.ctl.take ? 'Stop controlling their screen' : s.ctl.asked ? 'Waiting for their answer' : 'Ask to use their mouse and keyboard';
    }
    document.getElementById('chat').classList.toggle('with-viewer', watching);
    if (mine) renderRec(s);
    if (theater && !watching) setFull(false);
    syncRecording();
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
  $('viewerFull').onclick = () => setFull();
  $('viewerVideo').ondblclick = () => { if (!taking()) setFull(); };   // while controlling, two clicks are theirs
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && theater && !keysGoRemote()) { e.stopPropagation(); setFull(false); } }, true);
  $('viewerRec').onclick = () => { if (!s) return; s.recWanted = !s.rec; syncRecording(); renderRec(s); };
  $('viewerEnd').onclick = end;
  $('shareBackYes').onclick = () => { window.closeModal(); if (s) start(s.pub, 'two'); };
  $('shareBackNo').onclick = () => window.closeModal();
  // remote control: the viewer's input on the video goes to their machine while it is on
  $('viewerCtl').onclick = askControl;
  $('btnStopCtl').onclick = () => { if (s) giveUp(s, 'stopped'); };
  $('controlYes').onclick = () => { window.closeModal(); if (s) giveControl(s); };
  $('controlNo').onclick = () => { window.closeModal(); if (s) giveUp(s, 'denied'); };
  {
    const v = $('viewerVideo');
    v.addEventListener('pointermove', (e) => { if (taking()) s.ctl.move = { t: 'm', ...at(e) }; });
    v.addEventListener('pointerdown', (e) => { if (!taking()) return; e.preventDefault(); v.focus(); try { v.setPointerCapture(e.pointerId); } catch {} const p = at(e); s.ctl.move = null; sendCtl(s, { t: 'm', ...p }); sendCtl(s, { t: 'b', b: e.button, d: 1, ...p }); });
    v.addEventListener('pointerup', (e) => { if (!taking()) return; e.preventDefault(); sendCtl(s, { t: 'b', b: e.button, d: 0, ...at(e) }); });
    v.addEventListener('wheel', (e) => { if (!taking()) return; e.preventDefault(); const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; sendCtl(s, { t: 'w', dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...at(e) }); }, { passive: false });
    v.addEventListener('contextmenu', (e) => { if (taking()) e.preventDefault(); });
    const onKey = (e) => { if (!keysGoRemote()) return; e.preventDefault(); e.stopPropagation(); if (e.repeat) return; sendCtl(s, { t: 'k', c: e.code, d: e.type === 'keydown' ? 1 : 0 }); };
    document.addEventListener('keydown', onKey, true); document.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', () => { if (taking()) sendCtl(s, { t: 'r' }); });   // nothing stays pressed over there when this window loses the keyboard
  }

  // debug surface for the UI test (test/ui/share.sh): session internals and audio RTP counters
  const debug = () => (s ? { sid: s.id, mode: s.mode, rec: !!s.rec, recFile: s.rec ? s.rec.file : null, recBytes: s.rec ? s.rec.bytes : 0, remoteRec: s.remote.rec, theater, askedBack: s.askedBack, polite: s.polite, signaling: s.pc.signalingState, conn: s.pc.connectionState, remote: { screen: s.remote.screen, mic: s.remote.mic, mode: s.remote.mode }, local: { screen: !!s.screenTrack, mic: !!(s.micTrack && s.micTrack.enabled) }, path: s.path, rtt: s.rtt, codec: s.codec,
    ctl: { give: s.ctl.give, take: s.ctl.take, asked: s.ctl.asked, sent: s.ctl.sent, recv: s.ctl.recv, chans: s.ctl.chans.map((c) => `${c.label}:${c.readyState}`) } } : null);
  async function audio() {
    if (!s) return null;
    const out = { in: null, out: null };
    (await s.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.in = { packets: r.packetsReceived, energy: r.totalAudioEnergy, level: r.audioLevel };
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.out = { packets: r.packetsSent, bytes: r.bytesSent };
    });
    return out;
  }
  window.Share = { onFrame, onStatus, onSettings, onFullscreen, onControl, render, end, setFull, sessionPub, active: () => !!s, lastRecording: () => lastRecording, debug, audio,
    inject: (m) => (taking() ? sendCtl(s, m, m && m.t === 'm') : false) };   // test hook: send one control message as the viewer's input would
})();
