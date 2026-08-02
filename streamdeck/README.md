# Webcam Overlay — Stream Deck plugin

Controls the webcam overlay from a Stream Deck. Keys reflect the overlay's real
state, so a button never shows something the overlay isn't actually doing.

Verified against Stream Deck **7.4.2** with a **Stream Deck +** and Stream Deck Mobile.

## Actions

Four **dedicated state buttons**. Each one puts the overlay into a single specific
state, and is **lit while the overlay is currently in that state** — the key reports
what is true now, not what pressing it would do. Press it again when it's already
lit and nothing changes.

| Action | Sends | Lit when |
|---|---|---|
| **Show** | `show` | The overlay is visible |
| **Hide** | `hide` | The overlay is hidden |
| **Maximize** | `maximize` | The overlay is visible **and** maximized |
| **Window Mode** | `windowMode` | The overlay is visible **and** windowed |

A hidden overlay is neither maximized nor windowed as far as the user is concerned,
so both mode buttons go dim while it is out of sight — only **Hide** stays lit.

Two knob actions, unchanged:

| Action | Controllers | Behaviour |
|---|---|---|
| **Opacity** | Keypad + Encoder | Dial adjusts in 5% steps, push/touch resets to 100%. On a key, press cycles 40 → 60 → 80 → 100%. |
| **Corner Radius** | Keypad + Encoder | Dial adjusts in 2px steps, push/touch resets to 16px. On a key, press cycles the presets. |

Both knobs declare `Controllers: ["Keypad", "Encoder"]`, so the same action works on
a plain keypad and on a Stream Deck + dial. On a dial they render through the
built-in `$B1` layout (title, value, bar indicator).

When the overlay isn't running, keys show `offline` and a press triggers the
Stream Deck alert badge instead of failing silently.

### Why `DisableAutomaticStates` matters here

Stream Deck **toggles a two-state key's image by itself on every press** unless the
action sets `"DisableAutomaticStates": true`. That default is fine for a toggle, but
wrong for a dedicated button: pressing **Show** while the overlay is already visible
would darken the key even though nothing changed. All four state buttons set the
flag, so the image is owned entirely by the overlay's pushed state.

The plugin logs which buttons it considers lit on every state change, which is the
quickest way to diagnose a key that looks wrong:

```
overlay state: mode=maximized visible=true opacity=1 radius=16 | lit: show, maximize
```

## Architecture

```
Stream Deck app  ──WebSocket──▶  plugin (Node 20, bundled with Stream Deck)
                                       │
                                       │ TCP + newline-delimited JSON
                                       ▼
                                 overlay (Electron)  127.0.0.1:28492
```

Two separate sockets. The plugin can't call into the Electron app directly, so
the overlay exposes a loopback control channel (`control-server.js` in the parent
project) and the plugin is a client of it.

### Control protocol

One JSON object per line, both directions.

Commands the plugin sends:

| `cmd` | Extra | Effect |
|---|---|---|
| `getState` | — | Ask for a state push |
| `show` / `hide` / `toggleVisibility` | — | Visibility |
| `maximize` / `windowMode` / `toggleMaximize` | — | Window mode |
| `setOpacity` | `value` 0.1–1 | Absolute opacity |
| `nudgeOpacity` | `delta` | Relative opacity |
| `setRadius` | `value` 0–200 | Absolute corner radius |
| `nudgeRadius` | `delta` | Relative corner radius |
| `quit` | — | Quit the overlay |

Out-of-range values are clamped by the overlay, and unknown verbs are ignored
rather than throwing — the plugin can't wedge the overlay with a bad message.

The overlay pushes this on connect and after every change:

```json
{ "event": "state", "mode": "windowed", "visible": true, "opacity": 1, "radius": 16 }
```

Pushes are coalesced (20 ms) because one action often touches several setters —
maximizing also shows the window.

## Development

`node_modules` is gitignored, so after a fresh clone install the SDK **inside the
`.sdPlugin` folder** — there is no bundler, so the plugin loads its dependencies
from there at runtime:

```bash
cd streamdeck/com.ljack2k.webcamoverlay.sdPlugin && npm install
```

Regenerate the icon set:

```bash
pwsh -File tools\make-icons.ps1
```

```bash
npx @elgato/cli validate com.ljack2k.webcamoverlay.sdPlugin
```

```bash
npx @elgato/cli restart com.ljack2k.webcamoverlay
```

`streamdeck link` has already been run — `%APPDATA%\Elgato\StreamDeck\Plugins\com.ljack2k.webcamoverlay.sdPlugin`
is a **junction** to this folder, so edits here are live; just `restart` after changing `bin/`.

Plugin logs land in `com.ljack2k.webcamoverlay.sdPlugin/logs/`.

## Notes for anyone extending this

**No build step.** The plugin is plain ESM JavaScript with `@elgato/streamdeck`
as its only dependency (5 packages, ~5 MB) and `node_modules` shipped inside the
`.sdPlugin` folder. The official template uses TypeScript + Rollup; that's only
needed for the `@action` decorator, and the decorator merely sets a `manifestId`
class field — so a plain field does the same job:

```js
class Show extends SingletonAction {
  manifestId = "com.ljack2k.webcamoverlay.show";
}
streamDeck.actions.registerAction(new Show());
```

**Stream Deck runs plugins on its own bundled Node 20.20.0**, not the system Node.
That runtime has no global `WebSocket`, which is why the SDK pulls in `ws`. Target
Node 20 syntax, not whatever `node --version` says.

**`streamdeck validate` does not check that images decode.** It passed cleanly
while all 28 PNGs were zero bytes, and again while they were all written without
a `.png` extension. `tools/make-icons.ps1` therefore asserts a minimum file size
itself, and the manifest cross-check in the project's handover doc verifies every
declared image path resolves at both 1x and 2x.

**Icons are drawn with GDI+, not Electron.** `capturePage()` and offscreen `paint`
both return empty images for a window that is never composited, and `toPNG()` then
yields a zero-length buffer *without throwing*.

**The property inspector deliberately avoids the `sdpi-components` CDN.** It's a
web view; a remote script means a blank settings panel whenever the machine is
offline. `ui/port.html` talks the raw property-inspector socket protocol instead.

**Renaming an action UUID orphans placed keys.** Stream Deck binds each key to an
action UUID, so any key using a UUID that no longer exists has to be dragged on
again — the profile cannot migrate itself. This has bitten the plugin twice:

- **v1.1** replaced the two toggles (`…visibility`, `…windowmode`) with the four
  dedicated state buttons above.
- **v1.2** renamed the whole plugin from `com.eddy.*` to `com.ljack2k.*`, which
  changes every action UUID at once.

Treat the UUID namespace as permanent from here on.
