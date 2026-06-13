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
import type {
	CronAddParamsV2,
	CronAddResultV2,
	CronListParamsV2,
	CronListResultV2,
	CronRemoveParamsV2,
	CronRemoveResultV2,
	CronRunParamsV2,
	CronRunResultV2,
	CronRunsParamsV2,
	CronRunsResultV2,
	CronStatusParamsV2,
	CronStatusResultV2,
	CronUpdateParamsV2,
	CronUpdateResultV2,
	CronWakeParams,
} from "./core/server-methods/cron.js";
import type { OrgSnapshotResult } from "./protocol/methods.js";

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
	 *   - `"allow-session"`  → allow this call AND skip prompts for the rest of
	 *                          the session (ephemeral; guards still apply)
	 *   - `"deny"`           → this call refused; nothing persisted
	 */
	| "approval-resolve"
	/**
	 * Arm / disarm session-scoped exec "allow-all" (the TUI `/allow-all`
	 * command). When ON, shell commands in that session skip the approval
	 * PROMPT — but every protective layer still applies (hard-deny patterns,
	 * workdir/env refusals, and the config/path-write guards that run before
	 * the exec-gate). In-memory + per-session: clears on gateway restart,
	 * never persists, never cascades to sub-agents. Reply: the resolved
	 * sessionKey + state.
	 */
	| "exec-allow-all"
	/**
	 * Grant (or preview / revoke) a skill's declared command manifest into the
	 * agent's exec-approvals allowlist — the TUI `/grant-skill` command. A
	 * grant is a SNAPSHOT of the skill's current commands, so a later edit to
	 * the skill can't widen it. Reply: the manifest + what was granted.
	 */
	| "exec-grant-skill"
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
	| "shutdown"
	/**
	 * P1#3 (Wave H) — opt the connection into receiving events tagged with
	 * the supplied agentId / sessionId only. Multi-agent gateways fan
	 * approval prompts, pi events, and logs out per turn; a UI watching
	 * one agent uses this to mute the others. Without any subscribe call
	 * the connection still receives every event (back-compat).
	 */
	| "subscribe"
	/** Drop a previously-recorded subscribe entry. */
	| "unsubscribe"
	/**
	 * Wave N5 (bug #9) — list every agent the gateway knows about (boot
	 * default + every entry under `cfg.agents.<id>`). Used by the connect
	 * TUI's `/agents` slash command so the operator can see what they can
	 * `/agent <id>`-bind to without grovelling through the config file.
	 */
	| "agents.list"
	/**
	 * Wave N5 (bug #9) — list live sessions (one per in-flight Pi session
	 * keyed by sessionKey) on the gateway. Filtered to the supplied
	 * `agentId` by default; `all: true` returns every agent's live
	 * sessions. Used by the connect TUI's `/sessions` slash command.
	 */
	| "sessions.list"
	/* ─── Cron methods (Wave N6 — full reference parity) ────────── */
	/** Service-level snapshot — job count, next wake, running. */
	| "cron.status"
	/** Paginated job list. */
	| "cron.list"
	/** Create a new job. */
	| "cron.add"
	/** Patch one job by id (accepts `id` or `jobId`). */
	| "cron.update"
	/** Delete one job by id. */
	| "cron.remove"
	/** Fire a job NOW (force or due-only; enqueued). */
	| "cron.run"
	/** Read run-log history (scope: per-job or all). */
	| "cron.runs"
	/** Inject a system event into a session (heartbeat-driven). */
	| "wake"
	/**
	 * Pride hierarchy snapshot. Returns the derived OrgGraph plus pre-
	 * rendered chart formats (tui/channel/ascii/json). Used by the
	 * connect TUI's `/org` slash command. Reply: OrgSnapshotResult.
	 */
	| "org.snapshot";

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
	 * Out-of-band notification the connect-mode TUI must render as a visible
	 * chat line — distinct from `log` which scrolls in a debug panel. Today
	 * the only producer is the cron service's announce path: when a job's
	 * `delivery.mode === "announce"` fires and there's no channel target (or
	 * the channel dispatcher refuses), the gateway broadcasts a
	 * `system-event` so the operator's connected TUI surfaces the reply as
	 * a Brigade-side bubble (e.g. `[cron "X"] hi`). Without this the
	 * announce would be silently buried in the log panel + the operator
	 * would never see their reminder fire.
	 */
	| "system-event"
	/**
	 * The gateway needs operator consent to run a gated tool call (today:
	 * `bash`). The TUI renders an inline approval prompt and resolves via
	 * the `approval-resolve` request.
	 */
	| "approval-request";

/* ─────────────────────────── payload types ─────────────────────────── */

