import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { connectBlueBubbles, type BlueBubblesInboundMessage } from "./connection.js";
import { clearBlueBubblesContactCache } from "./contact-names.js";
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
		allowPrivateNetwork: true,
		selfHandle: "",
		inboundDebounceMs: 0,
		historyLimit: 10,
		dmHistoryLimit: 0,
		mediaLocalRoots: [],
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

	it("enriches the sender's display name from the warmed contact directory", async () => {
		clearBlueBubblesContactCache();
		// A fetch that serves the contact directory for the warm + nothing else.
		const f = (async (url: string) => {
			const data = typeof url === "string" && url.includes("/contact")
				? [{ displayName: "Alex Rivera", phoneNumbers: [{ address: "+15551234567" }] }]
				: [];
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ status: 200, data }),
				headers: new Map() as unknown as Headers,
			} as unknown as Response;
		}) as unknown as typeof fetch;
		const got: Array<{ from: string; fromName?: string }> = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			fetchImpl: f,
			onMessage: (m) => got.push({ from: m.from, ...(m.fromName ? { fromName: m.fromName } : {}) }),
		});
		const payload = (guid: string) => ({
			data: { guid, text: "hi", chatGuid: "iMessage;-;+15551234567", handle: { address: "+15551234567" } },
		});
		// First message: cache is cold → raw handle, warm kicked off in background.
		conn.feedWebhookEvent("new-message", payload("C-1"));
		await new Promise((r) => setTimeout(r, 10)); // let the background warm complete
		// Second message: cache is warm → resolved display name.
		conn.feedWebhookEvent("new-message", payload("C-2"));
		assert.equal(got.length, 2);
		assert.equal(got[0]!.fromName, undefined);
		assert.equal(got[1]!.fromName, "Alex Rivera");
	});
});

describe("connection — inbound debounce / balloon-coalescing", () => {
	it("merges a URL message + its preview balloon into ONE dispatch when debounce is on", async () => {
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account({ inboundDebounceMs: 30 }),
			log: () => {},
			privateApi: true,
			onMessage: (m) => got.push(m),
		});
		// A URL message, then its link-preview balloon (separate webhook, associated to the text).
		conn.feedWebhookEvent("new-message", {
			data: { guid: "TXT", text: "https://example.com", chatGuid: "iMessage;-;+1", handle: { address: "+1" } },
		});
		conn.feedWebhookEvent("new-message", {
			data: {
				guid: "BALLOON",
				text: "https://example.com",
				chatGuid: "iMessage;-;+1",
				handle: { address: "+1" },
				associatedMessageGuid: "TXT",
				balloonBundleId: "com.apple.messages.URLBalloonProvider",
			},
		});
		assert.equal(got.length, 0, "buffered — nothing dispatched yet");
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(got.length, 1, "two webhooks coalesced into one turn");
		assert.equal(got[0]!.text, "https://example.com");
	});

	it("dispatches synchronously (no coalescing) when debounce is off (default)", () => {
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({ account: account(), log: () => {}, onMessage: (m) => got.push(m) });
		conn.feedWebhookEvent("new-message", {
			data: { guid: "S-1", text: "hi", chatGuid: "iMessage;-;+1", handle: { address: "+1" } },
		});
		assert.equal(got.length, 1);
	});
});

