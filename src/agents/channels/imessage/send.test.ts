import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { IMessageRpcLike } from "./client.js";
import { sendMessageIMessage } from "./send.js";

/** A fake RPC client that records the last `send` params and returns a canned result. */
class FakeRpcClient implements IMessageRpcLike {
	lastMethod: string | null = null;
	lastParams: Record<string, unknown> | null = null;
	stopped = false;
	constructor(private readonly result: Record<string, unknown> = { message_id: "M-1" }) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.lastMethod = method;
		this.lastParams = (params ?? {}) as Record<string, unknown>;
		return this.result as T;
	}
	async waitForClose(): Promise<void> {}
}

describe("sendMessageIMessage", () => {
	it("sends to a phone handle with default auto service", async () => {
		const client = new FakeRpcClient();
		const res = await sendMessageIMessage("+15551234567", "hello", { client });
		assert.equal(res.messageId, "M-1");
		assert.equal(res.sentText, "hello");
		assert.equal(client.lastMethod, "send");
		assert.equal(client.lastParams?.to, "+15551234567");
		assert.equal(client.lastParams?.service, "auto");
		assert.equal(client.lastParams?.text, "hello");
		// An injected client is NOT stopped by send.
		assert.equal(client.stopped, false);
	});

	// THE CASE THE ORIGINAL PREFIX TEST MISSED.
	//
	// The test below passes no `opts.service`, so the old
	// `opts.service ?? target.service` fell through to the prefix and looked
	// right. Production ALWAYS passes `opts.service` — `account.service` is a
	// required field that `coerceIMessageService` defaults to "auto" — so the
	// left side never fell through and every prefix was silently discarded.
	it("a service prefix beats the account default", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("sms:+15551234567", "hi", { client, service: "imessage" });
		assert.equal(client.lastParams?.service, "sms");
	});

	it("an explicit auto: prefix beats an account pinned to sms", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("auto:+15551234567", "hi", { client, service: "sms" });
		assert.equal(client.lastParams?.service, "auto");
	});

	it("a bare handle still takes the account default", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("+15551234567", "hi", { client, service: "sms" });
		assert.equal(client.lastParams?.service, "sms");
	});

	it("inherits the service from a service-prefixed handle", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("sms:+15551234567", "hi", { client });
		assert.equal(client.lastParams?.service, "sms");
		assert.equal(client.lastParams?.to, "+15551234567");
	});

	it("routes a chat_id target to the chat_id param", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("chat_id:42", "yo", { client });
		assert.equal(client.lastParams?.chat_id, 42);
		assert.equal(client.lastParams?.to, undefined);
	});

	it("routes a chat_guid target", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("chat_guid:G-1", "yo", { client });
		assert.equal(client.lastParams?.chat_guid, "G-1");
	});

	it("routes a chat_identifier target", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("chat_identifier:ID-1", "yo", { client });
		assert.equal(client.lastParams?.chat_identifier, "ID-1");
	});

	it("opts.chatId wins over the `to` string", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("+15551234567", "yo", { client, chatId: 9 });
		assert.equal(client.lastParams?.chat_id, 9);
		assert.equal(client.lastParams?.to, undefined);
	});

	it("strips an inline directive tag from the body before the wire call", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("+15551234567", "Sure thing [[reply_to_current]] here you go", { client });
		const sent = String(client.lastParams?.text ?? "");
		assert.ok(!sent.includes("[["), `directive tag stripped, got: ${JSON.stringify(sent)}`);
		assert.ok(sent.includes("Sure thing") && sent.includes("here you go"));
	});

	it("strips a leaked role-scaffolding marker from the body", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("+15551234567", "Hello assistant to=final there", { client });
		const sent = String(client.lastParams?.text ?? "");
		assert.ok(!/assistant\s+to\s*=\s*final/i.test(sent), `role marker stripped, got: ${JSON.stringify(sent)}`);
		assert.ok(sent.includes("Hello") && sent.includes("there"));
	});

	it("strips <think> reasoning residue from the body", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("+15551234567", "<think>internal</think>The answer is 42.", { client });
		const sent = String(client.lastParams?.text ?? "");
		assert.equal(sent, "The answer is 42.");
	});

	it("includes a sanitized reply_to", async () => {
		const client = new FakeRpcClient();
		await sendMessageIMessage("+15551234567", "re", { client, replyToId: "  msg[1]  " });
		assert.equal(client.lastParams?.reply_to, "msg1");
	});

	it("flattens a markdown table to plain text", async () => {
		const client = new FakeRpcClient();
		const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
		await sendMessageIMessage("+15551234567", table, { client });
		const sent = String(client.lastParams?.text ?? "");
		assert.ok(!sent.includes("---"), "separator row dropped");
		assert.ok(sent.includes("a | b"), "header flattened");
		assert.ok(sent.includes("1 | 2"), "row flattened");
	});

	it("attaches media + emits a <media:kind> placeholder when text is empty", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "imsg-media-"));
		const file = path.join(dir, "pic.png");
		writeFileSync(file, "x");
		const client = new FakeRpcClient();
		const res = await sendMessageIMessage("+15551234567", "", { client, mediaPath: file });
		assert.equal(client.lastParams?.file, path.resolve(file));
		assert.equal(client.lastParams?.text, "<media:image>");
		assert.equal(res.sentText, "<media:image>");
	});

	it("throws when neither text nor media is provided", async () => {
		const client = new FakeRpcClient();
		await assert.rejects(() => sendMessageIMessage("+15551234567", "", { client }), /requires text or media/);
	});

	it("constructs + stops a client via the injected factory when none is passed", async () => {
		const created = new FakeRpcClient();
		const res = await sendMessageIMessage("+15551234567", "hi", {
			createClient: async () => created,
		});
		assert.equal(res.messageId, "M-1");
		// A client WE created is stopped in the finally.
		assert.equal(created.stopped, true);
	});

	afterEach(() => {
		/* tmp dirs are left for the OS to reap; no global state to reset */
	});
});

