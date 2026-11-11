'use strict';
// Screen share: remote control, both roles. A viewer can ask to drive the sharer's mouse and keyboard;
// the sharer answers a dialog and can stop it at any moment. The events ride the share's data channels
// and the sharer's page hands them to the main process (main/input.js posts them to the OS).
//
// One contact at a time drives this machine, and that is held twice. Here: K.control.owner, taken before
// main is asked, so that nothing else is answered or allowed while the grant is on its way. In main: the
// grant and its token (main/grant.js), which every input event has to carry. `pending` is the one
// request whose dialog is open; `taking` the one session whose screen I drive.
// Control ends in two functions and nowhere else: endGive (my screen) and stopTaking (theirs).
//
// Reads from app.js: toast, ipcErr. Reads K.sessions, K.tune, K.cast.retier, K.viewer, K.unprompt and K.paint at call time.
(() => {
  const K = window.ShareKit;
  const C = K.control = { owner: null, pending: null, taking: null };   // owner: { sess, token } (token null while main starts the grant); pending: { sess, timer }
  const dc = (sess, msg) => K.sessions.dc(sess, 'ctl', msg);
  // When I last said no to a contact (a Deny, or a request of theirs that was taken back or ran out). By
  // contact, not by session: ending the share and coming back in a new one must not bring the dialog
  // straight up again, and a viewer that dropped out is added again without a click of mine.
  const refused = new Map();   // pub -> ms
  // What a peer can make this side say as often as it likes (a request while someone else controls, an
  // answer to a request nobody made) is said once per session in a cooldown: twenty such messages are one
  // toast. The answers to them still go out each time.
  const said = new WeakMap();   // session -> { what: ms }
  function once(sess, what, text, cls) {
    const now = Date.now(), at = said.get(sess) || {};
    if (now - (at[what] || 0) < K.DENY_COOLDOWN_MS) return;
    at[what] = now; said.set(sess, at); toast(text, cls);
  }
  const refuse = (pub) => { const now = Date.now(); for (const [k, at] of refused) if (now - at >= K.DENY_COOLDOWN_MS) refused.delete(k); refused.set(pub, now); };

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

  // one message from a session's data channels (the session checked its shape and type)
  function onMessage(sess, m) {
    const ctl = sess.ctl, name = K.nameOf(sess.pub);
    switch (m.t) {
      case 'cur':   // the shape of their pointer: drawn as my own while I control
        ctl.cursor = cursorCss(m);
        K.viewer.applyCtl();
        return;
      case 'req':   // they want my mouse and keyboard. No await between these checks and the reservation.
        if (!sess.screenTrack) { dc(sess, { t: 'ctl', on: false, why: 'notsharing' }); return; }
        if (C.owner && C.owner.sess === sess && ctl.give === 'on') { dc(sess, { t: 'ctl', on: true }); return; }
        if ((C.pending && C.pending.sess === sess) || (C.owner && C.owner.sess === sess)) return;   // its dialog is open, or its grant is being started
        if (C.owner || C.pending) { dc(sess, { t: 'ctl', on: false, why: 'busy' }); once(sess, 'busy', `${name} also asked for control`); return; }   // no second dialog: the controller's own clicks could answer it
        if (Date.now() - (refused.get(sess.pub) || 0) < K.DENY_COOLDOWN_MS) { dc(sess, { t: 'ctl', on: false }); return; }
        C.pending = { sess, timer: setTimeout(() => deny('expired'), K.tune.GIVE_ASK_MS) };
        ctl.give = 'asked';
        K.viewer.showAsk(sess); K.paint();
        return;
      case 'ctl': { // their answer about my control of their screen
        const asked = ctl.asked;
        clearTimeout(ctl.askTimer); ctl.asked = false;
        if (m.on) {
          if (ctl.take) { /* driving already */ }
          // a yes nobody is waiting for (the request ran out, their screen is gone, or it was never asked) starts nothing
          else if (!asked || !sess.remote.screen) { dc(sess, { t: 'rel' }); once(sess, 'late', `${name} allowed control after your request ran out: ask again`); }
          else { startTaking(sess); toast(`You control ${name}'s screen: click the video, then your mouse and keyboard act there (Esc and shortcuts too). Click outside the video to type here again.`, 'ok'); }
        } else {
          const was = ctl.take; stopTaking(sess);
          const why = m.why === 'accessibility' ? `${name}'s Mac has to allow P2P Chat under Accessibility first (they were shown where). Ask again once it is on.`
            : m.why === 'wayland' ? `${name}'s Linux session is Wayland: no remote control there`
            : m.why === 'helper' ? `${name}'s app could not start its input helper`
            : m.why === 'busy' ? `${name}'s screen is being controlled by someone else`
            : m.why === 'expired' ? `${name} did not answer`
            : m.why === 'notsharing' ? '' : was ? `${name} stopped your control` : `${name} did not allow control`;
          if (why && (asked || was)) toast(why, was ? '' : 'err'); else if (why) once(sess, 'no', why, 'err');   // a no to nothing: not each time
        }
        K.paint(); return;
      }
      case 'rel':   // they let go of my screen
        endGive(sess, 'released');
        return;
      case 'm': case 'b': case 'w': case 'k': case 'r':   // their input: only from the one session that owns control, with main's token
        if (C.owner && C.owner.sess === sess && C.owner.token && ctl.give === 'on' && sess.screenTrack) window.api.input(C.owner.token, m);
        return;
    }
  }

  // --- sharer: my screen ---------------------------------------------------------------
  // the dialog's Allow
  async function allow() {
    const p = C.pending;
    if (!p) return;
    clearTimeout(p.timer); C.pending = null; K.unprompt('mControl');
    const sess = p.sess, ctl = sess.ctl, name = K.nameOf(sess.pub);
    if (sess.closed || !sess.screenTrack) { ctl.give = 'off'; dc(sess, { t: 'ctl', on: false, why: 'notsharing' }); K.paint(); return; }
    const own = C.owner = { sess, token: null };   // before the await: from here on every other request is busy
    let r; try { r = await window.api.controlGrant(sess.pub); } catch (e) { r = { ok: false, reason: 'helper', message: ipcErr(e) }; }
    // The grant came back for a session that closed, stopped sending my screen or gave control up
    // meanwhile: it is handed back at once, with the token it brought.
    if (C.owner !== own || sess.closed || !sess.screenTrack) {
      if (r && r.ok) window.api.controlRevoke(r.token).catch(() => {});
      if (C.owner === own) C.owner = null;
      // unless the same contact let go and asked anew meanwhile: that request has its own dialog open, and this grant is not its answer
      if (!(C.pending && C.pending.sess === sess)) { ctl.give = 'off'; if (!sess.closed) dc(sess, { t: 'ctl', on: false, why: 'notsharing' }); }
      K.paint(); return;
    }
    if (r && r.ok) {
      own.token = ctl.token = r.token; ctl.give = 'on';
      try { sess.screenTrack.contentHint = K.tune.hint(true); } catch {}
      dc(sess, { t: 'ctl', on: true });
      toast(`${name} now uses your mouse and keyboard. ✋ Stop control next to the Sharing pill ends it.`);
      K.cast.retier();   // whoever drives gets the full frame rate, whatever the audience
    } else {
      C.owner = null; ctl.give = 'off';
      dc(sess, { t: 'ctl', on: false, why: (r && r.reason) || 'helper' });
      toast((r && r.message) || 'Control could not be allowed', 'err');
    }
    K.paint();
  }
  // the dialog's Deny ('denied'), or nobody answered it ('expired')
  function deny(why) {
    const p = C.pending;
    if (!p) return;
    if (why === 'denied') refuse(p.sess.pub);
    endGive(p.sess, why);
  }
  // Control of my screen by this session ends, whatever state it was in (asked, being granted, on):
  // Deny, the dialog ran out, ✋, they released it, the share stopped, the session closed, the helper died.
  function endGive(sess, why) {
    const ctl = sess.ctl, mine = !!C.owner && C.owner.sess === sess;
    if (C.pending && C.pending.sess === sess) {
      clearTimeout(C.pending.timer); C.pending = null; K.unprompt('mControl');
      // A request they took back, or that ran out, counts like a Deny for the cooldown: asking and letting
      // go in a row would bring the dialog up again each time, over whatever I have open.
      if (why === 'released' || why === 'expired') refuse(sess.pub);
    }
    if (ctl.give === 'off' && !mine) return;
    const was = ctl.give, token = mine ? C.owner.token : null;
    ctl.give = 'off'; ctl.token = null;
    if (mine) C.owner = null;
    if (token) window.api.controlRevoke(token).catch(() => {});   // no token yet: allow() hands the grant back when it arrives
    if (was === 'on') { try { if (sess.screenTrack) sess.screenTrack.contentHint = K.tune.hint(false); } catch {} }
    if (!sess.closed && why !== 'released') dc(sess, { t: 'ctl', on: false, why: why === 'denied' ? undefined : why === 'expired' ? 'expired' : why === 'stopped' ? 'stopped' : 'helper' });
    if (was === 'on') { toast(why === 'released' ? `${K.nameOf(sess.pub)} stopped controlling your screen` : why === 'stopped' || why === 'closed' ? 'Remote control stopped' : `Remote control stopped: ${why}`); K.cast.retier(); }
    K.paint();
  }
  // main: the input helper stopped by itself
  function onHelper(ev) { const o = C.owner; if (ev && !ev.on && o && o.token && ev.token === o.token) endGive(o.sess, ev.why || 'the input helper stopped'); }
  // main: the shape of my pointer changed; the session that drives it draws it. The picture has to fit
  // one data-channel message (main lets through more than the connection takes): one that does not is
  // left out here, where send() would throw on it, and their pointer keeps the shape it had.
  function onCursor(c) {
    const o = C.owner;
    if (!o || !o.token || !c || typeof c !== 'object' || c.token !== o.token || o.sess.ctl.give !== 'on') return;
    const m = { t: 'cur', w: c.w, h: c.h, pw: c.pw, ph: c.ph, hx: c.hx, hy: c.hy, png: c.png }, sctp = o.sess.pc && o.sess.pc.sctp;
    if (JSON.stringify(m).length > ((sctp && sctp.maxMessageSize) || K.DC_FIT)) return;   // base64 and digits: characters are bytes
    dc(o.sess, m);
  }

  // --- viewer: their screen --------------------------------------------------------------
  // ask for their mouse and keyboard, or let go
  function ask(sess) {
    const ctl = sess.ctl;
    if (!sess.remote.screen) return;
    if (ctl.take) { stopTaking(sess); dc(sess, { t: 'rel' }); toast('You no longer control their screen'); K.paint(); return; }
    if (ctl.asked) return;
    const other = C.taking;
    if (other && other !== sess) { stopTaking(other); dc(other, { t: 'rel' }); }   // one screen at a time
    if (!dc(sess, { t: 'req' })) { toast('Not connected yet: try again in a moment', 'err'); return; }
    ctl.asked = true;
    ctl.askTimer = setTimeout(() => { if (ctl.asked) { ctl.asked = false; if (!sess.closed) { toast(`${K.nameOf(sess.pub)} has not answered`); K.paint(); } } }, K.tune.ASK_MS);
    K.paint();
  }
  function startTaking(sess) {
    const ctl = sess.ctl;
    ctl.take = true; C.taking = sess; ctl.move = null; ctl.moveAt = 0;
    clearTimeout(ctl.flush); ctl.flush = null;
    K.viewer.applyCtl();
  }
  // I stop driving their screen, or stop waiting for their answer
  function stopTaking(sess) {
    const ctl = sess.ctl;
    clearTimeout(ctl.flush); ctl.flush = null; ctl.move = null;
    clearTimeout(ctl.askTimer); ctl.asked = false;
    if (ctl.take) { ctl.take = false; if (!sess.closed) dc(sess, { t: 'r' }); }   // nothing stays pressed over there
    ctl.cursor = null;
    if (C.taking === sess) C.taking = null;
    K.viewer.applyCtl();
  }
  // true while the video on screen is the screen I drive
  const isTaking = () => { const b = K.viewer.bound; return !!(b && C.taking === b && b.ctl.take && b.remote.screen); };

  // a session closes: control of either side's screen ends with it
  function sessionClosed(sess) { endGive(sess, 'closed'); stopTaking(sess); }

  Object.assign(C, { onMessage, allow, deny, endGive, onHelper, onCursor, ask, startTaking, stopTaking, isTaking, sessionClosed });
})();
