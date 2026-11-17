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
// and I see each line in my own copy of the chat as it goes out. Nothing while the microphone is muted. When this
// computer's sound goes out with the share too (Settings, "Also send this computer's sound"), it is read as a
// second stream of its own, and its lines are sent marked as the computer's sound, never as my words. Only what
// actually goes out is read: an unattended share reads neither unless the owner turned on unattended audio, which
// gives it a real microphone the same as any share. There is one recognizer: while it reads
// this computer, the captions over a share I watch pause.
//
// Each line is streamed ahead of itself too: while it is still forming, sendLive sends it as an ephemeral
// 'capline' (never stored), so the other side sees the words build before the finished line lands in the chat.
// The receiving half here (onLive/onFinal) shows a contact's streamed captions as the live line under the open
// chat and as the subtitle over their screen, and clears each on the finished 'caption' message; while a contact
// streams, my own recognizer leaves their share alone (sync, receiving()).
//
// Reads from app.js: S, $, toast. Reads K.viewer, K.mic, K.capture and K.sessions at call time.
(() => {
  const K = window.ShareKit;
  const enabled = () => !!(S.settings && S.settings.captions);
  const outOn = () => !!(S.settings && S.settings.captionsOut);
  const SELF = '~self', SOUND = '~sound';   // the recognizer's names for my voice and for this computer's sound; no contact id looks like them
  // Who hears my microphone right now: a caption of what I say goes to them and to nobody else. A muted
  // microphone has none; an unattended share sends no microphone, so it has none either. The computer's sound
  // rides the same track, so the same contacts hear it, and the same mute stops it.
  const hearers = () => K.sessions.all().filter((x) => !x.closed && x.micTrack && x.micTrack.enabled && x.micTrack.readyState !== 'ended');
  const NOISE = /^[\[(].*[\])]$/;   // what the recognizer writes for a sound that is not speech: "[BLANK_AUDIO]", "(music)"

  const taps = new Map();         // stream name -> { pub, track, out, ctx, src, proc, gain }; out: 'voice' | 'sound' | '' (a share I watch)
  let idleTimer = null;
  let lines = [];                 // finalized caption lines (last two shown), from a share I watch and caption here
  let interim = '';               // the line still being spoken, same source
  let capSeq = 0;                 // orders the live lines I stream out, so a late one cannot overwrite a newer

  // Captions a contact streams to me: the live (still-forming) line and the last finished line, per source, per
  // contact. The finished lines also arrive as ordinary 'caption' messages (onFinal) - that is what the thread
  // shows and what clears the live line. Live only: nothing here is stored. { live: {'' , sound}, fin: {...}, ts }
  const recv = new Map();
  const RECV_HOLD = 10000;        // after this much quiet a contact counts as no longer streaming, and my recognizer may take the watched share back
  let recvTimer = null;

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
    taps.set(want.pub, { pub: want.pub, track, out: want.out || '', ctx, src, proc, gain });
    window.api.captionOn(want.pub).catch(() => {});
  }

  function stopTap(pub) {
    const t = taps.get(pub);
    if (!t) return;
    try { t.proc.onaudioprocess = null; t.src.disconnect(); t.proc.disconnect(); t.gain.disconnect(); t.ctx.close(); } catch {}
    window.api.captionOff(pub).catch(() => {});
    taps.delete(pub);
    if (!t.out) clear();
  }

  // Start, stop or switch the taps: what this computer sends while someone hears it and the setting is on (my
  // microphone, and the computer's sound when it is in the mix that goes out), else the share currently on screen.
  // Called whenever any of that can change (every paint of the share controls).
  function sync() {
    const wants = [];
    if (outOn() && K.mic && K.mic.state === 'live' && hearers().length) {
      if (K.mic.voice) wants.push({ pub: SELF, track: K.mic.voice, out: 'voice' });   // the microphone alone, never the mix
      const snd = K.capture && K.capture.sound;
      if (snd && snd.readyState === 'live' && K.mic.mix && K.mic.mix.has('sound')) wants.push({ pub: SOUND, track: snd, out: 'sound' });
    }
    const b = K.viewer.bound;
    if (!wants.length && enabled() && b && b.remote && b.remote.audio && !receiving(b.pub)) wants.push({ pub: b.pub, track: b.remote.audio });
    for (const t of [...taps.values()]) {
      const w = wants.find((x) => x.pub === t.pub);
      if (!w || (t.out && w.track !== t.track)) stopTap(t.pub);
    }
    for (const w of wants) if (!taps.has(w.pub)) startTap(w);
    if (!wants.some((w) => !w.out)) clear();
  }
  // src: 'voice' my microphone, 'sound' what this computer played. The mark travels in the message's lang field.
  function sendOut(text, src) {
    if (NOISE.test(text) || !/[\p{L}\p{N}]/u.test(text)) return;   // "(music)", or notes and dots with no word in them
    for (const x of hearers()) window.api.send(x.pub, { kind: 'caption', text, lang: src === 'sound' ? 'sound' : '' }).catch(() => {});
  }
  // The live line while a sentence is still forming: streamed to the same hearers, ahead of the finished line that
  // sendOut then sends. Ephemeral (window.api.capLive, never stored); the finished line is the record. seq lets the
  // other side drop a frame that arrives out of order.
  function sendLive(text, src) {
    if (NOISE.test(text) || !/[\p{L}\p{N}]/u.test(text)) return;
    const seq = ++capSeq, lang = src === 'sound' ? 'sound' : '';
    for (const x of hearers()) window.api.capLive(x.pub, { text, lang, seq }).catch(() => {});
  }

  // --- captions a contact streams to me -----------------------------------------------------
  const entry = (pub) => { let e = recv.get(pub); if (!e) { e = { live: { '': null, sound: null }, fin: { '': '', sound: '' }, ts: 0 }; recv.set(pub, e); } return e; };
  const receiving = (pub) => { const e = recv.get(pub); return !!e && Date.now() - e.ts < RECV_HOLD; };
  function recvArm() { clearTimeout(recvTimer); recvTimer = setTimeout(() => { let any = false; for (const [, e] of recv) { if (Date.now() - e.ts >= 7000) { e.live[''] = null; e.live.sound = null; } else any = true; } render(); if (any) recvArm(); }, 7000); }
  // ev: { pub, text, lang, seq } - the still-forming line. Keep it if it is newer than the one shown, or if a gap
  // (over 2 s since the last frame) means a new line, or their app restarted and seq began again.
  function onLive(ev) {
    if (!ev || !ev.pub) return;
    const lang = ev.lang === 'sound' ? 'sound' : '', e = entry(ev.pub), cur = e.live[lang], now = Date.now();
    if (cur && (ev.seq | 0) <= cur.seq && now - e.ts <= 2000) return;
    e.live[lang] = { text: String(ev.text || ''), seq: ev.seq | 0 }; e.ts = now;
    recvArm(); render();
  }
  // A finished 'caption' message from a contact arrived (app.js): the sentence is done, so its live line is cleared
  // (the thread now holds it) and kept as the last finished line for the subtitle over their screen.
  function onFinal(pub, msg) {
    if (!pub || !msg) return;
    const lang = msg.lang === 'sound' ? 'sound' : '', e = entry(pub);
    e.live[lang] = null; e.fin[lang] = String(msg.text || ''); e.ts = Date.now();
    render();
  }
  // The subtitle over a contact's screen: whatever is forming now (voice and sound), else their last finished line.
  function recvText(pub) {
    const e = recv.get(pub); if (!e) return '';
    const live = [e.live[''], e.live.sound].filter(Boolean).map((x) => x.text);
    const out = live.length ? live : [e.fin[''] || e.fin.sound].filter(Boolean);
    return out.join('\n').trim();
  }

  // --- overlay -------------------------------------------------------------------------------
  const box = () => K.el('viewerCaptions');   // kept by K.el: the viewer can be in a window of its own
  function render() {
    // The subtitle over the share on screen: a contact's own streamed captions while they are sending them,
    // otherwise what my recognizer makes of the share I watch. One or the other, never both at once.
    const el = box();
    if (el) {
      const b = K.viewer.bound, fromThem = b && receiving(b.pub) ? recvText(b.pub) : '';
      let text = fromThem;
      if (!text) { const shown = lines.slice(-2); if (interim) shown.push(interim); text = shown.join('\n').trim(); }
      el.textContent = text; el.classList.toggle('hidden', !text);
    }
    // The live line under the open chat: the still-forming caption a contact is streaming me, if any. The finished
    // lines are ordinary messages in the thread; this is only the one not yet finished.
    const cl = $('capLive');
    if (cl) {
      const e = S.current ? recv.get(S.current) : null;
      const txt = e ? [e.live[''], e.live.sound].filter(Boolean).map((x) => x.text).join('\n') : '';
      cl.textContent = txt; cl.classList.toggle('hidden', !txt);
    }
  }
  function clear() { lines = []; interim = ''; clearTimeout(idleTimer); render(); }
  function bumpIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(() => { lines = []; interim = ''; render(); }, 7000); }

  function onText(ev) {
    const tap = taps.get(ev.pub);
    if (!tap) return;
    const t = (ev.text || '').trim(); if (!t) return;
    if (tap.out) { if (ev.final) sendOut(t, tap.out); else sendLive(t, tap.out); return; }   // my own: finished lines into the chat, the live line streamed ahead of each
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

  K.caption = { sync, onText, onStatus, clear, onLive, onFinal, repaint: render, receiving, active: () => taps.size > 0, sending: (sess) => [...taps.values()].some((t) => t.out) && hearers().includes(sess) };
})();
