/**
 * These tests use Pi's REAL message shapes, taken from
 * `@earendil-works/pi-ai/dist/types.d.ts`:
 *
 *   UserMessage       { role: "user",       content, timestamp }
 *   AssistantMessage  { role: "assistant",  content: (Text|Thinking|ToolCall)[], … }
 *   ToolCall block    { type: "toolCall",   id, name, arguments }
 *   ToolResultMessage { role: "toolResult", toolCallId, toolName, content, … }
 *
 * That last one matters more than it looks. An earlier version of this file
 * modelled a tool result as a `user` message carrying a result block — a shape
 * Pi never produces — and every test passed against a transcript that cannot
 * exist. The bug it hid: `findSafeBoundary` looked for `role === "user"` and so
 * found no boundary anywhere inside a tool loop, which is the one situation
 * mid-turn compaction exists for. The feature was wired and inert.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyMidTurnCompaction,
	decideMidTurnCompaction,
	estimateTokens,
	findSafeBoundary,
	fingerprintBoundary,
	isCompactionSummaryMessage,
	isCompactionUsable,
	MIN_KEPT_TAIL_MESSAGES,
	MIN_MESSAGES_TO_COMPACT,
	splitPriorSummary,
	type MidTurnCompaction,
} from "./mid-turn.js";

let clock = 1;
const user = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: clock++,
});
const asst = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: clock++,
});
const asstCall = (id: string, args: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: args }],
	timestamp: clock++,
});
const toolRes = (toolCallId: string, text = "tool output") => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: clock++,
});

/** Prose conversation, large enough to trigger. */
function bigConversation(): unknown[] {
	const msgs: unknown[] = [];
	for (let i = 0; i < 12; i += 1) {
		msgs.push(user(`ask ${i} `.repeat(400)));
		msgs.push(asst(`answer ${i} `.repeat(400)));
	}
	return msgs;
}

/** A long TOOL LOOP — one user turn, then call/result pairs to the end. */
function toolLoop(): unknown[] {
	const msgs: unknown[] = [user(`do the migration ${"context ".repeat(400)}`)];
	for (let i = 0; i < 12; i += 1) {
		msgs.push(asstCall(`t${i}`, { command: `step ${i}` }));
		msgs.push(toolRes(`t${i}`, `output ${i} `.repeat(400)));
	}
	return msgs;
}

const WINDOW = 8_000;
const decide = (messages: unknown[]) =>
	decideMidTurnCompaction({ messages, contextWindowTokens: WINDOW });

/* ─────────────────────────── the trigger ─────────────────────────── */

test("below the threshold it is a pure pass-through", () => {
	// Compacting early would burn a summarization AND change the prompt prefix,
	// invalidating the provider cache for no benefit.
	const d = decideMidTurnCompaction({
		messages: bigConversation(),
		contextWindowTokens: 1_000_000,
	});
	assert.equal(d.should, false);
	assert.equal(d.reason, "below-threshold");
});

test("a short conversation is never compacted", () => {
	const msgs = Array.from({ length: MIN_MESSAGES_TO_COMPACT - 1 }, () =>
		user("x".repeat(100_000)),
	);
	assert.equal(decide(msgs).reason, "too-few-messages");
});

test("a missing or nonsensical context window disables the trigger", () => {
	for (const w of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const d = decideMidTurnCompaction({
			messages: bigConversation(),
			contextWindowTokens: w,
		});
		assert.equal(d.should, false, `window ${w}`);
	}
});

test("over the threshold it fires", () => {
	const d = decide(bigConversation());
	assert.equal(d.should, true);
	assert.equal(d.reason, "ready");
	assert.ok(d.keptFromIndex > 0);
});

test("IT FIRES INSIDE A TOOL LOOP — the case it exists for", () => {
	// The regression that made this whole feature inert: the tail of a tool loop
	// is assistant/toolResult, never `user`, so a boundary rule that only
	// accepted `user` messages never found one here.
	const d = decide(toolLoop());
	assert.equal(d.should, true, "a tool loop must be compactable");
	assert.equal(d.reason, "ready");
});

/* ─────────────────────────── the cut ─────────────────────────── */

