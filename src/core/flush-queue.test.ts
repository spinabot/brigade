/**
 * Promoting a queued message into the running turn.
 *
 * The operator queued messages while the model worked and has now decided it
 * should see them without waiting for the turn to end — DeepSeek's empty-draft
 * gesture. Two things make it safe, and both are asserted here:
 *
 *   • `clearQueue()` REMOVES what it returns, so nothing is delivered twice and
 *     Brigade needs no shadow queue that could drift from Pi's.
 *   • A turn can end between the drain and the re-queue, so anything already
 *     drained must be put back rather than evaporating.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { promoteQueue } from "./flush-queue.js";

/** Minimal stand-in for the parts of `AgentSession` this touches. */
function fakeSession(
	queue: { steering: string[]; followUp: string[] },
	opts: { failSteerAfter?: number } = {},
) {
	const steered: string[] = [];
	const followedUp: string[] = [];
	let cleared = 0;
	return {
		steered,
		followedUp,
		clearedCount: () => cleared,
		session: {
			clearQueue: () => {
				cleared += 1;
				const out = { steering: [...queue.steering], followUp: [...queue.followUp] };
				queue.steering = [];
				queue.followUp = [];
				return out;
			},
			steer: async (text: string) => {
				if (opts.failSteerAfter !== undefined && steered.length >= opts.failSteerAfter) {
					throw new Error("turn ended");
				}
				steered.push(text);
			},
			followUp: async (text: string) => {
				followedUp.push(text);
			},
		},
	};
}

test("queued follow-ups are promoted into the running turn, in order", async () => {
	const f = fakeSession({ steering: [], followUp: ["first", "second", "third"] });
	const n = await promoteQueue(f.session as never);
	assert.equal(n, 3);
	assert.deepEqual(f.steered, ["first", "second", "third"], "FIFO order is preserved");
});

test("existing steering keeps its head start over promoted follow-ups", async () => {
	// Those were already asked to be immediate; promoting a follow-up must not
	// jump ahead of a message the operator explicitly steered.
	const f = fakeSession({ steering: ["urgent"], followUp: ["queued-a", "queued-b"] });
	await promoteQueue(f.session as never);
	assert.deepEqual(f.steered, ["urgent", "queued-a", "queued-b"]);
});

test("an empty queue promotes nothing and does not steer", async () => {
	// The empty case is the one the operator most needs told: it means their
	// messages already landed and the model has moved on.
	const f = fakeSession({ steering: [], followUp: [] });
	assert.equal(await promoteQueue(f.session as never), 0);
	assert.deepEqual(f.steered, []);
});

test("the queue is drained exactly once — nothing is delivered twice", async () => {
	const f = fakeSession({ steering: [], followUp: ["a", "b"] });
	await promoteQueue(f.session as never);
	assert.equal(f.clearedCount(), 1);
	// A second flush finds nothing, because the first one removed it.
	assert.equal(await promoteQueue(f.session as never), 0);
	assert.deepEqual(f.steered, ["a", "b"], "no duplicates");
});

test("if the turn ends mid-promotion, the remainder is put back — not lost", async () => {
	// `clearQueue` already removed them from Pi. Dropping the rest on a failure
	// would silently destroy the operator's messages.
	const f = fakeSession({ steering: [], followUp: ["a", "b", "c"] }, { failSteerAfter: 1 });
	await assert.rejects(() => promoteQueue(f.session as never), /turn ended/);
	assert.deepEqual(f.steered, ["a"], "only the first landed");
	assert.deepEqual(f.followedUp, ["b", "c"], "the rest are restored for the next turn");
});

test("a session that dies completely does not throw past the restore", async () => {
	// Best-effort restore: if followUp also fails there is nothing further to do,
	// but the original error must still surface.
	const dead = {
		clearQueue: () => ({ steering: [], followUp: ["a", "b"] }),
		steer: async () => {
			throw new Error("gone");
		},
		followUp: async () => {
			throw new Error("also gone");
		},
	};
	await assert.rejects(() => promoteQueue(dead as never), /gone/);
});
