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

import type { Model, ToolCall as PiToolCall } from "@earendil-works/pi-ai";
import type { ProviderLimitWindow } from "./agents/usage/limits.js";
export type { ProviderLimitWindow };
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
import type { HelloOk } from "./protocol/handshake.js";
import type { ShutdownFrame, TickFrame } from "./protocol/messages.js";
import type { MemoryGraphExport } from "./agents/memory/graph-export.js";
import type { MemoryQueryResult } from "./agents/memory/query.js";

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
	/**
	 * Structured error. `code` is one of `ErrorCodes` (see protocol/errors.ts —
	 * the complete catalogue a client branches on). `retryable` + `retryAfterMs`
	 * let a client back off correctly (e.g. on `rate-limited`); `details` carries
	 * optional structured context.
	 */
	error?: { code: string; message: string; retryable?: boolean; retryAfterMs?: number; details?: unknown };
}

/**
 * Server → all clients. Push notification, no id.
 *
 * `seq` is a per-session monotonic counter stamped on ORDERED transcript
 * frames (today: `pi`). A client tracks the last seq it saw for each session;
 * a jump (next seq ≠ last + 1) means it missed a frame, so it issues a
 * `resume` to backfill from the transcript. Untagged frames (state / error /
 * basic log — no session) carry NO seq: they are not part of the ordered
 * stream and need no gap detection. Optional on the wire so an older or
 * minimal client that ignores it still works unchanged (unauthenticated +
 * legacy stay byte-for-byte compatible).
 */
export interface EventFrame {
	type: "event";
	event: EventName;
	payload?: unknown;
	/** Per-session monotonic sequence for ordered streams (`pi`). Absent on
	 *  untagged frames (state/error/basic log). */
	seq?: number;
}

/**
 * Top-level frame union. `tick` (keepalive) and `shutdown` (graceful restart
 * notice) are defined in `protocol/messages.ts`; the client tolerates them so
 * a future server can emit them without breaking older clients, and so a
 * graceful shutdown surfaces as a clean "reconnecting" line instead of a raw
 * socket drop.
 */
export type Frame = RequestFrame | ResponseFrame | EventFrame | TickFrame | ShutdownFrame | HelloOk;

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
	/**
	 * Promote everything queued for the running turn into IMMEDIATE steering.
	 *
	 * The operator queued messages while the model worked and has now decided
	 * the model should see them without waiting for the turn to end. Reply:
	 * `{ promoted, sessionKey }`.
	 */
	| "flush-queue"
	/**
	 * Rewind the conversation to an earlier point, or list the points available.
	 *
	 * CONVERSATION ONLY — files on disk are never touched. Reply:
	 * `SessionRewindResult`.
	 */
	| "sessions.rewind"
	/** Switch to a different model. Reply: void. */
	| "set-model"
	/** Drop a session's model pin so it follows its agent again. */
	| "clear-session-model"
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
	/**
	 * Validate + persist a provider API key into the gateway's auth-profiles.json
	 * (the same store `brigade onboard` writes), hot-load it into the live auth
	 * view, and refresh the model registry so the provider's models become
	 * available WITHOUT a gateway restart. Backs the TUI `/provider` command's
	 * inline add-a-new-provider path. Reply: { ok, provider, modelCount?, warning? }.
	 */
	| "add-provider"
	/** Get the current state snapshot on demand. Reply: SessionStateSnapshot. */
	| "get-state"
	/**
	 * Re-materialise a session's transcript after (re)connect or a detected
	 * seq gap. Reply: ResumeSnapshot (the ordered conversation + the session's
	 * head seq + the header state). The client renders the messages keyed by
	 * identity (role + timestamp; tool blocks by toolCall id) and then keeps
	 * applying live `pi` frames idempotently — so a dropped or reordered frame
	 * self-heals with nothing missing and nothing misplaced. The transcript is
	 * the single source of truth: both this snapshot and the live stream
	 * resolve to it. Cheap + safe to call on every connect.
	 */
	| "resume"
	/** Memory Graph dashboard data — nodes + typed edges + topic clusters + stats.
	 *  Reply: MemoryGraphExport. */
	| "memory-graph"
	/** Operator memory inspection — list / search / inspect / stats.
	 *  Reply: MemoryQueryResult. */
	| "memory-query"
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
	/**
	 * Set or clear a session's display name. Naming is metadata about a
	 * conversation, not activity in it, so this deliberately does NOT touch
	 * `lastUsedAt` — a rename must not reorder a recency-sorted history.
	 */
	| "sessions.rename"
	/**
	 * Delete a session and its transcript. OPERATOR-ONLY — there is deliberately
	 * no agent tool for this: deletion is irreversible and the sessions tool
	 * bundle has no owner gate. Refuses while a turn is running.
	 */
	| "sessions.delete"
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

/* ─────────────────────── runtime discovery arrays ─────────────────────── */

