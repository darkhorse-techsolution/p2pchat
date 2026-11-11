// The clipboard link in the main process, without a window and without a clipboard: main/clip.js on
// a backend in memory, under the real grant (main/grant.js). Every rule about when clipboard text may
// be read or written has a case here that fails when the rule is taken out.
const { createGrant } = require('../main/grant.js');
const { createClipLink, MAX_BYTES, POLL_MS } = require('../main/clip.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };

// The timer of a link is the test's: a look at the clipboard happens when the test fires it.
const timers = [];
global.setInterval = (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; };
global.clearInterval = (t) => { if (t) t.on = false; };
const live = () => timers.filter((t) => t.on);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const fire = async () => { for (const t of live()) t.fn(); await settle(); };

// a machine: a clipboard in memory that counts its reads and writes, the Settings switch, a grant, a link
function machine(platform = 'darwin') {
  const m = { text: '', reads: 0, writes: 0, marks: new Set(), failRead: false, failWrite: 0, on: true, texts: [], notes: [], stops: [] };   // failWrite: that many writes throw
  m.backend = { readText: async () => { m.reads++; if (m.failRead) throw new Error('no clipboard'); return m.text; }, writeText: async (v) => { m.writes++; if (m.failWrite) { m.failWrite--; throw new Error('clipboard busy'); } m.text = String(v); }, has: async (f) => m.marks.has(f) };
  m.control = { start: async () => ({ ok: true }), stop() {}, event() {} };
  m.grant = createGrant({ control: m.control });
  m.clip = createClipLink({ backend: m.backend, platform, enabled: () => m.on, grant: m.grant });
  m.clip.onText = (id, text) => m.texts.push(`${id}:${text}`); m.clip.onNote = (id, note) => m.notes.push(`${id}:${note}`); m.clip.onStop = (id, why) => m.stops.push(`${id}:${why}`);
  m.allow = async (pub, withClip) => (await m.grant.start(pub, { id: 1 }, withClip)).token;   // the sharer pressed Allow, with the clipboard box as given
  return m;
}
const DISPLAY = { id: 1 };

(async () => {
  // K1: on the sharer's machine a link starts only under a grant that is on, allowed the clipboard, and is named by token and contact
  let m = machine();
  ok('K1 no grant: a give link is refused and the clipboard is not read', (await m.clip.start({ pub: 'bob', role: 'give', token: 'x' })).reason === 'nogrant' && m.reads === 0 && m.clip.status().on === false);
  let tok = await m.allow('bob', false);
  ok('K1 a grant allowed without the clipboard box: refused', (await m.clip.start({ pub: 'bob', role: 'give', token: tok })).reason === 'nogrant' && m.reads === 0);
  m.grant.end('test'); tok = await m.allow('bob', true);
  ok('K1 the right grant but another token, no token, or a token that is not a string: refused', (await m.clip.start({ pub: 'bob', role: 'give', token: 'f'.repeat(32) })).reason === 'nogrant' && (await m.clip.start({ pub: 'bob', role: 'give' })).reason === 'nogrant' && (await m.clip.start({ pub: 'bob', role: 'give', token: { toString: () => tok } })).reason === 'nogrant' && m.reads === 0);
  ok('K1 the right token for another contact: refused', (await m.clip.start({ pub: 'cy', role: 'give', token: tok })).reason === 'nogrant' && m.reads === 0);
  let r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  ok('K1 token and contact of a grant that allowed the clipboard: the link starts, with one timer', r.ok === true && typeof r.id === 'string' && m.clip.status().on && m.clip.status().pub === 'bob' && m.clip.status().role === 'give' && live().length === 1 && live()[0].ms === POLL_MS);
  m.clip.stop('test');
  m = machine();
  const held = m.control.start; let ready; m.control.start = () => new Promise((res) => { ready = res; });
  const starting = m.grant.start('bob', DISPLAY, true); const pend = m.grant.current().token;
  ok('K1 a grant whose helper is still starting: refused', (await m.clip.start({ pub: 'bob', role: 'give', token: pend })).reason === 'nogrant' && m.reads === 0);
  ready({ ok: true }); await starting; m.control.start = held;
  ok('K1 the true value only: a grant asked with anything else than true has no clipboard', (await (async () => { const x = machine(); const t = await x.allow('bob', 1); return (await x.clip.start({ pub: 'bob', role: 'give', token: t })).reason; })()) === 'nogrant');

  // K2: what is sent from the sharer's clipboard
  m = machine(); m.text = 'before'; tok = await m.allow('bob', true);
  r = await m.clip.start({ pub: 'bob', role: 'give', token: tok }); const id = r.id;
  await fire(); await fire();
  ok('K2 the text that was there when the link started is never sent', m.texts.length === 0);
  m.text = 'alpha'; await fire();
  ok('K2 a new copy is sent once', m.texts.join() === `${id}:alpha`);
  await fire(); await fire();
  ok('K2 and not again while it stays', m.texts.length === 1);
  m.text = ''; await fire(); m.text = 'alpha'; await fire();
  ok('K2 an empty clipboard sends nothing and does not make the old text new', m.texts.length === 1);
  m.text = 'a\r\nb\rc'; await fire();
  ok('K2 line ends are folded to LF', m.texts[1] === `${id}:a\nb\nc`);
  m.text = 'x\0y'; await fire();
  ok('K2 a text with a NUL is not sent, and the page is told', m.texts.length === 2 && m.notes.join() === `${id}:refused`);
  m.text = 'é'.repeat(MAX_BYTES / 2 + 1); await fire();
  ok('K2 a text over 65536 bytes is not sent (counted in UTF-8), and the page is told', m.texts.length === 2 && m.notes[1] === `${id}:big`);
  m.text = 'é'.repeat(MAX_BYTES / 2); await fire();
  ok('K2 one of exactly 65536 bytes is', m.texts.length === 3 && m.texts[2].length === id.length + 1 + MAX_BYTES / 2);
  await fire();
  ok('K2 a refused text is told once, not on every look', m.notes.length === 2);

  // K3: a text from the peer is written, and never sent back
  const w0 = m.writes;
  ok('K3 apply writes the text', (await m.clip.apply(id, 'from bob')) === true && m.text === 'from bob' && m.writes === w0 + 1);
  await fire(); await fire();
  ok('K3 the next looks do not send it back', m.texts.length === 3);
  m.text = 'gamma'; await fire(); m.text = 'from bob'; await fire();
  ok('K3 nor when it is copied again later', m.texts.length === 4 && m.texts[3] === `${id}:gamma`);
  ok('K3 a text equal to what is there already is not written again', (await m.clip.apply(id, 'from bob')) === true && m.writes === w0 + 1);
  const w1 = m.writes, keep = m.text;
  const bad = [await m.clip.apply('999', 'other link'), await m.clip.apply(id, ''), await m.clip.apply(id, 'a\0b'), await m.clip.apply(id, 'x'.repeat(MAX_BYTES + 1)), await m.clip.apply(id, 42), await m.clip.apply(id, null), await m.clip.apply(id, ['list']), await m.clip.apply(undefined, 'no id')];
  ok('K3 apply with another id, no text, a NUL, too much, or something that is not a string: refused, nothing written', bad.every((x) => x === false) && m.writes === w1 && m.text === keep);

  // K4: the link ends with the grant, at once, and the clipboard is left alone from then on
  ok('K4 a stale token stops nothing', m.clip.stopFor('0'.repeat(32), 'x') === false && m.clip.status().on);
  const g = m.grant.end('capture ended'); m.clip.stopFor(g.token, 'capture ended');
  const reads = m.reads; m.text = 'after the grant'; await fire();
  ok('K4 the grant ends: the link is off, the page is told why, the timer is gone', m.clip.status().on === false && m.stops.join() === `${id}:capture ended` && live().length === 0);
  ok('K4 and nothing is read, sent or written any more', m.reads === reads && m.texts.length === 4 && (await m.clip.apply(id, 'late')) === false && m.text === 'after the grant');

  // K5: main asks the grant again before every read and every write (a link that outlived its grant does nothing)
  m = machine(); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  m.grant.end('ended without telling the link');
  const t5 = live()[0], r5 = m.reads; m.text = 'secret'; t5.fn(); await settle();
  ok('K5 a look after the grant is gone reads nothing, sends nothing and ends the link', m.reads === r5 && m.texts.length === 0 && m.clip.status().on === false && m.stops.join() === `${r.id}:not allowed`);
  m = machine(); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  m.grant.end('ended without telling the link');
  ok('K5 a text that arrives after the grant is gone is not written, and ends the link', (await m.clip.apply(r.id, 'late')) === false && m.writes === 0 && m.text === '' && m.clip.status().on === false);
  m = machine(); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  m.grant.end('x'); const tok2 = await m.allow('cy', true);
  m.text = 'for bob?'; live()[0].fn(); await settle();
  ok('K5 a grant for someone else does not keep the link of the one before alive', m.texts.length === 0 && m.clip.status().on === false && tok2 !== tok);

  // K6: clipboard off is final for a grant
  m = machine(); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  m.clip.stop('renderer');
  ok('K6 after the link ended, the same grant starts no second one', (await m.clip.start({ pub: 'bob', role: 'give', token: tok })).reason === 'nogrant' && m.grant.current() !== null && m.clip.status().on === false);
  m.grant.end('stopped'); tok = await m.allow('bob', true);
  ok('K6 a new Allow with the box ticked does', (await m.clip.start({ pub: 'bob', role: 'give', token: tok })).ok === true);
  m.clip.stop('test');

  // K7: the Settings switch
  m = machine(); m.on = false; tok = await m.allow('bob', true);
  ok('K7 switched off: no link starts, in either role', (await m.clip.start({ pub: 'bob', role: 'give', token: tok })).reason === 'off' && (await m.clip.start({ pub: 'bob', role: 'take' })).reason === 'off' && m.reads === 0);
  m.on = true; r = await m.clip.start({ pub: 'bob', role: 'give', token: tok }); m.on = false;
  const r7 = m.reads; m.text = 'copied with the switch off'; await fire();
  ok('K7 switched off while a link runs: the next look reads nothing and ends it', m.reads === r7 && m.texts.length === 0 && m.clip.status().on === false);
  m = machine(); r = await m.clip.start({ pub: 'alice', role: 'take' }); m.on = false;
  ok('K7 and a text from the peer is not written', (await m.clip.apply(r.id, 'x')) === false && m.writes === 0 && m.clip.status().on === false);

  // K8: the viewer's machine: no timer, one look per poke
  m = machine(); m.text = 'mine before';
  r = await m.clip.start({ pub: 'alice', role: 'take', token: 'ignored' });
  ok('K8 a take link starts without a grant and without a timer', r.ok === true && live().length === 0 && m.clip.status().role === 'take');
  const r8 = m.reads; m.text = 'beta'; await settle(); await new Promise((res) => setTimeout(res, 30));
  ok('K8 a copy is not looked at by itself', m.reads === r8 && m.texts.length === 0);
  m.clip.poke('nope'); await settle();
  ok('K8 nor on a poke with another id', m.reads === r8);
  m.clip.poke(r.id); await settle();
  ok('K8 a poke looks once and sends the new text', m.reads === r8 + 1 && m.texts.join() === `${r.id}:beta`);
  m.clip.poke(r.id); await settle();
  ok('K8 the baseline rule holds here too: what was copied before the link is never sent', m.texts.length === 1 && !m.texts.join().includes('mine before'));
  ok('K8 ending the grant of this machine does not touch a take link (it has no token)', m.clip.stopFor(null, 'x') === false && m.clip.stopFor(undefined, 'x') === false && m.clip.status().on);
  m.clip.stop('renderer');
  m = machine(); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  const r8b = m.reads; m.clip.poke(r.id); await settle();
  ok('K8 a poke does nothing on the sharer\'s side', m.reads === r8b);

  // K9: one link per app
  ok('K9 a second link is refused while one is on', (await m.clip.start({ pub: 'cy', role: 'take' })).reason === 'busy' && m.clip.status().pub === 'bob');
  m.clip.stop('renderer');
  ok('K9 status when off', JSON.stringify(m.clip.status()) === '{"on":false,"id":null,"pub":null,"role":null}' && m.clip.stop('again') === false && m.stops.length === 1);

  // K10: a copy marked as concealed is not read
  for (const [platform, mark] of [['darwin', 'org.nspasteboard.ConcealedType'], ['darwin', 'org.nspasteboard.TransientType'], ['darwin', 'org.nspasteboard.AutoGeneratedType'], ['win32', 'ExcludeClipboardContentFromMonitorProcessing'], ['linux', 'x-kde-passwordManagerHint']]) {
    m = machine(platform); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
    m.text = 'hunter2'; m.marks.add(`electron application/osclipboard;format="${mark}"`);
    const before = m.reads; await fire();
    const skipped = m.reads === before && m.texts.length === 0;
    m.marks.clear(); m.text = 'plain'; await fire();
    ok(`K10 ${platform} ${mark}: not read while marked, and the next plain copy is sent`, skipped && m.texts.join() === `${r.id}:plain`);
    m.clip.stop('test');
  }

  // K11: a link whose baseline cannot be read does not start; a start that is overtaken by a stop is not a link
  m = machine(); m.failRead = true; tok = await m.allow('bob', true);
  r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  ok('K11 no baseline, no link: nothing could tell an old copy from a new one', r.ok === false && r.reason === 'read' && m.clip.status().on === false && live().length === 0);
  m = machine(); tok = await m.allow('bob', true);
  const p11 = m.clip.start({ pub: 'bob', role: 'give', token: tok }); m.clip.stop('renderer'); r = await p11;
  ok('K11 stopped while the baseline was read: not a link, no timer', r.ok === false && r.reason === 'stopped' && live().length === 0 && m.clip.status().on === false);

  // K12: a slow clipboard does not pile up looks
  m = machine(); tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  let release; const slow = m.backend.readText; m.backend.readText = () => new Promise((res) => { release = () => { m.reads++; res('slow'); }; });
  const t12 = live()[0]; t12.fn(); t12.fn(); t12.fn(); await settle(); m.backend.readText = slow; release(); await settle();
  ok('K12 three timer ticks during one slow read make one read', m.reads === 2 && m.texts.join() === `${r.id}:slow`);
  m.clip.stop('test');

  // V2: a write that fails does not make the text from before the link look like a new copy (review of stage D, MEDIUM 1)
  for (const role of ['give', 'take']) {
    m = machine(); m.text = 'PRE-LINK'; tok = role === 'give' ? await m.allow('bob', true) : null;
    r = await m.clip.start({ pub: 'bob', role, token: tok });
    const look = async () => { if (role === 'give') await fire(); else { m.clip.poke(r.id); await settle(); } };
    m.failWrite = 1; let threw = false; try { await m.clip.apply(r.id, 'from the peer'); } catch { threw = true; }
    await look(); await look();
    ok(`V2 ${role}: the peer's text could not be written; what was on the clipboard before the link is still there and is not sent`, threw && m.text === 'PRE-LINK' && m.texts.length === 0);
    const wrote = await m.clip.apply(r.id, 'second'); await look();
    ok(`V2 ${role}: the next text of the peer is written and not sent back`, wrote === true && m.text === 'second' && m.texts.length === 0);
    m.text = 'mine'; await look();
    ok(`V2 ${role}: and a copy made here goes out as before`, m.texts.join() === `${r.id}:mine`);
    m.clip.stop('test');
  }
  m = machine(); m.text = 'PRE-LINK'; r = await m.clip.start({ pub: 'bob', role: 'take' });
  const write2 = m.backend.writeText; let letGo; m.backend.writeText = (v) => new Promise((res) => { letGo = () => res(write2(v)); });
  const p2 = m.clip.apply(r.id, 'late'); await settle(); m.clip.stop('renderer'); const reads2 = m.reads; letGo(); await p2; await settle();
  ok('V2 a link that stopped while a write was under way is not read again after it', m.reads === reads2 && m.clip.status().on === false);

  // V4: a marked copy that lands between the marker check and the read is not sent (review of stage D, LOW 1)
  const MARK = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';
  m = machine(); m.text = 'x'; tok = await m.allow('bob', true); r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  let asked = 0; const has4 = m.backend.has;
  m.backend.has = async (f) => { const marked = await has4(f); if (++asked === 3) { m.text = 'PASSWORD'; m.marks.add(MARK); } return marked; };   // the three markers of this platform were asked about: now the password manager copies
  await fire(); m.backend.has = has4;
  ok('V4 the copy came after the check found no marker and before the read: it is not sent', asked >= 3 && m.texts.length === 0 && m.notes.length === 0);
  await fire(); await fire();
  ok('V4 and not on the looks after it, while it is marked', m.texts.length === 0);
  m.marks.clear(); m.text = 'plain'; await fire();
  ok('V4 the next plain copy is sent', m.texts.join() === `${r.id}:plain`);
  m.clip.stop('test');

  // V5: a look that is under way when the link stops does not read the clipboard after the stop (review of stage D, LOW 2)
  for (const role of ['give', 'take']) {
    m = machine(); m.text = 'x'; tok = role === 'give' ? await m.allow('bob', true) : null;
    r = await m.clip.start({ pub: 'bob', role, token: tok });
    let calls = 0; const has5 = m.backend.has;
    m.backend.has = async (f) => { if (++calls === 2) m.clip.stop('control ended'); return has5(f); };   // the link ends while the markers are being asked about
    m.text = 'copied as control ends'; const reads5 = m.reads;
    if (role === 'give') await fire(); else { m.clip.poke(r.id); await settle(); }
    m.backend.has = has5;
    ok(`V5 ${role}: the link stopped between the marker check and the read: no read follows, nothing is sent`, calls >= 2 && m.clip.status().on === false && m.reads === reads5 && m.texts.length === 0);
  }

  // V6: a marked text is not read as the baseline of a new link either; a clipboard that cannot be asked about its markers counts as marked (review of stage D, LOW 3)
  for (const role of ['give', 'take']) {
    m = machine(); m.text = 'PASSWORD AT THE START'; m.marks.add(MARK); tok = role === 'give' ? await m.allow('bob', true) : null;
    r = await m.clip.start({ pub: 'bob', role, token: tok });
    const look = async () => { if (role === 'give') await fire(); else { m.clip.poke(r.id); await settle(); } };
    ok(`V6 ${role}: a marked text on the clipboard when the link starts: the link starts and the text is not read`, r.ok === true && m.reads === 0 && m.clip.status().on === true);
    await look(); await look();
    ok(`V6 ${role}: nor on the looks after it`, m.reads === 0 && m.texts.length === 0);
    m.marks.clear(); m.text = 'plain'; await look();
    ok(`V6 ${role}: the plain copy made after it is sent`, m.texts.join() === `${r.id}:plain`);
    m.clip.stop('test');
  }
  m = machine(); m.text = 'cannot tell'; tok = await m.allow('bob', true);
  const has6 = m.backend.has; m.backend.has = async () => { throw new Error('no formats'); };
  r = await m.clip.start({ pub: 'bob', role: 'give', token: tok });
  m.text = 'a copy while the markers cannot be asked about'; await fire(); await fire();
  ok('V6 the marker question throws: it counts as marked, nothing is read and nothing is sent', r.ok === true && m.reads === 0 && m.texts.length === 0);
  ok('V6 a text of the peer is written there, and not read back', (await m.clip.apply(r.id, 'from the peer')) === true && m.text === 'from the peer' && m.reads === 0);
  await fire();
  ok('V6 and not sent back on the next look', m.texts.length === 0);
  m.backend.has = has6; await fire(); m.text = 'asked again'; await fire();
  ok('V6 once the question is answered again, a new copy is sent', m.texts.join() === `${r.id}:asked again`);
  m.clip.stop('test');

  // V10: at most one text of the peer waits to be written; a newer one takes its place (review of stage D, LOW 8)
  m = machine(); m.text = 'x'; r = await m.clip.start({ pub: 'bob', role: 'take' });
  let free; const write10 = m.backend.writeText; m.backend.writeText = (v) => new Promise((res) => { free = () => res(write10(v)); });   // a slow clipboard: the first write does not come back
  const first = m.clip.apply(r.id, 'first'); await settle();
  let no = 0, yes = 0; const flood = [];
  for (let k = 0; k < 4000; k++) { const p10 = m.clip.apply(r.id, 'flood ' + k); p10.then((v) => { if (v) yes++; else no++; }); flood.push(p10); }
  await settle();
  ok('V10 one write is under way and 4000 texts follow: only the newest waits, the 3999 before it are answered no at once', no === 3999 && yes === 0 && m.writes === 0);
  m.backend.writeText = write10; free(); await settle(); await settle();
  ok('V10 the write under way ends and the newest text is written after it: two writes in all', (await first) === true && (await flood[3999]) === true && m.writes === 2 && m.text === 'flood 3999');
  m.clip.poke(r.id); await settle();
  ok('V10 and it is not sent back', m.texts.length === 0);
  m.backend.writeText = (v) => new Promise((res) => { free = () => res(write10(v)); });
  const held10 = m.clip.apply(r.id, 'under way'); await settle(); const waits = m.clip.apply(r.id, 'waits'); await settle();
  m.clip.stop('renderer'); m.backend.writeText = write10; free(); await settle();
  ok('V10 a text that still waited when the link stopped is not written', (await waits) === false && (await held10) === true && m.text === 'under way' && m.writes === 3);

  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL  harness threw:', e.stack); process.exit(1); });
