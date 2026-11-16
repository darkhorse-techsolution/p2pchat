'use strict';
// Live captions, viewer side. When the setting is on and you are watching a contact's share, this taps the
// voice you are already hearing (sess.remote.audio), turns it into 16 kHz mono PCM and streams it to the
// hidden captioner window (through main), then paints the text it sends back over the video. It reads only
// the voice of the share on screen, and only while that share's Sharing indicator is up on the other side.
// The chat window cannot run the WASM recognizer itself (strict CSP), so the work happens in main/caption.js.
//
// The other way round (Settings: "Send captions of what I say..."): while my microphone goes to a contact in a
// share, the same recognizer reads my own microphone here, and every finished line is sent to that contact as a
// chat message of kind 'caption'. Text gets through a connection too weak for the picture, it stays in the thread,
// and I see each line in my own copy of the chat as it goes out. Only my microphone, never the computer's sound,
// and nothing while the microphone is muted. There is one recognizer: while it reads my voice, the captions over
// a share I watch pause.
//
// Reads from app.js: S, $, toast. Reads K.viewer, K.mic and K.sessions at call time.
(() => {
  const K = window.ShareKit;
  const enabled = () => !!(S.settings && S.settings.captions);
  const outOn = () => !!(S.settings && S.settings.captionsOut);
  const SELF = '~self';           // the recognizer's name for my own voice; no contact id looks like it
  // Who hears my microphone right now: a caption of what I say goes to them and to nobody else. A muted
  // microphone has none; an unattended share sends no microphone, so it has none either.
  const hearers = () => K.sessions.all().filter((x) => !x.closed && x.micTrack && x.micTrack.enabled && x.micTrack.readyState !== 'ended');
  const NOISE = /^[\[(].*[\])]$/;   // what the recognizer writes for a sound that is not speech: "[BLANK_AUDIO]", "(music)"

  let cur = null;                 // { pub, track, out, ctx, src, proc, gain }
  let idleTimer = null;
  let lines = [];                 // finalized caption lines (last two shown)
  let interim = '';               // the line still being spoken

  function downsample(buf, inRate, outRate) {
    if (outRate >= inRate) return Float32Array.from(buf);
    const ratio = inRate / outRate, outLen = Math.floor(buf.length / ratio), out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) { const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, buf.length - 1), f = idx - lo; out[i] = buf[lo] * (1 - f) + buf[hi] * f; }
    return out;
  }

  function startTap(want) {
    const track = want.track;
    let ctx;
    try { ctx = new AudioContext(); } catch { return; }
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const gain = ctx.createGain(); gain.gain.value = 0;        // the <audio> element plays the sound; this branch is silent
    let acc = new Int16Array(0);
    proc.onaudioprocess = (e) => {
      const d = downsample(e.inputBuffer.getChannelData(0), ctx.sampleRate, 16000);
      const i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) { const s = Math.max(-1, Math.min(1, d[i])); i16[i] = s < 0 ? s * 32768 : s * 32767; }
      const merged = new Int16Array(acc.length + i16.length); merged.set(acc); merged.set(i16, acc.length); acc = merged;
      if (acc.length >= 4000) { try { window.api.captionPcm(want.pub, acc.buffer.slice(0)); } catch {} acc = new Int16Array(0); }
    };
    src.connect(proc); proc.connect(gain); gain.connect(ctx.destination);
    ctx.resume && ctx.resume().catch(() => {});
    cur = { pub: want.pub, track, out: !!want.out, ctx, src, proc, gain };
    window.api.captionOn(want.pub).catch(() => {});
  }

  function stopTap() {
    if (!cur) return;
    try { cur.proc.onaudioprocess = null; cur.src.disconnect(); cur.proc.disconnect(); cur.gain.disconnect(); cur.ctx.close(); } catch {}
    window.api.captionOff().catch(() => {});
    cur = null;
    clear();
  }

  // Start, stop or switch the tap: my own microphone while someone hears it and the setting is on, else the
  // share currently on screen. Called whenever either can change (every paint of the share controls).
  function sync() {
    const voice = outOn() && K.mic && K.mic.state === 'live' ? K.mic.voice : null;   // the microphone alone: the device's own track may be a mix with the computer's sound
    const b = K.viewer.bound;
    const want = voice && hearers().length ? { pub: SELF, track: voice, out: true }
      : enabled() && b && b.remote && b.remote.audio ? { pub: b.pub, track: b.remote.audio } : null;
    if (cur && (!want || want.pub !== cur.pub || (cur.out && want.track !== cur.track))) stopTap();
    if (want && !cur) startTap(want);
    if (!want) clear();
  }
  function sendOut(text) {
    if (NOISE.test(text)) return;
    for (const x of hearers()) window.api.send(x.pub, { kind: 'caption', text }).catch(() => {});
  }

  // --- overlay -------------------------------------------------------------------------------
  const box = () => K.el('viewerCaptions');   // kept by K.el: the viewer can be in a window of its own
  function render() {
    const el = box(); if (!el) return;
    const shown = lines.slice(-2);
    if (interim) shown.push(interim);
    const text = shown.join('\n').trim();
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }
  function clear() { lines = []; interim = ''; clearTimeout(idleTimer); render(); }
  function bumpIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { lines = []; interim = ''; render(); }, 7000); }

  function onText(ev) {
    if (!cur || ev.pub !== cur.pub) return;
    const t = (ev.text || '').trim(); if (!t) return;
    if (cur.out) { if (ev.final) sendOut(t); return; }   // my own voice: finished lines go into the chat, nothing over the video
    if (ev.final) { lines.push(t); if (lines.length > 6) lines = lines.slice(-6); interim = ''; }
    else interim = t;
    render(); bumpIdle();
  }

  function onStatus(ev) {
    if (!ev) return;
    if (ev.state === 'downloading') toast(`Getting captions ready... ${ev.pct || 0}%`, '');
    else if (ev.state === 'ready') toast('Live captions ready', 'ok');
    else if (ev.state === 'error') toast(`Captions unavailable: ${ev.message || 'failed to start'}`, 'err');
  }

  K.caption = { sync, onText, onStatus, clear, active: () => !!cur, sending: (sess) => !!(cur && cur.out && hearers().includes(sess)) };
})();
