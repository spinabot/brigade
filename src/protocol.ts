/**
 * Brigade gateway wire protocol.
 *
 * Single WebSocket connection per client. Three frame types travel over
 * the same connection:
 *
 *   1. REQUEST  (client → server) — caller expects a Response with the same id
 *   2. RESPONSE (server → client) — answers a Request, ok+payload OR error
 *   3. EVENT    (server → client) — push, no id, broadcast to all clients
 *
 * The req/res shape is for commands that need a reply (e.g. `list-models`
 * returns the list). The event shape is for streaming the live agent
 * state (every Pi event becomes a Brigade event with `event === "pi"`).
 *
 * Every frame is a JSON object with a discriminator `type` field so the
 * server and client can route without sniffing payload shapes. ID format
 * is `r{counter}` — opaque string, server treats as bytes.
 *
 * Compatible with: any WebSocket client speaking this JSON shape.
 */

import type { Model } from "@mariozechner/pi-ai";

/* ─────────────────────────── frame types ─────────────────────────── */

/** Caller → server. Server replies with a Response sharing this id. */
export interface RequestFrame {
	type: "req";
	id: string;
	method: RequestMethod;
	params?: unknown;
}

/** Server → caller. Always references a Request id. */
export interface ResponseFrame {
	type: "res";
	id: string;
	ok: boolean;
	payload?: unknown;
	error?: { code: string; message: string };
}

/** Server → all clients. Push notification, no id. */
export interface EventFrame {
	type: "event";
	event: EventName;
	payload?: unknown;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

/* ─────────────────────────── request methods (commands) ─────────────────────────── */

/**
 * Every request the server understands. Adding a new one means:
 *   1. Add the literal string here
 *   2. Add params + payload types in RequestParams / ResponseFor
 *   3. Add a case in server.ts handleRequest()
 *   4. Add a typed wrapper in the client
 */
export type RequestMethod =
	/** Send a new user message and start a turn. Reply: void on success. */
	| "prompt"
	/** Abort the in-flight turn. Reply: void. */
	| "abort"
	/** Mid-turn user message — queued for the next iteration. Reply: void. */
	| "steer"
	/** Switch to a different model. Reply: void. */
	| "set-model"
	/** Mid-turn live model switch — abort + swap + re-prompt. Reply: void. */
	| "switch-model-mid-turn"
	/** Set thinking level. Pi clamps to model capabilities. Reply: void. */
	| "set-thinking"
	/** Manual compaction trigger. Reply: void. */
	| "compact"
	/**
	 * Resolve a pending tool-approval request. The gateway broadcasts an
	 * `approval-request` event when a shell command needs operator consent;
	 * the TUI sends this back with the operator's choice.
	 *
	 * Decisions:
	 *   - `"allow-once"`     → this call only; nothing persisted
	 *   - `"allow-always"`   → write the exact command to `~/.brigade/exec-approvals.json`
	 *   - `"allow-pattern"`  → write a regex pattern (`params.pattern` required)
	 *   - `"deny"`           → this call refused; nothing persisted
	 */
	| "approval-resolve"
	/** List configured models. Reply: ModelSummary[]. */
	| "list-models"
	/** Reload the model registry from disk. Reply: void. */
	| "refresh-models"
	/** Get the current state snapshot on demand. Reply: SessionStateSnapshot. */
	| "get-state"
	/**
	 * Request a graceful shutdown of the gateway. The server acks the request,
	 * runs its full cleanup chain (close clients, unwind Pi session, clear PID
	 * + lock files), then exits with code 0. Used by `brigade gateway stop` to
	 * avoid Windows' `process.kill(SIGTERM)` forceful-kill behaviour. Reply:
	 * void (the response fires before the process exits, so the client can
	 * confirm the daemon is shutting down).
	 */
	| "shutdown";

/* ─────────────────────────── event names ─────────────────────────── */

/**
 * Every event the server can broadcast. Adding a new one means:
 *   1. Add the literal string here
 *   2. Add the payload type in EventPayload
 *   3. Emit it from server.ts via broadcast()
 *   4. Subscribe to it in the client
 */
export type EventName =
	/** Wraps a Pi AgentSessionEvent — `payload.event` is the inner Pi event. */
	| "pi"
	/** State snapshot. Server pushes after every mutation + on connect. */
	| "state"
	/** Server-side error (not a Pi error). One-off display. */
	| "error"
	/** Mirrored from event-logger writes — useful for debug clients. */
	| "log"
	/**
	 * The gateway needs operator consent to run a gated tool call (today:
	 * `bash`). The TUI renders an inline approval prompt and resolves via
	 * the `approval-resolve` request.
	 */
	| "approval-request";

/* ─────────────────────────── payload types ─────────────────────────── */

/** Params for each request method. `void` = no params required. */
export interface RequestParams {
	prompt: { text: string };
	abort: void;
	steer: { text: string };
	"set-model": { provider: string; modelId: string };
	"switch-model-mid-turn": { provider: string; modelId: string; replayMessage: string };
	"set-thinking": { level: string };
	compact: void;
	"approval-resolve": {
		/** Matches the `approval-request` event's `id`. */
		id: string;
		/** Operator's choice. */
		decision: "allow-once" | "allow-always" | "allow-pattern" | "deny";
		/** Required when `decision === "allow-pattern"`. Regex string. */
		pattern?: string;
	};
	"list-models": void;
	"refresh-models": void;
	"get-state": void;
	shutdown: void;
}

/** Payload for each request method's response. `void` = no payload. */
export interface ResponseFor {
	prompt: void;
	abort: void;
	steer: void;
	"set-model": void;
	"switch-model-mid-turn": void;
	"set-thinking": void;
	compact: void;
	"approval-resolve": void;
	"list-models": ModelSummary[];
	"refresh-models": void;
	"get-state": SessionStateSnapshot;
	shutdown: void;
}

/** Payload shape for each event. */
export interface EventPayload {
	pi: {
		event: any; // Pi's AgentSessionEvent — kept opaque to avoid coupling
		/** Sub-agent depth (Primitive #6). > 0 means this event came from a
		 *  child sub-agent; the TUI indents nested rendering by this value.
		 *  Top-level turns leave it undefined. */
		subagentDepth?: number;
	};
	state: SessionStateSnapshot;
	error: { message: string };
	log: { level: "info" | "warn" | "error"; message: string; at: number };
	"approval-request": {
		/** Opaque server-side id; echo back in `approval-resolve`. */
		id: string;
		/** The shell command the agent wants to run. */
		command: string;
		/** Tool that triggered the prompt (today always `"bash"`). */
		toolName: string;
		/** Working directory the command would run in (display only). */
		cwd?: string;
		/** Wall-clock millis the gateway will wait before auto-denying. */
		timeoutMs: number;
		/** Subset of decisions the operator is allowed to pick. */
		decisions: ReadonlyArray<"allow-once" | "allow-always" | "allow-pattern" | "deny">;
		/** Sub-agent attribution (Primitive #6). Present when the gated tool
		 *  call originated inside a sub-agent run. The TUI surfaces this so
		 *  the operator knows it isn't the top-level agent asking. */
		subagentLabel?: string;
		subagentDepth?: number;
		parentRunId?: string;
	};
}

/* ─────────────────────────── domain types ─────────────────────────── */

/**
 * Snapshot of the small set of fields the TUI renders. Sent on every
 * state mutation so the client always has consistent state without
 * having to mirror the full Pi session.
 */
export interface SessionStateSnapshot {
	provider: string | undefined;
	modelId: string | undefined;
	modelName: string | undefined;
	thinkingLevel: string;
	supportsThinking: boolean;
	availableThinkingLevels: string[];
	contextUsagePercent: number | null;
	totalTokensIn: number;
	totalTokensOut: number;
	totalCostUsd: number;
	isAgentRunning: boolean;
	messageCount: number;
	/**
	 * True when the agent is in fresh-bootstrap mode AND no turn has happened
	 * yet — i.e. BOOTSTRAP.md still exists on disk, IDENTITY.md has no Name
	 * field set, and `messageCount === 0`. The connect TUI uses this to auto-
	 * fire the synthetic kickoff message ("Wake up, my friend!") on first
	 * attach, mirroring the way `brigade chat` and reference frameworks
	 * (the reference) auto-trigger BOOTSTRAP from the TUI launch path. Once the
	 * first turn lands or the workspace is established, this flips to false
	 * and stays false for the lifetime of that workspace.
	 */
	firstRunBootstrap: boolean;
	/**
	 * The agent's chosen name from IDENTITY.md, or `undefined` when no Name
	 * is set yet. Used by the connect TUI to label assistant messages
	 * (showing "felix  Hey" instead of the hardcoded "brigade  Hey") so the
	 * UI reflects the operator's chosen persona even when the underlying
	 * model misbehaves and produces a generic-coding-assistant reply.
	 */
	agentName?: string;
}

/**
 * Wire-safe version of a Pi Model<any>. The full Model has stream functions
 * and other non-serializable fields — clients only need ids + display info
 * to render the picker.
 */
export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	costInputPerMtok: number;
	hasVision: boolean;
}

