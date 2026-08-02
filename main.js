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
// Config
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

// Slack when deciding which corner the window is parked in, so a corner still
// reads as "current" after a rounding pass through setBounds.
const CORNER_TOLERANCE = 2;

const DEFAULT_CONFIG = {
  hotkeys: {
    toggle_visibility: 'CommandOrControl+Alt+W',
    toggle_maximize:   'CommandOrControl+Alt+M'
  },
  window: {
    x:       null,
    y:       null,
    width:   320,
    height:  240,
    opacity: 0.95
  },
  corner_radius: 16,
  // Gap left between the window and the screen edge when snapping to a corner.
  corner_margin: 24,
  // Command or absolute path used by "Edit config.json".
  // null = auto-detect (VS Code, then Notepad++, then Notepad).
  editor: null,
  // Loopback port the Stream Deck plugin (or any other controller) talks to.
  // 0 disables the control server entirely.
  control_port: 28492
};

const MIN_OPACITY = 0.1;    // below this the window is invisible AND unclickable
const MAX_RADIUS  = 200;

// Text of the last config we wrote ourselves, so the file watcher can tell our
// own saves apart from a real external edit.
let lastWrittenConfig = null;

function fillDefaults(cfg) {
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (!(k in cfg)) { cfg[k] = v; continue; }
    if (typeof v === 'object' && v !== null) {
      for (const [kk, vv] of Object.entries(v)) {
        if (!(kk in cfg[k])) cfg[k][kk] = vv;
      }
    }
  }
  return cfg;
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return fillDefaults(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    } catch (_) { /* fall through to defaults */ }
  }
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  saveConfig(cfg);
  return cfg;
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
  // Pre-generated base64 PNG (16×16 RGBA blue circle)
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAN0lEQVR4nGNgoAnY8v8/VkyRZqIMIaQZryHEasZqCKmaMQwZNYAKBlAcjVRJSMQaQhSgSDOJAABJ26SIN6ER1AAAAABJRU5ErkJggg==';
  return nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let win  = null;
let tray = null;
let cfg  = null;

// 'windowed' | 'maximized'. Always starts windowed so a maximized quit can never
// leave the app stuck filling the screen on next launch.
let mode = 'windowed';

// Bounds to return to when leaving maximized mode.
let windowedBounds = null;

// Start bounds for an in-progress renderer-driven move/resize.
let dragOrigin = null;

// ---------------------------------------------------------------------------
// Bounds persistence
// ---------------------------------------------------------------------------

function saveBounds() {
  if (!win || win.isDestroyed() || mode !== 'windowed') return;
  const b = win.getBounds();
  cfg.window.x      = b.x;
  cfg.window.y      = b.y;
  cfg.window.width  = b.width;
  cfg.window.height = b.height;
  saveConfig(cfg);
}

// ---------------------------------------------------------------------------
// Corner radius
// ---------------------------------------------------------------------------

function applyCornerRadius() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('corner-radius', cfg.corner_radius);
  }
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function setCornerRadius(px) {
  cfg.corner_radius = Math.round(clamp(px, 0, MAX_RADIUS));
  saveConfig(cfg);
  applyCornerRadius();
  broadcastState();
}

function setOpacity(value) {
  const v = Math.round(clamp(value, MIN_OPACITY, 1) * 100) / 100;
  win.setOpacity(v);
  cfg.window.opacity = v;
  saveConfig(cfg);
  broadcastState();
}

