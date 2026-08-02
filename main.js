'use strict';

const {
  app, BrowserWindow, globalShortcut, Tray, Menu,
  nativeImage, ipcMain, screen, shell
} = require('electron');
const path = require('path');
const fs   = require('fs');
const { spawn, execFileSync } = require('child_process');
const { startControlServer } = require('./control-server');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, 'config.json');

const MIN_W = 160;
const MIN_H = 120;

const RADIUS_PRESETS = [0, 6, 10, 16, 24, 32, 48];

const CORNERS = {
  'top-left':     'Top left',
  'top-right':    'Top right',
  'bottom-left':  'Bottom left',
  'bottom-right': 'Bottom right'
};

// Slack when deciding which corner a window is parked in, so a corner still
// reads as "current" after a rounding pass through setBounds.
const CORNER_TOLERANCE = 2;

const MIN_OPACITY = 0.1;    // below this a window is invisible AND unclickable
const MAX_RADIUS  = 200;

const FITS = {
  cover:   'Fill & crop',
  contain: 'Fit whole image',
  fill:    'Stretch'
};

// Registry value name under HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
const STARTUP_NAME = 'Webcam Overlay';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function defaultOverlay(id, name) {
  return {
    id,
    name,
    window: { x: null, y: null, width: 320, height: 240, opacity: 0.95 },
    // Kept out of `window` on purpose: saveBounds() deliberately skips writing
    // while maximized, whereas visibility should always be recorded.
    visible: true,
    corner_radius: 16,
    // Mirror the image left-to-right. Natural for a face cam, wrong for a camera
    // pointed at anything else (text reads backwards), so it defaults to off.
    mirror: false,
    // How the image fills the window: 'cover' crops to fill, 'contain' shows the
    // whole frame letterboxed, 'fill' stretches (and distorts).
    fit: 'cover',
    // The id selects the device; the label is kept so the right camera can be
    // found again if Chromium reissues device ids.
    camera_id:    null,
    camera_label: null
  };
}

const DEFAULT_CONFIG = {
  hotkeys: {
    toggle_visibility: 'CommandOrControl+Alt+W',
    toggle_maximize:   'CommandOrControl+Alt+M'
  },
  // Gap left between a window and the screen edge when snapping to a corner.
  corner_margin: 24,
  // Command or absolute path used by "Open config.json".
  // null = auto-detect (VS Code, then Notepad++, then Notepad).
  editor: null,
  // Loopback port external controllers talk to. 0 disables the control server.
  control_port: 28492,
  overlays: [defaultOverlay('main', 'Main')]
};

// Text of the last config we wrote ourselves, so the file watcher can tell our
// own saves apart from a real external edit.
let lastWrittenConfig = null;

/**
 * Brings a pre-multi-overlay config forward. Before this, a single overlay's
 * settings lived at the top level; they are now the first entry of `overlays`.
 */
function migrateConfig(raw) {
  if (Array.isArray(raw.overlays) && raw.overlays.length) return raw;

  const first = defaultOverlay('main', 'Main');
  if (raw.window)                     first.window        = { ...first.window, ...raw.window };
  if (raw.corner_radius !== undefined) first.corner_radius = raw.corner_radius;
  if (raw.camera_id     !== undefined) first.camera_id     = raw.camera_id;
  if (raw.camera_label  !== undefined) first.camera_label  = raw.camera_label;

  raw.overlays = [first];
  delete raw.window;
  delete raw.corner_radius;
  delete raw.camera_id;
  delete raw.camera_label;
  return raw;
}

function fillDefaults(cfgIn) {
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (k === 'overlays') continue;
    if (!(k in cfgIn)) { cfgIn[k] = v; continue; }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) {
        if (!(kk in cfgIn[k])) cfgIn[k][kk] = vv;
      }
    }
  }

  if (!Array.isArray(cfgIn.overlays) || !cfgIn.overlays.length) {
    cfgIn.overlays = [defaultOverlay('main', 'Main')];
  }
  cfgIn.overlays = cfgIn.overlays.map((o, i) => {
    const base = defaultOverlay(o.id || `overlay-${i + 1}`, o.name || `Overlay ${i + 1}`);
    return { ...base, ...o, window: { ...base.window, ...(o.window || {}) } };
  });
  return cfgIn;
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return fillDefaults(migrateConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))));
    } catch (_) { /* fall through to defaults */ }
  }
  const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  saveConfig(fresh);
  return fresh;
}

