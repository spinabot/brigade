/**
 * Build a Brigade agent session — a thin wrapper over Pi's `createAgentSession`.
 *
 * What this gives the agent:
 *   - The 5 Pi built-in coding tools (read, bash, edit, write, grep)
 *   - A system prompt set on agent.state.systemPrompt (layered .md assembly comes in Primitive #2)
 *   - File-backed AuthStorage + ModelRegistry rooted at ~/.brigade
 *   - Pi's auto-resuming session manager (continueRecent on cwd)
 *   - Brigade's loop hooks wired in: beforeToolCall, afterToolCall, transformContext
 *     (each is a no-op by default; callers pass overrides via BuildAgentOptions)
 *
 * The hooks are deliberately wired here — not in the TUI layer — so any future
 * channel (web, mobile, ACP) gets the same loop semantics. Tests in
 * tests/loop/ exercise them directly via session.agent.{beforeToolCall,...}.
 */

import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentMessage,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@mariozechner/pi-agent-core";
import {
	createAgentSession,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Model, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

import { BRIGADE_DIR, getBrigadeSessionDir } from "./config.js";
// All four formerly lived as parallel implementations under src/core/. They
// were merged into the canonical Brigade-native modules in src/agents/ on
// 2026-05-08 so each concern has a single source of truth. The lifted v0.1.3
// agent loop reads them from there now via aliases that preserve the call
// sites below (classifyError → classifyErrorDetailed under the hood, since
// agents/'s `classifyError` returns a string while this loop wants the
// richer ClassifiedError object).
import { classifyErrorDetailed as classifyError, decideRetry } from "../agents/error-classifier.js";
import { pickInitialThinkingLevel } from "./model-caps.js";
import {
	decodeXaiToolCallArgs,
	downgradeOpenAIResponsesReasoningPairs,
	dropAnthropicThinkingBlocks,
	isMistralModel,
	isOpenAIResponsesModel,
	isXaiModel,
	sanitizeMistralToolCallIds,
	wrapStreamFnWithPayloadMutations,
} from "../agents/payload-mutators.js";
import { smartCompactToolResults } from "../agents/smart-compaction.js";
import { refreshSessionSystemPrompt, seedDefaultPrompts } from "./system-prompt.js";
import { emitAgentEvent } from "../agents/agent-event-bus.js";
import { DEFAULT_AGENT_ID } from "../config/paths.js";
import { randomUUID } from "node:crypto";

/**
 * Inspect a tool call BEFORE it executes. Return `{ block: true, reason }` to
 * refuse the call — Pi will synthesize an error tool result so the model knows
 * the request was denied. Return `undefined` to allow the call through.
 *
 * Receives Pi's run-scoped AbortSignal — long-running policy checks should
 * honor it.
 */
export type BeforeToolCallHook = (
	ctx: BeforeToolCallContext,
	signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;

/**
 * Inspect a tool result AFTER it executes. Return an `AfterToolCallResult` to
 * override `content` / `details` / `isError` / `terminate` (omitted fields keep
 * their original values; no deep merge). Return `undefined` to leave the
 * result unchanged.
 *
 * Useful for output redaction, audit metadata injection, or capturing tool
 * results into an external log.
 */
export type AfterToolCallHook = (
	ctx: AfterToolCallContext,
	signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;

/**
 * Mutate the message context BEFORE each LLM call. Return the new message
 * list. Useful for: pruning old turns, just-in-time memory recall, PII scrubbing.
 *
 * Pi calls this on every iteration of the loop, so the hook should be cheap
 * (or memoize per-turn).
 */
export type TransformContextHook = (
	messages: AgentMessage[],
	signal?: AbortSignal,
) => Promise<AgentMessage[]> | AgentMessage[];

export interface BuildAgentOptions {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model<any>;
	cwd: string;
	/** Optional override for Brigade's default system prompt. */
	systemPrompt?: string;
	/**
	 * Optional pre-built SessionManager. When omitted, buildAgent calls
	 * `SessionManager.continueRecent(cwd)` for chat-style auto-resume. Pass
	 * this when the caller drives session lookup by key (e.g. `brigade agent
	 * --session-key foo`) instead of by cwd.
	 *
	 * This is the integration point that lets the single-turn CLI path and
	 * the multi-turn TUI path share ONE runtime — matches OpenClaw's
	 * `agentCommandInternal` shape where both surfaces route through the
	 * same agent factory.
	 */
	sessionManager?: SessionManager;
	/** Loop hooks. All optional. See type docs above. */
	beforeToolCall?: BeforeToolCallHook;
	afterToolCall?: AfterToolCallHook;
	transformContext?: TransformContextHook;
}

export async function buildAgent(opts: BuildAgentOptions): Promise<AgentSession> {
	// Seed default prompt files into ~/.brigade/workspace/ on first boot.
	// Idempotent: existing files are never overwritten (users own their edits).
	// Failure is non-fatal — the assembler falls back to embedded defaults
	// when files are missing or unreadable.
	await seedDefaultPrompts();

	// Session resolution. Caller can supply a pre-built SessionManager (used
	// by the single-turn CLI path that resolves by session-key); when absent,
	// auto-resume the most recent conversation in this cwd or start fresh.
	// Either way, transcripts live under ~/.brigade/sessions/ — Pi's default
	// would be ~/.pi/agent/sessions/ but we want Brigade self-contained.
	const sessionManager =
		opts.sessionManager ??
		SessionManager.continueRecent(opts.cwd, getBrigadeSessionDir(opts.cwd));

	// Per-model SAFE default. See model-caps.ts for the rationale (reasoning-only
	// models like Gemini 2.5 Pro reject "off"; non-reasoning models ignore it).
	// Users can change this at runtime via /thinking <level>.
	const thinkingLevel = pickInitialThinkingLevel(opts.model);

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir: BRIGADE_DIR, // ~/.brigade — isolates Brigade from any other Pi install
		authStorage: opts.authStorage,
		modelRegistry: opts.modelRegistry,
		model: opts.model,
		sessionManager,
		thinkingLevel,
		// tools: omitted → Pi enables read/bash/edit/write by default; grep is available too
	});

	// Bridge Pi's per-session event stream into Brigade's process-wide
	// agent-event bus. Same forwarder pattern as `runSingleTurnLocked`
	// (Runtime B): every Pi `AgentSessionEvent` is wrapped as a `pi`
	// bus event and broadcast to all `onAgentEvent` listeners.
	//
	// Why here: chat.ts (TUI) and server.ts (gateway) both call buildAgent
	// for the long-lived session. Without this bridge they have to call
	// `session.subscribe(...)` directly, which couples them to Pi's API
	// shape and prevents bus subscribers from observing Runtime-A turns.
	//
	// `runId` is generated per buildAgent invocation rather than per turn
	// because Runtime A holds a single Pi session for the full chat
	// lifecycle — every event in that lifetime correlates to the same run
	// from the bus's perspective. (Runtime B generates per-turn runIds.)
	// Phase 4b/4c will replace this with a per-turn runId once chat.ts /
	// server.ts migrate to the long-lived openChatSession variant.
	const buildAgentRunId = randomUUID();
	const subscribableSession = session as unknown as {
		subscribe?: (cb: (piEvent: unknown) => void) => () => void;
		__brigadeBusBridgeAttached?: boolean;
	};
	// Guard against double-attach. `buildAgent` is called once per
	// gateway / TUI process under normal operation, but tests construct
	// multiple sessions in one process and supervisor restarts can re-
	// invoke it. Without this flag, every re-call wires another Pi → bus
	// forwarder onto the same session object, so each Pi event fires N
	// duplicate emissions (polluting the bus and any subscribers'
	// counters). The flag lives on the session so it's GC'd with it.
	if (
		typeof subscribableSession.subscribe === "function" &&
		!subscribableSession.__brigadeBusBridgeAttached
	) {
		subscribableSession.__brigadeBusBridgeAttached = true;
		subscribableSession.subscribe((piEvent) => {
			emitAgentEvent({
				type: "pi",
				runId: buildAgentRunId,
				agentId: DEFAULT_AGENT_ID,
				sessionId: (session as { id?: string }).id ?? "",
				piEvent,
			});
		});
	}

	// Inject Brigade's system prompt — assembled from the layered .md files
	// at ~/.brigade/workspace/ (with per-cwd override). The assembler embeds
	// the BRIGADE_CACHE_BOUNDARY marker between static prefix and dynamic
	// suffix; the payload mutator (wrapStreamFnWithPayloadMutations below)
	// splits at the marker and applies Anthropic cache_control.
	//
	// Caller can override via opts.systemPrompt — used by tests and any
	// future callers that want a fully custom prompt.
	if (opts.systemPrompt) {
		session.agent.state.systemPrompt = opts.systemPrompt;
	} else {
		await refreshSessionSystemPrompt(session as any, opts.cwd);
	}

	// Wire loop hooks. These are public properties on the Pi Agent class; setting
	// them after createAgentSession() is the supported integration point —
	// `createAgentSession` itself doesn't surface them as options, so we layer
	// them here. The hook setters wrap the user's hook in a guard so we never
	// pass a thrown error from a hook back to the loop unhandled.
	//
	// beforeToolCall composition (always-on first, user-supplied second):
	//   1. unknownToolGuard — refuse hallucinated names, whitespace-wrapped
	//      names, and empty-args calls to tools that need params. Built fresh
	//      per session against the actual tool registry so adding/removing
	//      tools at runtime stays consistent.
	//   2. user's hook — additional policy (approval workflows, audit, etc.)
	//      Runs ONLY if the guard passed (no point asking the user to approve
	//      a call that's about to be refused for being malformed).
	const allowedToolNames = (session.agent.state.tools ?? [])
		.map((t: { name?: string }) => t.name ?? "")
		.filter((n: string) => n.length > 0);
	const guardHook = makeUnknownToolGuard(allowedToolNames);
	const userBeforeHook = opts.beforeToolCall;
	session.agent.beforeToolCall = async (ctx, signal) => {
		// xAI / Grok occasionally HTML-encodes string values inside tool args
		// (`&quot;` instead of `"`, `&#x2F;` instead of `/`). Pi parses the JSON
		// fine but the args object then has unusable strings. Decode in-place
		// BEFORE the guard runs and BEFORE the tool executes — once decoded
		// the rest of the loop sees clean values.
		//
		// Mutates ctx.toolCall.arguments in place, which is what Pi reads when
		// dispatching to the tool. Provider check is live (session.model) so a
		// mid-session /model into / out of xAI takes effect immediately.
		if (isXaiModel(session.model)) {
			const tc = (ctx as any)?.toolCall;
			if (tc && tc.arguments && typeof tc.arguments === "object") {
				tc.arguments = decodeXaiToolCallArgs(tc.arguments);
			}
		}

		// Guard next. If it returns a block, short-circuit — the user's hook
		// never sees malformed calls.
		try {
			const guardResult = await guardHook(ctx, signal);
			if (guardResult && (guardResult as any).block) return guardResult;
		} catch (err) {
			return {
				block: true,
				reason: `tool guard error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		if (!userBeforeHook) return undefined;
		try {
			return await userBeforeHook(ctx, signal);
		} catch (err) {
			// A throwing hook is treated as "block" — safer than letting an
			// unrelated bug allow a destructive tool through.
			return {
				block: true,
				reason: `policy hook error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	};
	if (opts.afterToolCall) {
		const userHook = opts.afterToolCall;
		session.agent.afterToolCall = async (ctx, signal) => {
			try {
				return await userHook(ctx, signal);
			} catch {
				// A throwing post-hook should not invalidate a successful tool
				// call. Leave the result unchanged.
				return undefined;
			}
		};
	}
	// Transform context: defensive cleanup ALWAYS runs first, then provider-
	// conditional quirks fire, then the user-supplied hook (if any) gets the
	// final pass.
	//
	// Always-on cleanup, in order:
	//   1. repairToolPairing — synthesize tool_result for any orphaned tool_use.
	//      Without this, Anthropic returns 400 on resumed sessions where a
	//      tool was interrupted.
	//   2. sanitizeMessages — strip lone UTF-16 surrogates from text/thinking
	//      content blocks. Without this, providers occasionally crash JSON
	//      encoding when the model emits invalid Unicode.
	//   3. smartCompactToolResults — two-tier (oversized + aggregate) shrinking
	//      with head+tail preservation when the result contains errors.
	//      Replaces the older blind truncateOversizedToolResults; scales
	//      limits to the active model's context window.
	//
	// Provider-conditional quirks (each gated on the active model):
	//   4. dropAnthropicThinkingBlocks — Anthropic rejects re-sent thinking
	//      blocks from earlier turns. Strip from all but the latest assistant
	//      message. (Anthropic, Bedrock-Claude, Vertex-Claude, OpenRouter→Claude)
	//   5. sanitizeMistralToolCallIds — Mistral requires [a-zA-Z0-9]{9} IDs;
	//      rewrite Pi's longer IDs deterministically and keep tool_use ↔
	//      tool_result mapping consistent.
	//   6. downgradeOpenAIResponsesReasoningPairs — OpenAI Responses API
	//      rejects messages with both reasoning and toolCall; drop reasoning
	//      so the call survives.
	const userTransform = opts.transformContext;
	session.agent.transformContext = async (messages, signal) => {
		const repaired = repairToolPairing(messages);
		const sanitized = sanitizeMessages(repaired);
		const compacted = smartCompactToolResults(sanitized, {
			contextWindowTokens: session.model?.contextWindow,
		}).messages;

		// Read session.model LIVE so a /model switch mid-session picks up the
		// right behavior on the very next LLM call (no rebuild needed).
		const m = session.model;

		// Always-on: strip stale thinking blocks from history. The function
		// preserves the LATEST assistant's thinking ONLY when the active
		// model is Anthropic-flavored (cache continuity); for any other
		// active model — including a fresh /model switch into Gemini — it
		// strips every thinking block so the new provider doesn't reject
		// `{type:"thinking"}` as an unknown content type.
		let cleaned = dropAnthropicThinkingBlocks(compacted, m);

		// Provider-conditional quirks.
		if (isMistralModel(m)) cleaned = sanitizeMistralToolCallIds(cleaned);
		if (isOpenAIResponsesModel(m)) cleaned = downgradeOpenAIResponsesReasoningPairs(cleaned);

		if (!userTransform) return cleaned;
		try {
			return await userTransform(cleaned, signal);
		} catch {
			// User hook threw → fall back to the cleaned messages so the loop
			// stays valid. Never let a context transformer break the request.
			return cleaned;
		}
	};

	// Auto-compaction ON by default. Pi monitors context usage and compacts
	// before the model rejects with "context too long" — without this, long
	// sessions silently fail. Users can opt out per-session via setter.
	session.setAutoCompactionEnabled(true);

	// Wrap session.agent.streamFn to inject provider-specific payload mutations
	// inside Pi's `onPayload` hook. Three quirks handled:
	//   - OpenRouter Anthropic prompt-cache hints (cost win on long sessions)
	//   - Google Gemini thinking-config payload reformat (Pi level → enum)
	//   - SiliconFlow / Minimax thinking-mode normalization
	//
	// Strictly additive: preserves Pi's existing auth-aware streamFn by
	// composing on top of it (the wrapper calls the original underneath).
	// Called exactly once here so mutations don't stack across re-builds.
	wrapStreamFnWithPayloadMutations(session);

	// Re-assemble the system prompt at the start of every new human turn so
	// it stays accurate over a long-lived session.
	//
	//   - Cost: ~5KB of file I/O per turn (a few ms — negligible vs the
	//     500-5000ms LLM call). Re-read happens BEFORE the first LLM call
	//     of the turn, so the new prompt is in effect when Pi reads it.
	//   - Hot reload: edits to ~/.brigade/workspace/<layer>.md take effect on
	//     the next user turn, no restart needed.
	//   - Per-model guidance refresh: a /model swap changes which family
	//     guidance fires (OpenAI vs Google vs none for Anthropic). The
	//     swap is always followed by a new user prompt → turn_start fires
	//     → re-assembly picks up the new family guidance naturally. No
	//     need to subscribe to model_select separately (Pi doesn't expose
	//     that on the session event stream anyway).
	//
	// Fire-and-forget: errors are swallowed (a stale prompt is better than
	// a crashed turn). Re-assembly is idempotent — same inputs produce
	// same bytes — so cache stability is preserved when nothing changed.
	if (!opts.systemPrompt) {
		const cwdForRefresh = opts.cwd;
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "turn_start") {
				void refreshSessionSystemPrompt(session as any, cwdForRefresh).catch(() => {
					/* swallow — stale prompt > crashed turn */
				});
			}
		});
	}

	return session;
}

