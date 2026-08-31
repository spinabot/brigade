/**
 * Mid-turn compaction — pause, compact, continue, without owning the loop.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────
 * Brigade compacts BEFORE a turn. A turn that fills the window mid-flight — a
 * long tool loop reading files, a build log, a research fan-out — therefore
 * runs until the provider rejects it, and the operator pays a failed request
 * and a retry for a condition that was predictable a step earlier.
 *
 * Claude Code, Codex, Crush and DeepSeek all compact mid-turn and resume in
 * place. Verified from Claude Code's own transcripts: the last message before a
 * compaction boundary is a `tool_result`, the first after the summary is an
 * assistant message with a fresh tool call — no human prompt in between. The
 * turn was paused, compacted and continued.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SEAM
 * ─────────────────────────────────────────────────────────────────────────
 * Codex checks `should_roll_over` inside its sampling loop; Crush uses a
 * `StopWhen` predicate and re-queues. Neither seam exists in Pi from outside,
 * and racing a stream we do not own risks a corrupted turn rather than a clean
 * error.
 *
 * But `transformContext` is `async` and runs on EVERY provider request —
 * including each iteration of a mid-turn tool loop. That is the seam. Reducing
 * the messages there is indistinguishable, from the model's side, from having
 * compacted between turns: the loop continues, the next request is smaller, and
 * Pi's loop is never interrupted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE RESULT IS CACHED
 * ─────────────────────────────────────────────────────────────────────────
 * `transformContext` is a per-REQUEST view. Summarizing on every call inside a
 * tool loop would pay for a summarization per iteration and — worse — produce a
 * different prefix each time, invalidating the prompt cache on every step. So a
 * compaction is computed once, keyed by how much history it covers, and reused
 * for the rest of the turn. New messages accumulate AFTER the cached boundary
 * and stay verbatim, exactly as a between-turn compaction would leave them.
 *
 * This is the same immutable-log-plus-derived-view model the field converged
 * on: nothing is deleted, the transcript is untouched, and the reduction exists
 * only in what this request sends.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	anyDialectToolArguments,
	blockText,
	blockThinking,
	isToolCall,
	isWireToolResult,
	isWireToolUse,
	PI_ASSISTANT,
	PI_TOOL_RESULT,
} from "../pi-dialect.js";

/** A computed compaction, reusable for the remainder of a turn. */
export interface MidTurnCompaction {
	/** Model-facing summary of everything before `keptFromIndex`. */
	summary: string;
	/** Index into the ORIGINAL message array where verbatim history resumes. */
	keptFromIndex: number;
	/** Estimated tokens the original prefix occupied — for reporting. */
	replacedTokens: number;
	/** When it was computed, for diagnostics. */
	at: number;
	/**
	 * Identity of the messages either side of the cut, captured when the
	 * compaction was computed.
	 *
	 * A bare length check cannot tell "the turn grew" from "the transcript was
	 * rewritten beneath us". The pairing repair earlier in the same transform
	 * chain can drop an orphaned tool result, shifting every later index down by
	 * one — after which `slice(keptFromIndex)` cuts one message too far and can
	 * put an orphaned tool result at the head of the request, which is the 400
	 * this whole design exists to avoid.
	 */
	boundaryFingerprint: string;
}

/** Cheap identity for the messages either side of a cut. */
export function fingerprintBoundary(messages: readonly unknown[], index: number): string {
	const describe = (m: unknown): string => {
		const msg = m as { role?: unknown; content?: unknown; toolCallId?: unknown };
		const role = typeof msg?.role === "string" ? msg.role : "?";
		const id = typeof msg?.toolCallId === "string" ? msg.toolCallId : "";
		return `${role}:${id}:${messageTokens(m)}`;
	};
	const prev = index > 0 ? describe(messages[index - 1]) : "-";
	const here = index < messages.length ? describe(messages[index]) : "-";
	return `${prev}|${here}`;
}

export interface MidTurnDecision {
	/** Compact now? */
	should: boolean;
	/** Where verbatim history should resume, if compacting. */
	keptFromIndex: number;
	reason:
		| "below-threshold"
		| "too-few-messages"
		| "no-safe-boundary"
		| "not-worth-it"
		| "ready";
}

