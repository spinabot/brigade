import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { fetchBlueBubblesHistory, renderBlueBubblesHistoryBlock } from "./history.js";

const SERVER = "http://10.0.0.1:1234";
const PASSWORD = ["bb", "hist", "pw"].join("-");

/** A fetch that serves a canned message list on the FIRST recognised path, 404s the rest. */
function listFetch(messages: unknown[], opts: { failFirst?: number } = {}): typeof fetch {
	let calls = 0;
	return (async (url: string) => {
		calls++;
		void url;
		if (opts.failFirst && calls <= opts.failFirst) {
			return { ok: false, status: 404, text: async () => "", headers: new Map() as unknown as Headers } as unknown as Response;
		}
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 200, data: messages }),
			headers: new Map() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("fetchBlueBubblesHistory", () => {
	it("fetches recent messages and returns them oldest-first", async () => {
		const f = listFetch([
			{ guid: "m2", text: "second", dateCreated: 200, handle: { address: "+2" } },
			{ guid: "m1", text: "first", dateCreated: 100, handle: { address: "+1" } },
		]);
		const { entries, resolved } = await fetchBlueBubblesHistory("iMessage;+;chatX", 10, {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
		});
		assert.equal(resolved, true);
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.body, "first"); // oldest first
		assert.equal(entries[1]!.body, "second");
		assert.equal(entries[0]!.sender, "+1");
	});

	it("labels the bot's own past messages as 'me' and skips empty-text records", async () => {
		const f = listFetch([
			{ guid: "a", text: "hello", dateCreated: 1, is_from_me: true },
			{ guid: "b", text: "", dateCreated: 2, handle: { address: "+9" } },
			{ guid: "c", text: "world", dateCreated: 3, handle: { address: "+9" } },
		]);
		const { entries } = await fetchBlueBubblesHistory("iMessage;+;chatX", 10, {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
		});
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.sender, "me");
		assert.equal(entries[1]!.body, "world");
	});

	it("falls back to a later path when the first 404s (multi-path)", async () => {
		const f = listFetch([{ guid: "m1", text: "hi", dateCreated: 1, handle: { address: "+1" } }], { failFirst: 1 });
		const { entries, resolved } = await fetchBlueBubblesHistory("iMessage;+;chatX", 5, {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
		});
		assert.equal(resolved, true);
		assert.equal(entries.length, 1);
	});

	it("attaches nothing when the limit is 0 (disabled)", async () => {
		let called = false;
		const f = (async () => {
			called = true;
			return { ok: true, status: 200, text: async () => "{}", headers: new Map() as unknown as Headers } as unknown as Response;
		}) as unknown as typeof fetch;
		const { entries, resolved } = await fetchBlueBubblesHistory("iMessage;+;chatX", 0, {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
		});
		assert.equal(called, false, "no fetch when disabled");
		assert.equal(entries.length, 0);
		assert.equal(resolved, true);
	});

	it("returns resolved=false when every path fails (never throws)", async () => {
		const f = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const { entries, resolved } = await fetchBlueBubblesHistory("iMessage;+;chatX", 5, {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
		});
		assert.equal(resolved, false);
		assert.equal(entries.length, 0);
	});

	it("clamps the limit to the returned slice", async () => {
		const many = Array.from({ length: 30 }, (_v, i) => ({ guid: `g${i}`, text: `t${i}`, dateCreated: i, handle: { address: "+1" } }));
		const f = listFetch(many);
		const { entries } = await fetchBlueBubblesHistory("iMessage;+;chatX", 5, {
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
		});
		assert.equal(entries.length, 5);
	});
});

describe("renderBlueBubblesHistoryBlock", () => {
	it("renders a fenced context block", () => {
		const block = renderBlueBubblesHistoryBlock([
			{ sender: "Alex", body: "hey" },
			{ sender: "me", body: "hi" },
		]);
		assert.ok(block.startsWith("[recent conversation context]"));
		assert.ok(block.includes("Alex: hey"));
		assert.ok(block.includes("me: hi"));
		assert.ok(block.trimEnd().endsWith("[end context]"));
	});

	it("renders empty for no entries", () => {
		assert.equal(renderBlueBubblesHistoryBlock([]), "");
	});
});
