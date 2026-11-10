'use strict';
// Screen share, first script: the namespace the share files hang their parts on, and the helpers
// all of them need. Each share file is one closure with no globals of its own; what another file
// needs from it sits on window.ShareKit (K) and is looked up there at call time, so the order of
// the script tags only matters for what runs while a file loads.
//
// Reads from app.js: contact.
(() => {
  const K = window.ShareKit = {};
  K.nameOf = (pub) => contact(pub)?.name || 'Your contact';
})();
