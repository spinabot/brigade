import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { combineDebounceEntries, createBlueBubblesInboundDebouncer, resolveDebounceKey } from "./debounce.js";
import type { BlueBubblesInboundMessage } from "./connection.js";

function msg(overrides: Partial<BlueBubblesInboundMessage> = {}): BlueBubblesInboundMessage {
	return {
		conversationId: "chat_guid:iMessage;-;+1",
		chatGuid: "iMessage;-;+1",
		messageGuid: "M-1",
		from: "+1",
		text: "hi",
		isGroup: false,
		attachments: [],
		raw: {},
		...overrides,
	};
}

describe("combineDebounceEntries", () => {
	it("merges a URL text + its preview balloon, de-duping the shared URL", () => {
		const text = msg({ messageGuid: "TXT", text: "https://example.com" });
		const balloon = msg({
			messageGuid: "BALLOON",
			text: "https://example.com",
			associatedMessageGuid: "TXT",
			balloonBundleId: "com.apple.messages.URLBalloonProvider",
		});
		const merged = combineDebounceEntries([{ message: text }, { message: balloon }]);
		// The duplicate URL (echoed in the balloon) is collapsed to one.
		assert.equal(merged.text, "https://example.com");
		assert.equal(merged.messageGuid, "TXT");
		assert.equal(merged.balloonBundleId, undefined);
	});

	it("concatenates attachments and prefers the latest timestamp", () => {
		const a = msg({ messageGuid: "A", text: "one", timestampMs: 100, attachments: [{ guid: "att-a" }] });
		const b = msg({ messageGuid: "A", text: "two", timestampMs: 200, attachments: [{ guid: "att-b" }] });
		const merged = combineDebounceEntries([{ message: a }, { message: b }]);
		assert.equal(merged.text, "one two");
		assert.equal(merged.timestampMs, 200);
		assert.deepEqual(merged.attachments.map((x) => x.guid).sort(), ["att-a", "att-b"]);
	});

	it("chains deferred-media thunks so the merged message resolves all", async () => {
		const a = msg({ messageGuid: "A", text: "one", resolveMedia: async () => [{ kind: "image", path: "/a", fileName: "a" }] });
		const b = msg({ messageGuid: "A", text: "two", resolveMedia: async () => [{ kind: "video", path: "/b", fileName: "b" }] });
		const merged = combineDebounceEntries([{ message: a }, { message: b }]);
		assert.ok(merged.resolveMedia);
		const media = await merged.resolveMedia!();
		assert.equal(media.length, 2);
	});

	it("returns the single message unchanged when there is only one entry", () => {
		const only = msg({ messageGuid: "ONE", text: "solo" });
		const merged = combineDebounceEntries([{ message: only }]);
		assert.equal(merged, only);
	});
});

describe("resolveDebounceKey", () => {
	it("keys a balloon on its parent's associatedMessageGuid", () => {
		const balloon = msg({
			messageGuid: "BALLOON",
			associatedMessageGuid: "PARENT",
			balloonBundleId: "com.apple.messages.URLBalloonProvider",
		});
		assert.equal(resolveDebounceKey("acct", balloon), "acct:msg:PARENT");
	});

	it("keys a normal message on its messageGuid", () => {
		assert.equal(resolveDebounceKey("acct", msg({ messageGuid: "MID" })), "acct:msg:MID");
	});
});

describe("createBlueBubblesInboundDebouncer", () => {
	it("coalesces a URL text + its preview balloon into ONE dispatch", async () => {
		const out: BlueBubblesInboundMessage[] = [];
		const deb = createBlueBubblesInboundDebouncer({
			accountId: "acct",
			debounceMs: 30,
			dispatch: (m) => out.push(m),
		});
		deb.enqueue(msg({ messageGuid: "TXT", text: "https://x.test" }));
		deb.enqueue(
			msg({
				messageGuid: "BALLOON",
				text: "https://x.test",
				associatedMessageGuid: "TXT",
				balloonBundleId: "com.apple.messages.URLBalloonProvider",
			}),
		);
		// Nothing dispatched until the window elapses.
		assert.equal(out.length, 0);
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(out.length, 1, "two webhooks → one dispatch");
		assert.equal(out[0]!.text, "https://x.test");
	});

	it("coalesces a text + a split-out attachment (same messageGuid) into one dispatch", async () => {
		const out: BlueBubblesInboundMessage[] = [];
		const deb = createBlueBubblesInboundDebouncer({ accountId: "acct", debounceMs: 30, dispatch: (m) => out.push(m) });
		deb.enqueue(msg({ messageGuid: "SAME", text: "caption" }));
		deb.enqueue(msg({ messageGuid: "SAME", text: "", attachments: [{ guid: "img" }] }));
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(out.length, 1);
		assert.equal(out[0]!.text, "caption");
		assert.equal(out[0]!.attachments.length, 1);
	});

	it("dispatches two UNRELATED messages separately", async () => {
		const out: BlueBubblesInboundMessage[] = [];
		const deb = createBlueBubblesInboundDebouncer({ accountId: "acct", debounceMs: 20, dispatch: (m) => out.push(m) });
		deb.enqueue(msg({ messageGuid: "A", chatGuid: "iMessage;-;+1", from: "+1" }));
		deb.enqueue(msg({ messageGuid: "B", chatGuid: "iMessage;-;+2", from: "+2" }));
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(out.length, 2);
	});

	it("flushAll drains pending buffers immediately", () => {
		const out: BlueBubblesInboundMessage[] = [];
		const deb = createBlueBubblesInboundDebouncer({ accountId: "acct", debounceMs: 5_000, dispatch: (m) => out.push(m) });
		deb.enqueue(msg({ messageGuid: "P" }));
		assert.equal(out.length, 0);
		deb.flushAll();
		assert.equal(out.length, 1);
	});
});
