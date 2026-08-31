import assert from "node:assert/strict";
import { after, test } from "node:test";

import { TUI, type Component, type Terminal } from "@earendil-works/pi-tui";

import { wireConnectUi } from "../cli/commands/connect.js";
import type { BrigadeClient } from "../tui/client.js";
import type { SessionStateSnapshot } from "../protocol.js";
import {
	CompactionBreaker,
	describeCompactionOutcome,
	estimateContextTokensFromMessages,
	isCompactionCancellation,
	MAX_COMPACTIONS_WITHOUT_REPLY,
	summarizeCompactionOutcome,
} from "./smart-compaction.js";

const S = "agent:main:main";

test("the observed 1.33 loop terminates instead of running forever", () => {
	// retries exhaust → compact → still over threshold (the figure only refreshes
	// on a successful reply, and there isn't one) → compact → …
	const b = new CompactionBreaker();
	let compactions = 0;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (!b.allow(S)) break;
		b.noteCompaction(S);
		compactions += 1;
		// The turn fails with a connection error — no reply, so no reset.
	}
	assert.equal(compactions, MAX_COMPACTIONS_WITHOUT_REPLY);
	assert.equal(b.allow(S), false, "the breaker is open");
});

test("a successful reply resets the budget — and ONLY a reply does", () => {
	// A compaction "succeeding" proves nothing: that is exactly what the loop
	// did, every iteration, while making no progress.
	const b = new CompactionBreaker();
	b.noteCompaction(S);
	b.noteCompaction(S);
	assert.equal(b.allow(S), false);

	b.noteReply(S);
	assert.equal(b.allow(S), true, "a real reply proves the context changed");
	assert.equal(b.count(S), 0);
});

test("a legitimate single compaction per turn is never blocked", () => {
	// The common case: context fills, one compaction, the turn succeeds.
	const b = new CompactionBreaker();
	for (let turn = 0; turn < 20; turn += 1) {
		assert.equal(b.allow(S), true, `turn ${turn}`);
		b.noteCompaction(S);
		b.noteReply(S);
	}
});

test("sessions are independent — one stuck thread cannot block another", () => {
	const b = new CompactionBreaker();
	b.noteCompaction("a");
	b.noteCompaction("a");
	assert.equal(b.allow("a"), false);
	assert.equal(b.allow("b"), true);
});

test("an operator's Ctrl+C cannot close their own guard", () => {
	// `noteCompaction` is counted BEFORE the summarization on purpose — the guard
	// has to hold even if the call never returns. A CANCELLED compaction is the
	// one case where that is wrong: nothing was paid for and nothing was learned
	// about whether compaction helps this session, which is the only question
	// this guard exists to answer. Counted anyway, two interrupts in a row would
	// lock a perfectly healthy session out of compaction for the whole cooldown.
	const b = new CompactionBreaker();
	for (let i = 0; i < MAX_COMPACTIONS_WITHOUT_REPLY + 3; i += 1) {
		assert.equal(b.allow(S), true, `interrupt ${i} still leaves the guard open`);
		b.noteCompaction(S);
		b.undoCompaction(S); // the operator pressed Ctrl+C
	}
	assert.equal(b.count(S), 0);
	assert.equal(b.allow(S), true);
});

test("undoing a cancellation rewinds ONE attempt, it does not clear the budget", () => {
	// The distinction from `noteReply`. A real failure followed by an interrupt
	// must still leave the real failure on the books — otherwise a session that
	// alternates failure and cancellation compacts forever, which is the exact
	// loop the breaker was written for.
	const b = new CompactionBreaker();
	b.noteCompaction(S); // a genuine failure
	b.noteCompaction(S); // a cancelled attempt
	assert.equal(b.allow(S), false, "the guard closed on the second attempt");
	b.undoCompaction(S);
	assert.equal(b.count(S), 1, "the genuine failure survives");
	assert.equal(b.allow(S), true, "but the cancelled attempt is given back");
});

test("undoCompaction on an unknown session is a no-op, not a negative count", () => {
	const b = new CompactionBreaker();
	b.undoCompaction("never-seen");
	assert.equal(b.count("never-seen"), 0);
	assert.equal(b.size, 0);
});

