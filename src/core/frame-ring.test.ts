/**
 * The ring's whole value is the honesty of `complete`. A client that trusts a
 * partial replay as total silently skips real content, which is worse than the
 * gap it was trying to repair — so most of these tests are about that flag,
 * not about storage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyFrame, FrameRing } from "./frame-ring.js";

test("replays exactly the frames after the cursor, oldest first", () => {
	const ring = new FrameRing();
	for (let seq = 1; seq <= 5; seq += 1) ring.retain("s", seq, `{"seq":${seq}}`);

	const { frames, complete } = ring.replayFrom("s", 2);
	assert.deepEqual(frames.map((f) => f.seq), [3, 4, 5]);
	assert.equal(complete, true);
});

test("the retained bytes are the ones that were broadcast", () => {
	// Re-serializing could reorder keys; the point of a replay is the SAME bytes.
	const ring = new FrameRing();
	const json = '{"event":"pi","payload":{"z":1,"a":2}}';
	ring.retain("s", 1, json);
	assert.equal(ring.replayFrom("s", 0).frames[0]?.json, json);
});

test("a cursor already at the head is complete with nothing to send", () => {
	const ring = new FrameRing();
	ring.retain("s", 1, "{}");
	ring.retain("s", 2, "{}");
	const { frames, complete } = ring.replayFrom("s", 2);
	assert.deepEqual(frames, []);
	assert.equal(complete, true);
});

test("a cursor older than what survived is NOT reported complete", () => {
	// This is the case that must never lie. Frames 1-2 are gone; a client asking
	// from 0 cannot be made whole from the ring, and saying otherwise would make
	// it skip them silently.
	const ring = new FrameRing({ maxFrames: 3 });
	for (let seq = 1; seq <= 5; seq += 1) ring.retain("s", seq, `{"seq":${seq}}`);

	const { frames, complete } = ring.replayFrom("s", 0);
	assert.deepEqual(frames.map((f) => f.seq), [3, 4, 5]);
	assert.equal(complete, false, "frames 1-2 were evicted — the caller must fall back");
});

test("an empty or unknown session is never reported complete", () => {
	const ring = new FrameRing();
	assert.equal(ring.replayFrom("nope", 0).complete, false);
	assert.equal(ring.replayFrom(undefined, 0).complete, false);
});

test("the frame bound evicts oldest first", () => {
	const ring = new FrameRing({ maxFrames: 3 });
	for (let seq = 1; seq <= 10; seq += 1) ring.retain("s", seq, `{"seq":${seq}}`);
	assert.equal(ring.countFor("s"), 3);
	assert.deepEqual(ring.replayFrom("s", 0).frames.map((f) => f.seq), [8, 9, 10]);
});

test("the byte bound evicts even when the frame count is fine", () => {
	const ring = new FrameRing({ maxFrames: 1000, maxBytes: 100 });
	for (let seq = 1; seq <= 10; seq += 1) ring.retain("s", seq, "x".repeat(40));
	// 40 bytes each, 100-byte ceiling — only the newest few survive.
	assert.ok(ring.countFor("s") <= 3, `expected <=3 retained, got ${ring.countFor("s")}`);
});

test("a single frame larger than the whole budget is still retained", () => {
	// Dropping it would leave a hole nothing can fill, which is worse than
	// briefly exceeding a soft ceiling.
	const ring = new FrameRing({ maxFrames: 10, maxBytes: 10 });
	ring.retain("s", 1, "x".repeat(5000));
	assert.equal(ring.countFor("s"), 1);
});

test("sessions are bounded, coldest dropped first", () => {
	const ring = new FrameRing({ maxSessions: 2 });
	ring.retain("a", 1, "{}");
	ring.retain("b", 1, "{}");
	ring.retain("c", 1, "{}");
	assert.equal(ring.size, 2);
	assert.equal(ring.countFor("a"), 0, "the coldest session is dropped");
	assert.equal(ring.countFor("c"), 1);
});

test("writing to a session keeps it warm against eviction", () => {
	const ring = new FrameRing({ maxSessions: 2 });
	ring.retain("a", 1, "{}");
	ring.retain("b", 1, "{}");
	ring.retain("a", 2, "{}"); // touch "a"
	ring.retain("c", 1, "{}"); // evicts the coldest, which is now "b"
	assert.equal(ring.countFor("a"), 2);
	assert.equal(ring.countFor("b"), 0);
});

test("forget drops a session outright", () => {
	const ring = new FrameRing();
	ring.retain("s", 1, "{}");
	ring.forget("s");
	assert.equal(ring.countFor("s"), 0);
});

test("malformed input never throws on the broadcast path", () => {
	const ring = new FrameRing();
	assert.doesNotThrow(() => {
		ring.retain(undefined, 1, "{}");
		ring.retain("s", Number.NaN, "{}");
		ring.retain("s", Number.POSITIVE_INFINITY, "{}");
	});
	assert.equal(ring.countFor("s"), 0, "non-finite seqs are refused, not stored");
});

/* ─── classifyFrame: the rule that decides what is recoverable ─────────────
 * Previously inline in `broadcast()`, where covering it meant booting a
 * gateway — so the decision determining what survives a disconnect had no
 * direct test, on the one path where being wrong loses output in silence.
 * ───────────────────────────────────────────────────────────────────────── */

