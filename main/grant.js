'use strict';
// Who may drive this machine through a screen share. There is at most one grant: a random token
// for one contact, made when the sharer allows control. The renderer has to show that token with
// every input event, so a page that lost track of who controls (a stale session, a second viewer)
// cannot feed the helper. Kept apart from main.js so that it can be tested without a window.
const crypto = require('node:crypto');

function createGrant({ control }) {
  let grant = null, refused = 0;   // grant: { token, pub, pending }; refused: input events turned away
  // The grant is taken before the helper is awaited: the helper can need up to 15 s to say it is
  // ready, and a second request in that time is refused instead of being told "ok" about a helper
  // the first request owns.
  async function start(pub, display) {
    if (grant) return { ok: false, reason: 'busy', message: 'Someone else is controlling this screen' };
    const g = grant = { token: crypto.randomBytes(16).toString('hex'), pub, pending: true };
    let r;
    try { r = await control.start(display); } catch (e) { r = { ok: false, reason: 'helper', message: e.message }; }
    if (grant !== g) return r && !r.ok ? r : { ok: false, reason: 'helper', message: 'Control was cancelled' };   // ended while the helper was starting
    if (!r || !r.ok) { grant = null; return r || { ok: false, reason: 'helper', message: 'The input helper did not start' }; }
    g.pending = false;
    return { ok: true, token: g.token };
  }
  // Ends the grant, whoever holds it, and stops the helper. Returns the grant that ended, or null.
  function end(why) { const g = grant; grant = null; control.stop(why); return g; }
  // The renderer gives a grant back by its token; a token of an earlier grant does nothing.
  function revoke(token) { if (!grant || typeof token !== 'string' || token !== grant.token) return false; end('revoked'); return true; }
  // The helper stopped by itself: the grant is over and there is nothing left to stop.
  function drop() { const g = grant; grant = null; return g; }
  function input(token, ev) {
    if (!grant || grant.pending || token !== grant.token) { refused++; return false; }
    control.event(ev);
    return true;
  }
  return { start, end, revoke, drop, input, current: () => grant, status: () => ({ pub: grant ? grant.pub : null, refused }) };
}

module.exports = { createGrant };
