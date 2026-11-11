'use strict';
// Screen share, first script: the namespace the share files hang their parts on, and the helpers
// all of them need. Each share file is one closure with no globals of its own; what another file
// needs from it sits on window.ShareKit (K) and is looked up there at call time, so the order of
// the script tags only matters for what runs while a file loads.
//
// Reads from app.js: $, contact, show, closeLightbox, window.closeModal. Reads K.viewer at call time.
(() => {
  const K = window.ShareKit = {};
  K.PROTO = 2;             // sent as `v` on every share frame; a peer that sends none is 0.7.1 or older
  K.MAX_SESSIONS = 1;      // sessions at once, one per contact; an opener past it is answered with bye
  K.CONNECT_MS = 30000;    // a session that has not connected this long after its first offer is given up
  K.DENY_COOLDOWN_MS = 10000;   // after a Deny the same contact's next control request opens no dialog for this long
  K.ARM_MS = 800;          // the control dialog takes no click on Allow for this long after it opened
  K.DC_MAX = 400000;       // characters of one data-channel message; a longer one is dropped unparsed (a pointer image is up to 300000)
  K.nameOf = (pub) => contact(pub)?.name || 'Your contact';
  // A share prompt has to be seen: it sits under the full-screen viewer and under the image viewer, and
  // only one modal shows at a time. So it leaves full screen and closes what is open before it shows.
  K.prompt = (id) => {
    if (K.viewer.theater) K.viewer.setFull(false);
    if (!$('lightbox').classList.contains('hidden')) closeLightbox();
    if (!$('backdrop').classList.contains('hidden')) window.closeModal();
    show(id);
  };
  // closes its own modal only: another one that is open by now is not this prompt's to close
  K.unprompt = (id) => { if (!$(id).classList.contains('hidden')) window.closeModal(); };
})();
