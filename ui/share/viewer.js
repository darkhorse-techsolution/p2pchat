'use strict';
// Screen share: what the viewer has on screen and hears. The one <video> their screen plays in (always
// muted), an <audio> per session for their voice, full screen, the pointer and key listeners that feed
// remote control, and the two prompts a share can open (control of my screen, "share yours too").
//
// Reads from app.js: S, $, toast, contact, ipcErr. Reads K.sessions, K.tune, K.control, K.clip, K.prompt,
// K.unprompt and K.paint at call time.
(() => {
  const K = window.ShareKit;
  // share/control.js loads before this file, so every listener below finds K.control
  const taking = () => (K.control.isTaking() ? K.viewer.bound : null);   // the session whose screen I drive right now, or null

  // --- the video and the sound ---------------------------------------------------------------
  // First thing in every paint: which session the one <video> shows (K.viewer.bound: the session of the
  // open chat while they share a screen, else none). Nothing else assigns the video's source; its `ctl`
  // class and its pointer are set by applyCtl alone.
  function rebind() {
    const here = K.sessions.get(S.current), next = here && here.remote.screen ? here : null, prev = K.viewer.bound;
    if (next !== prev) {
      if (prev && !prev.closed && prev.ctl.take) K.sessions.dc(prev, 'ctl', { t: 'r' });   // nothing stays pressed on a screen I stopped looking at
      K.viewer.bound = next;
    }
    if (K.viewer.theater && !next) setFull(false);         // the watched share went away: full screen goes with it
    const v = $('viewerVideo'), view = next ? next.remote.view : null;
    v.muted = true;                                        // their voice plays from the session's <audio>
    if (v.srcObject !== view) { v.srcObject = view; if (view) v.play().catch(() => {}); }
    applyCtl(); syncKeys();
  }
  // Their voice has an element of the session's own: it is heard whichever chat is open, and the video
  // never carries sound.
  function audioFor(sess) {
    let a = sess.remote.audioEl;
    if (!a) { a = sess.remote.audioEl = document.createElement('audio'); a.autoplay = true; a.dataset.pub = sess.pub; $('shareAudio').appendChild(a); }
    a.srcObject = new MediaStream([sess.remote.audio]); a.muted = sess.muted; a.play().catch(() => {});
  }
  // the video takes my pointer and keys only while I drive the session it shows
  function applyCtl() {
    const v = $('viewerVideo'), on = !!K.control.isTaking(), was = v.classList.contains('ctl');
    v.classList.toggle('ctl', on); v.style.cursor = on ? K.viewer.bound.ctl.cursor || '' : '';
    if (on && !was) { v.addEventListener(K.tune.MOVE_EV, onMove); v.focus(); }
    if (!on && was) v.removeEventListener(K.tune.MOVE_EV, onMove);
  }

  // In full screen, while I drive the screen it shows, the keys this app would act on itself (its menu
  // shortcuts, the opacity keys) belong to that screen as well: main is told when that begins and when it
  // ends (K.viewer.keysWanted), and the key listeners below send them on like any other key. Asked again
  // wherever one of the two can change: full screen, control, the session on screen.
  function syncKeys() {
    const want = K.viewer.theater && !!K.control.isTaking();
    if (want === K.viewer.keysWanted) return;
    K.viewer.keysWanted = want;
    window.api.keysRemote(want).catch(() => {});
  }

  // The "share yours too" prompt belongs to the session that asked (K.viewer.backFor): its Yes shares with
  // that contact or with nobody.
  function askBack(sess) { K.viewer.backFor = sess; $('shareBackName').textContent = contact(sess.pub)?.name || 'They'; K.prompt('mShareBack'); }
  // The control dialog belongs to the session that asked, whichever chat is open. It names the contact
  // and the key, opens with the keyboard on Deny and takes no click on Allow for a moment: a dialog that
  // comes up under a click or a key press meant for something else must not be answered by it.
  let arming = null;
  function arm() {
    const yes = $('controlYes'), p = K.control.pending;
    yes.disabled = true; clearTimeout(arming); arming = setTimeout(() => { yes.disabled = false; }, K.ARM_MS);
    setTimeout(() => { if (p && K.control.pending === p && !$('mControl').classList.contains('hidden')) $('controlNo').focus(); }, 60);
  }
  // With `clip` the dialog also offers to share clipboard text with them, ticked, and the Allow button
  // says so; without it a line says why the clipboard stays out of it.
  let askClip = false;
  const labelAsk = () => { $('controlYes').textContent = askClip && $('controlClip').checked ? 'Allow control and clipboard' : 'Allow control'; };
  const clipTicked = () => askClip && !!$('controlClip').checked;
  function showAsk(sess, o) {
    const c = contact(sess.pub), name = K.nameOf(sess.pub), why = o && o.why;
    askClip = !!(o && o.clip);
    $('controlName').textContent = name;
    $('controlWho').textContent = `(${c && c.verified ? 'verified' : 'not verified'}, key ${sess.pub.slice(0, 8)})`;
    $('controlClipRow').classList.toggle('hidden', !askClip); $('controlClip').checked = true; $('controlClipName').textContent = name;
    $('controlClipNote').classList.toggle('hidden', askClip);
    $('controlClipNote').textContent = askClip ? '' : why === 'off' ? 'Clipboard is not shared: it is switched off in your Settings.' : why === 'busy' ? 'Clipboard is not shared: it is already shared in another session.' : `Clipboard is not shared: ${name}'s app did not offer it (older version, or switched off in their Settings).`;
    labelAsk();
    arm();
    K.prompt('mControl');
  }
  // A copy that could not be shared (main says which kind): the clipboard buttons say so for a moment,
  // because a toast sits under the full-screen viewer, and one toast says why.
  let noted = '', noteTimer = null;
  const clipLabel = () => (noted === 'big' ? '📋 Too large' : noted ? '📋 Not shared' : '📋 Shared');
  function clipNote(kind) {
    noted = kind; clearTimeout(noteTimer); noteTimer = setTimeout(() => { noted = ''; K.paint(); }, 3000);
    toast(kind === 'big' ? 'Copied text is larger than 64 KB: not shared' : 'That copied text cannot be shared', 'err');
  }
  // The moment that counts is when the dialog can be seen, not when the request came: one that arrived
  // while the window was hidden or in the background is disarmed anew, with the keyboard back on Deny,
  // when the window is shown or gets the focus.
  function seen() { if (K.control.pending && !$('mControl').classList.contains('hidden')) arm(); }
  function sessionClosed(sess) {
    const a = sess.remote.audioEl;
    if (a) { a.srcObject = null; a.remove(); sess.remote.audioEl = null; }
    if (K.viewer.backFor === sess) { K.viewer.backFor = null; K.unprompt('mShareBack'); }   // the prompt names this contact: it must not outlive the session
    if (K.viewer.bound === sess) K.viewer.bound = null;    // the paint that ends every close takes the video and full screen down
  }

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
  const keysGoRemote = () => ((document.activeElement === $('viewerVideo') || K.viewer.theater) && $('backdrop').classList.contains('hidden') ? taking() : null);

  // --- full screen ----------------------------------------------------------------------
  // The window itself goes full screen (main: simple fullscreen on macOS, setFullScreen
  // elsewhere) and the viewer covers the page. Esc, the button or a double-click leave.
  function applyTheater(on) {
    K.viewer.theater = !!on; document.body.classList.toggle('theater', K.viewer.theater);
    const b = $('viewerFull'); b.textContent = K.viewer.theater ? '⤡' : '⤢'; b.title = K.viewer.theater ? 'Leave full screen (Esc)' : 'Full screen (Esc leaves, unless you are controlling their screen)';
    syncKeys();
  }
  async function setFull(on) {
    on = on === undefined ? !K.viewer.theater : !!on;
    if (on && !K.viewer.bound) return;
    if (on === K.viewer.theater) return;
    if (!on) applyTheater(false);                          // off shows at once: what opens next (a prompt) must not sit under the viewer while main answers
    let got = false; try { got = await window.api.fullscreen(on); } catch (e) { toast(ipcErr(e), 'err'); }
    applyTheater(!!got);
    if (K.viewer.theater && !K.viewer.bound) setFull(false);   // the share ended while main was switching: nothing is left to fill the screen
  }
  function onFullscreen(ev) { applyTheater(!!ev.on && !!K.viewer.bound); }

  K.viewer = { bound: null, theater: false, backFor: null, keysWanted: false, syncKeys, rebind, audioFor, applyCtl, setFull, onFullscreen, askBack, showAsk, labelAsk, clipTicked, clipNote, clipLabel, seen, sessionClosed };

  $('viewerFull').onclick = () => setFull();
  $('viewerVideo').ondblclick = () => { if (!taking()) setFull(); };   // while controlling, two clicks are theirs
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && K.viewer.theater && !keysGoRemote()) { e.stopPropagation(); setFull(false); } }, true);
  {
    const v = $('viewerVideo');
    const tick = (_t, md) => {   // per shown frame: last packet in -> on screen, and the sharer's capture stamp -> on screen
      const sess = K.viewer.bound;
      if (sess && typeof md.receiveTime === 'number') {
        const f = sess.pic || (sess.pic = { n: 0, show: 0, c: 0, e2e: 0, worst: 0 });
        f.n++; f.show += md.expectedDisplayTime - md.receiveTime;
        if (typeof md.captureTime === 'number') { const e = md.expectedDisplayTime - md.captureTime; f.c++; f.e2e += e; if (e > f.worst) f.worst = e; }
      }
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
    v.addEventListener('pointerdown', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); v.focus(); try { v.setPointerCapture(e.pointerId); } catch {} const p = at(e); sess.ctl.move = null; K.sessions.dc(sess, 'ctl', { t: 'm', ...p }); K.sessions.dc(sess, 'ctl', { t: 'b', b: e.button, d: 1, ...p }); });
    v.addEventListener('pointerup', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); K.sessions.dc(sess, 'ctl', { t: 'b', b: e.button, d: 0, ...at(e) }); });
    v.addEventListener('wheel', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; K.sessions.dc(sess, 'ctl', { t: 'w', dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...at(e) }); }, { passive: false });
    v.addEventListener('contextmenu', (e) => { if (taking()) e.preventDefault(); });
    const onKey = (e) => { const sess = keysGoRemote(); if (!sess) return; e.preventDefault(); e.stopPropagation(); if (e.repeat) return; K.sessions.dc(sess, 'ctl', { t: 'k', c: e.code, d: e.type === 'keydown' ? 1 : 0 }); };
    document.addEventListener('keydown', onKey, true); document.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', () => { const sess = taking(); if (sess) K.sessions.dc(sess, 'ctl', { t: 'r' }); });   // nothing stays pressed over there when this window loses the keyboard
    window.addEventListener('focus', () => { seen(); K.clip.poke(); });   // back in this window: what I copied elsewhere meanwhile is looked at once
    v.addEventListener('pointerenter', () => K.clip.poke());
  }
})();
