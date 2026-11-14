'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('access', {
  onShow: (fn) => ipcRenderer.on('access', (_e, payload) => fn(payload)),
  stop: () => ipcRenderer.send('access-stop'),
});