/** Params for each request method. `void` = no params required. */
export interface RequestParams {
	prompt: {
		text: string;
		/** Target agent id; defaults to the gateway's boot default when omitted. */
		agentId?: string;
		/** Canonical session key; defaults to `defaultSessionKey(agentId)` when omitted. */
		sessionKey?: string;
	};
	abort: {
		/** Session key to abort; defaults to the gateway's boot session for back-compat. */
		sessionKey?: string;
		/** Agent id whose default session should be aborted when `sessionKey` is omitted. */
		agentId?: string;
	};
	steer: {
		text: string;
		/** Session key whose in-flight turn receives the steer; defaults to boot session. */
		sessionKey?: string;
		/** Agent id whose default session is steered when `sessionKey` is omitted. */
		agentId?: string;
	};
	"set-model": {
		provider: string;
		modelId: string;
		/** Agent id whose runtime entry is mutated; defaults to caller's bound agent. */
		agentId?: string;
	};
	"switch-model-mid-turn": {
		provider: string;
		modelId: string;
		replayMessage: string;
		/** Session key whose in-flight session is hot-swapped; defaults to boot session. */
		sessionKey?: string;
		/** Agent id whose runtime entry + (if running) live session is swapped. */
		agentId?: string;
	};
	"set-thinking": {
		level: string;
		/** Agent id whose thinking level is updated; defaults to caller's bound agent. */
		agentId?: string;
		/** Session key whose in-flight session also has its level set live. */
		sessionKey?: string;
	};
	compact: {
		/** Session key whose in-flight session is compacted; defaults to boot session. */
		sessionKey?: string;
		/** Agent id whose default session is compacted when `sessionKey` is omitted. */
		agentId?: string;
	} | void;
	"approval-resolve": {
		/** Matches the `approval-request` event's `id`. */
		id: string;
		/** Operator's choice. */
		decision: "allow-once" | "allow-always" | "allow-pattern" | "allow-session" | "deny";
		/** Required when `decision === "allow-pattern"`. Regex string. */
		pattern?: string;
	};
	"exec-allow-all": {
		/** Turn allow-all on (true) or off (false) for the resolved session. */
		enabled: boolean;
		/** Target session key. Defaults to the bound agent's main session. */
		sessionKey?: string;
		/** Agent id used to resolve the default session key when `sessionKey` is omitted. */
		agentId?: string;
	};
	"exec-grant-skill": {
		/** Skill name to grant / preview / revoke. */
		skillName: string;
		/** Apply the grant (true) or just preview the manifest (false/omitted). */
		apply?: boolean;
		/** Revoke a prior grant instead of granting. */
		revoke?: boolean;
		/** Agent whose allowlist + skills are used; defaults to the boot agent. */
		agentId?: string;
	};
	"list-models": void;
	"refresh-models": void;
	"get-state": void;
	shutdown: void;
	subscribe: {
		/** Subscribe to events tagged with this agentId. */
		agentId?: string;
		/** Subscribe to events tagged with this sessionId. */
		sessionId?: string;
	};
	unsubscribe: {
		/** Drop a prior agentId subscription. */
		agentId?: string;
		/** Drop a prior sessionId subscription. */
		sessionId?: string;
	};
	"agents.list": void;
	"sessions.list": {
		/** Filter to this agent's live sessions. Defaults to caller's bound agent. */
		agentId?: string;
		/** When true, ignore `agentId` and return every agent's live sessions. */
		all?: boolean;
	} | void;
	/* ─── Cron methods (Wave N6) — wire shapes owned by the handler module. */
	"cron.status": CronStatusParamsV2 | void;
	"cron.list": CronListParamsV2 | void;
	"cron.add": CronAddParamsV2;
	"cron.update": CronUpdateParamsV2;
	"cron.remove": CronRemoveParamsV2;
	"cron.run": CronRunParamsV2;
	"cron.runs": CronRunsParamsV2 | void;
	wake: CronWakeParams;
	"org.snapshot": void;
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
	"exec-allow-all": { sessionKey: string; enabled: boolean };
	"exec-grant-skill": {
		found: boolean;
		skill: string;
		applied: boolean;
		emptyManifest?: boolean;
		manifest: { commands: string[]; patterns: string[] };
		granted: { commands: string[]; patterns: string[] };
		refused: string[];
		removed?: number;
		revoked?: boolean;
	};
	"list-models": ModelSummary[];
	"refresh-models": void;
	"get-state": SessionStateSnapshot;
	shutdown: void;
	subscribe: void;
	unsubscribe: void;
	"agents.list": AgentSummary[];
	"sessions.list": SessionSummary[];
	/* ─── Cron methods (Wave N6) ─────────────────────────────── */
	"cron.status": CronStatusResultV2;
	"cron.list": CronListResultV2;
	"cron.add": CronAddResultV2;
	"cron.update": CronUpdateResultV2;
	"cron.remove": CronRemoveResultV2;
	"cron.run": CronRunResultV2;
	"cron.runs": CronRunsResultV2;
	wake: void;
	"org.snapshot": OrgSnapshotResult;
}