/** Fraction of the window at which a mid-turn compaction becomes worthwhile. */
export const MID_TURN_TRIGGER_RATIO = 0.85;
/** Never compact a conversation this short — there is nothing to gain. */
export const MIN_MESSAGES_TO_COMPACT = 8;
/** Recent messages always kept verbatim, whatever the pressure. */
export const MIN_KEPT_TAIL_MESSAGES = 4;
/**
 * The prefix being replaced must be at least this share of the transcript.
 *
 * A safe boundary is not automatically a WORTHWHILE one. One tool call whose
 * result arrives much later makes every index between them unsafe, and the
 * backward scan can bottom out at index 1 — so a 605-message transcript
 * "compacts" by dropping a single message, pays for a full summarization, and
 * then ADDS the summary on top. Measured: 111,202 tokens in, 112,239 out. The
 * request got bigger, `freedTokens` clamped to 0, and the result was cached for
 * the rest of the turn.
 *
 * Below this floor the honest answer is to decline: the summarization costs
 * money and seconds, and the reduction has to be worth both.
 */
export const MIN_RECLAIM_RATIO = 0.25;

/** Chars-per-token, matching every other estimator in the codebase. */
const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate for one message.
 *
 * Counts tool-call ARGUMENTS as well as text and thinking. A coding transcript
 * is dominated by tool traffic, and an estimator that skips the call side reads
 * systematically low — which makes a ratio trigger fire late, the exact bug
 * `maybeTriggerCompaction` was already fixed for once.
 */
function messageTokens(m: unknown): number {
	const content = (m as { content?: unknown })?.content;
	let chars = 0;
	if (typeof content === "string") chars = content.length;
	else if (Array.isArray(content)) {
		for (const block of content) {
			chars += blockText(block)?.length ?? 0;
			chars += blockThinking(block)?.length ?? 0;
			// A `read` of a long path list or a `write` of a whole file lives in
			// the tool arguments, not in text. Read through the BOTH-dialect
			// accessor: this function also sees transcripts that
			// `transcript-repair` synthesised in Anthropic shape, where the same
			// payload is spelled `input`. Reading only Pi's `arguments` counted
			// those as zero.
			const args = anyDialectToolArguments(block);
			if (args !== undefined) {
				try {
					chars += JSON.stringify(args)?.length ?? 0;
				} catch {
					/* circular or unserialisable — contributes nothing */
				}
			}
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateTokens(messages: readonly unknown[]): number {
	let total = 0;
	for (const m of messages) total += messageTokens(m);
	return total;
}

/** The tool-call ids an assistant message issues. */
function toolCallIds(m: unknown): string[] {
	const content = (m as { content?: unknown })?.content;
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const block of content) {
		const b = block as { id?: unknown };
		// Both dialects. Pi's in-memory shape is `toolCall`, but the pairing
		// repair earlier in this same chain accepts and SYNTHESISES Anthropic
		// `tool_use`/`tool_result` shapes — so a transcript carrying them reaches
		// here, registers zero unsafe indices, and the cut lands inside a tool
		// pair. That is two 400s in one message: an orphaned `tool_result`, and a
		// text block folded in front of it.
		if ((isToolCall(block) || isWireToolUse(block)) && typeof b.id === "string") {
			ids.push(b.id);
		}
	}
	return ids;
}

/**
 * Indices a cut must not land on, because doing so would orphan a tool result.
 *
 * A cut at `i` drops everything before `i`. If a `toolResult` at `j >= i` was
 * produced by a `toolCall` at `k < i`, that result arrives with no matching
 * call and EVERY provider rejects the request — a 400, not a quality
 * regression, and the place harnesses actually break in production.
 *
 * So for each result, the whole span between its call and itself is unsafe.
 * Computed in one pass rather than re-scanning per candidate.
 */
function unsafeBoundaries(messages: readonly unknown[]): boolean[] {
	const unsafe = new Array<boolean>(messages.length).fill(false);
	const callAt = new Map<string, number>();
	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i] as { role?: unknown; toolCallId?: unknown };
		if (m?.role === PI_ASSISTANT) {
			for (const id of toolCallIds(m)) callAt.set(id, i);
			continue;
		}
		// Pi models a tool result as its OWN message role, not as a `user` turn
		// carrying a result block (pi-ai types.d.ts: ToolResultMessage). An
		// earlier version of this file looked for `role === "user"` and so never
		// found a boundary inside a tool loop at all — the one case mid-turn
		// compaction exists for.
		// A Pi tool-result MESSAGE, or an Anthropic-dialect `user` message whose
		// content carries `tool_result` blocks.
		const blockResultIds: string[] = [];
		const rawContent = (m as { content?: unknown }).content;
		if (Array.isArray(rawContent)) {
			for (const b of rawContent) {
				if (!isWireToolResult(b)) continue;
				const id = (b as { tool_use_id?: unknown }).tool_use_id;
				if (typeof id === "string") blockResultIds.push(id);
			}
		}
		if (m?.role !== PI_TOOL_RESULT && blockResultIds.length === 0) continue;
		// A result can never lead the kept region: even with its call present,
		// landing on it means the assistant turn that owns it is only half sent.
		unsafe[i] = true;
		const ids =
			typeof m.toolCallId === "string" ? [m.toolCallId, ...blockResultIds] : blockResultIds;
		for (const id of ids) {
			const k = callAt.get(id);
			if (k === undefined) continue;
			for (let j = k + 1; j <= i && j < unsafe.length; j += 1) unsafe[j] = true;
		}
	}
	return unsafe;
}

