/**
 * Live reasoning state, per (agent, session).
 *
 * Answers the question the header could not: "is this model thinking RIGHT NOW,
 * and for how long?" Previously the only reasoning signals on the wire were
 * `thinkingLevel` and `supportsThinking` — both CAPABILITIES. Nothing said the
 * model was mid-reasoning, so a session that spent 40 seconds thinking looked
 * identical to one that had stalled.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY VISIBILITY IS PART OF THE STATE
 * ─────────────────────────────────────────────────────────────────────────
 * Reasoning is not one thing across providers, and a harness that pretends it
 * is will misrepresent at least one of them:
 *
 *   - Some stream the actual reasoning text (`raw`).
 *   - Some stream a summary the PROVIDER wrote, not the model's own chain of
 *     thought (`summary`). Showing that as "the model's thinking" is a lie.
 *   - Some redact it, leaving only an opaque payload (`redacted`).
 *   - Some reason, bill for it, and expose nothing (`hidden`). The honest UI
 *     there is "thinking…" with no text — NOT an empty thought bubble.
 *
 * So visibility travels with the state, and the renderer never has to hardcode
 * provider knowledge. A backend that reports no reasoning at all simply never
 * opens a phase, and `active` stays false.
 *
 * State is per-process and ephemeral by design: it describes what is happening
 * this instant, and a resurrected "was thinking" flag from before a restart
 * would be worse than nothing.
 */

import type { ReasoningVisibility, SessionReasoningState } from "../../protocol.js";

interface Entry {
	active: boolean;
	/**
	 * The turn ran a reasoning-capable model with thinking enabled.
	 *
	 * This is the THIRD proof that reasoning happened, and it exists because the
	 * other two can both be absent on a perfectly ordinary turn. See `end()`.
	 */
	expected: boolean;
	visibility: ReasoningVisibility;
	startedAt?: number;
	chars: number;
	tokens?: number;
	/**
	 * Has a reasoning phase EVER opened on this session?
	 *
	 * Declaring a visibility is a statement about what the backend WOULD expose,
	 * not evidence that anything was reasoned — and the gateway declares one at
	 * the start of every turn. Without this flag a model that never emits a
	 * thinking token still produced a snapshot, and the header rendered a
	 * permanent, false "Thought · provider summary".
	 */
	everReasoned: boolean;
	/** Duration of the most recently COMPLETED phase, so "Thought for 12s"
	 *  survives the phase ending (and a reconnect). */
	lastDurationMs?: number;
}

function fresh(): Entry {
	return { active: false, visibility: "none", chars: 0, everReasoned: false, expected: false };
}