function saveConfig(c) {
  try {
    const text = JSON.stringify(c, null, 2);
    lastWrittenConfig = text;
    fs.writeFileSync(CONFIG_PATH, text);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tray icon (16×16 blue circle, generated at runtime — no asset file needed)
// ---------------------------------------------------------------------------

function makeTrayIcon() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAN0lEQVR4nGNgoAnY8v8/VkyRZqIMIaQZryHEasZqCKmaMQwZNYAKBlAcjVRJSMQaQhSgSDOJAABJ26SIN6ER1AAAAABJRU5ErkJggg==';
  return nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let cfg  = null;
let tray = null;
let control = null;
let settingsWin = null;

// id -> { id, win, mode, windowedBounds, dragOrigin }
const overlays = new Map();

// Video inputs, as reported by an overlay renderer. Enumerated there rather than
// here because device *labels* are only exposed to a context that has been
// granted camera permission, and the overlays are the contexts that asked.
let cameras = [];

// Which hotkeys actually registered, so the settings screen can say so.
let hotkeyStatus = {};

function confOf(ov)      { return cfg.overlays.find((o) => o.id === ov.id); }
function liveOverlays()  { return cfg.overlays.map((o) => overlays.get(o.id)).filter(Boolean); }
function primaryOverlay() { return liveOverlays()[0] || null; }

/** Which overlay a renderer IPC message came from. */
function overlayFor(event) {
  for (const ov of overlays.values()) {
    if (ov.win && !ov.win.isDestroyed() && ov.win.webContents === event.sender) return ov;
  }
  return null;
}

/**
 * Resolves a control-channel / settings target. Omitted means the primary
 * overlay, so controllers written before multi-overlay support keep working;
 * "*" means every overlay.
 */
function targets(id) {
  if (id === '*') return liveOverlays();
  if (!id) return [primaryOverlay()].filter(Boolean);
  const ov = overlays.get(id);
  return ov ? [ov] : [];
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Bounds persistence
// ---------------------------------------------------------------------------

function saveBounds(ov) {
  if (!ov || !ov.win || ov.win.isDestroyed() || ov.mode !== 'windowed') return;
  const conf = confOf(ov);
  if (!conf) return;
  const b = ov.win.getBounds();
  conf.window.x = b.x;
  conf.window.y = b.y;
  conf.window.width  = b.width;
  conf.window.height = b.height;
  saveConfig(cfg);
  // Moving or resizing can take a window out of a corner, so controllers need to
  // hear about it too — otherwise a corner button stays lit after a drag.
  broadcastState();
}

// ---------------------------------------------------------------------------
// Corner radius / opacity
// ---------------------------------------------------------------------------

function applyCornerRadius(ov) {
  if (ov.win && !ov.win.isDestroyed()) {
    ov.win.webContents.send('corner-radius', confOf(ov).corner_radius);
  }
}

function applyMirror(ov) {
  if (ov.win && !ov.win.isDestroyed()) {
    ov.win.webContents.send('mirror', !!confOf(ov).mirror);
  }
}

function setMirror(ov, on) {
  confOf(ov).mirror = !!on;
  saveConfig(cfg);
  applyMirror(ov);
  broadcastState();
}

function applyFit(ov) {
  if (ov.win && !ov.win.isDestroyed()) {
    ov.win.webContents.send('fit', confOf(ov).fit);
  }
}

function setFit(ov, fit) {
  if (!(fit in FITS)) return;
  confOf(ov).fit = fit;
  saveConfig(cfg);
  applyFit(ov);
  broadcastState();
}

/**
 * Resizes the window to the camera's own aspect ratio, keeping the current width.
 * This is the real fix for a source whose shape doesn't match the window — with
 * 'cover' the mismatch shows up as heavy cropping, with 'contain' as letterboxing.
 */
function fitWindowToCamera(ov) {
  const v = ov.video;
  if (!v || !v.width || !v.height) return false;
  if (ov.mode === 'maximized') windowModeWindow(ov);

  const b = ov.win.getBounds();
  const height = Math.round(clamp(b.width * (v.height / v.width), MIN_H, 4096));
  ov.win.setBounds({ x: b.x, y: b.y, width: b.width, height });
  saveBounds(ov);
  return true;
}

function setCornerRadius(ov, px) {
  confOf(ov).corner_radius = Math.round(clamp(px, 0, MAX_RADIUS));
  saveConfig(cfg);
  applyCornerRadius(ov);
  broadcastState();
}

function setOpacity(ov, value) {
  const v = Math.round(clamp(value, MIN_OPACITY, 1) * 100) / 100;
  ov.win.setOpacity(v);
  confOf(ov).window.opacity = v;
  saveConfig(cfg);
  broadcastState();
}

// ---------------------------------------------------------------------------
// Camera selection
// ---------------------------------------------------------------------------

function setCamera(ov, id, label) {
  const conf = confOf(ov);
  conf.camera_id    = id    || null;
  conf.camera_label = label || null;
  saveConfig(cfg);
  if (ov.win && !ov.win.isDestroyed()) ov.win.webContents.send('set-camera', conf.camera_id);
  pushSettings();
  broadcastState();
}

// Control-channel picker. Accepts a device id, or a case-insensitive substring
// of the label — ids are opaque hashes, so a label is far more usable from a
// script. No argument means the system default.
function selectCamera(ov, msg) {
  if (msg.id) {
    const byId = cameras.find((c) => c.deviceId === msg.id);
    if (byId) setCamera(ov, byId.deviceId, byId.label);
    return;
  }
  if (msg.label) {
    const needle = String(msg.label).toLowerCase();
    const byLabel = cameras.find((c) => (c.label || '').toLowerCase().includes(needle));
    if (byLabel) setCamera(ov, byLabel.deviceId, byLabel.label);
    return;
  }
  setCamera(ov, null, null);
}

// ---------------------------------------------------------------------------
// Start with Windows (global, not per overlay)
// ---------------------------------------------------------------------------

function startupTarget() {
  // Unpackaged, process.execPath is electron.exe itself. Launching that with no
  // arguments opens Electron's default welcome window instead of this app, so
  // the app directory has to be passed explicitly.
  //
  // `name` is the registry value under HKCU\...\Run. Without it an unpackaged
  // app registers as "electron.app.Electron", which is meaningless in Task
  // Manager's Startup tab and liable to collide with other Electron apps.
  const target = { name: STARTUP_NAME };
  return app.isPackaged
    ? { ...target, path: process.execPath, args: [] }
    : { ...target, path: process.execPath, args: [app.getAppPath()] };
}

function startsWithWindows() {
  if (process.platform !== 'win32') {
    try { return app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
  }
  // setLoginItemSettings() accepts a `name` for the registry value, but
  // LoginItemSettingsOptions — what getLoginItemSettings() takes — has no such
  // field, so it would look for the default "electron.app.Electron" instead and
  // always report false. Read back the value we actually wrote.
  try {
    execFileSync('reg', ['query', RUN_KEY, '/v', STARTUP_NAME],
                 { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return true;
  } catch (_) {
    return false;   // reg exits non-zero when the value does not exist
  }
}

function setStartWithWindows(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, ...startupTarget() });
    console.log(`Start with Windows: ${startsWithWindows() ? 'on' : 'off'}`);
  } catch (e) {
    console.error(`Could not change the startup setting: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// External editor for config.json
// ---------------------------------------------------------------------------

let cachedEditor;   // undefined = not resolved yet

function which(cmd) {
  try {
    const lines = execFileSync('where', [cmd], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    }).toString().trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    // `where code` lists BOTH `bin\code` (an extensionless shell script) and
    // `bin\code.cmd`. Only the latter can be launched on Windows, and `where`
    // returns the unusable one first — so pick by extension, not by order.
    return lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) || lines[0];
  } catch (_) { return null; }
}

function resolveEditor() {
  if (cachedEditor !== undefined) return cachedEditor;

  const tries = [];
  if (cfg.editor) tries.push(cfg.editor);
  tries.push('code', 'code-insiders', 'notepad++.exe', 'notepad.exe');

  for (const t of tries) {
    if (path.isAbsolute(t)) {
      if (fs.existsSync(t)) { cachedEditor = t; return cachedEditor; }
      continue;
    }
    const found = which(t);
    if (found) { cachedEditor = found; return cachedEditor; }
  }
  cachedEditor = 'notepad.exe';
  return cachedEditor;
}

function fallbackOpen(editor, why) {
  // Deliberately Notepad rather than shell.openPath(): with no registered .json
  // handler, openPath shows the "How do you want to open this file?" picker,
  // which is exactly what the editor detection exists to avoid.
  console.error(`Could not launch editor "${editor}": ${why} — falling back to Notepad.`);
  try {
    spawn('notepad.exe', [CONFIG_PATH], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {
    shell.openPath(CONFIG_PATH);
  }
}

function openConfigInEditor() {
  const editor = resolveEditor();
  // Anything that isn't a plain .exe — a .cmd shim, or an extensionless shell
  // script like VS Code's bin\code — cannot be handed to CreateProcess directly
  // and has to go through the shell.
  const viaShell = !/\.exe$/i.test(editor);

  let child;
  try {
    child = viaShell
      ? spawn(`"${editor}" "${CONFIG_PATH}"`,
              { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(editor, [CONFIG_PATH],
              { detached: true, stdio: 'ignore', windowsHide: true });
  } catch (e) {
    return fallbackOpen(editor, e.message);
  }

  // spawn() reports a missing executable asynchronously via 'error', so a
  // try/catch on its own would silently do nothing at all.
  child.on('error', (e) => fallbackOpen(editor, e.message));
  child.unref();
  console.log(`config.json opened in: ${editor}`);
}

// ---------------------------------------------------------------------------
// Window modes
// ---------------------------------------------------------------------------

// Persisted so an overlay comes back the way it was left, like every other
// per-overlay setting.
function saveVisibility(ov) {
  const conf = confOf(ov);
  if (!conf) return;
  const vis = !!(ov.win && !ov.win.isDestroyed() && ov.win.isVisible());
  if (conf.visible === vis) return;      // don't churn the file on no-op toggles
  conf.visible = vis;
  saveConfig(cfg);
}

function showWindow(ov) {
  ov.win.show();
  ov.win.focus();
  saveVisibility(ov);
  broadcastState();
}

function maximizeWindow(ov) {
  if (ov.mode !== 'maximized') {
    ov.windowedBounds = ov.win.getBounds();
    // Set mode BEFORE setBounds so saveBounds() can never persist maximized bounds.
    ov.mode = 'maximized';
    // workArea, not bounds: keeps the taskbar — and therefore the tray icon —
    // reachable while maximized.
    const { workArea } = screen.getDisplayMatching(ov.windowedBounds);
    ov.win.setBounds(workArea);
  }
  showWindow(ov);
}

function windowModeWindow(ov) {
  ov.mode = 'windowed';
  const conf = confOf(ov);
  const b = ov.windowedBounds;
  if (b) {
    ov.win.setBounds(b);
  } else if (conf.window.x != null && conf.window.y != null) {
    ov.win.setBounds({
      x: conf.window.x, y: conf.window.y,
      width: conf.window.width, height: conf.window.height
    });
  } else {
    ov.win.setSize(conf.window.width, conf.window.height);
  }
  showWindow(ov);
  saveBounds(ov);
}

// skipTaskbar:true means a real minimize() would leave no taskbar button to
// click, so hide() is the recoverable equivalent — the tray icon and the
// show/hide hotkey both bring it back.
function minimizeWindow(ov) {
  ov.win.hide();
  saveVisibility(ov);
  broadcastState();
}

function toggleMaximize(ov) {
  if (ov.mode === 'maximized') windowModeWindow(ov);
  else maximizeWindow(ov);
}

function toggleVisibility(ov) {
  if (ov.win.isVisible()) minimizeWindow(ov);
  else showWindow(ov);
}

// ---------------------------------------------------------------------------
// Screen-corner presets
// ---------------------------------------------------------------------------

// Where a window would sit if parked in `corner` on the display it's on now.
// workArea, not bounds, so it never lands under the taskbar.
function cornerOrigin(corner, bounds) {
  const { workArea } = screen.getDisplayMatching(bounds);
  const m = cfg.corner_margin;
  return {
    x: corner.endsWith('left')
      ? workArea.x + m
      : workArea.x + workArea.width - bounds.width - m,
    y: corner.startsWith('top')
      ? workArea.y + m
      : workArea.y + workArea.height - bounds.height - m
  };
}

function snapToCorner(ov, corner) {
  if (!(corner in CORNERS)) return;

  // A maximized window has no corner to speak of, so drop back to windowed
  // first rather than silently doing nothing.
  if (ov.mode === 'maximized') windowModeWindow(ov);

  const b = ov.win.getBounds();
  const { x, y } = cornerOrigin(corner, b);
  ov.win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  showWindow(ov);
  saveBounds(ov);
}

// Which corner a window is parked in, or null if it's somewhere else.
function currentCorner(ov) {
  if (!ov || !ov.win || ov.win.isDestroyed() || ov.mode !== 'windowed') return null;
  const b = ov.win.getBounds();
  for (const corner of Object.keys(CORNERS)) {
    const { x, y } = cornerOrigin(corner, b);
    if (Math.abs(b.x - x) <= CORNER_TOLERANCE && Math.abs(b.y - y) <= CORNER_TOLERANCE) {
      return corner;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overlay lifecycle
// ---------------------------------------------------------------------------

function buildWindow(conf) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = conf.window.width;
  const h = conf.window.height;
  const x = conf.window.x ?? sw - w - 24;
  const y = conf.window.y ?? sh - h - 24;

  const win = new BrowserWindow({
    x, y, width: w, height: h,
    minWidth: MIN_W, minHeight: MIN_H,
    // Restore the visibility it was left with. The page still loads while
    // hidden, so the camera and radius are ready the moment it is shown.
    show:        conf.visible !== false,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   true,
    hasShadow:   false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setOpacity(conf.window.opacity);
  win.loadFile('index.html');
  return win;
}

function createOverlay(conf) {
  const ov = {
    id: conf.id,
    win: buildWindow(conf),
    // Always starts windowed so a maximized quit can never leave an overlay
    // stuck filling the screen on next launch.
    mode: 'windowed',
    windowedBounds: null,
    dragOrigin: null
  };

  ov.windowedBounds = ov.win.getBounds();
  ov.win.webContents.on('did-finish-load', () => {
    applyCornerRadius(ov);
    applyMirror(ov);
    applyFit(ov);
  });

  // Native edge-resize still fires these; renderer-driven move/resize saves on
  // its own drag-end. Programmatic setBounds() does not fire either event.
  let moveTimer = null;
  ov.win.on('moved',   () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => saveBounds(ov), 300); });
  ov.win.on('resized', () => saveBounds(ov));

  overlays.set(ov.id, ov);
  return ov;
}

function addOverlay() {
  // Unique id that survives removals in the middle of the list.
  let n = cfg.overlays.length + 1;
  while (cfg.overlays.some((o) => o.id === `overlay-${n}`)) n++;

  const conf = defaultOverlay(`overlay-${n}`, `Overlay ${n}`);
  const from = primaryOverlay();
  if (from) {
    // Cascade off the existing one so the new window isn't hidden underneath it.
    const b = from.win.getBounds();
    const { workArea } = screen.getDisplayMatching(b);
    conf.window.width  = b.width;
    conf.window.height = b.height;
    conf.window.x = clamp(b.x - b.width - cfg.corner_margin,
                          workArea.x, workArea.x + workArea.width  - b.width);
    conf.window.y = clamp(b.y, workArea.y, workArea.y + workArea.height - b.height);
  }

  cfg.overlays.push(conf);
  saveConfig(cfg);
  createOverlay(conf);
  pushSettings();
  broadcastState();
  console.log(`Added overlay "${conf.name}" (${conf.id})`);
  return conf.id;
}

function removeOverlay(id) {
  // Keep at least one, otherwise there is nothing left for the hotkeys to act on
  // and the app becomes a tray icon with no purpose.
  if (cfg.overlays.length <= 1) return false;

  const ov = overlays.get(id);
  if (!ov) return false;

  overlays.delete(id);
  cfg.overlays = cfg.overlays.filter((o) => o.id !== id);
  saveConfig(cfg);
  if (ov.win && !ov.win.isDestroyed()) ov.win.destroy();
  pushSettings();
  broadcastState();
  console.log(`Removed overlay ${id}`);
  return true;
}

function renameOverlay(id, name) {
  const conf = cfg.overlays.find((o) => o.id === id);
  if (!conf) return;
  conf.name = String(name || '').trim() || conf.id;
  saveConfig(cfg);
  pushSettings();
  broadcastState();
}

// ---------------------------------------------------------------------------
// Control channel
// ---------------------------------------------------------------------------

let stateTimer = null;

function overlayState(ov) {
  const conf = confOf(ov);
  return {
    id:      ov.id,
    name:    conf.name,
    mode:    ov.mode,
    visible: !!ov.win && !ov.win.isDestroyed() && ov.win.isVisible(),
    opacity: ov.win && !ov.win.isDestroyed() ? Math.round(ov.win.getOpacity() * 100) / 100 : 1,
    radius:  conf.corner_radius,
    mirror:  !!conf.mirror,
    fit:     conf.fit,
    corner:  currentCorner(ov),
    camera:  conf.camera_label,
    // Intrinsic size of the live stream, once the renderer has reported it.
    video:   ov.video || null
  };
}

function currentState() {
  const list = liveOverlays().map(overlayState);
  // The primary overlay's fields stay at the top level so controllers written
  // before multi-overlay support keep working unchanged.
  const first = list[0] || { mode: 'windowed', visible: false, opacity: 1, radius: 0, corner: null };
  return {
    mode:    first.mode,
    visible: first.visible,
    opacity: first.opacity,
    radius:  first.radius,
    corner:  first.corner,
    startup: startsWithWindows(),
    overlays: list
  };
}

// Coalesced: one action often touches several setters (maximize also shows), and
// controllers only care about the settled result.
function broadcastState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    if (control) control.broadcast({ event: 'state', ...currentState() });
    pushSettings();
  }, 20);
}

function handleControlCommand(msg) {
  const cmd = String(msg && msg.cmd);

  // Overlay-independent verbs first.
  switch (cmd) {
    case 'getState':     broadcastState(); return;
    case 'setStartup':   setStartWithWindows(msg.enabled); broadcastState(); return;
    case 'openSettings': openSettings();   return;
    case 'addOverlay':   addOverlay();     return;
    case 'removeOverlay': removeOverlay(String(msg.overlay || '')); return;
    case 'quit':         app.quit();       return;
  }

  for (const ov of targets(msg.overlay)) {
    switch (cmd) {
      case 'show':             showWindow(ov);        break;
      case 'hide':             minimizeWindow(ov);    break;
      case 'toggleVisibility': toggleVisibility(ov);  break;
      case 'maximize':         maximizeWindow(ov);    break;
      case 'windowMode':       windowModeWindow(ov);  break;
      case 'toggleMaximize':   toggleMaximize(ov);    break;
      case 'setOpacity':       setOpacity(ov, msg.value); break;
      case 'nudgeOpacity':     setOpacity(ov, ov.win.getOpacity() + Number(msg.delta || 0)); break;
      case 'setRadius':        setCornerRadius(ov, msg.value); break;
      case 'nudgeRadius':      setCornerRadius(ov, confOf(ov).corner_radius + Number(msg.delta || 0)); break;
      case 'snapCorner':       snapToCorner(ov, String(msg.corner)); break;
      case 'setCamera':        selectCamera(ov, msg); break;
      case 'setMirror':        setMirror(ov, msg.enabled); break;
      case 'toggleMirror':     setMirror(ov, !confOf(ov).mirror); break;
      case 'setFit':           setFit(ov, String(msg.fit)); break;
      case 'fitToCamera':      fitWindowToCamera(ov); break;
      default:                 return;                // unknown verb: ignore
    }
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Live reload of hand-edited config.json
// ---------------------------------------------------------------------------

function watchConfig() {
  try {
    // watchFile (polling) rather than watch(): editors often save by
    // rename-and-replace, which invalidates an fs.watch handle on Windows.
    fs.watchFile(CONFIG_PATH, { interval: 1000 }, reloadConfigFromDisk);
  } catch (_) { /* live reload is a nicety — never fatal */ }
}

function reloadConfigFromDisk() {
  let text;
  try { text = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (_) { return; }
  if (text === lastWrittenConfig) return;      // our own save

  let next;
  try { next = JSON.parse(text); } catch (_) { return; }   // mid-save / invalid JSON

  const prevHotkeys = JSON.stringify(cfg.hotkeys);
  cfg = fillDefaults(migrateConfig(next));
  cachedEditor = undefined;                    // cfg.editor may have changed

  // Add or drop windows so the running set matches the file.
  for (const conf of cfg.overlays) {
    if (!overlays.has(conf.id)) createOverlay(conf);
  }
  for (const id of [...overlays.keys()]) {
    if (!cfg.overlays.some((o) => o.id === id)) {
      const ov = overlays.get(id);
      overlays.delete(id);
      if (ov.win && !ov.win.isDestroyed()) ov.win.destroy();
    }
  }

  for (const ov of liveOverlays()) {
    const conf = confOf(ov);
    ov.win.setOpacity(conf.window.opacity);
    applyCornerRadius(ov);
    applyMirror(ov);
    applyFit(ov);
    ov.win.webContents.send('set-camera', conf.camera_id);

    // Raw show/hide rather than the helpers: those persist, which would write
    // the file straight back during a reload of that same file.
    const wantVisible = conf.visible !== false;
    if (wantVisible && !ov.win.isVisible()) ov.win.show();
    else if (!wantVisible && ov.win.isVisible()) ov.win.hide();

    if (ov.mode === 'windowed' && conf.window.x != null && conf.window.y != null) {
      ov.win.setBounds({
        x: conf.window.x, y: conf.window.y,
        width:  Math.max(MIN_W, conf.window.width),
        height: Math.max(MIN_H, conf.window.height)
      });
      ov.windowedBounds = ov.win.getBounds();
    }
  }

  if (JSON.stringify(cfg.hotkeys) !== prevHotkeys) {
    globalShortcut.unregisterAll();
    registerHotkeys();
  }

  broadcastState();
  console.log('config.json reloaded.');
}

// ---------------------------------------------------------------------------
// Settings window
// ---------------------------------------------------------------------------

function settingsSnapshot() {
  return {
    config:     cfg,
    cameras,
    startup:    startsWithWindows(),
    hotkeyOk:   hotkeyStatus,
    configPath: CONFIG_PATH,
    editor:     resolveEditor(),
    overlays:   liveOverlays().map((ov) => ({
      ...overlayState(ov),
      bounds: ov.win.getBounds()
    }))
  };
}

function pushSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings', settingsSnapshot());
  }
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 600, height: 880,
    minWidth: 480, minHeight: 460,
    title: 'Webcam Overlay — Settings',
    backgroundColor: '#1e2126',
    autoHideMenuBar: true,
    // The overlays are alwaysOnTop; without this the settings window would open
    // behind them and look like nothing happened.
    alwaysOnTop: true,
    webPreferences: {
      preload:          path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

/**
 * Applies a partial settings change. Everything routes through the same setters
 * the menus use, so there is one code path per setting and the interfaces cannot
 * drift apart. `patch.overlay` picks the target; omitted means the primary one.
 */
function applySettings(patch) {
  if (!patch || typeof patch !== 'object') return;

  // Global settings
  if ('startup'       in patch) setStartWithWindows(patch.startup);
  if ('corner_margin' in patch) {
    cfg.corner_margin = Math.round(clamp(patch.corner_margin, 0, 400));
    saveConfig(cfg);
  }
  if ('editor' in patch) {
    cfg.editor = patch.editor || null;
    cachedEditor = undefined;              // re-resolve on next use
    saveConfig(cfg);
  }
  if ('control_port' in patch) {
    // Bound once at startup, so this one genuinely needs a restart.
    cfg.control_port = Math.round(clamp(patch.control_port, 0, 65535));
    saveConfig(cfg);
  }
  if ('hotkeys' in patch) {
    cfg.hotkeys = { ...cfg.hotkeys, ...patch.hotkeys };
    saveConfig(cfg);
    globalShortcut.unregisterAll();
    registerHotkeys();
  }

  // Overlay management
  if (patch.addOverlay)    addOverlay();
  if (patch.removeOverlay) removeOverlay(String(patch.removeOverlay));

  // Per-overlay settings
  for (const ov of targets(patch.overlay)) {
    if ('name'          in patch) renameOverlay(ov.id, patch.name);
    if ('opacity'       in patch) setOpacity(ov, patch.opacity);
    if ('corner_radius' in patch) setCornerRadius(ov, patch.corner_radius);
    if ('mirror'        in patch) setMirror(ov, patch.mirror);
    if ('fit'           in patch) setFit(ov, String(patch.fit));
    if (patch.fitToCamera)        fitWindowToCamera(ov);
    if ('corner'        in patch) snapToCorner(ov, String(patch.corner));
    if ('camera_id'     in patch) setCamera(ov, patch.camera_id, patch.camera_label);
    if ('width' in patch || 'height' in patch) {
      const b = ov.win.getBounds();
      ov.win.setBounds({
        x: b.x, y: b.y,
        width:  Math.round(clamp(patch.width  ?? b.width,  MIN_W, 4096)),
        height: Math.round(clamp(patch.height ?? b.height, MIN_H, 4096))
      });
      saveBounds(ov);
    }
  }

  broadcastState();
  pushSettings();
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function opacityItems(ov) {
  const current = Math.round(ov.win.getOpacity() * 100);
  return [100, 80, 60, 40].map((pct) => ({
    label:   `${pct}%`,
    type:    'radio',
    checked: current === pct,
    click:   () => setOpacity(ov, pct / 100)
  }));
}

function radiusItems(ov) {
  const conf = confOf(ov);
  const items = RADIUS_PRESETS.map((px) => ({
    label:   px === 0 ? 'Square (0 px)' : `${px} px`,
    type:    'radio',
    checked: conf.corner_radius === px,
    click:   () => setCornerRadius(ov, px)
  }));

  // A hand-edited config.json can hold any value; show it rather than leaving
  // the submenu looking like nothing is selected.
  if (!RADIUS_PRESETS.includes(conf.corner_radius)) {
    items.push(
      { type: 'separator' },
      { label: `Custom: ${conf.corner_radius} px  (from config.json)`,
        type: 'radio', checked: true, enabled: false }
    );
  }
  return items;
}

function cornerItems(ov) {
  const current = currentCorner(ov);
  const isMax = ov.mode === 'maximized';
  return Object.entries(CORNERS).map(([key, label]) => ({
    label,
    type:    'radio',
    // Nothing is "current" while maximized, so leave them all unchecked rather
    // than implying the window is parked somewhere it isn't.
    checked: !isMax && current === key,
    click:   () => snapToCorner(ov, key)
  }));
}

/** The controls for one overlay, used inline in its own menu and nested in the tray. */
function overlayItems(ov) {
  const isMax  = ov.mode === 'maximized';
  const hidden = !ov.win.isVisible();
  const items = [];

  if (hidden) items.push({ label: 'Show', click: () => showWindow(ov) }, { type: 'separator' });

  items.push(
    { label: 'Maximize',    enabled: !(isMax && !hidden),  click: () => maximizeWindow(ov) },
    { label: 'Minimize',    enabled: !hidden,              click: () => minimizeWindow(ov) },
    { label: 'Window mode', enabled: !(!isMax && !hidden), click: () => windowModeWindow(ov) },
    { type: 'separator' },
    { label: 'Move to corner', submenu: cornerItems(ov) },
    { type: 'separator' },
    { label: 'Corner radius',  submenu: radiusItems(ov) },
    { label: 'Opacity',        submenu: opacityItems(ov) },
    {
      label: 'Image fit',
      submenu: Object.entries(FITS).map(([key, label]) => ({
        label,
        type:    'radio',
        checked: confOf(ov).fit === key,
        click:   () => setFit(ov, key)
      }))
    },
    {
      label:   'Mirror image',
      type:    'checkbox',
      checked: !!confOf(ov).mirror,
      click:   (item) => setMirror(ov, item.checked)
    },
    {
      label: ov.video
        ? `Fit window to camera  (${ov.video.width}×${ov.video.height})`
        : 'Fit window to camera',
      enabled: !!ov.video,
      click: () => fitWindowToCamera(ov)
    }
  );
  return items;
}

function buildWindowMenu(ov) {
  const hkVis = cfg.hotkeys.toggle_visibility;
  const hkMax = cfg.hotkeys.toggle_maximize;

  return [
    { label: confOf(ov).name, enabled: false },
    { type: 'separator' },
    ...overlayItems(ov),
    { type: 'separator' },
    { label: 'Add another overlay', click: () => addOverlay() },
    { label: 'Remove this overlay',
      enabled: cfg.overlays.length > 1,
      click: () => removeOverlay(ov.id) },
    { type: 'separator' },
    { label: `Hotkeys:  ${hkMax} = maximize / window`, enabled: false },
    { label: `          ${hkVis} = show / hide (all)`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    {
      label:   'Start with Windows',
      type:    'checkbox',
      checked: startsWithWindows(),
      // `item.checked` is already the post-click value.
      click:   (item) => setStartWithWindows(item.checked)
    },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ];
}

function buildTrayMenu() {
  const list = liveOverlays();
  const anyHidden = list.some((ov) => !ov.win.isVisible());

  const items = [
    { label: anyHidden ? 'Show all' : 'Hide all',
      click: () => { for (const ov of list) anyHidden ? showWindow(ov) : minimizeWindow(ov); } },
    { type: 'separator' }
  ];

  for (const ov of list) {
    items.push({ label: confOf(ov).name, submenu: overlayItems(ov) });
  }

  items.push(
    { type: 'separator' },
    { label: 'Add another overlay', click: () => addOverlay() },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  );
  return items;
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

function registerHotkeys() {
  const wanted = [
    ['toggle_visibility', cfg.hotkeys.toggle_visibility,
      // Hiding everything at once is the useful thing; maximizing everything
      // would just stack windows on top of each other, so that one stays on the
      // primary overlay.
      () => { for (const ov of liveOverlays()) toggleVisibility(ov); },
      'show / hide (all overlays)'],
    ['toggle_maximize', cfg.hotkeys.toggle_maximize,
      () => { const ov = primaryOverlay(); if (ov) toggleMaximize(ov); },
      'maximize / window mode (primary overlay)']
  ];

  hotkeyStatus = {};

  for (const [name, accel, handler, what] of wanted) {
    let ok = false;
    try { ok = globalShortcut.register(accel, handler); } catch (e) {
      hotkeyStatus[name] = false;
      console.error(`  hotkey ${accel} (${what}) — invalid accelerator: ${e.message}`);
      continue;
    }
    hotkeyStatus[name] = ok;
    if (ok) {
      console.log(`  ${accel} — ${what}`);
    } else {
      // Silent failure here is what makes a maximized window feel unrecoverable,
      // so say so loudly and point at the escape hatch.
      console.error(`  hotkey ${accel} (${what}) FAILED to register — likely already ` +
                    `owned by another app. Use the right-click menu or the tray icon, ` +
                    `and change "${accel}" in config.json.`);
    }
  }
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Webcam Overlay');

  tray.on('click', () => {
    const list = liveOverlays();
    const anyHidden = list.some((ov) => !ov.win.isVisible());
    for (const ov of list) anyHidden ? showWindow(ov) : minimizeWindow(ov);
  });
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
  });
}

// ---------------------------------------------------------------------------
// IPC from renderers
// ---------------------------------------------------------------------------

ipcMain.handle('show-context-menu', (event) => {
  const ov = overlayFor(event);
  if (!ov) return;
  Menu.buildFromTemplate(buildWindowMenu(ov)).popup({ window: ov.win });
});

// Each overlay renderer asks for its own slice of the config.
ipcMain.handle('get-config', (event) => {
  const ov = overlayFor(event);
  return ov ? confOf(ov) : null;
});

// Intrinsic size of the live stream. Only the renderer knows it (videoWidth /
// videoHeight), and it's what "Fit window to camera" needs — a virtual camera can
// report an aspect ratio that has nothing to do with the window's.
ipcMain.on('video-size', (event, size) => {
  const ov = overlayFor(event);
  if (!ov || !size || !size.width || !size.height) return;
  ov.video = { width: size.width, height: size.height };
  console.log(`  ${ov.id}: stream ${size.width}×${size.height}`);
  pushSettings();
  broadcastState();
});

ipcMain.on('cameras-reported', (_e, list) => {
  cameras = Array.isArray(list) ? list : [];
  console.log(`  cameras: ${cameras.map((c) => c.label || c.deviceId).join(' | ') || 'none'}`);
  pushSettings();
});

// Renderer-driven move/resize. index.html can't use -webkit-app-region: drag,
// because on Windows a drag region swallows right-click before it reaches the
// page — which would leave the context menu unreachable.
ipcMain.on('move-start', (event) => {
  const ov = overlayFor(event);
  if (ov) ov.dragOrigin = ov.win.getBounds();
});

ipcMain.on('move-by', (event, { dx, dy }) => {
  const ov = overlayFor(event);
  if (!ov || !ov.dragOrigin || ov.mode !== 'windowed') return;
  ov.win.setBounds({
    x: ov.dragOrigin.x + Math.round(dx),
    y: ov.dragOrigin.y + Math.round(dy),
    width:  ov.dragOrigin.width,
    height: ov.dragOrigin.height
  });
});

ipcMain.on('resize-start', (event) => {
  const ov = overlayFor(event);
  if (ov) ov.dragOrigin = ov.win.getBounds();
});

ipcMain.on('resize-by', (event, { dx, dy }) => {
  const ov = overlayFor(event);
  if (!ov || !ov.dragOrigin || ov.mode !== 'windowed') return;
  ov.win.setBounds({
    x: ov.dragOrigin.x,
    y: ov.dragOrigin.y,
    width:  Math.max(MIN_W, ov.dragOrigin.width  + Math.round(dx)),
    height: Math.max(MIN_H, ov.dragOrigin.height + Math.round(dy))
  });
});

ipcMain.on('drag-end', (event) => {
  const ov = overlayFor(event);
  if (!ov) return;
  ov.dragOrigin = null;
  saveBounds(ov);
});

// ---- settings window -------------------------------------------------------

ipcMain.handle('settings:get',        () => settingsSnapshot());
ipcMain.handle('settings:apply',      (_e, patch) => { applySettings(patch); return settingsSnapshot(); });
ipcMain.handle('settings:openConfig', () => openConfigInEditor());
ipcMain.on('settings:close',          () => { if (settingsWin) settingsWin.close(); });

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  cfg = loadConfig();
  for (const conf of cfg.overlays) createOverlay(conf);

  createTray();
  console.log(`Webcam Overlay running — ${cfg.overlays.length} overlay(s).`);
  registerHotkeys();
  watchConfig();

  if (cfg.control_port) {
    control = startControlServer({
      port:      cfg.control_port,
      onCommand: handleControlCommand,
      getState:  currentState,
      log:       (m) => console.log(`  ${m}`)
    });
  }

  console.log('  Right-click an overlay (or the tray icon) for the menu.');
  console.log(`  Config: ${CONFIG_PATH}  (edits are picked up live)`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { fs.unwatchFile(CONFIG_PATH); } catch (_) {}
  if (control) control.close();
});

// Keep alive when all windows are closed (hide doesn't count)
app.on('window-all-closed', () => { /* intentional no-op */ });
