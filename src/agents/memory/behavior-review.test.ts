import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	type BehaviorReviewer,
	makeBehaviorReviewer,
	runBehaviorReview,
	shouldReviewBehavior,
} from "./behavior-review.js";
import type { ExtractedFact } from "./extract.js";
import type { MemoryRecord, MemoryRecordOrigin, NewFact } from "./records.js";

const OWNER: MemoryRecordOrigin = { kind: "owner" };

function fakeStore() {
	const writes: NewFact[] = [];
	return {
		writes,
		write(fact: NewFact): MemoryRecord {
			writes.push(fact);
			return { memoryId: `m${writes.length}`, ...fact } as unknown as MemoryRecord;
		},
	};
}

function fakeReviewer(facts: ExtractedFact[]): BehaviorReviewer {
	return async () => facts;
}

describe("shouldReviewBehavior", () => {
	it("fires at/after the interval; 0 disables", () => {
		assert.equal(shouldReviewBehavior(5, 6), false);
		assert.equal(shouldReviewBehavior(6, 6), true);
		assert.equal(shouldReviewBehavior(100, 0), false);
	});
});

describe("runBehaviorReview", () => {
	it("writes self-model facts FIRST-CLASS as owner_message (trusted)", async () => {
		const store = fakeStore();
		const res = await runBehaviorReview({
			transcript: "USER: be concise. ASSISTANT: ok",
			reviewer: fakeReviewer([
				{ content: "Wants concise replies", segment: "preference" },
				{ content: "Stop adding emojis", segment: "correction", corrects: "added emojis" },
				{ content: "Is a backend engineer", segment: "identity" },
			]),
			store,
			origin: OWNER,
		});
		assert.equal(res.written, 3);
		assert.deepEqual(
			store.writes.map((w) => w.sourceType),
			["owner_message", "owner_message", "owner_message"],
		);
		assert.deepEqual(
			store.writes.map((w) => w.segment),
			["preference", "correction", "identity"],
		);
		assert.equal((store.writes[1]?.metadata as { corrects?: string })?.corrects, "added emojis");
		assert.deepEqual(store.writes[0]?.createdBy, OWNER);
	});

	it("skips non-self-model segments (extraction owns those)", async () => {
		const store = fakeStore();
		const res = await runBehaviorReview({
			transcript: "t",
			reviewer: fakeReviewer([
				{ content: "Uses postgres", segment: "knowledge" },
				{ content: "Ships on Fridays", segment: "project" },
				{ content: "Wants terse output", segment: "preference" },
			]),
			store,
			origin: OWNER,
		});
		assert.equal(res.written, 1);
		assert.equal(store.writes[0]?.segment, "preference");
	});

	it("only sets corrects on a correction segment", async () => {
		const store = fakeStore();
		await runBehaviorReview({
			transcript: "t",
			// a non-correction with a stray corrects must NOT carry it through
			reviewer: fakeReviewer([{ content: "Wants concise", segment: "preference", corrects: "nope" }]),
			store,
			origin: OWNER,
		});
		assert.equal(store.writes[0]?.metadata, undefined);
	});

	it("is best-effort: a reviewer error is a no-op, never thrown", async () => {
		const store = fakeStore();
		const res = await runBehaviorReview({
			transcript: "t",
			reviewer: async () => {
				throw new Error("boom");
			},
			store,
			origin: OWNER,
		});
		assert.equal(res.written, 0);
		assert.equal(store.writes.length, 0);
		assert.match(res.summary, /skipped/);
	});

	it("empty proposals → nothing written", async () => {
		const store = fakeStore();
		const res = await runBehaviorReview({ transcript: "t", reviewer: fakeReviewer([]), store, origin: OWNER });
		assert.equal(res.written, 0);
		assert.match(res.summary, /nothing behavioral/);
	});

	it("skips malformed elements without throwing", async () => {
		const store = fakeStore();
		const res = await runBehaviorReview({
			transcript: "t",
			reviewer: fakeReviewer([
				{ content: "", segment: "preference" },
				{ content: "  ", segment: "correction" },
				{ content: "Wants markdown tables", segment: "preference" },
			]),
			store,
			origin: OWNER,
		});
		assert.equal(res.written, 1);
		assert.equal(store.writes[0]?.content, "Wants markdown tables");
	});
});

describe("makeBehaviorReviewer", () => {
	it("builds a reviewer function without invoking a model at construction", () => {
		const reviewer = makeBehaviorReviewer({
			workspaceDir: "/tmp",
			agentDir: "/tmp",
			authStorage: {},
			modelRegistry: {},
			model: {},
		});
		assert.equal(typeof reviewer, "function");
	});
});
