// This computer's sound in a share (ui/share/cast.js, Settings "Also send this computer's sound when I share"):
// when the capture asks for it, how it is mixed with the microphone, what a contact's session gets, what captions
// may read, and that everything is given back when the share ends. Devices and the audio graph only record.
const { load } = require('./share-world.js');
const ok = (n, v) => { console.log((v ? 'PASS' : 'FAIL').padEnd(5), n); if (!v) process.exitCode = 1; };

function world({ platform = 'darwin', shareSound = true, soundTrack = 'live', micOk = true } = {}) {
  const w = { toasts: [], gdmArgs: [], ctxs: [], held: new Map(), states: [], micOk, soundTrack, S: { capture: { supported: true }, protection: true, settings: { shareSound } } };
  const track = (kind, from) => ({ kind, from: from || null, enabled: true, readyState: 'live', contentHint: '', stop() { this.readyState = 'ended'; }, clone() { return track(kind, this.from || this); }, applyConstraints: async () => {}, getSettings: () => ({ width: 1920 }) });
  class AudioContext {
    constructor() { this.closed = false; this.nodes = []; this.out = track('mix'); w.ctxs.push(this); }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [this.out] } }; }
    createMediaStreamSource(stream) { const n = { track: stream.tracks[0], on: false, connect() { this.on = true; }, disconnect() { this.on = false; } }; this.nodes.push(n); return n; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; }
  }
  w.K = load(['kit.js', 'tune.js', 'cast.js'], { toast: (t) => w.toasts.push(t), renderContacts() {}, S: w.S, contact: (pub) => ({ pub, name: pub, status: 'online' }), showScreenPermission() {}, console: { warn() {}, error() {}, log() {} },
    AudioContext, MediaStream: class { constructor(t) { this.tracks = t || []; } addTrack() {} removeTrack() {} },
    navigator: { mediaDevices: {
      getDisplayMedia: async (c) => { w.gdmArgs.push(c); w.video = track('video'); w.sound = w.soundTrack === 'none' ? null : track('sound'); if (w.sound && w.soundTrack === 'ended') w.sound.readyState = 'ended';
        return { getVideoTracks: () => [w.video], getAudioTracks: () => (c.audio && w.sound ? [w.sound] : []) }; },
      getUserMedia: async () => { w.voice = track('voice'); return { getAudioTracks: () => [w.voice] }; } } },
    api: { platform, screenPermission: async () => 'ok', micPermission: async () => w.micOk, captureEnded: async () => true } });
  w.K.paint = () => {}; w.K.control = { owner: null, endGive() {} }; w.K.clip = { link: null };
  w.mk = (pub) => { const x = { pub, closed: false, seen: false, ready: Promise.resolve(), mode: 'one', local: { addTrack() {}, removeTrack() {} }, screenTrack: null, micTrack: null, screenSender: null, micSender: null, micStream: null, scaled: false, remote: { screen: false, mic: false, rec: false }, ctl: { give: 'off' },
    pc: { addTrack: (t) => ({ track: t, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }), removeTrack() {}, getTransceivers: () => [] } }; w.held.set(pub, x); return x; };
  w.K.sessions = { get: (pub) => w.held.get(pub) || null, open: (pub) => w.mk(pub), all: () => [...w.held.values()], openChannels() {}, dc: () => true, sendState() {}, close: (x, why) => { x.closed = true; w.held.delete(x.pub); w.K.cast.sessionClosed(x, why); } };
  w.inputs = () => (w.K.mic.mix ? w.ctxs[w.ctxs.length - 1].nodes.filter((n) => n.on).map((n) => n.track.kind).sort().join('+') : 'no mix');
  return w;
}

