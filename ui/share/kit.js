'use strict';
// Screen share, first script: the namespace the share files hang their parts on, and the helpers
// all of them need. Each share file is one closure with no globals of its own; what another file
// needs from it sits on window.ShareKit (K) and is looked up there at call time, so the order of
// the script tags only matters for what runs while a file loads.
//
// Reads from app.js: contact.
(() => {
  const K = window.ShareKit = {};
  K.PROTO = 2;             // sent as `v` on every share frame; a peer that sends none is 0.7.1 or older
  K.MAX_SESSIONS = 1;      // sessions at once, one per contact; an opener past it is answered with bye
  K.CONNECT_MS = 30000;    // a session that has not connected this long after its first offer is given up
  K.nameOf = (pub) => contact(pub)?.name || 'Your contact';
})();