/**
 * Runtime list of every core request method, mirroring the `RequestMethod`
 * union (types are erased at compile time, so a client can't enumerate them
 * otherwise). The gateway advertises this (plus any plugin-registered methods)
 * in `HelloOk.features.methods` on connect, so a web/mobile client discovers
 * what it can call instead of hardcoding strings. `satisfies` makes adding an
 * invalid method a compile error.
 */
export const REQUEST_METHODS = [
	"prompt",
	"abort",
	"steer",
	"flush-queue",
	"sessions.rewind",
	"set-model",
	"clear-session-model",
	"switch-model-mid-turn",
	"set-thinking",
	"compact",
	"approval-resolve",
	"exec-allow-all",
	"exec-grant-skill",
	"list-models",
	"refresh-models",
	"add-provider",
	"get-state",
	"resume",
	"memory-graph",
	"memory-query",
	"shutdown",
	"subscribe",
	"unsubscribe",
	"agents.list",
	"sessions.list",
	"sessions.rename",
	"sessions.delete",
	"cron.status",
	"cron.list",
	"cron.add",
	"cron.update",
	"cron.remove",
	"cron.run",
	"cron.runs",
	"wake",
	"org.snapshot",
] as const satisfies readonly RequestMethod[];

/**
 * Runtime list of every server-pushed event name, mirroring `EventName`.
 * Advertised in `HelloOk.features.events` so a client knows what to subscribe
 * to. `satisfies` keeps it in lock-step with the union.
 */
export const EVENT_NAMES = [
	"pi",
	"state",
	"error",
	"log",
	"system-event",
	"approval-request",
] as const satisfies readonly EventName[];

/* ─────────────────────── pi inner-event contract ─────────────────────── */

/**
 * The set of `pi.event.type` values the gateway forwards (mirrors Pi's
 * `AgentSessionEvent` union). A web/mobile renderer switches on `pi.event.type`;
 * this is the authoritative list so it can be exhaustive.
 */
export const PI_EVENT_TYPES = [
	"agent_start",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"agent_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"mid_turn_compaction_start",
	"mid_turn_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"session_info_changed",
	"thinking_level_changed",
] as const;

export type PiEventType = (typeof PI_EVENT_TYPES)[number];

/**
 * Brigade-native, wire-stable view of a Pi `AgentSessionEvent` — the inner
 * `payload.event` of a `pi` frame. Provided so a web/mobile client has a typed
 * contract WITHOUT importing Pi's SDK types (which live in node_modules and
 * aren't shipped to a browser). It's an open union: known variants carry the
 * fields a renderer needs; the trailing member keeps it forward-compatible if
 * Pi adds an event type. Mirror of `@earendil-works/pi-coding-agent`'s
 * `AgentSessionEvent` — keep in sync when bumping the SDK.
 *
 * `message` is a {@link WireMessage}; key assistant blocks by
 * `role + timestamp` and tool blocks by the tool call id (see
 * docs/reliable-streaming.md).
 */
export type PiEvent =
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "turn_end"; message: WireMessage; toolResults?: WireMessage[] }
	| { type: "message_start"; message: WireMessage }
	| { type: "message_update"; message: WireMessage; assistantMessageEvent?: PiAssistantMessageEvent }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult?: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: unknown; isError: boolean }
	| { type: "agent_end"; messages?: WireMessage[]; willRetry?: boolean }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason?: string;
			aborted?: boolean;
			willRetry?: boolean;
			errorMessage?: string;
			/** Provider-side result. `tokensBefore` was already on the wire and
			 *  undeclared, so no client could report what compaction achieved. */
			result?: { summary?: string; tokensBefore?: number; firstKeptEntryId?: string };
			/**
			 * Brigade's own before/after measurement, attached by the gateway.
			 *
			 * Without it "✓ compacted" is an unfalsifiable claim: the context
			 * percentage does not refresh until the next SUCCESSFUL reply, so a
			 * compaction that reclaimed nothing looked exactly like one that
			 * reclaimed everything. Even when the compaction's own COST cannot be
			 * priced, what it FREED can always be measured.
			 */
			outcome?: {
				tokensBefore: number;
				tokensAfter: number;
				freedTokens: number;
				messagesBefore: number;
				messagesAfter: number;
				madeProgress: boolean;
			};
		}
	/**
	 * MID-TURN compaction — distinct from `compaction_start`/`compaction_end`,
	 * and deliberately not folded into them.
	 *
	 * Pi's compaction REPLACES `session.messages`, which is how the gateway
	 * measures its outcome (count before, count after). Mid-turn compaction
	 * changes nothing in the session: it reduces the view sent on ONE request
	 * and leaves the transcript whole. Reusing the same events would make the
	 * gateway measure an unchanged session and report "reclaimed nothing" on a
	 * compaction that in fact freed most of the window.
	 *
	 * So these carry their own numbers, measured where the reduction actually
	 * happened.
	 */
	| { type: "mid_turn_compaction_start"; messagesBefore: number; tokensBefore: number }
	| {
			type: "mid_turn_compaction_end";
			/** Did the request actually go out reduced? */
			applied: boolean;
			/** Why not, when it did not — surfaced so a silent no-op is impossible. */
			reason: string;
			tokensBefore: number;
			tokensAfter: number;
			freedTokens: number;
			messagesBefore: number;
			messagesAfter: number;
			durationMs?: number;
			errorMessage?: string;
			/**
			 * What the summarization itself cost.
			 *
			 * A compaction on a full window is one of the largest single model
			 * calls a harness makes, and every surveyed harness either folds it
			 * silently into session totals or drops it entirely. Brigade runs the
			 * call on its own isolated session, so Pi's own accounting for that
			 * session gives a real figure — reported here rather than recorded as
			 * spend that could not be priced.
			 */
			usage?: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
				/** False when the provider established no price; totals render `≥$X`. */
				costKnown: boolean;
			};
		}
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage?: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: string }
	| { type: string; [field: string]: unknown };