(async () => {
  // A1: off, or a system that cannot: exactly as before
  let w = world({ shareSound: false });
  await w.K.cast.add('bob', 'one');
  ok('A1 setting off: the capture asks for no audio', w.gdmArgs[0].audio === false);
  ok('A1 setting off: no mix; the contact gets the microphone itself, and captions read that', !w.K.mic.mix && w.ctxs.length === 0 && w.held.get('bob').micTrack.kind === 'voice' && w.K.mic.voice === w.voice && !w.K.capture.sound);
  w = world({ platform: 'linux' });
  await w.K.cast.add('bob', 'one');
  ok('A1 Linux, setting on: not asked for, no mix (it delivers no sound there)', w.gdmArgs[0].audio === false && !w.K.mic.mix);

  // A2: on, macOS and Windows
  for (const platform of ['darwin', 'win32']) {
    w = world({ platform });
    await w.K.cast.add('bob', 'one');
    ok(`A2 ${platform}: the capture asks for the sound, without this app's own playback`, w.gdmArgs[0].audio && w.gdmArgs[0].audio.restrictOwnAudio === true);
    ok(`A2 ${platform}: microphone and sound go into one mix`, w.K.capture.sound === w.sound && w.inputs() === 'sound+voice');
    ok(`A2 ${platform}: the contact gets one audio track, the mix`, w.held.get('bob').micTrack.kind === 'mix' && w.held.get('bob').micTrack.enabled === true);
    ok(`A2 ${platform}: captions of my voice may read the microphone alone, never the mix`, w.K.mic.voice === w.voice && w.K.mic.voice.kind === 'voice' && w.K.mic.src.kind === 'mix');
  }
  await w.K.cast.add('carol', 'one');
  ok('A2 a second viewer: the same capture, the same mix, no second graph', w.gdmArgs.length === 1 && w.ctxs.length === 1 && w.held.get('carol').micTrack.kind === 'mix');
  await w.K.cast.talk(w.held.get('bob'));
  ok('A2 the microphone button mutes all of it for everyone who gets my screen', w.held.get('bob').micTrack.enabled === false && w.held.get('carol').micTrack.enabled === false);

  // A3: the end gives everything back
  const sound = w.sound, voice = w.voice, ctx = w.ctxs[0];
  w.K.cast.remove('bob'); w.K.cast.remove('carol');
  ok('A3 the last viewer gone: the sound capture stops', sound.readyState === 'ended' && w.K.capture.sound === null && w.K.capture.state === 'idle');
  ok('A3 and the mix closes, and the microphone under it stops', ctx.closed && voice.readyState === 'ended' && w.K.mic.mix === null && w.K.mic.voice === null && w.K.mic.state === 'idle');

  // A4: the sound could not be had
  w = world({ soundTrack: 'ended' });
  await w.K.cast.add('bob', 'one');
  ok('A4 macOS without the permission (a track that has ended): told where to allow it', w.toasts.some((t) => /sound was not captured.*Screen & System Audio Recording/.test(t)));
  ok('A4 the share goes on with the microphone alone', w.held.get('bob').screenTrack && w.inputs() === 'voice' && !w.K.capture.sound);
  w = world({ soundTrack: 'none', platform: 'win32' });
  await w.K.cast.add('bob', 'one');
  ok('A4 no sound track came at all: told, share goes on', w.toasts.some((t) => /sound was not captured/.test(t)) && w.held.get('bob').screenTrack && w.inputs() === 'voice');

  // A5: no microphone
  w = world({ micOk: false });
  await w.K.cast.add('bob', 'one');
  ok('A5 no microphone, but sound: the contact gets the sound alone, and I am told', w.inputs() === 'sound' && w.held.get('bob').micTrack.kind === 'mix' && w.toasts.some((t) => /only this computer's sound is sent/.test(t)));
  ok('A5 and captions have no voice to read', w.K.mic.voice === null);
  w = world({ micOk: false, soundTrack: 'none' });
  await w.K.cast.add('bob', 'one');
  ok('A5 no microphone and no sound: no audio, as before', !w.held.get('bob').micTrack && w.K.mic.state === 'idle');

  // A6: whichever starts first
  w = world();
  const dave = w.mk('dave'); dave.remote.screen = true;          // I watch Dave and talk to him: the microphone starts first
  await w.K.cast.talk(dave);
  ok('A6 talking before sharing: a mix with the microphone alone', w.inputs() === 'voice' && dave.micTrack.kind === 'mix');
  await w.K.cast.add('bob', 'one');
  ok('A6 the share starts: the sound joins the running mix', w.inputs() === 'sound+voice' && w.ctxs.length === 1);
  const snd = w.sound;
  w.K.cast.remove('bob');
  ok('A6 the share ends, the talk goes on: the sound leaves, the microphone stays', snd.readyState === 'ended' && w.inputs() === 'voice' && w.K.mic.state === 'live' && !w.ctxs[0].closed);

  w = world({ shareSound: false });
  const erin = w.mk('erin'); erin.remote.screen = true;
  await w.K.cast.talk(erin);                                     // a microphone started while the setting was off
  w.S.settings.shareSound = true;
  await w.K.cast.add('bob', 'one');
  ok('A6 a microphone already running without the mix: the sound is not asked for, and I am told it joins next time', w.gdmArgs[0].audio === false && !w.K.capture.sound && w.toasts.some((t) => /joins with your next share/.test(t)));

  // A7: never unattended
  w = world();
  await w.K.cast.add('box', 'one', { mic: false });
  ok('A7 a share that starts unattended: no sound asked for, no audio sent', w.gdmArgs[0].audio === false && !w.held.get('box').micTrack && !w.K.capture.sound && w.ctxs.length === 0);
})().catch((e) => { console.log('FAIL  sound test threw:', e.stack); process.exitCode = 1; });
