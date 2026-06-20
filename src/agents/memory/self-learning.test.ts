import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";

/**
 * The continual-learning loop (memory + self-improvement, first piece). Recall
 * feedback adjusts a fact's importance/confidence ASYMMETRICALLY (+0.05 / −0.10),
 * persisted + logged to the event/telemetry track. Recall
 * then adapts (importance feeds the scorer), closing the loop: recall → feedback
 * → better recall. This is the substrate the reviewer/curator + anti-slop loop
 * build on.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-learn-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("self-learning loop — feedback adapts memory", () => {
	it("up/down adjust importance asymmetrically (+0.05 / −0.10), persisted to disk", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "deploy with npm run release", segment: "knowledge", importance: 0.5 });
		store.applyFeedback(a.memoryId, "up");
		assert.ok(Math.abs((store.readAll()[0]?.importance ?? 0) - 0.55) < 1e-9, "up: +0.05");
		store.applyFeedback(a.memoryId, "down");
		assert.ok(Math.abs((store.readAll()[0]?.importance ?? 0) - 0.45) < 1e-9, "down: −0.10");
		// survives a fresh store handle (persisted)
		assert.ok(Math.abs((new FactStore(dir).readAll()[0]?.importance ?? 0) - 0.45) < 1e-9, "persisted");
	});

	it("clamps importance to [0,1] at the boundaries (no overshoot/NaN/negative)", () => {
		const store = new FactStore(dir);
		// near-ceiling + up (+0.05 → 1.03) clamps to exactly 1.0
		const hi = store.write({ content: "near-ceiling fact", segment: "knowledge", importance: 0.98 });
		store.applyFeedback(hi.memoryId, "up");
		assert.equal(store.readAll().find((r) => r.memoryId === hi.memoryId)?.importance, 1.0, "clamped to 1.0");
		// near-floor + down (−0.10 → −0.05) clamps to exactly 0 (not negative, not NaN)
		const lo = store.write({ content: "near-floor fact", segment: "knowledge", importance: 0.05 });
		store.applyFeedback(lo.memoryId, "down");
		assert.equal(store.readAll().find((r) => r.memoryId === lo.memoryId)?.importance, 0, "clamped to 0");
	});

	it("adjusts the confidence cognition field too when present", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "a dated fact", segment: "knowledge", confidence: 0.5 });
		store.applyFeedback(a.memoryId, "down");
		assert.ok(Math.abs((store.readAll()[0]?.confidence ?? 0) - 0.4) < 1e-9, "confidence −0.10");
	});

	it("logs a 'feedback' event to the telemetry track (the self-improvement signal)", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "telemetry fact", segment: "knowledge" });
		store.applyFeedback(a.memoryId, "up");
		const fb = store.readEvents().filter((e) => e.kind === "feedback");
		assert.equal(fb.length, 1);
		assert.equal(fb[0]?.signal, "up");
		assert.equal(fb[0]?.memoryId, a.memoryId);
		assert.equal(fb[0]?.segment, "knowledge");
	});

	it("closes the loop: feedback INVERTS the BM25 order (not a length/frequency artifact)", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "pour over coffee brewing is my morning ritual", segment: "knowledge" });
		const b = store.write({ content: "the office kitchen has a pour over coffee brewing station", segment: "knowledge" });
		const q = "pour over coffee brewing";
		// Control: capture whichever fact BM25 favors BEFORE any feedback (the prior
		// version of this test silently relied on BM25 already ranking the "winner"
		// first, so it would pass even with feedback disabled — proving nothing).
		const preTop = store.recall(q, { markAccessed: false })[0]?.memoryId;
		const favored = preTop === a.memoryId ? a : b;
		const other = preTop === a.memoryId ? b : a;
		// Downvote the BM25 favorite, upvote the trailer → the order MUST flip, which
		// can ONLY come from feedback (BM25 is unchanged).
		for (let i = 0; i < 5; i++) store.applyFeedback(favored.memoryId, "down");
		store.applyFeedback(other.memoryId, "up");
		const postTop = store.recall(q, { markAccessed: false })[0]?.memoryId;
		assert.equal(postTop, other.memoryId, "feedback inverted the order: the upvoted fact now leads");
		assert.notEqual(postTop, preTop, "the top result changed BECAUSE of feedback, not BM25");
	});

	it("down does NOT touch the access clock; up bumps accessCount + refreshes lastAccessedAt", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "access-clock fact", segment: "knowledge", importance: 0.5 });
		const before = store.readAll().find((r) => r.memoryId === a.memoryId);
		const baseCount = before?.accessCount ?? 0;
		const baseAt = before?.lastAccessedAt ?? 0;
		// down: importance drops but the access clock must be UNCHANGED.
		store.applyFeedback(a.memoryId, "down");
		const afterDown = store.readAll().find((r) => r.memoryId === a.memoryId);
		assert.equal(afterDown?.accessCount, baseCount, "down: accessCount unchanged");
		assert.equal(afterDown?.lastAccessedAt, baseAt, "down: lastAccessedAt unchanged");
		// up: accessCount +1 and lastAccessedAt refreshed (>= the prior value).
		store.applyFeedback(a.memoryId, "up");
		const afterUp = store.readAll().find((r) => r.memoryId === a.memoryId);
		assert.equal(afterUp?.accessCount, baseCount + 1, "up: accessCount +1");
		assert.ok((afterUp?.lastAccessedAt ?? 0) >= baseAt, "up: lastAccessedAt refreshed");
	});

	it("archived facts reject feedback → undefined, importance untouched", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "archived fact", segment: "knowledge", importance: 0.5 });
		store.setLifecycle([a.memoryId], "archived");
		assert.equal(store.applyFeedback(a.memoryId, "up"), undefined, "archived → no-op");
		assert.equal(store.readAll().find((r) => r.memoryId === a.memoryId)?.importance, 0.5, "importance untouched");
	});

	it("unknown id → undefined (no-op)", () => {
		assert.equal(new FactStore(dir).applyFeedback("nope", "up"), undefined);
	});
});
