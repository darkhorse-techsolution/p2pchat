'use strict';
// Screen share, first script: the namespace the share files hang their parts on, and the helpers
// all of them need. Each share file is one closure with no globals of its own; what another file
// needs from it sits on window.ShareKit (K) and is looked up there at call time, so the order of
// the script tags only matters for what runs while a file loads.
//
// Reads from app.js: $, S, contact, show, closeLightbox, openModal, window.closeModal. Reads K.viewer at call time.
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
  // True where this window is part of what a screen capture shows (Linux, the monitor build, blocking
  // switched off): what it says about the audience is then on every viewer's screen.
  K.capturable = () => !(S.capture && S.capture.supported && S.protection);
  // A share prompt has to be seen: it sits under the full-screen viewer and under the image viewer, and
  // only one modal shows at a time. So it leaves full screen and closes what is open before it shows.
  K.prompt = (id) => {
    if (K.viewer.theater) K.viewer.setFull(false);
    if (!$('lightbox').classList.contains('hidden')) closeLightbox();
    if (!$('backdrop').classList.contains('hidden')) window.closeModal();
    show(id);
  };
  // Closes its own modal only. The app closes "the open modal", which is the one shown last: when
  // another was opened on top of this prompt (Settings by its shortcut), that one stays and the
  // prompt alone is taken off the screen.
  K.unprompt = (id) => { if ($(id).classList.contains('hidden')) return; if (openModal === id) window.closeModal(); else $(id).classList.add('hidden'); };
})();