test("the cut never orphans a tool result from its call", () => {
	const msgs = toolLoop();
	const d = decide(msgs);
	const kept = msgs.slice(d.keptFromIndex);
	// Every tool result in the kept region must have its call in the kept region.
	const produced = new Set<string>();
	for (const m of kept) {
		const msg = m as { role: string; content?: unknown[]; toolCallId?: string };
		if (msg.role === "assistant") {
			for (const b of msg.content ?? []) {
				const blk = b as { type?: string; id?: string };
				if (blk.type === "toolCall" && blk.id) produced.add(blk.id);
			}
		}
		if (msg.role === "toolResult") {
			assert.ok(
				produced.has(msg.toolCallId!),
				`orphaned tool result ${msg.toolCallId} — every provider 400s on this`,
			);
		}
	}
});

test("a tool result is never itself the boundary", () => {
	const msgs = toolLoop();
	const d = decide(msgs);
	assert.notEqual(
		(msgs[d.keptFromIndex] as { role: string }).role,
		"toolResult",
		"landing on a result means the assistant turn that owns it is half-sent",
	);
});

test("the kept tail is never shorter than the minimum", () => {
	// The boundary snaps BACKWARD, so the tail can only grow past the minimum.
	for (const msgs of [bigConversation(), toolLoop()]) {
		const d = decide(msgs);
		if (!d.should) continue;
		assert.ok(
			msgs.length - d.keptFromIndex >= MIN_KEPT_TAIL_MESSAGES,
			`kept ${msgs.length - d.keptFromIndex}, minimum ${MIN_KEPT_TAIL_MESSAGES}`,
		);
	}
});

test("cutting at the assistant that owns a call is safe — the pair stays together", () => {
	// A cut at the CALL keeps both halves of the pair, so it is legal. Only the
	// span strictly between a call and its result is off limits.
	const msgs = [user("go"), asstCall("t1"), toolRes("t1")];
	assert.equal(findSafeBoundary(msgs, msgs.length - 1), 1);
});

test("findSafeBoundary returns -1 when no cut above zero is safe", () => {
	// Result last, its call at index 0: every candidate above 0 is mid-pair, so
	// we must decline rather than cut anyway and orphan the result.
	const msgs = [asstCall("t1"), toolRes("t1")];
	assert.equal(findSafeBoundary(msgs, msgs.length - 1), -1);
});

test("no safe boundary means no compaction, not an unsafe cut", () => {
	const msgs: unknown[] = [user("go ".repeat(20_000)), asstCall("t1"), toolRes("t1")];
	while (msgs.length < MIN_MESSAGES_TO_COMPACT) msgs.splice(1, 0, asstCall(`x${msgs.length}`));
	// Rebuild as a strictly unsafe transcript: one call at index 1, result last.
	const unsafe: unknown[] = [user("go ".repeat(20_000)), asstCall("t1")];
	for (let i = 0; i < 8; i += 1) unsafe.push(asst(`thinking ${i} `.repeat(400)));
	unsafe.push(toolRes("t1", "x".repeat(40_000)));
	const d = decide(unsafe);
	if (d.should) {
		// If it did find one, it must still be safe — assert that instead.
		assert.notEqual((unsafe[d.keptFromIndex] as { role: string }).role, "toolResult");
	} else {
		assert.equal(d.reason, "no-safe-boundary");
	}
});

/* ─────────────────────────── applying it ─────────────────────────── */

function compactionFor(messages: unknown[], summary = "SUMMARY"): MidTurnCompaction {
	const d = decide(messages);
	return {
		summary,
		keptFromIndex: d.keptFromIndex,
		replacedTokens: 100,
		at: 1234,
		boundaryFingerprint: fingerprintBoundary(messages, d.keptFromIndex),
	};
}

test("the summary is carried by a user turn and the tail is verbatim", () => {
	const msgs = bigConversation();
	const c = compactionFor(msgs);
	const out = applyMidTurnCompaction(msgs as never, c);
	const first = out[0] as { role: string; content: { text: string }[] };
	assert.equal(first.role, "user");
	assert.match(first.content[0]!.text, /SUMMARY/);
	assert.match(first.content[0]!.text, /preserved and unchanged/);
	// Everything after the boundary survives byte-for-byte.
	assert.deepEqual(out.slice(1), msgs.slice(c.keptFromIndex + 1));
});

