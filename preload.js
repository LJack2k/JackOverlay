'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  showContextMenu: ()       => ipcRenderer.invoke('show-context-menu'),
  getConfig:       ()       => ipcRenderer.invoke('get-config'),

  // Live corner-radius updates pushed from the main process
  onCornerRadius:  (cb)     => ipcRenderer.on('corner-radius', (_e, px) => cb(px)),
  onMirror:        (cb)     => ipcRenderer.on('mirror', (_e, on) => cb(on)),
  onFit:           (cb)     => ipcRenderer.on('fit', (_e, fit) => cb(fit)),
  onVisible:       (cb)     => ipcRenderer.on('visible', (_e, on) => cb(on)),
  onPan:           (cb)     => ipcRenderer.on('pan', (_e, pan) => cb(pan)),
  onZoom:          (cb)     => ipcRenderer.on('zoom', (_e, z) => cb(z)),
  reportVideoSize: (w, h)   => ipcRenderer.send('video-size', { width: w, height: h }),
  reportCameraError: (msg)  => ipcRenderer.send('camera-error', msg),

  // Camera list / selection
  reportCameras:   (list)   => ipcRenderer.send('cameras-reported', list),
  onSetCamera:     (cb)     => ipcRenderer.on('set-camera', (_e, sel) => cb(sel)),
  // The renderer found the saved camera under a new device id.
  reportCameraId:  (id, label) => ipcRenderer.send('camera-id', { id, label }),

  // Window move / resize, driven from the renderer (see index.html)
  moveStart:       ()       => ipcRenderer.send('move-start'),
  moveBy:          (dx, dy) => ipcRenderer.send('move-by',   { dx, dy }),
  resizeStart:     ()       => ipcRenderer.send('resize-start'),
  resizeBy:        (dx, dy) => ipcRenderer.send('resize-by', { dx, dy }),
  dragEnd:         ()       => ipcRenderer.send('drag-end')
});
