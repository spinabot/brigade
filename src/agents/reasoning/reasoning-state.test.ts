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

/* ─────────────────────────────────────────────────────────────────────────
 * A summary that never arrived is not a summary.
 *
 * Reported from a live session: the footer read
 *
 *     Thought for 15s · 400 reasoning tokens · provider summary
 *
 * with `/reasoning on` and NOTHING rendered in the conversation. The model
 * reasoned and was billed for it; the "provider summary" label came from the
 * static provider map, not from anything the turn actually returned. It sent
 * the operator looking for text that does not exist.
 * ───────────────────────────────────────────────────────────────────────── */

test("reasoning with tokens but ZERO text is reported as hidden, not summary", () => {
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary"); // the static guess for this provider
	t.start("a", "s", "summary");
	t.setTokens("a", "s", 400); // billed…
	// …and not one character of reasoning text ever arrives.
	t.end("a", "s");

	const snap = t.snapshot("a", "s");
	assert.equal(snap?.visibility, "hidden");
	assert.equal(snap?.tokens, 400);
	assert.equal(snap?.chars, undefined);
});

test("a real summary keeps its label — the downgrade is not indiscriminate", () => {
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	t.delta("a", "s", "the model explained itself here");
	t.setTokens("a", "s", 400);
	t.end("a", "s");

	assert.equal(t.snapshot("a", "s")?.visibility, "summary");
});

test("a redacted phase is NOT downgraded — it is already block-proven", () => {
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "redacted");
	t.start("a", "s", "redacted");
	t.setTokens("a", "s", 120);
	t.end("a", "s");

	assert.equal(t.snapshot("a", "s")?.visibility, "redacted");
});

/* ─────────────────────────────────────────────────────────────────────────
 * The regressions an adversarial review reproduced against the real class.
 *
 * `end()` fires once per model ROUNDTRIP, not per logical turn, and `start()`
 * used to reset `chars` per PHASE. Together those made the "no text arrived"
 * downgrade fire on turns that had streamed a real summary, and latch for the
 * rest of the turn once it did.
 * ───────────────────────────────────────────────────────────────────────── */

test("a second EMPTY reasoning item does not erase a real summary", () => {
	// OpenAI's o-series / GPT-5 open one reasoning item per `output_item.added`
	// and routinely emit several per response, many with empty summaries.
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	t.delta("a", "s", "x".repeat(600)); // a real summary
	t.end("a", "s");
	t.start("a", "s", "summary"); // second item, no text at all
	t.end("a", "s");

	const snap = t.snapshot("a", "s");
	assert.equal(snap?.visibility, "summary", "600 chars of summary did arrive");
	assert.equal(snap?.chars, 600, "chars counts the whole turn, not the last phase");
});

test("late reasoning text corrects an early empty phase", () => {
	// Roundtrip 1 opens an empty phase; roundtrip 2 streams a genuine summary.
	// The old code latched `hidden` on the first and never re-evaluated, so the
	// real summary rendered under a label saying it was never exposed.
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	t.end("a", "s");
	assert.equal(t.snapshot("a", "s")?.visibility, "hidden", "nothing seen yet");

	t.start("a", "s", "summary");
	t.delta("a", "s", "y".repeat(900));
	t.end("a", "s");
	assert.equal(
		t.snapshot("a", "s")?.visibility,
		"summary",
		"the downgrade must not latch — it is derived, not stored",
	);
});

test("an ACTIVE phase is never downgraded — text may not have arrived yet", () => {
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	assert.equal(t.snapshot("a", "s")?.visibility, "summary");
});

test("a new turn re-evaluates from scratch", () => {
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	t.end("a", "s");
	assert.equal(t.snapshot("a", "s")?.visibility, "hidden");

	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	t.delta("a", "s", "fresh reasoning");
	t.end("a", "s");
	assert.equal(t.snapshot("a", "s")?.visibility, "summary");
});

test("start() defaults to summary, never raw", () => {
	// Understating fidelity is a smaller error than claiming a paraphrase is
	// the model's own chain of thought (see visibility.ts).
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.start("a", "s");
	t.delta("a", "s", "some text");
	t.end("a", "s");
	assert.equal(t.snapshot("a", "s")?.visibility, "summary");
});

/* ─────────────────────────────────────────────────────────────────────────
 * The PRODUCTION wiring, not the tracker in isolation.
 *
 * Every test above seeds `setVisibility(...,"summary")` right after
 * `beginTurn`, which is exactly the step the gateway does NOT do per block.
 * The gateway instead refines per thinking block:
 *
 *     prev = <read current>;  setVisibility(refine(prev, block))
 *
 * A reviewer showed that reading the DERIVED value there wrote the no-text
 * downgrade back into storage, where `refineReasoningVisibility` — which never
 * widens fidelity — made it permanent. These reproduce that loop.
 * ───────────────────────────────────────────────────────────────────────── */

/** Exactly what `server.ts` does for each `thinking` block on a message. */
function refineLikeGateway(
	t: ReasoningTracker,
	block: { thinking?: string; thinkingSignature?: string; redacted?: boolean },
): void {
	t.noteThinkingBlock("a", "s", block);
}

test("an empty reasoning item does not permanently pin the turn to hidden", () => {
	// OpenAI's o-series / GPT-5 emit one reasoning item per `output_item.added`,
	// many of them empty, each settling as empty-text + signature.
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");

	// Item 1: empty, but signed — legitimately refines to `hidden`.
	t.start("a", "s", "summary");
	refineLikeGateway(t, { thinking: "", thinkingSignature: "sig-1" });
	t.end("a", "s");

	// Item 2: a genuine 900-character summary.
	t.start("a", "s", "summary");
	t.delta("a", "s", "y".repeat(900));
	refineLikeGateway(t, { thinking: "y".repeat(900), thinkingSignature: "sig-2" });
	t.end("a", "s");

	const snap = t.snapshot("a", "s");
	assert.equal(snap?.chars, 900, "the summary did arrive");
	assert.notEqual(
		snap?.visibility,
		"hidden",
		"900 chars of summary must not render as 'not exposed by this model'",
	);
});

test("the derived downgrade is never written back into storage", () => {
	// The mechanism itself: after a settled empty turn the REPORTED value is
	// `hidden`, but the STORED value must still be `summary` — otherwise the
	// next refine reads `hidden` as its floor and can never climb back.
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	t.end("a", "s");

	assert.equal(t.snapshot("a", "s")?.visibility, "hidden", "reported: nothing arrived");
	assert.equal(t.declaredVisibility("a", "s"), "summary", "stored: what the backend can return");

	// An empty block records nothing at all now — `chars` already knows whether
	// text arrived, so there is no value to write back and therefore nothing
	// that can latch.
	refineLikeGateway(t, { thinking: "" });
	assert.equal(t.declaredVisibility("a", "s"), "summary");
});

test("a genuinely redacted phase still refines to redacted", () => {
	// The guard must not block real downgrades — only the derived one.
	const t = new ReasoningTracker();
	t.beginTurn("a", "s");
	t.setVisibility("a", "s", "summary");
	t.start("a", "s", "summary");
	refineLikeGateway(t, { redacted: true, thinkingSignature: "sig" });
	t.end("a", "s");
	assert.equal(t.snapshot("a", "s")?.visibility, "redacted");
});
