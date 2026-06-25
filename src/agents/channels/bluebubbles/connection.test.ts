import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { connectBlueBubbles } from "./connection.js";
import type { ResolvedBlueBubblesAccount } from "./account-config.js";

const PASSWORD = ["conn", "bb", "pw"].join("-");

function account(overrides: Partial<ResolvedBlueBubblesAccount> = {}): ResolvedBlueBubblesAccount {
	return {
		accountId: "default",
		enabled: true,
		serverUrl: "http://10.0.0.1:1234",
		password: PASSWORD,
		webhookPath: "/bluebubbles/webhook",
		region: "US",
		mediaMaxBytes: 100 * 1024 * 1024,
		probeTimeoutMs: 5000,
		actions: { reactions: true, edit: true, unsend: true, effects: true, groupAdmin: true },
		verbose: false,
		...overrides,
	};
}

/** A fetch that records each request URL + JSON body and returns a guid. */
function recordingFetch(rec: Array<{ url: string; body: unknown; isForm: boolean }>): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		let body: unknown = null;
		let isForm = false;
		if (typeof init.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		} else if (init.body instanceof FormData) {
			isForm = true;
			body = "<form>";
		}
		rec.push({ url, body, isForm });
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ data: { guid: "OUT-1" } }),
			headers: new Map() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("connection — inbound webhook feed", () => {
	it("normalizes + dispatches a new-message via onMessage", () => {
		const got: string[] = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			onMessage: (m) => got.push(m.text),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "M-1", text: "hi", chatGuid: "iMessage;-;+1", handle: { address: "+1" } },
		});
		assert.deepEqual(got, ["hi"]);
	});

	it("drops a duplicate (same guid)", () => {
		const got: string[] = [];
		const conn = connectBlueBubbles({ account: account(), log: () => {}, onMessage: (m) => got.push(m.text) });
		const payload = { data: { guid: "DUP", text: "x", chatGuid: "iMessage;-;+1", handle: { address: "+1" } } };
		conn.feedWebhookEvent("new-message", payload);
		conn.feedWebhookEvent("new-message", payload);
		assert.equal(got.length, 1);
	});

	it("drops a tapback message and surfaces it via onTapback", () => {
		const got: string[] = [];
		const tapbacks: string[] = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			onMessage: (m) => got.push(m.text),
			onTapback: (t) => tapbacks.push(`${t.action}:${t.emoji}`),
		});
		conn.feedWebhookEvent("new-message", {
			data: {
				guid: "T-1",
				text: "Liked",
				chatGuid: "iMessage;-;+1",
				handle: { address: "+1" },
				associatedMessageType: 2000,
				associatedMessageGuid: "ORIG",
			},
		});
		assert.equal(got.length, 0);
		assert.deepEqual(tapbacks, ["added:❤️"]);
	});

	it("skips isFromMe", () => {
		const got: string[] = [];
		const conn = connectBlueBubbles({ account: account(), log: () => {}, onMessage: (m) => got.push(m.text) });
		conn.feedWebhookEvent("new-message", {
			data: { guid: "MINE", text: "x", isFromMe: true, chatGuid: "iMessage;-;+1" },
		});
		assert.equal(got.length, 0);
	});
});

describe("connection — outbound", () => {
	it("bubble-splits text into N text POSTs", async () => {
		const rec: Array<{ url: string; body: unknown; isForm: boolean }> = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		await conn.sendText("chat_guid:iMessage;-;+1", "para one\n\npara two");
		const textPosts = rec.filter((r) => /message\/text/.test(r.url));
		assert.equal(textPosts.length, 2);
		assert.equal((textPosts[0]!.body as Record<string, unknown>).message, "para one");
		assert.equal((textPosts[1]!.body as Record<string, unknown>).message, "para two");
	});

	it("sends media then a SEPARATE caption bubble after", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "bb-conn-"));
		const file = path.join(dir, "pic.png");
		writeFileSync(file, "x");
		const rec: Array<{ url: string; body: unknown; isForm: boolean }> = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		await conn.sendMedia("chat_guid:iMessage;-;+1", { kind: "image", path: file, caption: "look at this" });
		const attachPosts = rec.filter((r) => r.isForm);
		const textPosts = rec.filter((r) => /message\/text/.test(r.url));
		assert.equal(attachPosts.length, 1, "one attachment upload");
		assert.equal(textPosts.length, 1, "one separate caption bubble");
		assert.equal((textPosts[0]!.body as Record<string, unknown>).message, "look at this");
	});
});
