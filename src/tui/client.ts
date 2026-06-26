/**
 * Brigade gateway client.
 *
 * Connects to the server's WebSocket endpoint, sends typed requests, and
 * delivers events to subscribers. Survives transient disconnects via
 * exponential-backoff reconnect; detects dead servers via tick timeout.
 *
 * Used by: the TUI (`src/index.ts` boots this and hands it to `chat.ts`).
 * A future web/mobile client implements the same shape against the same
 * wire protocol — same code on the wire, different transport on the page.
 *
 * Resilience features:
 *   - Exponential reconnect with jitter and a cap (1s → 30s)
 *   - Tick watchdog: if no frame received in 2× TICK_INTERVAL_MS, close +
 *     reconnect (catches half-open TCP sockets)
 *   - Pending-request timeout (default 60s) so callers never hang forever
 *   - One-shot connect: caller awaits `client.ready` before sending requests
 */

import { EventEmitter } from "node:events";

import WebSocket from "ws";

import {
	DEFAULT_PORT,
	type EventName,
	type EventPayload,
	type Frame,
	isFrame,
	type RequestMethod,
	type RequestParams,
	type ResponseFor,
	TICK_INTERVAL_MS,
} from "../protocol.js";
import { clientAuthHeaders } from "../core/gateway-auth.js";

export interface ClientOptions {
	/** WebSocket URL. Defaults to `ws://127.0.0.1:7777`. */
	url?: string;
	/** Per-request timeout (ms). Defaults to 60_000. */
	requestTimeoutMs?: number;
	/**
	 * Token presented to an authenticated gateway (sent as the `x-brigade-token`
	 * header). Omit/undefined when the gateway is unauthenticated — the default —
	 * and no auth header is sent.
	 */
	token?: string;
}

/** Per-request options; today only the timeout is overridable. */
export interface RequestOptions {
	/**
	 * Override the per-request timeout. Pass 0 or Infinity to disable
	 * timeout entirely — useful for `prompt` requests where the server's
	 * turn can legitimately run for minutes (Ollama, slow reasoning models).
	 * With the default 60s timeout, long server turns cause a client-side
	 * error WHILE the server keeps processing — silent state desync.
	 */
	timeoutMs?: number;
}

/**
 * Brigade gateway client. Construct → `await client.connect()` → use.
 *
 * Two surfaces:
 *   - `request(method, params)` — typed request/response (Promise)
 *   - `on(event, handler)` — typed event subscription
 *
 * The `EventEmitter` parent gives us `on` / `off` for free; we wrap with
 * typed signatures so callers get autocomplete for event names + payload.
 */
export class BrigadeClient extends EventEmitter {
	private ws: WebSocket | undefined;
	private readonly url: string;
	private readonly requestTimeoutMs: number;
	/** Gateway token, or undefined when the gateway is unauthenticated. */
	private readonly token: string | undefined;

	/** True once a connection is OPEN. False after close until reconnect. */
	private connected = false;
	/** Caller called close(); don't auto-reconnect. */
	private closed = false;

	/** id → resolver for pending requests. `timer` is undefined when the
	 *  caller passed `timeoutMs: 0` (or Infinity) to disable the auto-reject
	 *  timer — long-running requests like `prompt` rely on this. */
	private pending = new Map<
		string,
		{
			resolve: (payload: unknown) => void;
			reject: (err: Error) => void;
			timer: NodeJS.Timeout | undefined;
		}
	>();
	private nextId = 1;

	/** Last time we received any frame from the server. Tick watchdog reads this. */
	private lastFrameAt = 0;
	private tickWatchTimer: NodeJS.Timeout | undefined;

	/** Reconnect state. */
	private reconnectAttempt = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;

	constructor(opts: ClientOptions = {}) {
		super();
		this.url = opts.url ?? `ws://127.0.0.1:${DEFAULT_PORT}`;
		this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
		this.token = opts.token;
	}

	/** Open the connection. Resolves once the socket is OPEN. */
	async connect(): Promise<void> {
		await this.openSocket();
		this.startTickWatch();
	}

	/** Close the connection permanently. Cancels reconnect, rejects pending. */
	close(): void {
		this.closed = true;
		this.stopTickWatch();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		// Reject all pending requests so callers don't hang.
		for (const [id, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error("client closed"));
			this.pending.delete(id);
		}
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = undefined;
		this.connected = false;
	}

	/** True if the underlying socket is currently OPEN. */
	get isConnected(): boolean {
		return this.connected;
	}

	/* ─────────────────────────── public typed API ─────────────────────────── */

