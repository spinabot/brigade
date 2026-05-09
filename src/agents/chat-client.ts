/**
 * `ChatClient` — the abstraction the chat TUI talks to.
 *
 * Why an interface, not a concrete class:
 * Brigade ships two chat surfaces today:
 *
 *   1. `brigade chat` — in-process TUI + Pi `AgentSession` in one process.
 *      Friendly, fast-start, single-user terminal.
 *   2. `brigade gateway` + `brigade connect` — TUI is a WebSocket client
 *      to a daemon that holds the Pi session. Survives reboots, multi-
 *      device-friendly, the future home for channels.
 *
 * Both surfaces drive the SAME conversation primitives — send a turn,
 * abort, switch model, mutate thinking level, pull context usage. Today
 * the in-process TUI talks to Pi's `AgentSession` directly (via
 * `.messages`, `.compact`, `.abort`, etc.), and the gateway TUI talks
 * to Pi indirectly through `GatewayChatClient` over WebSocket. Two
 * incompatible APIs do the same job.
 *
 * `ChatClient` unifies them. Both modes implement this interface:
 *   - `EmbeddedChatClient` wraps a long-lived Pi `AgentSession` (in-
 *     process). Method calls are passthrough.
 *   - `GatewayChatClient` (existing in `cli/commands/connect.ts`) wraps
 *     a WebSocket connection. Method calls become RPC frames.
 *
 * `runChat` (the TUI) takes a `ChatClient` instead of a Pi session, so
 * the same render code drives both modes.
 *
 * Mirrors OpenClaw's pattern: `src/tui/gateway-chat.ts:129` exposes a
 * minimal verb-list (`sendChat`, `abortChat`, `loadHistory`,
 * `listSessions`, `patchSession`) plus `onEvent` callback. OpenClaw
 * collapsed in-process mode entirely; Brigade keeps it as a UX feature
 * but unifies the TUI plane.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	AgentSessionEvent,
	ContextUsage,
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";

/** Brigade-side alias for Pi's `ThinkingLevel`. Mirrors the full set so
 *  `client.setThinkingLevel(value)` accepts everything Pi accepts;
 *  Pi clamps to model capabilities at runtime. */
export type ChatThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Disposer returned by `subscribe`. Calling twice is a no-op. */
export type Unsubscribe = () => void;

export interface SteerOptions {
	/** Mid-turn user message text. */
	text: string;
	/** Optional images to attach. Most callers leave empty. Format
	 *  matches Pi's `ImageContent`. */
	images?: Array<{ data: string; mimeType: string }>;
}

/**
 * The minimum surface every chat surface needs. Designed so the
 * existing `runChat` can call `client.X` wherever it currently calls
 * `session.X`. Methods that have no obvious 1:1 (e.g. raw stream
 * subscription) get a clean Brigade-named alternative.
 */
export interface ChatClient {
	// ── Session metadata (read) ────────────────────────────────────────

	/** Live message log. Implementations may return a snapshot or a live array;
	 *  callers should treat it as read-only. */
	readonly messages: readonly AgentMessage[];

	/** Currently active model, or `null` if not yet resolved. */
	readonly model: Model<Api> | null;

	/** Currently active thinking level. */
	readonly thinkingLevel: ChatThinkingLevel;

	/** Whether the active model exposes thinking at all.
	 *  Method (not getter) to mirror Pi's `AgentSession.supportsThinking()`
	 *  shape for drop-in compatibility with existing consumers. */
	supportsThinking(): boolean;

	/** Thinking levels the active model accepts. Subset of the four
	 *  canonical levels. Method-named to mirror Pi's
	 *  `AgentSession.getAvailableThinkingLevels()`. */
	getAvailableThinkingLevels(): readonly ChatThinkingLevel[];

	// ── Streaming events ───────────────────────────────────────────────

	/**
	 * Subscribe to per-turn streaming events. The handler is invoked on
	 * every Pi `AgentSessionEvent` (`agent_start`, `message_update`,
	 * `tool_call`, `agent_end`, etc.). Returns an idempotent disposer.
	 *
	 * Implementations bridge their underlying transport — Pi session for
	 * embedded, WebSocket frames for gateway — into the same event shape.
	 */
	subscribe(handler: (event: AgentSessionEvent) => void): Unsubscribe;

	// ── Turn control ───────────────────────────────────────────────────

	/**
	 * Send a user message and run a turn. Resolves when the turn has
	 * SETTLED (fully streamed and any tool calls completed). Streaming
	 * events fire on the subscriber while this promise is pending.
	 *
	 * Same semantics as Pi's `AgentSession.prompt(text)` — callers
	 * inspect `messages` / subscribe events to read the assistant
	 * reply. `signal` aborts the turn at the next safe boundary.
	 */
	prompt(text: string, opts?: { signal?: AbortSignal }): Promise<void>;

	/** Abort the in-flight turn (if any). No-op when idle. */
	abort(): Promise<void>;

	/** Inject a mid-turn user message. Pi calls this `steer`. Returns a
	 *  promise so async errors (invalid image encoding, transcript I/O
	 *  failure) surface to the caller instead of getting swallowed. */
	steer(opts: SteerOptions): Promise<void>;

	// ── Configuration mutations ────────────────────────────────────────

	/** Switch the active model. Affects subsequent turns; does not abort
	 *  the in-flight turn. */
	setModel(model: Model<Api>): Promise<void>;

	/** Set the thinking level. Pi clamps to model capabilities. */
	setThinkingLevel(level: ChatThinkingLevel): void;

	// ── Context window ─────────────────────────────────────────────────

	getContextUsage(): ContextUsage | undefined;

	// ── Compaction ─────────────────────────────────────────────────────

	/** Trigger compaction now. Resolves when the transcript has been
	 *  rewritten; future turns continue with the compacted history. */
	compact(): Promise<void>;
}