/** Payload shape for each event. */
export interface EventPayload {
	pi: {
		event: any; // Pi's AgentSessionEvent — kept opaque to avoid coupling
		/** Sub-agent depth (Primitive #6). > 0 means this event came from a
		 *  child sub-agent; the TUI indents nested rendering by this value.
		 *  Top-level turns leave it undefined. */
		subagentDepth?: number;
		/** P1#3 (Wave H) — agent that produced this Pi event. Lets the gateway
		 *  filter broadcast to subscribers of THIS agent only. */
		agentId?: string;
		/** P1#3 (Wave H) — session that produced this Pi event. Lets the gateway
		 *  filter broadcast to subscribers of THIS session only. */
		sessionId?: string;
	};
	state: SessionStateSnapshot;
	error: { message: string };
	log: {
		level: "info" | "warn" | "error";
		message: string;
		at: number;
		/** P1#3 (Wave H) — agent that produced this log entry, when known. */
		agentId?: string;
		/** P1#3 (Wave H) — session that produced this log entry, when known. */
		sessionId?: string;
	};
	"system-event": {
		/** Text the TUI renders as a Brigade-side chat line. */
		text: string;
		/** Wall-clock ms the event was queued (display + ordering). */
		at: number;
		/**
		 * Source label so the TUI can prefix or colour the bubble. Today only
		 * the cron service emits these (`source: "cron"`); future system-event
		 * producers (alerts, notifications) get their own discriminator.
		 */
		source: "cron";
		/** Optional id of the cron job that fired — display only. */
		jobId?: string;
		/** Optional human-readable name of the cron job that fired. */
		jobName?: string;
		/**
		 * True when the cron's channel-side delivery (WhatsApp/Slack/etc.)
		 * landed; false when the channel dispatcher refused or no channel
		 * target was wired. The TUI shows a small `· delivered` / `· not
		 * delivered (TUI only)` suffix so the operator can tell whether
		 * their phone got the reminder too. Undefined for system-events that
		 * aren't cron deliveries (e.g. main-target wakes).
		 */
		delivered?: boolean;
		/** P1#3 (Wave H) — agent the system event targets, when known. */
		agentId?: string;
		/** P1#3 (Wave H) — session the system event targets, when known. */
		sessionId?: string;
	};
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
		decisions: ReadonlyArray<"allow-once" | "allow-always" | "allow-pattern" | "allow-session" | "deny">;
		/** Sub-agent attribution (Primitive #6). Present when the gated tool
		 *  call originated inside a sub-agent run. The TUI surfaces this so
		 *  the operator knows it isn't the top-level agent asking. */
		subagentLabel?: string;
		subagentDepth?: number;
		parentRunId?: string;
		/** P1#3 (Wave H) — agent whose turn requested this approval. Used to
		 *  route the prompt to the right operator when more than one agent is
		 *  live; absent for legacy single-agent installs. */
		agentId?: string;
		/** P1#3 (Wave H) — session the approval belongs to. */
		sessionId?: string;
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
	/**
	 * Canonical agent id this TUI is bound to (e.g. `"main"`, `"ops"`,
	 * `"work"`). Multi-agent gateways set this so the operator can see
	 * which persona/workspace/model is loaded for their session. Defaults
	 * to the gateway's boot-time default agent id.
	 */
	agentId?: string;
	/**
	 * Canonical session key the TUI's `prompt` requests land on. Format
	 * is `agent:<id>:<rest>` — typically `agent:main:main` for the TUI's
	 * default session. Surfaced so the operator can see which session
	 * key their turns target (useful when troubleshooting cross-channel
	 * vs. operator sessions, or when the gateway routes inbound for a
	 * non-default agent).
	 */
	sessionKey?: string;
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

/**
 * Wave N5 (bug #9) — wire-safe agent descriptor for the `/agents` slash
 * command. Lists configured agents with their resolved provider + model
 * so the operator can `/agent <id>`-bind without grovelling through
 * `~/.brigade/brigade.json`. `isBoot` flags the gateway's default agent
 * (the one the TUI auto-binds to on first connect).
 */
export interface AgentSummary {
	id: string;
	provider: string;
	modelId: string;
	isBoot: boolean;
	/** Display-only persona name (from IDENTITY.md), when set. */
	personaName?: string;
}

/**
 * Wave N5 (bug #9) — wire-safe live-session descriptor for the
 * `/sessions` slash command. One entry per in-flight Pi session keyed
 * by `sessionKey`. `agentId` is the agent that owns the session; the
 * raw key carries the channel/peer / cron / subagent details the TUI
 * label formatter turns into a chip.
 */
export interface SessionSummary {
	sessionKey: string;
	agentId: string;
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

/* ─────────────────────── Step 24 protocol barrel re-export ─────────────────────── */
/**
 * The Step 24 lift split the protocol surface across `protocol/messages.ts`,
 * `protocol/methods.ts`, `protocol/handshake.ts`, `protocol/errors.ts`.
 * Re-export those modules here so callers can import from a single
 * canonical path (`from "./protocol.js"`). The legacy exports above
 * (`Frame`, `RequestMethod`, `EventPayload`, …) stay unchanged.
 */
export * from "./protocol/messages.js";
export * from "./protocol/methods.js";
export * from "./protocol/handshake.js";
export * from "./protocol/errors.js";
