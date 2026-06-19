import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, type MemoryRecordOrigin } from "./records.js";

/**
 * Single-valued ATTRIBUTE SLOTS (subjectKey) — the deterministic correction path.
 * A fact tagged with a slot auto-supersedes the prior SAME-slot, SAME-origin value
 * on write (archive + bi-temporal close + `contradicts` link), so a correction
 * REPLACES the stale belief instead of piling beside it. Segment-independent.
 * Additive facts (no slot) are never touched. This is the piece both reference
 * memory systems lacked — it makes "supersede stale beliefs" actually true.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-slot-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const owner: MemoryRecordOrigin = { kind: "owner" };
const peer: MemoryRecordOrigin = { kind: "channel", channelId: "wa", conversationId: "c1", sessionKey: "s1" };

describe("subjectKey attribute slots — single-valued auto-supersede", () => {
	it("a new value for the same slot supersedes the old (CROSS-SEGMENT), keeping history", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		const b = store.write({ content: "I deploy on Wednesdays", segment: "correction", subjectKey: "deploy_day", createdBy: owner });

		const archived = store.readAll().find((r) => r.memoryId === a.memoryId);
		assert.equal(archived?.lifecycle, "archived", "prior slot value archived (preference superseded by a correction — segment-independent)");
		assert.ok(typeof archived?.validTo === "number", "validTo bi-temporally closed");
		assert.equal(b.lifecycle, "active");
		assert.ok(b.links?.some((l) => l.kind === "contradicts" && l.target === a.memoryId), "new fact carries a contradicts link to the superseded one");

		const hits = store.recall("deploy", { origin: owner, markAccessed: false });
		assert.ok(hits.some((h) => h.memoryId === b.memoryId), "current value recallable");
		assert.ok(!hits.some((h) => h.memoryId === a.memoryId), "stale slot value dropped from recall");
		assert.ok(store.readAll().some((r) => r.memoryId === a.memoryId), "archived value kept in history (not deleted)");
	});

	it("normalizes the slot key so phrasings collapse (Home City == home-city == home_city)", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "I live in Hyderabad", segment: "identity", subjectKey: "Home City", createdBy: owner });
		store.write({ content: "I live in Bangalore", segment: "identity", subjectKey: "home-city", createdBy: owner });
		assert.equal(store.readAll().find((r) => r.memoryId === a.memoryId)?.lifecycle, "archived", "different phrasing of the slot still supersedes");
		assert.equal(store.list({ origin: owner }).filter((r) => r.subjectKey === "home_city").length, 1, "exactly one active value for the slot");
	});

	it("ADDITIVE facts (no subjectKey) coexist — never auto-superseded", () => {
		const store = new FactStore(dir);
		store.write({ content: "I have a dog named Biscuit", segment: "relationship", createdBy: owner });
		store.write({ content: "I have a cat named Whiskers", segment: "relationship", createdBy: owner });
		assert.equal(store.list({ origin: owner }).length, 2, "both pets survive (no slot ⇒ additive)");
	});

	it("different slots coexist", () => {
		const store = new FactStore(dir);
		store.write({ content: "I live in Hyderabad", segment: "identity", subjectKey: "home_city", createdBy: owner });
		store.write({ content: "I deploy on Mondays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		assert.equal(store.list({ origin: owner }).length, 2, "distinct slots don't supersede each other");
	});

	it("restating the SAME value for a slot reinforces (no duplicate, no archive)", () => {
		const store = new FactStore(dir);
		const a = store.write({ content: "I deploy on Mondays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		const again = store.write({ content: "I deploy on Mondays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		assert.equal(again.memoryId, a.memoryId, "same value reinforced the existing record");
		assert.equal(store.list({ origin: owner }).length, 1, "no duplicate created");
	});

	it("ORIGIN-ISOLATED: a peer's slot value does NOT supersede the owner's same-slot fact", () => {
		const store = new FactStore(dir);
		const ownerFact = store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		store.write({ content: "I deploy on Sundays", segment: "preference", subjectKey: "deploy_day", createdBy: peer });
		assert.equal(store.readAll().find((r) => r.memoryId === ownerFact.memoryId)?.lifecycle, "active", "owner's slot value untouched by a peer's same-slot write");
	});

	it("an UNTRUSTED source cannot supersede a TRUSTED prior via a slot", () => {
		const store = new FactStore(dir);
		const trusted = store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		// tool_output → knowledge is allowed by the write-gate, but it must NOT archive the trusted slot value.
		store.write({ content: "a scraped page says deploys are on Sundays", segment: "knowledge", subjectKey: "deploy_day", sourceType: "tool_output", createdBy: owner });
		assert.equal(store.readAll().find((r) => r.memoryId === trusted.memoryId)?.lifecycle, "active", "trusted slot value not archived by an untrusted write");
	});
});

describe("supersede — slot-based is reliable; a slot-less correction safely COEXISTS (no content gamble)", () => {
	it("a slot-less correction does NOT archive the prior by content overlap (the data-loss-safe behavior)", () => {
		const store = new FactStore(dir);
		const fri = store.write({ content: "User deploys on Fridays", segment: "preference", createdBy: owner });
		const mon = store.write({ content: "User deploys on Mondays", segment: "correction", createdBy: owner });
		// A correction WITHOUT a subjectKey no longer auto-supersedes by content overlap:
		// no lexical threshold separates a same-subject value change from a DIFFERENT-subject
		// one (both ≈0.5), so the old gate silently archived still-true facts. Both now
		// coexist; recall surfaces the freshest first and the dream consolidates near-dupes.
		assert.equal(store.readAll().find((r) => r.memoryId === fri.memoryId)?.lifecycle, "active", "prior survives a slot-less correction — no data loss");
		assert.equal(mon.lifecycle, "active");
		assert.equal(store.list({ origin: owner }).length, 2, "both coexist (freshest wins at recall)");
	});

	it("a correction WITH a subjectKey reliably supersedes the same-slot prior (the supported auto-replace)", () => {
		const store = new FactStore(dir);
		const fri = store.write({ content: "User deploys on Fridays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		const mon = store.write({ content: "User deploys on Mondays", segment: "correction", subjectKey: "deploy_day", createdBy: owner });
		assert.equal(store.readAll().find((r) => r.memoryId === fri.memoryId)?.lifecycle, "archived", "same-slot prior archived");
		assert.equal(mon.lifecycle, "active");
		assert.ok(mon.links?.some((l) => l.kind === "contradicts" && l.target === fri.memoryId), "contradicts link recorded");
		// a SECOND same-slot write collapses the chain — no pile-up
		store.write({ content: "User deploys on Wednesdays", segment: "correction", subjectKey: "deploy_day", createdBy: owner });
		const active = store.list({ origin: owner });
		assert.equal(active.length, 1, "only the latest same-slot value stays active");
		assert.match(active[0]!.content, /Wednesdays/);
	});

	it("ADDITIVE facts (no slot) coexist even at high overlap (the cat doesn't kill the dog)", () => {
		const store = new FactStore(dir);
		store.write({ content: "I have a dog named Biscuit", segment: "relationship", createdBy: owner });
		store.write({ content: "I have a cat named Whiskers", segment: "relationship", createdBy: owner });
		assert.equal(store.list({ origin: owner }).length, 2, "both pets survive — slot-less facts are never auto-superseded");
	});

	it("a peer's correction does NOT supersede the owner's same-SLOT fact (origin-isolated)", () => {
		const store = new FactStore(dir);
		const ownerFact = store.write({ content: "I deploy on Fridays", segment: "preference", subjectKey: "deploy_day", createdBy: owner });
		store.write({ content: "I deploy on Sundays", segment: "correction", subjectKey: "deploy_day", createdBy: peer });
		assert.equal(store.readAll().find((r) => r.memoryId === ownerFact.memoryId)?.lifecycle, "active", "a peer can't archive the owner's belief even on the same slot");
	});
});
