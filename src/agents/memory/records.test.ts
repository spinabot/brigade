import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	compareRichness,
	FactStore,
	inheritRicherMetadata,
	makeMemoryId,
	richerSurvivor,
	SEGMENT_DEFAULTS,
	clampImportance,
	type MemoryRecord,
	type MemoryRecordOrigin,
} from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-facts-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("FactStore — write + list", () => {
	it("derives tier/importance/decay from the segment defaults", () => {
		const store = new FactStore(dir);
		const rec = store.write({ content: "User is on Windows.", segment: "identity" });
		assert.equal(rec.segment, "identity");
		assert.equal(rec.tier, SEGMENT_DEFAULTS.identity.tier); // permanent
		assert.equal(rec.importance, SEGMENT_DEFAULTS.identity.importance); // 0.85
		assert.equal(rec.decayRate, SEGMENT_DEFAULTS.identity.decayRate);
		assert.equal(rec.lifecycle, "active");
		assert.equal(rec.accessCount, 0);
		assert.ok(rec.memoryId.startsWith("mem_"));
		// Persisted + listable.
		assert.equal(store.list().length, 1);
		assert.equal(store.list({ segment: "identity" })[0]?.content, "User is on Windows.");
	});

	it("dedups a near-identical active fact (reinforces instead of duplicating)", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "The user prefers concise, no-fluff answers.", segment: "preference", importance: 0.9 });
		// Extraction later distills the SAME fact at a lower importance.
		const b = store.write({
			content: "The user prefers concise, no-fluff answers.",
			segment: "preference",
			importance: 0.7,
			sourceTurn: "t1",
		});
		// Same record returned — no parallel copy.
		assert.equal(b.memoryId, a.memoryId);
		assert.equal(store.list().length, 1);
		// Kept the HIGHER importance, reinforced, inherited the sourceTurn.
		assert.equal(store.list()[0]?.importance, 0.9);
		assert.equal(store.list()[0]?.accessCount, 1);
		assert.equal(store.list()[0]?.sourceTurn, "t1");
	});

	it("does NOT dedup distinct facts that merely share words", () => {
		const store = new FactStore(dir);
		store.write({ content: "The user is on Windows and uses PowerShell.", segment: "context" });
		store.write({ content: "The user prefers dark mode in their editor.", segment: "preference" });
		assert.equal(store.list().length, 2);
	});

	it("never dedups a correction (supersedes is intentional)", () => {
		const store = new FactStore(dir);
		const old = store.write({ content: "The user is on Windows.", segment: "context" });
		// A correction with the SAME-ish words must still be its own record + archive the old.
		store.write({
			content: "The user is on Windows no longer — they are on macOS.",
			segment: "correction",
			supersedes: [old.memoryId],
		});
		assert.equal(store.list().length, 1); // only the correction is active
		assert.equal(store.list()[0]?.segment, "correction");
	});

	it("clamps an out-of-range importance override", () => {
		const store = new FactStore(dir);
		const hi = store.write({ content: "x", segment: "context", importance: 5 });
		const lo = store.write({ content: "y", segment: "context", importance: -1 });
		assert.equal(hi.importance, 1);
		assert.equal(lo.importance, 0);
	});

	it("supersede archives the prior record (correction overwrites belief)", () => {
		const store = new FactStore(dir);
		const old = store.write({ content: "User likes tabs.", segment: "preference" });
		store.write({
			content: "User actually prefers spaces.",
			segment: "correction",
			supersedes: [old.memoryId],
			metadata: { corrects: "User likes tabs." },
		});
		// Active list shows only the correction; the old one is archived.
		const active = store.list();
		assert.equal(active.length, 1);
		assert.equal(active[0]?.segment, "correction");
		assert.equal(store.list({ lifecycle: "archived" }).length, 1);
	});

	it("markAccessed bumps accessCount + lastAccessedAt", () => {
		const T_WRITE = 1_000_000;
		const T_ACCESS = 2_000_000;
		let tick = 0;
		const clock = () => (tick === 0 ? T_WRITE : T_ACCESS);
		const store = new FactStore(dir, { now: clock });
		store.write({ content: "fact", segment: "knowledge" });
		tick = 1;
		const id = store.list()[0]!.memoryId;
		store.markAccessed([id]);
		const after = store.list()[0];
		assert.equal(after?.accessCount, 1);
		assert.equal(after?.lastAccessedAt, T_ACCESS);
	});

	it("setLifecycle prunes records (decay GC seam)", () => {
		const store = new FactStore(dir);
		const r = store.write({ content: "stale", segment: "context" });
		store.setLifecycle([r.memoryId], "pruned");
		assert.equal(store.list().length, 0);
		assert.equal(store.list({ lifecycle: "pruned" }).length, 1);
	});

	it("skips corrupt JSONL lines without throwing", () => {
		const store = new FactStore(dir);
		store.write({ content: "good", segment: "knowledge" });
		fs.appendFileSync(store.filePath, "this is not json\n", "utf8");
		const all = store.readAll();
		assert.equal(all.length, 1);
		assert.equal(all[0]?.content, "good");
	});

	it("empty / missing store reads as []", () => {
		const store = new FactStore(dir);
		assert.deepEqual(store.readAll(), []);
		assert.deepEqual(store.list(), []);
	});
});