/* ─────────────────────────── model fallback ─────────────────────────── */

export interface FallbackEntry {
	model: Model<any>;
	/** Optional human label (e.g. "OpenAI · gpt-5"); shown to user on switch. */
	label?: string;
}

export interface RunPromptOptions {
	/**
	 * Ordered list of fallback models. After the primary model returns an
	 * unrecoverable error (Pi's own auto-retry budget exhausted), Brigade
	 * tries each fallback in order. The chain stops at the first success
	 * OR when the list is exhausted (whichever comes first).
	 *
	 * Pass `[]` or omit for no fallback (behaves like a plain `session.prompt()`).
	 */
	fallbacks?: FallbackEntry[];
	/** Called just before each fallback attempt. Receives the error reason and which model is about to be tried. */
	onFallback?: (reason: string, next: FallbackEntry, attempt: number) => void;
	/** Called if every fallback in the chain also errors. */
	onFallbackExhausted?: (lastReason: string) => void;
	/**
	 * Per-attempt prompt wrapper. The default is `() => session.prompt(message)`.
	 * Wrap with `runWithStreamTimeout` to enforce a fresh stale-stream timeout
	 * per fallback attempt — without this, a hung primary would burn the timeout
	 * for the whole chain instead of just for itself.
	 */
	wrapAttempt?: (promptFn: () => Promise<void>) => Promise<void>;
	/**
	 * Per-error-class retry policy. Pi already retries transient errors (rate
	 * limit, 5xx, network) internally; this is the OUTER ring that fires when
	 * Pi gave up but the error class suggests another shot is worth it.
	 *
	 * Defaults to ONE retry per model with a backoff derived from the error
	 * class (rate-limit honors Retry-After, 5xx exponential, network quick).
	 * Set `maxRetriesPerModel: 0` to disable and behave like the old loop
	 * (advance to next fallback on first error).
	 */
	retryPolicy?: {
		/** Hard cap on retries on the SAME model after Pi's internal retries. Default 1. */
		maxRetriesPerModel?: number;
		/** Cap on a single retry's delay (e.g. ignore a 600s Retry-After). Default 60_000. */
		maxDelayMs?: number;
		/**
		 * Called when a context-overflow error fires and we're about to compact
		 * the session before retrying. Lets the caller surface "context full,
		 * compacting…" to the user.
		 */
		onCompactBeforeRetry?: () => void;
		/** Called just before each in-class retry sleep. */
		onRetry?: (info: { class: string; attempt: number; delayMs: number; reason: string }) => void;
	};
}

