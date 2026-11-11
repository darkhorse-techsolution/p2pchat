'use strict';
// Which incoming share frames raise the "is sharing their screen" pop-up. A share announces its screen
// with a `state` frame and sends more of them as it goes on (microphone, recording), so the pop-up
// is shown once per share: the sid of the share last announced is kept per contact. Per contact,
// because several of them can share at the same time and one must not make the other pop up again.
// Kept apart from main.js so that it can be tested without a window.
function createSharePops() {
  const shown = new Map();   // pub -> sid
  // true for the first frame of a share that says its screen is on
  function wants(f) {
    if (f.op === 'bye') { shown.delete(f.pub); return false; }
    if (f.op !== 'state' || !f.screen || shown.get(f.pub) === f.sid) return false;
    shown.set(f.pub, f.sid);
    return true;
  }
  return { wants, size: () => shown.size };
}

module.exports = { createSharePops };
