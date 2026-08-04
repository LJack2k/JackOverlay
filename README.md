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
- `pan_x` / `pan_y` — which part of the image is shown, 0–100. `50` is centred;
  higher looks further right / further down, like panning a camera. Only has an
  effect where the image is cropped or letterboxed — nothing to pan under `fill`
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

## Hidden overlays release their camera

Hiding an overlay stops its video tracks, which frees the device and puts the
capture light out — another app can claim it, and an overlay restored in the
hidden state never opens a camera at all. Showing it re-acquires.

One consequence: device *labels* only become readable once something has been
granted camera access, so if **every** overlay starts hidden the camera dropdown
lists devices by id until you show one.

## Capture resolution

Cameras are opened with an `ideal` request of 1920×1080. Without a resolution
constraint Chromium takes whatever the device offers by default, and some virtual
cameras default to **640×480** — not just low-res but 4:3, so the picture arrives
with a different aspect ratio than a physical webcam and looks squashed or
over-cropped. `ideal` rather than `exact` means cameras that can't do 1080p still
work and simply give their closest match.

## License

MIT