/**
 * Wrap `session.prompt()` with a multi-level model-fallback chain. After each
 * `prompt()` resolves, we inspect the last assistant message:
 *
 *   - `stopReason === "error"` AND fallbacks remain → swap to next model + re-prompt
 *   - success OR no more fallbacks → return
 *
 * Why a Brigade wrapper instead of a Pi feature: Pi's loop is intentionally
 * single-model per session — cross-model fallback is application policy,
 * not loop primitive. Implementing it here means any future channel (web,
 * mobile, ACP) gets the same fallback behavior.
 *
 * On total failure (every fallback errors), the original model is restored
 * so the next user turn doesn't run on a failing model. The final error
 * message is surfaced via `onFallbackExhausted`.
 *
 * Pi's stream-stale-detection is layered on TOP via `runWithStreamTimeout`
 * (see below) — they compose: `runWithFallback(runWithStreamTimeout(...))`.
 */
export async function runWithFallback(
	session: AgentSession,
	userMessage: string,
	options: RunPromptOptions = {},
): Promise<void> {
	const original = session.model;
	const fallbacks = options.fallbacks ?? [];
	const wrap = options.wrapAttempt ?? ((fn) => fn());
	const policy = options.retryPolicy ?? {};
	const maxRetriesPerModel = policy.maxRetriesPerModel ?? 1;
	const maxDelayMs = policy.maxDelayMs ?? 60_000;

	// Track restore-to-original state so we never call setModel(original)
	// twice — once defensive in the catch branch, once defensive at the end.
	// Doubling means two extra round-trips to the auth resolver and (worse)
	// can race a successful re-attempt during the second restore.
	//
	// `swappedToFallback` gates the restore: if we never left the primary
	// (in-model retry succeeded, or no fallbacks were configured), restoring
	// is a wasteful no-op that costs an auth round-trip. Only call setModel
	// when there's actually something to undo.
	let restoredOriginal = false;
	let swappedToFallback = false;
	const restoreOriginalOnce = async (): Promise<void> => {
		if (restoredOriginal || !original || !swappedToFallback) return;
		restoredOriginal = true;
		try {
			await session.setModel(original);
		} catch {
			/* best-effort — never let restore failures mask the actual error */
		}
	};

	/**
	 * Run a single model's attempt with per-error-class in-model retries.
	 * Returns when either (a) the attempt succeeds (no errorMessage on the
	 * last assistant) or (b) the error is not retryable on the same model
	 * (caller should advance to the next fallback) or (c) the user aborted
	 * (session.abort() raises agent.signal which we observe between retries).
	 *
	 * `attemptOnSameModel` is called once normally + up to maxRetriesPerModel
	 * times if the classifier says the same model deserves another shot.
	 */
	const attemptOnSameModel = async (label: string): Promise<void> => {
		await wrap(() => session.prompt(userMessage));

		// In-model retry loop. Pi already exhausted its internal retries by the
		// time we get here; this is Brigade's outer ring that handles classes
		// Pi doesn't bother with (e.g. context overflow → compact → retry).
		for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
			const errMsg = lastAssistantErrorMessage(session);
			if (!errMsg) return; // succeeded on the previous attempt — done with this model

			const classified = classifyError(errMsg);

			// Special case: context overflow → compact, then retry SAME model.
			// No point falling through to a fallback since the conversation
			// length is the same regardless of which model gets it next.
			if (classified.class === "context_overflow") {
				policy.onCompactBeforeRetry?.();
				try {
					await session.compact();
				} catch {
					// Compaction itself failed — give up on same-model recovery
					// and let the caller advance to fallback.
					return;
				}
				policy.onRetry?.({ class: classified.class, attempt, delayMs: 0, reason: "compacted, retrying" });
				await wrap(() => session.prompt(userMessage));
				continue;
			}

			const decision = decideRetry(classified, { attempt, maxAttempts: maxRetriesPerModel, maxDelayMs });
			if (!decision.retry) return; // not retryable on same model — caller advances

			policy.onRetry?.({
				class: classified.class,
				attempt,
				delayMs: decision.delayMs,
				reason: `${label}: ${decision.reason}`,
			});
			// Abortable sleep — without this a user Ctrl+C during a 5-minute
			// rate-limit wait would hang for the full 5 minutes (the sleep
			// timer ignores signals; only the next session.prompt call would
			// observe the abort). Pi exposes the active turn's AbortSignal as
			// `session.agent.signal`; if it's already aborted at the top of
			// the loop OR fires DURING the sleep, we exit early.
			if (decision.delayMs > 0) {
				const aborted = await sleepAbortable(decision.delayMs, session.agent.signal);
				if (aborted) return; // user pressed Ctrl+C during wait — bail out
			}
			// The user could have aborted DURING the sleep on a non-abortable
			// path (e.g., decision.delayMs === 0 path): re-check before the
			// next prompt so we don't fire one more attempt against an aborted
			// session.
			if (session.agent.signal?.aborted) return;
			await wrap(() => session.prompt(userMessage));
		}
	};

	// Initial attempt on the primary (with in-model retries).
	await attemptOnSameModel("primary");

	if (fallbacks.length === 0) return;

	for (let i = 0; i < fallbacks.length; i++) {
		const errMsg = lastAssistantErrorMessage(session);
		if (!errMsg) {
			// Success. If we got here AFTER swapping to a fallback (i > 0
			// implies we already swapped at least once), restore the user's
			// chosen primary so the NEXT user turn doesn't transparently run
			// on the fallback. Without this restore, a one-time hiccup on the
			// primary permanently demotes the session.
			await restoreOriginalOnce();
			return;
		}

		const next = fallbacks[i]!;
		options.onFallback?.(errMsg, next, i + 1);

		try {
			await session.setModel(next.model);
			swappedToFallback = true;
			await attemptOnSameModel(`fallback ${i + 1}/${fallbacks.length}`);
		} catch (err) {
			// A throw here means the swap-and-retry itself blew up (e.g. auth
			// resolution failed for the fallback model). Treat it like an error
			// message — try the next fallback if any remain. Loop continues.
			const reason = err instanceof Error ? err.message : String(err);
			if (i === fallbacks.length - 1) {
				options.onFallbackExhausted?.(reason);
				await restoreOriginalOnce();
				throw err;
			}
			continue;
		}
	}

	// Loop drained. Inspect final state once.
	const finalErr = lastAssistantErrorMessage(session);
	if (finalErr) {
		options.onFallbackExhausted?.(finalErr);
	}
	// Restore primary either way: success on a fallback OR exhaustion. The
	// next user turn must start on the model the user actually picked.
	await restoreOriginalOnce();
}