export class ReasoningTracker {
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly maxSessions = 2048) {}

	private key(agentId: string, sessionKey: string): string {
		return `${agentId} ${sessionKey}`;
	}

	private touch(agentId: string, sessionKey: string): Entry {
		const k = this.key(agentId, sessionKey);
		let e = this.entries.get(k);
		if (!e) {
			e = fresh();
		} else {
			// Re-insert so iteration order is least-recently-USED. `Map.set` on an
			// existing key does not reorder it, and relying on that is how the
			// gateway's seq counters ended up evicting the busiest session first.
			this.entries.delete(k);
		}
		this.entries.set(k, e);
		while (this.entries.size > this.maxSessions) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		return e;
	}

	/**
	 * Reset for a new turn. Clears a phase left open by an aborted turn, which
	 * would otherwise strand the header on "thinking…" forever.
	 */
	beginTurn(agentId: string, sessionKey: string): void {
		const e = this.touch(agentId, sessionKey);
		e.active = false;
		e.expected = false;
		e.startedAt = undefined;
		e.chars = 0;
		e.tokens = undefined;
		e.everReasoned = false;
		e.lastDurationMs = undefined;
	}

	/** A reasoning phase opened. */
	start(agentId: string, sessionKey: string, visibility: ReasoningVisibility = "raw", now = Date.now()): void {
		const e = this.touch(agentId, sessionKey);
		e.active = true;
		e.startedAt = now;
		e.chars = 0;
		e.everReasoned = true;
		// A phase that opens tells us the model reasons; keep a more specific
		// visibility if one was already established for this session.
		if (e.visibility === "none") e.visibility = visibility;
	}

	/**
	 * Reasoning text arrived. `delta` may be empty for a backend that signals a
	 * phase without exposing text — that still counts as an active phase, which
	 * is exactly the `hidden` case.
	 */
	delta(agentId: string, sessionKey: string, delta: string | undefined, now = Date.now()): void {
		const e = this.touch(agentId, sessionKey);
		if (!e.active) {
			// Some backends emit deltas without an explicit start. Opening the phase
			// here keeps the state honest rather than dropping the reasoning.
			e.active = true;
			e.startedAt = now;
		}
		e.everReasoned = true;
		if (delta) e.chars += delta.length;
	}

	/** The reasoning phase closed — the model is answering now. */
	end(agentId: string, sessionKey: string, now = Date.now()): void {
		const e = this.touch(agentId, sessionKey);
		// Capture the duration BEFORE dropping the start time, so a completed
		// phase can still say how long it took. Without this the formatter's
		// "Thought for Ns" branch was unreachable and every finished phase
		// rendered as a bare "Thought".
		if (e.active && e.startedAt !== undefined) e.lastDurationMs = Math.max(0, now - e.startedAt);
		e.active = false;
		e.startedAt = undefined;
		// SETTLE AN UNOBSERVED-BUT-EXPECTED PHASE.
		//
		// The turn ran a reasoning model with thinking on, and yet nothing was
		// ever observed: no thinking event, no reasoning-token count. That is not
		// evidence the model skipped reasoning — it is the omitted-but-billed
		// case, which is the DEFAULT on the current Claude generation.
		//
		// Report it as `hidden` so the UI can say "not exposed by this model"
		// instead of showing an empty header that reads as "it didn't think".
		// Only ever downgrades: a phase that WAS observed keeps whatever
		// visibility the blocks proved, and a non-reasoning model never sets
		// `expected`, so it still contributes no snapshot at all.
		if (!e.everReasoned && e.expected) {
			e.visibility = "hidden";
			e.everReasoned = true;
		}
		// A SUMMARY THAT NEVER ARRIVED IS NOT A SUMMARY.
		//
		// `summary` is only ever a STATIC guess from the provider id — it says
		// what this backend is capable of returning, not what this turn actually
		// returned. When the model demonstrably reasoned (a duration, a billed
		// token count) and produced ZERO characters of reasoning text, calling
		// that "provider summary" tells the operator to look for something that
		// is not there, and quietly misreports the omitted-but-billed case as a
		// summary they simply cannot see.
		//
		// Observed emptiness outranks the static guess, so downgrade to `hidden`
		// — whose label is "not exposed by this model", which is the truth.
		// `raw` is downgraded for the same reason. `redacted` is left alone: it
		// is already a stronger, block-proven statement.
		if (e.everReasoned && e.chars === 0 && (e.visibility === "summary" || e.visibility === "raw")) {
			e.visibility = "hidden";
		}
	}

	/** Record separately-billed reasoning tokens, when a provider reports them. */
	setTokens(agentId: string, sessionKey: string, tokens: number | undefined): void {
		const e = this.touch(agentId, sessionKey);
		if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
			e.tokens = tokens;
			// A reported reasoning-token count is itself proof the model reasoned,
			// even on a backend that streams no thinking text at all (the
			// omitted-but-billed case).
			e.everReasoned = true;
		}
	}

	/**
	 * This turn is RUNNING a reasoning-capable model with thinking enabled.
	 *
	 * ─────────────────────────────────────────────────────────────────────────
	 * WHY A THIRD SIGNAL IS NEEDED
	 * ─────────────────────────────────────────────────────────────────────────
	 * `everReasoned` was provable two ways: a thinking event arrived, or the
	 * provider reported a separately-billed reasoning-token count. On the
	 * current Claude generation BOTH are absent on a normal turn:
	 *
	 *   • `display: "omitted"` is the default, and it emits NO `thinking_delta`
	 *     events at all — only an empty block with a real signature, fully
	 *     billed (see `visibility.ts` for the vendor citation).
	 *   • Pi folds reasoning tokens into `output` before Brigade sees a usage
	 *     record, so `reasoningTokens` never arrives either.
	 *
	 * With neither proof, `snapshot()` returned `undefined`, the gateway sent no
	 * reasoning state, and the TUI rendered NOTHING — which reads as "the model
	 * did not think". It thought, and the operator paid for it. That is the
	 * exact misrepresentation this whole subsystem exists to prevent.
	 *
	 * Deliberately keyed off the MODEL'S DECLARED CAPABILITY and the configured
	 * thinking level, never off a provider name. A provider allow-list would be
	 * wrong the day a new backend ships, and Brigade drives 22 of them.
	 */
	expectReasoning(agentId: string, sessionKey: string): void {
		this.touch(agentId, sessionKey).expected = true;
	}

	/** Declare what this backend exposes. Called when the turn's model is known. */
	setVisibility(agentId: string, sessionKey: string, visibility: ReasoningVisibility): void {
		this.touch(agentId, sessionKey).visibility = visibility;
	}

	/**
	 * Wire-shaped state, or `undefined` when this session has never reasoned —
	 * so a non-reasoning model adds no noise to the snapshot at all.
	 */
	snapshot(agentId: string, sessionKey: string): SessionReasoningState | undefined {
		const e = this.entries.get(this.key(agentId, sessionKey));
		if (!e) return undefined;
		// Nothing has actually been reasoned on this session, so there is nothing
		// to report — regardless of what visibility the backend DECLARED. The
		// gateway sets a visibility on every turn, so keying suppression off it
		// put a permanent false "Thought · provider summary" in the header of
		// every non-reasoning model.
		if (!e.everReasoned && !e.active) return undefined;
		return {
			active: e.active,
			visibility: e.visibility,
			...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
			...(e.chars > 0 ? { chars: e.chars } : {}),
			...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
			...(e.lastDurationMs !== undefined ? { durationMs: e.lastDurationMs } : {}),
		};
	}

	/** Drop a session's state. */
	forget(agentId: string, sessionKey: string): void {
		this.entries.delete(this.key(agentId, sessionKey));
	}

	get size(): number {
		return this.entries.size;
	}
}
