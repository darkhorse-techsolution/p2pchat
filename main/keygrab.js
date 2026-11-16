'use strict';
// macOS, the viewer's side of remote control: the keys this Mac keeps for itself.
//
// While a contact's screen is driven in full screen every key should act over there, ⌘Tab, Spotlight
// and Mission Control included. On Windows and Linux Chromium's keyboard lock does that for the page
// (ui/share/viewer.js). Chromium has no such thing on macOS, so the input helper has a second mode,
// `p2pchat-input grab`: an event tap that takes key events off this Mac while it runs and writes them
// to stdout instead. This module starts and stops that helper and hands its keys to main, named as
// the DOM names them, so that the page sends them on like any key it got itself.
//
// It runs only while main says so (full screen, their screen driven, the viewer's window has the
// keyboard). The helper has its own limits on top: it holds the keyboard only while this app is the
// frontmost one, lets go when it has not heard from this module for 3 s, and ends with its stdin. The
// app's own hotkeys are passed to it by key and modifiers: it leaves those to this Mac, and says which one
// went by, so that main can run it even if macOS does not report a hotkey whose modifiers the grab holds.
// Needs Accessibility, the same switch that lets a contact drive this Mac. No key is ever logged.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { MAC } = require('./input.js');

const CODE_OF = new Map(Object.entries(MAC).map(([code, vk]) => [vk, code]));   // CGKeyCode -> DOM KeyboardEvent.code
// One line of the helper's stdout: "k CODE 1|0 [1]" (a key; the last field marks an auto-repeat), "r" (one of
// the app's hotkeys went by: what was sent of it is let go over there) or "x N" (which one: the N-th it was told).
function parseLine(line) {
  const p = String(line).trim().split(' ');
  if (p[0] === 'r' && p.length === 1) return { r: true };
  if (p[0] === 'x' && p.length === 2 && /^\d$/.test(p[1])) return { hot: Number(p[1]) };
  if (p[0] !== 'k' || p.length < 3 || p.length > 4 || !/^\d{1,3}$/.test(p[1]) || !/^[01]$/.test(p[2])) return null;
  const c = CODE_OF.get(Number(p[1]));
  if (!c) return null;
  return p[3] === '1' && p[2] === '1' ? { c, d: 1, rep: 1 } : { c, d: Number(p[2]) };
}
// An Electron accelerator as the helper takes it: "CGKeyCode:modifiers" (1 shift, 2 control, 4 option, 8 command).
const ACCEL_KEYS = { return: 'Enter', enter: 'Enter', backspace: 'Backspace', space: 'Space', tab: 'Tab', escape: 'Escape', esc: 'Escape', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Equal', minus: 'Minus' };
function passArg(accel) {
  let mods = 0, code = '';
  for (const part of String(accel || '').split('+')) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    if (p === 'shift') mods |= 1;
    else if (p === 'control' || p === 'ctrl') mods |= 2;
    else if (p === 'alt' || p === 'option') mods |= 4;
    else if (['command', 'cmd', 'super', 'meta', 'commandorcontrol', 'cmdorctrl'].includes(p)) mods |= 8;
    else if (/^[a-z]$/.test(p)) code = 'Key' + p.toUpperCase();
    else if (/^[0-9]$/.test(p)) code = 'Digit' + p;
    else if (/^f([1-9]|1[0-9]|20)$/.test(p)) code = p.toUpperCase();
    else if (Object.hasOwn(ACCEL_KEYS, p)) code = ACCEL_KEYS[p];
  }
  return code && Object.hasOwn(MAC, code) ? `${MAC[code]}:${mods}` : '';
}

const BEAT_MS = 1000;   // the helper lets go of the keyboard after 3 s without one

function createKeyGrab({ log, helpersDir, platform = process.platform, trusted, ask, onKey, onNote, onHotkey = () => {}, spawnFn = spawn, exists = fs.existsSync, beatMs = BEAT_MS }) {
  let proc = null, beat = null, keys = 0, asked = false, args = '', kinds = [];
  const bin = path.join(helpersDir, 'p2pchat-input');
  const drop = (p) => { if (proc !== p) return false; proc = null; args = ''; clearInterval(beat); beat = null; return true; };
  function stop(why) {
    const p = proc;
    if (!p) return;
    drop(p);
    try { p.stdin.write('q\n'); p.stdin.end(); } catch {}
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 800);
    p.once('exit', () => clearTimeout(t));
    log.info('key grab off', why || '', 'keys', keys);
  }
  // hotkeys: { kind: accelerator } of the app's own hotkeys, which the helper leaves to this Mac
  function start(hotkeys) {
    if (platform !== 'darwin') return false;
    const named = Object.entries(hotkeys || {}).map(([kind, accel]) => [kind, passArg(accel)]).filter(([, arg]) => arg);
    const pass = named.map(([, arg]) => arg), sig = pass.join(' ');
    if (proc && sig === args) return true;
    if (proc) stop('hotkeys changed');
    if (!exists(bin)) { log.error('key grab: the input helper is missing from this build'); return false; }
    if (!trusted()) { if (!asked) { asked = true; ask(); } onNote('accessibility'); return false; }
    let p;
    try { p = spawnFn(bin, ['grab', ...pass], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { log.error('key grab', e.message); return false; }
    proc = p; args = sig; keys = 0; kinds = named.map(([kind]) => kind);
    let out = '', err = '';
    p.stdout.on('data', (d) => {
      out += String(d); const lines = out.split('\n'); out = lines.pop(); if (out.length > 4096) out = '';
      if (proc !== p) return;
      for (const l of lines) { const ev = parseLine(l); if (!ev) continue; if (ev.hot !== undefined) { if (ev.hot < kinds.length) onHotkey(kinds[ev.hot]); continue; } keys++; onKey(ev); }
    });
    p.stderr.on('data', (d) => {
      err += String(d); const lines = err.split('\n'); err = lines.pop(); if (err.length > 4096) err = '';
      for (const l of lines) { const t = l.trim(); if (!t) continue; log.info('key grab:', t); if (proc === p && t.startsWith('ready')) onNote('on'); if (proc === p && t.startsWith('err tap')) onNote('accessibility'); }
    });
    p.stdin.on('error', () => {});
    p.on('error', (e) => { log.error('key grab', e.message); drop(p); });
    // it ended by itself (no beat heard, the tap refused): whatever it reported as held is let go over there
    p.on('exit', (code, sig2) => { if (drop(p)) { log.info('key grab exited', code ?? sig2, 'keys', keys); onKey({ r: true }); } });
    beat = setInterval(() => { try { p.stdin.write('h\n'); } catch {} }, beatMs);
    if (beat.unref) beat.unref();   // never the reason a process stays up
    log.info('key grab on');
    return true;
  }
  return { set: (on, hotkeys) => { if (on) return start(hotkeys); stop('off'); return false; }, stop, status: () => ({ on: !!proc, keys }) };
}

module.exports = { createKeyGrab, parseLine, passArg };