/**
 * Sleep for `ms` but bail early if the supplied AbortSignal fires. Returns
 * `true` if the abort fired (caller should treat as "user cancelled"),
 * `false` if the timer ran to completion normally.
 *
 * Without this helper, a `setTimeout` ignores AbortSignal entirely — a
 * 5-minute rate-limit retry sleep would block Ctrl+C for the full 5 minutes
 * since Pi's session.abort() flips agent.signal but the timer stays armed.
 *
 * If the signal is ALREADY aborted on entry, returns true synchronously
 * (microtask) — no wasted timer.
 */
async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return true;
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function lastAssistantErrorMessage(session: AgentSession): string | undefined {
	const last = [...session.messages].reverse().find((m: any) => m.role === "assistant");
	if (!last) return undefined;
	const stop = (last as any).stopReason;
	const errMsg = (last as any).errorMessage as string | undefined;
	if (stop !== "error" || !errMsg) return undefined;
	return errMsg;
}

/* ─────────────────────────── stream timeout watcher ─────────────────────────── */

/**
 * Race `session.prompt()` against a stale-stream timeout. If no event fires
 * for `idleMs` consecutively, abort the run and reject the prompt.
 *
 * Why this exists: Pi's underlying stream relies on the provider SDK's
 * own timeout (Anthropic SDK: 10 min; OpenAI SDK: 10 min). On a half-open
 * TCP socket, that means the user stares at "thinking…" for 10 minutes,
 * which is unacceptable. A ~90s stale-stream detector at the loop layer
 * is the standard mitigation.
 *
 * The watcher subscribes to ALL agent events. Any event resets the idle
 * timer. If the timer expires, we call `session.abort()` and reject —
 * the catch in chat.ts surfaces a clean message.
 *
 * Composes with `runWithFallback` — wrap one inside the other to get
 * timeout + fallback on the same prompt.
 */
export interface StreamTimeoutOptions {
	/** Idle threshold in ms. Default 60_000 (60s). */
	idleMs?: number;
	/** Called when the timeout fires (just before abort). */
	onTimeout?: (idleMs: number) => void;
}

export async function runWithStreamTimeout(
	session: AgentSession,
	body: () => Promise<void>,
	options: StreamTimeoutOptions = {},
): Promise<void> {
	const idleMs = options.idleMs ?? 60_000;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	let cleanedUp = false;

	const arm = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			if (cleanedUp) return; // race: don't fire after cleanup
			timedOut = true;
			options.onTimeout?.(idleMs);
			void session.abort().catch(() => {});
		}, idleMs);
	};

	const rawUnsubscribe = session.subscribe(() => {
		// Any event from the loop = liveness signal. Reset the timer.
		if (!timedOut && !cleanedUp) arm();
	});

	// Idempotent cleanup — safe to call multiple times. Pi's unsub may or may
	// not tolerate double-call; we don't depend on that.
	const cleanup = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		if (timer) clearTimeout(timer);
		try {
			rawUnsubscribe();
		} catch {
			/* defensive — never let unsub throws mask body errors */
		}
	};

	arm(); // start the clock

	try {
		await body();
	} finally {
		cleanup();
	}

	if (timedOut) {
		throw new Error(`No response from model for ${Math.round(idleMs / 1000)}s — connection may be stalled.`);
	}
}

