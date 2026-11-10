'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('api', {
  state: call('state'), setName: call('setName'), invite: call('invite'),
  addContact: call('addContact'), removeContact: call('removeContact'), renameContact: call('renameContact'),
  setVerified: call('setVerified'), contact: call('contact'), conversation: call('conversation'), conversationPeek: call('conversationPeek'),
  send: call('send'), typing: call('typing'), requestHistory: call('requestHistory'), wipeConversation: call('wipeConversation'),
  screenshot: call('screenshot'), saveImage: call('saveImage'), copyImage: call('copyImage'), fetchImage: call('fetchImage'), openScreenSettings: call('openScreenSettings'),
  share: call('share'), iceConfig: call('iceConfig'), fullscreen: call('fullscreen'), recordStart: call('recordStart'), recordChunk: call('recordChunk'), recordStop: call('recordStop'), openRecordings: call('openRecordings'), controlGrant: call('controlGrant'), controlRevoke: call('controlRevoke'), input: (ev) => ipcRenderer.send('input', ev), micPermission: call('micPermission'), screenPermission: call('screenPermission'),
  protection: call('protection'), setHotkey: call('setHotkey'), setModeHotkey: call('setModeHotkey'), setFullHotkey: call('setFullHotkey'), setMode: call('setMode'), setPopups: call('setPopups'), testPopup: call('testPopup'), setPref: call('setPref'), openExternal: call('openExternal'), devResize: call('devResize'), setRelay: call('setRelay'), setAutostart: call('setAutostart'), setOpacity: call('setOpacity'), logPath: call('logPath'), log: call('log'), setTheme: call('setTheme'), discovery: call('discovery'),
  hide: call('hide'), quit: call('quit'), copy: call('copy'), paste: call('paste'),
  platform: process.platform,
  onEvent: (fn) => ipcRenderer.on('event', (_e, payload) => fn(payload)),
});
