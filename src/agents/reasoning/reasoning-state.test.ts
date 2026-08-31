import assert from "node:assert/strict";
import { test } from "node:test";

import { ReasoningTracker } from "./reasoning-state.js";

const A = "main";
const S = "agent:main:main";

test("a session that never reasons produces no snapshot at all", () => {
	// A non-reasoning model must add no noise to the state snapshot.
	const t = new ReasoningTracker();
	assert.equal(t.snapshot(A, S), undefined);
	t.beginTurn(A, S);
	assert.equal(t.snapshot(A, S), undefined);
});

test("a reasoning phase reports active with a start time, then clears", () => {
	// The header could not previously distinguish "thinking for 40s" from
	// "stalled" — `thinkingLevel` and `supportsThinking` are capabilities, not state.
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.start(A, S, "raw", 1000);
	const mid = t.snapshot(A, S)!;
	assert.equal(mid.active, true);
	assert.equal(mid.startedAt, 1000);
	assert.equal(mid.visibility, "raw");

	t.end(A, S);
	const after = t.snapshot(A, S)!;
	assert.equal(after.active, false);
	assert.equal(after.startedAt, undefined, "no stale start time once answering");
});

test("reasoning characters accumulate across deltas", () => {
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.start(A, S, "raw");
	t.delta(A, S, "let me think");
	t.delta(A, S, " harder");
	assert.equal(t.snapshot(A, S)?.chars, "let me think harder".length);
});

test("a delta without an explicit start still opens the phase", () => {
	// Not every backend emits a start event; dropping the reasoning because of
	// that would be worse than inferring the phase.
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.delta(A, S, "hmm", 500);
	const s = t.snapshot(A, S)!;
	assert.equal(s.active, true);
	assert.equal(s.startedAt, 500);
});

test("a hidden-reasoning backend is active with no text", () => {
	// Some providers reason, bill for it, and expose nothing. The honest UI is
	// "thinking…" with a token count — NOT an empty thought bubble.
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.setVisibility(A, S, "hidden");
	t.start(A, S, "raw"); // start must not downgrade an established visibility
	t.delta(A, S, undefined);
	t.setTokens(A, S, 1024);

	const s = t.snapshot(A, S)!;
	assert.equal(s.active, true);
	assert.equal(s.visibility, "hidden", "an explicit visibility is not overwritten by a phase opening");
	assert.equal(s.chars, undefined, "no readable text to report");
	assert.equal(s.tokens, 1024);
});

test("summary visibility is preserved so a UI can label it honestly", () => {
	// Rendering a provider-written summary as "the model's thinking" is a
	// misrepresentation, so the shape must survive to the client.
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.setVisibility(A, S, "summary");
	t.delta(A, S, "Considering the file layout");
	assert.equal(t.snapshot(A, S)?.visibility, "summary");
});

test("an aborted turn does not strand the header on 'thinking…'", () => {
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.start(A, S);
	assert.equal(t.snapshot(A, S)?.active, true);
	t.beginTurn(A, S); // user aborted, next turn starts
	// Stronger than "active: false": the row disappears entirely, so an aborted
	// turn leaves no stale reasoning line behind at all.
	assert.equal(t.snapshot(A, S), undefined, "nothing stranded from the abandoned turn");
});

test("state is per (agent, session) — no cross-session bleed", () => {
	const t = new ReasoningTracker();
	t.beginTurn("main", "agent:main:main");
	t.start("main", "agent:main:main");
	t.beginTurn("ops", "agent:ops:main");

	assert.equal(t.snapshot("main", "agent:main:main")?.active, true);
	assert.equal(t.snapshot("ops", "agent:ops:main"), undefined, "an idle agent shows nothing");
});

test("negative or non-finite token counts are ignored", () => {
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.start(A, S);
	t.setTokens(A, S, -5);
	t.setTokens(A, S, Number.NaN);
	assert.equal(t.snapshot(A, S)?.tokens, undefined);
});

test("eviction drops the least recently USED session", () => {
	const t = new ReasoningTracker(2);
	t.start(A, "s1");
	t.start(A, "s2");
	t.delta(A, "s1", "x"); // s1 becomes most recently used
	t.start(A, "s3");

	assert.equal(t.size, 2);
	assert.ok(t.snapshot(A, "s1"), "the busy session survives");
	assert.equal(t.snapshot(A, "s2"), undefined, "the coldest is evicted");
});

test("declaring a visibility is NOT evidence that anything was reasoned", () => {
	// Regression: the gateway sets a visibility on EVERY turn, so keying
	// suppression off it painted a permanent, false "Thought · provider summary"
	// into the header of every non-reasoning model.
	const t = new ReasoningTracker();
	t.setVisibility(A, S, "summary");
	t.beginTurn(A, S);
	assert.equal(t.snapshot(A, S), undefined, "no phase happened — say nothing");
});

test("a completed phase reports how long it took", () => {
	// The formatter's "Thought for Ns" branch was unreachable: nothing carried
	// the duration once the phase closed, so every finished phase said "Thought".
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.start(A, S, "raw", 1_000);
	t.delta(A, S, "mulling", 2_000);
	t.end(A, S, 13_000);
	const s = t.snapshot(A, S)!;
	assert.equal(s.active, false);
	assert.equal(s.durationMs, 12_000);
});

test("reported reasoning tokens alone prove a phase happened", () => {
	// The omitted-but-billed case: no text, no deltas, but the model reasoned
	// and was charged for it.
	const t = new ReasoningTracker();
	t.setVisibility(A, S, "hidden");
	t.beginTurn(A, S);
	t.setTokens(A, S, 740);
	const s = t.snapshot(A, S)!;
	assert.equal(s.tokens, 740);
	assert.equal(s.visibility, "hidden");
});

test("a new turn clears the previous phase's duration", () => {
	const t = new ReasoningTracker();
	t.beginTurn(A, S);
	t.start(A, S, "raw", 0);
	t.end(A, S, 5_000);
	t.beginTurn(A, S);
	assert.equal(t.snapshot(A, S), undefined, "a fresh turn has nothing to report yet");
});