/* ─────────────────────────── length continuation ─────────────────────────── */

export interface LengthContinuationOptions {
	/** Called just before the auto-continuation prompt fires. */
	onContinue?: () => void;
}

/**
 * Run a prompt body. If the model stops with `stopReason: "length"` (hit
 * max_tokens), automatically prompt with a continuation request so the
 * reply isn't left truncated mid-sentence.
 *
 * Capped at ONE continuation per call by control flow — we never recurse.
 * If the continuation ALSO truncates, the user sees both pieces and can
 * ask "continue" manually for a third pass.
 *
 * Without this, long responses on models with tight max_tokens caps
 * look broken (cut off mid-sentence with no follow-through).
 */
export async function runWithLengthContinuation(
	session: AgentSession,
	body: () => Promise<void>,
	options: LengthContinuationOptions = {},
): Promise<void> {
	await body();

	const last = [...session.messages].reverse().find((m: any) => m.role === "assistant");
	if (!last) return;
	const stopReason = (last as any).stopReason;
	if (stopReason !== "length") return;

	options.onContinue?.();

	// Defensive try/catch: if the continuation prompt itself errors (rate
	// limit during the continuation, network blip, model unavailable), don't
	// throw upstream — the user already has the truncated half of the reply,
	// and an error here would mask the actual partial result. Outer wrappers
	// can decide whether to surface the error.
	try {
		await session.prompt(
			"Please continue your previous reply from exactly where you left off — do not repeat the prior text, just continue.",
		);
	} catch {
		/* swallow — partial reply is better than nothing */
	}
}

/* ─────────────────────────── sensitive stop-reason classifier ─────────────────────────── */

export interface SensitiveStopReason {
	/** Short kind tag — useful for telemetry. */
	kind: "refusal" | "content_filter" | "policy" | "unknown_sensitive";
	/** User-facing explanation. Already friendly — caller can display as-is. */
	userMessage: string;
}

/**
 * Recognize stop reasons that indicate the model declined to produce a
 * normal reply (refusal, content filter, policy block). Returns null for
 * normal/expected stop reasons like `stop`, `end_turn`, `toolUse`, and
 * for stop reasons already handled elsewhere (`error`, `aborted`).
 *
 * Why this exists: when Anthropic returns `stop_reason: refusal` (etc),
 * the assistant message has no text content. Without this classifier the
 * UI just shows nothing and the user is confused. With it, we display a
 * clear message like "The model declined this request."
 *
 * Expressed as a post-hoc classifier on the final assistant message rather
 * than a stream wrapper — the outcome is the same and the integration
 * point is simpler.
 */
export function classifySensitiveStopReason(
	message: { stopReason?: string } | undefined | null,
): SensitiveStopReason | null {
	if (!message) return null;
	const reason = message.stopReason;
	if (!reason || typeof reason !== "string") return null;

	const r = reason.toLowerCase();

	// "Refusal" — model declined to respond. Anthropic's most common case.
	if (r === "refusal" || r === "refused") {
		return {
			kind: "refusal",
			userMessage:
				"The model declined this request. Try rephrasing or asking a different question.",
		};
	}

	// Content-policy variants across providers.
	if (
		r === "content_filter" ||
		r === "content_filtered" ||
		r === "safety" ||
		r === "policy_violation"
	) {
		return {
			kind: "content_filter",
			userMessage:
				"The model's content filter blocked this response. Try rephrasing the request.",
		};
	}

	// Unknown but suspicious — anything that ends in "_filter", "_block", "policy", "safety".
	if (/(_filter|_block|policy|safety|prohibited)/i.test(r)) {
		return {
			kind: "unknown_sensitive",
			userMessage: `The model stopped with an unrecognized policy reason ("${reason}"). Try rephrasing.`,
		};
	}

	// Normal stop reasons + already-handled cases — not our concern.
	return null;
}

/* ─────────────────────────── tool-call cleanup ─────────────────────────── */

/**
 * Trim whitespace from a tool-call name. Some providers occasionally emit
 * `"  read  "` instead of `"read"`; without this Pi treats the call as an
 * unknown tool and the model has to retry from a confusing failure.
 *
 * Defensive on non-string input — returns "" so the unknown-tool guard
 * downstream catches it cleanly.
 *
 * Expressed as a pure function callable from any layer.
 */
export function trimToolCallName(name: unknown): string {
	if (typeof name !== "string") return "";
	return name.trim();
}

/**
 * Tools that DON'T need parameters. If the model calls one of these with
 * empty args, that's normal — don't flag.
 *
 * This is a small allowlist of common parameter-less tools across our
 * provider catalog. If you add a new parameter-less tool, add it here too.
 */
const PARAMETERLESS_TOOLS = new Set([
	"ping",
	"status",
	"list_models",
	"list-models",
	"version",
	"help",
	"now",
]);

/**
 * Heuristic detector for malformed tool arguments. Returns true when the
 * call looks suspiciously empty (likely a streaming JSON parse failure)
 * for a tool that typically requires arguments.
 *
 * Pure approximation — true repair would need stream-level intervention
 * (a streamFn wrapper that rewrites the args mid-parse). In v1 we use
 * this to surface a clean error to the model so it self-corrects.
 *
 * Caller should refuse the call (via beforeToolCall hook) and tell the
 * model to retry with proper arguments.
 */
export function isLikelyMalformedArgs(args: unknown, toolName: string): boolean {
	// Non-object args are always suspicious
	if (args === null || args === undefined) return true;
	if (typeof args !== "object") return true;

	// Empty object — only suspicious for tools that typically take params
	const keys = Object.keys(args);
	if (keys.length === 0) {
		const normalized = (toolName ?? "").toLowerCase();
		return !PARAMETERLESS_TOOLS.has(normalized);
	}

	return false;
}

/* ─────────────────────────── unknown-tool guard ─────────────────────────── */

/**
 * Build a `beforeToolCall` hook that blocks problematic tool calls before
 * they execute. Three failure modes are caught here:
 *
 *   1. UNKNOWN TOOL — model hallucinated a name not in the allowlist.
 *      Returns a refusal listing the real tools so it can self-correct.
 *
 *   2. WHITESPACE-WRAPPED NAME — provider emitted "  read  " instead of
 *      "read". Pi treats this as unknown. We compare trimmed name against
 *      the allowlist and refuse if untrimmed name still doesn't match a
 *      legitimate tool, with a clear "name had whitespace" hint.
 *
 *   3. MALFORMED ARGS — empty args for a tool that needs params (xAI
 *      sometimes emits broken JSON; Pi parses what it can, leaves us
 *      with {}). Refuse with explicit instruction to retry with proper
 *      arguments.
 *
 * Expressed as a single `beforeToolCall` hook — the hook fires AFTER Pi
 * parses but BEFORE the tool would execute, which is the right point to
 * refuse and re-prompt.
 *
 * Wire via buildAgent's `beforeToolCall` option:
 *   buildAgent({ ..., beforeToolCall: makeUnknownToolGuard(toolNames) })
 */
