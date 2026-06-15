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
		assert.equal(store.list().length, 4);
		assert.equal(store.list({ lifecycle: "archived" }).length, 2);
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
		assert.ok(store.list({ lifecycle: "archived" }).map((r) => r.memoryId).includes(firstOwnerId));
		for (const id of chanIds) {
			assert.ok(store.list().map((r) => r.memoryId).includes(id), "channel facts untouched by owner consolidation");
		}
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