/**
 * The latest index at or BEFORE `at` where verbatim history can safely resume.
 *
 * Backward, not forward. Searching forward from "keep the last N" can walk past
 * the end of the tail and keep a single message — contradicting
 * `MIN_KEPT_TAIL_MESSAGES` and throwing away the recent work the turn is
 * actively using. Searching backward can only keep MORE than the minimum.
 *
 * Returns -1 when no safe point exists, which the caller treats as "do not
 * compact" rather than cutting anyway.
 */
export function findSafeBoundary(messages: readonly unknown[], at: number): number {
	const unsafe = unsafeBoundaries(messages);
	const start = Math.min(at, messages.length - 1);
	// `i > 0`: a boundary of 0 replaces nothing and gains nothing.
	for (let i = start; i > 0; i -= 1) {
		if (!unsafe[i]) return i;
	}
	return -1;
}

/**
 * Should this request compact, and where should verbatim history resume?
 *
 * Deliberately conservative: below the threshold this is a pure pass-through so
 * the prompt prefix stays byte-stable and the provider's cache keeps working.
 */
export function decideMidTurnCompaction(args: {
	messages: readonly unknown[];
	contextWindowTokens: number;
	triggerRatio?: number;
}): MidTurnDecision {
	const { messages, contextWindowTokens } = args;
	const ratio = args.triggerRatio ?? MID_TURN_TRIGGER_RATIO;

	if (messages.length < MIN_MESSAGES_TO_COMPACT) {
		return { should: false, keptFromIndex: 0, reason: "too-few-messages" };
	}
	if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
		return { should: false, keptFromIndex: 0, reason: "below-threshold" };
	}
	if (estimateTokens(messages) < contextWindowTokens * ratio) {
		return { should: false, keptFromIndex: 0, reason: "below-threshold" };
	}

	// Keep a verbatim tail. Walk back from the end by message count, then snap
	// BACKWARD to the nearest safe boundary — so the cut cannot split a tool
	// pair, and the tail can only grow beyond the minimum, never shrink below it.
	const desired = Math.max(0, messages.length - MIN_KEPT_TAIL_MESSAGES);
	const boundary = findSafeBoundary(messages, desired);
	if (boundary <= 0) {
		// Nothing before the boundary to replace, or no safe point at all.
		return { should: false, keptFromIndex: 0, reason: "no-safe-boundary" };
	}
	// A safe cut is not automatically a worthwhile one — see MIN_RECLAIM_RATIO.
	const total = estimateTokens(messages);
	const replaced = estimateTokens(messages.slice(0, boundary));
	if (total > 0 && replaced / total < MIN_RECLAIM_RATIO) {
		return { should: false, keptFromIndex: 0, reason: "not-worth-it" };
	}
	return { should: true, keptFromIndex: boundary, reason: "ready" };
}

/**
 * Build the request-time view: a synthetic user message carrying the summary,
 * followed by verbatim history from `keptFromIndex`.
 *
 * The summary rides as a `user` message because that is what every harness
 * converged on — Claude Code (`isCompactSummary`), Codex, Gemini, opencode,
 * Roo, Cline and OpenHands all inject it as a user turn. Providers treat a
 * system message as instructions; the summary is context, and a model that
 * reads it as instruction starts narrating the summary back.
 */
