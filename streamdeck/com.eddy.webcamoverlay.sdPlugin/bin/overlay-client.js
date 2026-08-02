import net from "node:net";
import { EventEmitter } from "node:events";

/**
 * Reconnecting client for the webcam overlay's loopback control channel.
 *
 * The overlay is an ordinary desktop app the user can quit at any time, so the
 * plugin must survive it being absent: every failure path schedules a retry and
 * the buttons fall back to a "disconnected" look rather than going stale.
 */
export class OverlayClient extends EventEmitter {
	#port;
	#sock = null;
	#buf = "";
	#retry = null;
	#backoff = 500;
	#closed = false;

	/** Last state pushed by the overlay, or null when not connected. */
	state = null;

	constructor(port) {
		super();
		this.#port = port;
	}

	get connected() {
		return this.#sock !== null && this.state !== null;
	}

	/** Change the port at runtime (the property inspector can edit it). */
	setPort(port) {
		if (port === this.#port) return;
		this.#port = port;
		this.#teardown();
		this.connect();
	}

	connect() {
		if (this.#closed || this.#sock) return;

		const sock = net.createConnection({ host: "127.0.0.1", port: this.#port });
		this.#sock = sock;
		sock.setEncoding("utf8");
		sock.setNoDelay(true);

		sock.on("connect", () => {
			this.#backoff = 500;
			sock.write(JSON.stringify({ cmd: "getState" }) + "\n");
		});

		sock.on("data", (chunk) => {
			this.#buf += chunk;
			let i;
			while ((i = this.#buf.indexOf("\n")) >= 0) {
				const line = this.#buf.slice(0, i).trim();
				this.#buf = this.#buf.slice(i + 1);
				if (!line) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.event === "state") {
					this.state = msg;
					this.emit("state", msg);
				}
			}
		});

		// 'error' always precedes 'close', so do all the recovery work in 'close'
		// to avoid scheduling two reconnects for one failure.
		sock.on("error", () => {});
		sock.on("close", () => {
			this.#teardown();
			this.#scheduleReconnect();
		});
	}

	send(cmd, extra = {}) {
		if (!this.#sock) return false;
		try {
			this.#sock.write(JSON.stringify({ cmd, ...extra }) + "\n");
			return true;
		} catch {
			return false;
		}
	}

	close() {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#teardown();
	}

	#teardown() {
		const had = this.state !== null;
		if (this.#sock) {
			this.#sock.removeAllListeners();
			this.#sock.destroy();
			this.#sock = null;
		}
		this.#buf = "";
		this.state = null;
		if (had) this.emit("disconnected");
	}

	#scheduleReconnect() {
		if (this.#closed) return;
		clearTimeout(this.#retry);
		this.#retry = setTimeout(() => this.connect(), this.#backoff);
		// Cap the backoff: the overlay is local, so retrying every few seconds
		// forever is cheap and means it reconnects promptly when relaunched.
		this.#backoff = Math.min(this.#backoff * 2, 5000);
	}
}
