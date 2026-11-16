'use strict';
// Screen share, first script: the namespace the share files hang their parts on, and the helpers
// all of them need. Each share file is one closure with no globals of its own; what another file
// needs from it sits on window.ShareKit (K) and is looked up there at call time, so the order of
// the script tags only matters for what runs while a file loads.
//
// Reads from app.js: $, S, contact, show, closeLightbox, openModal, window.closeModal. Reads K.viewer and K.cast at call time.
(() => {
  const K = window.ShareKit = {};
  K.PROTO = 2;             // sent as `v` on every share frame; a peer that sends none is 0.7.1 or older
  K.MAX_SESSIONS = 6;      // sessions at once, one per contact; an opener past it is answered with bye
  K.CONNECT_MS = 30000;    // a session that has not connected this long after its first offer is given up
  K.REJOIN_MS = 60000;     // a viewer that went offline while others still get my screen is added again by itself for this long
  K.BACK_MS = 3000;        // ... and that long after it is back: an app that has just started is connected before its window can take a share frame
  K.DENY_COOLDOWN_MS = 10000;   // after a Deny the same contact's next control request opens no dialog for this long
  K.ARM_MS = 800;          // the control dialog takes no click on Allow for this long after it opened
  K.DC_MAX = 400000;       // characters of one data-channel message; a longer one is dropped unparsed (a pointer image is up to 300000)
  K.DC_FIT = 262144;       // bytes one data-channel message may have when the connection does not say (Chromium's SCTP message size)
  K.CLIP_MAX = 65536;      // one copied text: UTF-8 bytes where main reads and writes the clipboard, UTF-16 units where its parts are put together
  K.CLIP_PART = 4096;      // UTF-16 units of one part of a copied text on the clip channel
  K.CLIP_PARTS = 16;       // parts of one text at most
  K.nameOf = (pub) => contact(pub)?.name || 'Your contact';
  // The viewer's elements can sit in another window's document (share/viewer.js moves the whole
  // section there), where getElementById of this page no longer finds them. So each is looked up
  // once, while it is still here, and kept.
  const kept = new Map();
  K.el = (id) => { let e = kept.get(id); if (!e) { e = $(id); if (e) kept.set(id, e); } return e; };
  // An Electron accelerator ("Control+Super+Return") as something a key event can be held against.
  // Needed where the page itself has the whole keyboard (full screen while I drive their screen): the
  // OS never sees the modifiers then, so its own hotkey does not fire and the page has to know the combination.
  const ACCEL_CODES = { return: ['Enter', 'NumpadEnter'], enter: ['Enter', 'NumpadEnter'], backspace: ['Backspace'], space: ['Space'], tab: ['Tab'], escape: ['Escape'], esc: ['Escape'], delete: ['Delete'], insert: ['Insert'],
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], home: ['Home'], end: ['End'], pageup: ['PageUp'], pagedown: ['PageDown'], plus: ['Equal', 'NumpadAdd'], minus: ['Minus', 'NumpadSubtract'] };
  K.accel = (text, mac) => {
    const a = { ctrl: false, meta: false, alt: false, shift: false, codes: [], key: '' };
    for (const part of String(text || '').split('+')) {
      const p = part.trim().toLowerCase();
      if (!p) continue;
      if (p === 'control' || p === 'ctrl') a.ctrl = true;
      else if (p === 'command' || p === 'cmd' || p === 'super' || p === 'meta') a.meta = true;
      else if (p === 'commandorcontrol' || p === 'cmdorctrl') { if (mac) a.meta = true; else a.ctrl = true; }
      else if (p === 'alt' || p === 'option') a.alt = true;
      else if (p === 'shift') a.shift = true;
      else if (/^[a-z]$/.test(p)) a.codes = ['Key' + p.toUpperCase()];
      else if (/^[0-9]$/.test(p)) a.codes = ['Digit' + p, 'Numpad' + p];
      else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) a.codes = [p.toUpperCase()];
      else if (Object.hasOwn(ACCEL_CODES, p)) a.codes = ACCEL_CODES[p];
      else a.key = p;
    }
    return a.codes.length || a.key ? a : null;
  };
  K.accelHit = (e, a) => !!a && !!e.ctrlKey === a.ctrl && !!e.metaKey === a.meta && !!e.altKey === a.alt && !!e.shiftKey === a.shift
    && (a.codes.length ? a.codes.includes(e.code) : String(e.key || '').toLowerCase() === a.key);
  // which of this app's three hotkeys a key event is, if any
  K.hotkeyOf = (e) => {
    const mac = window.api.platform === 'darwin', set = S.settings || {};
    for (const kind of ['fullHotkey', 'hotkey', 'modeHotkey']) if (K.accelHit(e, K.accel(set[kind], mac))) return kind;
    return '';
  };
  // True where this window is part of what a screen capture shows (Linux, the monitor build, blocking
  // switched off): what it says about the audience is then on every viewer's screen.
  K.capturable = () => !(S.capture && S.capture.supported && S.protection);
  // There, with my screen going to more than one contact, each viewer reads what this window says about
  // the others. So outside the control dialog and the picker nothing names a contact then: no marker on
  // a contact's row, no name on a button, and the toasts say "a viewer" or "a contact" (K.label).
  K.hushed = () => K.capturable() && K.cast.members.size > 1;
  K.label = (pub, plain, hush = K.hushed()) => (hush ? plain : K.nameOf(pub));
  // A share prompt has to be seen: it sits under the full-screen viewer and under the image viewer, and
  // only one modal shows at a time. So it leaves full screen and closes what is open before it shows.
  // The one thing it does not close is the control dialog: that one stays until it is answered. Anything
  // put in its place would stand where its buttons were, with the request still open behind it.
  // Every other share prompt goes too, also one that another modal had been opened over (Settings by its
  // shortcut): left up, it would be painted over the prompt that comes now, the Allow dialog included.
  // A share-back prompt that is closed this way was not answered: it is nobody's any more, and its
  // session may ask again with its next state frame.
  const PROMPTS = ['mControl', 'mShareBack', 'mCast'], up = (id) => !$(id).classList.contains('hidden');
  K.prompt = (id) => {
    if (id !== 'mControl' && up('mControl')) return false;
    if (K.viewer.theater) K.viewer.setFull(false);
    if (up('lightbox')) closeLightbox();
    const back = id !== 'mShareBack' && up('mShareBack') ? K.viewer.backFor : null;
    if (up('backdrop')) window.closeModal();
    for (const other of PROMPTS) if (other !== id && up(other)) K.unprompt(other);
    if (back && !up('mShareBack')) { back.askedBack = false; if (K.viewer.backFor === back) K.viewer.backFor = null; }
    show(id);
    if (K.viewer.away && K.viewer.away()) window.api.viewerFront('chat').catch(() => {});   // their screen is in a window of its own: the chat, with this prompt, comes in front of it
    return true;
  };
  // Closes its own modal only. The app closes "the open modal", which is the one shown last: when
  // another was opened on top of this prompt (Settings by its shortcut), that one stays and the
  // prompt alone is taken off the screen.
  K.unprompt = (id) => { if ($(id).classList.contains('hidden')) return; if (openModal === id) window.closeModal(); else $(id).classList.add('hidden'); };
})();
