'use strict';
// The notice that stays on this machine's screen for as long as a contact is connected to it
// unattended (main/unattended.js): a small window at the bottom of the shared display, above every
// other window, that says who is connected and has a Disconnect button. It is the one window of the
// app that is never hidden from screen capture: whoever is connected sees it in the picture as well,
// so nobody clicks a button they cannot see.
//
// The session depends on the notice, not the other way round: if the window cannot be shown or goes
// away while a session runs, `onGone` ends the session.
// Kept apart from main.js; it gets Electron's parts handed in.
const W = 440, H = 76;

function createAccessCard({ BrowserWindow, ipcMain, screen, preload, page, isMac, isLinux, onStop, onGone, log }) {
  let card = null, live = false, last = null;
  const mine = (e) => !!card && !card.isDestroyed() && e.sender === card.webContents;
  ipcMain.on('access-stop', (e) => { if (mine(e)) { log.info('unattended access: Disconnect clicked on the notice'); onStop(); } });

  function place(display, h) {
    const d = (display || screen.getPrimaryDisplay()).workArea;
    card.setBounds({ x: Math.round(d.x + (d.width - W) / 2), y: Math.round(d.y + d.height - h - 14), width: W, height: h });
  }
  function ensure() {
    if (card && !card.isDestroyed()) return card;
    card = new BrowserWindow({
      width: W, height: H, show: false, frame: false, transparent: !isLinux, hasShadow: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, type: isMac ? 'panel' : undefined,
      acceptFirstMouse: true,                             // macOS: the window never has the focus, and a click on Disconnect must still be a click
      title: 'P2P Chat: unattended access', webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
    });
    const w = card;
    w.setContentProtection(false);                        // in the picture on purpose (see above)
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.on('close', (e) => { if (live && card === w) e.preventDefault(); });   // not by a window-manager key while a session runs
    w.on('closed', () => { if (card !== w) return; card = null; if (live) { live = false; log.error('unattended access: the notice went away while a session ran'); onGone(); } });
    w.webContents.on('render-process-gone', () => { if (card === w && live) { live = false; try { w.destroy(); } catch {} card = null; onGone(); } });
    w.loadFile(page);
    return w;
  }
  // text: who is connected, as the page worded it. theme: 'dark' | 'light'. display: the one that is shared.
  function show({ text, theme, display }) {
    live = true; last = { text: String(text || '').slice(0, 200), theme, solid: isLinux };
    let w;
    try { w = ensure(); place(display, H); } catch (e) { live = false; log.error('unattended access: the notice could not be made', e); onGone(); return false; }
    const send = () => { if (card === w && live) { w.webContents.send('access', last); if (!w.isVisible()) w.showInactive(); w.moveTop(); } };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
    return true;
  }
  function hide() {
    live = false; last = null;
    const w = card; card = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
  return { show, hide, owns: (w) => !!card && w === card, isUp: () => live && !!card && !card.isDestroyed(), status: () => ({ up: live && !!card && !card.isDestroyed(), visible: !!card && !card.isDestroyed() && card.isVisible(), text: last ? last.text : '', bounds: card && !card.isDestroyed() ? card.getBounds() : null }) };
}

module.exports = { createAccessCard };
