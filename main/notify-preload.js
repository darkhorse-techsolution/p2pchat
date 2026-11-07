'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('notify', {
  onShow: (fn) => ipcRenderer.on('notify', (_e, payload) => fn(payload)),
  sized: (h) => ipcRenderer.send('notify-sized', h),
});