describe("connection — rolling group-history context", () => {
	/** A fetch that serves a history listing on chat message-list paths, [] elsewhere. */
	function historyServingFetch(history: unknown[], seen: string[]): typeof fetch {
		return (async (url: string) => {
			const u = String(url);
			seen.push(u);
			if (/\/chat\/.+\/messages?(\?|$)/.test(u) || /\/messages\?/.test(u)) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ status: 200, data: history }),
					headers: new Map() as unknown as Headers,
				} as unknown as Response;
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ status: 200, data: [] }), headers: new Map() as unknown as Headers } as unknown as Response;
		}) as unknown as typeof fetch;
	}

	it("attaches N prior messages as context to an untagged GROUP message", async () => {
		const seen: string[] = [];
		const f = historyServingFetch(
			[
				{ guid: "h1", text: "earlier one", dateCreated: 100, handle: { address: "+2" } },
				{ guid: "h2", text: "earlier two", dateCreated: 200, handle: { address: "+3" } },
			],
			seen,
		);
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account({ historyLimit: 5 }),
			log: () => {},
			fetchImpl: f,
			onMessage: (m) => got.push(m),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "G-NOW", text: "what did I miss", chatGuid: "iMessage;+;chatABC", handle: { address: "+9" } },
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(got.length, 1);
		assert.ok(got[0]!.text.includes("[recent conversation context]"), "context block prepended");
		assert.ok(got[0]!.text.includes("earlier one"), "prior message included");
		assert.ok(got[0]!.text.includes("what did I miss"), "current message preserved");
		assert.ok(seen.some((u) => /\/chat\//.test(u)), "fetched chat history");
	});

	it("does NOT attach history when disabled (historyLimit 0)", async () => {
		const seen: string[] = [];
		const f = historyServingFetch([{ guid: "h1", text: "earlier", dateCreated: 1, handle: { address: "+2" } }], seen);
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account({ historyLimit: 0 }),
			log: () => {},
			fetchImpl: f,
			onMessage: (m) => got.push(m),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "G2", text: "hello group", chatGuid: "iMessage;+;chatABC", handle: { address: "+9" } },
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(got.length, 1);
		assert.equal(got[0]!.text, "hello group", "no context block when disabled");
		assert.ok(!seen.some((u) => /\/chat\/.+\/messages?/.test(u)), "no history fetch when disabled");
	});

	it("a DM respects dmHistoryLimit (0 → no context by default)", async () => {
		const seen: string[] = [];
		const f = historyServingFetch([{ guid: "h1", text: "prior dm", dateCreated: 1, handle: { address: "+9" } }], seen);
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account({ historyLimit: 5, dmHistoryLimit: 0 }),
			log: () => {},
			fetchImpl: f,
			onMessage: (m) => got.push(m),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "D1", text: "hey there", chatGuid: "iMessage;-;+9", handle: { address: "+9" } },
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(got.length, 1);
		assert.equal(got[0]!.text, "hey there", "DM with dmHistoryLimit 0 gets no context");
	});

	it("a DM with dmHistoryLimit > 0 attaches context", async () => {
		const seen: string[] = [];
		const f = historyServingFetch([{ guid: "h1", text: "prior dm line", dateCreated: 1, handle: { address: "+9" } }], seen);
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account({ dmHistoryLimit: 3 }),
			log: () => {},
			fetchImpl: f,
			onMessage: (m) => got.push(m),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "D2", text: "follow up", chatGuid: "iMessage;-;+9", handle: { address: "+9" } },
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(got.length, 1);
		assert.ok(got[0]!.text.includes("prior dm line"), "DM context attached when dmHistoryLimit > 0");
	});
});