describe("record helpers", () => {
	it("clampImportance falls back when not finite", () => {
		assert.equal(clampImportance(undefined, 0.5), 0.5);
		assert.equal(clampImportance(Number.NaN, 0.7), 0.7);
		assert.equal(clampImportance(0.3, 0.5), 0.3);
	});
	it("makeMemoryId is unique-ish + prefixed", () => {
		const a = makeMemoryId();
		const b = makeMemoryId();
		assert.notEqual(a, b);
		assert.ok(a.startsWith("mem_"));
		assert.ok(b.startsWith("mem_"));
	});
});

const owner: MemoryRecordOrigin = { kind: "owner" };

/** Minimal MemoryRecord builder for the pure-comparator unit tests. */
function rec(over: Partial<MemoryRecord>): MemoryRecord {
	return {
		memoryId: makeMemoryId(),
		content: "x",
		segment: "knowledge",
		tier: "long",
		importance: 0.6,
		decayRate: 0.03,
		accessCount: 0,
		lastAccessedAt: 0,
		createdAt: 0,
		lifecycle: "active",
		...over,
	};
}

describe("winner-selection — richest beats newest (Fix 3)", () => {
	it("a subject-bearing identity original outranks a NEWER subject-less knowledge copy", () => {
		const rich = rec({ segment: "identity", subjectKey: "diet", importance: 0.85, createdAt: 1000 });
		// The churn copy is NEWER (higher createdAt) but metadata-poorer.
		const churn = rec({ segment: "knowledge", importance: 0.6, createdAt: 2000 });
		assert.ok(compareRichness(rich, churn) > 0, "rich record compares as richer");
		assert.equal(richerSurvivor(rich, churn).memoryId, rich.memoryId, "the rich record survives, not the newer churn copy");
		assert.equal(richerSurvivor(churn, rich).memoryId, rich.memoryId, "order-independent — richest still wins");
	});

	it("a present subjectKey dominates segment specificity", () => {
		// Even a `knowledge` fact WITH a subjectKey beats a subject-less `identity` one,
		// because the subject anchor is the vault hub key (first tuple field).
		const withSlot = rec({ segment: "knowledge", subjectKey: "ui_theme" });
		const noSlot = rec({ segment: "identity" });
		assert.ok(compareRichness(withSlot, noSlot) > 0, "subjectKey presence is the top richness signal");
	});

	it("on an exact richness tie, the NEWER record wins (a genuine restatement refreshes)", () => {
		const older = rec({ segment: "preference", subjectKey: "deploy_day", createdAt: 1000 });
		const newer = rec({ segment: "preference", subjectKey: "deploy_day", createdAt: 5000 });
		assert.equal(compareRichness(older, newer), 0, "identical richness");
		assert.equal(richerSurvivor(older, newer).memoryId, newer.memoryId, "tie breaks to newer");
	});

	it("more specific segment wins when subjectKey + importance tie", () => {
		const ident = rec({ segment: "identity", importance: 0.7 });
		const know = rec({ segment: "knowledge", importance: 0.7 });
		assert.ok(compareRichness(ident, know) > 0, "identity beats knowledge at equal importance");
	});
});

describe("metadata preservation on reconcile (Fix 2)", () => {
	it("inheritRicherMetadata folds the richer of each field into the survivor", () => {
		const survivor = rec({ segment: "knowledge", importance: 0.6, accessCount: 1 });
		const loser = rec({ segment: "identity", subjectKey: "diet", importance: 0.9, confidence: 0.8, accessCount: 3 });
		inheritRicherMetadata(survivor, loser);
		assert.equal(survivor.subjectKey, "diet", "subjectKey inherited (never dropped to none)");
		assert.equal(survivor.segment, "identity", "more-specific segment kept");
		assert.equal(survivor.importance, 0.9, "higher importance kept");
		assert.equal(survivor.confidence, 0.8, "confidence inherited");
		assert.equal(survivor.accessCount, 3, "higher confirmations kept");
		// Promoting the segment re-bases the durability fields off the new segment.
		assert.equal(survivor.tier, SEGMENT_DEFAULTS.identity.tier);
		assert.equal(survivor.decayRate, SEGMENT_DEFAULTS.identity.decayRate);
	});

	it("never DROPS a subjectKey when the survivor already has none and the loser has one", () => {
		const survivor = rec({ segment: "preference" });
		const loser = rec({ segment: "preference", subjectKey: "ui_theme" });
		inheritRicherMetadata(survivor, loser);
		assert.equal(survivor.subjectKey, "ui_theme");
	});

	it("FactStore.mergeMetadataInto persists the merge and reports change", () => {
		const store = new FactStore(dir);
		const keep = store.write({ content: "The user is vegetarian and does not eat meat or fish", segment: "knowledge", sourceType: "extraction", createdBy: owner });
		const drop = store.write({ content: "User vegetarian fact (distinct enough not to dedup) — taught", segment: "identity", subjectKey: "diet", importance: 0.9, createdBy: owner });
		const changed = store.mergeMetadataInto(keep.memoryId, drop.memoryId);
		assert.equal(changed, true, "merge changed the survivor");
		const after = store.readAll().find((r) => r.memoryId === keep.memoryId)!;
		assert.equal(after.subjectKey, "diet", "survivor inherited the subjectKey");
		assert.equal(after.segment, "identity", "survivor inherited the more-specific segment");
		assert.equal(after.importance, 0.9, "survivor inherited the higher importance");
	});
});

