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
	return { active: false, visibility: "none", chars: 0, everReasoned: false };
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