/**
 * The INNER streaming event carried on every `message_update`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * `message_update.message` is the full CUMULATIVE assistant message — the whole
 * reply so far, resent on every token. That is what makes resume idempotent
 * (apply-by-replace can never duplicate), and it is also why a 8k-token answer
 * costs ~125 MiB on the wire and why a renderer repaints rather than types.
 *
 * Alongside it, the provider emits a precise DELTA describing what actually
 * changed. Brigade has always forwarded it — the gateway broadcasts the Pi event
 * object verbatim — but the protocol never declared it, so no client knew it was
 * there and every renderer fell back to the expensive snapshot path.
 *
 * Declaring it is purely additive: `message` keeps its meaning and stays the
 * reconciliation path, while a client that understands `assistantMessageEvent`
 * can append deltas instead of replacing, render reasoning as a live phase, and
 * show a tool's arguments as the model writes them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE STREAMS
 * ─────────────────────────────────────────────────────────────────────────
 *   text_*      the visible reply.
 *   thinking_*  the model's reasoning. NOT universally raw text — see the note
 *               on reasoning shapes below. Providers differ enough that a UI
 *               must not assume `delta` is always readable chain-of-thought.
 *   toolcall_*  the tool invocation, including `toolcall_delta` carrying the
 *               arguments AS THEY GENERATE. This is the affordance that makes a
 *               coding agent feel live: the edit target appears while the model
 *               is still writing the diff.
 *
 * `contentIndex` identifies which content block of the message the event
 * belongs to, so interleaved reasoning and text stay separable.
 *
 * Mirrors pi-ai's `AssistantMessageEvent`. Keep in sync when bumping the SDK;
 * the trailing open member keeps an unknown future variant from breaking a
 * client.
 */
export type PiAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number }
	/** Incremental tool-call ARGUMENTS as the model writes them (partial JSON). */
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall?: unknown }
	| { type: "done"; reason: "stop" | "length" | "toolUse" }
	| { type: "error"; reason: "error" | "aborted" }
	| { type: string; [field: string]: unknown };

/* ───────────────────────── wire message shapes ───────────────────────── */

/** A text/thinking/tool-call content block on a wire message. */
export interface WireContentBlock {
	type: "text" | "thinking" | "toolCall" | "image" | string;
	/** Present on `text` blocks. */
	text?: string;
	/** Present on `thinking` blocks. */
	thinking?: string;
	/**
	 * Opaque provider payload authenticating a `thinking` block, and the ONLY
	 * carrier of a redacted block's content.
	 *
	 * A client that rebuilds a transcript from these blocks and sends it back to
	 * the model MUST echo this verbatim: providers that sign reasoning reject or
	 * silently degrade a turn whose thinking blocks were altered or stripped.
	 * Dropping it is a correctness bug, not a cosmetic one — which is why it is
	 * on the wire even though the reference TUI never re-sends a transcript (the
	 * gateway owns it).
	 */
	thinkingSignature?: string;
	/**
	 * True when the provider's safety filter redacted this thinking block. There
	 * is no readable `thinking` text in that case — the encrypted payload lives
	 * in `thinkingSignature`. A renderer must show "reasoning redacted by the
	 * provider" rather than an empty thought bubble, and must still round-trip
	 * the signature for multi-turn continuity.
	 */
	redacted?: boolean;
	/** Present on `toolCall` blocks — the stable tool call id used to key the
	 *  tool's render block + correlate its `toolResult`. */
	id?: string;
	/** Tool name, on `toolCall` blocks. */
	name?: string;
	/**
	 * Tool arguments, on `toolCall` blocks.
	 *
	 * SPELLED `arguments`, AND TIED TO PI'S TYPE ON PURPOSE.
	 *
	 * This field was previously not declared at all — it was served by the index
	 * signature below, which types every unknown key as `unknown`. That meant
	 * `block.arguments` and `block.input` (the Anthropic WIRE spelling for the
	 * same thing) both compiled and both returned `unknown`, so reaching for the
	 * wrong dialect was invisible to the compiler. `renderTranscript` did exactly
	 * that and rendered every tool call with empty arguments; `approxMessageChars`
	 * did the same and estimated a 153,000-token transcript at 5 tokens, silently
	 * disabling tier-2 compaction.
	 *
	 * Declaring it explicitly restores the type. Sourcing it from `PiToolCall`
	 * rather than restating `Record<string, unknown>` means the wire contract and
	 * Pi's in-memory shape cannot drift apart silently: if Pi renames the field,
	 * this line fails to compile instead of serialising `undefined` to every
	 * connected client. See `src/agents/pi-dialect.ts` for the full account.
	 */
	arguments?: PiToolCall["arguments"];
	[field: string]: unknown;
}

