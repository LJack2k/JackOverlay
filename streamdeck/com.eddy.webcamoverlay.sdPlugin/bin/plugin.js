import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import { OverlayClient } from "./overlay-client.js";

const DEFAULT_PORT = 28492;

const overlay = new OverlayClient(DEFAULT_PORT);

// Every visible action re-renders on any state change or a disconnect, so the
// keys can never show something the overlay isn't actually doing.
const rendered = new Set();

// Registered dedicated-state buttons, used for the "lit:" diagnostic below.
// Handy when a key looks wrong: the log says what the plugin thinks is true.
const stateButtons = [];
function renderAll() {
	for (const a of rendered) {
		try {
			a.render();
		} catch (e) {
			streamDeck.logger.error(`render failed: ${e.message}`);
		}
	}
}
overlay.on("state", (s) => {
	const lit = stateButtons
		.filter((b) => b.config.active(s))
		.map((b) => b.manifestId.split(".").pop());
	streamDeck.logger.debug(
		`overlay state: mode=${s.mode} visible=${s.visible} opacity=${s.opacity} ` +
			`radius=${s.radius} | lit: ${lit.join(", ") || "none"}`,
	);
	renderAll();
});
overlay.on("disconnected", () => {
	streamDeck.logger.info("overlay disconnected");
	renderAll();
});

/** Shared plumbing: track visible actions and re-render them on state changes. */
class OverlayAction extends SingletonAction {
	onWillAppear() {
		rendered.add(this);
		this.render();
	}

	onWillDisappear() {
		rendered.delete(this);
	}

	/** Overridden by each action. */
	render() {}
}

// ---------------------------------------------------------------------------
// Dedicated state buttons
// ---------------------------------------------------------------------------

/**
 * A button that puts the overlay into one specific state, and is lit while the
 * overlay is CURRENTLY in that state — so the key reports what is true now
 * rather than what pressing it would do.
 *
 * Each of these declares `DisableAutomaticStates: true` in the manifest. Without
 * it Stream Deck flips a two-state key's image on every press by itself, so
 * pressing "Show" while already visible would darken the key even though nothing
 * changed. State here is owned entirely by the overlay.
 */
class StateButton extends OverlayAction {
	/** @type {{ cmd: string, active: (state: object) => boolean }} */
	config = null;

	async onKeyDown() {
		if (!overlay.send(this.config.cmd)) {
			for (const a of this.actions) await a.showAlert();
		}
	}

	render() {
		const lit = overlay.connected && this.config.active(overlay.state);
		for (const a of this.actions) {
			if (!a.isKey()) continue;
			a.setState(lit ? 1 : 0);
			a.setTitle(overlay.connected ? "" : "offline");
		}
	}
}

class Show extends StateButton {
	manifestId = "com.eddy.webcamoverlay.show";
	config = { cmd: "show", active: (s) => s.visible };
}

class Hide extends StateButton {
	manifestId = "com.eddy.webcamoverlay.hide";
	config = { cmd: "hide", active: (s) => !s.visible };
}

// A hidden overlay is neither maximized nor windowed as far as the user is
// concerned, so neither mode button lights while it is out of sight.
class Maximize extends StateButton {
	manifestId = "com.eddy.webcamoverlay.maximize";
	config = { cmd: "maximize", active: (s) => s.visible && s.mode === "maximized" };
}

class WindowMode extends StateButton {
	manifestId = "com.eddy.webcamoverlay.window";
	config = { cmd: "windowMode", active: (s) => s.visible && s.mode === "windowed" };
}

// ---------------------------------------------------------------------------
// Dial-friendly numeric actions (opacity, corner radius)
// ---------------------------------------------------------------------------

/**
 * Base for the two knob actions. Both work on a plain keypad (press cycles
 * through presets) and on a Stream Deck + dial (rotate to adjust, push to reset),
 * so the same action is useful on either device.
 */
class KnobAction extends OverlayAction {
	/**
	 * @type {{
	 *   title: string, nudge: string, set: string,
	 *   step: number, reset: number, presets: number[]
	 * }}
	 */
	config = null;

	async onDialRotate(ev) {
		const step = this.config.step * (ev.payload.ticks ?? 0);
		if (!overlay.send(this.config.nudge, { delta: step })) await this.#offline();
	}

	async onDialDown() {
		if (!overlay.send(this.config.set, { value: this.config.reset })) await this.#offline();
	}

	async onTouchTap() {
		await this.onDialDown();
	}

	/** Keypad fallback: step through the presets. */
	async onKeyDown() {
		const cur = this.value();
		const presets = this.config.presets;
		// Pick the next preset strictly above the current value, wrapping around.
		const next = presets.find((p) => p > cur + 1e-6) ?? presets[0];
		if (!overlay.send(this.config.set, { value: next })) await this.#offline();
	}

	render() {
		const connected = overlay.connected;
		for (const a of this.actions) {
			if (a.isKey()) {
				a.setTitle(connected ? this.label() : "offline");
			} else {
				a.setFeedback({
					title: this.config.title,
					value: connected ? this.label() : "offline",
					indicator: { value: connected ? this.percent() : 0 },
				});
			}
		}
	}

	async #offline() {
		for (const a of this.actions) await a.showAlert();
	}
}

class Opacity extends KnobAction {
	manifestId = "com.eddy.webcamoverlay.opacity";
	config = {
		title: "Opacity",
		nudge: "nudgeOpacity",
		set: "setOpacity",
		step: 0.05,
		reset: 1,
		presets: [0.4, 0.6, 0.8, 1],
	};

	value() {
		return overlay.state?.opacity ?? 1;
	}
	percent() {
		return Math.round(this.value() * 100);
	}
	label() {
		return `${this.percent()}%`;
	}
}

class Radius extends KnobAction {
	manifestId = "com.eddy.webcamoverlay.radius";
	config = {
		title: "Corner radius",
		nudge: "nudgeRadius",
		set: "setRadius",
		step: 2,
		reset: 16,
		presets: [0, 6, 10, 16, 24, 32, 48],
	};

	value() {
		return overlay.state?.radius ?? 0;
	}
	percent() {
		// The bar is 0-100; 48px is the largest preset, so scale against that.
		return Math.round(Math.min(100, (this.value() / 48) * 100));
	}
	label() {
		return `${this.value()} px`;
	}
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

for (const button of [new Show(), new Hide(), new Maximize(), new WindowMode()]) {
	stateButtons.push(button);
	streamDeck.actions.registerAction(button);
}

streamDeck.actions.registerAction(new Opacity());
streamDeck.actions.registerAction(new Radius());

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