/* ─────────────────────────────────────────────────────────────────────────
 * A send is not successful because it returned.
 *
 * The transport rejects on a JSON-RPC `error` member, so this code only ever
 * sees a 200-shaped answer — but the bridge reports a refused send INSIDE the
 * result. `{ok:false, error:"no such handle"}` fell through to
 * `messageId:"unknown"`, which every caller reads as success, so an
 * undeliverable message was reported delivered.
 * ───────────────────────────────────────────────────────────────────────── */

describe("sendMessageIMessage — refuses to claim an unconfirmed delivery", () => {
	const clientReturning = (result: unknown) => ({
		request: async () => result,
		stop: async () => {},
	});

	it("throws when the bridge refuses the send", async () => {
		await assert.rejects(
			() => sendMessageIMessage("+16464201739", "hi", { client: clientReturning({ ok: false, error: "no such handle" }) as never }),
			/no such handle/,
		);
	});

	it("throws when the result carries an error string", async () => {
		await assert.rejects(
			() => sendMessageIMessage("+16464201739", "hi", { client: clientReturning({ error: "not signed in" }) as never }),
			/not signed in/,
		);
	});

	it("throws when nothing acknowledges the send", async () => {
		// No id, no ack. Absence of evidence is not evidence of delivery.
		await assert.rejects(
			() => sendMessageIMessage("+16464201739", "hi", { client: clientReturning({}) as never }),
			/not confirmed/,
		);
	});

	it("accepts a real message id", async () => {
		const r = await sendMessageIMessage("+16464201739", "hi", { client: clientReturning({ messageId: "ABC-123" }) as never });
		assert.equal(r.messageId, "ABC-123");
	});

	it("accepts a positive acknowledgement without an id", async () => {
		const r = await sendMessageIMessage("+16464201739", "hi", { client: clientReturning({ ok: true }) as never });
		assert.equal(r.messageId, "ok");
	});
});

// ─────────────────────────────────────────────────────────────────────────
// A reply that cannot be threaded is still a reply.
//
// `reply_to` needs the bridge transport; the AppleScript fallback rejects it,
// and that used to kill the whole send. The message it cost most often is the
// pairing challenge — the one that tells a new sender how to get authorised —
// so losing it leaves them messaging into silence with no way to find out why.
// Observed live: "sendText failed … reply_to requires bridge transport".
// ─────────────────────────────────────────────────────────────────────────
describe("sendMessageIMessage — threaded-reply fallback", () => {
	class ReplyRejectingClient implements IMessageRpcLike {
		attempts: Array<Record<string, unknown>> = [];
		constructor(private readonly message: string) {}
		async start(): Promise<void> {}
		async stop(): Promise<void> {}
		async request<T = unknown>(_m: string, params?: unknown): Promise<T> {
			const p = (params ?? {}) as Record<string, unknown>;
			// Snapshot: the sender reuses one params object across the retry, so
			// recording the reference would show both attempts as the second one.
			this.attempts.push({ ...p });
			if (p.reply_to !== undefined) throw new Error(this.message);
			return { message_id: "M-9" } as T;
		}
		async waitForClose(): Promise<void> {}
	}

	it("retries flat when the transport cannot thread", async () => {
		const client = new ReplyRejectingClient(
			"Invalid params: code=-32602 reply_to requires bridge transport; AppleScript fallback cannot send threaded replies",
		);
		const res = await sendMessageIMessage("+15551234567", "you need to pair", {
			client,
			replyToId: "p:1",
		});
		assert.equal(res.messageId, "M-9", "the reply still went out");
		assert.equal(client.attempts.length, 2, "threaded first, then flat");
		assert.equal(client.attempts[0]?.reply_to, "p:1");
		assert.equal(client.attempts[1]?.reply_to, undefined);
		assert.equal(client.attempts[1]?.text, "you need to pair", "same message, unthreaded");
	});

	it("does NOT retry a send the bridge refused for a real reason", async () => {
		// Re-sending something the bridge already refused is worse than not
		// sending it, so the fallback is narrow on purpose.
		const client = new ReplyRejectingClient("no such handle");
		await assert.rejects(
			() => sendMessageIMessage("+15551234567", "hi", { client, replyToId: "p:1" }),
			/no such handle/,
		);
		assert.equal(client.attempts.length, 1, "failed once, did not retry");
	});

	// Error shapes the narrow first version missed. OpenClaw's equivalent
	// predicate matches all of these against the same `imsg` binary.
	for (const msg of [
		"cannot send threaded replies",
		"threaded replies are unavailable",
		"threaded reply not supported on this transport",
		"requires bridge transport",
	]) {
		it(`recognises: ${msg}`, async () => {
			const client = new ReplyRejectingClient(msg);
			const res = await sendMessageIMessage("+15551234567", "hi", { client, replyToId: "p:1" });
			assert.equal(res.messageId, "M-9", "fell back to a flat send");
			assert.equal(client.attempts.length, 2);
		});
	}

	it("does not retry when there was no reply_to to drop", async () => {
		const client = new ReplyRejectingClient("reply_to requires bridge transport");
		const res = await sendMessageIMessage("+15551234567", "hi", { client });
		assert.equal(res.messageId, "M-9");
		assert.equal(client.attempts.length, 1);
	});
});
