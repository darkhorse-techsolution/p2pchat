'use strict';
const { app, BrowserWindow, Menu, Tray, ipcMain, clipboard, ClipboardItem, safeStorage, dialog, globalShortcut, nativeTheme, powerMonitor, screen, shell, desktopCapturer, nativeImage, protocol, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Store } = require('../core/store.js');
const { Transport } = require('../core/transport.js');
const { Engine } = require('../core/engine.js');
const { trayIcon } = require('./icon.js');
const { createController } = require('./input.js');
const { createGrant } = require('./grant.js');
const { createClipLink } = require('./clip.js');
const { createSharePops } = require('./sharepop.js');

const argFlag = (name) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : ''; };
const instance = argFlag('instance');
if (instance) app.setPath('userData', path.join(app.getPath('appData'), `P2P Chat (${instance})`));

// --- production mode ----------------------------------------------------------
const PROD = app.isPackaged;
// A packaged build must not be debuggable from the outside: these switches open
// the renderer and main process to anything on localhost.
if (PROD && process.argv.some((a) => /^--(remote-debugging-port|remote-debugging-pipe|inspect)/.test(a))) app.exit(1);

// Log to a file (rotated at 2 MB) so a user can send something useful when it breaks.
const LOG_MAX = 2 * 1024 * 1024;
let logPath = null;
try { logPath = path.join(app.getPath('logs'), instance ? `p2pchat-${instance}.log` : 'p2pchat.log'); fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
function logLine(level, args) {
  const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  if (!logPath) return;
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX) fs.renameSync(logPath, logPath + '.1');
    fs.appendFileSync(logPath, line);
  } catch {}
}
const log = { info: (...a) => { if (!PROD) console.log(...a); logLine('INFO', a); }, error: (...a) => { console.error(...a); logLine('ERROR', a); } };
process.on('uncaughtException', (e) => {
  log.error('uncaughtException', e);
  // Before the window exists there is nothing to recover into: exit, do not linger as a zombie.
  if (!win) { if (app.isReady()) { try { dialog.showErrorBox('P2P Chat could not start', String(e && e.stack || e)); } catch {} } app.exit(1); }
});
process.on('unhandledRejection', (e) => { log.error('unhandledRejection', e); });

// Super = the Windows key on Windows/Linux, Command on macOS. Ctrl+Win+X / Ctrl+Cmd+X.
const MAC = process.platform === 'darwin';
const DEFAULT_HOTKEY = MAC ? 'Command+Alt+V' : 'Control+Super+X';
const DEFAULT_MODE_HOTKEY = MAC ? 'Command+Alt+Backspace' : 'Control+Super+Backspace';   // cycles Overlap -> On top -> Overlay; the only way out of Overlay
const DEFAULT_FULL_HOTKEY = MAC ? 'Command+Alt+Return' : 'Control+Super+Return';      // full screen for an incoming share, also while controlling it
// Every default ever shipped, per key: a stored copy of one of them moves to the current default at boot
const FORMER_DEFAULTS = { hotkey: ['Super+Alt+X', 'Control+Super+X', 'Command+Alt+V'], modeHotkey: ['Super+Alt+Z', 'Control+Super+Backspace', 'Command+Alt+Backspace'], fullHotkey: ['Control+Super+Return', 'Command+Alt+Return'] };
const MODES = ['overlap', 'top', 'overlay'];
// Your own relay. New installs use it until the user changes it in Settings; invites carry it.
const DEFAULT_RELAY = 'relay://49.12.170.6:4433/eEo_7e-gv8vacjh-EGO7ZcwYNSrALyQU1kDFruoFlyU';
// Call server (STUN + TURN, coturn on the same box) for screen-share media when the two
// NATs will not pass it directly. Long-term credential; the media through it is DTLS-SRTP.
// Read from main/turn.json, which is not committed (copy main/turn.example.json; see
// relay/README.md). Without the file there is no default call server until Settings has one.
const DEFAULT_TURN = (() => { try { return require('./turn.json'); } catch { return { host: '', user: '', pass: '' }; } })();

// A second launch of a hidden background app would otherwise open a second
// copy on the same vault. The lock lives in userData, so --instance copies
// stay independent.
if (process.platform === 'win32') app.setAppUserModelId('io.p2pchat.desktop'); // shortcuts, Run key and toasts share one id
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());
const isMac = process.platform === 'darwin', isWin = process.platform === 'win32', isLinux = process.platform === 'linux';
// On Linux a global shortcut does not work under Wayland and the tray needs a
// GNOME extension, so hiding the window could make the app unreachable. There,
// the window stays in the taskbar and closing it quits.
const BACKGROUND_APP = !isLinux;
if (isLinux) app.setDesktopName('io.p2pchat.P2PChat.desktop'); // must match the installed .desktop file; the Wayland GlobalShortcuts portal resolves it
// Image bytes reach the renderer as p2pblob://img/<contact>/<message id>, served from the
// sealed blob files, instead of data: URLs: the DOM never holds megabytes of base64 and
// Chromium caches the decoded image. Must be registered before 'ready'.
protocol.registerSchemesAsPrivileged([{ scheme: 'p2pblob', privileges: { standard: true, secure: true } }]);
// A share is driven live, so each video frame is painted when it arrives: no jitter cushion, no A/V-sync hold.
// First trial: this app as viewer, whatever the sharer runs. Second: tags outgoing video so a viewer on an older
// build does the same. Price: a lost packet shows as a short stall where the cushion used to hide it;
// `--share-cushion` on the command line brings the cushion back. Any other WebRTC trial goes into this same
// string (a second appendSwitch would replace it). Must run before the app is ready.
if (!process.argv.includes('--share-cushion')) app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/');

// --- screen-capture blocking -------------------------------------------------
// The "monitor" build variant (Windows installer only, `npm run dist:win:monitor`) ships without it:
// its window is an ordinary one that screenshots, recordings and screen shares show, and the shield,
// the Settings switch and the tray item are gone. The flag is baked into the packaged package.json
// (electron-builder extraMetadata); P2P_VARIANT does the same for a dev run.
const VARIANT = (() => { try { return String(require('../package.json').p2pVariant || (app.isPackaged ? '' : process.env.P2P_VARIANT || '')); } catch { return ''; } })();
const NO_BLOCK = VARIANT === 'monitor';
let protectionOn = !NO_BLOCK && !process.argv.includes('--no-protection');
const captureSupport = () =>
  NO_BLOCK ? { supported: false, variant: true, how: 'This build does not block screen capture: the window shows in screenshots, recordings and screen shares' }
  : isMac ? { supported: true, how: 'NSWindow sharingType = none' }
  : isWin ? { supported: true, how: 'SetWindowDisplayAffinity' }
  : { supported: false, how: 'Linux has no API to exclude a window from capture (X11 lets any client read any window; the Wayland screenshot portal captures everything), so this window IS capturable' };
