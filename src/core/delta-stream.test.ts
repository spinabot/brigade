/**
 * The delta-streaming payload contract.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE CAN AND CANNOT PIN
 * ─────────────────────────────────────────────────────────────────────────
 * The PRODUCER — the transform that removes `message.content` for a delta-mode
 * recipient — is written inline inside `broadcast()` in `src/core/server.ts`
 * (search: `const { content: _omitted, ...msgWithoutContent }`). It is not
 * exported and there is no seam to reach it, so no test can call it.
 *
 * The previous version of this file papered over that by declaring its own
 * `stripContent()` and asserting against THAT. It was a copy, not the code:
 * it stripped a bare pi event rather than rebuilding the `{type, event,
 * payload:{event}}` frame production actually sends, and it printed a `freed
 * 118000 tokens`-style shape production never emits. Deleting the real strip
 * from `server.ts` would not have failed a single assertion in it.
 *
 * So this file now tests the two halves that ARE reachable:
 *
 *   1. `shouldSendDeltaFrame` — WHO gets a stripped frame (real import).
 *   2. The CONSUMER — the reconstruction in `connect.ts` that turns a
 *      content-less `message_update` back into rendered text, driven through
 *      the real `wireConnectUi` against a fake terminal + gateway. This is
 *      what "what survives the strip" actually means to an operator: if the
 *      strip removed the render key, or the client stopped appending, the
 *      screen goes blank until `message_end`.
 *
 * To pin the producer as well, `server.ts` needs the transform lifted into an
 * exported function (the natural home is `./delta-mode.ts`, e.g.
 * `stripCumulativeContent(frame)`); that is a production change and is
 * deliberately not made here.
 */
import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";

import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui";

import { shouldSendDeltaFrame, stripCumulativeContent } from "./delta-mode.js";
import { asstKey } from "../cli/commands/connect-transcript.js";
import { wireConnectUi } from "../cli/commands/connect.js";
import type { BrigadeClient } from "../tui/client.js";
import type { SessionStateSnapshot } from "../protocol.js";

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

/* ─────────────── the render key the strip must not remove ─────────────── */

describe("the render key a delta is attached by", () => {
	// The strip keeps `role` and `timestamp` for exactly one reason: the client
	// keys the streaming block on `${depth}:${message.timestamp}`. This is the
	// real function it keys with.
	it("two deltas of the same message land on the same block", () => {
		const msg = { role: "assistant", timestamp: 1_700_000_000_000 };
		assert.equal(asstKey(0, msg), asstKey(0, { ...msg }));
	});

	it("a frame that lost its timestamp collapses onto a shared key", () => {
		// Not an error — a fallback. Which is why removing the timestamp is not a
		// harmless byte saving: two concurrent messages would then share a block
		// and overwrite each other.
		assert.equal(asstKey(0, {}), asstKey(0, { timestamp: undefined }));
		assert.notEqual(asstKey(0, { timestamp: 1 }), asstKey(0, {}));
	});

	it("a sub-agent's stream is a different block from its parent's", () => {
		const msg = { timestamp: 1_700_000_000_000 };
		assert.notEqual(asstKey(0, msg), asstKey(1, msg));
	});
});

/* ─────────────── the consumer, driven end to end ─────────────── */

