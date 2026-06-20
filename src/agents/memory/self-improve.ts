// src/agents/memory/self-improve.ts
//
// Tideline Step 25 — self-improvement, Lane B (human-gated, reversible).
//
// Lane A (the dream) lets FACTS auto-evolve. Lane B is the BEHAVIOUR lane and is
// deliberately NOT autonomous: telemetry (the memory feedback/event log) →
// PROPOSE a change (the reviewer diff) → optional held-out EVAL gate → a human
// APPROVES → REVERSIBLE apply → REVERT if it regresses. The whole point is that
// no behaviour change ever ships without an explicit human approval, and every
// applied change can be rolled back.
//
// SAFETY: a configurable read-only set (safety constraints) can never be the
// target of a proposal — proposals against them are dropped, and apply refuses.
//
// The proposer + the held-out eval are SEAMS: a reflective, score-and-select LLM reviewer can
// generate richer diffs and score them; the v1 default proposes deterministically
// from down-vote telemetry so it runs offline.

import type { MemoryEvent } from "./event-log.js";

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied" | "reverted";

export interface ProposalDiff {
	/** What kind of behaviour this changes. */
	kind: "preference" | "skill" | "prompt";
	/** The thing being changed (a memoryId, skill name, prompt key…). */
	target: string;
	before: string;
	after: string;
}

export interface Proposal {
	id: string;
	rationale: string;
	diff: ProposalDiff;
	/** Held-out eval delta (set by `gateOnEval`); positive = improvement. */
	evalDelta?: number;
	status: ProposalStatus;
	/** Captured at apply time so the change is reversible. */
	prior?: unknown;
}

export interface ProposeOpts {
	/** Down-votes on a fact before a retraction is proposed. Default 3. */
	minDownvotes?: number;
	/** Targets that can NEVER be proposed against (safety constraints, read-only). */
	safetyConstraints?: ReadonlySet<string>;
}

/**
 * Deterministic proposer: a fact down-voted ≥ `minDownvotes` times in the
 * telemetry is proposed for retraction. Safety-constrained targets are skipped.
 * Stable order (by target) — no clock/random.
 */
export function proposeFromTelemetry(events: readonly MemoryEvent[], opts: ProposeOpts = {}): Proposal[] {
	const minDown = opts.minDownvotes ?? 3;
	const safety = opts.safetyConstraints ?? new Set<string>();
	const down = new Map<string, number>();
	for (const e of events) {
		if (e.kind === "feedback" && e.signal === "down") down.set(e.memoryId, (down.get(e.memoryId) ?? 0) + 1);
	}
	const out: Proposal[] = [];
	for (const [target, n] of [...down.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		if (n < minDown || safety.has(target)) continue;
		out.push({
			id: `prop:${target}`,
			rationale: `fact ${target} was down-voted ${n}× — propose retracting it from behaviour`,
			diff: { kind: "preference", target, before: "active", after: "retracted" },
			status: "pending",
		});
	}
	return out;
}

/** Record a held-out eval delta on a proposal (the gate the human reads before
 *  approving). Pure — returns a new proposal; never auto-approves. */
export function gateOnEval(p: Proposal, evalDelta: number): Proposal {
	return { ...p, evalDelta };
}

/** The human gate. Approve a PENDING proposal (throws otherwise). */
export function approve(p: Proposal): Proposal {
	if (p.status !== "pending") throw new Error(`can only approve a pending proposal (status: ${p.status})`);
	return { ...p, status: "approved" };
}

/** Reject a pending proposal. */
export function reject(p: Proposal): Proposal {
	if (p.status !== "pending") throw new Error(`can only reject a pending proposal (status: ${p.status})`);
	return { ...p, status: "rejected" };
}

/**
 * Apply an APPROVED proposal, reversibly. `doApply` performs the actual change
 * and RETURNS the prior state (captured on the proposal for rollback). REFUSES
 * to apply anything not explicitly approved — that refusal is the Lane-B
 * guarantee, not a convention. Also refuses a safety-constrained target.
 * Pass `appliedLedger` (a shared `Set<string>`) to enforce apply-once across
 * proposal copies (status alone is bypassable if a caller holds a pre-apply ref).
 * NOTE: `evalDelta` (set by `gateOnEval`) is informational — it is NOT enforced
 * here; the human reads it and decides whether to call `approve`.
 */
export function applyProposal(
	p: Proposal,
	doApply: (diff: ProposalDiff) => unknown,
	opts: { safetyConstraints?: ReadonlySet<string>; appliedLedger?: Set<string> } = {},
): Proposal {
	if (p.status !== "approved") {
		throw new Error(`refusing to apply an un-approved behaviour change (status: ${p.status}) — Lane B is human-gated`);
	}
	if (opts.safetyConstraints?.has(p.diff.target)) {
		throw new Error(`refusing to modify a safety constraint (${p.diff.target}) — read-only`);
	}
	// Double-apply guard by ID (status alone is bypassable — a caller can hold the
	// pre-apply object and apply it twice, corrupting the captured prior/revert
	// target). Pass an `appliedLedger` to enforce apply-once across copies.
	if (opts.appliedLedger?.has(p.id)) {
		throw new Error(`proposal ${p.id} was already applied — refusing a double-apply`);
	}
	const prior = doApply(p.diff);
	opts.appliedLedger?.add(p.id);
	return { ...p, status: "applied", prior };
}

/** Roll back an APPLIED proposal. `doRevert` restores the captured prior state. */
export function revertProposal(p: Proposal, doRevert: (prior: unknown) => void): Proposal {
	if (p.status !== "applied") throw new Error(`can only revert an applied proposal (status: ${p.status})`);
	if (p.prior === undefined) {
		throw new Error(`proposal ${p.id} has no captured prior — cannot revert (apply must return a defined prior)`);
	}
	doRevert(p.prior);
	return { ...p, status: "reverted" };
}
