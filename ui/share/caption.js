'use strict';
// Live captions, viewer side. When the setting is on and you are watching a contact's share, this taps the
// voice you are already hearing (sess.remote.audio), turns it into 16 kHz mono PCM and streams it to the
// hidden captioner window (through main), then paints the text it sends back over the video. It reads only
// the voice of the share on screen, and only while that share's Sharing indicator is up on the other side.
// The chat window cannot run the WASM recognizer itself (strict CSP), so the work happens in main/caption.js.
//
// Reads from app.js: S, $, toast. Reads K.viewer at call time.
(() => {
  const K = window.ShareKit;
  const enabled = () => !!(S.settings && S.settings.captions);

  let cur = null;                 // { pub, ctx, src, proc, gain }
  let idleTimer = null;
  let lines = [];                 // finalized caption lines (last two shown)
  let interim = '';               // the line still being spoken

  function downsample(buf, inRate, outRate) {
    if (outRate >= inRate) return Float32Array.from(buf);
    const ratio = inRate / outRate, outLen = Math.floor(buf.length / ratio), out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) { const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, buf.length - 1), f = idx - lo; out[i] = buf[lo] * (1 - f) + buf[hi] * f; }
    return out;
  }

  function startTap(sess) {
    const track = sess.remote && sess.remote.audio;
    if (!track) return;
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
      if (acc.length >= 4000) { try { window.api.captionPcm(sess.pub, acc.buffer.slice(0)); } catch {} acc = new Int16Array(0); }
    };
    src.connect(proc); proc.connect(gain); gain.connect(ctx.destination);
    ctx.resume && ctx.resume().catch(() => {});
    cur = { pub: sess.pub, ctx, src, proc, gain };
    window.api.captionOn(sess.pub).catch(() => {});
  }

  function stopTap() {
    if (!cur) return;
    try { cur.proc.onaudioprocess = null; cur.src.disconnect(); cur.proc.disconnect(); cur.gain.disconnect(); cur.ctx.close(); } catch {}
    window.api.captionOff().catch(() => {});
    cur = null;
    clear();
  }

  // Start, stop or switch the tap to the share currently on screen. Called whenever that can change.
  function sync() {
    const want = enabled() && K.viewer.bound && K.viewer.bound.remote && K.viewer.bound.remote.audio ? K.viewer.bound : null;
    if (cur && (!want || want.pub !== cur.pub)) stopTap();
    if (want && !cur) startTap(want);
    if (!want) clear();
  }

  // --- overlay -------------------------------------------------------------------------------
  const box = () => document.getElementById('viewerCaptions');
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

  K.caption = { sync, onText, onStatus, clear, active: () => !!cur };
})();