const applyProtection = (win) => { if (!win.isDestroyed()) win.setContentProtection(protectionOn); };
app.on('browser-window-created', (_e, win) => applyProtection(win));

// --- vault key, wrapped by the OS keychain -----------------------------------
function rawKey(file) {
  if (fs.existsSync(file)) { const blob = fs.readFileSync(file); if (blob.subarray(0, 4).toString() === 'RAW:') return { key: Buffer.from(blob.subarray(4).toString(), 'hex'), secure: false }; }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'RAW:' + key.toString('hex'), { mode: 0o600 });
  return { key, secure: false };
}

async function loadVaultKey(dir) {
  const file = path.join(dir, 'vault.key');
  // The sync safeStorage API is deprecated in Electron 45 and races the keychain
  // at startup (observed: false on one instance, true on another, same binary).
  // Dev runs keep the Keychain out of it: a dev Electron and an installed build share the
  // item name "<app> Safe Storage" and fight over its ACL. Dev vaults are test data.
  if (!PROD) { log.info('dev run: vault key stored as a plain file, no keychain'); return rawKey(file); }
  log.info('safeStorage: checking availability');
  let secure = typeof safeStorage.isAsyncEncryptionAvailable === 'function'
    ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  // On Linux without a keyring Chromium "encrypts" with a fixed password and still reports available.
  if (isLinux && typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') secure = false;
  log.info(`safeStorage: available=${secure}`);
  const enc = (s) => (safeStorage.encryptStringAsync ? safeStorage.encryptStringAsync(s) : Promise.resolve(safeStorage.encryptString(s)));
  // Electron 45's decryptStringAsync resolves to { shouldReEncrypt, result }, not a string.
  const dec = async (b) => {
    if (!safeStorage.decryptStringAsync) return { result: safeStorage.decryptString(b), shouldReEncrypt: false };
    const r = await safeStorage.decryptStringAsync(b);
    return typeof r === 'string' ? { result: r, shouldReEncrypt: false } : r;
  };
  if (fs.existsSync(file)) {
    const blob = fs.readFileSync(file);
    if (blob.subarray(0, 4).toString() === 'RAW:') return { key: Buffer.from(blob.subarray(4).toString(), 'hex'), secure: false };
    if (!secure && isMac) throw new Error('macOS asked for permission to read the vault key from your Keychain and it was not granted. Nothing is lost: open P2P Chat again and click "Always Allow" (this happens once after each update because the app is not signed with an Apple Developer ID).');
    let unwrapped;
    try { unwrapped = await dec(blob); }
    catch (e) {
      // On macOS this is almost always a denied Keychain prompt after an update
      // (each unsigned build has a new signature). Nothing is lost: relaunch and allow.
      throw new Error(process.platform === 'darwin'
        ? 'macOS asked for permission to read the vault key from your Keychain and it was not granted. Nothing is lost: open P2P Chat again and click "Always Allow" (this happens once after each update because the app is not signed with an Apple Developer ID).'
        : `The OS could not unwrap vault.key (${e.message}). This happens after moving the data folder to another account or machine, or deleting "Local State". Delete vault.key and vault.bin in ${dir} to start over; a contact can restore the conversation afterwards.`);
    }
    const { result, shouldReEncrypt } = unwrapped;
    const key = Buffer.from(result, 'hex');
    if (key.length !== 32) throw new Error('vault key is corrupt');
    if (shouldReEncrypt) fs.writeFileSync(file, await enc(result), { mode: 0o600 });
    return { key, secure: true };
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, secure ? await enc(key.toString('hex')) : 'RAW:' + key.toString('hex'), { mode: 0o600 });
  return { key, secure };
}

let engine = null, store = null, keyInfo = null, win = null, tray = null, quitting = false, hotkeyOk = false, modeHotkeyOk = false;
const settings = () => (store.data.settings ||= { hotkey: DEFAULT_HOTKEY, modeHotkey: DEFAULT_MODE_HOTKEY, fullHotkey: DEFAULT_FULL_HOTKEY, mode: 'overlap', discovery: false, theme: 'system', relay: DEFAULT_RELAY, opacity: 1, popups: true, popupText: true, sidebarWidth: 300, sidebarCollapsed: false, codeWrap: true, codeCollapse: true, shareMode: 'one', callsRelayOnly: false, recordShares: false, clipboardSync: true });
// Settings added after a vault was created are read with defaults (an existing vault lacks the keys).
const turnCfg = () => { const st = settings(); return { host: st.turn ?? DEFAULT_TURN.host, user: st.turnUser ?? DEFAULT_TURN.user, pass: st.turnPass ?? DEFAULT_TURN.pass }; };
function iceConfig() {
  const t = turnCfg(); const servers = [];
  if (t.host) servers.push({ urls: [`stun:${t.host}`, `turn:${t.host}?transport=udp`, `turn:${t.host}?transport=tcp`], username: t.user, credential: t.pass });
  return { iceServers: servers, iceTransportPolicy: settings().callsRelayOnly ? 'relay' : 'all' };
}
const OPACITY_MIN = 0.2; // never fully invisible: the window must stay usable
const clampOpacity = (v) => Math.min(1, Math.max(OPACITY_MIN, Number(v) || 1));
// Linux: Electron's setOpacity is a no-op there, but under X11 the window manager
// honours _NET_WM_WINDOW_OPACITY (Mutter, KWin, xfwm with compositing). We set it
// on our own X window through xprop. Wayland sessions have no such hook.
const x11 = isLinux && !!process.env.DISPLAY && spawnSync('xprop', ['-version'], { timeout: 1500 }).status === 0;
function linuxSetOpacity(o) {
  if (!x11 || !win || win.isDestroyed()) return false;
  let xid = 0;
  try { const h = win.getNativeWindowHandle(); xid = h.length >= 4 ? h.readUInt32LE(0) : 0; } catch {}
  if (!xid) return false;
  const args = o >= 0.995
    ? ['-id', String(xid), '-remove', '_NET_WM_WINDOW_OPACITY']
    : ['-id', String(xid), '-f', '_NET_WM_WINDOW_OPACITY', '32c', '-set', '_NET_WM_WINDOW_OPACITY', String(Math.round(o * 0xffffffff))];
  const r = spawnSync('xprop', args, { timeout: 2000 });
  if (r.status !== 0) log.error('xprop opacity failed', String(r.stderr || '').trim());
  return r.status === 0;
}
const opacitySupported = () => !isLinux || x11;
function applyOpacity(v) {
  const o = Math.round(clampOpacity(v) * 100) / 100;
  settings().opacity = o; store.saveSoon();
  if (win && !win.isDestroyed()) { if (isLinux) { const ok = linuxSetOpacity(o); log.info('opacity', o, x11 ? (ok ? 'x11 ok' : 'x11 failed') : 'unsupported'); } else win.setOpacity(o); }
  push('opacity', { opacity: o });
  return o;
}
const OPACITY_STEP = 0.1;
// Cmd/Win + '+' / '-' while the window is focused: step the opacity. Handled as a
// window-local key event, not a global shortcut, because Cmd+/- is zoom in every
// other app on macOS and Win+/- is the Magnifier on Windows (owned by the shell).
// Windows also accepts Ctrl+Alt+'+'/'-' since the shell swallows the Win key combos.
function opacityKey(input) {
  if (input.type !== 'keyDown') return 0;
  const mod = isMac ? input.meta : (input.meta || (input.control && input.alt));
  if (!mod) return 0;
  const k = input.key, c = input.code;
  if (k === '+' || k === '=' || c === 'Equal' || c === 'NumpadAdd') return +OPACITY_STEP;
  if (k === '-' || k === '_' || c === 'Minus' || c === 'NumpadSubtract') return -OPACITY_STEP;
  return 0;
}
const push = (type, data = {}) => { if (win && !win.isDestroyed()) win.webContents.send('event', { type, ...data }); };

// --- message pop-ups -------------------------------------------------------------
// Drawn by the app, not the OS: no app name, no icon, nothing left in Notification
// Center. A frameless, click-through, non-focusable window at the top-right of the
// screen, capture-blocked like the main window, shown only when the chat is hidden
// or not in front, gone after a few seconds.
const POPUP_W = 380, POPUP_MS = 6000;
let popup = null, popupTimer = null, popupQueue = 0, popupLast = null;
function popupTheme() { const t = settings().theme || 'system'; return t === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : t; }
function ensurePopup() {
  if (popup && !popup.isDestroyed()) return popup;
  popup = new BrowserWindow({
    width: POPUP_W, height: 90, show: false, frame: false, transparent: !isLinux, hasShadow: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, type: isMac ? 'panel' : undefined,
    title: '', webPreferences: { preload: path.join(__dirname, 'notify-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
  });
  popup.setAlwaysOnTop(true, 'screen-saver');          // above fullscreen apps and other floating windows
  popup.setIgnoreMouseEvents(true);                     // never intercepts a click
  popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popup.webContents.on('will-navigate', (e) => e.preventDefault());
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.on('closed', () => { popup = null; });
  popup.loadFile(path.join(__dirname, '..', 'ui', 'notify.html'));
  return popup;
}
function placePopup(h) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  popup.setBounds({ x: Math.round(d.x + d.width - POPUP_W - 12), y: Math.round(d.y + 12), width: POPUP_W, height: Math.max(60, Math.min(220, h)) });
}
ipcMain.on('notify-sized', (e, h) => { if (popup && e.sender === popup.webContents) { placePopup(Number(h) || 90); if (!popup.isVisible()) popup.showInactive(); } });
function chatInFront() { return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && (win.isFocused() || win.isAlwaysOnTop()); }
function showPopup({ pub, name, text, kind, force = false }) {
  if (!settings().popups && !force) return;
  if (chatInFront() && !force) return;
  if (capturing) return;
  const w = ensurePopup();
  const same = popupLast === pub && popup.isVisible();
  popupQueue = same ? popupQueue + 1 : 0; popupLast = pub;
  const payload = { theme: popupTheme(), solid: isLinux, name, pub, kind, showText: !!settings().popupText, more: popupQueue,
    text: kind === 'code' ? String(text).split('\n')[0].slice(0, 120) : kind === 'image' || kind === 'share' ? '' : String(text).slice(0, 220) };
  const send = () => w.webContents.send('notify', payload);
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
  clearTimeout(popupTimer);
  popupTimer = setTimeout(() => { if (popup && !popup.isDestroyed()) popup.hide(); popupQueue = 0; popupLast = null; }, POPUP_MS);
}

// --- window modes --------------------------------------------------------------
//   overlap  normal window: takes input, other windows can cover it
//   top      always on top, still interactive
//   overlay  always on top AND click-through: the mouse goes to whatever is behind,
//            so the window never takes focus; the mode hotkey is the way back
const isOverlay = () => settings().mode === 'overlay';
function applyMode(mode) {
  const m = MODES.includes(mode) ? mode : 'overlap';
  settings().mode = m; store.saveSoon();
  if (win && !win.isDestroyed()) {
    const onTop = m !== 'overlap', through = m === 'overlay';
    win.setAlwaysOnTop(onTop, onTop ? 'floating' : 'normal');
    win.setIgnoreMouseEvents(through);
    if (isMac || isWin) win.setFocusable(!through);
    if (through && win.isFocused()) win.blur();
  }
  log.info('mode', m);
  push('mode', { mode: m, hotkey: settings().modeHotkey });
  return m;
}
function cycleMode() {
  const i = MODES.indexOf(settings().mode || 'overlap');
  applyMode(MODES[(i + 1) % MODES.length]);
  if (win && !win.isVisible()) showWindow();
}

// --- show / hide: hotkey and tray only, never Dock or taskbar ----------------
function showWindow() {
  if (!win || capturing) return; // hidden for a screenshot: a hotkey or relaunch must not put it back into the shot
  log.info('showWindow', new Error().stack.split('\n')[2]?.trim() || '');
  // No app.dock.hide() here: flipping the activation policy on an already visible
  // window makes macOS order it out again (seen as a stray 'hide' event, and twice
  // as a window that never appeared). The policy is set once, before the window exists.
  if (isOverlay()) { win.showInactive(); push('shown'); return; } // overlay never takes focus
  win.show();
  win.focus();
  if (isMac) app.focus({ steal: true });
  if (isWin) win.setSkipTaskbar(true);   // one-shot ITaskbarList call; re-apply after every show

  push('shown');
}
function hideWindow() { log.info('hideWindow', new Error().stack.split('\n')[2]?.trim() || ''); if (win && !win.isDestroyed()) { setViewerFullscreen(false); win.hide(); } }
function toggleWindow() {
  if (!win) return;
  if (isOverlay()) { win.isVisible() ? hideWindow() : showWindow(); return; } // never focused in overlay, so visibility alone decides
  (win.isVisible() && win.isFocused()) ? hideWindow() : showWindow();
}

// Three global shortcuts: `hotkey` shows/hides, `modeHotkey` cycles the window mode, `fullHotkey`
// toggles full screen for an incoming share (the renderer decides; nothing happens without one).
const SHORTCUTS = { hotkey: () => toggleWindow(), modeHotkey: () => cycleMode(), fullHotkey: () => { if (win && !win.isDestroyed() && win.isVisible()) push('fullHotkey', {}); } };
function registerShortcut(kind, accel) {
  const current = settings()[kind];
  const others = Object.keys(SHORTCUTS).filter((k) => k !== kind).map((k) => settings()[k]);
  if (accel && others.includes(accel)) return { ok: false, error: 'already used by another hotkey', hotkey: current };
  if (current) globalShortcut.unregister(current);
  let ok = false, error = '';
  try { ok = globalShortcut.register(accel, SHORTCUTS[kind]); if (!ok) error = 'that combination is taken by another app or the OS'; }
  catch (e) { error = e.message; }
  if (!ok) {
    if (current && current !== accel) { try { globalShortcut.register(current, SHORTCUTS[kind]); } catch {} }
    return { ok: false, error, hotkey: current };
  }
  settings()[kind] = accel; store.saveSoon();
  log.info(kind, 'registered', accel);
  tray?.setContextMenu(trayMenu());
  push('settings', settings());
  return { ok: true, hotkey: accel };
}
const registerHotkey = (accel) => registerShortcut('hotkey', accel);

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show / Hide', accelerator: settings().hotkey, click: toggleWindow },
    { label: 'Next Window Mode', accelerator: settings().modeHotkey, click: cycleMode },
    { label: 'Full Screen Share', accelerator: settings().fullHotkey, click: SHORTCUTS.fullHotkey },
    { type: 'separator' },
    ...(NO_BLOCK ? [] : [{ label: 'Block Screenshots & Recording', type: 'checkbox', checked: protectionOn, enabled: captureSupport().supported, click: (i) => setProtection(i.checked) }]),
    { label: 'Copy My Invite', click: () => clipboard.writeText(engine.invite()) },
    { type: 'separator' },
    { label: 'Quit P2P Chat', click: () => { quitting = true; app.quit(); } },
  ]);
}

