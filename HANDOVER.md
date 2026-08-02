# Webcam Overlay — Handover

## What this is
A floating, borderless, always-on-top Electron app that shows your webcam feed.
- Drag anywhere to move, drag the bottom-right grip to resize
- **Right-click the window** → Maximize / Minimize / Window mode / Corner radius /
  Opacity / Edit config.json / Exit
- Right-click the tray icon (blue dot) for the same menu, plus Show when hidden
- Global hotkeys: `Ctrl+Alt+M` (maximize ⇄ window mode), `Ctrl+Alt+W` (show/hide)
- Rounded corners, configurable live from the menu or `config.json`
- All settings auto-saved to `config.json`, and **hand edits are picked up live**

### Window modes
| Mode | What it does | How to get out |
|---|---|---|
| **Maximize** | Fills the display's **work area** — the taskbar and tray stay visible on purpose | `Ctrl+Alt+M`, or right-click → Window mode |
| **Minimize** | Hides the window (`hide()`, not `minimize()` — `skipTaskbar: true` means a real minimize would leave no taskbar button to click) | `Ctrl+Alt+W`, or tray icon → Show |
| **Window mode** | Returns to the exact pre-maximize bounds | — |

Menu items grey out when they don't apply, so the current mode is always visible.
The app always launches in window mode, so quitting while maximized can never leave it
stuck filling the screen.

### Corner radius
Presets in the menu: 0 (square), 6, 10, 16 (default), 24, 32, 48 px — radio-checked to show
the current value, applied instantly, and saved to `corner_radius`. A hand-edited value
outside the presets shows up as a disabled `Custom: N px` entry rather than leaving the
submenu looking unselected.

The radius is set on `#container`, `video` **and** `#error`. Putting it only on the
container is not enough: the video carries `transform: scaleX(-1)`, which gets its own
compositing layer and can bleed past `overflow: hidden`.

### Editing config.json
"Edit config.json…" resolves a real editor rather than calling `shell.openPath()`.
Order: `config.editor` (command or absolute path) → `code` → `code-insiders` →
`notepad++.exe` → `notepad.exe`. Set `"editor"` in config.json to force a specific one.

Saving the file applies immediately — no restart. `fs.watchFile` (1 s poll) re-reads it and
re-applies opacity, corner radius, window bounds, and hotkeys. Polling rather than
`fs.watch` on purpose: editors often save by rename-and-replace, which invalidates an
`fs.watch` handle on Windows. Our own writes are skipped by comparing against the exact
text last written, so drag-to-move doesn't trigger a reload loop.

## Stream Deck control

The overlay exposes a loopback control channel so external controllers can drive
it. [control-server.js](control-server.js) listens on `127.0.0.1:<control_port>`
(default `28492`, `0` disables it) and speaks newline-delimited JSON — no
dependencies, since both ends are Node.

The Stream Deck plugin lives in [streamdeck/](streamdeck/README.md) and is a
client of this channel. Anything else that can open a TCP socket works too:

```bash
node -e "require('net').createConnection(28492,'127.0.0.1').end(JSON.stringify({cmd:'toggleMaximize'})+'\n')"
```

Commands: `getState`, `show`, `hide`, `toggleVisibility`, `maximize`,
`windowMode`, `toggleMaximize`, `setOpacity {value}`, `nudgeOpacity {delta}`,
`setRadius {value}`, `nudgeRadius {delta}`, `quit`. Values are clamped
(opacity `0.1`–`1`, radius `0`–`200`) and unknown verbs are ignored, so a
misbehaving controller can't wedge the overlay.

After every change the overlay pushes to all connected clients:

```json
{ "event": "state", "mode": "windowed", "visible": true, "opacity": 1, "radius": 16 }
```

Pushes are coalesced over 20 ms because one action often touches several setters
(maximizing also shows the window). The state push lives inside the mutator
functions rather than the command handler, so changes made by hotkey, tray, or
the right-click menu are broadcast too — not just ones that arrived over TCP.

**Security:** bound to `127.0.0.1` only. Do not change the bind host; there is no
authentication, and `quit` is a valid command.

## Gotchas worth remembering

**1. `-webkit-app-region: drag` swallows right-click on Windows.**
A drag region is hit-tested as the title bar, so `contextmenu` never reaches the page and
any right-click menu is silently dead. Verified with a two-zone probe: a real OS right-click
on a `drag` half produced no event, while the `no-drag` half fired normally. That is why
[index.html](index.html) has **no** drag region and moves the window through pointer events
+ IPC (`move-start` / `move-by` / `drag-end` in [main.js](main.js)) instead. Resizing goes
through the same path, which also makes the corner grip actually functional rather than
just a cursor hint.

**2. Maximize to `workArea`, never `bounds`.**
`screen.getPrimaryDisplay().bounds` is 1920×1080 and covers the taskbar; `workArea` is
1920×1032 and does not. Maximizing to `bounds` hid the tray icon, which — combined with
gotcha 1 killing right-click — left no way back out of maximized except Alt+F4.

**3. `where code` returns the unusable path first.**
It prints two lines — `bin\code` (an extensionless shell script) and `bin\code.cmd`. Only
the `.cmd` can be launched on Windows, and the useless one comes first, so `which()` picks
by extension rather than taking `lines[0]`. Anything that isn't a plain `.exe` is spawned
through `shell: true`.