test("a cancellation is recognised by shape, not by message text", () => {
	// The same pair `retry-policy.ts` and `model-fallback.ts` classify by, so an
	// abort raised anywhere below — Pi's run abort, an isolated summarization
	// call, a provider fetch — is recognised without each layer inventing its
	// own spelling.
	assert.equal(isCompactionCancellation(Object.assign(new Error("x"), { name: "AbortError" })), true);
	assert.equal(isCompactionCancellation(Object.assign(new Error("x"), { code: "ABORT_ERR" })), true);
	assert.equal(isCompactionCancellation(Object.assign(new Error("x"), { code: 20 })), true);
	// A real failure must NOT be forgiven — that would retry a broken
	// summarization on every attempt, which is the loop the breaker exists for.
	assert.equal(isCompactionCancellation(new Error("Connection error.")), false);
	assert.equal(isCompactionCancellation(undefined), false);
	assert.equal(isCompactionCancellation("AbortError"), false);
});

test("forget clears a session", () => {
	const b = new CompactionBreaker();
	b.noteCompaction(S);
	b.forget(S);
	assert.equal(b.count(S), 0);
	assert.equal(b.size, 0);
});

/* ─────────────────────── outcome measurement ─────────────────────── */

test("a real compaction reports what it reclaimed", () => {
	const o = summarizeCompactionOutcome({
		tokensBefore: 150_000,
		tokensAfter: 32_000,
		messagesBefore: 142,
		messagesAfter: 12,
		contextWindowTokens: 200_000,
	});
	assert.equal(o.freedTokens, 118_000);
	assert.equal(o.madeProgress, true);
	assert.equal(o.wasOverWindow, false);
	assert.equal(describeCompactionOutcome(o), "142 → 12 messages · freed 118k tokens (79%)");
});

test("a compaction that reclaimed nothing is reported as no progress", () => {
	// This is the loop's exact signature: it kept reporting success while
	// changing nothing, so nothing ever stopped it.
	const o = summarizeCompactionOutcome({
		tokensBefore: 150_000,
		tokensAfter: 149_000,
		messagesBefore: 100,
		messagesAfter: 100,
	});
	assert.equal(o.madeProgress, false);
	assert.match(describeCompactionOutcome(o), /no meaningful reduction/);
});

test("a compaction that GREW the context reports zero freed, not a negative", () => {
	const o = summarizeCompactionOutcome({
		tokensBefore: 10_000,
		tokensAfter: 12_000,
		messagesBefore: 10,
		messagesAfter: 11,
	});
	assert.equal(o.freedTokens, 0);
	assert.equal(o.madeProgress, false);
});

test("an over-window estimate is flagged rather than presented as a measurement", () => {
	// The screenshot showed "was 161%". Over 100% means the figure is stale or
	// inflated — a cumulative usage total being read as a context size — and
	// that deserves saying out loud.
	const o = summarizeCompactionOutcome({
		tokensBefore: 322_000,
		tokensAfter: 40_000,
		messagesBefore: 200,
		messagesAfter: 10,
		contextWindowTokens: 200_000,
	});
	assert.equal(o.wasOverWindow, true);
});

test("degenerate inputs do not produce NaN or Infinity", () => {
	const o = summarizeCompactionOutcome({
		tokensBefore: 0,
		tokensAfter: 0,
		messagesBefore: 0,
		messagesAfter: 0,
	});
	assert.equal(o.freedRatio, 0);
	assert.equal(o.madeProgress, false);
	assert.equal(Number.isFinite(o.freedRatio), true);
});

test("trip opens the guard immediately, without spending the attempt budget", () => {
	// A compaction that reclaimed nothing cannot do better on a retry; spending
	// another paid summarization call to prove that is waste.
	const b = new CompactionBreaker();
	assert.equal(b.allow(S), true);
	b.trip(S);
	assert.equal(b.allow(S), false);
	// And a real reply still clears it.
	b.noteReply(S);
	assert.equal(b.allow(S), true);
});

/* ───────────── what the operator is told, end to end ───────────── */

// These used to call a `compactionLine()` declared right here in the test file,
// which was a COPY of the expression inside `connect.ts`'s `compaction_end`
// handler — and a stale one: it asserted `freed 118000 tokens` where production
// runs the figure through `formatTokens` and prints `freed 118k tokens`. The
// test agreed with itself and disagreed with the screen, and deleting the real
// line from `connect.ts` would not have failed it.
//
// The real line is built inline inside a closure in `wireConnectUi`, so there is
// nothing to import. What CAN be driven is the whole path: boot the real connect
// UI against a fake terminal and a fake gateway, push the `compaction_end` frame
// the gateway really sends, and read the row off the widget tree.

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