export function makeUnknownToolGuard(allowedToolNames: string[]): BeforeToolCallHook {
	const allowed = new Set(allowedToolNames);
	return (ctx) => {
		// Pi's BeforeToolCallContext exposes the tool call. Field shape varies
		// slightly across Pi versions — the most stable accessors are `name`
		// and `arguments`/`args`.
		const rawName = (ctx as any)?.toolCall?.name ?? (ctx as any)?.name ?? "";
		const name = trimToolCallName(rawName);
		const args =
			(ctx as any)?.toolCall?.arguments ??
			(ctx as any)?.args ??
			(ctx as any)?.arguments ??
			{};

		// CHECK ORDER MATTERS:
		//   1. Unknown tool first — if the name is wrong, the model has to
		//      retry with a different tool entirely; arg validation is moot.
		//   2. Malformed args second — name was right but call was empty;
		//      model needs to retry with proper params for the SAME tool.
		// Without this ordering, a call with both bad name AND empty args
		// would only learn about the name issue on the first retry, then
		// fail again on the args.

		// Unknown tool — refuse with the available list.
		if (!name || !allowed.has(name)) {
			const list = [...allowed].sort().join(", ") || "(no tools enabled)";
			const hint =
				rawName !== name
					? ` (note: your tool name had extra whitespace — use exactly "${name}" without spaces)`
					: "";
			return {
				block: true,
				reason: `Tool "${rawName}" is not available${hint}. Available tools: ${list}. Please use one of those instead.`,
			};
		}

		// Malformed args — refuse and ask for retry with proper params.
		// (Only reachable when the name is valid; bad name short-circuits above.)
		if (isLikelyMalformedArgs(args, name)) {
			return {
				block: true,
				reason: `Tool "${name}" was called with empty/missing arguments. Please retry with the required parameters.`,
			};
		}

		return undefined;
	};
}

/* ─────────────────────────── post-compaction tool-result truncation ─────────────────────────── */

export interface TruncateOptions {
	/** Max characters per text content block. Default 8_000 (~2k tokens). */
	maxCharsPerBlock?: number;
}

/**
 * Walk the message history and truncate text content inside tool-result
 * messages that exceed `maxCharsPerBlock`. Replaces the tail with a
 * `[…N chars truncated]` marker so the model knows the result was cut.
 *
 * Why: Pi's compaction summarizes by turn, not by per-block size. A tool
 * call that returned 500KB of stdout (e.g., `cat large.log`) keeps that
 * 500KB in history until the whole turn is compacted away. Even AFTER
 * compaction, a recent-but-not-current bloated tool result can re-overflow
 * context on the very next request.
 *
 * Pure function. Returns a new array; original is not mutated. Image
 * content blocks pass through untouched (images are stored as base64,
 * which counts as text but truncating would corrupt them).
 */
export function truncateOversizedToolResults(
	messages: AgentMessage[],
	options: TruncateOptions = {},
): AgentMessage[] {
	// Clamp max to a positive integer. Bad input (negative, NaN, Infinity)
	// breaks slice arithmetic silently — slice(0, -50) truncates from the
	// END instead, slice(0, NaN) returns "". Defensive defaults.
	const requested = options.maxCharsPerBlock ?? 8_000;
	const max = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 8_000;
	if (!Array.isArray(messages)) return messages;

	return messages.map((msg) => {
		const m = msg as any;
		if (m?.role !== "toolResult" || !Array.isArray(m.content)) return msg;
		const newContent = m.content.map((block: any) => {
			if (!block || block.type !== "text" || typeof block.text !== "string") return block;
			if (block.text.length <= max) return block;
			const cut = block.text.length - max;
			return {
				...block,
				text: `${block.text.slice(0, max)}\n\n[…${cut} chars truncated]`,
			};
		});
		return { ...m, content: newContent };
	});
}

/* ─────────────────────────── surrogate UTF-16 sanitization ─────────────────────────── */

/**
 * Strip lone UTF-16 surrogate code units from a string. Valid surrogate
 * PAIRS (e.g. emoji like 😀 = U+D83D U+DE00) are preserved.
 *
 * Why: some providers occasionally emit lone surrogates in streamed
 * output. These are invalid Unicode — `JSON.stringify` will throw, and
 * downstream APIs reject the request entirely. Stripping them is safer
 * than crashing the loop.
 *
 * Caveat: assumes `text` is a complete string, not a slice that splits
 * an emoji across boundaries. Pi's content blocks are always whole strings
 * by the time we see them (assistant messages aren't split mid-codepoint),
 * so this is safe in our context.
 *
 * Strips lone UTF-16 surrogate halves before they reach the JSON encoder.
 */
export function sanitizeSurrogates(text: string): string {
	if (!text) return text;
	// High surrogate (D800-DBFF) NOT followed by a low surrogate (DC00-DFFF) → strip
	// Low surrogate NOT preceded by a high surrogate → strip
	// We do this in two passes to keep the regex simple and correct.
	return text
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
		.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Walk an AgentMessage[] and sanitize lone surrogates from every text /
 * thinking content block. Returns a new array (input is not mutated).
 *
 * Wired via `transformContext` so every LLM call sees clean UTF-16.
 */
export function sanitizeMessages(messages: AgentMessage[]): AgentMessage[] {
	if (!Array.isArray(messages)) return messages;
	return messages.map((msg) => {
		const m = msg as any;
		if (!m || !Array.isArray(m.content)) return msg;
		const cleanedContent = m.content.map((block: any) => {
			if (!block) return block;
			if (block.type === "text" && typeof block.text === "string") {
				return { ...block, text: sanitizeSurrogates(block.text) };
			}
			if (block.type === "thinking" && typeof block.thinking === "string") {
				return { ...block, thinking: sanitizeSurrogates(block.thinking) };
			}
			return block;
		});
		return { ...m, content: cleanedContent };
	});
}

/* ─────────────────────────── tool-call/result pairing repair ─────────────────────────── */

/**
 * Walk the message transcript and synthesize an error tool_result for any
 * orphaned tool_use block (i.e., assistant emitted a tool call but no
 * corresponding tool_result message follows it before the next assistant
 * turn).
 *
 * Why this matters: Anthropic (and several OpenAI-compatible providers)
 * reject the request with `400: tool_use ids must have corresponding
 * tool_result` if the history violates the pairing invariant. Brigade's
 * session can drift into this state after:
 *   - process crash mid-tool-execution
 *   - SIGINT during a tool call
 *   - extension-emitted custom messages that interleave between tool_use
 *     and tool_result
 *
 * Repairs instead of rejecting so resumed sessions don't dead-end.
 *
 * Wired via `buildAgent`'s `transformContext` hook so it runs on every LLM
 * call automatically.
 */
export function repairToolPairing(messages: AgentMessage[]): AgentMessage[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;

	// Pass 1 — collect every tool_use id (with its name) and every
	// fulfilled tool_result toolCallId. Pi's `ToolResultMessage` is at
	// the MESSAGE level (role: "toolResult", toolCallId on the message),
	// not as a content block, so we check `msg.toolCallId` directly.
	const toolUseInfo = new Map<string, string>(); // id → toolName
	const fulfilledIds = new Set<string>();
	for (const msg of messages) {
		const m = msg as any;
		if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
			fulfilledIds.add(m.toolCallId);
			continue;
		}
		const content = m?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "toolCall" && typeof block.id === "string") {
				toolUseInfo.set(block.id, typeof block.name === "string" ? block.name : "unknown");
			}
		}
	}

	// Find orphans — tool_use with no matching tool_result.
	const orphans = [...toolUseInfo.entries()].filter(([id]) => !fulfilledIds.has(id));
	if (orphans.length === 0) return messages;

	// Pass 2 — for each orphan, splice a synthetic toolResult message
	// immediately after the assistant message that contained the tool_use.
	// One ToolResultMessage PER orphan (Pi's shape; no batching).
	const orphanIdSet = new Set(orphans.map(([id]) => id));
	const repaired: AgentMessage[] = [];
	for (const msg of messages) {
		repaired.push(msg);
		const content = (msg as any)?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (
				block?.type === "toolCall" &&
				typeof block.id === "string" &&
				orphanIdSet.has(block.id)
			) {
				// Use the proper ToolResultMessage shape from pi-ai. Compiler
				// catches missing fields here — no `as any` to swallow shape
				// drift if Pi changes the type.
				const synthetic: ToolResultMessage = {
					role: "toolResult",
					toolCallId: block.id,
					toolName: toolUseInfo.get(block.id) ?? "unknown",
					content: [
						{
							type: "text",
							text: "(tool result missing — likely interrupted; did not complete)",
						},
					],
					isError: true,
					timestamp: Date.now(),
				};
				repaired.push(synthetic as AgentMessage);
			}
		}
	}

	return repaired;
}

