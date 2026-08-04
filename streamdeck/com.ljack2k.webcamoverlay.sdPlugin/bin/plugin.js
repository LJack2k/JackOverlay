import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import { OverlayClient } from "./overlay-client.js";

const DEFAULT_PORT = 28492;

const overlay = new OverlayClient(DEFAULT_PORT);

// Every registered action. `this.actions` already yields only the *visible*
// instances of an action, so there is no need to track appearances separately —
// and doing so previously meant one key disappearing stopped its siblings from
// updating.
const allActions = [];

// Per-instance settings, keyed by action instance id. Both onWillAppear and
// onDidReceiveSettings carry them, which keeps render() synchronous — getSettings()
// is async and would race the state pushes.
const instanceSettings = new Map();

// Last status badge sent per action instance, so renders don't re-send it.
const lastBadge = new Map();

const STATUS = {
	offline: "imgs/status/offline.png",
	missing: "imgs/status/missing.png",
};

function renderAll() {
	for (const a of allActions) {
		try {
			a.render();
		} catch (e) {
			streamDeck.logger.error(`render failed: ${e.message}`);
		}
	}
}

/** Overlay list from the last state push, newest first entry = primary. */
function overlayList() {
	return overlay.state?.overlays ?? [];
}

overlay.on("state", (s) => {
	const names = (s.overlays ?? []).map((o) => `${o.id}${o.visible ? "" : "(hidden)"}`);
	streamDeck.logger.debug(`overlay state: ${names.join(", ") || "none"}`);
	renderAll();
	publishOverlaysToUI();
});

overlay.on("disconnected", () => {
	streamDeck.logger.info("overlay disconnected");
	renderAll();
	publishOverlaysToUI();
});

/**
 * Keeps an open property inspector's overlay dropdown current. Safe to call
 * unconditionally — sendToPropertyInspector is a no-op when none is visible.
 */
function publishOverlaysToUI() {
	streamDeck.ui
		.sendToPropertyInspector({
			event: "overlays",
			connected: overlay.connected,
			overlays: overlayList().map((o) => ({ id: o.id, name: o.name })),
		})
		.catch(() => {});
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

class OverlayAction extends SingletonAction {
	onWillAppear(ev) {
		instanceSettings.set(ev.action.id, ev.payload?.settings ?? {});
		this.render();
	}

	onWillDisappear(ev) {
		instanceSettings.delete(ev.action.id);
		lastBadge.delete(ev.action.id);
	}

	onDidReceiveSettings(ev) {
		instanceSettings.set(ev.action.id, ev.payload?.settings ?? {});
		// Immediate confirmation that a target picked in the property inspector
		// actually landed — the quickest way to diagnose a key acting on the
		// wrong window.
		const target = this.targetOf(ev.action);
		streamDeck.logger.info(
			`${this.manifestId} now targets ${target ?? "the primary overlay"}`,
		);
		this.render();
	}

	/** Overlay id this key targets, or null for "whichever is primary". */
	targetOf(action) {
		const s = instanceSettings.get(action.id);
		const id = s && typeof s.overlay === "string" ? s.overlay.trim() : "";
		return id || null;
	}

	/** The overlay this key should reflect, or null if it isn't there. */
	stateOf(action) {
		const list = overlayList();
		if (!list.length) return null;
		const id = this.targetOf(action);
		return id ? list.find((o) => o.id === id) ?? null : list[0];
	}

	/** Adds the target to a command payload, omitting it for the primary overlay. */
	argsFor(action, extra = {}) {
		const id = this.targetOf(action);
		return id ? { ...extra, overlay: id } : { ...extra };
	}

	/**
	 * A status badge to draw over the key's own image, or undefined when all is
	 * well. Signalled with an image rather than the title so a key never
	 * commandeers a label you set yourself.
	 *
	 * Stream Deck ignores setImage when the user has picked a custom image for the
	 * key, which is the right precedence — but it does mean the badge won't show
	 * on such a key.
	 */
	statusImage(action) {
		if (!overlay.connected) return STATUS.offline;
		const st = this.stateOf(action);
		if (!st) return STATUS.missing;              // overlay removed since it was set
		if (st.error) return STATUS.offline;         // camera gone or unavailable
		return undefined;                            // undefined = the manifest image
	}

	/** Only sends when the badge actually changes; renders are frequent. */
	setBadge(action, image) {
		if (lastBadge.get(action.id) === image) return;
		lastBadge.set(action.id, image);
		action.setImage(image);
	}

	/** Short word for the dial readout, where there is no user title to protect. */
	statusWord(action) {
		if (!overlay.connected) return "offline";
		const st = this.stateOf(action);
		if (!st) return "missing";
		if (st.error) return "no camera";
		return "";
	}

	async fail(action) {
		await action.showAlert();
	}

	/** Overridden by each action. */
	render() {}
}

// ---------------------------------------------------------------------------
// Dedicated state buttons
// ---------------------------------------------------------------------------

/**
 * A button that puts one overlay into one specific state, and is lit while that
 * overlay is CURRENTLY in that state — so the key reports what is true now rather
 * than what pressing it would do.
 *
 * Each declares `DisableAutomaticStates: true` in the manifest. Without it Stream
 * Deck flips a two-state key's image on every press by itself, so pressing "Show"
 * while already visible would darken the key even though nothing changed.
 */
class StateButton extends OverlayAction {
	/**
	 * @type {{
	 *   cmd: string,
	 *   args?: object,
	 *   active: (state: object) => boolean
	 * }}
	 */
	config = null;

	async onKeyDown(ev) {
		const sent = overlay.send(this.config.cmd, this.argsFor(ev.action, this.config.args));
		if (!sent) await this.fail(ev.action);
	}

	render() {
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			const st = this.stateOf(a);
			// A camera that isn't working shouldn't read as a healthy lit state.
			const lit = overlay.connected && st && !st.error && this.config.active(st);
			a.setState(lit ? 1 : 0);
			this.setBadge(a, this.statusImage(a));
			// Deliberately no setTitle here — the key's label is yours.
		}
	}
}

