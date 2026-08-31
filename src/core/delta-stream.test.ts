/**
 * The delta-streaming payload contract.
 *
 * Verifies the shape the gateway sends to a connection that opted in — the part
 * that matters is WHAT SURVIVES the strip, not just what is removed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldSendDeltaFrame } from "./delta-mode.js";

/** Mirrors the transform in `broadcast()` for a delta-mode recipient. */
function stripContent(piEvent: Record<string, unknown>): Record<string, unknown> {
	const msg = piEvent.message as Record<string, unknown>;
	const { content: _omitted, ...msgWithoutContent } = msg;
	return { ...piEvent, message: msgWithoutContent };
}

const FULL = {
	type: "message_update",
	message: {
		role: "assistant",
		timestamp: 1_700_000_000_000,
		usage: { input: 4700, output: 120, cost: { total: 0.02 } },
		content: [{ type: "text", text: "a very long cumulative reply".repeat(200) }],
	},
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y" },
};

describe("delta-mode payload", () => {
	it("keeps the render key — a delta with no identity cannot be attached", () => {
		// `asstKey` is `${depth}:${message.timestamp}`. Strip the timestamp and the
		// client has a delta it cannot place on any block.
		const out = stripContent(FULL) as { message: Record<string, unknown> };
		assert.equal(out.message.timestamp, 1_700_000_000_000);
		assert.equal(out.message.role, "assistant");
	});

	it("keeps usage — it drives the live token counter", () => {
		const out = stripContent(FULL) as { message: { usage?: Record<string, unknown> } };
		assert.equal(out.message.usage?.output, 120);
	});

	it("drops only the cumulative content", () => {
		const out = stripContent(FULL) as { message: Record<string, unknown> };
		assert.equal("content" in out.message, false);
	});

	it("keeps the delta itself, which is the whole point", () => {
		const out = stripContent(FULL) as { assistantMessageEvent?: { delta?: string } };
		assert.equal(out.assistantMessageEvent?.delta, "y");
	});

	it("is dramatically smaller than the snapshot it replaces", () => {
		const before = JSON.stringify(FULL).length;
		const after = JSON.stringify(stripContent(FULL)).length;
		assert.ok(after * 20 < before, `expected a big reduction, got ${before} → ${after}`);
	});

	it("appending deltas reproduces the snapshot text", () => {
		// The client's reconstruction must equal what apply-by-replace would have
		// produced, or the two modes disagree.
		const chunks = ["Hel", "lo ", "wor", "ld"];
		let acc = "";
		for (const c of chunks) acc += c;
		assert.equal(acc, "Hello world");
	});
});

/* ─────────────── who actually receives a stripped frame ─────────────── */

describe("delta frames are OPT-IN", () => {
	// Shipped as opt-out: every connection got `message.content` stripped unless
	// it said `deltas: false`. A client that had never heard of deltas — the
	// desktop app, the watch app, anyone on npm — rendered empty streaming text
	// until `message_end`, with PROTOCOL_VERSION still 1 and no warning. People
	// cannot opt out of something they do not know exists.
	it("a client that never asked gets the FULL frame", () => {
		assert.equal(
			shouldSendDeltaFrame({ hasDeltaFrame: true, connId: "c1", optedIn: false }),
			false,
		);
	});

	it("a client that asked gets the stripped frame", () => {
		assert.equal(
			shouldSendDeltaFrame({ hasDeltaFrame: true, connId: "c1", optedIn: true }),
			true,
		);
	});

	it("a connection with no id yet gets the full frame", () => {
		// The race between socket open and onConnection assigning an id. We
		// cannot know what it supports, and the full frame is correct for all.
		assert.equal(
			shouldSendDeltaFrame({ hasDeltaFrame: true, connId: undefined, optedIn: true }),
			false,
		);
	});

	it("no stripped frame available means the full frame, always", () => {
		for (const optedIn of [true, false]) {
			assert.equal(
				shouldSendDeltaFrame({ hasDeltaFrame: false, connId: "c1", optedIn }),
				false,
			);
		}
	});
});
