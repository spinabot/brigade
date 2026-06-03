import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	REMINDER_CONTEXT_MARKER,
	REMINDER_CONTEXT_MESSAGES_MAX,
	REMINDER_CONTEXT_PER_MESSAGE_MAX,
	REMINDER_CONTEXT_TOTAL_MAX,
	buildReminderContextLines,
	extractTextFromChatContent,
	maybeAttachReminderContext,
	stripExistingContext,
	truncateText,
} from "./reminder-context.js";

function makeMessages(rows: Array<{ role: string; text: string }>): Array<unknown> {
	return rows.map((r) => ({ role: r.role, content: r.text }));
}

function stubGateway(response: { messages: ReadonlyArray<unknown> }) {
	return async <T>(opts: { method: string; params?: unknown }): Promise<T> => {
		void opts;
		return response as unknown as T;
	};
}

describe("reminder-context — degrade cases", () => {
	it("returns [] when agentSessionKey is empty / whitespace", async () => {
		const lines = await buildReminderContextLines({
			contextMessages: 5,
			agentSessionKey: "   ",
		});
		assert.deepEqual(lines, []);
	});

	it("returns [] when agentSessionKey is undefined", async () => {
		const lines = await buildReminderContextLines({ contextMessages: 5 });
		assert.deepEqual(lines, []);
	});

	it("returns [] when contextMessages <= 0", async () => {
		const lines = await buildReminderContextLines({
			contextMessages: 0,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages: [{ role: "user", content: "hi" }] }),
		});
		assert.deepEqual(lines, []);
	});

	it("returns [] when callGateway throws (silent degrade)", async () => {
		const lines = await buildReminderContextLines({
			contextMessages: 3,
			agentSessionKey: "main",
			callGateway: async () => {
				throw new Error("transport failed");
			},
		});
		assert.deepEqual(lines, []);
	});
});

describe("reminder-context — clamp + caps", () => {
	it("clamps contextMessages above MAX to MAX", async () => {
		const messages = makeMessages(
			Array.from({ length: 50 }).map((_, i) => ({ role: "user", text: `msg ${i}` })),
		);
		const lines = await buildReminderContextLines({
			contextMessages: 100,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages }),
		});
		// Cap: at most MAX lines (10) — also bounded by total-char cap.
		assert.equal(lines.length <= REMINDER_CONTEXT_MESSAGES_MAX, true);
	});

	it("filters out non-user / non-assistant roles", async () => {
		const messages = [
			{ role: "user", content: "hi" },
			{ role: "system", content: "init" },
			{ role: "tool", content: "result" },
			{ role: "assistant", content: "hello" },
		];
		const lines = await buildReminderContextLines({
			contextMessages: 10,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages }),
		});
		assert.equal(lines.length, 2);
		assert.equal(lines[0]!.startsWith("- User: "), true);
		assert.equal(lines[1]!.startsWith("- Assistant: "), true);
	});

	it("respects 700-char total cap (drops overflowing line, does not partially include)", async () => {
		const bigText = "x".repeat(REMINDER_CONTEXT_PER_MESSAGE_MAX);
		const messages = makeMessages(
			Array.from({ length: 10 }).map(() => ({ role: "user", text: bigText })),
		);
		const lines = await buildReminderContextLines({
			contextMessages: 10,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages }),
		});
		const total = lines.join("\n").length;
		assert.equal(total <= REMINDER_CONTEXT_TOTAL_MAX, true);
	});

	it("truncates per-message at 220 chars with `...` suffix", async () => {
		const longText = "x".repeat(500);
		const messages = makeMessages([{ role: "user", text: longText }]);
		const lines = await buildReminderContextLines({
			contextMessages: 1,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages }),
		});
		assert.equal(lines.length, 1);
		const line = lines[0]!;
		assert.equal(line.endsWith("..."), true);
		// "- User: " prefix is 8 chars; total at most prefix + 220.
		assert.equal(line.length <= 8 + REMINDER_CONTEXT_PER_MESSAGE_MAX, true);
	});
});

