# Webcam Overlay — Stream Deck plugin

Controls the webcam overlay from a Stream Deck. Keys reflect the overlay's real
state, so a button never shows something the overlay isn't actually doing.

Verified against Stream Deck **7.4.2** with a **Stream Deck +** and Stream Deck Mobile.

## Actions

Eight **dedicated state buttons**. Each one puts the overlay into a single specific
state, and is **lit while the overlay is currently in that state** — the key reports
what is true now, not what pressing it would do. Press it again when it's already
lit and nothing changes.

| Action | Sends | Lit when |
|---|---|---|
| **Show** | `show` | The overlay is visible |
| **Hide** | `hide` | The overlay is hidden |
| **Maximize** | `maximize` | The overlay is visible **and** maximized |
| **Window Mode** | `windowMode` | The overlay is visible **and** windowed |
| **Corner: Top Left** | `snapCorner` `top-left` | Parked in that corner |
| **Corner: Top Right** | `snapCorner` `top-right` | Parked in that corner |
| **Corner: Bottom Left** | `snapCorner` `bottom-left` | Parked in that corner |
| **Corner: Bottom Right** | `snapCorner` `bottom-right` | Parked in that corner |

A hidden overlay is neither maximized nor windowed as far as the user is concerned,
so the mode and corner buttons all go dim while it is out of sight — only **Hide**
stays lit.

At most one corner button is ever lit, and none are once the window has been dragged
away from a corner: the overlay reports the corner it is actually in rather than the
last one that was asked for. Snapping while maximized drops back to window mode first.

Two knob actions:

| Action | Controllers | Behaviour |
|---|---|---|
| **Opacity** | Keypad + Encoder | Dial adjusts in 5% steps, push/touch resets to 100%. On a key, press cycles 40 → 60 → 80 → 100%. |
| **Corner Radius** | Keypad + Encoder | Dial adjusts in 2px steps, push/touch resets to 16px. On a key, press cycles the presets. |
| **Zoom** | Keypad + Encoder | Scales the image 100–400% in 5% steps; push/touch resets to 100%. |
| **Pan X** | Keypad + Encoder | Moves the visible crop left/right in 2% steps; push/touch centres that axis. |
| **Pan Y** | Keypad + Encoder | Same, vertically. |

Pan works at any zoom, and higher values look further right / further down, the way
panning a camera does. Pushing beyond the cropped area leaves empty space, so Zoom
above 100% is worth having when you want to reframe without a gap — 125% is usually
enough.

Both knobs declare `Controllers: ["Keypad", "Encoder"]`, so the same action works on
a plain keypad and on a Stream Deck + dial. On a dial they render through the
built-in `$B1` layout (title, value, bar indicator).

### Status is shown with images, not titles

Keys never write their own title — that label is yours. Problems are signalled by
swapping the key image instead:

| Badge | Meaning |
|---|---|
| Amber warning triangle | The overlay app isn't running, or that overlay's camera has failed |
| Red cross in a frame | This key points at an overlay that no longer exists |

A key with a camera fault also stops reading as lit, so a broken feed can't look
healthy. Pressing an unreachable key still triggers Stream Deck's alert.

Stream Deck ignores `setImage` when you've set a custom image on a key, which is
the right precedence — but it does mean the badge won't appear on such a key.

The two knob actions are the exception: they use the title to show their current
value, which is the point of putting one on a key. When something's wrong the badge
says so and the value goes blank.

### Choosing which overlay a key controls

Select a key in the Stream Deck app and use **Overlay to control** in its property
inspector. The dropdown is populated live from the running app, so it lists the
overlays by name.

- **Primary overlay** (the default) follows the first entry in `config.json`, so a
  key keeps working even if you rename or reorder overlays.
- Picking a specific overlay pins the key to that `id`.

Targeting is **per key**, so two Show buttons can drive two different windows. On a
Stream Deck + dial, the touch strip title gains the overlay name once a specific
one is targeted, e.g. `Opacity · Overlay 2`.

If a key points at an overlay that has since been removed it shows `missing` rather
than silently retargeting itself, and the dropdown keeps the dead id listed as
*not found*. The plugin log records every change:

