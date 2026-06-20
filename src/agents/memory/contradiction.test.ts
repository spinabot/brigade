import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { findContradictions } from "./contradiction.js";
import { FactStore, type MemoryRecord, type MemoryRecordOrigin, type MemorySegment } from "./records.js";

/**
 * Contradiction → bi-temporal invalidation (Tideline v2, step 15). Detect a
 * conflicting belief (deterministic candidate-find), then close the stale fact's
 * valid interval so recall drops it while history keeps it.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-contra-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const owner: MemoryRecordOrigin = { kind: "owner" };
const NOW = 1_750_000_000_000;

/** Build a record with an EXPLICIT, distinct createdAt so the newer-is-`a`
 *  assertion is order-independent (the pick resolves the newest fact as `a`
 *  regardless of input array order). */
function rec(
	id: string,
	content: string,
	createdAt: number,
	segment: MemorySegment = "identity",
	embedding?: number[],
): MemoryRecord {
	return {
		memoryId: id,
		content,
		segment,
		tier: "long",
		importance: 0.5,
		decayRate: 0.03,
		accessCount: 0,
		lastAccessedAt: createdAt,
		createdAt,
		lifecycle: "active",
		createdBy: owner,
		...(embedding !== undefined ? { embedding } : {}),
	};
}

describe("findContradictions", () => {
	it("flags same-segment facts with a shared subject but a divergent claim; the NEWER fact is `a`", () => {
		const old = rec("old", "I live in Hyderabad", NOW);
		const neu = rec("neu", "I live in Bangalore now", NOW + 1000); // strictly newer (deterministic)
		const unrelated = rec("other", "I drink black coffee", NOW, "preference");

		const cands = findContradictions([neu, old, unrelated]);
		assert.equal(cands.length, 1, "exactly one contradiction candidate (same-segment pair only; unrelated is a different segment)");
		const top = cands[0];
		const ids = new Set([top?.a.memoryId, top?.b.memoryId]);
		assert.ok(ids.has("old") && ids.has("neu"), "the two location facts are the pair");
		assert.equal(top?.a.memoryId, "neu", "the NEWER fact is `a` (the likely superseder)");
	});

	it("does NOT flag unrelated facts (different segments / low overlap)", () => {
		const store = new FactStore(dir);
		store.write({ content: "I live in Hyderabad", segment: "identity", createdBy: owner });
		store.write({ content: "the deploy command is npm run release", segment: "knowledge", createdBy: owner });
		assert.equal(findContradictions(store.list()).length, 0);
	});

	it("does NOT flag same-segment facts that share no value-bearing tokens (low overlap)", () => {
		const a = rec("a", "I live in Hyderabad", NOW + 1000);
		const b = rec("b", "my favorite color is blue", NOW);
		assert.equal(findContradictions([a, b]).length, 0, "no shared subject ⇒ overlap below minOverlap ⇒ not flagged");
	});

	// Embedding branch — the PRODUCTION path (records always carry an embedding via
	// embed-on-write). Divergence = 1 − cosine, gated by token overlap.
	it("divergence comes from the EMBEDDING when both records carry one (opposed → flagged)", () => {
		// Same subject ("live … city" → overlap ≥ minOverlap), opposed embeddings → divergence ≈ 1.
		const a = rec("a", "I live in Hyderabad city", NOW + 1000, "identity", [1, 0]);
		const b = rec("b", "I live in Bangalore city", NOW, "identity", [0, 1]);
		const cands = findContradictions([a, b]);
		assert.equal(cands.length, 1, "opposed embeddings on a shared subject → a contradiction candidate");
		assert.equal(cands[0]?.divergence, 1, "divergence is exactly 1 for opposed unit vectors [1,0] vs [0,1] (cosine=0, divergence=1-0=1)");
		assert.equal(cands[0]?.a.memoryId, "a", "the newer fact is `a`");
	});

	it("near-identical embeddings on a shared subject → NOT flagged (low divergence)", () => {
		const a = rec("a", "I live in Hyderabad city", NOW + 1000, "identity", [1, 0]);
		const b = rec("b", "I live in Bangalore city", NOW, "identity", [1, 0]); // same vector → cosine 1
		assert.equal(findContradictions([a, b]).length, 0, "cosine≈1 ⇒ divergence≈0 ⇒ below threshold");
	});

	it("mismatched embedding lengths fall back to the token symmetric-difference path", () => {
		const a = rec("a", "I live in Hyderabad city", NOW + 1000, "identity", [1, 0]);
		const b = rec("b", "I live in Bangalore city", NOW, "identity", [1, 0, 0]); // length mismatch → token fallback
		const cands = findContradictions([a, b]);
		assert.equal(cands.length, 1, "length mismatch ⇒ token symmetric-difference still flags the divergent claim");
	});
});

