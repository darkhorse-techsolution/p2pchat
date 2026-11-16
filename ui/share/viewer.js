'use strict';
// Screen share: what the viewer has on screen and hears. The one <video> their screen plays in (always
// muted), an <audio> per session for their voice, where the viewer sits (in the chat or in a window of
// its own), its toolbar, full screen, the pointer and key listeners that feed remote control, and the
// two prompts a share can open (control of my screen, "share yours too").
//
// Reads from app.js: S, $, toast, contact, ipcErr, prettyHotkey. Reads K.sessions, K.tune, K.control, K.clip,
// K.prompt, K.unprompt, K.hotkeyOf and K.paint at call time.
(() => {
  const K = window.ShareKit, el = K.el;
  // every element of the viewer, looked up once while it is in this page (K.el keeps it)
  for (const id of ['viewer', 'viewerVideo', 'viewerCaptions', 'viewerTab', 'viewerBar', 'viewerName', 'viewerStats', 'viewerAud', 'viewerMute', 'viewerTalk', 'viewerShareBack', 'viewerCtl', 'viewerClip', 'viewerRec', 'viewerStopCtl', 'viewerPop', 'viewerFull', 'viewerEnd', 'viewerFold']) el(id);
  // share/control.js loads before this file, so every listener below finds K.control
  const taking = () => (K.control.isTaking() ? K.viewer.bound : null);   // the session whose screen I drive right now, or null

  // --- where the viewer is ----------------------------------------------------------------------
  // In the chat, above the messages, or in a window of its own (the setting viewerWindow, switched by
  // the ⧉ button). That window is an about:blank window this page opens. The whole section is moved into
  // its document, listeners and all, and moved back when the window goes. The connection, the sessions
  // and every handler stay in this page: only the elements are over there. Main keeps the window itself:
  // its place on the screen, hiding and showing it with the chat, and its full screen.
  let pop = null;                                    // { win, doc, toasts } while that window is open
  const own = () => !!(S.settings && S.settings.viewerWindow);
  const stageDoc = () => (pop ? pop.doc : document);
  const stageWin = () => (pop ? pop.win : window);
  const replay = () => { const v = el('viewerVideo'); if (v.srcObject) v.play().catch(() => {}); armTick(); };   // a video that changed documents starts its stream anew
  function openOwn() {
    let w = null;
    try { w = window.open('about:blank', 'p2p-viewer', 'popup'); } catch {}
    if (!w || !w.document || !w.document.body) return false;
    const d = w.document;
    d.documentElement.dataset.theme = document.documentElement.dataset.theme || 'dark';
    for (const l of document.querySelectorAll('link[rel="stylesheet"]')) { const c = d.createElement('link'); c.rel = 'stylesheet'; c.href = l.href; d.head.appendChild(c); }
    d.body.className = 'viewer-win';
    const toasts = d.createElement('div'); toasts.className = 'toasts'; d.body.appendChild(toasts);
    if (K.viewer.theater) leaveFull();
    d.body.appendChild(el('viewer'));
    pop = { win: w, doc: d, toasts };
    wire(d, w);
    replay();
    return true;
  }
  function closeOwn() {
    const p = pop;
    if (!p) return;
    if (K.viewer.theater) leaveFull();
    pop = null;
    const away = $('viewerAway');
    away.parentNode.insertBefore(el('viewer'), away);   // back where it was in the chat
    window.api.viewerClose().catch(() => {});
    replay();
  }
  // The window went without this page asking for it (main closed it, or the system did). Its document is dead;
  // the section, still this page's own elements, is taken back into the chat. The paint that noticed goes on
  // from there and opens a new window if that is still the setting.
  function lost() {
    if (!pop) return;
    pop = null;
    if (K.viewer.theater) applyTheater(false);
    const away = $('viewerAway');
    away.parentNode.insertBefore(el('viewer'), away);
    bindAll();                                        // the dead window took every listener off these elements
    replay();
  }
  // full screen ends here and now, without waiting for main: what holds the viewer is about to change
  function leaveFull() { applyTheater(false); window.api.fullscreen(false).catch(() => {}); }
  // the ⧉ button, the placeholder's "Back into the chat", and the window's own close button (main says so)
  function setOwn(on) {
    on = !!on;
    if (on === own()) return;
    S.settings.viewerWindow = on;                    // at once: the paint below puts the viewer where it belongs
    window.api.setPref('viewerWindow', on).catch(() => {});
    K.paint();
  }
  function onWindow(ev) { if (ev && ev.op === 'close' && pop) setOwn(false); else if (ev && ev.op === 'gone') K.paint(); }
  // what the app says is read in that window as well: the chat can be behind it
  function echo(text, cls) {
    if (!pop) return;
    const t = pop.doc.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = text; pop.toasts.appendChild(t);
    setTimeout(() => t.remove(), 3800);
  }

  // --- the video and the sound ---------------------------------------------------------------
  // First thing in every paint: which session the one <video> shows (K.viewer.bound: the session of the
  // open chat while they share a screen, else none; a window of its own keeps the one it has), and where
  // the viewer sits. Nothing else assigns the video's source; its `ctl` class and its pointer are set by
  // applyCtl alone.
  function rebind() {
    if (pop && pop.win.closed) lost();
    const here = K.sessions.get(S.current), prev = K.viewer.bound;
    let next = here && here.remote.screen ? here : null;
    // A window of its own keeps the screen it shows while a chat without one is open; a chat with a share takes it over.
    if (!next && own() && prev && !prev.closed && prev.remote.screen) next = prev;
    if (next !== prev) {
      if (prev && !prev.closed && prev.ctl.take) K.sessions.dc(prev, 'ctl', { t: 'r' });   // nothing stays pressed on a screen I stopped looking at
      K.viewer.bound = next;
    }
    if (K.viewer.theater && !next) setFull(false);         // the watched share went away: full screen goes with it
    // where it is shown: its own window exists only while there is a screen to show in it
    if (next && own() && !pop) { if (!openOwn()) { S.settings.viewerWindow = false; window.api.setPref('viewerWindow', false).catch(() => {}); toast('A window for their screen could not be opened: it stays in the chat', 'err'); } }
    else if (pop && !(next && own())) closeOwn();
    if (pop && next) { const title = `${K.nameOf(next.pub)}'s screen`; if (pop.doc.title !== title) pop.doc.title = title; }
    const v = el('viewerVideo'), view = next ? next.remote.view : null;
    v.muted = true;                                        // their voice plays from the session's <audio>
    if (v.srcObject !== view) { v.srcObject = view; if (view) v.play().catch(() => {}); }
    applyCtl(); syncKeys();
    if (K.caption) K.caption.sync();   // captions follow the share on screen
  }
  // Their voice has an element of the session's own: it is heard whichever chat is open, and the video
  // never carries sound.
  function audioFor(sess) {
    let a = sess.remote.audioEl;
    if (!a) { a = sess.remote.audioEl = document.createElement('audio'); a.autoplay = true; a.dataset.pub = sess.pub; $('shareAudio').appendChild(a); }
    a.srcObject = new MediaStream([sess.remote.audio]); a.muted = sess.muted; a.play().catch(() => {});
    if (K.caption) K.caption.sync();   // the voice just arrived for a watched share: captions can start
  }
  // the video takes my pointer and keys only while I drive the session it shows
  function applyCtl() {
    const v = el('viewerVideo'), on = !!K.control.isTaking(), was = v.classList.contains('ctl');
    v.classList.toggle('ctl', on); v.style.cursor = on ? K.viewer.bound.ctl.cursor || '' : '';
    if (on && !was) { v.addEventListener(K.tune.MOVE_EV, onMove); v.focus(); }
    if (!on && was) v.removeEventListener(K.tune.MOVE_EV, onMove);
  }

  // In full screen, while I drive the screen it shows, the keys this app would act on itself (its menu
  // shortcuts, the opacity keys) belong to that screen as well: main is told when that begins and when it
  // ends (K.viewer.keysWanted), and the key listeners below send them on like any other key. Asked again
  // wherever one of the two can change: full screen, control, the session on screen.
  // keysWanted is what was asked until main answers, and from then on what main answered. Main says no
  // while the window is not in full screen yet (elsewhere than on macOS that comes a moment after it was
  // asked for); it reports when the window is there, and the question is then put again.
  //
  // The keys the operating system keeps for itself (the Windows key, Alt+Tab, ⌘Tab) go over as well, for as
  // long as main says yes. On Windows and Linux that is Chromium's keyboard lock, asked for here: it holds
  // while the document is in full screen through the Fullscreen API, which is how main asks for full
  // screen there. On macOS Chromium has no such lock, and main runs a key grab of its own (main/keygrab.js)
  // whose keys arrive in onGrabKey. This app's three hotkeys stay this machine's either way.
  let keysTurn = 0, locked = false, tipped = false;
  // said once, when the system keys first go over: that they do, and the way out
  function tip() {
    if (tipped) return;
    tipped = true;
    toast(`Every key goes to their screen now, the system keys too. ${typeof prettyHotkey === 'function' && S.settings.fullHotkey ? prettyHotkey(S.settings.fullHotkey) : 'The full-screen hotkey'} leaves full screen. The small tab at the top is the toolbar.`, 'ok');
  }
  function lockKeys(on) {
    const nav = stageWin().navigator, kb = nav && nav.keyboard;
    if (!kb || typeof kb.lock !== 'function' || window.api.platform === 'darwin') return;
    if (on) kb.lock().then(() => { locked = K.viewer.keysWanted; if (locked) tip(); else kb.unlock(); }, () => { locked = false; });
    else { locked = false; try { kb.unlock(); } catch {} }
  }
  function syncKeys() {
    const want = K.viewer.theater && !!K.control.isTaking();
    if (want === K.viewer.keysWanted) return;
    K.viewer.keysWanted = want;
    const turn = ++keysTurn, heard = (got) => { if (turn !== keysTurn) return; K.viewer.keysWanted = !!got; lockKeys(!!got); };   // only the answer to the latest question counts
    if (!want) lockKeys(false);
    window.api.keysRemote(want).then(heard, () => heard(false));
  }
  // macOS: one key from main's grab, as the DOM would have named it; `r` when a hotkey of this app went by
  function onGrabKey(ev) {
    const sess = keysGoRemote();
    if (!sess || !ev) return;
    if (ev.r) K.sessions.dc(sess, 'ctl', { t: 'r' });
    else if (typeof ev.c === 'string') K.sessions.dc(sess, 'ctl', ev.rep ? { t: 'k', c: ev.c, d: 1, rep: 1 } : { t: 'k', c: ev.c, d: ev.d ? 1 : 0 });
  }

  // The "share yours too" prompt belongs to the session that asked (K.viewer.backFor): its Yes shares with
  // that contact or with nobody. It never takes the place of a prompt that is up: not of another contact's
  // (a click meant for that one would share with this one), not of the control dialog, not of the picker,
  // and not while a control request is open at all. The session may then ask again with its next state frame.
  // Its Yes takes no click for a moment after it opens, like Allow, and the keyboard starts on "Just watch".
  let armingBack = null;
  function armBack() {
    const yes = $('shareBackYes'), sess = K.viewer.backFor;
    yes.disabled = true; clearTimeout(armingBack); armingBack = setTimeout(() => { yes.disabled = false; }, K.ARM_MS);
    setTimeout(() => { if (sess && K.viewer.backFor === sess && !$('mShareBack').classList.contains('hidden')) $('shareBackNo').focus(); }, 60);
  }
  function askBack(sess) {
    const up = (id) => !$(id).classList.contains('hidden');
    if (up('mShareBack') || up('mControl') || up('mCast') || K.control.pending) { sess.askedBack = false; return; }
    K.viewer.backFor = sess; $('shareBackName').textContent = contact(sess.pub)?.name || 'They';
    armBack();
    K.prompt('mShareBack');
  }
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
  function seen() {
    if (K.control.pending && !$('mControl').classList.contains('hidden')) arm();
    if (K.viewer.backFor && !$('mShareBack').classList.contains('hidden')) armBack();
  }
  function sessionClosed(sess) {
    const a = sess.remote.audioEl;
    if (a) { a.srcObject = null; a.remove(); sess.remote.audioEl = null; }
    if (K.viewer.backFor === sess) { K.viewer.backFor = null; K.unprompt('mShareBack'); }   // the prompt names this contact: it must not outlive the session
    if (K.viewer.bound === sess) K.viewer.bound = null;    // the paint that ends every close takes the video and full screen down
    if (K.caption) K.caption.sync();
  }

  // where on their display the pointer is: fractions of the video picture (object-fit: contain leaves bars)
  function at(e) {
    const v = el('viewerVideo'), r = v.getBoundingClientRect();
    const vw = v.videoWidth || r.width || 1, vh = v.videoHeight || r.height || 1;
    const k = Math.min(r.width / vw, r.height / vh) || 1, cw = vw * k, ch = vh * k;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    const c = (x) => Math.min(1, Math.max(0, x));
    return { x: +c((e.clientX - ox) / cw).toFixed(4), y: +c((e.clientY - oy) / ch).toFixed(4) };
  }
  const onMove = (e) => { const sess = taking(); if (sess) K.tune.sendMove(sess, { t: 'm', ...at(e) }); };
  // My keys are theirs while I drive their screen and the video has the keyboard, or the viewer fills the
  // screen. A dialog that is open in the chat holds the keys only while the viewer is in the chat too.
  const keysGoRemote = () => ((stageDoc().activeElement === el('viewerVideo') || K.viewer.theater) && (!!pop || $('backdrop').classList.contains('hidden')) ? taking() : null);

  // --- the toolbar in full screen ---------------------------------------------------------------
  // In full screen the bar is a small toolbar at the top (ui/app.css) that folds into a tab by itself, so
  // that nothing of this app lies over their picture for longer than it is used: a bar along the bottom
  // took the clicks meant for their Dock or taskbar. The tab can be dragged sideways out of the way.
  let foldTimer = null;
  function fold(on) { clearTimeout(foldTimer); foldTimer = null; el('viewer').classList.toggle('folded', !!on); }
  function foldSoon(ms) { clearTimeout(foldTimer); foldTimer = setTimeout(() => { foldTimer = null; if (K.viewer.theater) fold(true); }, ms); }

  // --- full screen ----------------------------------------------------------------------
  // The window that holds the viewer goes full screen (main: simple fullscreen on macOS, the page's
  // Fullscreen API elsewhere) and the viewer covers it. Esc, the button or a double-click leave.
  function applyTheater(on) {
    const was = K.viewer.theater;
    K.viewer.theater = !!on; stageDoc().body.classList.toggle('theater', K.viewer.theater);
    const b = el('viewerFull'); b.textContent = K.viewer.theater ? '⤡' : '⤢'; b.title = K.viewer.theater ? 'Leave full screen (Esc)' : 'Full screen (Esc leaves, unless you are controlling their screen)';
    if (K.viewer.theater && !was) { fold(false); foldSoon(3500); } else if (!K.viewer.theater) fold(false);
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

  // per shown frame: last packet in -> on screen, and the sharer's capture stamp -> on screen. Armed anew
  // when the video changes documents: a callback that was waiting in the old one does not come.
  let tickGen = 0;
  function armTick() {
    const v = el('viewerVideo'), gen = ++tickGen;
    const tick = (_t, md) => {
      if (gen !== tickGen) return;
      const sess = K.viewer.bound;
      if (sess && typeof md.receiveTime === 'number') {
        const f = sess.pic || (sess.pic = { n: 0, show: 0, c: 0, e2e: 0, worst: 0 });
        f.n++; f.show += md.expectedDisplayTime - md.receiveTime;
        if (typeof md.captureTime === 'number') { const e = md.expectedDisplayTime - md.captureTime; f.c++; f.e2e += e; if (e > f.worst) f.worst = e; }
      }
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
  }
  const keysDown = new Set();   // the keys whose way down went over: only their way up follows
  function onKey(e, doc) {
    if (stageDoc() !== doc) return;                        // the keys of the chat are the chat's while the viewer is in a window of its own
    const sess = keysGoRemote();
    if (!sess) return;
    e.preventDefault(); e.stopPropagation();
    // A held key repeats over there as it does here, so its repeats go over too: macOS and Windows make none
    // for a key a program put in (a Linux sharer's X server does, and its side leaves these out). Not for the
    // modifiers: held, they are one press.
    const rep = !!e.repeat;
    if (rep && (e.type !== 'keydown' || /^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)/.test(e.code))) return;
    // This app's own hotkeys are this machine's, never theirs. Where the page holds the whole keyboard (full
    // screen, their screen driven) the OS did not act on the combination, so it is picked out here and main
    // runs it. Where the OS did act on it, the key that completed it can still arrive here (seen on Linux):
    // it is not sent on either, and main takes the second word for the same press as one (its `fire`).
    // What went over of the combination so far, the modifiers, is let go over there.
    if (e.type === 'keydown' && !rep) { const kind = K.hotkeyOf(e); if (kind) { keysDown.clear(); K.sessions.dc(sess, 'ctl', { t: 'r' }); window.api.runHotkey(kind).catch(() => {}); return; } }
    // a key that comes up without having gone over on its way down (the rest of a hotkey, a key held since before) is not theirs
    if (e.type === 'keydown') keysDown.add(e.code); else if (!keysDown.delete(e.code)) return;
    K.sessions.dc(sess, 'ctl', rep ? { t: 'k', c: e.code, d: 1, rep: 1 } : { t: 'k', c: e.code, d: e.type === 'keydown' ? 1 : 0 });
  }
  // the key and focus listeners of a document that holds the viewer: this page, and the viewer's own window while it is open
  function wire(doc, win) {
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && K.viewer.theater && stageDoc() === doc && !keysGoRemote()) { e.stopPropagation(); setFull(false); } }, true);
    doc.addEventListener('keydown', (e) => onKey(e, doc), true); doc.addEventListener('keyup', (e) => onKey(e, doc), true);
    win.addEventListener('blur', () => { if (stageWin() !== win) return; keysDown.clear(); const sess = taking(); if (sess) K.sessions.dc(sess, 'ctl', { t: 'r' }); });   // nothing stays pressed over there when the viewer's window loses the keyboard
    win.addEventListener('focus', () => { seen(); K.clip.poke(); });   // back in this window: what I copied elsewhere meanwhile is looked at once
  }

  K.viewer = { bound: null, theater: false, backFor: null, keysWanted: false, syncKeys, rebind, audioFor, applyCtl, setFull, onFullscreen, askBack, showAsk, labelAsk, clipTicked, clipNote, clipLabel, seen, sessionClosed,
    away: () => !!pop, setOwn, onWindow, echo, onGrabKey, tip, fold, themed: (t) => { if (pop) pop.doc.documentElement.dataset.theme = t; }, locked: () => locked };

  // Every listener on the viewer's own elements is put on by a binder, and the binders can run again. When a
  // window is destroyed with the section inside (the system kills it, main has to close it), Chromium takes
  // every listener and every on-handler off those elements. The elements and the video stream survive, so
  // lost() brings them back and binds them anew. A second run first takes off what the run before put on.
  const binders = []; let unbind = null, opt = (o = {}) => o;
  function bindAll() {
    if (unbind) unbind.abort();
    unbind = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = unbind && unbind.signal;
    opt = (o = {}) => (signal ? { ...o, signal } : o);
    for (const f of binders) f();
  }
  binders.push(() => {
    const v = el('viewerVideo');
    el('viewerFull').onclick = () => setFull();
    el('viewerPop').onclick = () => setOwn(!own());
    v.ondblclick = () => { if (!taking()) setFull(); };   // while controlling, two clicks are theirs
    v.addEventListener('pointerdown', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); v.focus(); try { v.setPointerCapture(e.pointerId); } catch {} const p = at(e); sess.ctl.move = null; K.sessions.dc(sess, 'ctl', { t: 'm', ...p }); K.sessions.dc(sess, 'ctl', { t: 'b', b: e.button, d: 1, ...p }); }, opt());
    v.addEventListener('pointerup', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); K.sessions.dc(sess, 'ctl', { t: 'b', b: e.button, d: 0, ...at(e) }); }, opt());
    v.addEventListener('wheel', (e) => { const sess = taking(); if (!sess) return; e.preventDefault(); const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; K.sessions.dc(sess, 'ctl', { t: 'w', dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...at(e) }); }, opt({ passive: false }));
    v.addEventListener('contextmenu', (e) => { if (taking()) e.preventDefault(); }, opt());
    v.addEventListener('pointerenter', () => K.clip.poke(), opt());
    if (v.classList.contains('ctl')) { v.removeEventListener(K.tune.MOVE_EV, onMove); v.addEventListener(K.tune.MOVE_EV, onMove); }   // applyCtl put it on while I drive their screen: back on, once
    // the tab: a click opens the toolbar, a drag moves the tab along the top edge
    const tab = el('viewerTab'), box = el('viewer'), bar = el('viewerBar'); let drag = null;
    tab.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, moved: false }; try { tab.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); }, opt());
    tab.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
      if (drag.moved) { const r = box.getBoundingClientRect(); box.style.setProperty('--tab-x', `${Math.round(Math.min(r.width - 30, Math.max(30, e.clientX - r.left)))}px`); }
    }, opt());
    tab.addEventListener('pointerup', () => { const d = drag; drag = null; if (d && !d.moved) { fold(false); foldSoon(4000); } }, opt());
    tab.addEventListener('pointercancel', () => { drag = null; }, opt());
    el('viewerFold').onclick = () => fold(true);
    bar.addEventListener('pointerenter', () => { clearTimeout(foldTimer); foldTimer = null; }, opt());
    bar.addEventListener('pointerleave', () => { if (K.viewer.theater) foldSoon(1800); }, opt());
  });
  // share.js hangs the bar's buttons on through this, so that they come back with the rest
  K.viewer.bind = (f) => { binders.push(f); f(); };
  bindAll();
  wire(document, window);
  armTick();
})();
