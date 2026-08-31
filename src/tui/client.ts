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
	type ResumeSnapshot,
	type ShutdownFrame,
	TICK_INTERVAL_MS,
} from "../protocol.js";
import type { HelloOk } from "../protocol/handshake.js";
import { isSeqGap } from "../protocol/stream-seq.js";
import { BrigadeRequestError } from "../protocol/errors.js";

/** Payload of the client-emitted `"resync"` event: a seq gap was detected on a
 *  session's ordered `pi` stream, so the consumer should `resume()` to backfill. */
export interface ClientResyncInfo {
	sessionId: string;
	lastSeq: number;
	gotSeq: number;
}

/** Connection lifecycle state, emitted as the `"connection-state"` event so a
 *  UI can bind a status indicator directly. */
export type ClientConnectionState = "connecting" | "connected" | "reconnecting" | "closed";
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

	/**
	 * Last `seq` seen per session on the ordered `pi` stream. Used to detect a
	 * gap: when a frame's seq isn't `last + 1`, a frame was dropped or reordered
	 * (or the gateway restarted and reset its counters), so we emit `"resync"`
	 * and the consumer issues a `resume` to backfill from the transcript. Keyed
	 * by sessionId (= sessionKey), the same key `resume` syncs. Survives
	 * reconnects so the cursor stays meaningful across a blip.
	 */
	private lastSeqBySession = new Map<string, number>();

	/** The most recent HelloOk frame (server connId, build version, epoch,
	 *  advertised methods/events, policy limits). Undefined until first connect. */
	private lastHelloOk: HelloOk | undefined;

	/** Connection lifecycle state, mirrored by the "connection-state" event. */
	private connState: ClientConnectionState = "connecting";

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
		this.setConnState("closed");
	}

	/**
	 * Server handshake info from the last `HelloOk` — connId, build version,
	 * `epoch` (session generation), the advertised `features.{methods,events}`,
	 * and `policy` limits. Undefined before the first connect. A web/mobile
	 * client reads this to discover what it can call/subscribe to + the limits.
	 */
	get server(): HelloOk | undefined {
		return this.lastHelloOk;
	}

	/** Current connection lifecycle state (also pushed via "connection-state"). */
	get connectionState(): ClientConnectionState {
		return this.connState;
	}

	private setConnState(state: ClientConnectionState): void {
		if (this.connState === state) return;
		this.connState = state;
		super.emit("connection-state", state);
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

	/**
	 * Type-aware event subscription. Two families:
	 *   - server-pushed events, typed by `EventName` → `EventPayload[K]`
	 *   - client lifecycle events BrigadeClient emits itself: `"hello"` (the
	 *     server's HelloOk handshake landed), `"connection-state"` (connecting /
	 *     connected / reconnecting / closed), `"reconnected"` (socket re-opened),
	 *     `"resync"` (a seq gap → call `resume()`), and `"shutdown"` (the gateway
	 *     sent a graceful-shutdown frame).
	 * Returns `this` for chaining (matches EventEmitter).
	 */
	override on<K extends EventName>(event: K, listener: (payload: EventPayload[K]) => void): this;
	override on(event: "hello", listener: (hello: HelloOk) => void): this;
	override on(event: "connection-state", listener: (state: ClientConnectionState) => void): this;
	override on(event: "reconnected", listener: () => void): this;
	override on(event: "resync", listener: (info: ClientResyncInfo) => void): this;
	override on(event: "shutdown", listener: (frame: ShutdownFrame) => void): this;
	override on(event: string, listener: (...args: any[]) => void): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}

	override off<K extends EventName>(event: K, listener: (payload: EventPayload[K]) => void): this;
	override off(event: "hello", listener: (hello: HelloOk) => void): this;
	override off(event: "connection-state", listener: (state: ClientConnectionState) => void): this;
	override off(event: "reconnected", listener: () => void): this;
	override off(event: "resync", listener: (info: ClientResyncInfo) => void): this;
	override off(event: "shutdown", listener: (frame: ShutdownFrame) => void): this;
	override off(event: string, listener: (...args: any[]) => void): this {
		return super.off(event, listener as (...args: unknown[]) => void);
	}

	/**
	 * Resume a session: fetch its committed transcript + head seq + header
	 * snapshot, and sync the local seq cursor so live frames continue cleanly
	 * from `headSeq + 1`. Call this on connect, on reconnect, and on a
	 * `"resync"` event. The consumer renders the returned `messages` through
	 * its identity-keyed applier (idempotent), so overlapping with live frames
	 * is harmless. This is the reliable-streaming recovery primitive — the
	 * transcript is the source of truth, so a dropped/reordered/missed frame
	 * always self-heals here.
	 */
	async resume(params?: RequestParams["resume"]): Promise<ResumeSnapshot> {
		// NOTE: we deliberately do NOT write `lastSeqBySession` here. The seq
		// cursor is owned by `dispatchFrame`, which advances it to each live
		// frame's seq as it arrives — so after a gap the cursor already reflects
		// the last frame actually received, and the next contiguous frame won't
		// re-trigger. Writing `headSeq` here (a snapshot that can LAG the live
		// frames still streaming during the resume round-trip) would rewind the
		// cursor below an already-applied frame, making the next live frame look
		// like a fresh gap → a resync/resume storm on a busy session. resume()
		// recovers CONTENT (the transcript); the cursor is pure live bookkeeping.
		return this.request("resume", params);
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
				this.setConnState("connected");
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
				if (!this.closed) {
					this.setConnState("reconnecting");
					this.scheduleReconnect();
				}
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
				// Reject with the server's STRUCTURED error, not a flattened string.
				// Collapsing it here meant no caller could ever tell a rate-limit
				// that clears in 30s from a permanent authorization failure.
				// `BrigadeRequestError extends Error`, so existing `err.message`
				// handlers are unaffected.
				pending.reject(new BrigadeRequestError(frame.error ?? {}));
			}
			return;
		}
		if (frame.type === "event") {
			// Gap detection on the ordered stream. The server stamps a per-session
			// monotonic `seq` on every ordered frame — `pi` (top-level),
			// `approval-request`, and `system-event` — all sharing one counter, so
			// any frame carrying a `seq` is part of it. If the next seq isn't
			// `last + 1` we missed a frame (dropped by backpressure, reordered, or
			// a gateway restart); emit `"resync"` so the consumer `resume`s and
			// backfills (transcript + pending approvals + recent system-events).
			// Frames without `seq` (state/error/log + sub-agent pi) are unordered
			// side-channels and skip the check. Sub-agent frames stay unsequenced
			// deliberately: they are tagged with the child's Pi session UUID, which
			// `resume` cannot look up, so a gap in them is undetectable-but-honest
			// rather than detectable-but-unrepairable.
			if (typeof frame.seq === "number") {
				const sid = (frame.payload as { sessionId?: string } | undefined)?.sessionId;
				if (sid) {
					const last = this.lastSeqBySession.get(sid);
					this.lastSeqBySession.set(sid, frame.seq);
					if (isSeqGap(last, frame.seq)) {
						super.emit("resync", { sessionId: sid, lastSeq: last, gotSeq: frame.seq });
					}
				}
			}
			// Re-emit with the typed event name so on() handlers fire.
			super.emit(frame.event, frame.payload);
			return;
		}
		if (frame.type === "hello-ok") {
			// Server handshake (connId / build version / epoch / advertised
			// methods+events / policy limits). If the `epoch` changed since the
			// last HelloOk, the gateway restarted and its per-session seq counters
			// reset — invalidate our cursors so the fresh low seqs aren't misread
			// as a backwards gap; the consumer's reconnect → `resume` rebuilds.
			const prevEpoch = this.lastHelloOk?.server.epoch;
			this.lastHelloOk = frame;
			if (prevEpoch !== undefined && prevEpoch !== frame.server.epoch) {
				this.lastSeqBySession.clear();
			}
			super.emit("hello", frame);
			return;
		}
		if (frame.type === "tick") {
			// Keepalive — `lastFrameAt` already bumped in the message handler;
			// receiving it is enough to keep the tick watchdog satisfied.
			return;
		}
		if (frame.type === "shutdown") {
			// Graceful shutdown notice — surface it so the consumer can show a
			// "gateway restarting" line instead of a bare disconnect. The socket
			// close that follows still drives the normal reconnect+resume path.
			super.emit("shutdown", frame);
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
