/**
 * Self-review loop — Brigade's continual-learning "self-learning" review pass:
 * after a cadence of turns, a SCOPED background review distils the conversation
 * into durable memory (and later, skills), non-blocking, attributed,
 * autonomously — the LLM decides WHAT to learn under guidance; the loop runs
 * itself.
 *
 * This module is the model-agnostic CORE: the cadence trigger, the review prompt
 * (what to capture + what NOT to), and the apply-step (proposed writes → the
 * memory store, attributed). The {@link Reviewer} seam is where the live agent
 * loop plugs a scoped sub-agent (whitelisted to memory tools) over the transcript
 * — a forked-reviewer pattern. Kept here so it's unit-testable
 * without a model + a running loop. Pairs with the feedback loop
 * (`FactStore.applyFeedback`) + the event/telemetry track (`MemoryEventLog`).
 */

import { MEMORY_SEGMENTS } from "./records.js";
import type { MemoryRecord, MemoryRecordOrigin, MemorySegment, NewFact } from "./records.js";
import { confineUntrustedSegment } from "./write-gate.js";

/** Cadence trigger — fire a review every `interval` turns (default cadence ~10).
 *  `0` disables. The caller owns the per-session counter; this is the pure rule. */
export function shouldReview(turnsSinceReview: number, interval: number): boolean {
	return interval > 0 && turnsSinceReview >= interval;
}

/**
 * The review prompt: "be ACTIVE, capture corrections/preferences/lessons; DON'T
 * capture env-failures / negative tool claims / transient errors / one-offs" —
 * the filters are what stop a review loop from poisoning the
 * store with noise (and they compose with the write-gate).
 */
export const SELF_REVIEW_PROMPT = [
	"Review the conversation above and update long-term memory. Be ACTIVE but PRECISE —",
	"most useful sessions yield at least one durable fact, but noise is worse than nothing.",
	"",
	"CAPTURE (durable, reusable across future sessions):",
	"  • Who the user is — stable identity, role, environment, tools they use.",
	"  • Preferences + expectations about how you should behave (style, format, verbosity),",
	"    ESPECIALLY corrections (\"stop doing X\", \"always do Y\", \"I prefer Z\").",
	"  • Decisions, conventions, and durable project facts.",
	"  • Lessons: a non-obvious technique, workaround, or pitfall worth not relearning.",
	"",
	"DO NOT CAPTURE (noise that hardens into bad behavior):",
	"  • Environment-dependent failures (a missing binary, an unconfigured key).",
	"  • Negative claims about tools (\"X is broken\") — they ossify into refusals.",
	"  • Transient errors that resolved within the session.",
	"  • One-off task narratives with no reusable class.",
	"",
	"Output only the durable facts, each with its segment. If nothing qualifies, output nothing.",
].join("\n");

/** A fact the review proposes to persist (shape-compatible with `NewFact`). */
export interface ReviewProposedFact {
	content: string;
	segment: MemorySegment;
	importance?: number;
	supersedes?: string[];
}

export interface ReviewProposal {
	facts: ReviewProposedFact[];
}

/**
 * The reviewer seam — runs the {@link SELF_REVIEW_PROMPT} over a transcript and
 * returns proposed facts. In production this is a SCOPED sub-agent (whitelisted
 * to memory tools, fresh session, the parent's model) — the forked-reviewer.
 * Injected so the loop is testable without a model.
 */
export type Reviewer = (prompt: string, transcript: string) => Promise<ReviewProposal>;

/** Minimal write surface the apply-step needs (a `FactStore` satisfies it). */
export interface ReviewWriteStore {
	write(fact: NewFact): MemoryRecord;
}

export interface SelfReviewResult {
	written: number;
	records: MemoryRecord[];
	/** Compact action summary to surface back (e.g. "💾 Self-improvement review: …"). */
	summary: string;
}

/**
 * Run one self-review pass: review the transcript → persist the proposed facts,
 * ATTRIBUTED as `extraction` (distilled-from-the-turn, not the owner speaking —
 * so the write-gate trusts them ~0.9 but they're distinguishable from direct
 * owner statements) and scoped to `origin`. Best-effort: a reviewer error yields
 * an empty (no-op) result rather than throwing into the turn.
 */
export async function runSelfReview(args: {
	transcript: string;
	reviewer: Reviewer;
	store: ReviewWriteStore;
	origin?: MemoryRecordOrigin;
}): Promise<SelfReviewResult> {
	let proposal: ReviewProposal;
	try {
		proposal = await args.reviewer(SELF_REVIEW_PROMPT, args.transcript);
	} catch {
		return { written: 0, records: [], summary: "self-review: skipped (reviewer error)" };
	}
	const records: MemoryRecord[] = [];
	// Best-effort: a MALFORMED reviewer return (missing / non-array `facts`) is a
	// no-op, not a crash. The for-of would otherwise throw OUTSIDE the try above
	// (the try only wraps the reviewer CALL) and reject into the turn.
	const proposed = Array.isArray(proposal?.facts) ? proposal.facts : [];
	for (const f of proposed) {
		// Type-guard the ELEMENT too, not just the container: the reviewer return is
		// model-influenceable, so a malformed element (`null`, `{content: 123}`) must
		// be skipped — `f.content.trim()` runs OUTSIDE the per-write try below, so a
		// non-string content would otherwise throw into the turn (breaks best-effort).
		// Also reject an off-vocabulary/missing segment: filesystem mode would
		// persist it but the non-optional convex Segment validator rejects it —
		// skip in BOTH modes (parity) rather than write an fs-only record.
		if (
			!f ||
			typeof f.content !== "string" ||
			!f.content.trim() ||
			!MEMORY_SEGMENTS.includes(f.segment as MemorySegment)
		)
			continue;
		// The reviewer distils an attacker-influenceable transcript, so its writes
		// are the write-gate's CONFINED `extraction` tier: route a protected segment
		// to descriptive `knowledge`, and DROP any proposed supersede (an untrusted
		// distillation may not overwrite an owner fact — it lands as a fresh evidence
		// fact instead of being gate-rejected and silently lost).
		const segment = confineUntrustedSegment("extraction", f.segment as MemorySegment);
		try {
			records.push(
				args.store.write({
					content: f.content,
					segment,
					sourceType: "extraction",
					...(f.importance !== undefined ? { importance: f.importance } : {}),
					...(args.origin !== undefined ? { createdBy: args.origin } : {}),
				}),
			);
		} catch {
			// Best-effort: protected segments are pre-confined and supersedes dropped,
			// so the gate no longer throws here — only an unexpected fs/embedder error.
		}
	}
	return {
		written: records.length,
		records,
		summary: records.length
			? `self-review: learned ${records.length} fact(s) — ${records.map((r) => r.segment).join(", ")}`
			: "self-review: nothing durable to learn",
	};
}
