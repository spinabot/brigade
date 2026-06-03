/**
 * Wave O0.7 — Sub-agent completion announce-delivery.
 *
 * Brand-scrubbed analogue of the reference codebase's
 * `src/agents/subagent-announce-delivery.ts`, scoped to Brigade's surface.
 *
 * Closes the lifecycle gap the operator hit: `sessions_spawn` returns
 * `{status:"accepted", childSessionKey, runId}` IMMEDIATELY (the child has
 * not run yet). The model used to have no way to know when the child
 * finished or what reply it produced, so it would spin on
 * `sessions_history` (returning []) or run `spawn_agent` separately to
 * get the answer — paying for two runs.
 *
 * This module solves it. When a child session completes (success OR
 * failure OR abort OR timeout), the runtime injects a SYSTEM event into
 * the PARENT session's inbox carrying:
 *
 *   - Status: completed | failed | aborted | timed-out
 *   - Child session key (so the parent can correlate with its runId)
 *   - The child's final assistant reply, truncated to ~4 KB
 *   - Duration (so the parent can tell if the child was slow)
 *
 * The parent sees this on its next turn as a system message and can
 * incorporate the child's result without polling. The existing
 * `enqueueSystemEvent` primitive (the parent's inbox) is what makes
 * delivery durable — the parent picks it up the next time it runs a
 * turn, regardless of which surface (TUI, channel, cron) triggers it.
 *
 * Idempotent: keyed off `subagent:ended:<runId>`. Two end-events for the
 * same runId (e.g. a retry storm) drop to a single inbox entry.
 */

import { createSubsystemLogger } from "../logging/subsystem-logger.js";
import { enqueueSystemEvent } from "./session-inbox.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
	SUBAGENT_ENDED_OUTCOME_ABORT,
	SUBAGENT_ENDED_OUTCOME_ERROR,
	SUBAGENT_ENDED_OUTCOME_OK,
	SUBAGENT_ENDED_OUTCOME_TIMEOUT,
	type SubagentLifecycleEndedOutcome,
} from "./subagent-lifecycle-events.js";

const log = createSubsystemLogger("agents/subagent-announce-delivery");

/**
 * Cap announce body at 4 KB so a runaway child can't blow up the parent's
 * inbox / system prompt. The reference codebase uses similar caps for
 * subagent completion text in the parent's transcript.
 */
const MAX_REPLY_BODY_CHARS = 4_000;
const TRUNCATE_MARKER = "\n[...truncated]";

/** Strip ANSI escape sequences and control characters that would mangle the parent's transcript. */
function sanitizeReplyText(raw: string | undefined | null): string {
	if (!raw) return "";
	// ANSI CSI / SGR escape sequences (ESC[<params><letter>).
	// eslint-disable-next-line no-control-regex
	const ansiPattern = new RegExp("\\x1B\\[[0-9;]*[A-Za-z]", "g");
	const stripped = raw.replace(ansiPattern, "");
	// Replace any remaining control chars except tab (0x09), LF (0x0A), CR (0x0D).
	// eslint-disable-next-line no-control-regex
	const ctrlPattern = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]", "g");
	const cleaned = stripped.replace(ctrlPattern, "");
	return cleaned.trim();
}

function truncateReplyText(text: string): string {
	if (text.length <= MAX_REPLY_BODY_CHARS) return text;
	return text.slice(0, MAX_REPLY_BODY_CHARS - TRUNCATE_MARKER.length) + TRUNCATE_MARKER;
}

function describeOutcome(outcome: SubagentLifecycleEndedOutcome): {
	verb: string;
	publicStatus: "completed" | "failed" | "aborted" | "timed-out";
} {
	if (outcome === SUBAGENT_ENDED_OUTCOME_OK) {
		return { verb: "completed", publicStatus: "completed" };
	}
	if (outcome === SUBAGENT_ENDED_OUTCOME_TIMEOUT) {
		return { verb: "timed out", publicStatus: "timed-out" };
	}
	if (outcome === SUBAGENT_ENDED_OUTCOME_ABORT) {
		return { verb: "was aborted", publicStatus: "aborted" };
	}
	if (outcome === SUBAGENT_ENDED_OUTCOME_ERROR) {
		return { verb: "failed", publicStatus: "failed" };
	}
	return { verb: "ended", publicStatus: "completed" };
}