describe("the churn regression — extraction copy must never archive the rich original (end-to-end)", () => {
	it("a reworded subject-less knowledge copy does NOT win over a subject-bearing identity original at write time", () => {
		const store = new FactStore(dir);
		// Rich taught fact.
		const rich = store.write({ content: "User is vegetarian — no meat or fish", segment: "identity", subjectKey: "diet", createdBy: owner });
		// Reworded extraction copy (knowledge, no subjectKey). It is a paraphrase below the
		// 0.85 dedup bar AND carries no subjectKey, so the write paths leave the rich
		// original untouched (no churn-driven archive of the richer record at write time).
		store.write({ content: "The user is vegetarian and does not eat meat or fish", segment: "knowledge", sourceType: "extraction", createdBy: owner });
		const richAfter = store.readAll().find((r) => r.memoryId === rich.memoryId)!;
		assert.equal(richAfter.lifecycle, "active", "the rich original is NOT archived by the churn copy");
		assert.equal(richAfter.subjectKey, "diet", "the rich original keeps its subjectKey");
		assert.equal(richAfter.segment, "identity", "the rich original keeps its identity segment");
	});

	it("write-time dedup of two same-trust facts keeps the survivor's metadata RICHEST (no segment downgrade)", () => {
		const store = new FactStore(dir);
		// A sparse note lands first (owner-authored / trusted, no sourceType, no subjectKey
		// ⇒ takes the dedup path, not the slot path).
		const sparse = store.write({ content: "User prefers dark mode in the editor", segment: "knowledge", importance: 0.6, createdBy: owner });
		// The operator then states the SAME fact with a more-specific segment. Near-exact
		// (>= 0.85 dedup bar), both trusted, neither carries a subjectKey ⇒ the dedup path
		// fires onto the existing record, which must INHERIT the richer incoming segment
		// rather than stay the sparse `knowledge` version.
		const ret = store.write({ content: "User prefers dark mode in the editor.", segment: "identity", importance: 0.85, createdBy: owner });
		assert.equal(ret.memoryId, sparse.memoryId, "deduped onto the existing record (no parallel copy)");
		assert.equal(store.list({ origin: owner }).length, 1, "exactly one active record");
		const after = store.readAll().find((r) => r.memoryId === sparse.memoryId)!;
		assert.equal(after.segment, "identity", "survivor was UPGRADED to the more-specific segment, not left at knowledge");
		assert.equal(after.importance, 0.85, "survivor kept the higher importance");
		assert.equal(after.tier, SEGMENT_DEFAULTS.identity.tier, "durability re-based to the promoted segment");
		assert.equal(after.accessCount, 1, "reinforced");
	});

	it("an UNTRUSTED extraction restatement of a TRUSTED owner fact does NOT dedup-merge (security) — idempotency handles that churn upstream", () => {
		// Documents WHY the write-time dedup leaves the churn copy separate: the write-gate
		// blind-spot guard forbids an untrusted (extraction) write from reinforcing/mutating
		// a trusted owner fact through the dedup back door. The CLEANUP of such churn is the
		// job of extraction idempotency (extract.ts, Fix 1) + the consolidation guard, NOT
		// write-time dedup — so the rich original is never archived by the churn copy here.
		const store = new FactStore(dir);
		const rich = store.write({ content: "User prefers dark mode in the editor", segment: "preference", subjectKey: "ui_theme", createdBy: owner });
		const churn = store.write({ content: "User prefers dark mode in the editor.", segment: "knowledge", sourceType: "extraction", createdBy: owner });
		assert.notEqual(churn.memoryId, rich.memoryId, "untrusted restatement does NOT merge into the trusted fact");
		const richAfter = store.readAll().find((r) => r.memoryId === rich.memoryId)!;
		assert.equal(richAfter.lifecycle, "active", "the rich original is untouched (not archived) by the untrusted churn write");
		assert.equal(richAfter.subjectKey, "ui_theme", "rich original keeps its subjectKey");
	});
});