describe("reminder-context — content extraction", () => {
	it("extractTextFromChatContent handles plain string", () => {
		assert.equal(extractTextFromChatContent("hello world"), "hello world");
	});

	it("extractTextFromChatContent handles array of text blocks", () => {
		const out = extractTextFromChatContent([
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		]);
		assert.equal(out, "hello world");
	});

	it("extractTextFromChatContent normalizes whitespace", () => {
		assert.equal(
			extractTextFromChatContent("hello   world\n\t  again"),
			"hello world again",
		);
	});

	it("extractTextFromChatContent returns null for image / tool_use blocks", () => {
		const out = extractTextFromChatContent([
			{ type: "image", source: { type: "base64", data: "x" } },
		]);
		assert.equal(out, null);
	});

	it("extractTextFromChatContent returns null for empty / whitespace string", () => {
		assert.equal(extractTextFromChatContent(""), null);
		assert.equal(extractTextFromChatContent("   "), null);
	});
});

describe("reminder-context — stripExistingContext idempotency", () => {
	it("returns input unchanged when no marker present", () => {
		assert.equal(stripExistingContext("Just a reminder"), "Just a reminder");
	});

	it("strips marker + everything after on first call", () => {
		const input = `Reminder${REMINDER_CONTEXT_MARKER}- User: hi`;
		assert.equal(stripExistingContext(input), "Reminder");
	});

	it("is idempotent — calling twice yields the same base text", () => {
		const input = `Reminder${REMINDER_CONTEXT_MARKER}- User: hi`;
		const once = stripExistingContext(input);
		const twice = stripExistingContext(once);
		assert.equal(once, twice);
	});
});

describe("reminder-context — truncateText UTF-16 safety", () => {
	it("does not split a surrogate pair", () => {
		const s = "x".repeat(217) + "\u{1F600}"; // 217 chars + 2-code-unit emoji = 219
		const out = truncateText(s + s, 220);
		// "..." appended; must not end in a lone high surrogate.
		assert.equal(out.endsWith("..."), true);
		const beforeEllipsis = out.slice(0, -3);
		const last = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1);
		assert.equal(last >= 0xd800 && last <= 0xdbff, false);
	});
});

describe("maybeAttachReminderContext — payload-shape gates", () => {
	it("returns input unchanged for agentTurn payload (no marker pollution)", async () => {
		const job = {
			name: "j",
			schedule: { kind: "at", at: 0 },
			sessionTarget: "isolated",
			payload: { kind: "agentTurn", message: "run a task" },
		};
		const out = await maybeAttachReminderContext({
			job,
			contextMessages: 5,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages: makeMessages([{ role: "user", text: "hi" }]) }),
		});
		assert.equal(out, job);
	});

	it("returns input unchanged for systemEvent with empty text", async () => {
		const job = {
			name: "j",
			payload: { kind: "systemEvent", text: "   " },
		};
		const out = await maybeAttachReminderContext({
			job,
			contextMessages: 5,
			agentSessionKey: "main",
			callGateway: stubGateway({ messages: makeMessages([{ role: "user", text: "hi" }]) }),
		});
		assert.equal(out, job);
	});

	it("appends context marker + lines for valid systemEvent", async () => {
		const job = {
			name: "j",
			payload: { kind: "systemEvent", text: "Time to stretch." },
		};
		const out = await maybeAttachReminderContext({
			job,
			contextMessages: 2,
			agentSessionKey: "main",
			callGateway: stubGateway({
				messages: makeMessages([
					{ role: "user", text: "how's it going" },
					{ role: "assistant", text: "fine, you?" },
				]),
			}),
		});
		const payload = (out.payload as { text: string }).text;
		assert.equal(payload.includes(REMINDER_CONTEXT_MARKER), true);
		assert.equal(payload.includes("- User: how's it going"), true);
		assert.equal(payload.includes("- Assistant: fine, you?"), true);
	});

	it("is idempotent — re-attaching replaces (not duplicates) the context block", async () => {
		const cb = stubGateway({
			messages: makeMessages([{ role: "user", text: "hi" }]),
		});
		const job1 = {
			name: "j",
			payload: { kind: "systemEvent", text: "Reminder text" },
		};
		const out1 = await maybeAttachReminderContext({
			job: job1,
			contextMessages: 1,
			agentSessionKey: "main",
			callGateway: cb,
		});
		const out2 = await maybeAttachReminderContext({
			job: out1,
			contextMessages: 1,
			agentSessionKey: "main",
			callGateway: cb,
		});
		const payload = (out2.payload as { text: string }).text;
		// Marker should appear exactly once.
		const occurrences = payload.split(REMINDER_CONTEXT_MARKER).length - 1;
		assert.equal(occurrences, 1);
		// And base text is preserved on top.
		assert.equal(payload.startsWith("Reminder text"), true);
	});
});