export interface BuildSubagentCompletionAnnounceParams {
	label?: string;
	childSessionKey: string;
	runId: string;
	outcome: SubagentLifecycleEndedOutcome;
	error?: string;
	replyText?: string | null;
	durationMs?: number;
}

/**
 * Build the human-readable announce text the parent's next turn will see.
 * Pure function - no IO, deterministic given inputs. Visible to tests.
 */
export function buildSubagentCompletionAnnounceText(
	params: BuildSubagentCompletionAnnounceParams,
): string {
	const tag = params.label?.trim() ? ` "${params.label.trim()}"` : "";
	const { verb, publicStatus } = describeOutcome(params.outcome);
	const reply = truncateReplyText(sanitizeReplyText(params.replyText));
	const durationLine =
		typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
			? ` (${Math.max(0, Math.round(params.durationMs))}ms)`
			: "";
	const head = `Sub-agent${tag} ${verb}${durationLine} - childSessionKey=${params.childSessionKey} status=${publicStatus}`;
	if (publicStatus === "completed" && reply) {
		return `${head}\nFinal reply:\n${reply}`;
	}
	if (publicStatus === "failed") {
		const detail = params.error?.trim();
		const body = detail ? `Error: ${detail}` : "Error: unknown";
		const tail = reply ? `\nLast reply before failure:\n${reply}` : "";
		return `${head}\n${body}${tail}`;
	}
	if (publicStatus === "timed-out" || publicStatus === "aborted") {
		const tail = reply ? `\nLast reply before ${publicStatus}:\n${reply}` : "";
		return `${head}${tail}`;
	}
	return head;
}

export interface DeliverSubagentCompletionParams {
	parentSessionKey: string;
	childSessionKey: string;
	runId: string;
	outcome: SubagentLifecycleEndedOutcome;
	label?: string;
	error?: string;
	replyText?: string | null;
	durationMs?: number;
	/**
	 * Wave O0.8 GAP 12 — monotonic sequence number assigned at lifecycle-
	 * event emission time. Consumers that re-sort announces (e.g. a fresh
	 * inbox replay) can use this to recover the original order regardless
	 * of microtask scheduling. Optional — when absent the inbox order is
	 * the queue insertion order.
	 */
	completionSeq?: number;
}

/**
 * Deliver the completion announce into the parent's session inbox.
 *
 * Idempotent via the inbox's `contextKey: subagent:ended:<runId>` - two
 * end-events for the same runId collapse to a single entry. Returns
 * `true` when the announce was enqueued, `false` when the inbox dropped
 * it (already present, or the inbox is full).
 */
export function deliverSubagentCompletionAnnounce(
	params: DeliverSubagentCompletionParams,
): boolean {
	const parent = params.parentSessionKey?.trim();
	if (!parent || parent === "main") {
		// Operator's main session uses the TUI's lifecycle stream directly
		// (no inbox needed). Skipping here is intentional - the audit-driven
		// completion bridge would otherwise create empty inbox entries the
		// TUI never drains.
		return false;
	}
	try {
		const text = buildSubagentCompletionAnnounceText(params);
		return enqueueSystemEvent(text, {
			sessionKey: parent,
			contextKey: `subagent:ended:${params.runId}`,
			trusted: true,
		});
	} catch (err) {
		log.warn("deliverSubagentCompletionAnnounce threw", {
			runId: params.runId,
			parentSessionKey: parent,
			error: (err as Error)?.message,
		});
		return false;
	}
}

/**
 * Pull the best available reply text from a `SubagentRunRecord`.
 *
 * Tries `frozenResultText` first (the canonical capture site populated by
 * the runner / completion bridge), then `outcome.text` (sub-agent ended
 * payload), then falls back to undefined for the error case.
 */
export function pickReplyTextFromRegistryEntry(
	entry: SubagentRunRecord | undefined,
): string | undefined {
	if (!entry) return undefined;
	if (typeof entry.frozenResultText === "string" && entry.frozenResultText.trim()) {
		return entry.frozenResultText;
	}
	const outcome = entry.outcome;
	if (outcome && typeof (outcome as { text?: unknown }).text === "string") {
		const text = (outcome as { text?: string }).text;
		if (text && text.trim()) return text;
	}
	return undefined;
}
