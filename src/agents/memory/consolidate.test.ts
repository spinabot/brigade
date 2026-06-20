import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	markConsolidationRun,
	parseConsolidationArchive,
	runConsolidation,
	shouldRunConsolidation,
} from "./consolidate.js";
import { FactStore } from "./records.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-consolidate-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("parseConsolidationArchive", () => {
	it("parses an archive id list", () => {
		assert.deepEqual(parseConsolidationArchive('{"archive":["a","b"]}'), ["a", "b"]);
	});
	it("handles prose-wrapped JSON + drops non-strings", () => {
		assert.deepEqual(parseConsolidationArchive('ok: {"archive":["x", 5, null, "y"]}'), ["x", "y"]);
	});
	it("returns [] on garbage / empty / no archive key", () => {
		assert.deepEqual(parseConsolidationArchive("nope"), []);
		assert.deepEqual(parseConsolidationArchive('{"other":1}'), []);
		assert.deepEqual(parseConsolidationArchive(""), []);
	});
	it("survives brace-bearing prose + a leading stray object (balanced-object scan)", () => {
		// A greedy first-to-last `{...}` match would span both brace groups and fail;
		// a leading `{}` would shadow the real payload. The balanced-object scan takes
		// the FIRST object that actually carries an `archive` array.
		assert.deepEqual(parseConsolidationArchive('My analysis: {a few notes}. Result: {"archive":["mem_x"]}'), ["mem_x"]);
		assert.deepEqual(parseConsolidationArchive('{} {"archive":["mem_y"]}'), ["mem_y"]);
	});
});

function seed(store: FactStore, n: number): string[] {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		ids.push(store.write({ content: `Distinct fact number ${i} about topic ${i}.`, segment: "knowledge" }).memoryId);
	}
	return ids;
}