/**
 * Wire-stable view of a Pi message (the elements of a `ResumeSnapshot.messages`
 * transcript and the `message` on `pi` events). No top-level `id` — render keys
 * are `role + timestamp` (assistant/user) and the tool call `id` /
 * `toolCallId` (tools). Open-ended for forward-compat.
 */
export interface WireMessage {
	role: "user" | "assistant" | "toolResult" | string;
	/**
	 * Stable identity of this message in the transcript, when the store has one.
	 *
	 * Pi's records form an `id` / `parentId` TREE — the structure edit, rewind
	 * and branch all need — and it previously stopped at the storage layer, so a
	 * client could not address a message to act on it. Render keys are still
	 * `role + timestamp` (see below) and are unchanged by this; the id is
	 * additive, and present only on messages read back from a transcript.
	 */
	messageId?: string;
	/** Parent in the transcript tree — the branch point a rewind would fork from. */
	parentMessageId?: string;
	/** Creation timestamp (ms) — stable across a message's streaming updates;
	 *  the identity key a renderer uses for the assistant block. */
	timestamp?: number;
	/** `string` for a simple user message, else an array of content blocks. */
	content?: string | WireContentBlock[];
	/** On `toolResult` messages — correlates to the assistant's tool call id. */
	toolCallId?: string;
	/** On `toolResult` messages. */
	toolName?: string;
	/** On `toolResult` messages. */
	isError?: boolean;
	[field: string]: unknown;
}

/* ─────────────────────────── payload types ─────────────────────────── */

/**
 * A file the client attached to a turn — the TUI's `@path` tokens, a file
 * dropped onto the terminal, or an image pasted from the OS clipboard.
 *
 * Deliberately the same shape as a channel's `InboundMediaAttachment` (minus
 * `caption`), because the gateway feeds these straight into the SAME
 * `buildMediaNote` + `buildInboundImageBlocks` pair the channel inbound
 * pipeline uses. That's what makes a pasted screenshot behave exactly like a
 * WhatsApp photo: images ride inline to a vision-capable model, audio gets
 * transcribed by any configured STT provider, and a PDF/video arrives as an
 * `analyze_media` call-to-action carrying its path.
 *
 * `path` must be absolute AND resolvable ON THE GATEWAY HOST. The TUI normally
 * shares a filesystem with its gateway (it auto-spawns one on 127.0.0.1), so
 * sending the path — rather than base64 bytes — keeps a 400 MB video off the
 * wire entirely and imposes no payload ceiling. A future remote-gateway client
 * (`brigade expose`) adds an optional `data` field here and the gateway spools
 * it to a temp file, collapsing back into this same path case; that is why the
 * transport is a path and not a blob.
 */
export interface PromptAttachment {
	/** What it is — drives inline-vision vs. `analyze_media` routing downstream. */
	kind: "image" | "video" | "audio" | "voice" | "document" | "sticker";
	/** Absolute path, resolvable on the GATEWAY host. */
	path: string;
	/** Detected MIME type, e.g. `image/png`. Inferred from the extension when absent. */
	mimeType?: string;
	/** Display name — what the operator sees in the chip tray + the media note. */
	fileName?: string;
}

/**
 * Result of a rewind, or of listing the points one could rewind to.
 *
 * `files` is the honest half of the contract: rewind moves the conversation
 * pointer and NAMES the files written after that point, without pretending to
 * revert them. Every reported failure in this space across the field is a
 * file-restore failure, and `git` already solves files with a tool the operator
 * already trusts.
 */
export interface SessionRewindResult {
	/** The points available — the operator's own messages, oldest first. */
	targets: {
		entryId: string;
		/** 1-based position, stable as the session grows. */
		ordinal: number;
		preview: string;
		timestamp?: number;
	}[];
	/** True when a rewind actually happened (an `entryId` was supplied). */
	rewound: boolean;
	/** The entry now at the leaf, when `rewound`. */
	entryId?: string;
	/** How many transcript entries are no longer on the active path. */
	abandoned?: number;
	/**
	 * Files written after the rewind point. NOT reverted — reported so the
	 * operator can reconcile them with `git`.
	 */
	files?: string[];
	/**
	 * Set when the transcript contains a compaction entry with no parent link.
	 *
	 * That shape severs the tree and makes pre-compaction history unreachable —
	 * the defect behind Claude Code's rewind losing multi-day sessions. Brigade
	 * refuses rather than silently showing a truncated conversation.
	 */
	blocked?: string;
}

