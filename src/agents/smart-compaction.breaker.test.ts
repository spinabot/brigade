import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CompactionBreaker,
	describeCompactionOutcome,
	estimateContextTokensFromMessages,
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

/** The line the TUI renders from `compaction_end.outcome`. */
function compactionLine(oc: { freedTokens: number; messagesBefore: number; messagesAfter: number; madeProgress: boolean } | undefined): string {
	if (!oc) return "compacted · usage refreshes on the next reply";
	return oc.madeProgress
		? `compacted · freed ${oc.freedTokens} tokens · ${oc.messagesBefore} → ${oc.messagesAfter} messages`
		: `compacted · reclaimed almost nothing (${oc.messagesBefore} → ${oc.messagesAfter} messages)`;
}

test("a real compaction tells the operator what it freed", () => {
	// The summarization's COST cannot be priced — the provider reports no usage
	// for it — but what it RECLAIMED is always measurable, and saying nothing was
	// how a no-progress loop kept passing for success.
	const o = summarizeCompactionOutcome({
		tokensBefore: 150_000,
		tokensAfter: 32_000,
		messagesBefore: 142,
		messagesAfter: 12,
	});
	assert.equal(
		compactionLine(o),
		"compacted · freed 118000 tokens · 142 → 12 messages",
	);
});

test("a compaction that achieved nothing says so, instead of claiming success", () => {
	const o = summarizeCompactionOutcome({
		tokensBefore: 150_000,
		tokensAfter: 149_500,
		messagesBefore: 100,
		messagesAfter: 100,
	});
	assert.match(compactionLine(o), /reclaimed almost nothing/);
	assert.doesNotMatch(compactionLine(o), /freed/);
});

test("an older gateway with no outcome falls back to the honest old wording", () => {
	// The percentage genuinely is stale until the next successful reply, so the
	// fallback is not a lie — just less useful.
	assert.match(compactionLine(undefined), /usage refreshes on the next reply/);
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