/* ─────────────────────────── content-quality retries ─────────────────────────── */

/**
 * Detected content-quality issue with the final assistant message:
 *   - "empty"           — no content blocks at all
 *   - "reasoning-only"  — only thinking blocks, no visible text
 *   - "planning-only"   — text says "I'll do X" / "let me Y" but NO tool was
 *                         invoked, despite tools being available
 *   - null              — message looks fine
 *
 * These classes are used as gates for steered retries — without them,
 * models that "promise but don't act" or "think but don't answer"
 * silently waste turns.
 */
type ContentQualityIssue = "empty" | "reasoning-only" | "planning-only" | null;

/**
 * Common phrasings that indicate the model is DESCRIBING an action it intends
 * to take, rather than taking it. Conservative — false positives here cost a
 * single retry, which is preferable to false negatives (silent failures).
 *
 * All patterns are anchored to start-of-string OR start-of-sentence to avoid
 * matching the same phrase inside a quoted user message (e.g. assistant
 * echoing the user's "I'll create a script" in the middle of an answer).
 * `(?:^|[.!?\n]\s+)` is the sentence-start anchor.
 */
const SENTENCE_START = "(?:^|[.!?\\n]\\s+)";
const PLANNING_PHRASES = [
	new RegExp(`${SENTENCE_START}i'?ll (?:create|write|build|make|generate|set up|implement|fix|update|add|do|run|execute|launch|deploy|install|configure)`, "i"),
	new RegExp(`${SENTENCE_START}let me (?:create|write|build|make|generate|implement|fix|update|add|do|run|execute|launch|deploy|install|configure)`, "i"),
	new RegExp(`${SENTENCE_START}(?:going to|i will|i shall) (?:create|write|build|make|generate|implement)`, "i"),
	new RegExp(`${SENTENCE_START}here'?s (?:what|how) i'?ll`, "i"),
];

function detectContentIssue(message: any, hadTools: boolean): ContentQualityIssue {
	if (!message || message.role !== "assistant") return null;
	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return "empty";

	const textBlocks = content.filter(
		(b: any) => b && b.type === "text" && typeof b.text === "string",
	);
	const thinkingBlocks = content.filter((b: any) => b && b.type === "thinking");
	const toolCallBlocks = content.filter((b: any) => b && b.type === "toolCall");

	const totalText = textBlocks.map((b: any) => b.text).join("").trim();

	// Reasoning-only: had thinking blocks, no text, no tool call.
	if (thinkingBlocks.length > 0 && totalText.length === 0 && toolCallBlocks.length === 0) {
		return "reasoning-only";
	}

	// Empty: zero text AND zero tool calls (and not reasoning-only above).
	if (totalText.length === 0 && toolCallBlocks.length === 0) return "empty";

	// Planning-only: only matters when tools were available — otherwise the
	// model has no choice. We check that the text matches a planning phrase
	// AND no tool was invoked in this final message.
	if (hadTools && toolCallBlocks.length === 0 && totalText.length > 0) {
		if (PLANNING_PHRASES.some((re) => re.test(totalText))) return "planning-only";
	}

	return null;
}

const STEER_FOR: Record<NonNullable<ContentQualityIssue>, string> = {
	empty:
		"You returned no visible reply. Provide your full visible answer to the user's last message now, in plain text.",
	"reasoning-only":
		"You produced reasoning but no visible answer. Provide your final visible answer to the user now, in plain text outside of any reasoning blocks.",
	"planning-only":
		"You described an action you would take, but you did not actually invoke the tool to do it. Take the action now using the appropriate tool — do not just describe it again.",
};

export interface ContentQualityRetryOptions {
	/** Called when a retry is triggered, with the detected reason. */
	onRetry?: (reason: NonNullable<ContentQualityIssue>) => void;
}

/**
 * Run a prompt body. After it resolves, inspect the final assistant message
 * for low-quality content (empty / reasoning-only / planning-only). If
 * detected, queue a steering message and re-run ONCE — the cap is hardcoded
 * at one retry by control flow (we never recurse).
 *
 * The cap matters because this wrapper composes with other retry layers
 * (thinkingFallback adds 1, model fallback adds 1+). Without the hard cap,
 * a single user message could trigger 4-6 prompts in pathological cases —
 * burning tokens, money, and patience.
 *
 * Each retry is a fresh `session.prompt()` so it stacks cleanly with
 * `runWithStreamTimeout` / `runWithThinkingFallback` / `runWithFallback`.
 *
 * Three failure modes are handled: planning-only (model emitted a plan
 * but no action), empty-response (no content blocks), and reasoning-only
 * (thinking blocks but no user-visible text). Each gets a tailored
 * re-prompt rather than a blind retry. We re-prompt with a steering
 * message rather than prefilling the model's reasoning — more tokens
 * but no provider-specific prefill API needed in v1.
 */
