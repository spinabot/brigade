import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, type MemoryRecordOrigin } from "./records.js";
import { type Reviewer, runSelfReview, shouldReview } from "./self-review.js";

/**
 * The self-review loop (Brigade's "self-learning" background review): a
 * cadence-triggered pass that distils the conversation into
 * durable, attributed memory — the loop runs itself; the reviewer (a scoped
 * sub-agent in production, a fake here) decides what to learn.
 */

describe("self-review cadence trigger", () => {
	it("fires every `interval` turns; 0 disables", () => {
		assert.equal(shouldReview(9, 10), false);
		assert.equal(shouldReview(10, 10), true);
		assert.equal(shouldReview(11, 10), true);
		assert.equal(shouldReview(100, 0), false, "interval 0 disables");
	});
});

describe("self-review loop — distils a transcript into attributed memory", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-review-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	const owner: MemoryRecordOrigin = { kind: "owner" };

	it("persists proposed facts as extraction-confined evidence, scoped to origin", async () => {
		const store = new FactStore(dir);
		const reviewer: Reviewer = async () => ({
			facts: [
				{ content: "The user prefers concise, no-fluff answers", segment: "preference" },
				{ content: "The user is on Windows with PowerShell", segment: "identity" },
			],
		});
		const res = await runSelfReview({ transcript: "…the conversation…", reviewer, store, origin: owner });
		assert.equal(res.written, 2);
		const all = store.list();
		assert.equal(all.length, 2);
		assert.ok(all.every((r) => r.sourceType === "extraction"), "attributed as extraction (review-distilled)");
		assert.ok(all.every((r) => r.createdBy?.kind === "owner"), "scoped to the turn's origin");
		// SECURITY: the reviewer distils an attacker-influenceable transcript, so its
		// proposed `preference`/`identity` are CONFINED to descriptive `knowledge` —
		// laundered content can't pose as the operator's authoritative self-model.
		assert.ok(all.every((r) => r.segment === "knowledge"), "protected segments confined to knowledge evidence");
		assert.equal(res.summary, "self-review: learned 2 fact(s) — knowledge, knowledge");
	});

	it("is best-effort: a reviewer error is a no-op, never throws into the turn", async () => {
		const store = new FactStore(dir);
		const reviewer: Reviewer = async () => {
			throw new Error("model down");
		};
		const res = await runSelfReview({ transcript: "x", reviewer, store });
		assert.equal(res.written, 0);
		assert.equal(store.list().length, 0);
		assert.equal(res.summary, "self-review: skipped (reviewer error)");
	});

	it("is best-effort on a MALFORMED reviewer return (facts missing/non-array) — no-op, never throws", async () => {
		const store = new FactStore(dir);
		// The apply-loop runs OUTSIDE the reviewer try/catch, so a return like `{}`
		// would `for...of undefined` → throw into the turn without the guard.
		const malformed = [
			// bad CONTAINER (caught by the Array.isArray guard)
			{}, { facts: undefined }, { facts: null }, { facts: "nope" },
			// bad ELEMENTS in a valid array (caught by the per-element type-guard) —
			// a non-string `content` would otherwise throw f.content.trim() into the turn
			{ facts: [null] }, { facts: [undefined] }, { facts: [42] }, { facts: [{}] },
			{ facts: [{ content: 123, segment: "knowledge" }] },
			{ facts: [{ content: {}, segment: "knowledge" }] },
		];
		for (const bad of malformed) {
			const reviewer: Reviewer = async () => bad as unknown as Awaited<ReturnType<Reviewer>>;
			const res = await runSelfReview({ transcript: "x", reviewer, store });
			assert.equal(res.written, 0, `malformed return ${JSON.stringify(bad)} → no writes`);
		}
		assert.equal(store.list().length, 0, "nothing persisted from any malformed return");
	});

	it("skips empty proposals → 'nothing durable to learn'", async () => {
		const store = new FactStore(dir);
		const reviewer: Reviewer = async () => ({ facts: [{ content: "   ", segment: "knowledge" }] });
		const res = await runSelfReview({ transcript: "x", reviewer, store });
		assert.equal(res.written, 0);
		assert.equal(res.summary, "self-review: nothing durable to learn");
	});

	it("a review-distilled fact is recallable next turn (the loop's payoff)", async () => {
		const store = new FactStore(dir);
		const reviewer: Reviewer = async () => ({
			facts: [{ content: "The user's deploy command is npm run release", segment: "knowledge" }],
		});
		await runSelfReview({ transcript: "x", reviewer, store, origin: owner });
		const hit = store.recall("how do I deploy", { origin: owner, markAccessed: false })[0];
		assert.equal(hit?.content, "The user's deploy command is npm run release", "learned fact surfaces in later recall");
		// …but stays origin-scoped: the same query under a DIFFERENT origin gets no hit.
		const otherOrigin: MemoryRecordOrigin = { kind: "channel", channelId: "whatsapp", conversationId: "c1", sessionKey: "s1" };
		const crossHit = store.recall("how do I deploy", { origin: otherOrigin, markAccessed: false });
		assert.equal(crossHit.length, 0, "review-distilled facts stay scoped to their origin");
	});
});