test("it never emits two consecutive user turns", () => {
	// Anthropic merges them; Gemini, Bedrock and Mistral conversions are
	// stricter, and Brigade drives all of them.
	for (const msgs of [bigConversation(), toolLoop()]) {
		const out = applyMidTurnCompaction(msgs as never, compactionFor(msgs));
		for (let i = 1; i < out.length; i += 1) {
			const a = (out[i - 1] as { role: string }).role;
			const b = (out[i] as { role: string }).role;
			assert.ok(!(a === "user" && b === "user"), `consecutive user turns at ${i}`);
		}
	}
});

test("a synthesised header carries a timestamp", () => {
	// Pi's UserMessage requires it; without one, Pi's own compaction bookkeeping
	// does `new Date(undefined)` and every timestamp comparison is silently false.
	const msgs = toolLoop();
	const out = applyMidTurnCompaction(msgs as never, compactionFor(msgs));
	const first = out[0] as { role: string; timestamp?: number };
	assert.equal(typeof first.timestamp, "number");
	assert.ok(Number.isFinite(first.timestamp));
});

test("the reduced request is materially smaller", () => {
	const msgs = bigConversation();
	const out = applyMidTurnCompaction(msgs as never, compactionFor(msgs));
	assert.ok(estimateTokens(out) < estimateTokens(msgs) / 2);
});

/* ─────────────────────────── cache validity ─────────────────────────── */

test("a cached compaction is reused while the turn only grows", () => {
	const msgs = bigConversation();
	const c = compactionFor(msgs);
	assert.equal(isCompactionUsable(c, msgs), true);
	assert.equal(isCompactionUsable(c, [...msgs, asst("more"), user("more")]), true);
});

test("a rewritten history invalidates the cache instead of cutting wrong", () => {
	// The pairing repair runs EARLIER in the same transform chain and can drop an
	// orphan, shifting every later index down by one. Reusing a boundary index
	// across that shift cuts one message too far — and can put an orphaned tool
	// result at the head of the request, the exact 400 the cut rule prevents.
	const msgs = bigConversation();
	const c = compactionFor(msgs);
	const shifted = msgs.slice(1); // one message dropped from the front
	assert.equal(isCompactionUsable(c, shifted), false);
});

test("a truncated history invalidates the cache", () => {
	const msgs = bigConversation();
	const c = compactionFor(msgs);
	assert.equal(isCompactionUsable(c, msgs.slice(0, 3)), false);
});

test("an absent or degenerate compaction is never usable", () => {
	assert.equal(isCompactionUsable(undefined, bigConversation()), false);
	assert.equal(
		isCompactionUsable(
			{ summary: "s", keptFromIndex: 0, replacedTokens: 0, at: 0, boundaryFingerprint: "" },
			bigConversation(),
		),
		false,
	);
});

/* ─────────────────────────── estimation ─────────────────────────── */

test("tool-call arguments count toward the estimate", () => {
	// A transcript dominated by tool traffic would otherwise read low, firing the
	// ratio trigger well past the real threshold.
	const bare = [asstCall("t1", {})];
	const heavy = [asstCall("t1", { command: "x".repeat(40_000) })];
	assert.ok(estimateTokens(heavy) > estimateTokens(bare) + 9_000);
});

test("estimateTokens tolerates junk without throwing", () => {
	assert.equal(estimateTokens([]), 0);
	assert.equal(estimateTokens([null, undefined, 42, "str", {}] as unknown[]), 0);
});

/* ─────────────── a safe cut is not automatically a worthwhile one ─────────────── */

