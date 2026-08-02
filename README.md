# JackOverlay

A floating, borderless, always-on-top webcam overlay for Windows — plus a Stream Deck
plugin to drive it.

Built with Electron. Drag it anywhere, resize it, round the corners, dim it, and park
it over whatever you're doing.

## Features

- Borderless always-on-top webcam window, draggable and resizable
- Snap it to any of the four screen corners from the menu
- Right-click menu: Maximize / Minimize / Window mode / Move to corner /
  Corner radius / Opacity / Start with Windows / Exit
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
| Show / hide | `Ctrl+Alt+W` |
| Maximize ⇄ window | `Ctrl+Alt+M` |

Maximize fills the display's **work area**, so the taskbar and tray stay reachable —
you can always get back out. The app always launches in window mode.

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
  "window": { "x": null, "y": null, "width": 320, "height": 240, "opacity": 0.95 },
  "corner_radius": 16,
  "corner_margin": 24,
  "editor": null,
  "control_port": 28492
}
```

- `x`/`y` `null` — auto-place bottom-right on first launch
- `corner_margin` — gap left between the window and the screen edge when snapping
  to a corner
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

## License

MIT
