import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore, type MemoryRecordOrigin } from "./records.js";

/**
 * Origin-isolation property test — Tideline gate 0.4 deliverable + a Phase-1
 * CI gate (the "no principal sees another's record" invariant).
 *
 * This guards the ONE filter the live recall path depends on:
 * `FactStore.search` applies `recordMatchesOriginFilter` over `readAll()`
 * (records.ts) BEFORE scoring. Every live recall surface (recall_memory,
 * auto-recall, capability.search → searchRich → factStore.recall
 * (searchHybrid)) routes through this exact function, so this suite proves
 * the SHARED origin-filter behaviour that all recall surfaces depend on.
 * search() and recall() share the same origin-filtered candidate set —
 * both gate on `recordMatchesOriginFilter` before scoring.
 *
 * Scope note: what is proven here is the in-memory origin filter applied to
 * the records returned by `readAll()`. The mode-specific seam — how a record's
 * `createdBy` origin is populated/hydrated per backend — is NOT exercised here;
 * convex `createdBy`-hydration is covered in the dual-mode / hybrid-convex
 * suites. (The convex `searchContent`/`findSimilar` server path is latent /
 * v2-only and NOT on the v1 recall path — see ConvexMemoryStore.searchFacts.)
 *
 * The cases are constructed so EVERY record matches the query lexically —
 * isolation must therefore come from the origin filter, never from a query
 * that simply fails to match the other principals' content.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-origin-iso-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const owner: MemoryRecordOrigin = { kind: "owner" };
const chanA: MemoryRecordOrigin = {
	kind: "channel",
	channelId: "whatsapp",
	conversationId: "convA",
	sessionKey: "sA",
};
const chanB: MemoryRecordOrigin = {
	kind: "channel",
	channelId: "whatsapp",
	conversationId: "convB",
	sessionKey: "sB",
};

describe("origin isolation — the shared recall origin-filter (FactStore.search)", () => {
	it("each principal recalls ONLY its own records — even when all match the query", () => {
		const store = new FactStore(dir);
		// Identical query terms across all three → lexical scorer matches every
		// record; only the origin filter can separate them.
		store.write({ content: "secret project alpha — owner note", segment: "project", createdBy: owner });
		store.write({ content: "secret project alpha — channelA note", segment: "project", createdBy: chanA });
		store.write({ content: "secret project alpha — channelB note", segment: "project", createdBy: chanB });

		// Premise pin: with NO origin the filter is bypassed, so the query must
		// lexically match all three records. If this drops below 3 the isolation
		// assertions below would pass trivially (query simply not matching).
		assert.equal(
			store.search("secret project alpha", { markAccessed: false }).length,
			3,
			"no-origin search returns all three — the query matches every record",
		);

		const ownerHits = store.search("secret project alpha", { origin: owner, markAccessed: false });
		assert.equal(ownerHits.length, 1, "owner sees exactly one record");
		assert.equal(ownerHits[0]!.content, "secret project alpha — owner note");

		const aHits = store.search("secret project alpha", { origin: chanA, markAccessed: false });
		assert.equal(aHits.length, 1, "channel A sees exactly one record");
		assert.equal(aHits[0]!.content, "secret project alpha — channelA note");

		const bHits = store.search("secret project alpha", { origin: chanB, markAccessed: false });
		assert.equal(bHits.length, 1, "channel B sees exactly one record");
		assert.equal(bHits[0]!.content, "secret project alpha — channelB note");
	});

	it("a channel peer NEVER recalls an owner fact, even on an exact term match", () => {
		const store = new FactStore(dir);
		store.write({ content: "the deploy key is rotated weekly", segment: "knowledge", createdBy: owner });
		const peerHits = store.search("deploy key rotated", { origin: chanA, markAccessed: false });
		assert.equal(peerHits.length, 0, "owner fact must be invisible to a channel peer");
	});

	it("the owner NEVER recalls a channel peer's fact", () => {
		const store = new FactStore(dir);
		store.write({ content: "peer said their birthday is in May", segment: "relationship", createdBy: chanA });
		const ownerHits = store.search("birthday May", { origin: owner, markAccessed: false });
		assert.equal(ownerHits.length, 0, "channel fact must be invisible to the owner");
	});

	it("a different session of the SAME channel peer is still isolated", () => {
		const store = new FactStore(dir);
		store.write({ content: "shared topic note from session A", segment: "context", createdBy: chanA });
		// Same channel + conversation, different sessionKey ⇒ a different principal.
		const chanADifferentSession: MemoryRecordOrigin = { ...chanA, sessionKey: "sA-other" };
		const hits = store.search("shared topic note", { origin: chanADifferentSession, markAccessed: false });
		assert.equal(hits.length, 0, "a different session of the same peer must not cross-recall");
	});

	it("the HYBRID recall surfaces (recall / searchHybrid / explainRecall) isolate by origin too", () => {
		const store = new FactStore(dir);
		// Same lexical terms across principals → only the origin filter separates them.
		store.write({ content: "secret project alpha — owner note", segment: "project", createdBy: owner });
		store.write({ content: "secret project alpha — channelA note", segment: "project", createdBy: chanA });

		// recall() → searchHybrid (the live auto-recall / recall_memory path).
		const ownerRecall = store.recall("secret project alpha", { origin: owner, markAccessed: false });
		assert.equal(ownerRecall.length, 1, "recall(): owner sees exactly its own");
		assert.equal(ownerRecall[0]!.content, "secret project alpha — owner note");
		assert.equal(
			store.recall("secret project alpha", { origin: chanB, markAccessed: false }).length,
			0,
			"recall(): an unrelated principal sees nothing",
		);

		// searchHybrid directly.
		const aHybrid = store.searchHybrid("secret project alpha", { origin: chanA, markAccessed: false });
		assert.equal(aHybrid.length, 1, "searchHybrid(): channel A sees exactly its own");
		assert.equal(aHybrid[0]!.content, "secret project alpha — channelA note");

		// explainRecall (transparency surface).
		assert.equal(store.explainRecall("secret project alpha", { origin: owner }).length, 1, "explainRecall(): owner-only");
		assert.equal(store.explainRecall("secret project alpha", { origin: chanB }).length, 0, "explainRecall(): isolated");
	});

	it("legacy records (no createdBy) resolve to owner-origin", () => {
		const store = new FactStore(dir);
		store.write({ content: "legacy fact about the build", segment: "knowledge" }); // no createdBy
		assert.equal(
			store.search("legacy build", { origin: owner, markAccessed: false }).length,
			1,
			"owner sees a legacy (undefined-origin) record",
		);
		assert.equal(
			store.search("legacy build", { origin: chanA, markAccessed: false }).length,
			0,
			"a channel peer does not see a legacy record",
		);
	});
});