const UI_AGENT = "main";
const UI_SESSION = "agent:main:main";

const UI_SNAPSHOT = {
	provider: "claude-cli",
	modelId: "opus-4-8",
	modelName: "Opus 4.8",
	thinkingLevel: "off",
	supportsThinking: true,
	supportsVision: true,
	availableThinkingLevels: ["off"],
	contextUsagePercent: 889,
	totalTokensIn: 0,
	totalTokensOut: 0,
	totalCostUsd: 0,
	isAgentRunning: false,
	messageCount: 0,
	agentId: UI_AGENT,
	agentName: "brigade",
	sessionKey: UI_SESSION,
} as unknown as SessionStateSnapshot;

const bootedUis: TUI[] = [];
after(() => {
	for (const tui of bootedUis) {
		for (const child of (tui as unknown as { children: Component[] }).children) {
			(child as unknown as { stop?: () => void }).stop?.();
		}
	}
});

/** Boot the real connect UI and hand back a way to push one `compaction_end`. */
async function compactionScreen(event: Record<string, unknown>): Promise<string> {
	const tui = new TUI(new FakeTerminal());
	bootedUis.push(tui);
	const handlers = new Map<string, Array<(...a: never[]) => void>>();
	const client = {
		on(name: string, fn: (...a: never[]) => void) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
			return client;
		},
		connect: async () => {},
		resume: async () => {},
		close: () => {},
		request: async (method: string) => {
			if (method === "get-state") return UI_SNAPSHOT;
			if (method === "list-models") return [];
			if (method === "sessions.list" || method === "list-sessions") return [];
			if (method === "list-agents") return [];
			return undefined;
		},
	};
	await wireConnectUi(tui, client as unknown as BrigadeClient, UI_AGENT, UI_SESSION);
	const emit = (name: string, payload: unknown): void => {
		for (const fn of handlers.get(name) ?? []) (fn as (p: unknown) => void)(payload);
	};
	emit("state", UI_SNAPSHOT);
	emit("pi", { event, subagentDepth: 0, agentId: UI_AGENT, sessionId: UI_SESSION });
	return (tui as unknown as { children: Component[] }).children
		.map((c) => (c as unknown as { render(width: number): string[] }).render(120).join("\n"))
		.join("\n");
}

/** The `compaction_end` frame the gateway sends for a SUCCESSFUL compaction. */
function compactionEnd(outcome: unknown): Record<string, unknown> {
	return { type: "compaction_end", aborted: false, result: {}, outcome };
}

test("a real compaction tells the operator what it freed", async () => {
	// The summarization's COST cannot be priced — the provider reports no usage
	// for it — but what it RECLAIMED is always measurable, and saying nothing was
	// how a no-progress loop kept passing for success.
	const o = summarizeCompactionOutcome({
		tokensBefore: 150_000,
		tokensAfter: 32_000,
		messagesBefore: 142,
		messagesAfter: 12,
	});
	const screen = await compactionScreen(compactionEnd(o));
	assert.ok(
		screen.includes("compacted · freed 118k tokens · 142 → 12 messages"),
		`the operator must be told what was freed; screen tail:\n${screen.slice(-400)}`,
	);
});

test("a compaction that achieved nothing says so, instead of claiming success", async () => {
	const o = summarizeCompactionOutcome({
		tokensBefore: 150_000,
		tokensAfter: 149_500,
		messagesBefore: 100,
		messagesAfter: 100,
	});
	assert.equal(o.madeProgress, false, "0.3% freed is not progress");
	const screen = await compactionScreen(compactionEnd(o));
	assert.ok(screen.includes("reclaimed almost nothing (100 → 100 messages)"), "it must say so");
	assert.equal(screen.includes("freed"), false, "and must not also claim a saving");
});

test("an older gateway with no outcome falls back to the honest old wording", async () => {
	// The percentage genuinely is stale until the next successful reply, so the
	// fallback is not a lie — just less useful.
	const screen = await compactionScreen(compactionEnd(undefined));
	assert.ok(screen.includes("compacted · usage refreshes on the next reply"));
});

