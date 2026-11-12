'use strict';
// Preload for the hidden captioner window. It passes PCM in and caption text out, nothing else.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cap', {
  // main -> captioner
  onPcm: (fn) => ipcRenderer.on('cap-pcm', (_e, pub, buf) => fn(pub, buf)),
  onControl: (fn) => ipcRenderer.on('cap-control', (_e, msg) => fn(msg)),
  // captioner -> main
  ready: () => ipcRenderer.send('cap-ready'),
  text: (pub, text, final) => ipcRenderer.send('cap-text', pub, text, !!final),
  stat: (m) => ipcRenderer.send('cap-stat', String(m)),
  fail: (m) => ipcRenderer.send('cap-fail', String(m)),
});