function setProtection(v) {
  protectionOn = !NO_BLOCK && !!v;
  BrowserWindow.getAllWindows().forEach(applyProtection);
  tray?.setContextMenu(trayMenu());
  push('protection', { on: protectionOn, ...captureSupport() });
  return protectionOn;
}

function contactView(c) {
  const conv = store.conv(c.pub);
  const last = conv.messages[conv.messages.length - 1] || null;
  return { pub: c.pub, name: c.name, host: c.host, port: c.port, verified: !!c.verified, status: engine.status(c.pub),
    unread: conv.unread, last: last ? { ts: last.ts, kind: last.kind, text: String(last.text || '').slice(0, 80), from: last.from } : null };
}
// What the renderer sees of a message: an image record also says whether its bytes are
// here (blob) and, if not, why not yet (fetch: pending | offline | quota | unavailable).
const msgView = (pub, m) => { if (m.kind !== 'image') return m; const st = engine.imageStatus(pub, m.id); return { ...m, blob: st === 'have', fetch: st }; };

// --- screenshots ----------------------------------------------------------------
// One click: capture the display this window is on and send it as an image message.
// With capture blocking on, macOS and Windows leave this window out of the shot by
// themselves (that is what the blocking is). Where it would be captured (Linux, or
// blocking turned off) the window is hidden for the shot, so the screenshot shows
// what is behind the chat, never the chat.
const SHOT_MAX_EDGE = 2560, SHOT_QUALITY = 85;
const screenPermission = () => { if (!isMac) return 'granted'; try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; } };
let capturing = false; // window hidden for a shot: the pop-up card is hidden too and none may appear until the shot is taken
let screenPermAtBoot = 'granted'; // macOS: what TCC said when this process started (set in boot)
let sharedDisplay = null; // the display handed to the last getDisplayMedia (the one a share sends); remote control maps onto it
// The display this window is on (or the primary one), and its size in pixels.
function targetDisplay() {
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return { display, want: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } };
}
// display_id is filled on macOS and on Windows with the DirectX capturer only; elsewhere match the
// source by its pixel size, then by display order, and the first source is right on a single display.
function pickSource(sources, display, want) {
  const byId = sources.find((s) => s.display_id && String(s.display_id) === String(display.id));
  const bySize = sources.filter((s) => { const z = s.thumbnail.getSize(); return z.width === want.width && z.height === want.height; });
  const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
  return byId || (bySize.length === 1 ? bySize[0] : null) || sources[Math.max(0, Math.min(idx, sources.length - 1))] || sources[0] || null;
}
async function captureScreen() {
  const { display, want } = targetDisplay();
  const hide = !!win && !win.isDestroyed() && win.isVisible() && (isLinux || !protectionOn);
  if (hide) {
    capturing = true;
    if (popup && !popup.isDestroyed() && popup.isVisible()) popup.hide();
    win.hide();
    await new Promise((r) => setTimeout(r, 250));
  }
  let sources;
  try { sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: want }); }
  finally { if (hide) { capturing = false; showWindow(); } }
  const src = pickSource(sources, display, want);
  if (!src || src.thumbnail.isEmpty()) throw new Error('nothing was captured');
  let img = src.thumbnail;
  const sz = img.getSize(), edge = Math.max(sz.width, sz.height);
  if (edge > SHOT_MAX_EDGE) img = img.resize({ width: Math.round(sz.width * SHOT_MAX_EDGE / edge), height: Math.round(sz.height * SHOT_MAX_EDGE / edge), quality: 'good' });
  const out = img.getSize();
  return { mime: 'image/jpeg', data: img.toJPEG(SHOT_QUALITY), w: out.width, h: out.height };
}