function radiusItems() {
  const items = RADIUS_PRESETS.map(px => ({
    label:   px === 0 ? 'Square (0 px)' : `${px} px`,
    type:    'radio',
    checked: cfg.corner_radius === px,
    click:   () => setCornerRadius(px)
  }));

  // A hand-edited config.json can hold any value; show it rather than leaving
  // the submenu looking like nothing is selected.
  if (!RADIUS_PRESETS.includes(cfg.corner_radius)) {
    items.push(
      { type: 'separator' },
      { label: `Custom: ${cfg.corner_radius} px  (from config.json)`,
        type: 'radio', checked: true, enabled: false }
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// External editor for config.json
// ---------------------------------------------------------------------------

let cachedEditor;   // undefined = not resolved yet

function which(cmd) {
  try {
    const lines = execFileSync('where', [cmd], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    }).toString().trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    // `where code` lists BOTH `bin\code` (an extensionless shell script) and
    // `bin\code.cmd`. Only the latter can be launched on Windows, and `where`
    // returns the unusable one first — so pick by extension, not by order.
    return lines.find(l => /\.(exe|cmd|bat|com)$/i.test(l)) || lines[0];
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
  child.on('error', e => fallbackOpen(editor, e.message));
  child.unref();
  console.log(`config.json opened in: ${editor}`);
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
  cfg = fillDefaults(next);
  cachedEditor = undefined;                    // cfg.editor may have changed

  win.setOpacity(cfg.window.opacity);
  applyCornerRadius();

  if (JSON.stringify(cfg.hotkeys) !== prevHotkeys) {
    globalShortcut.unregisterAll();
    registerHotkeys();
  }
  if (mode === 'windowed' && cfg.window.x != null && cfg.window.y != null) {
    win.setBounds({
      x: cfg.window.x, y: cfg.window.y,
      width: Math.max(MIN_W, cfg.window.width),
      height: Math.max(MIN_H, cfg.window.height)
    });
    windowedBounds = win.getBounds();
  }
  broadcastState();
  console.log('config.json reloaded.');
}

// ---------------------------------------------------------------------------
// Control channel (Stream Deck plugin, or anything else that speaks the protocol)
// ---------------------------------------------------------------------------

let control    = null;
let stateTimer = null;

function currentState() {
  return {
    mode:    mode,                                   // 'windowed' | 'maximized'
    visible: !!win && !win.isDestroyed() && win.isVisible(),
    opacity: win && !win.isDestroyed() ? Math.round(win.getOpacity() * 100) / 100 : 1,
    radius:  cfg.corner_radius,
    corner:  currentCorner()                         // corner key, or null
  };
}

// Coalesced: one mutation often touches several setters (maximize also shows),
// and controllers only care about the settled result.
function broadcastState() {
  if (!control) return;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    control.broadcast({ event: 'state', ...currentState() });
  }, 20);
}

function handleControlCommand(msg) {
  switch (String(msg && msg.cmd)) {
    case 'getState':         break;                  // the broadcast below answers it
    case 'show':             showWindow();           break;
    case 'hide':             minimizeWindow();       break;
    case 'toggleVisibility': toggleVisibility();     break;
    case 'maximize':         maximizeWindow();       break;
    case 'windowMode':       windowModeWindow();     break;
    case 'toggleMaximize':   toggleMaximize();       break;
    case 'setOpacity':       setOpacity(msg.value);  break;
    case 'nudgeOpacity':     setOpacity(win.getOpacity() + Number(msg.delta || 0)); break;
    case 'setRadius':        setCornerRadius(msg.value); break;
    case 'nudgeRadius':      setCornerRadius(cfg.corner_radius + Number(msg.delta || 0)); break;
    case 'snapCorner':       snapToCorner(String(msg.corner)); break;
    case 'quit':             app.quit();             return;
    default:                 return;                 // unknown verb: ignore
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Window modes
// ---------------------------------------------------------------------------

function showWindow() {
  win.show();
  win.focus();
  broadcastState();
}

function maximizeWindow() {
  if (mode !== 'maximized') {
    windowedBounds = win.getBounds();
    // Set mode BEFORE setBounds so saveBounds() can never persist maximized bounds.
    mode = 'maximized';
    // workArea, not bounds: keeps the taskbar — and therefore the tray icon —
    // reachable while maximized.
    const { workArea } = screen.getDisplayMatching(windowedBounds);
    win.setBounds(workArea);
  }
  showWindow();
}

function windowModeWindow() {
  mode = 'windowed';
  const b = windowedBounds;
  if (b) {
    win.setBounds(b);
  } else if (cfg.window.x != null && cfg.window.y != null) {
    win.setBounds({
      x: cfg.window.x, y: cfg.window.y,
      width: cfg.window.width, height: cfg.window.height
    });
  } else {
    win.setSize(cfg.window.width, cfg.window.height);
  }
  showWindow();
  saveBounds();
}

// skipTaskbar:true means a real minimize() would leave no taskbar button to click,
// so hide() is the recoverable equivalent — the tray icon and the show/hide hotkey
// both bring it back.
function minimizeWindow() {
  win.hide();
  broadcastState();
}

// ---------------------------------------------------------------------------
// Screen-corner presets
// ---------------------------------------------------------------------------

// Where the window would sit if parked in `corner` on the display it's on now.
// workArea, not bounds, so the window never lands under the taskbar.
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

function snapToCorner(corner) {
  if (!(corner in CORNERS)) return;

  // A maximized window has no corner to speak of, so drop back to windowed
  // first rather than silently doing nothing.
  if (mode === 'maximized') windowModeWindow();

  const b = win.getBounds();
  const { x, y } = cornerOrigin(corner, b);
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  showWindow();
  saveBounds();
}

// Which corner the window is currently parked in, or null if it's somewhere else.
function currentCorner() {
  if (!win || win.isDestroyed() || mode !== 'windowed') return null;
  const b = win.getBounds();
  for (const corner of Object.keys(CORNERS)) {
    const { x, y } = cornerOrigin(corner, b);
    if (Math.abs(b.x - x) <= CORNER_TOLERANCE && Math.abs(b.y - y) <= CORNER_TOLERANCE) {
      return corner;
    }
  }
  return null;
}

function toggleMaximize() {
  if (mode === 'maximized') windowModeWindow();
  else maximizeWindow();
}

function toggleVisibility() {
  if (win.isVisible()) minimizeWindow();
  else showWindow();
}

// ---------------------------------------------------------------------------
// Shared menu (used by both the window right-click menu and the tray menu)
// ---------------------------------------------------------------------------

function opacityItems() {
  const current = Math.round(win.getOpacity() * 100);
  return [100, 80, 60, 40].map(pct => ({
    label:   `${pct}%`,
    type:    'radio',
    checked: current === pct,
    click:   () => setOpacity(pct / 100)
  }));
}

function cornerItems() {
  const current = currentCorner();
  const isMax = mode === 'maximized';
  return Object.entries(CORNERS).map(([key, label]) => ({
    label,
    type:    'radio',
    // Nothing is "current" while maximized, so leave them all unchecked rather
    // than implying the window is parked somewhere it isn't.
    checked: !isMax && current === key,
    click:   () => snapToCorner(key)
  }));
}

function buildMenuTemplate() {
  const isMax  = mode === 'maximized';
  const hidden = !win.isVisible();
  const hkVis  = cfg.hotkeys.toggle_visibility;
  const hkMax  = cfg.hotkeys.toggle_maximize;

  const items = [];

  if (hidden) {
    items.push({ label: 'Show', click: showWindow }, { type: 'separator' });
  }

  items.push(
    { label: 'Maximize',    enabled: !(isMax && !hidden),  click: maximizeWindow },
    { label: 'Minimize',    enabled: !hidden,              click: minimizeWindow },
    { label: 'Window mode', enabled: !(!isMax && !hidden), click: windowModeWindow },
    { type: 'separator' },
    { label: 'Move to corner', submenu: cornerItems() },
    { type: 'separator' },
    { label: 'Corner radius', submenu: radiusItems() },
    { label: 'Opacity',       submenu: opacityItems() },
    { type: 'separator' },
    { label: `Hotkeys:  ${hkMax} = maximize / window`, enabled: false },
    { label: `          ${hkVis} = show / hide`,        enabled: false },
    { type: 'separator' },
    { label: 'Edit config.json…', click: openConfigInEditor },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  );

  return items;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  cfg = loadConfig();

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const w = cfg.window.width;
  const h = cfg.window.height;
  const x = cfg.window.x ?? sw - w - 24;
  const y = cfg.window.y ?? sh - h - 24;

  win = new BrowserWindow({
    x, y, width: w, height: h,
    minWidth: MIN_W, minHeight: MIN_H,
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
  win.setOpacity(cfg.window.opacity);
  win.loadFile('index.html');

  windowedBounds = win.getBounds();

  // Push the radius once the renderer is actually up.
  win.webContents.on('did-finish-load', applyCornerRadius);

  // Native edge-resize still fires these; renderer-driven move/resize saves on
  // its own drag-end. Programmatic setBounds() does not fire either event.
  let moveTimer = null;
  win.on('moved',   () => { clearTimeout(moveTimer); moveTimer = setTimeout(saveBounds, 300); });
  win.on('resized', saveBounds);
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

function registerHotkeys() {
  const wanted = [
    [cfg.hotkeys.toggle_visibility, toggleVisibility, 'show / hide'],
    [cfg.hotkeys.toggle_maximize,   toggleMaximize,   'maximize / window mode']
  ];

  for (const [accel, handler, what] of wanted) {
    let ok = false;
    try { ok = globalShortcut.register(accel, handler); } catch (e) {
      console.error(`  hotkey ${accel} (${what}) — invalid accelerator: ${e.message}`);
      continue;
    }
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

  tray.on('click', toggleVisibility);
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  });
}

// ---------------------------------------------------------------------------
// IPC from renderer
// ---------------------------------------------------------------------------

ipcMain.handle('show-context-menu', () => {
  Menu.buildFromTemplate(buildMenuTemplate()).popup({ window: win });
});

ipcMain.handle('get-config', () => cfg);

// Renderer-driven move/resize. index.html can't use -webkit-app-region: drag,
// because on Windows a drag region swallows right-click before it reaches the
// page — which would leave the context menu unreachable.
ipcMain.on('move-start', () => { dragOrigin = win.getBounds(); });

ipcMain.on('move-by', (_e, { dx, dy }) => {
  if (!dragOrigin || mode !== 'windowed') return;
  win.setBounds({
    x: dragOrigin.x + Math.round(dx),
    y: dragOrigin.y + Math.round(dy),
    width:  dragOrigin.width,
    height: dragOrigin.height
  });
});

ipcMain.on('resize-start', () => { dragOrigin = win.getBounds(); });

ipcMain.on('resize-by', (_e, { dx, dy }) => {
  if (!dragOrigin || mode !== 'windowed') return;
  win.setBounds({
    x: dragOrigin.x,
    y: dragOrigin.y,
    width:  Math.max(MIN_W, dragOrigin.width  + Math.round(dx)),
    height: Math.max(MIN_H, dragOrigin.height + Math.round(dy))
  });
});

ipcMain.on('drag-end', () => { dragOrigin = null; saveBounds(); });

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  createWindow();
  createTray();
  console.log('Webcam Overlay running.');
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

  console.log('  Right-click the window (or the tray icon) for the menu.');
  console.log(`  Config: ${CONFIG_PATH}  (edits are picked up live)`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { fs.unwatchFile(CONFIG_PATH); } catch (_) {}
  if (control) control.close();
});

// Keep alive when all windows are closed (hide doesn't count)
app.on('window-all-closed', () => { /* intentional no-op */ });