	/**
	 * Send a typed request and await the typed response. Promise rejects
	 * if the server returns an error frame, the (per-request OR client-default)
	 * timeout elapses, or the socket closes before a response arrives.
	 */
	async request<M extends RequestMethod>(
		method: M,
		params?: RequestParams[M],
		options?: RequestOptions,
	): Promise<ResponseFor[M]> {
		if (!this.connected || !this.ws) {
			throw new Error("client not connected");
		}
		const id = `r${this.nextId++}`;
		const frame: Frame = { type: "req", id, method, params };
		const ws = this.ws;
		const effectiveTimeout =
			options?.timeoutMs !== undefined ? options.timeoutMs : this.requestTimeoutMs;

		return new Promise<ResponseFor[M]>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			if (effectiveTimeout > 0 && Number.isFinite(effectiveTimeout)) {
				timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`request timeout after ${effectiveTimeout}ms (${method})`));
				}, effectiveTimeout);
			}
			this.pending.set(id, {
				resolve: (payload) => resolve(payload as ResponseFor[M]),
				reject,
				timer, // optional — undefined when timeoutMs<=0 or non-finite
			});
			try {
				ws.send(JSON.stringify(frame));
			} catch (err) {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/** Type-aware event subscription. Returns `this` for chaining (matches EventEmitter). */
	override on<K extends EventName>(event: K, listener: (payload: EventPayload[K]) => void): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}

	override off<K extends EventName>(event: K, listener: (payload: EventPayload[K]) => void): this {
		return super.off(event, listener as (...args: unknown[]) => void);
	}

	/* ─────────────────────────── socket lifecycle ─────────────────────────── */

	private openSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url, { headers: clientAuthHeaders(this.token) });
			this.ws = ws;
			let resolved = false;

			ws.on("open", () => {
				this.connected = true;
				this.reconnectAttempt = 0;
				this.lastFrameAt = Date.now();
				resolved = true;
				resolve();
			});

			ws.on("message", (data) => {
				this.lastFrameAt = Date.now();
				let frame: Frame;
				try {
					const parsed = JSON.parse(data.toString());
					if (!isFrame(parsed)) return;
					frame = parsed;
				} catch {
					return;
				}
				this.dispatchFrame(frame);
			});

			ws.on("close", () => {
				this.connected = false;
				this.ws = undefined;
				// Reject every pending request — the server's session for this
				// socket is gone, so any in-flight request will NEVER receive a
				// response on this connection. Without this, requests with
				// `timeoutMs: 0` (e.g. long-running prompts) orphan in the
				// pending map and the awaiting caller hangs forever, even
				// after a successful reconnect.
				//
				// We reject BEFORE scheduleReconnect so the caller sees the
				// drop and can decide whether to retry. The reconnect itself
				// is a transport-level recovery; pending request resumption
				// is a higher-level concern (caller policy).
				for (const [id, p] of this.pending) {
					if (p.timer) clearTimeout(p.timer);
					p.reject(new Error("connection lost — request was in flight when socket closed"));
					this.pending.delete(id);
				}
				if (!resolved) reject(new Error("socket closed before open"));
				if (!this.closed) this.scheduleReconnect();
			});

			ws.on("error", (err) => {
				if (!resolved) {
					resolved = true;
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.closed) return;
		this.reconnectAttempt++;
		// Exponential backoff with jitter: 1s, 2s, 4s, ... cap at 30s.
		const baseMs = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 30_000);
		const jitter = Math.floor(Math.random() * 500);
		const delay = baseMs + jitter;

		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = undefined;
			try {
				await this.openSocket();
				this.emit("reconnected" as any);
			} catch {
				// openSocket rejected → its close handler will scheduleReconnect again
			}
		}, delay);
	}

	private dispatchFrame(frame: Frame): void {
		if (frame.type === "res") {
			const pending = this.pending.get(frame.id);
			if (!pending) return; // stale or unknown id — drop
			if (pending.timer) clearTimeout(pending.timer);
			this.pending.delete(frame.id);
			if (frame.ok) {
				pending.resolve(frame.payload);
			} else {
				pending.reject(
					new Error(frame.error?.message ?? `request failed (${frame.error?.code ?? "unknown"})`),
				);
			}
			return;
		}
		if (frame.type === "event") {
			// Re-emit with the typed event name so on() handlers fire.
			super.emit(frame.event, frame.payload);
			return;
		}
		// type === "req" — server doesn't make requests of clients in v1; ignore.
	}

	/* ─────────────────────────── tick watchdog ─────────────────────────── */

	private startTickWatch(): void {
		// Server pushes a state snapshot every TICK_INTERVAL_MS. We expect a
		// frame in 2× that interval. If none arrives, close the socket — the
		// close handler triggers reconnect.
		const checkIntervalMs = TICK_INTERVAL_MS;
		const stallThresholdMs = TICK_INTERVAL_MS * 2;
		this.tickWatchTimer = setInterval(() => {
			if (!this.connected) return;
			const gap = Date.now() - this.lastFrameAt;
			if (gap > stallThresholdMs) {
				try {
					this.ws?.close(4000, "tick timeout");
				} catch {
					/* ignore */
				}
			}
		}, checkIntervalMs);
		this.tickWatchTimer.unref();
	}

	private stopTickWatch(): void {
		if (this.tickWatchTimer) clearInterval(this.tickWatchTimer);
		this.tickWatchTimer = undefined;
	}
}
