// Runs inside the hidden captioner window. Loads the WASM speech-to-text engine, then turns the PCM that
// main forwards (16 kHz mono Int16: the voice of a share the viewer is hearing, or this computer's own
// microphone and sound while they go out in a share) into caption lines. It never sees video and never reaches the network: engine, runtime and model all load from
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

const MAX_WAITING = 6;       // finished lines waiting for the recognizer; past this the oldest is dropped

let asr = null;
// One entry per stream being read: a contact's voice, or this computer's own audio ("~self" the microphone,
// "~sound" what the computer plays). They share the one recognizer, a line at a time.
const streams = new Map();   // name -> { seg, segLen, lastVoice, open, lastInterim, preroll, prerollLen }
const fresh = () => ({ seg: [], segLen: 0, lastVoice: 0, open: false, lastInterim: 0, preroll: [], prerollLen: 0 });
// This computer's own audio is only ever used a finished line at a time (it goes into the chat), so no live line
// is worked out for it: with two such streams the recognizer has no time to spare.
const finalsOnly = (pub) => pub[0] === '~';
let busy = false;
const jobs = [];

function rms(f32) { let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i]; return Math.sqrt(s / (f32.length || 1)); }
function flatten(chunks, len) { const out = new Float32Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
function clean(t) { t = (t || '').replace(/\s+/g, ' ').trim(); return DROP.has(t.toLowerCase()) ? '' : t; }

function want(samples, pub, final) {
  if (final) { jobs.push({ samples, pub, final: true }); if (jobs.length > MAX_WAITING) jobs.shift(); }   // finished lines wait their turn, in order
  else if (!busy && !jobs.length) jobs.push({ samples, pub, final: false });                              // a live line only when nothing else waits
  pump();
}
async function pump() {
  if (busy || !jobs.length) return;
  const job = jobs.shift(); busy = true;
  try { const out = await asr(job.samples); const t = clean(out && out.text); if (t && streams.has(job.pub)) window.cap.text(job.pub, t, job.final); }
  catch (e) { window.cap.stat('infer ' + (e && e.message || e)); }
  finally { busy = false; pump(); }
}

function feed(pub, ab) {
  const st = streams.get(pub);
  if (!st || !asr) return;
  const i16 = new Int16Array(ab);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  const now = Date.now(), voiced = rms(f) > VAD_RMS;

  // keep a short pre-roll so a line starts with its first word, not after it
  st.preroll.push(f); st.prerollLen += f.length;
  while (st.prerollLen > (PREROLL_MS / 1000) * RATE && st.preroll.length > 1) { st.prerollLen -= st.preroll.shift().length; }

  if (!st.open) {
    if (voiced) { st.open = true; st.lastVoice = now; st.lastInterim = 0; st.seg = st.preroll.slice(); st.segLen = st.prerollLen; }
    return;
  }
  st.seg.push(f); st.segLen += f.length;
  if (voiced) st.lastVoice = now;

  const segMs = (st.segLen / RATE) * 1000;
  const quietMs = now - st.lastVoice;
  if ((quietMs >= SILENCE_MS && segMs >= MIN_SEG_MS) || segMs >= MAX_SEG_MS) {
    want(flatten(st.seg, st.segLen), pub, true);                // line finished
    st.seg = []; st.segLen = 0; st.open = false; st.lastInterim = 0;
    return;
  }
  if (!finalsOnly(pub) && segMs >= MIN_SEG_MS && now - st.lastInterim >= INTERIM_MS) { st.lastInterim = now; want(flatten(st.seg, st.segLen), pub, false); }
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
  const drop = (pub) => { streams.delete(pub); for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].pub === pub) jobs.splice(i, 1); };
  if (msg.op === 'start' && typeof msg.pub === 'string' && msg.pub) { drop(msg.pub); streams.set(msg.pub, fresh()); }
  else if (msg.op === 'stop') { if (msg.pub) drop(msg.pub); else { streams.clear(); jobs.length = 0; } }   // one stream, or all of them
});
window.cap.onPcm((pub, ab) => { try { feed(pub, ab); } catch (e) { window.cap.stat('feed ' + e); } });

boot();