describe("runConsolidation", () => {
	it("archives the ids the LLM returns (that exist + are active)", async () => {
		const store = new FactStore(dir);
		const ids = seed(store, 6);
		const llm = async () => `{"archive":["${ids[1]}","${ids[3]}","nonexistent-id"]}`;
		const res = await runConsolidation({ workspaceDir: dir, llm });
		assert.equal(res.ran, true);
		assert.equal(res.archived, 2); // the bogus id is ignored
		// Exact active set: the 4 facts NOT asked to be archived (ids[0,2,4,5]).
		assert.deepEqual(
			store.list().map((r) => r.memoryId).sort(),
			[ids[0], ids[2], ids[4], ids[5]].sort(),
		);
		// Exact archived set: only the two ids the LLM nominated (ids[1] and ids[3]).
		assert.deepEqual(
			store.list({ lifecycle: "archived" }).map((r) => r.memoryId).sort(),
			[ids[1], ids[3]].sort(),
		);
	});

	it("is a no-op below the minimum fact count (no LLM call)", async () => {
		const store = new FactStore(dir);
		seed(store, 3);
		let called = 0;
		const llm = async () => {
			called++;
			return "{}";
		};
		const res = await runConsolidation({ workspaceDir: dir, llm });
		assert.equal(res.ran, false);
		assert.equal(called, 0);
	});

	it("refuses to archive ALL facts (runaway-model safety)", async () => {
		const store = new FactStore(dir);
		const ids = seed(store, 6);
		const llm = async () => `{"archive":${JSON.stringify(ids)}}`;
		const res = await runConsolidation({ workspaceDir: dir, llm });
		assert.equal(res.archived, 0, "must not empty the store");
		assert.equal(store.list().length, 6);
	});

	it("does not advance / archive when the LLM throws", async () => {
		const store = new FactStore(dir);
		seed(store, 6);
		const llm = async () => {
			throw new Error("provider down");
		};
		const res = await runConsolidation({ workspaceDir: dir, llm });
		assert.equal(res.ran, false);
		assert.equal(store.list().length, 6);
	});

	// RICHNESS GUARD (Fix 2 + 3) — the bug: the LLM, with no notion of metadata
	// richness, archived the subject-bearing identity/preference ORIGINALS and kept
	// their reworded subject-less knowledge twins (the vault graph then lost the
	// hub-anchoring subjectKeys). The guard must redirect each such archive to the
	// POORER twin so the richest record always survives — even though the LLM named
	// the rich one. Reproduces the operator's exact real-data evidence (3 of 5 facts).
	it("redirects an LLM archive away from the RICHER twin — the subject-bearing original survives", async () => {
		const owner = { kind: "owner" as const };
		const store = new FactStore(dir);
		// 5 rich taught facts (identity/preference + subjectKey).
		const rich = {
			veg: store.write({ content: "User is vegetarian — no meat or fish", segment: "identity", subjectKey: "diet", createdBy: owner }).memoryId,
			peanut: store.write({ content: "User has a peanut allergy", segment: "identity", subjectKey: "peanut_allergy", createdBy: owner }).memoryId,
			dark: store.write({ content: "User prefers dark mode", segment: "preference", subjectKey: "ui_theme", createdBy: owner }).memoryId,
			loc: store.write({ content: "User lives in Hyderabad", segment: "identity", subjectKey: "location", createdBy: owner }).memoryId,
			deploy: store.write({ content: "User deploys on Fridays", segment: "preference", subjectKey: "deploy_day", createdBy: owner }).memoryId,
		};
		// 3 reworded extraction churn copies (knowledge, no subjectKey) — for veg/peanut/dark.
		const churn = {
			veg: store.write({ content: "The user is vegetarian and does not eat meat or fish", segment: "knowledge", sourceType: "extraction", createdBy: owner }).memoryId,
			peanut: store.write({ content: "The user is allergic to peanuts", segment: "knowledge", sourceType: "extraction", createdBy: owner }).memoryId,
			dark: store.write({ content: "The user prefers the dark theme", segment: "knowledge", sourceType: "extraction", createdBy: owner }).memoryId,
		};
		// The model (wrongly) nominates the RICH originals for archival.
		const llm = async () => JSON.stringify({ archive: [rich.veg, rich.peanut, rich.dark] });
		const res = await runConsolidation({ workspaceDir: dir, llm, minFacts: 1 });
		assert.equal(res.archived, 3, "three records archived — but the POORER twins, not the rich originals");

		const byId = new Map(store.readAll().map((r) => [r.memoryId, r]));
		// Every rich subject-bearing original stays ACTIVE.
		for (const id of Object.values(rich)) {
			assert.equal(byId.get(id)!.lifecycle, "active", "rich subject-bearing original survives");
		}
		// Every churn copy is archived instead.
		for (const id of Object.values(churn)) {
			assert.equal(byId.get(id)!.lifecycle, "archived", "the subject-less churn twin is the one archived");
		}
		// The surviving veg fact still carries its subjectKey + identity segment (not isolated).
		const veg = byId.get(rich.veg)!;
		assert.equal(veg.subjectKey, "diet");
		assert.equal(veg.segment, "identity");
	});

	it("consolidates each ORIGIN in isolation — no prompt mixes origins, no cross-origin archive", async () => {
		const store = new FactStore(dir);
		const ownerIds: string[] = [];
		const chanIds: string[] = [];
		for (let i = 0; i < 6; i++) {
			ownerIds.push(store.write({ content: `Owner fact ${i} about topic ${i}.`, segment: "knowledge" }).memoryId);
		}
		const chanOrigin = { kind: "channel" as const, channelId: "whatsapp", conversationId: "grp1", sessionKey: "s1" };
		for (let i = 0; i < 6; i++) {
			chanIds.push(
				store.write({ content: `Channel fact ${i} about topic ${i}.`, segment: "knowledge", createdBy: chanOrigin })
					.memoryId,
			);
		}
		const firstOwnerId = ownerIds[0];
		assert.ok(firstOwnerId);
		const blocks: string[] = [];
		// The LLM always tries to archive an OWNER id, regardless of which bucket it sees.
		const llm = async (block: string) => {
			blocks.push(block);
			return `{"archive":["${firstOwnerId}"]}`;
		};
		const res = await runConsolidation({ workspaceDir: dir, llm });

		// Two origin buckets (owner + one channel), each >= minFacts → exactly two ISOLATED calls.
		assert.equal(blocks.length, 2, "one LLM call per origin — never a single merged cross-origin prompt");
		for (const b of blocks) {
			const sawOwner = ownerIds.some((id) => b.includes(id));
			const sawChannel = chanIds.some((id) => b.includes(id));
			assert.ok(!(sawOwner && sawChannel), "a consolidation prompt must never contain two origins at once");
		}
		// Owner id archived by the owner bucket; the channel call returning that same
		// owner id archives NOTHING (cross-origin archive is blocked by bucket scoping).
		assert.equal(res.archived, 1);
		// Exact archived set: only the one owner fact the owner-bucket's LLM call nominated.
		assert.deepEqual(
			store.list({ lifecycle: "archived" }).map((r) => r.memoryId),
			[firstOwnerId],
		);
		// All 6 channel facts must still be active — none was archivable by the owner bucket.
		assert.deepEqual(
			store.list().map((r) => r.memoryId).sort(),
			[...ownerIds.filter((id) => id !== firstOwnerId), ...chanIds].sort(),
		);
	});
});

describe("consolidation throttle", () => {
	it("eligible when never run; throttled within the interval; eligible after", () => {
		assert.equal(shouldRunConsolidation(dir, 1000, 10_000), true);
		markConsolidationRun(dir, 10_000);
		assert.equal(shouldRunConsolidation(dir, 1000, 10_500), false); // 500ms < 1000ms
		assert.equal(shouldRunConsolidation(dir, 1000, 11_500), true); // 1500ms >= 1000ms
	});
});