describe("connection — late-index attachment re-fetch (Fix 9)", () => {
	it("re-fetches a missing attachment for an image-only message and resolves the media", async () => {
		const seen: string[] = [];
		// A fetch that serves message/{guid} (now WITH an attachment) + the download.
		const f = (async (url: string) => {
			const u = String(url);
			seen.push(u);
			if (/\/message\/MSG-IMG\b/.test(u)) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ status: 200, data: { attachments: [{ guid: "ATT-1", transferName: "pic.png", mimeType: "image/png" }] } }),
					headers: new Headers(),
				} as unknown as Response;
			}
			if (/\/attachment\/ATT-1\/download/.test(u)) {
				return {
					ok: true,
					status: 200,
					arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
					text: async () => "",
					headers: new Headers({ "content-type": "image/png" }),
				} as unknown as Response;
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: {} }), headers: new Headers() } as unknown as Response;
		}) as unknown as typeof fetch;

		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			fetchImpl: f,
			attachmentRefetchDelayMs: 0,
			onMessage: (m) => got.push(m),
		});
		// Image-only message — empty text, NO attachments in the webhook. It is
		// normalised as an "empty message" skip + a media candidate; the connection
		// re-fetches in the background and dispatches once the media indexes.
		conn.feedWebhookEvent("new-message", {
			data: { guid: "MSG-IMG", text: "", chatGuid: "iMessage;-;+1", handle: { address: "+1" } },
		});
		// Let the background re-fetch + dispatch settle.
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(got.length, 1, "the late-indexed media message was dispatched");
		const inbound = got[0]!;
		assert.ok(seen.some((u) => /\/message\/MSG-IMG/.test(u)), "re-fetched the message by guid");
		assert.ok(inbound.resolveMedia, "the dispatched message carries a deferred-media thunk");
		const media = await inbound.resolveMedia!();
		assert.equal(media.length, 1, "the late-indexed attachment resolved");
	});

	it("does NOT dispatch when the re-fetch finds no media (no agent spam)", async () => {
		// Server still reports zero attachments after the delay → truly empty.
		const f = (async (url: string) => {
			void url;
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ status: 200, data: { attachments: [] } }),
				headers: new Headers(),
			} as unknown as Response;
		}) as unknown as typeof fetch;
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			fetchImpl: f,
			attachmentRefetchDelayMs: 0,
			onMessage: (m) => got.push(m),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "MSG-EMPTY", text: "", chatGuid: "iMessage;-;+1", handle: { address: "+1" } },
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(got.length, 0, "a genuinely empty message is never dispatched");
	});

	it("does NOT attach a re-fetch thunk for a normal text message with no media", () => {
		const got: BlueBubblesInboundMessage[] = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			fetchImpl: (async () => ({ ok: true, status: 200, text: async () => "{}", headers: new Headers() })) as unknown as typeof fetch,
			onMessage: (m) => got.push(m),
		});
		conn.feedWebhookEvent("new-message", {
			data: { guid: "MSG-TXT", text: "just text", chatGuid: "iMessage;-;+1", handle: { address: "+1" } },
		});
		assert.equal(got.length, 1);
		assert.equal(got[0]!.resolveMedia, undefined, "no media expected → no re-fetch");
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

	it("strips internal directive tags / role markers from outbound text before the wire", async () => {
		const rec: Array<{ url: string; body: unknown; isForm: boolean }> = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		await conn.sendText("chat_guid:iMessage;-;+1", "<think>plan</think>Here you go [[reply_to_current]] assistant to=final");
		const textPosts = rec.filter((r) => /message\/text/.test(r.url));
		assert.equal(textPosts.length, 1);
		const msg = String((textPosts[0]!.body as Record<string, unknown>).message ?? "");
		assert.ok(!msg.includes("<think>"), "reasoning stripped");
		assert.ok(!msg.includes("[["), "directive tag stripped");
		assert.ok(!/assistant\s+to\s*=\s*final/i.test(msg), "role marker stripped");
		assert.ok(msg.includes("Here you go"), `kept the visible reply, got: ${JSON.stringify(msg)}`);
	});

	it("refuses edit on macOS 26+ and proceeds on macOS 15", async () => {
		const rec: Array<{ url: string; body: unknown; isForm: boolean }> = [];
		// macOS 26 host → edit refused cleanly, no REST call made.
		const conn26 = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			macOSMajor: 26,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		await assert.rejects(() => conn26.edit({ messageId: "M-1", text: "fixed" }), /macOS 26/);
		assert.equal(rec.filter((r) => /\/edit/.test(r.url)).length, 0, "no edit REST call on macOS 26");

		// macOS 15 host → edit proceeds to the REST call.
		const conn15 = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			macOSMajor: 15,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		await conn15.edit({ messageId: "M-1", text: "fixed" });
		assert.equal(rec.filter((r) => /\/edit/.test(r.url)).length, 1, "edit REST call made on macOS 15");
	});

	it("mediaLocalRoots: rejects an attachment outside the allowed roots, accepts one inside", async () => {
		const allowedDir = mkdtempSync(path.join(os.tmpdir(), "bb-roots-ok-"));
		const otherDir = mkdtempSync(path.join(os.tmpdir(), "bb-roots-no-"));
		const inside = path.join(allowedDir, "ok.png");
		const outside = path.join(otherDir, "nope.png");
		writeFileSync(inside, "x");
		writeFileSync(outside, "x");
		const rec: Array<{ url: string; body: unknown; isForm: boolean }> = [];
		const conn = connectBlueBubbles({
			account: account({ mediaLocalRoots: [allowedDir] }),
			log: () => {},
			privateApi: true,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		// Outside the allow-list → refused, no upload.
		await assert.rejects(
			() => conn.sendMedia("chat_guid:iMessage;-;+1", { kind: "image", path: outside }),
			/outside the allowed media roots/,
		);
		assert.equal(rec.filter((r) => r.isForm).length, 0, "no upload for the rejected path");
		// Inside the allow-list → proceeds.
		await conn.sendMedia("chat_guid:iMessage;-;+1", { kind: "image", path: inside });
		assert.equal(rec.filter((r) => r.isForm).length, 1, "allowed path uploaded");
	});

	it("voice send: rejects a non-mp3/caf file fast and accepts an mp3", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "bb-conn-voice-"));
		const wav = path.join(dir, "clip.wav");
		const mp3 = path.join(dir, "memo.mp3");
		writeFileSync(wav, "x");
		writeFileSync(mp3, "x");
		const rec: Array<{ url: string; body: unknown; isForm: boolean }> = [];
		const conn = connectBlueBubbles({
			account: account(),
			log: () => {},
			privateApi: true,
			onMessage: () => {},
			fetchImpl: recordingFetch(rec),
		});
		// A .wav as voice fails fast — no upload happens.
		await assert.rejects(() => conn.sendMedia("chat_guid:iMessage;-;+1", { kind: "voice", path: wav }), /mp3 or caf/);
		assert.equal(rec.filter((r) => r.isForm).length, 0, "no upload for the rejected voice file");
		// A .mp3 as voice proceeds to the attachment upload.
		await conn.sendMedia("chat_guid:iMessage;-;+1", { kind: "voice", path: mp3 });
		assert.equal(rec.filter((r) => r.isForm).length, 1, "mp3 voice uploaded");
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