describe("FactStore.invalidate — bi-temporal supersede", () => {
	it("closes validTo + archives + drops from recall + keeps history + logs", () => {
		const store = new FactStore(dir);
		const old = store.write({ content: "I live in Hyderabad", segment: "identity", createdBy: owner });
		const neu = store.write({ content: "I live in Bangalore now", segment: "identity", createdBy: owner });

		const inv = store.invalidate(old.memoryId, { supersededBy: neu.memoryId, now: 1_750_000_000_000 });
		assert.ok(inv);
		assert.equal(inv.validTo, 1_750_000_000_000, "valid interval closed");
		assert.equal(inv.lifecycle, "archived", "archived (not deleted)");

		// recall now returns ONLY the current belief.
		const hits = store.recall("where do I live", { origin: owner, markAccessed: false });
		assert.ok(hits.some((h) => h.memoryId === neu.memoryId), "current fact recallable");
		assert.ok(!hits.some((h) => h.memoryId === old.memoryId), "invalidated fact dropped from recall");

		// history survives (readAll keeps the archived row).
		assert.ok(store.readAll().some((r) => r.memoryId === old.memoryId), "archived fact kept in history");

		// the superseder carries a `contradicts` link to the stale fact.
		const by = store.readAll().find((r) => r.memoryId === neu.memoryId);
		assert.ok(by?.links?.some((l) => l.kind === "contradicts" && l.target === old.memoryId), "contradicts link recorded");

		// telemetry: an `invalidated` event was logged.
		const ev = store.readEvents().filter((e) => e.kind === "invalidated");
		assert.equal(ev.length, 1);
		assert.deepEqual(ev[0]?.targets, [neu.memoryId]);
	});

	it("no-op on an unknown / already-inactive fact", () => {
		const store = new FactStore(dir);
		assert.equal(store.invalidate("nope"), undefined);
	});

	it("re-invalidating an already-archived fact is a no-op (no second event, validTo unchanged)", () => {
		const store = new FactStore(dir);
		const fact = store.write({ content: "I live in Hyderabad", segment: "identity", createdBy: owner });

		const first = store.invalidate(fact.memoryId, { now: 1_750_000_000_000 });
		assert.ok(first, "first invalidate succeeds");
		assert.equal(first.validTo, 1_750_000_000_000, "valid interval closed once");

		// Same id again — already archived → must return undefined, leave validTo
		// untouched, and NOT emit a second `invalidated` event.
		const second = store.invalidate(fact.memoryId, { now: 1_750_000_999_999 });
		assert.equal(second, undefined, "second invalidate is a no-op");

		const stored = store.readAll().find((r) => r.memoryId === fact.memoryId);
		assert.equal(stored?.validTo, 1_750_000_000_000, "validTo unchanged by the no-op");
		assert.equal(stored?.lifecycle, "archived");

		const ev = store.readEvents().filter((e) => e.kind === "invalidated" && e.memoryId === fact.memoryId);
		assert.equal(ev.length, 1, "exactly ONE invalidated event despite two calls");
	});
});