test("a compaction that FAILED is never reported as a compaction", async () => {
	// Pi emits `compaction_end` on every failure path with `aborted: false` and
	// no `result`. Branching on `aborted` alone printed "✓ compacted · reclaimed
	// almost nothing" for a summarization that never ran.
	const screen = await compactionScreen({
		type: "compaction_end",
		aborted: false,
		errorMessage: "rate limited",
	});
	assert.ok(screen.includes("compaction failed · rate limited"), "the failure is named");
	assert.equal(screen.includes("compacted ·"), false, "and never dressed up as success");
});

test("one estimator is shared, so the trigger and the measurement cannot disagree", () => {
	// Three different token estimators would disagree about whether a compaction
	// helped — the exact ambiguity that let the loop keep reporting success.
	const msgs = [{ content: "x".repeat(400) }, { content: [{ type: "text", text: "y".repeat(400) }] }];
	assert.equal(estimateContextTokensFromMessages(msgs), 200);
	assert.equal(estimateContextTokensFromMessages([]), 0);
	assert.equal(estimateContextTokensFromMessages(undefined as never), 0);
});

/* ───────────────── cooldown — the guard must not deadlock ───────────────── */

test("a closed guard re-opens after the cooldown", () => {
	// Without this the guard can only be cleared by the thing it forbids:
	// `trip()` closes it mid-turn, that turn fails because the context is still
	// over, so no successful reply ever lands, so `noteReply` is never called —
	// and the session can never compact again for the life of the process.
	let now = 1_000_000;
	const b = new CompactionBreaker(2, 60_000, () => now);
	b.trip("s1");
	assert.equal(b.allow("s1"), false, "closed immediately after tripping");

	now += 59_000;
	assert.equal(b.allow("s1"), false, "still closed inside the cooldown");

	now += 2_000;
	assert.equal(b.allow("s1"), true, "re-opens once the cooldown elapses");
	assert.equal(b.count("s1"), 0, "and the budget is genuinely reset");
});

test("the cooldown also releases a guard closed by exhausting the budget", () => {
	let now = 0;
	const b = new CompactionBreaker(2, 1_000, () => now);
	b.noteCompaction("s1");
	b.noteCompaction("s1");
	assert.equal(b.allow("s1"), false);
	now += 1_500;
	assert.equal(b.allow("s1"), true);
});

test("a successful reply still resets immediately, without waiting", () => {
	let now = 0;
	const b = new CompactionBreaker(2, 60_000, () => now);
	b.trip("s1");
	b.noteReply("s1");
	assert.equal(b.allow("s1"), true, "a reply proves the context moved");
	assert.equal(b.count("s1"), 0);
});

test("the cooldown is per session", () => {
	let now = 0;
	const b = new CompactionBreaker(2, 1_000, () => now);
	b.trip("s1");
	now += 1_500;
	b.trip("s2");
	assert.equal(b.allow("s1"), true, "s1 waited out its cooldown");
	assert.equal(b.allow("s2"), false, "s2 just closed");
});

test("the breaker's memory is bounded", () => {
	// Entries clear on a reply or after the cooldown — but the cooldown is only
	// checked inside `allow()`, which is never called again for a session that
	// has died. A long-lived gateway would otherwise accumulate one entry per
	// abandoned session forever.
	const b = new CompactionBreaker(2, 60_000, () => 0, 10);
	for (let i = 0; i < 100; i += 1) b.noteCompaction(`s${i}`);
	assert.ok(b.size <= 10, `retained ${b.size} sessions`);
	// Evicting a suppression record only means the next compaction is allowed,
	// which is the correct default.
	assert.equal(b.allow("s0"), true);
	// The most recent sessions keep their state.
	assert.equal(b.count("s99"), 1);
});

test("a tripped session is not the first one evicted", () => {
	// `trip()` used to use a bare `set`, which preserves insertion order in a JS
	// Map — so the session we most wanted suppressed kept its stale LRU position
	// and was evicted first, silently re-allowing the compaction that had just
	// been proven useless.
	const b = new CompactionBreaker(2, 60_000, () => 0, 3);
	b.noteCompaction("old-1");
	b.noteCompaction("old-2");
	b.trip("a");
	b.noteCompaction("d");
	assert.equal(b.allow("a"), false, "the tripped session must survive eviction");
});
