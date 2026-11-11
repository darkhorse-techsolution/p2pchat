// Remote control in the main process, without a window: the grant (main/grant.js) and the dry mode
// of the input controller (main/input.js) that the UI tests rely on.
const { createGrant } = require('../main/grant.js');
const { createController } = require('../main/input.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };

// a controller whose helper answers when the test says so
function fakeControl() {
  const c = { starts: [], stops: [], events: [], answer: [] };
  c.start = (display) => { c.starts.push(display); return new Promise((res, rej) => c.answer.push({ res, rej })); };
  c.stop = (why) => c.stops.push(why);
  c.event = (ev) => c.events.push(ev);
  return c;
}
const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 500 }, scaleFactor: 2 };

(async () => {
  // G1: one grant, taken before the helper is ready
  let c = fakeControl(), g = createGrant({ control: c });
  ok('G1 no grant at first', g.current() === null && g.status().pub === null && g.status().refused === 0);
  const p1 = g.start('alice', DISPLAY);
  ok('G1 the grant is held while the helper starts', g.current() && g.current().pending === true && g.current().pub === 'alice' && c.starts.length === 1);
  const second = await g.start('bob', DISPLAY);
  ok('G1 a second request meanwhile is refused as busy and starts no helper', second.ok === false && second.reason === 'busy' && c.starts.length === 1 && g.current().pub === 'alice');
  ok('G1 input is refused while the grant is pending, whatever token comes', g.input(g.current().token, { t: 'r' }) === false && g.input(undefined, { t: 'r' }) === false && c.events.length === 0 && g.status().refused === 2);
  c.answer[0].res({ ok: true });
  const r1 = await p1;
  ok('G1 the grant returns a 32-hex token once the helper is ready', r1.ok === true && /^[0-9a-f]{32}$/.test(r1.token) && g.current().pending === false && g.status().pub === 'alice');

  // G2: every input event needs that token
  ok('G2 input with the token reaches the helper', g.input(r1.token, { t: 'm', x: 0.5, y: 0.5 }) === true && c.events.length === 1 && c.events[0].t === 'm');
  const refusedBefore = g.status().refused;
  ok('G2 input with another token, or none, is refused and counted', g.input('wrong', { t: 'r' }) === false && g.input(null, { t: 'r' }) === false && g.input(r1.token.toUpperCase(), { t: 'r' }) === false && c.events.length === 1 && g.status().refused === refusedBefore + 3);
  ok('G2 a third request while control is on is busy', (await g.start('cy', DISPLAY)).reason === 'busy' && c.starts.length === 1);

  // G3: revoke by token
  ok('G3 a stale or malformed token revokes nothing', g.revoke('0'.repeat(32)) === false && g.revoke(undefined) === false && g.revoke({}) === false && g.current() !== null && c.stops.length === 0);
  ok('G3 the right token ends the grant and stops the helper', g.revoke(r1.token) === true && g.current() === null && g.status().pub === null && c.stops.join() === 'revoked');
  ok('G3 the token is dead afterwards', g.input(r1.token, { t: 'r' }) === false && c.events.length === 1 && g.revoke(r1.token) === false && c.stops.length === 1);
  const p2 = g.start('alice', DISPLAY); c.answer[1].res({ ok: true }); const r2 = await p2;
  ok('G3 the next grant has a new token and the old one stays refused', r2.ok && r2.token !== r1.token && g.input(r1.token, { t: 'r' }) === false && g.input(r2.token, { t: 'r' }) === true);

  // G4: main ends the grant by itself (capture ended, page reload, renderer gone)
  const ended = g.end('capture ended');
  ok('G4 end() clears the grant, stops the helper and returns what ended', ended && ended.token === r2.token && g.current() === null && c.stops[c.stops.length - 1] === 'capture ended' && g.input(r2.token, { t: 'r' }) === false);
  ok('G4 end() without a grant returns null', g.end('page reload') === null);

  // G5: the grant is ended while its helper is still starting
  c = fakeControl(); g = createGrant({ control: c });
  const p3 = g.start('alice', DISPLAY);
  g.end('capture ended');
  c.answer[0].res({ ok: true });
  const r3 = await p3;
  ok('G5 a helper that turns up ready after the grant was ended is not a grant', r3.ok === false && r3.reason === 'helper' && !('token' in r3) && g.current() === null);
  const p4 = g.start('alice', DISPLAY); g.end('renderer gone'); c.answer[1].res({ ok: false, reason: 'helper', message: 'exited at once' });
  ok('G5 and its own failure is passed on as it is', (await p4).message === 'exited at once' && g.current() === null);
  const p5 = g.start('alice', DISPLAY); g.end('page reload'); const p6 = g.start('bob', DISPLAY);
  c.answer[2].res({ ok: true });
  const r5 = await p5;
  ok('G5 a cancelled start leaves a grant made after it alone', r5.ok === false && g.current() && g.current().pub === 'bob' && g.current().pending === true);
  c.answer[3].res({ ok: true });
  const r6 = await p6;
  ok('G5 which then completes with its own token', r6.ok === true && g.status().pub === 'bob' && g.input(r6.token, { t: 'r' }) === true);

  // G6: the helper does not start, or goes away
  c = fakeControl(); g = createGrant({ control: c });
  const p7 = g.start('alice', DISPLAY); c.answer[0].res({ ok: false, reason: 'accessibility', message: 'no' });
  const r7 = await p7;
  ok('G6 a refused start returns the reason and frees the grant', r7.ok === false && r7.reason === 'accessibility' && g.current() === null);
  const p8 = g.start('alice', DISPLAY); c.answer[1].rej(new Error('spawn failed'));
  const r8 = await p8;
  ok('G6 a start that throws is a helper failure, grant free', r8.ok === false && r8.reason === 'helper' && r8.message === 'spawn failed' && g.current() === null);
  const p9 = g.start('alice', DISPLAY); c.answer[2].res({ ok: true }); const r9 = await p9;
  const stopsBefore = c.stops.length, dropped = g.drop();
  ok('G6 drop() (the helper exited by itself) ends the grant without stopping anything', dropped.token === r9.token && g.current() === null && c.stops.length === stopsBefore && g.input(r9.token, { t: 'r' }) === false);

  // G7: the clipboard is a part of the grant: allowed with it or not, for its contact and token, and used up once
  c = fakeControl(); g = createGrant({ control: c });
  ok('G7 no grant, no clipboard', g.clipOk('alice', 'x') === false && g.clipOk('alice', undefined) === false);
  const pc1 = g.start('alice', DISPLAY, true);
  ok('G7 not while the grant is still starting', g.clipOk('alice', g.current().token) === false);
  c.answer[0].res({ ok: true }); const rc1 = await pc1;
  ok('G7 a grant allowed with the clipboard: yes for its contact and its token', g.clipOk('alice', rc1.token) === true);
  ok('G7 not for another contact, another token, or a token that is not a string', g.clipOk('bob', rc1.token) === false && g.clipOk('alice', 'f'.repeat(32)) === false && g.clipOk('alice', null) === false && g.clipOk('alice', { toString: () => rc1.token }) === false);
  g.clipSpent('some other token');
  ok('G7 a stale token uses nothing up', g.clipOk('alice', rc1.token) === true);
  g.clipSpent(rc1.token);
  ok('G7 used up: the grant goes on, its clipboard does not come back', g.clipOk('alice', rc1.token) === false && g.current() !== null && g.input(rc1.token, { t: 'r' }) === true);
  g.end('stopped');
  const pc2 = g.start('alice', DISPLAY, true); c.answer[1].res({ ok: true }); const rc2 = await pc2;
  ok('G7 the next grant has its own', g.clipOk('alice', rc2.token) === true && g.clipOk('alice', rc1.token) === false);
  g.end('stopped');
  ok('G7 and it ends with the grant', g.clipOk('alice', rc2.token) === false);
  for (const v of [undefined, false, 0, 1, 'true', {}, null]) {
    const px = g.start('alice', DISPLAY, v); c.answer[c.answer.length - 1].res({ ok: true }); const rx = await px;
    ok(`G7 a grant asked with ${JSON.stringify(v)} for the clipboard has none`, rx.ok === true && g.clipOk('alice', rx.token) === false);
    g.end('stopped');
  }

  // D1: the dry controller never starts a helper
  const lines = []; const log = { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const none = '/nonexistent-helpers-dir';
  const dry = createController({ log, helpersDir: none, screen: {}, systemPreferences: {}, dry: true });
  ok('D1 dry: reported in status, off at first', dry.status().dry === true && dry.status().on === false && dry.status().events === 0);
  ok('D1 dry: available without a helper binary or any permission', dry.available().ok === true);
  const s1 = await dry.start(DISPLAY);
  ok('D1 dry: start succeeds and is on, with no helper process and no log line', s1.ok === true && dry.status().on === true && dry.status().display.id === 1 && lines.length === 0);
  dry.event({ t: 'm', x: 0.5, y: 0.5 }); dry.event({ t: 'b', b: 0, d: 1, x: 0.1, y: 0.1 }); dry.event({ t: 'k', c: 'KeyA', d: 1 }); dry.event({ t: 'w', dx: 1, dy: 2, x: 0, y: 0 }); dry.event({ t: 'r' });
  ok('D1 dry: well-formed events are counted', dry.status().events === 5 && dry.status().dropped === 0);
  dry.event({ t: 'zz' }); dry.event({ t: 'b', b: 9, d: 1 }); dry.event({ t: 'k', c: 'NoSuchKey', d: 1 }); dry.event(null); dry.event('m');
  ok('D1 dry: malformed ones are dropped as with a helper', dry.status().events === 5 && dry.status().dropped === 3);
  dry.stop('test');
  dry.event({ t: 'm', x: 0.5, y: 0.5 });
  ok('D1 dry: off after stop, and events no longer count', dry.status().on === false && dry.status().display === null && dry.status().events === 5 && lines.length === 0);
  await dry.start(DISPLAY);
  ok('D1 dry: a new start counts from zero', dry.status().on === true && dry.status().events === 0 && dry.status().dropped === 0);
  const real = createController({ log, helpersDir: none, screen: {}, systemPreferences: { isTrustedAccessibilityClient: () => false } });
  ok('D1 without the option the controller is not dry and not on', real.status().dry === false && real.status().on === false);
  real.event({ t: 'm', x: 0.5, y: 0.5 });
  ok('D1 and counts nothing while no helper runs', real.status().events === 0);

  // D2: the grant on top of the dry controller, as a dev instance runs it
  const dg = createGrant({ control: createController({ log, helpersDir: none, screen: {}, systemPreferences: {}, dry: true }) });
  const d1 = await dg.start('alice', DISPLAY);
  ok('D2 a dry grant gives a token', d1.ok === true && /^[0-9a-f]{32}$/.test(d1.token));
  ok('D2 a second one is busy', (await dg.start('bob', DISPLAY)).reason === 'busy');
  dg.input(d1.token, { t: 'm', x: 0.5, y: 0.5 }); dg.input('wrong', { t: 'r' });
  ok('D2 input with the token is counted, without it refused', dg.status().refused === 1 && dg.status().pub === 'alice');
  dg.revoke(d1.token);
  ok('D2 revoked', dg.current() === null && dg.status().pub === null);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL  harness threw:', e.stack); process.exit(1); });
