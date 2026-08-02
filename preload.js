'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  showContextMenu: ()       => ipcRenderer.invoke('show-context-menu'),
  getConfig:       ()       => ipcRenderer.invoke('get-config'),

  // Live corner-radius updates pushed from the main process
  onCornerRadius:  (cb)     => ipcRenderer.on('corner-radius', (_e, px) => cb(px)),

  // Window move / resize, driven from the renderer (see index.html)
  moveStart:       ()       => ipcRenderer.send('move-start'),
  moveBy:          (dx, dy) => ipcRenderer.send('move-by',   { dx, dy }),
  resizeStart:     ()       => ipcRenderer.send('resize-start'),
  resizeBy:        (dx, dy) => ipcRenderer.send('resize-by', { dx, dy }),
  dragEnd:         ()       => ipcRenderer.send('drag-end')
});