export function modelToSummary(model: Model<any>): ModelSummary {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: !!model.reasoning,
		contextWindow: model.contextWindow ?? 0,
		costInputPerMtok: model.cost?.input ?? 0,
		hasVision: Array.isArray(model.input) && model.input.includes("image"),
	};
}

/* ─────────────────────────── shared constants ─────────────────────────── */

/** Default port. Configurable via BRIGADE_PORT env var. */
export const DEFAULT_PORT = 7777;

/**
 * Process exit codes — sysexits-aligned so supervisors (systemd, launchd,
 * Docker) make the right restart decisions:
 *   - 1   = generic failure (default; supervisor will retry)
 *   - 2   = usage error (bad CLI args; retry will fail again)
 *   - 78  = configuration error (sysexits EX_CONFIG; supervisor STOPS
 *           retrying because restarting won't fix a bad config)
 *
 * Use EXIT_CONFIG_ERROR for "the config is missing or invalid" — without it,
 * a misconfigured `brigade gateway` under systemd would restart-storm.
 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_CONFIG_ERROR = 78;

/**
 * Tick interval for the heartbeat. Server pushes a `pi`-wrapped tick event
 * every TICK_INTERVAL_MS so the client can detect a stalled connection.
 * Client closes if no frame received in 2× this interval.
 */
export const TICK_INTERVAL_MS = 30_000;

/* ─────────────────────────── tiny runtime guards ─────────────────────────── */

/** Cheap shape check before routing. Avoids dragging in AJV for v1's small surface. */
export function isFrame(value: unknown): value is Frame {
	if (!value || typeof value !== "object") return false;
	const t = (value as any).type;
	return t === "req" || t === "res" || t === "event";
}