class Show extends StateButton {
	manifestId = "com.ljack2k.webcamoverlay.show";
	config = { cmd: "show", active: (s) => s.visible };
}

class Hide extends StateButton {
	manifestId = "com.ljack2k.webcamoverlay.hide";
	config = { cmd: "hide", active: (s) => !s.visible };
}

// A hidden overlay is neither maximized nor windowed as far as the user is
// concerned, so neither mode button lights while it is out of sight.
class Maximize extends StateButton {
	manifestId = "com.ljack2k.webcamoverlay.maximize";
	config = { cmd: "maximize", active: (s) => s.visible && s.mode === "maximized" };
}

class WindowMode extends StateButton {
	manifestId = "com.ljack2k.webcamoverlay.window";
	config = { cmd: "windowMode", active: (s) => s.visible && s.mode === "windowed" };
}

/**
 * Parks an overlay in one screen corner. The overlay reports which corner it is
 * currently in (or null once it has been dragged elsewhere), so these light up
 * the same way the mode buttons do.
 */
class CornerButton extends StateButton {
	constructor(id, corner) {
		super();
		this.manifestId = `com.ljack2k.webcamoverlay.${id}`;
		this.config = {
			cmd: "snapCorner",
			args: { corner },
			active: (s) => s.visible && s.corner === corner,
		};
	}
}

const CORNER_BUTTONS = [
	["topleft", "top-left"],
	["topright", "top-right"],
	["bottomleft", "bottom-left"],
	["bottomright", "bottom-right"],
];

// ---------------------------------------------------------------------------
// Dial-friendly numeric actions (opacity, corner radius)
// ---------------------------------------------------------------------------

/**
 * Base for the two knob actions. Both work on a plain keypad (press cycles through
 * presets) and on a Stream Deck + dial (rotate to adjust, push to reset), so the
 * same action is useful on either device.
 */
class KnobAction extends OverlayAction {
	/**
	 * `nudgeArgs` / `setArgs` build the command payload, because not every knob
	 * takes a bare {delta}/{value} — pan is one command with two named axes.
	 *
	 * @type {{
	 *   title: string, nudge: string, set: string,
	 *   step: number, reset: number, presets: number[],
	 *   nudgeArgs?: (delta: number) => object,
	 *   setArgs?: (value: number) => object
	 * }}
	 */
	config = null;

