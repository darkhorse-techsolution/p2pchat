// Captions of my own voice, sent into the chat (ui/share/caption.js, the outgoing half): when the tap runs and on
// which track, who a finished line goes to, what is never sent, and how it shares the one recognizer with the
// captions over a share I watch. Then the same for this computer's sound, a second stream with its own mark.
// No window, no audio: stand-ins for the audio graph and for window.api.
const { load } = require('./share-world.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };
const tick = () => new Promise((r) => setImmediate(r));

function world(settings) {
  const w = { on: [], off: 0, offs: [], sent: [], live: [], taps: [], S: { settings }, list: [], els: new Map() };
  const mkEl = () => { const e = { textContent: '', hidden: false }; e.classList = { toggle(_c, on) { e.hidden = !!on; } }; return e; };
  const $ = (id) => { let e = w.els.get(id); if (!e) { e = mkEl(); w.els.set(id, e); } return e; };
  w.$ = $;
  class AudioContext {
    constructor() { this.sampleRate = 48000; this.destination = {}; this.closed = false; }
    createMediaStreamSource(stream) { const n = { stream, connect() {}, disconnect() {} }; w.taps.push({ ctx: this, track: stream.tracks[0] }); return n; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  w.K = load(['kit.js', 'caption.js'], { S: w.S, $, toast() {}, AudioContext, MediaStream: class { constructor(t) { this.tracks = t; } },
    api: { captionOn: async (pub) => { w.on.push(pub); return true; }, captionOff: async (pub) => { w.off++; w.offs.push(pub); return true; }, captionPcm() {},
      send: async (pub, m) => { w.sent.push({ pub, ...m }); return m; }, capLive: async (pub, m) => { w.live.push({ pub, ...m }); return true; } } });
  w.K.sessions = { all: () => w.list };
  w.K.viewer = { bound: null };
  w.K.mic = { state: 'idle', src: null, voice: null, mix: null };
  w.K.capture = { sound: null };
  w.track = (id) => ({ id, enabled: true, readyState: 'live' });
  // this computer's sound, captured with the screen and (unless inMix is false) part of the mix that goes out
  w.soundUp = (inMix = true) => { const t = w.track('sound'); w.K.capture.sound = t; w.K.mic.state = 'live'; w.K.mic.mix = { has: (which) => which === 'sound' && inMix }; return t; };
  w.micUp = (id = 'mic') => { w.K.mic.state = 'live'; w.K.mic.voice = w.track(id); w.K.mic.src = { id: 'mix-of-' + id }; return w.K.mic.voice; };   // src stands for a mix with the computer's sound: never to be read
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

  // O5: this computer's sound, a second stream beside my voice
  w = world({ captionsOut: true });
  const v5 = w.micUp(); const bob5 = w.hears('bob');
  w.soundUp(false); w.K.caption.sync();
  ok('O5 the sound was captured but is not in what goes out: it is not read', w.liveTap().length === 1 && w.on.join() === '~self');
  const snd = w.soundUp(); w.K.caption.sync();
  ok('O5 the sound goes out in the mix: a second tap, on the sound itself, under its own name', w.liveTap().length === 2 && w.liveTap()[0].track === v5 && w.liveTap()[1].track === snd && w.on.join() === '~self,~sound');
  w.K.caption.sync(); w.K.caption.sync();
  ok('O5 asked again and again: still the two', w.taps.length === 2 && w.off === 0);
  w.say('Welcome to the demo.', true, '~sound'); w.say('That was the clip.', true, '~self');
  await tick();
  ok('O5 a line of the computer\'s sound goes out marked as sound', w.sent.length === 2 && w.sent[0].pub === 'bob' && w.sent[0].kind === 'caption' && w.sent[0].lang === 'sound' && w.sent[0].text === 'Welcome to the demo.');
  ok('O5 a line of my voice goes out unmarked, as before', w.sent[1].kind === 'caption' && w.sent[1].lang === '' && w.sent[1].text === 'That was the clip.');
  w.say('♪♪', true, '~sound'); w.say('(upbeat music)', true, '~sound'); w.say('...', true, '~sound');
  ok('O5 music and noise make no line', w.sent.length === 2);
  w.say('half a li', false, '~sound');
  ok('O5 a line of the sound that is still running is not sent', w.sent.length === 2);
  snd.readyState = 'ended'; w.K.caption.sync();
  ok('O5 the sound capture ended, the talk goes on: only the sound tap stops', w.liveTap().length === 1 && w.liveTap()[0].track === v5 && w.offs.join() === '~sound');
  w.say('A late line of the clip.', true, '~sound');
  ok('O5 and a late line of it is dropped', w.sent.length === 2);
  w.soundUp(); w.K.caption.sync();
  bob5.micTrack.enabled = false; w.K.caption.sync();
  ok('O5 the microphone button mutes all I send: both taps stop', w.liveTap().length === 0 && w.K.caption.sending(bob5) === false);
  bob5.micTrack.enabled = true; w.K.caption.sync();
  ok('O5 unmuted: both again', w.liveTap().length === 2 && w.K.caption.sending(bob5) === true);
  w.S.settings.captionsOut = false; w.K.caption.sync();
  ok('O5 the setting goes off: neither is read', w.liveTap().length === 0);

  w = world({ captionsOut: true });
  const only = w.soundUp(); const bob6 = w.hears('bob'); w.K.caption.sync();   // no microphone here: mic.voice stays null
  ok('O5 no microphone, the sound alone goes out: the sound is read and nothing else', w.liveTap().length === 1 && w.liveTap()[0].track === only && w.on.join() === '~sound' && w.K.caption.sending(bob6) === true);

  w = world({ captionsOut: true });
  w.soundUp(); w.list.push({ pub: 'box', closed: false, micTrack: null, screenTrack: {}, remote: {} }); w.K.caption.sync();
  ok('O5 a share that sends no audio (an unattended one): nothing is read, whatever the capture holds', w.liveTap().length === 0 && w.on.length === 0);

  w = world({ captionsOut: true, captions: true });
  w.K.viewer.bound = { pub: 'dave', remote: { audio: w.track('their-voice') } };
  w.K.caption.sync();
  w.micUp(); w.soundUp(); w.hears('dave'); w.K.caption.sync();
  ok('O5 watching them, then my voice and sound go to them: the recognizer leaves their voice for my two', w.liveTap().length === 2 && w.on.join() === 'dave,~self,~sound' && w.offs.join() === 'dave');

  // O6: the live line, streamed ahead of each finished one
  w = world({ captionsOut: true });
  w.micUp(); w.hears('bob'); w.soundUp(); w.K.caption.sync();
  w.say('So the first sl', false, '~self');
  ok('O6 a line still forming is streamed live, to whoever hears me, and not stored', w.live.length === 1 && w.live[0].pub === 'bob' && w.live[0].text === 'So the first sl' && w.live[0].lang === '' && w.sent.length === 0);
  w.say('So the first slide.', true, '~self');
  await tick();
  ok('O6 the finished line is the stored caption, no new live frame', w.sent.length === 1 && w.sent[0].kind === 'caption' && w.live.length === 1);
  w.say('Welcome to the de', false, '~sound');
  ok('O6 the live line of the computer sound is marked sound', w.live.length === 2 && w.live[1].lang === 'sound' && w.live[1].text === 'Welcome to the de');
  ok('O6 each live frame has a higher seq than the last', w.live[1].seq > w.live[0].seq);
  w.hears('carol'); w.say('More soon', false, '~self');
  ok('O6 the live line goes to everyone who hears me', w.live.slice(-2).map((x) => x.pub).sort().join() === 'bob,carol');
  const before6 = w.live.length;
  w.say('(music)', false, '~sound'); w.say('   ', false, '~self');
  ok('O6 noise and blank make no live line', w.live.length === before6);

  // O7: captions a contact streams to me - received, shown live, cleared by the finished message
  w = world({ captions: true });
  w.S.current = 'dave';
  w.K.viewer.bound = { pub: 'dave', remote: { audio: w.track('their-voice') } };
  w.K.caption.onLive({ pub: 'dave', text: 'We finished the scr', lang: '', seq: 1 });
  ok('O7 a contact streaming to me counts as receiving, another contact does not', w.K.caption.receiving('dave') === true && w.K.caption.receiving('eve') === false);
  w.K.caption.sync();
  ok('O7 so my own recognizer does not also read their share', w.liveTap().length === 0);
  ok('O7 the live line shows under the open chat', w.$('capLive').textContent === 'We finished the scr' && w.$('capLive').hidden === false);
  ok('O7 and the same text is the subtitle over their screen', w.$('viewerCaptions').textContent === 'We finished the scr');
  w.K.caption.onLive({ pub: 'dave', text: 'stale', lang: '', seq: 0 });   // older seq, within the window
  ok('O7 a live frame that arrives out of order is ignored', w.$('capLive').textContent === 'We finished the scr');
  w.K.caption.onFinal('dave', { kind: 'caption', text: 'We finished the screen work.', lang: '' });
  ok('O7 the finished message clears the live line', w.$('capLive').textContent === '' && w.$('capLive').hidden === true);
  ok('O7 the finished line stays as the subtitle over their screen', w.$('viewerCaptions').textContent === 'We finished the screen work.');
})().catch((e) => { console.log('FAIL  caption test threw:', e.stack); process.exitCode = 1; });
