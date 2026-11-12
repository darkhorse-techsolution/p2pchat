'use strict';
// Live captions for a screen share, main-process side. The caption engine is WebAssembly and the app's
// chat window runs under a strict CSP that forbids WASM, so the recognition happens in a separate hidden
// window (ui/caption/) with its own narrow CSP. This module owns that window, serves its files over the
// p2pcap:// protocol, downloads the engine runtime and model once (opt-in), and relays voice PCM in and
// caption text out. It never touches video; it only sees the voice the viewer is already hearing.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Engine runtime (version-matched to ui/caption/cap-engine.mjs) and the tiny English model, hosted as
// release assets so the JS and WASM versions never drift. Downloaded once into userData/caption and
// verified by size + SHA-256 before use. ~70 MB total; nothing is fetched unless captions are turned on.
const REL_BASE = 'https://github.com/darkhorse-techsolution/p2pchat/releases/download/caption-assets-v1/';
const MANIFEST = [
  { rel: 'engine/ort-wasm-simd-threaded.asyncify.mjs', size: 53057, sha256: '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611' },
  { rel: 'engine/ort-wasm-simd-threaded.asyncify.wasm', size: 26861777, sha256: '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082' },
  { rel: 'models/whisper-tiny.en/config.json', size: 2202, sha256: '37a1073be00d19118c06557896c7c148598f4d8277edc0f5bc07c9f5554839f1' },
  { rel: 'models/whisper-tiny.en/generation_config.json', size: 1590, sha256: '132c95ba9db45f4498f2eab3fea7c1d6a174005010f8f6b7d20cfd5e9795996b' },
  { rel: 'models/whisper-tiny.en/preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
  { rel: 'models/whisper-tiny.en/tokenizer.json', size: 2128494, sha256: 'c6ee8f089220a5b1188f6426456772572671c6141ae007eecb83c6a8349f5deb' },
  { rel: 'models/whisper-tiny.en/tokenizer_config.json', size: 835, sha256: 'e082c1ad251541bf277967a703252cddd4bb37a71a43737e03d050c22ec08238' },
  { rel: 'models/whisper-tiny.en/onnx/encoder_model_quantized.onnx', size: 10124913, sha256: '8cc3c6f8563d1b3fbd2c5af9f64c2bed8b020bc593c402d1ef53b9f08fbf1b90' },
  { rel: 'models/whisper-tiny.en/onnx/decoder_model_merged_quantized.onnx', size: 30727382, sha256: 'dbb2e063b7fbc41d9803b9698f93ecb035c50cbb3fb87b56cb131e4a5eb99059' },
];
const assetName = (rel) => rel.replace(/\//g, '__');
const APP_FILES = new Set(['captioner.html', 'captioner.js', 'cap-engine.mjs']);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream' };

function createCaptioner({ app, protocol, BrowserWindow, ipcMain, log, push }) {
  const APP_DIR = path.join(__dirname, '..', 'ui', 'caption');
  const USER_DIR = path.join(app.getPath('userData'), 'caption');
  let win = null, ready = false, enabling = false, activePub = null;

  const within = (base, p) => { const r = path.resolve(p), b = path.resolve(base); return r === b || r.startsWith(b + path.sep); };

  function serve(rel) {
    let base = null, fp = null;
    if (APP_FILES.has(rel)) { base = APP_DIR; fp = path.join(APP_DIR, rel); }
    else if (rel.startsWith('engine/') || rel.startsWith('models/')) { base = USER_DIR; fp = path.join(USER_DIR, rel); }
    if (!fp || !within(base, fp)) return new Response(null, { status: 404 });
    try { return new Response(fs.readFileSync(fp), { headers: { 'content-type': TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } }); }
    catch { return new Response(null, { status: 404 }); }
  }
  function handleProtocol() { protocol.handle('p2pcap', (req) => serve(decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, ''))); }

  const have = (e) => { try { return fs.statSync(path.join(USER_DIR, e.rel)).size === e.size; } catch { return false; } };
  const missing = () => MANIFEST.filter((e) => !have(e));

  async function download(list) {
    const total = list.reduce((a, e) => a + e.size, 0); let got = 0, n = 0;
    for (const e of list) {
      const fp = path.join(USER_DIR, e.rel); fs.mkdirSync(path.dirname(fp), { recursive: true });
      const resp = await fetch(REL_BASE + assetName(e.rel));
      if (!resp.ok) throw new Error(`download ${e.rel}: HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (crypto.createHash('sha256').update(buf).digest('hex') !== e.sha256) throw new Error(`checksum failed: ${e.rel}`);
      const tmp = fp + '.part'; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, fp);
      got += e.size; n++;
      push('caption-status', { state: 'downloading', pct: Math.round((got / total) * 100), file: n, files: list.length });
    }
  }

  async function ensureAssets() {
    fs.mkdirSync(USER_DIR, { recursive: true });
    const miss = missing();
    if (!miss.length) return;
    log.info('caption: downloading', miss.length, 'asset(s)');
    push('caption-status', { state: 'downloading', pct: 0, file: 0, files: miss.length });
    await download(miss);
  }

  function makeWindow() {
    win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(APP_DIR, 'captioner-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, devTools: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('console-message', (d) => { if (d && (d.level === 'error' || d.level === 2)) log.error('captioner', d.message); });
    win.webContents.on('render-process-gone', (_e, d) => { log.error('captioner gone', d && d.reason); ready = false; push('caption-status', { state: 'error', message: 'captioner stopped' }); });
    win.on('closed', () => { win = null; ready = false; });
    win.loadURL('p2pcap://app/captioner.html').catch((e) => log.error('captioner load', e));
  }

  async function setEnabled(on) {
    if (on) {
      if (win || enabling) return;
      enabling = true;
      try { await ensureAssets(); push('caption-status', { state: 'loading' }); makeWindow(); }
      catch (e) { log.error('caption enable', e); push('caption-status', { state: 'error', message: String((e && e.message) || e).slice(0, 200) }); }
      finally { enabling = false; }
    } else {
      activePub = null; ready = false;
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      push('caption-status', { state: 'off' });
    }
  }

  function start(pub) { activePub = pub || null; if (win && ready && !win.isDestroyed() && activePub) win.webContents.send('cap-control', { op: 'start', pub: activePub }); }
  function stop() { if (win && ready && !win.isDestroyed()) win.webContents.send('cap-control', { op: 'stop' }); activePub = null; }
  function feed(pub, buf) { if (win && ready && !win.isDestroyed() && pub === activePub) win.webContents.send('cap-pcm', pub, buf); }

  const fromCap = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on('cap-ready', (e) => { if (!fromCap(e)) return; ready = true; push('caption-status', { state: 'ready' }); if (activePub) win.webContents.send('cap-control', { op: 'start', pub: activePub }); });
  ipcMain.on('cap-text', (e, pub, text, final) => { if (!fromCap(e)) return; push('caption', { pub, text: String(text || '').slice(0, 400), final: !!final }); });
  ipcMain.on('cap-stat', (e, m) => { if (!fromCap(e)) return; log.info('captioner', m); });
  ipcMain.on('cap-fail', (e, m) => { if (!fromCap(e)) return; log.error('captioner', m); push('caption-status', { state: 'error', message: String(m).slice(0, 200) }); });

  return { handleProtocol, setEnabled, start, stop, feed, isReady: () => ready, assetsPresent: () => missing().length === 0, USER_DIR };
}
module.exports = { createCaptioner };
