'use strict';
// Screen share: what the viewer has on screen and hears. The one <video> their screen plays in (always
// muted), an <audio> per session for their voice, full screen, the pointer and key listeners that feed
// remote control, and the "share yours too" prompt.
//
// Reads from app.js: S, $, toast, contact, ipcErr, show, window.closeModal. Reads K.sessions and K.tune,
// and K.control.isTaking at call time.
(() => {
  const K = window.ShareKit;
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
    applyCtl();
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

  // The "share yours too" prompt belongs to the session that asked (K.viewer.backFor): its Yes shares with
  // that contact or with nobody.
  function askBack(sess) { K.viewer.backFor = sess; $('shareBackName').textContent = contact(sess.pub)?.name || 'They'; show('mShareBack'); }
  function sessionClosed(sess) {
    const a = sess.remote.audioEl;
    if (a) { a.srcObject = null; a.remove(); sess.remote.audioEl = null; }
    if (K.viewer.backFor === sess) { K.viewer.backFor = null; if (!$('mShareBack').classList.contains('hidden')) window.closeModal(); }   // the prompt names this contact: it must not outlive the session
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
  }
  async function setFull(on) {
    on = on === undefined ? !K.viewer.theater : !!on;
    if (on && !K.viewer.bound) return;
    if (on === K.viewer.theater) return;
    let got = false; try { got = await window.api.fullscreen(on); } catch (e) { toast(ipcErr(e), 'err'); }
    applyTheater(!!got);
  }
  function onFullscreen(ev) { applyTheater(!!ev.on && !!K.viewer.bound); }

  K.viewer = { bound: null, theater: false, backFor: null, rebind, audioFor, applyCtl, setFull, onFullscreen, askBack, sessionClosed };

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
  }
})();