export async function runWithContentQualityRetry(
	session: AgentSession,
	body: () => Promise<void>,
	options: ContentQualityRetryOptions = {},
): Promise<void> {
	await body();

	// Snapshot session state immediately so async subscribers can't mutate
	// what we're inspecting. Race window without the snapshot: between body()
	// resolving and detectContentIssue() running, another event listener
	// (extension hook, telemetry handler) could append a message — making
	// "last assistant" be something other than what body() actually produced.
	const snapshot = [...session.messages];
	const tools = (session.agent.state as any)?.tools;
	const hadTools = Array.isArray(tools) && tools.length > 0;

	const lastAssistant = [...snapshot].reverse().find((m: any) => m.role === "assistant");
	const issue = detectContentIssue(lastAssistant, hadTools);
	if (!issue) return;

	options.onRetry?.(issue);

	// Queue the steer message as a normal user prompt — we re-prompt directly
	// here (Pi's `agent.steer` is for mid-turn injection; this fires AFTER
	// the turn ended). The steer text addresses the specific failure mode.
	await session.prompt(STEER_FOR[issue]);
}

/* ─────────────────────────── stream heartbeat ─────────────────────────── */

export interface HeartbeatOptions {
	/** Fire after this many ms of silence. Default 30_000 (30s). */
	intervalMs?: number;
	/** Receives elapsed-since-start in ms each time the heartbeat fires. */
	onHeartbeat?: (elapsedMs: number) => void;
}

/**
 * Run a prompt body and fire a heartbeat callback every `intervalMs` of
 * WALL-CLOCK time during the turn. Fires regardless of whether the model
 * is emitting events — the user wants to see "still working… 2m elapsed"
 * even when tokens are trickling in steadily.
 *
 * Critical for local Ollama where a complex generation can take 5-15
 * minutes and the user has NO other signal that we're alive.
 *
 * Distinct from `runWithStreamTimeout` (which aborts on idle silence) —
 * this is purely informational and ALWAYS fires on its interval.
 */
export async function runWithHeartbeat(
	session: AgentSession,
	body: () => Promise<void>,
	options: HeartbeatOptions = {},
): Promise<void> {
	void session; // session not currently used; kept for future per-session metrics
	const intervalMs = options.intervalMs ?? 30_000;
	const startedAt = Date.now();
	let timer: NodeJS.Timeout | undefined;
	let cleanedUp = false;

	const tick = (): void => {
		if (cleanedUp) return;
		options.onHeartbeat?.(Date.now() - startedAt);
		// Re-arm — heartbeat fires every intervalMs of wall clock.
		timer = setTimeout(tick, intervalMs);
	};

	const cleanup = (): void => {
		if (cleanedUp) return;
		cleanedUp = true;
		if (timer) clearTimeout(timer);
	};

	// First tick at intervalMs — don't fire immediately on start.
	timer = setTimeout(tick, intervalMs);

	try {
		await body();
	} finally {
		cleanup();
	}
}

/* ─────────────────────────── thinking-level fallback ─────────────────────────── */

/**
 * Detect a "model doesn't support thinking" error in the assistant message.
 * Provider error texts vary — we match on common phrasings.
 *
 * Examples that trigger:
 *   - Ollama: "qwen3-coder:30b does not support thinking"
 *   - Generic: "model X does not support thinking_config"
 *   - Some Cerebras: "thinking is not enabled for this model"
 *   - Anthropic: "model does not support extended thinking"
 *
 * If we add a new provider that uses different phrasing, just extend the regex.
 */
function looksLikeThinkingNotSupported(message: string): boolean {
	if (!message) return false;
	return /not support(?:ed)? (?:extended )?thinking|thinking is not enabled|thinking_config|does not allow thinking|requires thinking_off/i.test(
		message,
	);
}

export interface ThinkingFallbackOptions {
	/** Called just before the auto-downgrade retry. */
	onDowngrade?: (originalLevel: string, errorMessage: string) => void;
}

/**
 * Run a prompt body. If the model rejects with "doesn't support thinking",
 * silently downgrade `thinkingLevel` to "off" and retry once.
 *
 * Why this matters: our static capability inference (model.reasoning flag)
 * can be wrong. Ollama doesn't report capabilities, so we guess from the
 * model name — and "qwen3-coder" is qwen3-family but actually code-only.
 * Without this dynamic fallback, every wrong guess = a hard failure for
 * the user.
 *
 * Capped at one retry. If the second attempt also errors, that error
 * propagates normally (will be picked up by runWithFallback if composed).
 */
export async function runWithThinkingFallback(
	session: AgentSession,
	body: () => Promise<void>,
	options: ThinkingFallbackOptions = {},
): Promise<void> {
	await body();

	const errMsg = lastAssistantErrorMessage(session);
	if (!errMsg || !looksLikeThinkingNotSupported(errMsg)) return;
	// Already on off — retry would loop.
	if (session.thinkingLevel === "off") return;

	const originalLevel = session.thinkingLevel;
	options.onDowngrade?.(originalLevel, errMsg);
	session.setThinkingLevel("off");

	// Retry once with thinking off. Re-prompt with the same user message —
	// we extract from session history.
	const lastUser = [...session.messages].reverse().find((m: any) => m.role === "user");
	if (!lastUser) return;
	const text = ((lastUser as any).content as any[])
		?.filter((b: any) => b?.type === "text")
		?.map((b: any) => b.text)
		?.join("") ?? "";
	if (!text) return;

	await session.prompt(text);
}

/* ─────────────────────────── mid-turn model switch ─────────────────────────── */

/**
 * Swap the active model WHILE a turn is in flight, then re-run the user's
 * last message on the new model. Used for live-failover and exposed for
 * the `/model` slash command so the user can change models without
 * "abort, switch, retype message."
 *
 * Sequence:
 *   1. abort current run (Pi unwinds cleanly via AbortController)
 *   2. wait for `agent_end` so session state is settled
 *   3. setModel(target) — Pi validates auth, persists to session
 *   4. re-prompt with the same user message
 *
 * Returns true if the swap+re-prompt completed, false if the user wasn't
 * actually mid-turn (caller should fall back to a normal `setModel`).
 */
export async function switchModelMidTurn(
	session: AgentSession,
	target: Model<any>,
	userMessageToReplay: string,
): Promise<boolean> {
	// If no turn is active, the caller should use the normal setModel path.
	if (!session.agent.signal) return false;

	// Idempotent unsub guard — both the agent_end handler and the 5s safety
	// timeout call this. Without the guard we'd race-call Pi's raw unsub
	// twice and (depending on Pi's internals) potentially detach a stale
	// listener registered by code reading our event stream concurrently.
	let unsubbed = false;
	let resolved = false;

	const ended = new Promise<void>((resolve) => {
		const rawUnsub = session.subscribe((ev) => {
			if (ev.type === "agent_end") {
				if (!unsubbed) {
					unsubbed = true;
					try {
						rawUnsub();
					} catch {
						/* defensive */
					}
				}
				if (!resolved) {
					resolved = true;
					resolve();
				}
			}
		});
		// Safety: if abort never produces agent_end (shouldn't happen), don't
		// hang forever. Pi guarantees agent_end after abort, but defense in depth.
		setTimeout(() => {
			if (!unsubbed) {
				unsubbed = true;
				try {
					rawUnsub();
				} catch {
					/* defensive */
				}
			}
			if (!resolved) {
				resolved = true;
				resolve();
			}
		}, 5_000);
	});

	await session.abort();
	await ended;

	await session.setModel(target);
	await session.prompt(userMessageToReplay);
	return true;
}