/**
 * Marker that identifies a message as a Brigade compaction summary.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A MARKER AND NOT JUST A PROMPT INSTRUCTION
 * ─────────────────────────────────────────────────────────────────────────
 * Compacting twice means the second summarization is fed the FIRST summary as
 * ordinary history — the telephone game, where each cycle paraphrases a
 * paraphrase and detail compounds away. Aider does this on purpose (recursive,
 * depth-limited to 3); Codex re-feeds prior summaries as plain history.
 *
 * Everyone who solved it did the same thing: identify the prior summary, pull
 * it OUT of the summarizable set, and hand it to the model in a separate
 * labelled slot with "merge, don't re-summarize" — opencode
 * (`type: "compaction"`), Roo (`isSummary` flag), Cline
 * (`metadata.kind === "compaction_summary"`), Gemini CLI (`<intent_summary>`).
 *
 * Anthropic went furthest and made it STRUCTURAL: a compaction block causes the
 * API to ignore every content block before it. Not a request to the model — a
 * property of the request. That is the version worth copying, and it is what
 * `splitPriorSummary` below enforces client-side: a summary is removed from the
 * transcript that gets summarized, so it CANNOT be re-summarized, whatever the
 * model would otherwise have done.
 *
 * The marker is a content prefix rather than a typed record because Brigade's
 * summary rides inside a normal user message — it has to, since it must survive
 * Pi's own message pipeline untouched. That is weaker than a typed field: tool
 * output could in principle forge it. So it is only ever trusted for messages
 * BRIGADE ITSELF synthesised in `applyMidTurnCompaction`, and only to decide
 * what to re-summarize — never to grant the text any authority.
 */
export const COMPACTION_SUMMARY_MARKER =
	"[Earlier conversation was compacted to fit the context window.";

/** Is this message one of Brigade's own compaction summaries? */
export function isCompactionSummaryMessage(m: unknown): boolean {
	const msg = m as { role?: unknown; content?: unknown };
	if (msg?.role !== "user" || !Array.isArray(msg.content)) return false;
	const first = blockText(msg.content[0]);
	return typeof first === "string" && first.startsWith(COMPACTION_SUMMARY_MARKER);
}

/**
 * Separate any prior summary from the history that should be summarized.
 *
 * The returned `rest` NEVER contains a summary, so the next summarization
 * cannot paraphrase one. `priorSummary` is the most recent summary's text,
 * stripped of the marker header, ready to hand to the summarizer in its own
 * `<prior-summary>` slot.
 */
export function splitPriorSummary(messages: readonly unknown[]): {
	priorSummary: string | undefined;
	rest: readonly unknown[];
} {
	let priorSummary: string | undefined;
	const rest: unknown[] = [];
	for (const m of messages) {
		if (isCompactionSummaryMessage(m)) {
			const text = ((m as { content: { text: string }[] }).content[0]?.text ?? "").slice(
				COMPACTION_SUMMARY_MARKER.length,
			);
			// Later summaries supersede earlier ones — they already folded them in.
			priorSummary = text.replace(/^[^\n]*\n+/, "").trim() || undefined;
			continue;
		}
		rest.push(m);
	}
	return { priorSummary, rest };
}

export function applyMidTurnCompaction(
	messages: readonly AgentMessage[],
	compaction: MidTurnCompaction,
): AgentMessage[] {
	const kept = messages.slice(Math.min(compaction.keptFromIndex, messages.length));
	const text =
		"[Earlier conversation was compacted to fit the context window. " +
		"The full transcript is preserved and unchanged; this is a summary of what came before.]\n\n" +
		compaction.summary;

	// FOLD into the first kept message when it is already a user turn, rather
	// than prepending a second one. Anthropic merges consecutive user messages;
	// Gemini, Bedrock and Mistral conversions are stricter about alternation,
	// and Brigade drives all of them. Folding sidesteps the question entirely.
	const first = kept[0] as { role?: unknown; content?: unknown } | undefined;
	if (first?.role === "user" && Array.isArray(first.content)) {
		return [
			{ ...(first as object), content: [{ type: "text", text }, ...first.content] } as AgentMessage,
			...kept.slice(1),
		];
	}

	// `timestamp` is REQUIRED on Pi's UserMessage (pi-ai types.d.ts). Omitting it
	// made `new Date(msg.timestamp)` an Invalid Date inside Pi's own compaction
	// bookkeeping, and every `timestamp <= boundary` comparison silently false.
	const header = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: compaction.at,
	} as unknown as AgentMessage;
	return [header, ...kept];
}

/**
 * Is a cached compaction still usable for this request?
 *
 * Reusable while the messages it summarized are still a PREFIX of the current
 * array — i.e. the turn has only grown. If history was rewritten beneath it
 * (a rewind, a branch switch, a transcript repair) the cache is stale and must
 * be discarded rather than applied to a different conversation.
 */
export function isCompactionUsable(
	compaction: MidTurnCompaction | undefined,
	messages: readonly unknown[],
): compaction is MidTurnCompaction {
	if (!compaction) return false;
	if (compaction.keptFromIndex <= 0) return false;
	if (messages.length < compaction.keptFromIndex) return false;
	// The messages either side of the cut must still be the ones this compaction
	// was computed against. A length check alone cannot distinguish "the turn
	// grew" from "the array was rewritten and every index shifted".
	return fingerprintBoundary(messages, compaction.keptFromIndex) === compaction.boundaryFingerprint;
}