/** Params for each request method. `void` = no params required. */
export interface RequestParams {
	prompt: {
		text: string;
		/** Target agent id; defaults to the gateway's boot default when omitted. */
		agentId?: string;
		/** Canonical session key; defaults to `defaultSessionKey(agentId)` when omitted. */
		sessionKey?: string;
		/**
		 * OPTIONAL files attached to THIS turn. Absent for every historical
		 * caller (cron / sub-agent / RPC / a pre-attachment TUI), so their turn
		 * is byte-identical to before.
		 */
		attachments?: ReadonlyArray<PromptAttachment>;
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
		/**
		 * WHEN the running turn sees this message.
		 *
		 *   • `"steer"` (default) — injected into the turn in progress. Pi delivers
		 *     it at the next loop iteration, so the model can change course
		 *     mid-task. Powerful and irreversible: it alters a plan the model is
		 *     halfway through executing.
		 *
		 *   • `"followUp"` — held until the turn has no more tool calls and no
		 *     pending steering, i.e. a real TURN BOUNDARY. This is what "queue my
		 *     message" should mean, and it is the safe thing to put on the key a
		 *     user hits by reflex.
		 *
		 * Defaults to `"steer"` so existing clients calling a method NAMED steer
		 * keep getting steering. Brigade's own TUI passes `"followUp"` for a plain
		 * Enter and `"steer"` only for the deliberate Ctrl/Cmd+Enter gesture.
		 */
		deliverAs?: "steer" | "followUp";
	};
	"sessions.rewind": {
		sessionKey?: string;
		agentId?: string;
		/**
		 * Transcript entry to branch from. Omit to LIST the available points
		 * without changing anything — the picker call.
		 */
		entryId?: string;
	};
	"flush-queue": {
		/** Session whose queue is promoted; defaults to the caller's binding. */
		sessionKey?: string;
		/** Agent id whose default session is used when `sessionKey` is omitted. */
		agentId?: string;
	};
	"set-model": {
		provider: string;
		modelId: string;
		/** Agent id whose runtime entry is mutated; defaults to caller's bound agent. */
		agentId?: string;
		/**
		 * Session to pin. Only read when `scope` is "session"; ignored for
		 * agent scope, where the change deliberately spans every session.
		 */
		sessionKey?: string;
		/**
		 * "agent" (the default, and the pre-existing behaviour) — move the
		 * agent's model. Every session WITHOUT its own pin follows, whether it
		 * already exists or is created later.
		 *
		 * "session" — pin `sessionKey` alone and leave the agent untouched, so
		 * one thread can run a different model without affecting the others.
		 *
		 * Optional for wire-compat: a client older than this field sends no
		 * scope and keeps getting agent-wide behaviour.
		 */
		scope?: "agent" | "session";
	};
	"clear-session-model": {
		/** Session whose pin is dropped; defaults to the caller's bound session. */
		sessionKey?: string;
		/** Agent owning that session; defaults to the caller's bound agent. */
		agentId?: string;
	};
	"switch-model-mid-turn": {
		provider: string;
		modelId: string;
		replayMessage: string;
		/**
		 * Files that rode the message being replayed. Without these, the single most
		 * likely reason to switch models mid-turn — "this model can't see images,
		 * switch to one that can" — replays the TEXT onto the vision model but leaves
		 * the image behind, so the new model still can't see it and the switch
		 * accomplishes nothing. Re-resolved gateway-side exactly like `prompt`'s.
		 */
		replayAttachments?: ReadonlyArray<PromptAttachment>;
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
	"add-provider": {
		/** Provider id (Pi KnownProvider, e.g. "anthropic" | "openai" | "openrouter"). */
		providerId: string;
		/** Plaintext API key to validate + persist into the gateway's auth-profiles.json. */
		apiKey: string;
		/** Skip the live key-validation HTTP probe (trust the caller). */
		skipValidation?: boolean;
	};
	"get-state": void;
	resume: {
		/** Agent whose session is resumed; defaults to the caller's bound agent. */
		agentId?: string;
		/** Canonical session key to resume; defaults to that agent's main session. */
		sessionKey?: string;
		/**
		 * When set, the server omits messages the client already has and returns
		 * only the tail. Today the server always returns the full transcript
		 * (simple + correct — the client applies it idempotently by identity);
		 * this is a forward-compat hint for a future tail optimisation. */
		sinceSeq?: number;
	};
	"memory-graph": {
		/** Agent whose memory graph is exported; defaults to the boot agent. */
		agentId?: string;
		/** Cap the node set returned for the viz (top-importance first). Default 250. */
		maxNodes?: number;
	};
	"memory-query": {
		/** Agent whose memory is queried; defaults to the boot agent. */
		agentId?: string;
		/** What to fetch: recent facts, a token search, one fact, or counts. */
		action: "list" | "search" | "inspect" | "stats";
		/** Search terms for action="search". */
		query?: string;
		/** Target memoryId for action="inspect". */
		memoryId?: string;
		/** Cap returned facts (list/search). Default 20, max 100. */
		limit?: number;
	};
	shutdown: void;
	subscribe: {
		/** Subscribe to events tagged with this agentId. */
		agentId?: string;
		/** Subscribe to events tagged with this sessionId. */
		sessionId?: string;
		/**
		 * Full-snapshot opt-OUT. Delta streaming is the DEFAULT.
		 *
		 * By default every `message_update` carries the full cumulative assistant
		 * message — the whole reply so far, resent per token. That is what makes
		 * `resume` trivially idempotent (apply-by-replace can never duplicate),
		 * and it is also why an 8k-token answer costs ~125 MiB on the wire.
		 *
		 * By default the gateway omits `message.content` from `message_update`
		 * frames THAT CARRY A DELTA, and the client reconstructs the text by
		 * appending `assistantMessageEvent.delta`. `role`, `timestamp` and `usage`
		 * are KEPT — the timestamp is the render key, so a delta with no way to
		 * identify its block would be unusable, and `usage` drives the live token
		 * counter. The full content still arrives on `message_start` and
		 * `message_end`, so every message ends reconciled against the
		 * authoritative snapshot and any drift self-corrects within one message.
		 * `resume` is unaffected.
		 *
		 * OPT-IN. Leave unset (or `false`) and you get the full cumulative
		 * `message.content` on every update, byte-identical to the pre-delta
		 * protocol. Set `true` only if the client appends deltas — it is roughly
		 * an 18x reduction in bytes on a long answer, but a client that does not
		 * reconstruct sees empty text until `message_end`.
		 *
		 * Advertised as the `subscribe.deltas` capability in `hello-ok`.
		 */
		deltas?: boolean;
		/**
		 * How broadly frames are delivered for an agent you have named a session on.
		 *
		 *   • `"session"` (default) — naming a session scopes delivery to that
		 *     session and its children. This is the cross-session-bleed fix:
		 *     without it, the agent's other threads (cron runs, channel traffic,
		 *     a second chat) arrive in the same stream.
		 *
		 *   • `"agent"` — the pre-narrowing breadth. For a client that names a
		 *     session for some OTHER reason and still wants the agent's whole
		 *     stream; Brigade's desktop client does exactly that, because its
		 *     snapshot push is gated on the session id.
		 *
		 * An opt-out rather than a version bump: the fix is the default, because
		 * the clients that never update are the ones that need the bleed fixed.
		 * Advertised as the `subscribe.scope` capability in `hello-ok`.
		 */
		scope?: "session" | "agent";
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
	"sessions.delete": {
		/** The session to delete. The owning agent is derived from it. */
		sessionKey: string;
	};
	"sessions.rename": {
		/** The session to rename. */
		sessionKey: string;
		/**
		 * New display name. Empty / whitespace-only CLEARS the name, so
		 * `/rename` with no argument is a natural "remove it" rather than a
		 * second command. Sanitised and length-capped server-side.
		 */
		name?: string;
	};
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
	"sessions.rewind": SessionRewindResult;
	"flush-queue": {
		/** How many queued messages were promoted into the running turn. */
		promoted: number;
		/** The session that was flushed, resolved from the params. */
		sessionKey: string;
	};
	steer: void;
	"set-model": void;
	/** `cleared: false` means the session existed but had no pin — a no-op the
	 *  TUI reports differently from an actual unpin. */
	"clear-session-model": { cleared: boolean };
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
	"add-provider": {
		ok: boolean;
		/** Provider id that was added/updated. */
		provider: string;
		/** Model count reported by the validation probe, when available. */
		modelCount?: number;
		/** Non-fatal validation note (e.g. rate-limited / provider outage at probe time). */
		warning?: string;
	};
	"get-state": SessionStateSnapshot;
	resume: ResumeSnapshot;
	"memory-graph": MemoryGraphExport;
	"memory-query": MemoryQueryResult;
	shutdown: void;
	subscribe: void;
	unsubscribe: void;
	"agents.list": AgentSummary[];
	"sessions.list": SessionSummary[];
	"sessions.rename": SessionRenameResult;
	"sessions.delete": SessionDeleteResult;
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
		/** Minted by Brigade rather than emitted by Pi's loop — today, the tool
		 *  events for a claude-cli turn, whose tools run in the binary's loop via
		 *  the MCP route. Excluded from the seq'd stream (see `broadcast`): a
		 *  `resume` cannot replay them, so they must never create a seq gap. */
		synthetic?: boolean;
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
 * What a provider actually EXPOSES of a model's reasoning.
 *
 * Reasoning is not one thing across providers, and a UI that assumes it is will
 * lie to the operator. The four shapes a harness has to represent:
 *
 *   - `raw`      the actual reasoning text streams and can be shown verbatim.
 *   - `summary`  the provider streams a SUMMARY it wrote, not the model's own
 *                chain of thought. Rendering it as "the model's thinking" is a
 *                misrepresentation, so a client must label it as a summary.
 *   - `redacted` a safety filter removed the text. Only an opaque payload
 *                remains (see `WireContentBlock.thinkingSignature`), which must
 *                still be round-tripped for multi-turn continuity.
 *   - `hidden`   the model reasons and is billed for it, but exposes nothing.
 *                The honest UI is "thinking…" with a token count and no text.
 *   - `none`     this model does not reason.
 *
 * Kept on the wire so a client renders the truth for whatever backend is
 * serving the turn, without hardcoding provider knowledge of its own.
 */
export type ReasoningVisibility = "raw" | "summary" | "redacted" | "hidden" | "none";

/** Live reasoning state for one session. */
export interface SessionReasoningState {
	/** True while the model is in a reasoning phase RIGHT NOW. */
	active: boolean;
	/** What this backend exposes — drives whether text may be shown at all. */
	visibility: ReasoningVisibility;
	/** Epoch ms the current reasoning phase began. Absent when not active. */
	startedAt?: number;
	/** Characters of reasoning text produced in the current turn, when readable. */
	chars?: number;
	/**
	 * Duration of the most recently COMPLETED reasoning phase, in ms.
	 *
	 * Server-stamped, so "Thought for 12s" survives a reconnect — two of the
	 * harnesses surveyed seed their timer from component mount and lose the
	 * figure on reload.
	 */
	durationMs?: number;
	/**
	 * Reasoning tokens billed for this turn, when the provider reports them
	 * separately. Most bill reasoning as output tokens without breaking them
	 * out, so this is frequently absent — and absent must not render as zero.
	 */
	tokens?: number;
}

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
	/**
	 * Whether the RESOLVED turn model accepts image input. The TUI reads this to
	 * warn — before the turn is sent — that a staged image will not actually be
	 * seen (it falls back to an `analyze_media` path note instead). Optional for
	 * wire-compat with a gateway older than this field.
	 */
	supportsVision?: boolean;
	availableThinkingLevels: string[];
	/**
	 * Live reasoning state for THIS session — what the model is doing right now,
	 * as opposed to `thinkingLevel`/`supportsThinking` which describe what it is
	 * capable of. Absent on a gateway older than this field.
	 */
	reasoning?: SessionReasoningState;
	/**
	 * Provider consumption windows — "how much have I got left?".
	 *
	 * Absent when the backend has not reported any, which is NOT the same as
	 * "none left": a provider that sends no rate-limit headers simply cannot be
	 * asked, and a UI must render that as unknown rather than as a full or an
	 * empty bar. Populated for whichever provider is serving this session, so a
	 * client never has to know which header dialect that provider speaks.
	 */
	limits?: ProviderLimitWindow[];
	contextUsagePercent: number | null;
	/**
	 * Estimated tokens currently in the context window, and the window's size.
	 *
	 * Both are computed on every agent event and were discarded — only the
	 * derived percentage survived, and the TUI rendered even that solely above
	 * 50%, so for most of a session's life the operator saw nothing. The raw
	 * pair is what lets a client show "34k / 200k" and compute headroom before
	 * compaction. `contextTokens` is null right after a compaction, when Pi
	 * deliberately reports unknown rather than a stale figure.
	 */
	contextTokens?: number | null;
	contextWindow?: number | null;
	/**
	 * How this backend CHARGES — what a cost figure means here, or why there
	 * isn't one.
	 *
	 *   `metered`      per-token pricing; the dollar figure is the signal.
	 *   `subscription` a plan/seat. Marginal cost really is zero, so a `$0.00`
	 *                  is true but useless — the PLAN WINDOW is the signal.
	 *   `local`        runs on the operator's hardware; nothing to meter.
	 *   `unknown`      no pricing on record. MUST render as an absence, never
	 *                  as `$0`, or an unmeasured turn reads as a free one.
	 *
	 * Without this a client cannot tell those four apart, and every one of them
	 * previously rendered as the same `$0.0000`.
	 */
	billing?: "metered" | "subscription" | "local" | "unknown";
	/**
	 * False once any contribution to `totalCostUsd` arrived with no cost signal,
	 * making the total a FLOOR rather than the truth. A renderer should show it
	 * as `≥ $0.42` in that case.
	 */
	costComplete?: boolean;
	totalTokensIn: number;
	totalTokensOut: number;
	totalCostUsd: number;
	isAgentRunning: boolean;
	messageCount: number;
	/**
	 * A newer Brigade is published. Present only when one genuinely is: the check is
	 * skipped for source checkouts, silent when the registry is unreachable, and never
	 * offers a prerelease or a downgrade. The gateway REPORTS; the operator decides,
	 * because updating restarts their gateway and they may be mid-turn.
	 */
	updateAvailable?: { current: string; latest: string } | null;
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
 * Reply to a `resume` request — the heart of reliable streaming.
 *
 * The client re-materialises a session from this on (re)connect or a detected
 * seq gap, then resumes applying live `pi` frames. Because the renderer keys
 * every block by identity (message role + timestamp; tool blocks by their
 * toolCall id) and applies terminal snapshots by REPLACE, re-applying a
 * message the client already has is a harmless no-op — so the snapshot and the
 * live stream overlap safely with nothing missing, nothing duplicated, and
 * nothing misplaced. The persisted transcript is the single source of truth.
 */
export interface ResumeSnapshot {
	/** Canonical session key this transcript belongs to. */
	sessionKey: string;
	/** Agent id that owns the session. */
	agentId: string;
	/**
	 * The ordered conversation, oldest-first ({@link WireMessage}: user /
	 * assistant / toolResult). The renderer keys each message by `role +
	 * timestamp` and each embedded tool call by its `toolCall.id`, the same keys
	 * the live stream uses — that shared keyspace is what makes snapshot ⊕ live
	 * idempotent.
	 */
	messages: WireMessage[];
	/**
	 * The session's current head sequence (the last seq stamped on an ordered
	 * frame — `pi` / `approval-request` / `system-event` — for this session, or
	 * 0 if none yet). The client sets its last-seen seq to this; subsequent live
	 * frames continue from `headSeq + 1`, and any frame with `seq ≤ headSeq` is
	 * a duplicate it can apply idempotently or skip.
	 */
	headSeq: number;
	/**
	 * Tool-approval prompts CURRENTLY pending on this session. Recovery for the
	 * one event that loses an operator ACTION: a client that connected after —
	 * or missed — the live `approval-request` frame gets the open prompts here
	 * and can resolve them via `approval-resolve`, instead of the turn hanging
	 * until it auto-denies. Empty when nothing is pending.
	 */
	pendingApprovals: EventPayload["approval-request"][];
	/**
	 * Recent `system-event` notices (cron announces, channel-health) for this
	 * session — a bounded tail so a client that was disconnected when one fired
	 * can still surface it. Oldest-first. Display-only; safe to dedupe by `at`.
	 */
	recentSystemEvents: EventPayload["system-event"][];
	/**
	 * The gateway's process boot id (session generation). If it differs from the
	 * epoch the client saw on its previous `HelloOk`, the gateway restarted and
	 * its seq counters reset — the client should treat its cursors as invalid.
	 */
	epoch: string;
	/** Header state (provider / model / tokens / running) so the client
	 *  refreshes its chrome in the same round-trip. */
	snapshot: SessionStateSnapshot;
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
	/**
	 * Operator-chosen display name, sanitised. Absent means unnamed — render the
	 * derived label or the key, as every surface did before names existed.
	 */
	displayName?: string;
}

export interface SessionDeleteResult {
	/** False on a miss, a bad key, or a session with a turn still running. */
	ok: boolean;
	sessionKey: string;
	agentId: string;
	/** Why it was refused. Absent on success. */
	reason?: string;
	/**
	 * False when the index entry went but the JSONL could not be removed — an
	 * orphaned file nothing references. Surfaced rather than hidden so the
	 * operator knows the bytes are still on disk.
	 */
	transcriptRemoved?: boolean;
}

export interface SessionRenameResult {
	/**
	 * False when the session does not exist — a clean miss rather than an error,
	 * since the caller may be racing a deletion and a rename is never worth
	 * failing a turn over. Typed clients MUST branch on this: without it a
	 * successful rename and an unknown-session miss are indistinguishable.
	 */
	ok: boolean;
	sessionKey: string;
	agentId: string;
	/** The stored name AFTER sanitising. Absent when the name was cleared. */
	name?: string;
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
 * Heartbeat interval. The server's keepalive today is the periodic `state`
 * broadcast (a real frame that bumps the client's `lastFrameAt`), plus
 * WS-protocol pings; the dedicated `TickFrame` type exists for forward-compat
 * but is not emitted yet. The client closes + reconnects if NO frame arrives in
 * 2× this interval (catches half-open sockets — the common backgrounded-mobile
 * case), then `resume`s.
 */
export const TICK_INTERVAL_MS = 30_000;

/* ─────────────────────────── tiny runtime guards ─────────────────────────── */

/** Cheap shape check before routing. Avoids dragging in AJV for v1's small surface.
 *  Accepts `tick`/`shutdown` too so the client never silently drops a keepalive
 *  or a graceful-shutdown notice (the old guard rejected both). */
export function isFrame(value: unknown): value is Frame {
	if (!value || typeof value !== "object") return false;
	const t = (value as any).type;
	return (
		t === "req" ||
		t === "res" ||
		t === "event" ||
		t === "tick" ||
		t === "shutdown" ||
		t === "hello-ok"
	);
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
