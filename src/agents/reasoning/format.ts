/**
 * The one-line reasoning summary.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE: same shape everyone knows, but it tells the truth.
 * ─────────────────────────────────────────────────────────────────────────
 * Every harness surveyed converged on `Thinking…` → `Thought for Ns`, collapsed
 * to one line. That idiom is good and this keeps it. What none of them do is
 * say WHAT you are reading — Cline, Roo, Continue, CopilotKit and Codex all
 * print the same word for Anthropic's provider-written summary, OpenAI's
 * summary, and DeepSeek's actual chain of thought. Those are different things:
 *
 *   - Anthropic never returns raw reasoning. The text is a summary written by a
 *     DIFFERENT model that the reasoning model never sees, and the billed
 *     thinking tokens deliberately do not match the tokens you can see.
 *   - On the current Claude generation the default is to omit it entirely:
 *     empty text, real signature, FULLY BILLED. An empty bubble reads as "it
 *     didn't think". It thought, and you paid for it.
 *   - A safety filter can redact it, leaving an opaque payload.
 *
 * So the suffix is not decoration. It is the difference between a UI that
 * informs and one that quietly misrepresents three of the seven providers
 * Brigade drives.
 *
 * The second unclaimed win is reasoning TOKENS. Cline, Roo and Continue each
 * normalize them from several provider shapes and then never render them
 * (Hub-only, dropped at the task layer, prop never passed). Showing them costs
 * one field and is the only number that makes hidden reasoning legible at all.
 */

import type { ReasoningVisibility, SessionReasoningState } from "../../protocol.js";

/** Compact duration: `800ms`, `12s`, `2m 10s`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = Math.round(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

/**
 * Compact token count: `842`, `4.2k`, `1.3M`.
 *
 * Rounded deliberately. `4,231` implies a precision the providers do not agree
 * on, and the operator is reading this to gauge magnitude, not to audit it.
 */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
	}
	const m = n / 1_000_000;
	return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
}

/**
 * The honesty suffix. Empty for `raw`, because there is nothing to disclaim —
 * an unqualified line correctly means "this is the model's own reasoning".
 */
export function reasoningSuffix(v: ReasoningVisibility): string {
	switch (v) {
		case "summary":
			return "provider summary";
		case "hidden":
			return "not exposed by this model";
		case "redacted":
			return "redacted by the provider";
		case "raw":
		case "none":
			return "";
	}
}

export interface ReasoningLineInput {
	state: SessionReasoningState | undefined;
	/** Wall-clock now, for the live elapsed figure. */
	now?: number;
	/** Duration of a COMPLETED phase, when the caller tracked it. */
	elapsedMs?: number;
}

/**
 * Render the collapsed one-liner, or `undefined` when there is nothing to say.
 *
 * `undefined` (rather than an empty string) for a session that never reasoned,
 * so a caller can skip the row entirely instead of painting a blank line.
 */
export function formatReasoningLine(input: ReasoningLineInput): string | undefined {
	const s = input.state;
	if (!s) return undefined;
	if (s.visibility === "none" && !s.active && !s.tokens && !s.chars) return undefined;

	const parts: string[] = [];

	if (s.active) {
		// Live. Elapsed comes from the server-stamped `startedAt`, so a client
		// that reconnects mid-phase shows the true elapsed time rather than
		// restarting from zero — the bug that makes `Thought for Ns` vanish on
		// reload in two of the harnesses surveyed.
		const now = input.now ?? Date.now();
		const elapsed = s.startedAt !== undefined ? Math.max(0, now - s.startedAt) : undefined;
		parts.push(elapsed !== undefined ? `Thinking ${formatDuration(elapsed)}…` : "Thinking…");
	} else {
		// Prefer an explicit override, else the server-stamped duration carried on
		// the state. Without the fallback this branch was unreachable and every
		// completed phase rendered as a bare "Thought".
		const elapsed = input.elapsedMs ?? s.durationMs;
		parts.push(elapsed !== undefined ? `Thought for ${formatDuration(elapsed)}` : "Thought");
	}

	// Tokens are the only signal that makes HIDDEN reasoning legible — without
	// them an omitted-but-billed phase is indistinguishable from no phase.
	// Absent must never render as `0`: that would claim a measurement we do not have.
	if (typeof s.tokens === "number" && s.tokens > 0) {
		parts.push(`${formatTokens(s.tokens)} reasoning tokens`);
	}

	const suffix = reasoningSuffix(s.visibility);
	if (suffix) parts.push(suffix);

	return parts.join(" · ");
}

/**
 * Whether a collapsed line has expandable text behind it. `hidden` and
 * `redacted` have none, so a UI must not offer an expand affordance that opens
 * an empty pane.
 */
export function hasExpandableReasoning(s: SessionReasoningState | undefined): boolean {
	if (!s) return false;
	if (s.visibility !== "raw" && s.visibility !== "summary") return false;
	return (s.chars ?? 0) > 0;
}
