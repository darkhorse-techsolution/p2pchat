'use strict';
// Screen share with voice, between the two apps, over WebRTC.
//
// Signaling (SDP, ICE, a small state message, bye) rides the chat's end-to-end
// channel as `share` frames, so the DTLS fingerprints that key the media are
// authenticated by the same long-term keys as the messages. Media is DTLS-SRTP
// straight between the peers, or through the TURN server from Settings when the
// NATs will not let it through.
//
// One session per contact, up to K.MAX_SESSIONS at once, each a connection of its own. My screen can
// go to several contacts from the one capture (the audience); they get my screen and my microphone
// and nothing of each other. Either side of a session can add or drop its screen or its mic at
// any moment (one-way, two-way, talk-back) because the connection uses the
// "perfect negotiation" pattern: the side with the lower public key is polite
// and yields on an offer collision; the other keeps its offer.
//
// Remote control: a viewer can ask to drive the sharer's mouse and keyboard. The sharer answers a
// dialog and can stop it at any moment; one contact at a time has it. Events ride two data channels
// on the same connection: "ctl" (reliable: requests, answers, buttons, keys, wheel) and
// "move" (unordered, no retransmits: pointer moves, where only the latest matters). The
// sharer's app hands them to the main process with the token of the grant, and main posts them to
// the OS (main/grant.js, main/input.js). Only a whole display is ever shared, so coordinates are
// fractions of that display. While control is on, and only when both sides said so in that request,
// copied text travels both ways on a third channel, "clip" (main/clip.js reads and writes the clipboard).
//
// This file is the last share script and holds what is left: the paint of the header, the viewer bar
// and the audience bar, the audience picker, the buttons, the debug surface and window.Share. The
// sessions are in share/session.js, my outgoing screen and microphone and the audience in
// share/cast.js, remote control in share/control.js, the clipboard link that can come with it in
// share/clip.js, recording in share/record.js, the video, full screen, the pointer and key listeners
// and the prompts in share/viewer.js; share/kit.js has the namespace (K) and share/tune.js every
// latency and quality value.
//
// Reads from app.js: S, $, toast, contact.
(() => {
  const K = window.ShareKit;
  const map = K.sessions.map;
  const cur = () => map.get(S.current) || null;                                             // the session of the open chat
  const pick = (pub) => map.get(pub) || cur() || map.values().next().value || null;         // ... else the oldest

  function onSettings() {
    for (const sess of map.values()) { sess.recWanted = !!S.settings.recordShares; K.rec.sync(sess); if (S.current === sess.pub) K.rec.paint(sess); }
    // The switch went off: the link ends on both sides, and every offer of mine that is still out is withdrawn
    // (a request sent while it was on). Switching it on again brings neither back: that takes a new request.
    if (S.settings.clipboardSync === false) { for (const sess of map.values()) sess.ctl.askedClip = false; if (K.clip.link) K.clip.off(K.clip.link.sess, 'setting'); }
    if (K.caption) K.caption.sync();
    render();
  }

  // --- UI ---------------------------------------------------------------------
  // Only draws. What a share needs done is done where it happens (a recording in share/record.js, the
  // stats line in K.paintStats); the first line is the one exception: it points the video at the open
  // chat's share and leaves full screen when that share is gone.
  function render() {
    K.viewer.rebind();
    const pub = S.current, sess = cur(), mine = !!sess, conn = mine && sess.pc ? sess.pc.connectionState : '';   // no pc yet: still connecting
    const sharing = !!(mine && sess.screenTrack), watching = !!(mine && sess.remote.screen);
    const viewers = K.cast.count(), casting = K.capture.state === 'live' || K.cast.members.size > 0;   // my screen goes out already, to someone
    const link = K.clip.link, linked = !!link && link.sess === sess;                                    // the clipboard is shared in this chat's session
    // The button stops what it shows as running: also for a contact of the audience that is away, or whose share is still being started.
    const stops = sharing || K.cast.members.has(pub);
    const btn = $('btnShare'); btn.textContent = stops ? '■ Stop sharing' : casting ? '＋ Add to share' : '⇡ Share screen'; btn.classList.toggle('on', stops);
    btn.title = stops ? (viewers >= 2 ? 'Stop sending your screen to this contact; the others keep it' : 'Stop sending your screen') : casting ? 'Send the screen you are sharing to this contact as well, one click' : `Send your screen${S.settings.shareMode === 'two' ? ' and ask for theirs (two way)' : ''} to this contact, one click`;
    $('shareMenu').querySelectorAll('button[data-mode]').forEach((b) => b.classList.toggle('hidden', sharing));   // one way or two way is chosen before a share; the ▾ stays for the audience picker
    const micBtn = $('btnMic'); micBtn.classList.toggle('hidden', !mine); if (mine) { const on = !!(sess.micTrack && sess.micTrack.enabled); micBtn.textContent = on ? '🎙' : '🎙̸'; micBtn.classList.toggle('on', on); micBtn.title = (on ? 'Mute your microphone' : sess.micTrack ? 'Unmute your microphone' : 'Talk: send your microphone') + (sharing && K.cast.members.size >= 2 ? ' for everyone you share with' : ''); }
    const pill = $('sharePill'); const state = !mine ? '' : conn === 'connected' || conn === 'completed' ? (sharing && watching ? 'Both screens' : sharing ? 'Sharing' : watching ? 'Watching' : 'Voice') + (sharing && sess.remote.rec ? ' · recorded' : '') + (sharing && sess.ctl.give === 'on' ? ' · controlled' : '') + (sharing && viewers >= 2 ? ` · ${viewers} viewers` : '') + (linked ? ' · clipboard' : '') : conn === 'failed' ? 'Failed' : 'Connecting…';
    pill.textContent = state; pill.className = 'share-pill ' + (sharing ? 'sharing' : watching ? 'watching' : 'idle') + (state ? '' : ' hidden');   // the class list in one piece: set after `hidden`, it used to put an empty pill back on screen
    // whoever drives my screen can be stopped from every chat; elsewhere than in their own the button says who it is
    const own = K.control.owner, driven = !!own && own.sess.ctl.give === 'on', stop = $('btnStopCtl');
    stop.classList.toggle('hidden', !driven); stop.textContent = driven && own.sess.pub !== pub && !K.hushed() ? `✋ Stop control (${K.nameOf(own.sess.pub)})` : '✋ Stop control';
    // and so can the clipboard that is shared with them: in every chat, control stays
    const cbtn = $('btnClip'); cbtn.classList.toggle('hidden', !(link && link.role === 'give')); cbtn.textContent = K.viewer.clipLabel();
    const viewer = $('viewer'); viewer.classList.toggle('hidden', !watching);
    if (watching) {
      $('viewerName').textContent = `${contact(pub)?.name || ''}'s screen`; $('viewerShareBack').classList.toggle('hidden', sharing); $('viewerTalk').textContent = sess.micTrack && sess.micTrack.enabled ? '🎙 Talking' : '🎙 Talk'; $('viewerMute').textContent = sess.muted ? '🔇' : '🔊';
      $('viewerAud').textContent = sess.remote.cast >= 2 ? ` · ${sess.remote.cast} watching` : '';   // the sharer said how many get this screen
      $('viewerTalk').title = `Send your microphone: only ${K.nameOf(pub)} hears you`;
      const cb = $('viewerCtl'); cb.textContent = sess.ctl.take ? '🖱 Controlling' : sess.ctl.asked ? '🖱 Asking…' : '🖱 Control'; cb.classList.toggle('on', sess.ctl.take);
      cb.title = sess.ctl.take ? 'Stop controlling their screen' : sess.ctl.asked ? 'Waiting for their answer' : 'Ask to use their mouse and keyboard' + (S.settings.clipboardSync !== false && !link ? '. Text you or they copy is shared both ways while you control (Settings switches it off).' : '');
    }
    const vclip = $('viewerClip'); vclip.classList.toggle('hidden', !(watching && linked)); vclip.textContent = K.viewer.clipLabel();
    document.getElementById('chat').classList.toggle('with-viewer', watching);
    if (mine) { K.rec.paint(sess); K.paintStats(sess); }   // the stats line too: the poll writes it only every 2 s, and not while this chat was closed
    // The audience bar, above whatever chat is open: who gets my screen, and Stop for all of them. A share
    // with the one contact whose chat is open has no bar: it looks as it always did. While someone drives
    // my screen the bar stays on top of a full-screen viewer (class ctl).
    const m = K.cast.members, bar = $('castBar'), barOn = m.size >= 2 || (m.size === 1 && !m.has(pub));
    bar.className = 'cast-bar' + (driven ? ' ctl' : '') + (barOn ? '' : ' hidden');
    if (barOn) { const line = K.cast.text(K.capturable()); $('castBarText').textContent = line; $('castBarText').title = line; $('castBarStopCtl').classList.toggle('hidden', !driven); }
  }
  // --- the audience picker ------------------------------------------------------------------
  // Built when it opens and not touched by paint: the boxes must not move under the pointer. The boxes
  // themselves hold what was ticked.
  function syncPicker() {
    const boxes = [...$('castList').querySelectorAll('input')], n = boxes.filter((b) => b.checked).length, running = K.capture.state !== 'idle';
    for (const b of boxes) b.disabled = K.cast.locked(!!b.dataset.free, b.checked, n);
    $('castCount').textContent = `${n} of ${K.tune.MAX_AUDIENCE}`;
    const go = $('castGo'); go.textContent = running ? 'Update' : 'Start sharing'; go.disabled = !n && !running;
    $('castStop').classList.toggle('hidden', !running);
  }
  function openPicker() {
    const root = $('castList'); root.textContent = '';
    for (const r of K.cast.rows(S.contacts, S.current)) {
      const row = document.createElement('label'), box = document.createElement('input'), name = document.createElement('span'), st = document.createElement('span');
      row.className = 'check'; box.type = 'checkbox'; box.dataset.pub = r.pub; if (r.free) box.dataset.free = '1'; box.checked = r.ticked; box.onchange = syncPicker;
      name.textContent = r.key ? `${r.name} (key ${r.key})` : r.name; st.className = 'muted small'; st.textContent = r.state;
      row.append(box, name, st); root.appendChild(row);
    }
    $('castHint').textContent = K.capturable() ? 'This window is not hidden from screen capture here: viewers also see this list and your chats.' : '';
    syncPicker(); K.prompt('mCast');
  }
  const sessionPub = () => { const sess = pick(); return sess ? sess.pub : null; };
  // what the contact list marks: '' no session, 'out' my screen goes to them, 'both' theirs comes back as well, 'in' anything else
  // Where the viewers read this window (K.hushed) a contact my screen goes to gets no mark at all: the list would tell each of them who the others are.
  const live = (pub) => { const x = map.get(pub); return !x ? '' : !x.screenTrack ? 'in' : K.hushed() ? '' : x.remote.screen ? 'both' : 'out'; };
  K.paint = render;
  K.paintStats = (sess) => { if (K.viewer.bound === sess) $('viewerStats').textContent = sess.stats; if (S.current === sess.pub) $('sharePill').title = sess.stats; };   // a session's stats line goes only where that session is on screen

  $('btnShare').onclick = () => { if (!S.current) return; const sess = cur(); if ((sess && sess.screenTrack) || K.cast.members.has(S.current)) K.cast.remove(S.current); else K.cast.add(S.current, S.settings.shareMode === 'two' ? 'two' : 'one'); };
  $('btnShareMode').onclick = (e) => { e.stopPropagation(); const m = $('shareMenu'); m.classList.toggle('hidden'); m.querySelectorAll('button[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === (S.settings.shareMode || 'one'))); };
  $('shareMenu').querySelectorAll('button[data-mode]').forEach((b) => (b.onclick = async () => { $('shareMenu').classList.add('hidden'); S.settings.shareMode = await window.api.setPref('shareMode', b.dataset.mode); render(); toast(b.dataset.mode === 'two' ? 'Two way: your contact will be asked to share their screen too' : 'One way: only your screen is sent', 'ok'); }));
  $('shareCastOpen').onclick = () => { $('shareMenu').classList.add('hidden'); openPicker(); };
  $('castBarManage').onclick = openPicker;
  $('castGo').onclick = () => { const pubs = [...$('castList').querySelectorAll('input')].filter((b) => b.checked).map((b) => b.dataset.pub); K.unprompt('mCast'); K.cast.set(pubs); };
  $('castStop').onclick = () => { K.unprompt('mCast'); K.cast.stop('user'); };
  $('castBarStop').onclick = () => K.cast.stop('user');
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
  $('btnStopCtl').onclick = $('castBarStopCtl').onclick = () => { const own = K.control.owner; if (own) K.control.endGive(own.sess, 'stopped'); };
  // the dialog belongs to the session that asked (K.control.pending), whichever chat is open
  $('controlYes').onclick = () => K.control.allow();
  $('controlNo').onclick = () => K.control.deny('denied');
  $('controlClip').onchange = () => K.viewer.labelAsk();   // the Allow button says what it allows
  // clipboard off, from either side: control stays, and the clipboard does not come back in this grant
  $('btnClip').onclick = $('viewerClip').onclick = () => { const link = K.clip.link; if (link) K.clip.off(link.sess, 'user'); };

  // debug surface for the UI tests (test/ui/share.sh, cast.sh, latency.sh): session internals and audio RTP counters
  const debug = (pub) => { const x = pick(pub); return x ? { sid: x.id, ver: x.ver, mode: x.mode, rec: !!x.rec, recFile: x.rec ? x.rec.file : null, recBytes: x.rec ? x.rec.bytes : 0, remoteRec: x.remote.rec, theater: K.viewer.theater, askedBack: x.askedBack, polite: x.polite, signaling: x.pc ? x.pc.signalingState : null, conn: x.pc ? x.pc.connectionState : null, remote: { screen: x.remote.screen, mic: x.remote.mic, mode: x.remote.mode }, in: { video: !!x.remote.video, audio: !!x.remote.audio, cast: x.remote.cast, frames: x.q ? x.q.decN || 0 : 0 }, local: { screen: !!x.screenTrack, mic: !!(x.micTrack && x.micTrack.enabled) }, path: x.path, rtt: x.rtt, codec: x.codec, q: x.q || null,
    enc: x.screenSender ? x.screenSender.getParameters().encodings[0] || null : null, limit: x.q && x.q.limit ? x.q.limit : null, clip: !!(K.clip.link && K.clip.link.sess === x && K.clip.link.id),
    ctl: { give: x.ctl.give, take: x.ctl.take, asked: x.ctl.asked, sent: x.ctl.sent, recv: x.ctl.recv, chans: x.ctl.chans.map((c) => `${c.label}:${c.readyState}`) } } : null; };
  const debugAll = () => ({ sessions: Object.fromEntries([...map.values()].map((x) => [x.pub.slice(0, 8), debug(x.pub)])),
    capture: { state: K.capture.state, leases: K.capture.leases.size }, mic: { state: K.mic.state, leases: K.mic.leases.size, audienceOn: K.mic.audienceOn },
    cast: { members: Object.fromEntries([...K.cast.members].map(([pub, m]) => [pub.slice(0, 8), m.state])) },
    control: { owner: K.control.owner ? K.control.owner.sess.pub.slice(0, 8) : null, pending: K.control.pending ? K.control.pending.sess.pub.slice(0, 8) : null, taking: K.control.taking ? K.control.taking.pub.slice(0, 8) : null },
    clip: K.clip.link ? { with: K.clip.link.sess.pub.slice(0, 8), role: K.clip.link.role, on: !!K.clip.link.id, tx: K.clip.link.tx, rx: K.clip.link.rx, skipped: K.clip.link.skipped } : null,
    bound: K.viewer.bound ? K.viewer.bound.pub.slice(0, 8) : null, theater: K.viewer.theater, keysWanted: K.viewer.keysWanted });
  async function audio(pub) {
    const sess = pick(pub);
    if (!sess || !sess.pc) return null;
    const out = { in: null, out: null };
    (await sess.pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.in = { packets: r.packetsReceived, energy: r.totalAudioEnergy, level: r.audioLevel };
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.out = { packets: r.packetsSent, bytes: r.bytesSent };
    });
    return out;
  }
  window.Share = { onFrame: (ev) => K.sessions.onFrame(ev), onStatus: (ev) => K.sessions.onStatus(ev), onSettings, onFullscreen: (ev) => K.viewer.onFullscreen(ev), onControl: (ev) => K.control.onHelper(ev), onCursor: (c) => K.control.onCursor(c), onClip: (ev) => K.clip.onLocal(ev), onShown: () => K.viewer.seen(), render, end: () => { const sess = cur(); if (sess) K.sessions.end(sess); }, forget: (pub) => K.cast.forget(pub), setFull: (on) => K.viewer.setFull(on), sessionPub, live, active: () => map.size > 0, lastRecording: () => K.rec.last, debug, debugAll, audio,
    inject: (m) => (K.control.isTaking() ? K.sessions.dc(K.viewer.bound, m && m.t === 'm' ? 'move' : 'ctl', m) : false) };   // test hook: send one control message as the viewer's input would
})();