// --- IPC ---------------------------------------------------------------------
// Only the app's own main frame may call these.
const handle = (name, fn) => ipcMain.handle(name, (e, ...a) => {
  if (!win || win.isDestroyed() || e.senderFrame !== win.webContents.mainFrame) throw new Error('untrusted sender');
  return fn(e, ...a);
});
handle('state', () => ({
  me: { pub: engine.me.pub.toString('base64url'), name: engine.me.name, host: engine.transport.host, port: engine.transport.port },
  contacts: store.contacts().map(contactView),
  protection: protectionOn, capture: captureSupport(), variant: VARIANT, platform: process.platform,
  settings: settings(), relay: engine.relayStatus(), vaultSecure: keyInfo.secure, vaultPath: store.file,
  backgroundApp: BACKGROUND_APP, hotkeyOk, defaultRelay: DEFAULT_RELAY, mode: settings().mode || 'overlap', modeHotkeyOk, defaults: { hotkey: DEFAULT_HOTKEY, modeHotkey: DEFAULT_MODE_HOTKEY, fullHotkey: DEFAULT_FULL_HOTKEY }, turn: turnCfg(),
  windowFlags: win && !win.isDestroyed() ? { alwaysOnTop: win.isAlwaysOnTop(), focusable: win.isFocusable(), fullscreen: isViewerFullscreen() } : null,
  popup: popup && !popup.isDestroyed() ? { visible: popup.isVisible(), focusable: popup.isFocusable(), alwaysOnTop: popup.isAlwaysOnTop(), bounds: popup.getBounds() } : null, opacity: clampOpacity(settings().opacity), opacitySupported: opacitySupported(), autostartSupported: isMac || isWin, version: app.getVersion(), packaged: PROD, logPath,
  recordingsDir: recordingsDir(), control: { ...control.status(), ...grant.status() }, clip: { ...clip.status(), fake: CLIP_FAKE }, keysRemote,
  versions: { electron: process.versions.electron, node: process.versions.node },
}));
handle('setName', (_e, name) => { engine.setMyName(name); return engine.me.name; });
handle('invite', () => engine.invite());
handle('addContact', (_e, invite) => contactView(engine.addContact(invite)));
handle('removeContact', (_e, pub) => { engine.removeContact(pub); return true; });
handle('renameContact', (_e, pub, name) => { engine.renameContact(pub, name); store.upsertContact(pub, { renamed: true }); return true; });
handle('setVerified', (_e, pub, v) => { engine.setVerified(pub, v); return true; });
handle('contact', (_e, pub) => { const c = store.contact(pub); return c ? { ...contactView(c), safetyNumber: engine.safetyNumber(pub) } : null; });
handle('conversation', (_e, pub) => { store.clearUnread(pub); return store.conv(pub).messages.map((m) => msgView(pub, m)); });
handle('conversationPeek', (_e, pub) => store.conv(pub).messages.map((m) => msgView(pub, m))); // a refresh, not a read: unread stays
handle('send', (_e, pub, m) => engine.sendMessage(pub, m));
// macOS Screen Recording for screenshots and screen sharing. Returns 'ok', or why not:
// 'ask' (not allowed yet: the attempt below makes macOS list the app and prompt) or
// 'relaunch' (allowed while this process was running; macOS applies it after a restart).
// A 'denied' entry after an update is usually stale: each unsigned build is a new app to
// macOS and a stale entry never re-prompts, so the app resets its own entry and asks again.
async function ensureScreenPermission() {
  if (!isMac) return 'ok';
  let perm = screenPermission();
  if (perm === 'granted' && screenPermAtBoot === 'granted') return 'ok';
  if (perm === 'granted') return 'relaunch';
  if (perm === 'denied' && PROD) {
    const r = spawnSync('tccutil', ['reset', 'ScreenCapture', 'io.p2pchat.desktop'], { timeout: 5000 });
    log.info('screen permission was denied: tccutil reset ->', r.status, String(r.stdout || r.stderr || '').trim());
    perm = screenPermission();
  }
  try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } }); } catch {}
  log.info('screen permission:', perm, 'at boot', screenPermAtBoot);
  return 'ask';
}
handle('screenPermission', () => ensureScreenPermission());
handle('screenshot', async (_e, pub) => {
  if (!store.contact(pub)) throw new Error('unknown contact');
  const perm = await ensureScreenPermission();
  if (perm !== 'ok') throw new Error(perm === 'relaunch' ? 'screen-permission-relaunch' : 'screen-permission');
  const shot = await captureScreen();
  const msg = engine.sendImage(pub, shot);
  log.info('screenshot sent', `${shot.w}x${shot.h}`, shot.data.length, 'bytes');
  return msgView(pub, msg);
});
handle('fetchImage', (_e, pub, id) => { engine.fetchImage(pub, String(id || '')); return true; });
// Screen share / voice: signaling goes through the engine; media is WebRTC in the renderer.
handle('share', (_e, pub, payload) => engine.sendShare(String(pub || ''), payload));
handle('iceConfig', () => iceConfig());
handle('micPermission', async () => { if (!isMac) return true; try { return await systemPreferences.askForMediaAccess('microphone'); } catch { return false; } });
// --- share viewer: full screen and recording --------------------------------------
// Full screen is the window itself, asked for by the viewer: simple fullscreen on macOS (no
// Space switch, so it works for a Dock-less app and in every window mode), setFullScreen
// elsewhere. Element fullscreen is not used (every page permission stays refused).
function isViewerFullscreen() { return !!win && !win.isDestroyed() && (win.isFullScreen() || (isMac && win.isSimpleFullScreen())); }
// While the viewer drives a contact's screen in full screen, the keys this app would take for itself go to
// that screen with all the others: the page says when (keysRemote), and then the application menu's
// shortcuts are not acted on and the opacity keys are not consumed, so the page gets them and sends them
// on. Only in full screen, and off again whenever full screen ends, the window is hidden, or the page
// reloads or dies. The three global hotkeys (show/hide, window mode, full screen) are not touched: they
// stay this machine's. Keys the operating system keeps for itself never reach the app and are not asked for.
let keysRemote = false;
let viewerFull = false;   // the viewer asked for full screen and the window has not left it since
function setKeysRemote(on) {
  on = !!on && isViewerFullscreen();
  if (on === keysRemote) return on;
  keysRemote = on;
  if (win && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(on);
  log.info('keysRemote', on);
  return on;
}
function setViewerFullscreen(on) {
  if (!win || win.isDestroyed()) return false;
  on = !!on;
  if (!on) setKeysRemote(false);
  viewerFull = on;
  if (on !== isViewerFullscreen()) { if (isMac) win.setSimpleFullScreen(on); else win.setFullScreen(on); push('fullscreen', { on }); }
  return on;
}
handle('fullscreen', (_e, on) => setViewerFullscreen(on));
handle('keysRemote', (_e, on) => setKeysRemote(on));
// --- remote control of the shared display ------------------------------------------
// The sharer allowed the viewer to drive this machine: a helper process posts the viewer's
// events to the OS (main/input.js). Granted to one contact at a time (main/grant.js): the
// renderer gets a token with the grant and shows it with every event. The grant ends when the
// sharer stops it, the capture ends, the page reloads or dies, or the app quits, and the clipboard
// link that was allowed with it ends in the same step. The helpers live outside the asar (asarUnpack).
const helpersDir = path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'main', 'helpers');
const DRY_INPUT = !PROD && process.argv.includes('--dry-input');   // dev runs only: a grant works, but no helper starts and no event reaches the OS
const control = createController({ log, helpersDir, screen, systemPreferences, dry: DRY_INPUT });
const grant = createGrant({ control });
// The clipboard link (main/clip.js). --clip-fake is for dev runs only, like --dry-input: the link then
// works on a text in memory and the system clipboard is never read or written. A dev run that can be
// driven from outside (a debugging port) gets it without the flag: whatever a test clicks there, the
// real clipboard stays out of it.
const CLIP_FAKE = !PROD && (process.argv.includes('--clip-fake') || process.argv.some((a) => /^--(remote-debugging-port|remote-debugging-pipe|inspect)/.test(a)));
const fakeClip = { text: '', async readText() { return this.text; }, async writeText(v) { this.text = String(v); }, async has() { return false; } };
const clip = createClipLink({ backend: CLIP_FAKE ? fakeClip : clipboard, platform: process.platform, enabled: () => settings().clipboardSync !== false, grant });
clip.onText = (id, text) => push('clip', { id, text });   // to the page, which sends it to the peer; never to the log
clip.onNote = (id, note) => push('clip', { id, note });
clip.onStop = (id, why) => { log.info('clipboard link off', id, why); push('clip', { id, off: true, why }); };
const endGrant = (why) => { const g = grant.end(why); if (g) clip.stopFor(g.token, why); return g; };
control.onExit = (why) => { const g = grant.drop(); if (g) { clip.stopFor(g.token, 'control ended'); push('control', { on: false, why, token: g.token }); } };
control.onCursor = (c) => { const g = grant.current(); if (g && !g.pending) push('cursor', { ...c, token: g.token }); };   // the sharer's renderer passes it to the viewer
handle('controlGrant', (_e, pub, withClip) => {
  pub = String(pub || '');
  if (!store.contact(pub)) throw new Error('unknown contact');
  if (!sharedDisplay) return { ok: false, reason: 'notsharing', message: 'Nothing is being shared' };
  return grant.start(pub, screen.getAllDisplays().find((x) => x.id === sharedDisplay.id) || sharedDisplay, withClip === true);
});
handle('controlRevoke', (_e, token) => { if (grant.revoke(token)) clip.stopFor(token, 'control ended'); return true; });
// The renderer stopped its capture: no display is shared any more, so none can be controlled.
handle('captureEnded', () => { sharedDisplay = null; endGrant('capture ended'); return true; });
ipcMain.on('input', (e, token, ev) => { if (!win || win.isDestroyed() || e.senderFrame !== win.webContents.mainFrame) return; grant.input(token, ev); });
// The page starts the link when control with the clipboard is on in a session, and names it by the id
// it gets back in every later call. Whether it may start, and go on, is decided in main/clip.js.
handle('clipStart', (_e, o) => {
  const pub = String((o && o.pub) || ''), role = o && o.role === 'give' ? 'give' : 'take';
  if (!store.contact(pub)) throw new Error('unknown contact');
  return clip.start({ pub, role, token: o && o.token }).then((r) => { if (r.ok) log.info('clipboard link on', r.id, role, pub.slice(0, 8), CLIP_FAKE ? '(fake clipboard)' : ''); return r; });
});
handle('clipPoke', (_e, id) => { clip.poke(String(id)); return true; });
handle('clipApply', (_e, id, text) => clip.apply(String(id), text));
handle('clipStop', (_e, id) => { if (clip.status().id === String(id)) clip.stop('renderer'); return true; });
// Recording an incoming share: the renderer's MediaRecorder streams WebM pieces here and they
// are appended, in order, to a plain file in the Videos folder. Deliberately not in the vault:
// a recording is for playing in any player. Files are created exclusively and never reused.
const recordings = new Map(); const recordedFiles = new Set(); let recSeq = 0;
const REC_CHUNK_MAX = 16 * 1024 * 1024;
function recordingsDir() { let base; try { base = app.getPath('videos'); } catch { base = app.getPath('home'); } return path.join(base, 'P2P Chat'); }
handle('recordStart', (_e, pub) => {
  const c = store.contact(String(pub || '')); if (!c) throw new Error('unknown contact');
  if (recordings.size >= 2) throw new Error('a recording is already running');
  const dir = recordingsDir(); fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
  const name = String(c.name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 40) || 'contact';
  let file, fd;
  for (let i = 0; ; i++) {
    file = path.join(dir, `${name} ${stamp}${i ? ` (${i})` : ''}.webm`);
    try { fd = fs.openSync(file, 'wx', 0o600); break; } catch (e) { if (e.code !== 'EEXIST' || i > 20) throw new Error(`cannot create the recording: ${e.code || e.message}`); }
  }
  const id = String(++recSeq); recordings.set(id, { fd, file, bytes: 0 }); log.info('recording start', file);
  return { id, file };
});
handle('recordChunk', (_e, id, data) => {
  const r = recordings.get(String(id)); if (!r) throw new Error('no such recording');
  const buf = Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : data instanceof ArrayBuffer ? Buffer.from(data) : null;
  if (!buf || !buf.length || buf.length > REC_CHUNK_MAX) throw new Error('bad chunk');
  try { fs.writeSync(r.fd, buf); r.bytes += buf.length; }
  catch (e) { recordings.delete(String(id)); try { fs.closeSync(r.fd); } catch {} log.error('recording write', r.file, e); throw new Error(`cannot write the recording: ${e.code || e.message}`); }
  return r.bytes;
});
handle('recordStop', (_e, id) => {
  const r = recordings.get(String(id)); if (!r) return null;
  recordings.delete(String(id));
  try { fs.fsyncSync(r.fd); } catch {} try { fs.closeSync(r.fd); } catch {}
  if (r.bytes < 100) { try { fs.unlinkSync(r.file); } catch {} return null; }   // nothing arrived: no empty file left behind
  recordedFiles.add(r.file); log.info('recording saved', r.file, r.bytes);
  return { file: r.file, bytes: r.bytes };
});
handle('openRecordings', (_e, file) => {
  const f = String(file || '');
  if (f && recordedFiles.has(f)) { shell.showItemInFolder(f); return true; }
  const dir = recordingsDir(); fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); return true;
});
handle('openScreenSettings', () => { if (!isMac) return false; shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); return true; });
handle('copyImage', async (_e, pub, id) => {
  const data = store.blob(pub, id); if (!data) throw new Error('image not available');
  // Electron 45's clipboard is the web-style async API (ClipboardItem + Blob; writeImage is gone). PNG pastes everywhere.
  const img = nativeImage.createFromBuffer(data);
  if (img.isEmpty()) throw new Error('this image cannot be decoded');
  const png = img.toPNG();
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  return true;
});
handle('saveImage', async (_e, pub, id) => {
  const data = store.blob(pub, id); if (!data) throw new Error('image not available');
  const rec = store.conv(pub).messages.find((x) => x.id === id);
  const ext = rec?.mime === 'image/png' ? 'png' : 'jpg';
  const stamp = new Date(rec?.ts || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let dir; try { dir = app.getPath('pictures'); } catch { dir = app.getPath('home'); }
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, `screenshot-${stamp}.${ext}`), filters: [{ name: ext === 'png' ? 'PNG image' : 'JPEG image', extensions: [ext] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, data);
  return true;
});
handle('typing', (_e, pub) => { engine.sendTyping(pub); return true; });
handle('requestHistory', (_e, pub) => { engine.requestHistory(pub); return true; });
handle('wipeConversation', (_e, pub) => { store.wipeConversation(pub); return true; });
handle('protection', (_e, v) => setProtection(v));
handle('setHotkey', (_e, accel) => registerHotkey(String(accel || '')));
handle('setModeHotkey', (_e, accel) => registerShortcut('modeHotkey', String(accel || '')));
handle('setFullHotkey', (_e, accel) => registerShortcut('fullHotkey', String(accel || '')));
handle('setMode', (_e, m) => applyMode(m));
// UI preferences live in the same encrypted vault as everything else and come back on restart.
const PREFS = { sidebarWidth: (v) => Math.min(480, Math.max(220, Number(v) || 300)), sidebarCollapsed: (v) => !!v, codeWrap: (v) => !!v, codeCollapse: (v) => !!v,
  shareMode: (v) => (v === 'two' ? 'two' : 'one'), callsRelayOnly: (v) => !!v, recordShares: (v) => !!v, clipboardSync: (v) => !!v, turn: (v) => String(v || '').trim().slice(0, 200), turnUser: (v) => String(v || '').trim().slice(0, 200), turnPass: (v) => String(v || '').slice(0, 200) };
handle('setPref', (_e, key, value) => { if (!Object.hasOwn(PREFS, key)) throw new Error('unknown pref'); settings()[key] = PREFS[key](value); if (key === 'clipboardSync' && !settings().clipboardSync) clip.stop('setting'); store.saveSoon(); push('settings', settings()); return settings()[key]; });
handle('openExternal', (_e, url) => { const u = String(url || ''); if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > 2048) return false; shell.openExternal(u); return true; });
// Dev builds only: lets the UI test suite resize the real window. Not registered in packaged builds.
if (!PROD) handle('devResize', (_e, w, h) => { win.setBounds({ width: Math.max(300, Number(w) | 0), height: Math.max(250, Number(h) | 0) }); return win.getBounds(); });
// Dev builds only, and only with the fake clipboard: the UI tests set and read the text it holds.
if (!PROD) handle('devClip', (_e, op, text) => { if (!CLIP_FAKE) throw new Error('this run has the real clipboard: devClip needs --clip-fake'); if (op === 'set') { fakeClip.text = String(text); return true; } return fakeClip.text; });
handle('setPopups', (_e, o) => { settings().popups = !!o.popups; settings().popupText = !!o.popupText; store.saveSoon(); return { popups: settings().popups, popupText: settings().popupText }; });
handle('testPopup', () => { const c = store.contacts()[0]; showPopup({ pub: c?.pub || 'test', name: c?.name || 'Preview', text: 'This is how a new message pops up. It disappears in a few seconds and never takes focus.', kind: 'text', force: true }); return true; });
handle('setRelay', (_e, address) => { engine.setRelay(address); return { relay: settings().relay || '', status: engine.relayStatus() }; });
handle('setAutostart', (_e, on) => {
  settings().autostart = !!on; store.saveSoon();
  if (isWin) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--start-hidden'] });
  else if (isMac) app.setLoginItemSettings({ openAtLogin: !!on }); // may silently not apply for an unsigned app (Electron docs); README tells users to check Login Items
  return !!on;
});
handle('logPath', () => logPath);
handle('log', (_e, line) => { log.info('share', String(line).slice(0, 1000)); return true; });   // the share readout, every 10 s while a share runs
handle('setTheme', (_e, t) => {
  const v = ['system', 'dark', 'light'].includes(t) ? t : 'system';
  settings().theme = v; store.saveSoon(); nativeTheme.themeSource = v;
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6fa');
  return v;
});
handle('setOpacity', (_e, v) => applyOpacity(v));
handle('discovery', (_e, on) => {
  settings().discovery = !!on; store.saveSoon();
  if (on) engine.transport.startDiscovery(() => ({ invite: engine.discoveryInvite() })); else engine.transport.stopDiscovery();
  return !!on;
});
handle('hide', () => { hideWindow(); return true; });
handle('quit', () => { quitting = true; app.quit(); return true; });
handle('copy', (_e, t) => { clipboard.writeText(String(t || '')); return true; });
handle('paste', () => clipboard.readText());

