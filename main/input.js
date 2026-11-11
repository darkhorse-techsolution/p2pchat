'use strict';
// Remote control of the shared display. The viewer's mouse and keyboard events arrive in the
// renderer over the share's data channel and come here (main.js `input`); this module maps
// them to the shared display and feeds a small helper process that posts them to the OS:
// a compiled Swift binary on macOS (CGEvent, needs Accessibility), python3 + XTest on
// Linux/X11, PowerShell + SendInput on Windows. No native Node module, nothing to rebuild per
// Electron version. The helper runs only while the sharer allows control; it releases every
// held key and button when told to reset and when its stdin closes.
// With `dry` (a dev run started with --dry-input, see main.js) no helper is ever started: start
// and stop only flip a flag and every event is counted and dropped, so control can be tested on a
// machine that must not be driven.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// DOM KeyboardEvent.code (the physical key) -> what the helper needs.
// macOS: CGKeyCode (kVK_*). Linux: X11 keysym. Windows: scan code, bit 0x100 = extended (E0).
const MAC = { KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9, IntlBackslash: 10, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35,
  Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53,
  MetaRight: 54, MetaLeft: 55, ShiftLeft: 56, CapsLock: 57, AltLeft: 58, ControlLeft: 59, ShiftRight: 60, AltRight: 61, ControlRight: 62, Fn: 63,
  F17: 64, NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71, AudioVolumeUp: 72, AudioVolumeDown: 73, AudioVolumeMute: 74, NumpadDivide: 75, NumpadEnter: 76, NumpadSubtract: 78, F18: 79, F19: 80, NumpadEqual: 81,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89, F20: 90, Numpad8: 91, Numpad9: 92,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105, F16: 106, F14: 107, F10: 109, ContextMenu: 110, F12: 111, F15: 113, Insert: 114, Home: 115, PageUp: 116, Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126 };
const LINUX = { Enter: 0xff0d, Tab: 0xff09, Space: 0x20, Backspace: 0xff08, Escape: 0xff1b, Delete: 0xffff, Insert: 0xff63, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4, CapsLock: 0xffe5,
  MetaLeft: 0xffeb, MetaRight: 0xffec, AltLeft: 0xffe9, AltRight: 0xffea, ContextMenu: 0xff67, NumLock: 0xff7f, ScrollLock: 0xff14, Pause: 0xff13, PrintScreen: 0xff61,
  Minus: 0x2d, Equal: 0x3d, BracketLeft: 0x5b, BracketRight: 0x5d, Semicolon: 0x3b, Quote: 0x27, Backquote: 0x60, Backslash: 0x5c, Comma: 0x2c, Period: 0x2e, Slash: 0x2f, IntlBackslash: 0x3c,
  NumpadEnter: 0xff8d, NumpadMultiply: 0xffaa, NumpadAdd: 0xffab, NumpadSubtract: 0xffad, NumpadDecimal: 0xffae, NumpadDivide: 0xffaf, NumpadEqual: 0xffbd,
  AudioVolumeMute: 0x1008ff12, AudioVolumeDown: 0x1008ff11, AudioVolumeUp: 0x1008ff13 };
for (let i = 0; i < 26; i++) LINUX['Key' + String.fromCharCode(65 + i)] = 0x61 + i;          // a..z (the keymap adds Shift)
for (let i = 0; i < 10; i++) { LINUX['Digit' + i] = 0x30 + i; LINUX['Numpad' + i] = 0xffb0 + i; }
for (let i = 1; i <= 12; i++) LINUX['F' + i] = 0xffbe + i - 1;
for (let i = 13; i <= 20; i++) LINUX['F' + i] = 0xffca + i - 13;
const WIN = { Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0x11c, ControlRight: 0x11d, NumpadDivide: 0x135, PrintScreen: 0x137, AltRight: 0x138, Home: 0x147, ArrowUp: 0x148, PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d, End: 0x14f,
  ArrowDown: 0x150, PageDown: 0x151, Insert: 0x152, Delete: 0x153, MetaLeft: 0x15b, MetaRight: 0x15c, ContextMenu: 0x15d };
const KEYS = process.platform === 'darwin' ? MAC : process.platform === 'linux' ? LINUX : WIN;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const READY_MS = 15000;   // PowerShell compiles its P/Invoke shim first (a few seconds)

