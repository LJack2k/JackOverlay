# JackOverlay

A floating, borderless, always-on-top webcam overlay for Windows — plus a Stream Deck
plugin to drive it.

Built with Electron. Drag it anywhere, resize it, round the corners, dim it, and park
it over whatever you're doing.

## Features

- Borderless always-on-top webcam window, draggable and resizable
- **As many overlays as you like**, each with its own camera, position, size,
  corner radius, opacity and mirroring
- Snap any of them to the four screen corners from the menu
- **Settings window** — pick your webcam, and adjust everything else without
  touching a config file
- Right-click menu: Maximize / Minimize / Window mode / Move to corner /
  Corner radius / Opacity / Settings / Start with Windows / Exit
- System tray icon with the same menu
- Global hotkeys — `Ctrl+Alt+M` (maximize ⇄ window), `Ctrl+Alt+W` (show / hide)
- Configurable rounded corners, live-updating
- Position, size, opacity and radius persisted to `config.json`
- Hand edits to `config.json` are picked up live, no restart
- Optional [Stream Deck plugin](streamdeck/README.md) with buttons that reflect the
  overlay's real state, and dial control for opacity and corner radius

## Quick start

```bash
npm install
```

```bash
npm start
```

`config.json` is created automatically on first run.

## Building an exe

```bash
npm run package
```

That regenerates the icon and produces a portable folder,
`dist/JackOverlay-win32-x64/`, containing `JackOverlay.exe`. Copy the folder
anywhere and run it — no installer, no admin rights.

It uses [`@electron/packager`](https://github.com/electron/packager) rather than
electron-builder deliberately: it reuses the Electron build already in the local
cache and downloads nothing else — no NSIS, no signing tools. The downside is a
folder rather than a single-file installer.

Run from source, settings live next to `main.js`. **Packaged, they move to
`%APPDATA%\JackOverlay`**, because a packaged app's own directory is inside a
read-only `app.asar`. To carry your setup across, copy `config.json` there.

Two things to know when you switch to the exe:

- **Re-tick Start with Windows.** The startup entry records an absolute path, and
  the exe's differs from `electron.exe` plus the project folder.
- Chromium salts camera device ids per profile, so the ids in a config copied from
  the source build won't match. The app re-finds each camera by its stored label
  and rewrites the id, which it logs — but if a camera can't be matched, pick it
  again in Settings.

If Windows is holding a handle on a previous build's `app.asar` (antivirus does
this occasionally, with no process visibly owning it) the build fails to overwrite.
Either retry later or send it elsewhere:

```bash
PACKAGE_OUT=build/app npm run package
```

## Controls

| | |
|---|---|
| Move | Drag anywhere on the window |
| Snap to a screen corner | Right-click → Move to corner |
| Resize | Drag the grip in the bottom-right corner |
| Menu | Right-click the window, or the tray icon |
| Show / hide **all** overlays | `Ctrl+Alt+W` |
| Maximize ⇄ window, **primary** overlay | `Ctrl+Alt+M` |

Hiding everything at once is the useful thing, so `Ctrl+Alt+W` acts on every
overlay. Maximizing everything would just stack windows on top of each other, so
`Ctrl+Alt+M` sticks to the first overlay in the list. Per-overlay control is in
each window's own right-click menu.

Maximize fills the display's **work area**, so the taskbar and tray stay reachable —
you can always get back out. The app always launches in window mode.

## Settings

Right-click the overlay (or the tray icon) → **Settings…**

| Section | What's there |
|---|---|
| **Overlays** | A tab per overlay plus **+ Add overlay**. Rename it, pick its webcam, or remove it. A saved camera that's currently unplugged stays listed as *not connected* rather than silently switching. |
| **Appearance** | Opacity, corner radius, image fit, mirroring, pan X/Y, and **Match window to camera** for the selected overlay. |
| **Position & size** | The four corner presets, width/height, and the corner margin. |
| **Hotkeys** | Both accelerators, each with an **active** / **taken** badge showing whether it actually registered. |
| **System** | Start with Windows, config editor, control port. |

The Appearance and Position headers name the overlay they're editing, so it's
always clear which window a slider is about. Hotkeys and System are global.

Everything applies immediately and is written to `config.json`. The window also
stays in sync the other way — change something from the tray, a hotkey or the
Stream Deck and the settings screen updates live.

**Open config.json** in the footer still opens the raw file in your editor.

## Starting with Windows

Right-click the overlay (or the tray icon) → tick **Start with Windows**.

