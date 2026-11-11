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
// This file is the last share script and holds what is left: remote control (until share/control.js
// exists), the paint of the header and the viewer bar, the buttons, the debug surface and window.Share.
// The sessions are in share/session.js, my outgoing screen and microphone in share/cast.js, recording in
// share/record.js, the video, full screen and the pointer and key listeners in share/viewer.js;
// share/kit.js has the namespace (K) and share/tune.js every latency and quality value.
//
// Reads from app.js: S, $, toast, contact, ipcErr, show.
(() => {
  const K = window.ShareKit;
  const map = K.sessions.map;
  const cur = () => map.get(S.current) || null;                                             // the session of the open chat
  const pick = (pub) => map.get(pub) || cur() || map.values().next().value || null;         // ... else the oldest
  const giving = (state) => [...map.values()].find((x) => x.ctl.give === state) || null;    // the session that asked for ('asked') or has ('on') control of my screen

  // --- remote control ----------------------------------------------------------------
  function onCtl(sess, data) {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    sess.ctl.recv++;
    const name = K.nameOf(sess.pub);
    switch (m.t) {
      case 'cur':   // the shape of their pointer: drawn as my own while I control
        sess.ctl.cursor = cursorCss(m);
        K.viewer.applyCtl();
        return;
      case 'req':   // they want my mouse and keyboard
        if (!sess.screenTrack) { K.sessions.dc(sess, 'ctl', { t: 'ctl', on: false, why: 'notsharing' }); return; }
        if (sess.ctl.give === 'on') { K.sessions.dc(sess, 'ctl', { t: 'ctl', on: true }); return; }
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
  function onCursor(c) { const sess = giving('on'); if (sess && c && typeof c === 'object') K.sessions.dc(sess, 'ctl', { t: 'cur', w: c.w, h: c.h, pw: c.pw, ph: c.ph, hx: c.hx, hy: c.hy, png: c.png }); }
  async function giveControl(sess) {
    if (sess.closed || !sess.screenTrack) { sess.ctl.give = 'off'; K.sessions.dc(sess, 'ctl', { t: 'ctl', on: false, why: 'notsharing' }); render(); return; }
    let r; try { r = await window.api.controlGrant(); } catch (e) { r = { ok: false, reason: 'helper', message: ipcErr(e) }; }
    if (sess.closed) return;
    const name = K.nameOf(sess.pub);
    if (r && r.ok) {
      sess.ctl.give = 'on';
      try { if (sess.screenTrack) sess.screenTrack.contentHint = K.tune.hint(true); } catch {}
      K.sessions.dc(sess, 'ctl', { t: 'ctl', on: true });
      toast(`${name} now uses your mouse and keyboard. ✋ Stop control next to the Sharing pill ends it.`);
    } else {
      sess.ctl.give = 'off';
      K.sessions.dc(sess, 'ctl', { t: 'ctl', on: false, why: (r && r.reason) || 'helper' });
      toast((r && r.message) || 'Control could not be allowed', 'err');
    }
    render();
  }
  // sharer: control of my screen ends (Deny, ✋, they released it, the share stops, the helper died)
  function giveUp(sess, why) {
    const was = sess.ctl.give; sess.ctl.give = 'off';
    if (was === 'on') { window.api.controlRevoke().catch(() => {}); try { if (sess.screenTrack) sess.screenTrack.contentHint = K.tune.hint(false); } catch {} }
    if (why !== 'released' && was !== 'off') K.sessions.dc(sess, 'ctl', { t: 'ctl', on: false, why: why === 'denied' ? undefined : why === 'stopped' ? 'stopped' : 'helper' });
    if (!$('mControl').classList.contains('hidden')) window.closeModal();
    if (was === 'on') toast(why === 'released' ? `${K.nameOf(sess.pub)} stopped controlling your screen` : why === 'stopped' ? 'Remote control stopped' : `Remote control stopped: ${why}`);
    render();
  }
  function onControl(ev) { const sess = giving('on'); if (sess && !ev.on) giveUp(sess, ev.why || 'the input helper stopped'); }
  // viewer: ask for their mouse and keyboard, or let go
  function askControl(sess) {
    if (!sess.remote.screen) return;
    if (sess.ctl.take) { stopTaking(sess); K.sessions.dc(sess, 'ctl', { t: 'rel' }); toast('You no longer control their screen'); render(); return; }
    if (sess.ctl.asked) return;
    if (!K.sessions.dc(sess, 'ctl', { t: 'req' })) { toast('Not connected yet: try again in a moment', 'err'); return; }
    sess.ctl.asked = true;
    sess.ctl.askTimer = setTimeout(() => { if (sess.ctl.asked) { sess.ctl.asked = false; if (!sess.closed) { toast(`${K.nameOf(sess.pub)} has not answered`); render(); } } }, K.tune.ASK_MS);
    render();
  }
  function startTaking(sess) {
    sess.ctl.take = true; sess.ctl.move = null; sess.ctl.moveAt = 0;
    clearTimeout(sess.ctl.flush); sess.ctl.flush = null;
    K.viewer.applyCtl();
  }
  function stopTaking(sess) {
    clearTimeout(sess.ctl.flush); sess.ctl.flush = null; sess.ctl.move = null;
    if (sess.ctl.take) { sess.ctl.take = false; K.sessions.dc(sess, 'ctl', { t: 'r' }); }
    sess.ctl.cursor = null;
    K.viewer.applyCtl();
  }
  const taking = () => { const sess = K.viewer.bound; return sess && sess.ctl.take && sess.remote.screen ? sess : null; };   // the session whose screen I drive right now (the one on the video), or null
  // a session closes: control of either side's screen ends with it
  function controlClosed(sess) {
    if (sess.ctl.give === 'on') window.api.controlRevoke().catch(() => {});
    clearTimeout(sess.ctl.flush); clearTimeout(sess.ctl.askTimer);
    if (!$('mControl').classList.contains('hidden')) window.closeModal();
  }
  K.control = { onData: onCtl, stopTaking, isTaking: () => !!taking(), sessionClosed: controlClosed, endGive: (sess, why) => { if (sess.ctl.give !== 'off') giveUp(sess, why); } };   // what the other share files call, until share/control.js exists

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
    $('btnStopCtl').classList.toggle('hidden', !(sharing && sess.ctl.give === 'on'));
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
  $('viewerRec').onclick = () => { const sess = cur(); if (sess) K.rec.toggle(sess); };
  $('viewerEnd').onclick = () => { const sess = cur(); if (sess) K.sessions.end(sess); };
  // the prompt belongs to the session that asked: Yes shares with that contact or with nobody
  $('shareBackYes').onclick = () => { window.closeModal(); const sess = K.viewer.backFor; K.viewer.backFor = null; if (sess && !sess.closed) K.cast.add(sess.pub, 'two'); };
  $('shareBackNo').onclick = () => window.closeModal();
  // remote control: the viewer's input on the video goes to their machine while it is on
  $('viewerCtl').onclick = () => { const sess = cur(); if (sess) askControl(sess); };
  $('btnStopCtl').onclick = () => { const sess = giving('on'); if (sess) giveUp(sess, 'stopped'); };
  // the dialog belongs to the session that asked, whichever chat is open
  $('controlYes').onclick = () => { window.closeModal(); const sess = giving('asked'); if (sess) giveControl(sess); };
  $('controlNo').onclick = () => { window.closeModal(); const sess = giving('asked'); if (sess) giveUp(sess, 'denied'); };

  // debug surface for the UI test (test/ui/share.sh): session internals and audio RTP counters
  const debug = (pub) => { const x = pick(pub); return x ? { sid: x.id, ver: x.ver, mode: x.mode, rec: !!x.rec, recFile: x.rec ? x.rec.file : null, recBytes: x.rec ? x.rec.bytes : 0, remoteRec: x.remote.rec, theater: K.viewer.theater, askedBack: x.askedBack, polite: x.polite, signaling: x.pc ? x.pc.signalingState : null, conn: x.pc ? x.pc.connectionState : null, remote: { screen: x.remote.screen, mic: x.remote.mic, mode: x.remote.mode }, in: { video: !!x.remote.video, audio: !!x.remote.audio }, local: { screen: !!x.screenTrack, mic: !!(x.micTrack && x.micTrack.enabled) }, path: x.path, rtt: x.rtt, codec: x.codec, q: x.q || null,
    enc: x.screenSender ? x.screenSender.getParameters().encodings[0] || null : null,
    ctl: { give: x.ctl.give, take: x.ctl.take, asked: x.ctl.asked, sent: x.ctl.sent, recv: x.ctl.recv, chans: x.ctl.chans.map((c) => `${c.label}:${c.readyState}`) } } : null; };
  const debugAll = () => ({ sessions: Object.fromEntries([...map.values()].map((x) => [x.pub.slice(0, 8), debug(x.pub)])),
    capture: { state: K.capture.state, leases: K.capture.leases.size }, mic: { state: K.mic.state, leases: K.mic.leases.size, audienceOn: K.mic.audienceOn },
    cast: { members: Object.fromEntries([...K.cast.members].map(([pub, m]) => [pub.slice(0, 8), m.state])) } });
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
  window.Share = { onFrame: (ev) => K.sessions.onFrame(ev), onStatus: (ev) => K.sessions.onStatus(ev), onSettings, onFullscreen: (ev) => K.viewer.onFullscreen(ev), onControl, onCursor, render, end: () => { const sess = cur(); if (sess) K.sessions.end(sess); }, setFull: (on) => K.viewer.setFull(on), sessionPub, active: () => map.size > 0, lastRecording: () => K.rec.last, debug, debugAll, audio,
    inject: (m) => { const sess = taking(); return sess ? K.sessions.dc(sess, m && m.t === 'm' ? 'move' : 'ctl', m) : false; } };   // test hook: send one control message as the viewer's input would
})();