**4. `spawn()` reports a missing executable asynchronously.**
It emits `'error'` instead of throwing, so a `try/catch` around the call alone silently does
nothing. `openConfigInEditor()` attaches an `'error'` handler that falls back to Notepad —
deliberately Notepad and not `shell.openPath()`, because with no registered `.json` handler
(this machine has none) `openPath` just shows the "How do you want to open this file?" picker.

**5. Register renderer listeners before awaiting the camera.**
`getUserMedia()` can take seconds. The listener wiring in [index.html](index.html) used to sit
after `await startCamera()`, which left right-click and dragging dead on every cold start —
looking exactly like a broken menu. The async startup now runs last, after the listeners.

Also: `globalShortcut.register()` returns `false` instead of throwing when another app
already owns the accelerator. [main.js](main.js) now logs that failure loudly, because a
silently-unregistered hotkey is what makes the window feel unrecoverable.

## Status: RESOLVED — app runs

Fixed 2026-08-02. `npm start` works. No mirror, proxy, or rewrite was needed.

### The real root cause (the `EAI_AGAIN` diagnosis was a red herring)
The download had **already succeeded**. The cached zip at
`%LOCALAPPDATA%\electron\Cache\<hash>\electron-v31.7.7-win32-x64.zip`
was complete (105.61 MB) and its SHA256 matched `node_modules/electron/checksums.json`.

What actually failed was **extraction**. `node_modules/electron/install.js` logged
`Cache hit` and exited 0 without unpacking — `extract-zip` bailed silently after creating
only `dist/locales`. Because it exits 0, `npm install` reports success and you get an
empty `dist/`, which looks exactly like a failed download.

Network was never the problem: `npmmirror.com`, `registry.npmjs.org` **and**
`github.com/electron/electron/releases/...` all returned HTTP 200 on retest.

### The fix — extract the cached zip by hand
If `node_modules/electron/dist/` is ever empty again, run this in PowerShell (no download):
```powershell
$zip  = (Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter 'electron-v*-win32-x64.zip' | Select-Object -First 1).FullName
$dist = 'D:\Projects\JackOverlay\node_modules\electron\dist'
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $dist -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dist)
[System.IO.File]::WriteAllText("$dist\..\path.txt", 'electron.exe', [System.Text.UTF8Encoding]::new($false))
```

**`path.txt` must contain `electron.exe` with no trailing newline.** `install.js`
compares the file's bytes exactly, so the `echo electron.exe > path.txt` trick appends
`\r\n` and makes `isInstalled()` return false forever.

Verify with:
```powershell
node -e "const p=require('electron');console.log(p, require('fs').existsSync(p))"
```

Re-running `npm install` is now safe — `isInstalled()` sees a valid `dist/version`,
`path.txt` and `electron.exe`, so the postinstall skips extraction entirely.

### Fallback if the cache is ever purged and GitHub is blocked again
- **Mirror:** `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` then reinstall.
  This repopulates the cache; if `dist/` is still empty afterwards, extract by hand as above.
- **Last resort — rewrite without Electron:** PowerShell + WPF (zero install, webcam via
  the MediaCapture WinRT API) is the most robust no-download option on Windows.
  NW.js is another option but is also a large binary download.

## File map
Project root is `D:\Projects\JackOverlay` — **not** `D:\Projects\JackOverlay\webcam-overlay`.
That subfolder exists but is empty; `package.json` and friends live one level up.
```
D:\Projects\JackOverlay\
  main.js          — Main process: window, modes, hotkeys, tray, menu, editor launch,
                     config R/W + live reload, control-channel commands
  control-server.js — Loopback TCP + NDJSON control channel (Stream Deck etc.)
  streamdeck\      — Stream Deck plugin (see streamdeck/README.md)
  preload.js    — Secure bridge: showContextMenu, getConfig, onCornerRadius,
                  move*/resize*/dragEnd
  index.html    — Renderer: getUserMedia feed, pointer-event drag/resize, right-click menu,
                  live corner radius
  package.json  — name: webcam-overlay, main: main.js, devDep: electron ^31
  config.json   — Auto-created on first run; watched for live edits
  install.bat   — npm install with ELECTRON_MIRROR pre-set
  start.bat     — npm start
```

## Config shape (config.json)
```json
{
  "hotkeys": {
    "toggle_visibility": "CommandOrControl+Alt+W",
    "toggle_maximize":   "CommandOrControl+Alt+M"
  },
  "window": { "x": null, "y": null, "width": 320, "height": 240, "opacity": 0.95 },
  "corner_radius": 16,
  "editor": null,
  "control_port": 28492
}
```
- `x/y null` = auto-place bottom-right on first launch.
- `corner_radius` = px; any number works, not just the menu presets.
- `editor` = `null` auto-detects (VS Code → Notepad++ → Notepad). Set a command
  (`"notepad++"`) or an absolute path to force one.
- `control_port` = loopback port for the Stream Deck plugin; `0` disables it.
- Missing keys are forward-filled from the defaults on load, so an older or partial
  config.json still works — new keys just appear on the next save.
- Saving this file applies immediately; no restart needed. (`control_port` is the
  one exception — the server binds at startup, so changing it needs a restart.)
