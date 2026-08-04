'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Deliberately separate from the overlay's preload: the settings window has no
// business being able to drag or resize the overlay, and the overlay has no
// business writing arbitrary settings.
contextBridge.exposeInMainWorld('settings', {
  get:        ()      => ipcRenderer.invoke('settings:get'),
  apply:      (patch) => ipcRenderer.invoke('settings:apply', patch),
  openConfig: ()      => ipcRenderer.invoke('settings:openConfig'),
  save:       ()      => ipcRenderer.invoke('settings:save'),
  close:      ()      => ipcRenderer.send('settings:close'),

  // Pushed whenever anything changes the overlay, including from the tray menu,
  // a hotkey or the Stream Deck — so the screen never shows a stale value.
  onChange:   (cb)    => ipcRenderer.on('settings', (_e, snapshot) => cb(snapshot))
});