test("it declines a cut that reclaims almost nothing", () => {
	// The measured failure: one tool call whose result lands far later makes
	// every index between them unsafe, so the backward scan bottoms out at 1.
	// A 605-message transcript then "compacted" by dropping ONE message, paid
	// for a full summarization, and added the summary on top — 111,202 tokens
	// in, 112,239 out. The request got bigger.
	const msgs: unknown[] = [user("kick off ".repeat(400))];
	msgs.push(asstCall("straddle"));
	for (let i = 0; i < 200; i += 1) {
		msgs.push(asst(`work ${i} `.repeat(400)));
		msgs.push(asst(`more ${i} `.repeat(400)));
	}
	msgs.push(toolRes("straddle", "done"));

	const d = decide(msgs);
	assert.equal(d.should, false, "paying for a summarization that reclaims ~nothing is waste");
	assert.equal(d.reason, "not-worth-it");
});

test("a compaction that IS worthwhile still fires", () => {
	// The floor must not swallow the normal case.
	const d = decide(toolLoop());
	assert.equal(d.should, true);
	assert.equal(d.reason, "ready");
});

test("an applied compaction always makes the request smaller", () => {
	// The invariant the floor exists to protect.
	for (const msgs of [bigConversation(), toolLoop()]) {
		const d = decide(msgs);
		if (!d.should) continue;
		const out = applyMidTurnCompaction(msgs as never, compactionFor(msgs));
		assert.ok(
			estimateTokens(out) < estimateTokens(msgs),
			"a compaction that grows the request is not a compaction",
		);
	}
});

/* ───────── prior-summary detection ───────── */

test("Brigade's own summary message is recognised", () => {
	const msgs = bigConversation();
	const out = applyMidTurnCompaction(msgs as never, compactionFor(msgs, "BODY"));
	assert.equal(isCompactionSummaryMessage(out[0]), true);
});

test("an ordinary user message is never mistaken for a summary", () => {
	// The marker is a content prefix, so anything that merely mentions
	// compaction must not trip it.
	assert.equal(isCompactionSummaryMessage(user("we should compact this soon")), false);
	assert.equal(isCompactionSummaryMessage(asst("Earlier conversation was compacted")), false);
	assert.equal(isCompactionSummaryMessage(null), false);
	assert.equal(isCompactionSummaryMessage({ role: "user", content: "a string" }), false);
});

test("splitPriorSummary removes every summary and keeps the newest body", () => {
	const msgs = bigConversation();
	const once = applyMidTurnCompaction(msgs as never, compactionFor(msgs, "FIRST-BODY"));
	const grown = [...once, asst("more"), user("more")];
	const twice = applyMidTurnCompaction(grown as never, {
		...compactionFor(grown as unknown[], "SECOND-BODY"),
		keptFromIndex: 1,
		boundaryFingerprint: fingerprintBoundary(grown as unknown[], 1),
	});

	const split = splitPriorSummary(twice as unknown[]);
	assert.equal(
		(split.rest as unknown[]).some((m) => isCompactionSummaryMessage(m)),
		false,
		"no summary survives into the summarizable set",
	);
	// The most recent summary wins — it already folded the earlier one forward.
	assert.match(split.priorSummary ?? "", /SECOND-BODY/);
});

test("splitPriorSummary is a pass-through when there is no summary", () => {
	const msgs = bigConversation();
	const split = splitPriorSummary(msgs);
	assert.equal(split.priorSummary, undefined);
	assert.equal((split.rest as unknown[]).length, msgs.length);
});

test("an Anthropic-dialect tool pair is also protected from the cut", () => {
	// Pi's in-memory shape is `toolCall` + a `toolResult` MESSAGE, but the
	// pairing repair earlier in the same chain accepts and SYNTHESISES Anthropic
	// `tool_use` / `tool_result` blocks. A boundary rule that knows only one
	// dialect registers zero unsafe indices on the other and cuts straight
	// through a pair — an orphaned `tool_result`, plus a text block folded in
	// front of it. Two 400s in one message.
	const msgs: unknown[] = [
		{ role: "user", content: [{ type: "text", text: "go" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "t9", name: "read" }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "out" }] },
	];
	// Index 2 is the result — cutting there orphans it. The rule must refuse.
	assert.notEqual(findSafeBoundary(msgs, 2), 2);
});

test("the Pi dialect is still protected — the widening did not break it", () => {
	const msgs = [user("go"), asstCall("t1"), toolRes("t1")];
	assert.equal(findSafeBoundary(msgs, 2), 1);
});
