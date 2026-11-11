'use strict';
// Screen share: the clipboard link, renderer half. While a contact controls a screen and both sides
// agreed to it in that control handshake (share/control.js: ctl.giveClip on the sharer's side,
// ctl.takeClip on the viewer's), text copied on one machine is put on the other's clipboard. There is
// one link per app. It is derived from the control state and from nothing else: K.clip.sync is called
// on every change of control and starts or ends it, so it cannot outlive the control it came with.
// Off is final: the button, the Settings switch, the peer's clipoff, a closed channel or a start that
// failed clear both flags of the session, and only a new request with a new dialog sets them again.
//
// The clipboard itself is read and written in the main process only (main/clip.js), which decides
// once more whether a link may start and go on. This file moves the text between main and the `clip`
// data channel, in parts. It never shows, logs or keeps a text.
//
// Reads from app.js: S. Reads K.sessions, K.viewer and K.paint at call time.
(() => {
  const K = window.ShareKit;
  const SEND_WAIT_MS = 5000;   // a text whose next part cannot go out for this long is given up
  // link: { sess, id (null until main answers), role: 'give' | 'take', tx, rx, skipped, asm, sending }
  const clip = K.clip = { link: null };
  let texts = 0;               // every text gets a number of its own, so the parts of two are never mixed

  // A session's control changed: its link starts, stays or ends with it.
  function sync(sess) {
    const ctl = sess.ctl, give = ctl.give === 'on' && ctl.giveClip, take = ctl.take && ctl.takeClip, l = clip.link;
    const want = !sess.closed && S.settings.clipboardSync !== false && (give || take);
    if (want && !l) start(sess, give ? 'give' : 'take');
    else if (want && l.sess !== sess) off(sess, 'busy');   // another session has the one link: this one is told no, not left believing
    else if (l && l.sess === sess && (!want || (l.role === 'give' ? !give : !take))) off(sess, 'ended');
  }
  // The link exists from here on, so nothing else can start one; it carries text once main has answered.
  // The sharer's side opens the channel, in the session main is then asked about.
  async function start(sess, role) {
    const l = clip.link = { sess, id: null, role, tx: 0, rx: 0, skipped: 0, asm: null, sending: Promise.resolve() };
    if (role === 'give') { try { K.sessions.adopt(sess, sess.pc.createDataChannel('clip')); } catch { off(sess, 'failed'); return; } }
    let r; try { r = await window.api.clipStart({ pub: sess.pub, role, token: role === 'give' ? sess.ctl.token : null }); } catch { r = null; }
    if (clip.link !== l) { if (r && r.ok) window.api.clipStop(r.id).catch(() => {}); return; }   // ended while main was asked: what main started is stopped again
    if (!r || !r.ok) { off(sess, 'failed'); return; }
    l.id = r.id; K.paint();
  }
  // Clipboard off for this session, for good: both flags go, whatever the reason, and with them an offer
  // of mine that is still out in this session (a request of my own that they have not answered yet): their
  // yes to it must not bring back what was just switched off. If the link is this
  // session's it ends in main, the peer is told (unless it was the peer who said so) and the sharer's
  // side closes the channel. A session that had agreed but never got the link tells its peer as well.
  function off(sess, why) {
    const ctl = sess.ctl, l = clip.link, agreed = ctl.giveClip || ctl.takeClip, mine = !!l && l.sess === sess;
    ctl.giveClip = ctl.takeClip = ctl.askedClip = false;
    if (mine) {
      clip.link = null;
      if (l.id && why !== 'main') window.api.clipStop(l.id).catch(() => {});
      if (!sess.closed && why !== 'peer') K.sessions.dc(sess, 'ctl', { t: 'clipoff' });
      const ch = ctl.cp; ctl.cp = null;
      if (ch && l.role === 'give') { try { ch.close(); } catch {} }
    } else if (agreed && !sess.closed && why !== 'peer') K.sessions.dc(sess, 'ctl', { t: 'clipoff' });
    K.paint();
  }

  // main: a text was copied here, a copy could not be shared, or main ended the link
  function onLocal(ev) {
    const l = clip.link;
    if (!l || !l.id || !ev || ev.id !== l.id) return;
    if (ev.off) { off(l.sess, 'main'); return; }
    if (ev.note === 'big' || ev.note === 'refused') { l.skipped++; K.viewer.clipNote(ev.note); K.paint(); return; }
    if (typeof ev.text === 'string') l.sending = l.sending.then(() => sendText(l, ev.text)).catch(() => {});   // one text at a time, in the order copied
  }
  // the channel is open and has nothing queued, so the next part can go; false when the link went or it never drained
  async function clear(l) {
    const until = Date.now() + SEND_WAIT_MS;
    for (;;) {
      if (clip.link !== l || l.sess.closed) return false;
      const ch = l.sess.ctl.cp;
      if (ch && ch.readyState === 'open' && ch.bufferedAmount === 0) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  async function sendText(l, text) {
    const n = Math.max(1, Math.ceil(text.length / K.CLIP_PART));
    if (n > K.CLIP_PARTS) return;
    const id = ++texts;
    for (let i = 0; i < n; i++) {
      if (!(await clear(l))) return;
      if (!K.sessions.dc(l.sess, 'clip', { t: 'clip', id, i, n, d: text.slice(i * K.CLIP_PART, (i + 1) * K.CLIP_PART) })) return;
    }
    l.tx++; K.paint();
  }
  // One part of a text of theirs. Taken only in the session that has the link, once main has answered.
  // Part 0 starts a text; every other part has to continue the open one, in order. Anything else, or a
  // text that grows past the bound, drops what was put together so far. A whole text goes to main,
  // which checks it again before it touches the clipboard.
  function onPart(sess, m) {
    const l = clip.link, int = Number.isInteger;
    if (!l || l.sess !== sess || !l.id) return;
    if (!int(m.id) || !int(m.n) || m.n < 1 || m.n > K.CLIP_PARTS || !int(m.i) || m.i < 0 || m.i >= m.n || typeof m.d !== 'string' || m.d.length > K.CLIP_PART) { l.asm = null; return; }
    if (m.i === 0) l.asm = { id: m.id, n: m.n, next: 0, len: 0, parts: [] };
    const a = l.asm;
    if (!a || a.id !== m.id || a.n !== m.n || a.next !== m.i) { l.asm = null; return; }
    a.parts.push(m.d); a.len += m.d.length; a.next++;
    if (a.len > K.CLIP_MAX) { l.asm = null; return; }
    if (a.next < a.n) return;
    l.asm = null;
    window.api.clipApply(l.id, a.parts.join('')).then((ok) => { if (ok && clip.link === l) { l.rx++; K.paint(); } }).catch(() => {});
  }
  function channelClosed(sess) { const l = clip.link; if (l && l.sess === sess) off(sess, 'peer'); }
  // The viewer's clipboard is not read on a timer: main looks once when I come back to their screen
  // (the window gets the focus, the pointer enters the video).
  function poke() { const l = clip.link; if (l && l.id && l.role === 'take' && K.viewer.bound === l.sess) window.api.clipPoke(l.id).catch(() => {}); }

  Object.assign(clip, { sync, off, onLocal, onPart, channelClosed, poke });
})();