```
com.ljack2k.webcamoverlay.show now targets overlay-2
```

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

**Targeting.** The overlay supports multiple windows, so most commands accept an
`overlay` field holding an overlay `id`. Omit it and the command hits the **primary**
(first) overlay; pass `"*"` and it hits every one. Each key sends the id chosen in
its property inspector, and omits the field when set to Primary — which is why keys
placed before multi-overlay support keep working untouched.

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
| `snapCorner` | `corner` | Park in `top-left` / `top-right` / `bottom-left` / `bottom-right` |
| `setStartup` | `enabled` | Launch the overlay at Windows login |
| `setCamera` | `id` or `label` | Switch webcam. `label` matches case-insensitively on a substring, which is far more usable than an opaque device id; no argument means the system default |
| `setMirror` / `toggleMirror` | `enabled` | Flip the image left-to-right |
| `setFit` | `fit` | `cover` / `contain` / `fill` |
| `fitToCamera` | — | Resize the window to the stream's aspect ratio |
| `setPan` | `x` and/or `y` | Absolute pan, 0–100. Omitting an axis leaves it alone |
| `nudgePan` | `dx` and/or `dy` | Relative pan |
| `setZoom` | `value` 1–4 | Absolute zoom |
| `nudgeZoom` | `delta` | Relative zoom |
| `recentre` | — | Both pan axes back to 50 |
| `openSettings` | — | Open the settings window |
| `addOverlay` | — | Create another overlay window |
| `removeOverlay` | `overlay` | Close one and drop it from the config (the last one can't be removed) |
| `quit` | — | Quit the app |

Out-of-range values are clamped by the overlay, and unknown verbs are ignored
rather than throwing — the plugin can't wedge the overlay with a bad message.

The overlay pushes this on connect and after every change:

```json
{
  "event": "state",
  "mode": "windowed",
  "visible": true,
  "opacity": 1,
  "radius": 16,
  "corner": "bottom-right",
  "startup": true,
  "overlays": [
    { "id": "main", "name": "Main", "mode": "windowed", "visible": true,
      "opacity": 1, "radius": 16, "mirror": false, "fit": "cover",
      "pan_x": 50, "pan_y": 50, "zoom": 1,
      "corner": "bottom-right", "camera": "Insta360 Link 2 Pro", "error": null,
      "video": { "width": 1920, "height": 1080 } }
  ]
}
```

`overlays` is the authoritative per-window list. The five fields beside it mirror
the **primary** overlay so that controllers written before multi-overlay support
keep reading the shape they expect.

`corner` is the screen corner a window is currently parked in, or `null` when it
sits anywhere else — computed from the live bounds, so dragging a window off a
corner clears it.

`error` is `null` when the camera is fine, or a short message when it isn't — a
device that vanished mid-session, or one another app holds exclusively.

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

Link it into Stream Deck. Developer mode has to be on first:

```bash
npx @elgato/cli dev
```

```bash
npx @elgato/cli link com.ljack2k.webcamoverlay.sdPlugin
```

That puts a **junction** at `%APPDATA%\Elgato\StreamDeck\Plugins\com.ljack2k.webcamoverlay.sdPlugin`
pointing back here, so edits are live — `restart` is enough after changing `bin/`.

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

**`streamdeck validate` does not check that images decode.** It passes happily
with image files that are zero bytes, or that were written without a `.png`
extension at all. `tools/make-icons.ps1` therefore asserts a minimum file size on
every file it writes; if you add artwork by any other route, check by hand that
each path declared in `manifest.json` resolves at both 1x and 2x.

**Icons are drawn with GDI+, not Electron.** `capturePage()` and offscreen `paint`
both return empty images for a window that is never composited, and `toPNG()` then
yields a zero-length buffer *without throwing*.

**The property inspector deliberately avoids the `sdpi-components` CDN.** It's a
web view; a remote script means a blank settings panel whenever the machine is
offline. `ui/port.html` talks the raw property-inspector socket protocol instead.

**Treat action UUIDs as permanent.** Stream Deck binds every placed key to its
action UUID, so changing one orphans each key already using it — the profile
cannot migrate itself, and the button has to be dragged onto the device again.
Renaming the plugin namespace changes all six at once.
