'use strict';
// Screen share: what the viewer has on screen. The one <video> their screen plays in, full screen,
// the pointer and key listeners that feed remote control, and the "share yours too" prompt.
//
// Reads from app.js: S, $, toast, contact, ipcErr, show, window.closeModal. Reads K.sessions and K.tune,
// and K.control.isTaking at call time.
(() => {
  const K = window.ShareKit;
  const map = K.sessions.map;
  const cur = () => map.get(S.current) || null;                                             // the session of the open chat
  const pick = (pub) => map.get(pub) || cur() || map.values().next().value || null;         // ... else the oldest
  const taking = () => (K.control.isTaking() ? pick() : null);   // the session whose screen I drive right now, or null

  function attachRemote(sess) {
    const v = $('viewerVideo');
    if (sess.remote.stream && v.srcObject !== sess.remote.stream) { v.srcObject = sess.remote.stream; v.muted = sess.muted; v.play().catch(() => {}); }
  }

  // The "share yours too" prompt belongs to the session that asked (K.viewer.backFor): its Yes shares with
  // that contact or with nobody.
  function askBack(sess) { K.viewer.backFor = sess; $('shareBackName').textContent = contact(sess.pub)?.name || 'They'; show('mShareBack'); }
  function sessionClosed(sess) {
    if (K.viewer.backFor === sess) { K.viewer.backFor = null; if (!$('mShareBack').classList.contains('hidden')) window.closeModal(); }   // the prompt names this contact: it must not outlive the session
    const v = $('viewerVideo'); v.srcObject = null;
    if (K.viewer.theater) setFull(false);
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
    const sess = pick();
    if (on && !(sess && sess.remote.screen)) return;
    if (on === K.viewer.theater) return;
    let got = false; try { got = await window.api.fullscreen(on); } catch (e) { toast(ipcErr(e), 'err'); }
    applyTheater(!!got);
  }
  function onFullscreen(ev) { const sess = pick(); applyTheater(!!ev.on && !!(sess && sess.remote.screen)); }

  K.viewer = { theater: false, backFor: null, attachRemote, onMove, setFull, onFullscreen, askBack, sessionClosed };

  $('viewerFull').onclick = () => setFull();
  $('viewerVideo').ondblclick = () => { if (!taking()) setFull(); };   // while controlling, two clicks are theirs
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && K.viewer.theater && !keysGoRemote()) { e.stopPropagation(); setFull(false); } }, true);
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
    v.addEventListener('pointerdown', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); v.focus(); try { v.setPointerCapture(e.pointerId); } catch {} const p = at(e); sess.ctl.move = null; K.sessions.dc(sess, 'ctl', { t: 'm', ...p }); K.sessions.dc(sess, 'ctl', { t: 'b', b: e.button, d: 1, ...p }); });
    v.addEventListener('pointerup', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); K.sessions.dc(sess, 'ctl', { t: 'b', b: e.button, d: 0, ...at(e) }); });
    v.addEventListener('wheel', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; K.sessions.dc(sess, 'ctl', { t: 'w', dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...at(e) }); }, { passive: false });
    v.addEventListener('contextmenu', (e) => { if (taking()) e.preventDefault(); });
    const onKey = (e) => { const sess = keysGoRemote(); if (!sess) return; e.preventDefault(); e.stopPropagation(); if (e.repeat) return; K.sessions.dc(sess, 'ctl', { t: 'k', c: e.code, d: e.type === 'keydown' ? 1 : 0 }); };
    document.addEventListener('keydown', onKey, true); document.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', () => { const sess = taking(); if (sess) K.sessions.dc(sess, 'ctl', { t: 'r' }); });   // nothing stays pressed over there when this window loses the keyboard
  }
})();