test("a top-level pi frame is ordered but rebuilt from the transcript", () => {
	const c = classifyFrame({ event: "pi", subagentDepth: 0 });
	assert.equal(c.ordered, true);
	assert.equal(c.replayOnly, false, "the JSONL transcript already holds it");
});

test("a sub-agent frame is ordered AND must be retained", () => {
	// It carries the child's session id and lives in a child transcript the
	// parent's resume never reads — retention is its only recovery path.
	const c = classifyFrame({ event: "pi", subagentDepth: 1 });
	assert.equal(c.ordered, true);
	assert.equal(c.replayOnly, true);
});

test("a synthetic frame is ordered AND must be retained", () => {
	// Minted for a claude-cli turn whose tools run in the binary's own loop.
	// In no transcript at all.
	const c = classifyFrame({ event: "pi", subagentDepth: 0, synthetic: true });
	assert.equal(c.ordered, true);
	assert.equal(c.replayOnly, true);
});

test("retention implies sequencing — never a seq we cannot replay", () => {
	// The invariant the whole design turns on. A seq on an unreplayable frame
	// makes every dropped decoration an unrepairable gap and thrashes resume.
	for (const input of [
		{ event: "pi", subagentDepth: 0 },
		{ event: "pi", subagentDepth: 3 },
		{ event: "pi", subagentDepth: 0, synthetic: true },
		{ event: "approval-request" },
		{ event: "system-event" },
		{ event: "state" },
		{ event: "log" },
	]) {
		const c = classifyFrame(input);
		if (c.replayOnly) assert.equal(c.ordered, true, `${JSON.stringify(input)} retained but unsequenced`);
	}
});

test("approval-request and system-event are ordered, and not retained here", () => {
	// Both already have their own recovery path in `resume` (pending approvals
	// are re-listed; system-events keep a bounded tail), so duplicating them in
	// the ring would double-deliver on reconnect.
	for (const event of ["approval-request", "system-event"]) {
		const c = classifyFrame({ event });
		assert.equal(c.ordered, true, event);
		assert.equal(c.replayOnly, false, event);
	}
});

test("unordered side-channels stay unordered", () => {
	// `state` is a self-healing cumulative snapshot; `error`/`log` are not the
	// transcript. Sequencing them would invent gaps that mean nothing.
	for (const event of ["state", "error", "log"]) {
		const c = classifyFrame({ event });
		assert.equal(c.ordered, false, event);
		assert.equal(c.replayOnly, false, event);
	}
});

test("a non-pi frame is never treated as a sub-agent frame", () => {
	// `subagentDepth` is only meaningful on `pi`; a stray value on another event
	// must not smuggle it into retention.
	const c = classifyFrame({ event: "state", subagentDepth: 4, synthetic: true });
	assert.equal(c.ordered, false);
	assert.equal(c.replayOnly, false);
});

test("a malformed depth degrades to top-level, never throws", () => {
	for (const depth of [Number.NaN, undefined, -1]) {
		const c = classifyFrame({ event: "pi", subagentDepth: depth as number | undefined });
		assert.equal(c.ordered, true);
		assert.equal(c.replayOnly, false);
	}
});
