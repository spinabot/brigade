/**
 * Multi-turn chat session — Phase 3 of the Runtime A → Runtime B migration.
 *
 * Wraps `runSingleTurn` so callers (the in-process TUI in Phase 4, the
 * gateway in Phase 4) can drive a stateful conversation without
 * re-resolving session/auth/model on every turn. Same agentId +
 * sessionKey are kept across turns; JSONL transcript continuity is
 * preserved by Pi's `SessionManager.continueRecent`.
 *
 * No new turn logic. The wrapper only:
 *   1. Caches the current `(provider, modelId, thinkingLevel)` so the
 *      caller doesn't pass it every turn.
 *   2. Parses slash commands inline via the existing `parseSlashCommand`
 *      helper — `/model`, `/thinking`, `/reset`, `/help` short-circuit
 *      before invoking `runSingleTurn`.
 *   3. Holds a per-turn AbortController so a Ctrl+C / WebSocket
 *      disconnect can cancel the in-flight turn without tearing down
 *      the session.
 *
 * What this DELIBERATELY does NOT do (yet):
 *   - Hold a long-lived Pi `AgentSession` across turns. Today, every
 *     turn calls `runSingleTurn` which constructs a fresh Pi session
 *     internally (continuity comes via JSONL). Phase 4 may revisit if
 *     `chat.ts` / `server.ts` need persistent event subscriptions.
 *   - Forward Pi streaming events to the caller — Phase 4 will design
 *     that bridge based on what `chat.ts` / `server.ts` actually need.
 *   - Multi-model failover. The resilient runner already exists at
 *     `runSingleTurnWithModelFallback` and slot in here later if
 *     needed; the basic builder calls plain `runSingleTurn` to keep
 *     the contract narrow.
 */

import { runSingleTurn, type RunSingleTurnArgs, type RunSingleTurnResult } from "./agent-loop.js";
import { parseSlashCommand, type SlashCommandResult } from "./slash-commands.js";

export type ChatThinkingLevel = "off" | "low" | "medium" | "high";

export interface OpenChatSessionArgs {
	agentId: string;
	provider: string;
	modelId: string;
	thinkingLevel?: ChatThinkingLevel;
	sessionKey?: string;
	workspaceDir?: string;
	cwd?: string;
}

/**
 * Outcome of a single `runTurn` call. Discriminated on `kind` so the
 * caller branches cleanly between model-call results, slash-command
 * acknowledgements, and aborts.
 */
export type TurnOutcome =
	| {
			kind: "model";
			result: RunSingleTurnResult;
			/** True if the message that landed at the model was a slash-command
			 *  rewrite (e.g. `/model x` → message stays the same; rare). */
			rewrittenFromSlash: boolean;
	  }
	| {
			kind: "slash";
			/** The slash-command's logical action ("model" / "thinking" / "reset" / "help" / "error"). */
			command: string;
			/** Optional human-facing detail the caller can surface (e.g.
			 *  "switched to openrouter/openai/gpt-5.4-mini — active on the next turn"). */
			detail?: string;
			/** When the parsed slash had an inline message (e.g. `/model x then write USER.md`),
			 *  this is what the caller should pass to the NEXT runTurn call. Null when
			 *  the slash command alone was the entire input. */
			carryMessage: string | null;
	  }
	| { kind: "aborted"; reason: string };

export interface ChatSession {
	readonly agentId: string;
	readonly sessionKey: string;
	readonly cwd: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ChatThinkingLevel;

	/** Run a single turn. Slash commands are intercepted before reaching `runSingleTurn`. */
	runTurn(message: string, opts?: { signal?: AbortSignal }): Promise<TurnOutcome>;

	/** Switch the model used by subsequent turns. */
	setModel(provider: string, modelId: string): void;

	/** Adjust the thinking level used by subsequent turns. */
	setThinkingLevel(level: ChatThinkingLevel): void;

	/** Abort the currently in-flight turn (if any). No-op when idle. */
	abortCurrent(reason?: string): void;
}

/**
 * Open a chat session. The returned object captures `(provider, modelId,
 * thinkingLevel)` in a closure so the caller can mutate them between
 * turns without threading them through every call.
 */