/** A Terminal that renders nowhere. */
class FakeTerminal implements Terminal {
	onInput: (data: string) => void = () => {};
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 120;
	}
	get rows(): number {
		return 40;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const AGENT = "main";
const SESSION = "agent:main:main";

const SNAPSHOT = {
	provider: "claude-cli",
	modelId: "opus-4-8",
	modelName: "Opus 4.8",
	thinkingLevel: "off",
	supportsThinking: true,
	supportsVision: true,
	availableThinkingLevels: ["off"],
	contextUsagePercent: null,
	totalTokensIn: 0,
	totalTokensOut: 0,
	totalCostUsd: 0,
	isAgentRunning: false,
	messageCount: 0,
	agentId: AGENT,
	agentName: "brigade",
	sessionKey: SESSION,
} as unknown as SessionStateSnapshot;

type Handler = (...args: never[]) => void;

async function bootConnectUi(): Promise<{ tui: TUI; pi(event: unknown): void }> {
	const tui = new TUI(new FakeTerminal());
	const handlers = new Map<string, Handler[]>();
	const client = {
		on(event: string, fn: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
			return client;
		},
		connect: async () => {},
		resume: async () => {},
		close: () => {},
		request: async (method: string) => {
			if (method === "get-state") return SNAPSHOT;
			if (method === "list-models") return [];
			if (method === "sessions.list" || method === "list-sessions") return [];
			if (method === "list-agents") return [];
			return undefined;
		},
	};
	await wireConnectUi(tui, client as unknown as BrigadeClient, AGENT, SESSION);
	const emit = (event: string, payload: unknown): void => {
		for (const fn of handlers.get(event) ?? []) (fn as (p: unknown) => void)(payload);
	};
	emit("state", SNAPSHOT);
	return {
		tui,
		pi: (event: unknown) =>
			emit("pi", { event, subagentDepth: 0, agentId: AGENT, sessionId: SESSION }),
	};
}

function transcript(tui: TUI): string {
	const kids = (tui as unknown as { children: Component[] }).children;
	return kids
		.map((c) => (c as unknown as { render(width: number): string[] }).render(120).join("\n"))
		.join("\n");
}

function stopTimers(tui: TUI): void {
	for (const child of (tui as unknown as { children: Component[] }).children) {
		(child as unknown as { stop?: () => void }).stop?.();
	}
}

const booted: TUI[] = [];
after(() => {
	for (const tui of booted) stopTimers(tui);
});

/** The exact frame the gateway sends a delta-mode client: NO `message.content`. */
function deltaFrame(timestamp: number, delta: string): unknown {
	return {
		type: "message_update",
		// `role`, `timestamp` and `usage` survive the strip; `content` does not.
		message: { role: "assistant", timestamp, usage: { input: 4700, output: 12 } },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	};
}

describe("a delta-mode client reconstructs the reply", () => {
	it("appending deltas puts the whole sentence on screen", async () => {
		const { tui, pi } = await bootConnectUi();
		booted.push(tui);
		const ts = 1_700_000_000_000;
		assert.equal(transcript(tui).includes("Hello world"), false, "nothing on screen yet");
		for (const chunk of ["Hel", "lo ", "wor", "ld"]) pi(deltaFrame(ts, chunk));
		const screen = transcript(tui);
		assert.ok(
			screen.includes("Hello world"),
			`the accumulated text must render; got:\n${screen.slice(-400)}`,
		);
		// One block, not four — every delta of a message shares its render key.
		assert.equal(screen.split("Hello world").length - 1, 1, "the deltas share one block");
	});

	it("deltas of two different messages do not bleed into each other", async () => {
		const { tui, pi } = await bootConnectUi();
		booted.push(tui);
		pi(deltaFrame(1_700_000_000_001, "first reply"));
		pi(deltaFrame(1_700_000_000_002, "second reply"));
		const screen = transcript(tui);
		assert.ok(screen.includes("first reply"), "the first message survived");
		assert.ok(screen.includes("second reply"), "the second message rendered");
		assert.equal(
			screen.includes("first replysecond reply"),
			false,
			"a new timestamp is a new block, not a continuation",
		);
	});

	it("a frame that DOES carry content is authoritative and resets the accumulator", async () => {
		// message_end, an older gateway, or a resume rebuild. Without the reset,
		// the delta buffer would be composed on top of the snapshot and the
		// operator would read the reply twice.
		const { tui, pi } = await bootConnectUi();
		booted.push(tui);
		const ts = 1_700_000_000_003;
		pi(deltaFrame(ts, "partial answer"));
		pi({
			type: "message_end",
			message: {
				role: "assistant",
				timestamp: ts,
				content: [{ type: "text", text: "the whole answer" }],
			},
		});
		const screen = transcript(tui);
		assert.ok(screen.includes("the whole answer"), "the snapshot won");
		assert.equal(screen.includes("partial answer"), false, "the stale delta text is gone");
	});
});

/* ─────────────────────────────────────────────────────────────────────────
 * The PRODUCER side, which was previously untestable.
 *
 * The strip lived inline in `server.ts`'s `broadcast()`, so the only way to
 * "cover" it was to re-implement it in the test — which is what happened, and
 * the copy stripped a bare Pi event while production strips the nested
 * `{ type, event, payload: { event } }` frame. It asserted against a shape the
 * gateway never emits. Now that `stripCumulativeContent` is exported, these
 * drive the real thing.
 * ───────────────────────────────────────────────────────────────────────── */

/** The frame shape `broadcast()` actually builds. */
function updateFrame(content: unknown) {
	return {
		type: "event",
		event: "pi",
		payload: {
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
				message: {
					role: "assistant",
					timestamp: 1730000000000,
					usage: { input: 10, output: 2 },
					content,
				},
			},
		},
	};
}

it("the cumulative content is removed, and nothing else is", () => {
	const json = stripCumulativeContent(updateFrame([{ type: "text", text: "a".repeat(5000) }]));
	assert.ok(json, "a message_update with a delta must produce a stripped variant");
	const out = JSON.parse(json!);
	const msg = out.payload.event.message;

	assert.equal(msg.content, undefined, "content is the whole O(n^2) payload");
	// These three are load-bearing and must survive: the timestamp is the
	// client's render key, without which a delta cannot attach to a block.
	assert.equal(msg.role, "assistant");
	assert.equal(msg.timestamp, 1730000000000);
	assert.deepEqual(msg.usage, { input: 10, output: 2 });
	// The envelope is preserved so the client routes it identically.
	assert.equal(out.event, "pi");
	assert.equal(out.payload.event.type, "message_update");
	assert.deepEqual(out.payload.event.assistantMessageEvent, { type: "text_delta", delta: "hi" });
});

it("the stripped frame is genuinely smaller — the entire point", () => {
	const frame = updateFrame([{ type: "text", text: "a".repeat(5000) }]);
	const stripped = stripCumulativeContent(frame)!;
	assert.ok(
		stripped.length < JSON.stringify(frame).length / 2,
		"stripping must remove the bulk, not shuffle it",
	);
});

it("frames that are not strippable return undefined rather than a copy", () => {
	// No delta — a full snapshot the client needs whole.
	assert.equal(
		stripCumulativeContent({
			type: "event",
			event: "pi",
			payload: { event: { type: "message_update", message: { role: "assistant" } } },
		}),
		undefined,
	);
	// A different event kind entirely.
	assert.equal(
		stripCumulativeContent({ type: "event", event: "state", payload: { event: {} } }),
		undefined,
	);
	// Junk must never throw on the hottest path in the gateway.
	for (const junk of [null, undefined, 0, "", [], {}]) {
		assert.doesNotThrow(() => stripCumulativeContent(junk));
	}
});
