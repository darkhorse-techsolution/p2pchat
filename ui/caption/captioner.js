// Runs inside the hidden captioner window. Loads the WASM speech-to-text engine, then turns the voice
// PCM that main forwards (16 kHz mono Int16, from the share the viewer is already hearing) into caption
// lines. It never sees video and never reaches the network: engine, runtime and model all load from
// p2pcap:// (app resources + the model downloaded into userData). Text goes back to main, which paints
// it over the viewer. See main/caption.js and ui/share/caption.js.
'use strict';

const RATE = 16000;
const VAD_RMS = 0.012;       // above this a 250 ms frame counts as speech
const SILENCE_MS = 650;      // this much quiet after speech closes a line
const MIN_SEG_MS = 480;      // a segment shorter than this is a blip, not words
const MAX_SEG_MS = 12000;    // force a line out so latency stays bounded
const INTERIM_MS = 1100;     // while still speaking, refresh the live line this often
const PREROLL_MS = 240;      // keep a little audio from just before onset

const MODEL_ID = 'whisper-tiny.en';
const DROP = new Set(['', 'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching.', 'bye', 'bye.', '.', '....']);

let asr = null, activePub = null;
let seg = [], segLen = 0, segStart = 0, lastVoice = 0, open = false, lastInterim = 0;
let preroll = [], prerollLen = 0;
let busy = false, queued = null;

function rms(f32) { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / (f32.length || 1)); }
function flatten(chunks, len) { const out = new Float32Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
function clean(t) { t = (t || '').replace(/\s+/g, ' ').trim(); return DROP.has(t.toLowerCase()) ? '' : t; }

function want(samples, pub, final) {
  if (final) queued = { samples, pub, final: true };            // a finished line always takes the next slot
  else if (!busy && !queued) queued = { samples, pub, final: false };
  pump();
}
async function pump() {
  if (busy || !queued) return;
  const job = queued; queued = null; busy = true;
  try { const out = await asr(job.samples); const t = clean(out && out.text); if (t) window.cap.text(job.pub, t, job.final); }
  catch (e) { window.cap.stat('infer ' + (e && e.message || e)); }
  finally { busy = false; if (queued) pump(); }
}

function reset() { seg = []; segLen = 0; open = false; lastInterim = 0; }

function feed(pub, ab) {
  if (pub !== activePub || !asr) return;
  const i16 = new Int16Array(ab);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  const now = Date.now(), voiced = rms(f) > VAD_RMS;

  // keep a short pre-roll so a line starts with its first word, not after it
  preroll.push(f); prerollLen += f.length;
  while (prerollLen > (PREROLL_MS / 1000) * RATE && preroll.length > 1) { prerollLen -= preroll.shift().length; }

  if (!open) {
    if (voiced) { open = true; segStart = now; lastVoice = now; lastInterim = 0; seg = preroll.slice(); segLen = prerollLen; }
    return;
  }
  seg.push(f); segLen += f.length;
  if (voiced) lastVoice = now;

  const segMs = (segLen / RATE) * 1000;
  const quietMs = now - lastVoice;
  if ((quietMs >= SILENCE_MS && segMs >= MIN_SEG_MS) || segMs >= MAX_SEG_MS) {
    want(flatten(seg, segLen), pub, true);                      // line finished
    reset();
    return;
  }
  if (segMs >= MIN_SEG_MS && now - lastInterim >= INTERIM_MS) { lastInterim = now; want(flatten(seg, segLen), pub, false); }
}

async function boot() {
  try {
    window.cap.stat('loading engine');
    const { pipeline, env } = await import('p2pcap://app/cap-engine.mjs');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = 'p2pcap://app/models';
    env.backends.onnx.wasm = env.backends.onnx.wasm || {};
    env.backends.onnx.wasm.numThreads = 1;                      // single thread: no worker, no cross-origin isolation needed
    env.backends.onnx.wasm.wasmPaths = 'p2pcap://app/engine/';
    window.cap.stat('loading model');
    asr = await pipeline('automatic-speech-recognition', MODEL_ID, { device: 'wasm', dtype: 'q8' });
    window.cap.stat('model ready');
    window.cap.ready();
  } catch (e) { window.cap.fail((e && e.stack) || String(e)); }
}

window.cap.onControl((msg) => {
  if (!msg) return;
  if (msg.op === 'start') { activePub = msg.pub; preroll = []; prerollLen = 0; reset(); queued = null; }
  else if (msg.op === 'stop') { activePub = null; preroll = []; prerollLen = 0; reset(); queued = null; }
});
window.cap.onPcm((pub, ab) => { try { feed(pub, ab); } catch (e) { window.cap.stat('feed ' + e); } });

boot();
