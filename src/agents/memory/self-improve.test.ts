import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { MemoryEvent } from "./event-log.js";
import { applyProposal, approve, proposeFromTelemetry, revertProposal } from "./self-improve.js";

/**
 * Tideline Step 25 — Lane B self-improvement. Done-when: a behaviour change
 * requires EXPLICIT approval and can be ROLLED BACK. Plus: safety constraints
 * are read-only.
 */

function down(memoryId: string, n: number): MemoryEvent[] {
	return Array.from({ length: n }, (_, i) => ({ at: i + 1, kind: "feedback" as const, memoryId, signal: "down" as const }));
}

describe("self-improve — propose from telemetry", () => {
	it("proposes retraction for a fact down-voted ≥ threshold; ignores below-threshold", () => {
		const events = [...down("f-hot", 3), ...down("f-cold", 1)];
		const proposals = proposeFromTelemetry(events, { minDownvotes: 3 });
		assert.equal(proposals.length, 1);
		assert.equal(proposals[0]!.id, "prop:f-hot");
		assert.equal(proposals[0]!.diff.kind, "preference");
		assert.equal(proposals[0]!.diff.target, "f-hot");
		assert.equal(proposals[0]!.diff.before, "active");
		assert.equal(proposals[0]!.diff.after, "retracted");
		assert.equal(proposals[0]!.status, "pending");
	});

	it("NEVER proposes against a safety constraint (read-only)", () => {
		const events = down("safety-rule-1", 9);
		const proposals = proposeFromTelemetry(events, { minDownvotes: 3, safetyConstraints: new Set(["safety-rule-1"]) });
		assert.equal(proposals.length, 0, "a safety-constrained target is never proposed");
	});
});

describe("self-improve — human gate + reversible apply", () => {
	it("REFUSES to apply without explicit approval", () => {
		const [p] = proposeFromTelemetry(down("f1", 3), { minDownvotes: 3 });
		let applied = false;
		assert.throws(
			() => applyProposal(p!, () => {
				applied = true;
				return "prior";
			}),
			/human-gated/,
		);
		assert.equal(applied, false, "the change never ran without approval");
	});

	it("approve → apply (reversible) → revert restores the prior state", () => {
		const [p0] = proposeFromTelemetry(down("f1", 3), { minDownvotes: 3 });

		// A tiny behaviour store the apply/revert act on.
		const behaviour = { f1: "active" };

		const approved = approve(p0!);
		assert.equal(approved.status, "approved");
		assert.equal(approved.id, "prop:f1");
		const applied = applyProposal(approved, (diff) => {
			const prior = behaviour[diff.target as "f1"];
			behaviour.f1 = diff.after; // "retracted"
			return prior; // captured for rollback
		});
		assert.equal(applied.status, "applied");
		assert.equal(behaviour.f1, "retracted", "the approved change took effect");
		assert.equal(applied.prior, "active", "prior captured for rollback");

		const reverted = revertProposal(applied, (prior) => {
			behaviour.f1 = prior as string;
		});
		assert.equal(reverted.status, "reverted");
		assert.equal(behaviour.f1, "active", "rolled back to the prior state");
	});

	it("refuses to apply against a safety constraint even if (wrongly) approved", () => {
		const p = { id: "x", rationale: "", diff: { kind: "prompt" as const, target: "safety", before: "a", after: "b" }, status: "approved" as const };
		assert.throws(() => applyProposal(p, () => undefined, { safetyConstraints: new Set(["safety"]) }), /read-only/);
	});
});