	#nudgeArgs(delta) {
		return this.config.nudgeArgs ? this.config.nudgeArgs(delta) : { delta };
	}

	#setArgs(value) {
		return this.config.setArgs ? this.config.setArgs(value) : { value };
	}

	async onDialRotate(ev) {
		const delta = this.config.step * (ev.payload.ticks ?? 0);
		if (!overlay.send(this.config.nudge, this.argsFor(ev.action, this.#nudgeArgs(delta)))) {
			await this.fail(ev.action);
		}
	}

	async onDialDown(ev) {
		if (!overlay.send(this.config.set, this.argsFor(ev.action, this.#setArgs(this.config.reset)))) {
			await this.fail(ev.action);
		}
	}

	async onTouchTap(ev) {
		await this.onDialDown(ev);
	}

	/** Keypad fallback: step through the presets. */
	async onKeyDown(ev) {
		const cur = this.value(this.stateOf(ev.action));
		const presets = this.config.presets;
		// Next preset strictly above the current value, wrapping around.
		const value = presets.find((p) => p > cur + 1e-6) ?? presets[0];
		if (!overlay.send(this.config.set, this.argsFor(ev.action, this.#setArgs(value)))) {
			await this.fail(ev.action);
		}
	}

	render() {
		for (const a of this.actions) {
			const st = this.stateOf(a);
			const live = overlay.connected && !!st && !st.error;
			const status = this.statusWord(a);

			if (a.isKey()) {
				// The title is this action's readout — it's showing you the value,
				// not overwriting a label with a status word. When something is
				// wrong the badge says so and the title goes quiet.
				this.setBadge(a, this.statusImage(a));
				a.setTitle(live ? this.label(st) : '');
			} else {
				// The touch strip has room for the overlay name, which matters once
				// more than one overlay exists.
				const target = this.targetOf(a);
				const title = target && st ? `${this.config.title} · ${st.name}` : this.config.title;
				a.setFeedback({
					title,
					value: live ? this.label(st) : status || "offline",
					indicator: { value: live ? this.percent(st) : 0 },
					// The touch-strip icon is the layout's own, not a user label, so
					// swapping it for a status badge costs nothing. It must be set back
					// explicitly: an undefined value is dropped when the payload is
					// serialised, and Stream Deck then keeps the last icon it was
					// given — which left healthy dials stuck showing a warning.
					icon: this.statusImage(a) ?? this.config.icon,
				});
			}
		}
	}
}

class Opacity extends KnobAction {
	manifestId = "com.ljack2k.webcamoverlay.opacity";
	config = {
		title: "Opacity",
		icon: "imgs/actions/opacity/encoder.png",
		nudge: "nudgeOpacity",
		set: "setOpacity",
		step: 0.05,
		reset: 1,
		presets: [0.4, 0.6, 0.8, 1],
	};

	value(st) {
		return st?.opacity ?? 1;
	}
	percent(st) {
		return Math.round(this.value(st) * 100);
	}
	label(st) {
		return `${this.percent(st)}%`;
	}
}

class Radius extends KnobAction {
	manifestId = "com.ljack2k.webcamoverlay.radius";
	config = {
		title: "Corner radius",
		icon: "imgs/actions/radius/encoder.png",
		nudge: "nudgeRadius",
		set: "setRadius",
		step: 2,
		reset: 16,
		presets: [0, 6, 10, 16, 24, 32, 48],
	};

	value(st) {
		return st?.radius ?? 0;
	}
	percent(st) {
		// The bar is 0-100; 48px is the largest preset, so scale against that.
		return Math.round(Math.min(100, (this.value(st) / 48) * 100));
	}
	label(st) {
		return `${this.value(st)} px`;
	}
}

/**
 * Scales the image beyond its fit. This is what creates room for Pan to move: a
 * 16:9 camera in a narrow window has horizontal slack but no vertical slack at
 * all, so Pan Y does nothing until you zoom in a little.
 */
class Zoom extends KnobAction {
	manifestId = "com.ljack2k.webcamoverlay.zoom";
	config = {
		title: "Zoom",
		icon: "imgs/actions/zoom/encoder.png",
		nudge: "nudgeZoom",
		set: "setZoom",
		step: 0.05,
		reset: 1,
		presets: [1, 1.25, 1.5, 2, 3],
	};

	value(st) {
		return st?.zoom ?? 1;
	}
	percent(st) {
		// Bar spans the usable 1x-4x range.
		return Math.round(((this.value(st) - 1) / 3) * 100);
	}
	label(st) {
		return `${Math.round(this.value(st) * 100)}%`;
	}
}

/**
 * Moves the visible crop inside the overlay. Higher values look further right /
 * further down, the same way panning a camera does. Only bites where the image is
 * actually cropped — see the fit and zoom settings.
 */
class PanAction extends KnobAction {
	constructor(axis) {
		super();
		const upper = axis.toUpperCase();
		this.manifestId = `com.ljack2k.webcamoverlay.pan${axis}`;
		this.config = {
			title: `Pan ${upper}`,
			icon: `imgs/actions/pan${axis}/encoder.png`,
			nudge: "nudgePan",
			set: "setPan",
			nudgeArgs: (delta) => ({ [`d${axis}`]: delta }),
			setArgs: (value) => ({ [axis]: value }),
			step: 2,
			reset: 50,
			presets: [0, 25, 50, 75, 100],
		};
		this.axis = axis;
	}

	value(st) {
		return st?.[`pan_${this.axis}`] ?? 50;
	}
	percent(st) {
		return Math.round(this.value(st));   // already 0-100
	}
	label(st) {
		return `${this.value(st)}%`;
	}
}

// ---------------------------------------------------------------------------
// Property inspector
// ---------------------------------------------------------------------------

streamDeck.ui.onSendToPlugin((ev) => {
	if (ev.payload?.request === "overlays") publishOverlaysToUI();
});

// Send the list as soon as an inspector opens, so its dropdown is populated
// without the page having to ask.
streamDeck.ui.onDidAppear(() => publishOverlaysToUI());

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

for (const action of [
	new Show(),
	new Hide(),
	new Maximize(),
	new WindowMode(),
	...CORNER_BUTTONS.map(([id, corner]) => new CornerButton(id, corner)),
	new Opacity(),
	new Radius(),
	new Zoom(),
	new PanAction("x"),
	new PanAction("y"),
]) {
	allActions.push(action);
	streamDeck.actions.registerAction(action);
}

await streamDeck.connect();

// Let the port be overridden from global settings (set via the property inspector).
try {
	const globals = await streamDeck.settings.getGlobalSettings();
	if (globals?.port) overlay.setPort(Number(globals.port));
} catch {
	/* fall back to the default port */
}

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	const port = Number(ev.settings?.port);
	if (Number.isFinite(port) && port > 0) overlay.setPort(port);
});

overlay.connect();
streamDeck.logger.info(`webcam overlay plugin ready; control port ${DEFAULT_PORT}`);