export function openChatSession(args: OpenChatSessionArgs): ChatSession {
	let provider = args.provider;
	let modelId = args.modelId;
	let thinkingLevel: ChatThinkingLevel = args.thinkingLevel ?? "off";
	let currentAbort: AbortController | null = null;
	const cwd = args.cwd ?? process.cwd();
	const sessionKey = args.sessionKey ?? `agent:${args.agentId}:main`;

	async function runTurn(
		message: string,
		opts: { signal?: AbortSignal } = {},
	): Promise<TurnOutcome> {
		// Concurrency guard. Brigade's gateway is single-user but a buggy
		// client could send two prompts back-to-back without awaiting the
		// first response. Without this guard, the second `runTurn` would
		// overwrite `currentAbort` (line below) and the first turn's
		// abort handle would be unreachable for the rest of its lifetime.
		// Fail fast with a clear message — caller decides whether to queue
		// or report. Cheaper than a queue, sufficient for the single-user
		// chat surface; Phase 2 (multi-user) will revisit if needed.
		if (currentAbort !== null) {
			throw new Error(
				"chat-session: a turn is already in flight on this session. " +
					"Await the previous runTurn before calling again, or call " +
					"abortCurrent() first.",
			);
		}

		// Slash commands first — short-circuit before any model call.
		const parsed = parseSlashCommand(message);
		const slashOutcome = applySlashCommand(parsed);
		if (slashOutcome) {
			return slashOutcome;
		}

		// `parsed.type === "passthrough"` — `parsed.message` is the user's
		// actual message (with leading whitespace preserved by the parser).
		// Defensive fallback to the original input in case a future slash
		// type lands here without an outcome.
		const messageForModel =
			parsed.type === "passthrough" ? parsed.message : message;

		// Per-turn AbortController. Linking the caller's signal lets a TUI
		// or a WebSocket disconnect propagate without us owning the signal.
		const turnAbort = new AbortController();
		currentAbort = turnAbort;
		const onCallerAbort = (): void => turnAbort.abort();
		opts.signal?.addEventListener("abort", onCallerAbort);

		try {
			const turnArgs: RunSingleTurnArgs = {
				agentId: args.agentId,
				provider,
				modelId,
				thinkingLevel,
				message: messageForModel,
				sessionKey,
				cwd,
				workspaceDir: args.workspaceDir,
				signal: turnAbort.signal,
			};
			const result = await runSingleTurn(turnArgs);
			return {
				kind: "model",
				result,
				rewrittenFromSlash: messageForModel !== message,
			};
		} catch (err: unknown) {
			if (turnAbort.signal.aborted) {
				const reason = (turnAbort.signal as { reason?: unknown }).reason;
				return {
					kind: "aborted",
					reason: typeof reason === "string" ? reason : (reason as Error)?.message ?? "aborted",
				};
			}
			throw err;
		} finally {
			opts.signal?.removeEventListener("abort", onCallerAbort);
			if (currentAbort === turnAbort) currentAbort = null;
		}
	}

	function applySlashCommand(parsed: SlashCommandResult): TurnOutcome | null {
		switch (parsed.type) {
			case "model":
				provider = parsed.provider;
				modelId = parsed.modelId;
				return {
					kind: "slash",
					command: "model",
					detail: `switched to ${parsed.provider}/${parsed.modelId} — active on the next turn`,
					carryMessage: null,
				};
			case "thinking":
				thinkingLevel = parsed.level as ChatThinkingLevel;
				return {
					kind: "slash",
					command: "thinking",
					detail: `level set to '${parsed.level}' — active on the next turn`,
					carryMessage: null,
				};
			case "reset":
				// Session reset is a transcript-level operation. We can't drop
				// the JSONL from inside the chat-session abstraction without
				// re-plumbing — caller (CLI / TUI / gateway) owns that. We just
				// tell the caller a /reset was requested.
				return {
					kind: "slash",
					command: "reset",
					detail: "reset requested — caller should drop the session JSONL and re-open",
					carryMessage: null,
				};
			case "help":
				return {
					kind: "slash",
					command: "help",
					detail: "help requested — caller should print the slash-command list",
					carryMessage: null,
				};
			case "error":
				return {
					kind: "slash",
					command: "error",
					detail: parsed.message,
					carryMessage: null,
				};
			default:
				return null;
		}
	}

	return {
		get agentId() {
			return args.agentId;
		},
		get sessionKey() {
			return sessionKey;
		},
		get cwd() {
			return cwd;
		},
		get provider() {
			return provider;
		},
		get modelId() {
			return modelId;
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		runTurn,
		setModel(p, m) {
			provider = p;
			modelId = m;
		},
		setThinkingLevel(level) {
			thinkingLevel = level;
		},
		abortCurrent(reason) {
			currentAbort?.abort(reason);
		},
	};
}