That writes a `Webcam Overlay` value to
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` pointing straight at
`electron.exe` with the app directory as its argument — so it launches without a
console window and without depending on `npm` or Node being on `PATH`. Untick it to
remove the entry; it also shows up in Task Manager's Startup tab.

The path is absolute, so **re-tick it if you move the project folder**.

## Saving, and the log

Settings live in memory and are written to `config.json` **at most once a minute**,
to keep SSD writes down — sweeping a dial would otherwise be dozens of whole-file
writes. Pending changes also flush when you quit, or immediately via **Save now**
in the Settings footer, which shows `saved` / `unsaved` so you always know.

Writes go to a temp file and are then renamed, which is atomic on one volume. If
`config.json` ever *can't* be parsed the app keeps a copy at `config.json.corrupt`
and starts from defaults rather than quietly overwriting your overlays.

The trade-off: if the process is killed outright — as opposed to quitting — you can
lose up to a minute of changes.

Everything is logged to `webcam-overlay.log` next to `config.json`, rotating to
`.log.old` past 512 KB. That matters because launching at Windows login gives the
app no console, so stdout goes nowhere — including hotkey-registration failures and
camera errors.

Only one copy runs at a time. Launching it again surfaces the overlays that should
be visible instead of starting a rival set that would fight over `config.json`, the
control port and the hotkeys.

## Configuration

`config.json` sits next to `main.js` and is re-read whenever you save it:

```json
{
  "hotkeys": {
    "toggle_visibility": "CommandOrControl+Alt+W",
    "toggle_maximize":   "CommandOrControl+Alt+M"
  },
  "corner_margin": 24,
  "editor": null,
  "control_port": 28492,
  "overlays": [
    {
      "id": "main",
      "name": "Main",
      "window": { "x": null, "y": null, "width": 320, "height": 240, "opacity": 0.95 },
      "visible": true,
      "corner_radius": 16,
      "mirror": false,
      "fit": "cover",
      "pan_x": 50,
      "pan_y": 50,
      "zoom": 1,
      "camera_id": null,
      "camera_label": null
    }
  ]
}
```

Each entry in `overlays` is one floating window. Add or remove entries by hand and
the running app creates or closes windows to match on save.

- `id` — stable identifier; it's what the control channel targets. Don't rename it
  casually
- `x`/`y` `null` — auto-place bottom-right on first launch
- `visible` — an overlay comes back the way it was left, so one you hid stays hidden
  across a restart. If you quit with everything hidden the app still starts, just
  with nothing but the tray icon — `Ctrl+Alt+W` brings them back
- `camera_id` — `null` uses the system default. `camera_label` is kept alongside it
  so the right camera can still be found if the device id changes
- `mirror` — flips the image left-to-right. Off by default: it only feels right for
  a face cam, and makes text or a second angle read backwards
- `fit` — `cover` crops to fill the window, `contain` shows the whole frame
  letterboxed, `fill` stretches it. If a camera's shape doesn't match the window,
  **Match window to camera** in Settings resizes the window instead of cropping
- `pan_x` / `pan_y` — where the image sits in the window, 0–100. `50` is centred;
  higher looks further right / further down, like panning a camera. Works at any
  zoom; see below
- `zoom` — scales the image beyond its fit, 1–4. Higher means real crop to pan
  through, so no empty space appears at the extremes
- `corner_margin` — gap left between a window and the screen edge when snapping
  to a corner (global)

A pre-multi-overlay config, with `window` / `corner_radius` / `camera_id` at the
top level, is migrated into `overlays[0]` automatically on first load.
- `editor` — `null` auto-detects VS Code → Notepad++ → Notepad for the
  "Edit config.json" menu item
- `control_port` — loopback port for the Stream Deck plugin; `0` disables it
  (this one needs a restart, the rest apply live)

## Stream Deck plugin

See [streamdeck/README.md](streamdeck/README.md). It talks to the overlay over a
loopback TCP channel, so the keys reflect the overlay's actual state rather than
firing blind. Anything that can open a socket can drive it:

```bash
node -e "require('net').createConnection(28492,'127.0.0.1').end(JSON.stringify({cmd:'toggleMaximize'})+'\n')"
```

The channel binds to `127.0.0.1` only and has no authentication — don't change the
bind host.

## When a camera goes away

If the selected camera can't be opened — unplugged, or held exclusively by another
app — the overlay shows a short message and reports it. It does **not** quietly
switch to a different device: showing the wrong camera on a live overlay is worse
than showing nothing, because you might not notice.

| Shown | Cause |
|---|---|
| `Camera disconnected` | It vanished mid-session |
| `Selected camera not available` | The saved device isn't present |
| `Camera is in use by another app` | Something else holds it exclusively |
| `Camera access denied` | Permission refused |

The same state reaches the tray menu, the Settings window and the Stream Deck keys,
which show an amber warning badge. Plug the camera back in and the overlay
re-acquires it automatically — no need to reselect it.

## Hidden overlays release their camera

Hiding an overlay stops its video tracks, which frees the device and puts the
capture light out — another app can claim it, and an overlay restored in the
hidden state never opens a camera at all. Showing it re-acquires.

One consequence: device *labels* only become readable once something has been
granted camera access, so if **every** overlay starts hidden the camera dropdown
lists devices by id until you show one.

## Zoom and pan

Pan always moves the image, at any zoom. `50` is centred on both axes.

It travels over the **overscan** — the part of the frame that doesn't fit in the
window — plus a free allowance of one window dimension. That allowance is what
makes pan work when there's no overscan to slide through, which is more common
than it sounds: a 16:9 camera in a window narrower than 16:9 is scaled to match
the window's *height*, so the width overflows and the height fits exactly. Nothing
to crop vertically.

The cost is that pushing past the overscan leaves empty space, and at 0 or 100
roughly half the image sits outside the frame. In practice you work in the middle
of the range. **Zoom** above 100% enlarges the image so there's real crop to move
through and no gap appears at all — 125% is usually plenty.

Sizes and offsets are computed in the renderer rather than left to CSS
`object-fit` / `object-position`. Those only ever expose the slack the fit happens
to leave, can't be combined with a zoom, and can't pan past an edge. One piece of
arithmetic handles fit, zoom and pan together.

## Capture resolution

Cameras are opened with an `ideal` request of 1920×1080. Without a resolution
constraint Chromium takes whatever the device offers by default, and some virtual
cameras default to **640×480** — not just low-res but 4:3, so the picture arrives
with a different aspect ratio than a physical webcam and looks squashed or
over-cropped. `ideal` rather than `exact` means cameras that can't do 1080p still
work and simply give their closest match.

## License

MIT
