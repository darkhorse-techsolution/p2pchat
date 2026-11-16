// Captions of my own voice, sent into the chat (ui/share/caption.js, the outgoing half): when the tap runs and on
// which track, who a finished line goes to, what is never sent, and how it shares the one recognizer with the
// captions over a share I watch. No window, no audio: stand-ins for the audio graph and for window.api.
const { load } = require('./share-world.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const tick = () => new Promise((r) => setImmediate(r));

function world(settings) {
  const w = { on: [], off: 0, sent: [], taps: [], S: { settings }, list: [] };
  const el = { textContent: '', classList: { toggle() {} } };
  class AudioContext {
    constructor() { this.sampleRate = 48000; this.destination = {}; this.closed = false; }
    createMediaStreamSource(stream) { const n = { stream, connect() {}, disconnect() {} }; w.taps.push({ ctx: this, track: stream.tracks[0] }); return n; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  w.K = load(['kit.js', 'caption.js'], { S: w.S, $: () => el, toast() {}, AudioContext, MediaStream: class { constructor(t) { this.tracks = t; } },
    api: { captionOn: async (pub) => { w.on.push(pub); return true; }, captionOff: async () => { w.off++; return true; }, captionPcm() {},
      send: async (pub, m) => { w.sent.push({ pub, ...m }); return m; } } });
  w.K.sessions = { all: () => w.list };
  w.K.viewer = { bound: null };
  w.K.mic = { state: 'idle', src: null };
  w.track = (id) => ({ id, enabled: true, readyState: 'live' });
  w.micUp = (id = 'mic') => { w.K.mic.state = 'live'; w.K.mic.src = w.track(id); return w.K.mic.src; };
  w.hears = (pub) => { const x = { pub, closed: false, micTrack: w.track('lease-' + pub), remote: { audio: null } }; w.list.push(x); return x; };
  w.liveTap = () => w.taps.filter((t) => !t.ctx.closed);
  w.say = (text, final = true, pub = '~self') => w.K.caption.onText({ pub, text, final });
  return w;
}

(async () => {
  // O1: when the tap runs
  let w = world({ captionsOut: false });
  w.micUp(); w.hears('bob'); w.K.caption.sync();
  ok('O1 setting off: my microphone is not read, whoever hears it', w.liveTap().length === 0 && w.on.length === 0);
  w = world({ captionsOut: true });
  w.K.caption.sync();
  ok('O1 setting on, no microphone: nothing', w.liveTap().length === 0);
  const mic = w.micUp(); w.K.caption.sync();
  ok('O1 microphone on but nobody hears it: nothing', w.liveTap().length === 0);
  const bob = w.hears('bob'); w.K.caption.sync();
  ok('O1 someone hears it: the tap is on the microphone itself, under the recognizer\'s own name for me', w.liveTap().length === 1 && w.liveTap()[0].track === mic && w.on.join() === '~self');
  w.K.caption.sync(); w.K.caption.sync();
  ok('O1 asked again and again (every paint): still one tap', w.taps.length === 1 && w.on.length === 1);
  ok('O1 the pill can say so for that contact, and for no other', w.K.caption.sending(bob) === true && w.K.caption.sending({ pub: 'eve' }) === false);

  // O2: what goes out, and to whom
  w.say('so the first sl', false);
  ok('O2 a line still being spoken is not sent', w.sent.length === 0);
  w.say('So the first slide is the roadmap.');
  await tick();
  ok('O2 a finished line goes to the one who hears me, as a caption', w.sent.length === 1 && w.sent[0].pub === 'bob' && w.sent[0].kind === 'caption' && w.sent[0].text === 'So the first slide is the roadmap.');
  const carol = w.hears('carol');
  w.say('Next, the numbers.');
  ok('O2 two hear me: both get the line', w.sent.length === 3 && w.sent[1].pub === 'bob' && w.sent[2].pub === 'carol');
  w.say('[BLANK_AUDIO]'); w.say('(music)'); w.say('   ');
  ok('O2 what the recognizer writes for a sound that is not speech is not sent', w.sent.length === 3);
  w.say('from some other stream', true, 'bob');
  ok('O2 text that is not from my own voice is not sent', w.sent.length === 3);
  const ua = { pub: 'box', closed: false, micTrack: null, screenTrack: {}, remote: {} }; w.list.push(ua);
  w.say('Any questions?');
  ok('O2 a contact who gets my screen without my microphone (an unattended share) gets no caption', w.sent.length === 5 && !w.sent.some((s) => s.pub === 'box'));

  // O3: the mute, and the end of it
  carol.micTrack.enabled = false; w.K.caption.sync();
  w.say('Only Bob hears this.');
  ok('O3 muted toward one contact: that one gets nothing more', w.sent.length === 6 && w.sent[5].pub === 'bob');
  bob.micTrack.enabled = false; w.K.caption.sync();
  ok('O3 muted for everyone: the tap stops', w.liveTap().length === 0 && w.off === 1 && w.K.caption.sending(bob) === false);
  w.say('Said while muted.');
  ok('O3 and a line that still arrives is dropped', w.sent.length === 6);
  bob.micTrack.enabled = true; w.K.caption.sync();
  ok('O3 unmuted: it starts again', w.liveTap().length === 1 && w.on.length === 2);
  bob.closed = true; w.K.caption.sync();
  ok('O3 the share ended: the tap stops', w.liveTap().length === 0);
  bob.closed = false; w.K.caption.sync();
  const mic2 = w.micUp('mic2'); w.K.caption.sync();
  ok('O3 the microphone was started anew: the tap moves to the new one', w.liveTap().length === 1 && w.liveTap()[0].track === mic2);
  w.S.settings.captionsOut = false; w.K.caption.sync();
  ok('O3 the setting goes off mid-share: the tap stops at once', w.liveTap().length === 0);

  // O4: one recognizer, two uses
  w = world({ captionsOut: true, captions: true });
  const theirs = w.track('their-voice');
  w.K.viewer.bound = { pub: 'dave', remote: { audio: theirs } };
  w.K.caption.sync();
  ok('O4 watching, not talking: the recognizer reads their voice, as before', w.liveTap().length === 1 && w.liveTap()[0].track === theirs && w.on.join() === 'dave');
  w.say('their words', true, 'dave');
  ok('O4 and their words are never sent anywhere', w.sent.length === 0);
  const m = w.micUp(); const dave = w.hears('dave'); w.K.caption.sync();
  ok('O4 my microphone goes to them: the recognizer moves to my voice', w.liveTap().length === 1 && w.liveTap()[0].track === m && w.on.join() === 'dave,~self');
  w.say('their words, late', true, 'dave');
  ok('O4 a late line of theirs is not taken for mine', w.sent.length === 0);
  dave.micTrack.enabled = false; w.K.caption.sync();
  ok('O4 I mute: it goes back to their voice', w.liveTap().length === 1 && w.liveTap()[0].track === theirs);
  w.S.settings.captions = false; w.K.caption.sync();
  ok('O4 with only the outgoing setting on and nothing of mine to read: no tap', w.liveTap().length === 0);
})().catch((e) => { console.log('FAIL  caption test threw:', e.stack); process.exitCode = 1; });