function createController({ log, helpersDir, screen, systemPreferences, dry }) {
  const platform = process.platform;
  let proc = null, display = null, events = 0, dropped = 0, stopping = false, dryOn = false;
  const api = { onExit: null, onCursor: null };

  function helper() {
    if (platform === 'darwin') return { cmd: path.join(helpersDir, 'p2pchat-input'), args: [], name: 'p2pchat-input' };
    if (platform === 'linux') return { cmd: 'python3', args: ['-I', path.join(helpersDir, 'input-linux.py')], name: 'python3' };
    if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(helpersDir, 'input-win.ps1')], name: 'powershell' };
    return null;
  }
  function available() {
    if (dry) return { ok: true };
    const h = helper();
    if (!h) return { ok: false, reason: 'platform', message: 'Remote control is not available on this system' };
    if (platform === 'linux') {
      if ((process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || !process.env.DISPLAY) return { ok: false, reason: 'wayland', message: 'Remote control needs an X11 session on Linux (this one is Wayland or has no display)' };
    }
    if (platform === 'darwin') {
      if (!fs.existsSync(h.cmd)) return { ok: false, reason: 'helper', message: 'The input helper is missing from this build (main/helpers/make-mac.sh builds it)' };
      let trusted = false;
      try { trusted = systemPreferences.isTrustedAccessibilityClient(false); } catch {}
      if (!trusted) {
        try { systemPreferences.isTrustedAccessibilityClient(true); } catch {}   // lists the app under Accessibility and shows the system prompt
        return { ok: false, reason: 'accessibility', message: 'macOS has to let P2P Chat control the computer first: System Settings → Privacy & Security → Accessibility, turn on P2P Chat (it was just added there), then allow control again' };
      }
    }
    return { ok: true };
  }

  // Starts the helper for `disp` (an Electron Display: the one being shared). Resolves once the
  // helper says it is ready, so a missing python3 or a refused X display fails here, not later.
  function start(disp) {
    const a = available();
    if (!a.ok) return Promise.resolve(a);
    display = { id: disp.id, bounds: disp.bounds, scaleFactor: disp.scaleFactor };
    if (dry) { dryOn = true; events = dropped = 0; return Promise.resolve({ ok: true }); }
    if (proc) return Promise.resolve({ ok: true });
    const h = helper();
    return new Promise((resolve) => {
      let p, settled = false, err = '';
      const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      try { p = spawn(h.cmd, h.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (e) { return done({ ok: false, reason: 'helper', message: `The input helper could not start: ${e.message}` }); }
      proc = p; events = 0; dropped = 0; stopping = false;
      const timer = setTimeout(() => { if (proc === p) stop('no ready'); done({ ok: false, reason: 'helper', message: 'The input helper did not start in time' }); }, READY_MS);
      p.stderr.on('data', (d) => {
        err += String(d); const lines = err.split('\n'); err = lines.pop();
        for (const l of lines) { const t = l.trim(); if (!t) continue; log.info('input helper:', t); if (t.startsWith('ready')) done({ ok: true }); }
      });
      let out = '';   // the macOS helper reports the system cursor shape here (main/helpers/input-mac.swift pollCursor)
      p.stdout.on('data', (d) => {
        out += String(d); const lines = out.split('\n'); out = lines.pop(); if (out.length > 400000) out = '';
        for (const l of lines) {
          if (!l.startsWith('cursor ') || proc !== p) continue;
          const [, w, h, pw, ph, hx, hy, png] = l.split(' ');
          if (png && png.length <= 300000 && api.onCursor) api.onCursor({ w: +w, h: +h, pw: +pw, ph: +ph, hx: +hx, hy: +hy, png });
        }
      });
      p.stdin.on('error', (e) => log.error('input helper stdin', e.message));
      p.on('error', (e) => { log.error('input helper', e); if (proc === p) { proc = null; display = null; } done({ ok: false, reason: 'helper', message: `The input helper could not start: ${e.code === 'ENOENT' ? `${h.name} is not installed` : e.message}` }); if (!stopping && settled && api.onExit) api.onExit(`helper error: ${e.message}`); });
      p.on('exit', (code, sig) => { log.info('input helper exit', code, sig); if (proc === p) { proc = null; display = null; if (!stopping && api.onExit) api.onExit(`the input helper exited (${code ?? sig})`); } done({ ok: false, reason: 'helper', message: `The input helper exited at once (${code ?? sig})` }); });
      log.info('input helper start', h.name, 'display', display.id, JSON.stringify(display.bounds));
    });
  }

  function stop(why) {
    if (dry) { dryOn = false; display = null; return; }
    const p = proc; display = null;
    if (!p) return;
    stopping = true; proc = null;
    try { p.stdin.write('r\n'); p.stdin.end(); } catch {}
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 1500);
    p.once('exit', () => clearTimeout(t));
    log.info('input helper stop', why, 'events', events, 'dropped', dropped);
  }

  // One event from the viewer: x/y are fractions of the shared display (0..1).
  function event(ev) {
    if ((!proc && !dryOn) || !display || !ev || typeof ev !== 'object') return;
    const b = display.bounds;
    const at = (nx, ny) => {
      const dip = { x: b.x + clamp01(nx) * b.width, y: b.y + clamp01(ny) * b.height };
      let p = dip;
      if (platform !== 'darwin') { try { p = screen.dipToScreenPoint(dip); } catch { p = { x: dip.x * display.scaleFactor, y: dip.y * display.scaleFactor }; } }
      return `${Math.round(p.x)} ${Math.round(p.y)}`;
    };
    const lim = (v, m) => Math.max(-m, Math.min(m, Math.round(Number(v) || 0)));
    let line;
    switch (ev.t) {
      case 'm': line = `m ${at(ev.x, ev.y)}`; break;
      case 'b': { const btn = [0, 1, 2].includes(ev.b) ? ev.b : -1; if (btn < 0) { dropped++; return; } line = `${ev.d ? 'd' : 'u'} ${btn} ${at(ev.x, ev.y)}`; break; }
      case 'w': line = `w ${lim(ev.dx, 4000)} ${lim(ev.dy, 4000)} ${at(ev.x, ev.y)}`; break;
      case 'k': {
        const code = typeof ev.c === 'string' && Object.hasOwn(KEYS, ev.c) ? KEYS[ev.c] : undefined;
        if (code === undefined) { dropped++; return; }
        line = platform === 'win32' ? `k ${code & 0xff} ${code & 0x100 ? 1 : 0} ${ev.d ? 1 : 0}` : `k ${code} ${ev.d ? 1 : 0}`;
        break;
      }
      case 'r': line = 'r'; break;
      default: dropped++; return;
    }
    events++;
    if (dryOn) return;
    try { proc.stdin.write(line + '\n'); } catch (e) { log.error('input write', e.message); }
  }

  const status = () => ({ on: !!proc || dryOn, events, dropped, display, helper: helper()?.name || null, dry: !!dry });
  return Object.assign(api, { available, start, stop, event, status });
}

module.exports = { createController, KEYS };