// --- boot --------------------------------------------------------------------
// Any failure here must surface and quit. An unhandled rejection in boot leaves
// a process with no window that nothing can reach (seen once; never again).
app.whenReady().then(boot).catch((e) => {
  log.error('boot failed', e);
  dialog.showErrorBox('P2P Chat could not start', `${e.message}\n\nData: ${app.getPath('userData')}`);
  app.exit(1);
});

async function boot() {
  const dir = app.getPath('userData');
  log.info(`boot v${app.getVersion()} electron ${process.versions.electron} ${process.platform}/${process.arch} packaged=${PROD} userData=${dir}`);
  if (VARIANT) log.info('variant', VARIANT, NO_BLOCK ? '(no capture blocking)' : '');
  keyInfo = await loadVaultKey(dir);
  log.info(`vault key ready (keychain=${keyInfo.secure})`);
  screenPermAtBoot = screenPermission();
  if (isMac) log.info('screen recording permission at boot:', screenPermAtBoot);
  store = new Store(path.join(dir, 'vault.bin'), keyInfo.key).load();
  settings();
  nativeTheme.themeSource = settings().theme || 'system';
  protocol.handle('p2pblob', (req) => {
    const [, pub = '', id = ''] = new URL(req.url).pathname.split('/');
    const had = store.hasBlob(pub, id);
    const data = store.blob(pub, id); // null for any malformed ref, so no path is ever built from raw input
    if (!data) {
      if (had && engine) { try { engine.fetchImage(pub, id); } catch {} } // the file was there but did not open: it is gone now, pull it again
      return new Response(null, { status: 404 });
    }
    const rec = store.conv(pub).messages.find((x) => x.id === id);
    return new Response(data, { headers: { 'content-type': rec?.mime || 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });

  engine = new Engine(store, new Transport());
  for (const ev of ['contact', 'status', 'update', 'history', 'typing', 'error', 'info', 'discovered', 'relay', 'share']) engine.on(ev, (d) => push(ev, d));
  const sharePops = createSharePops();
  engine.on('share', (f) => { if (sharePops.wants(f)) showPopup({ pub: f.pub, name: store.contact(f.pub)?.name || 'A contact', text: '', kind: 'share' }); });
  engine.on('message', ({ pub, msg }) => push('message', { pub, msg: msgView(pub, msg) }));
  // After sleep the relay link and peer sockets are usually dead without saying so.
  powerMonitor.on('resume', () => engine.kick());
  powerMonitor.on('unlock-screen', () => engine.kick());
  engine.on('message', ({ pub }) => push('contact', { pub }));
  engine.on('message', ({ pub, msg }) => { if (msg.from === 'peer') showPopup({ pub, name: store.contact(pub)?.name || 'New message', text: msg.text, kind: msg.kind }); });
  engine.on('error', (d) => log.error('engine', d.message));
  engine.on('info', (d) => log.info('engine', d.message));
  engine.on('relay', (d) => log.info('relay', d.status, d.reason || ''));
  engine.on('status', (d) => log.info('peer', d.pub.slice(0, 8), d.status, d.reason || ''));
  await engine.start();
  if (settings().discovery) engine.transport.startDiscovery(() => ({ invite: engine.discoveryInvite() }));

  // Background app: no Dock icon on macOS, no taskbar button on Windows.
  if (isMac) { app.dock?.hide(); }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ...(PROD ? [] : [{ label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }])]));

  win = new BrowserWindow({
    width: 1080, height: 740, minWidth: 360, minHeight: 320,
    x: argFlag('x') ? Number(argFlag('x')) : undefined, y: argFlag('y') ? Number(argFlag('y')) : undefined,
    show: false, skipTaskbar: BACKGROUND_APP, minimizable: !BACKGROUND_APP,
    title: instance ? `P2P Chat - ${instance}` : 'P2P Chat',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f4f6fa', // matches theme.css --bg, so no flash before the page paints
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: !PROD, backgroundThrottling: false }, // a share keeps running while the window is hidden
  });
  // The UI is a local file and never navigates or opens windows. Refuse both, and every permission.
  win.webContents.on('before-input-event', (e, input) => {
    if (!PROD && input.type === 'keyDown') log.info('input', input.key, input.code, `meta=${input.meta} ctrl=${input.control} alt=${input.alt} shift=${input.shift}`);
    const d = keysRemote ? 0 : opacityKey(input);   // theirs while I drive their screen in full screen
    if (d) { e.preventDefault(); applyOpacity(clampOpacity(settings().opacity) + d); }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // a reload: the page that held the share and the grant is gone, whatever it was doing
  win.webContents.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) { endGrant('page reload'); clip.stop('page reload'); setKeysRemote(false); sharedDisplay = null; } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Everything is refused except what a screen share needs, and only for this window:
  // the display (served below without a picker) and the microphone (never the camera).
  const ours = (wc) => !!wc && win && !win.isDestroyed() && wc === win.webContents;
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb, details) => cb(ours(wc) && (perm === 'display-capture' || (perm === 'media' && (details?.mediaTypes || []).every((t) => t === 'audio')))));
  win.webContents.session.setPermissionCheckHandler((wc, perm, _origin, details) => ours(wc) && (perm === 'display-capture' || (perm === 'media' && (!details?.mediaType || details.mediaType === 'audio'))));
  // getDisplayMedia from the page gets the display this window is on, no system picker:
  // one click shares, nothing else opens. The window itself stays out of the shared video
  // wherever capture blocking works (macOS, Windows), the same as for screenshots.
  win.webContents.session.setDisplayMediaRequestHandler((req, cb) => {
    if (!win || win.isDestroyed() || req.frame !== win.webContents.mainFrame) return cb(null);
    const { display, want } = targetDisplay();
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => { const src = pickSource(sources, display, want); log.info('display media', src ? src.name : 'no source'); if (src) sharedDisplay = display; cb(src ? { video: src } : null); })
      .catch((e) => { log.error('display media', e); cb(null); });
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.on('console-message', (d) => { if (d.level === 'error' || !PROD) logLine(d.level === 'error' ? 'ERROR' : 'INFO', ['renderer', d.message, d.sourceId, d.lineNumber]); });
  win.webContents.on('preload-error', (_e, p, err) => log.error('preload', p, err));
  win.webContents.on('render-process-gone', (_e, d) => { log.error('renderer gone', d); endGrant('renderer gone'); clip.stop('renderer gone'); setKeysRemote(false); sharedDisplay = null; if (d.reason !== 'clean-exit') win.webContents.reload(); });
  if (isWin) win.setSkipTaskbar(true);
  log.info('window created');
  applyProtection(win);
  applyOpacity(settings().opacity);
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // once, before the first show
  win.on('close', (e) => { if (!quitting && BACKGROUND_APP && (hotkeyOk || tray)) { e.preventDefault(); hideWindow(); } else { quitting = true; } });
  win.on('hide', () => { log.info('window hide event'); push('hidden'); });
  win.on('leave-full-screen', () => { viewerFull = false; setKeysRemote(false); push('fullscreen', { on: false }); });   // the OS took it out (green button, Esc); the viewer follows
  // Elsewhere than on macOS the window is in full screen a moment after the viewer asked for it. The page asks
  // for the key routing right away and is told no; it is told here when the window is there, and asks again.
  win.on('enter-full-screen', () => { if (viewerFull) push('fullscreen', { on: true }); });
  win.on('show', () => { log.info('window show event'); if (isLinux && clampOpacity(settings().opacity) < 0.995) linuxSetOpacity(clampOpacity(settings().opacity)); });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--start-hidden')) showWindow(); });

  // macOS: no menu-bar item either; the hotkey is the only way in (and relaunching the
  // app from Finder/Launchpad, which the single-instance lock turns into "show").
  // Windows keeps a tray icon, as requested.
  if (!isMac) {
    tray = new Tray(trayIcon(process.platform));
    tray.setToolTip('P2P Chat');
    tray.setContextMenu(trayMenu());
    if (isWin) tray.on('click', toggleWindow);
  }

  const CURRENT = { hotkey: DEFAULT_HOTKEY, modeHotkey: DEFAULT_MODE_HOTKEY, fullHotkey: DEFAULT_FULL_HOTKEY };
  for (const k of Object.keys(CURRENT)) if (settings()[k] !== CURRENT[k] && FORMER_DEFAULTS[k].includes(settings()[k])) { settings()[k] = CURRENT[k]; store.saveSoon(); log.info(k, 'moved from a former default to', CURRENT[k]); }
  if (!settings().fullHotkey) settings().fullHotkey = DEFAULT_FULL_HOTKEY;
  let r = registerHotkey(settings().hotkey || DEFAULT_HOTKEY);
  if (!r.ok && settings().hotkey !== DEFAULT_HOTKEY) r = registerHotkey(DEFAULT_HOTKEY); // a custom key that stopped working falls back
  if (!r.ok) { showWindow(); push('error', { message: `The show/hide hotkey (${settings().hotkey}) could not be registered: ${r.error}. Pick another in Settings; until then the window stays open.` }); }
  hotkeyOk = r.ok;
  let rm = registerShortcut('modeHotkey', settings().modeHotkey || DEFAULT_MODE_HOTKEY);
  if (!rm.ok && settings().modeHotkey !== DEFAULT_MODE_HOTKEY) rm = registerShortcut('modeHotkey', DEFAULT_MODE_HOTKEY);
  modeHotkeyOk = rm.ok;
  let rf = registerShortcut('fullHotkey', settings().fullHotkey || DEFAULT_FULL_HOTKEY);
  if (!rf.ok && settings().fullHotkey !== DEFAULT_FULL_HOTKEY) rf = registerShortcut('fullHotkey', DEFAULT_FULL_HOTKEY);
  if (!rf.ok) { log.error('full-screen hotkey unavailable', rf.error); push('error', { message: `The full-screen hotkey (${settings().fullHotkey}) could not be registered: ${rf.error}. Pick another in Settings.` }); }
  if (!rm.ok) { log.error('mode hotkey unavailable', rm.error); if (settings().mode === 'overlay') { settings().mode = 'overlap'; store.saveSoon(); } push('error', { message: `The window-mode hotkey (${settings().modeHotkey}) could not be registered: ${rm.error}. Overlay mode is disabled until you pick another key in Settings.` }); }
  applyMode(settings().mode || 'overlap');
}

app.on('before-quit', () => { quitting = true; clip.stop('quit'); control.stop('quit'); globalShortcut.unregisterAll(); if (popup && !popup.isDestroyed()) popup.destroy(); });
app.on('will-quit', () => { if (engine) engine.stop(); });
app.on('window-all-closed', () => { if (!BACKGROUND_APP) app.quit(); });
app.on('activate', showWindow);
