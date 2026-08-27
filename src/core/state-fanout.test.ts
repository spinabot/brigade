import assert from "node:assert/strict";
import { test } from "node:test";

import { planStateFanout } from "./state-fanout.js";

// Mirrors `parseAgentSessionKey`'s agent extraction for canonical keys.
const ownerOf = (sk: string): string | undefined => {
	const m = /^agent:([^:]+):.+$/.exec(sk);
	return m ? m[1] : undefined;
};

const plan = (
	agentSubs: string[] | undefined,
	sessionSubs: string[] | undefined,
	bootAgentId = "main",
) =>
	planStateFanout({
		agentSubs: agentSubs ? new Set(agentSubs) : undefined,
		sessionSubs: sessionSubs ? new Set(sessionSubs) : undefined,
		bootAgentId,
		ownerOf,
	});

// The regression that would break every client: a connection must always be
// planned at least one frame, or state updates stop arriving entirely.
test("every connection is always planned at least one frame", () => {
	const cases: Array<[string[] | undefined, string[] | undefined]> = [
		[undefined, undefined],
		[[], []],
		[["main"], undefined],
		[undefined, ["agent:main:t-1"]],
		[["main", "ops"], ["agent:ops:t-9"]],
		[["main"], ["agent:main:t-1", "agent:main:t-2"]],
	];
	for (const [a, s] of cases) {
		assert.ok(plan(a, s).length >= 1, `no frame planned for ${JSON.stringify([a, s])}`);
	}
});

test("un-subscribed client still gets the boot-agent snapshot", () => {
	assert.deepEqual(plan(undefined, undefined), [{ agentId: undefined, sessionKey: undefined }]);
	assert.deepEqual(plan([], []), [{ agentId: undefined, sessionKey: undefined }]);
});

test("the bound thread rides along on its own agent's snapshot", () => {
	assert.deepEqual(plan(["main"], ["agent:main:t-1"]), [
		{ agentId: "main", sessionKey: "agent:main:t-1" },
	]);
});

// Carrying agent A's thread into agent B's snapshot would read B's store for
// A's key and report a pin that does not apply there.
test("a thread never rides on another agent's snapshot", () => {
	assert.deepEqual(plan(["ops"], ["agent:main:t-1"]), [
		{ agentId: "ops", sessionKey: undefined },
	]);
	assert.deepEqual(plan(["main", "ops"], ["agent:ops:t-9"]), [
		{ agentId: "main", sessionKey: undefined },
		{ agentId: "ops", sessionKey: "agent:ops:t-9" },
	]);
});

test("agent fan-out is preserved: one frame per subscribed agent", () => {
	const out = plan(["main", "ops", "coder"], undefined);
	assert.equal(out.length, 3);
	assert.deepEqual(
		out.map((t) => t.agentId),
		["main", "ops", "coder"],
	);
	assert.ok(out.every((t) => t.sessionKey === undefined));
});

// Zero or many session subs cannot identify "the thread being viewed".
test("an ambiguous session binding falls back to agent-level", () => {
	assert.deepEqual(plan(["main"], ["agent:main:t-1", "agent:main:t-2"]), [
		{ agentId: "main", sessionKey: undefined },
	]);
	assert.deepEqual(plan(["main"], []), [{ agentId: "main", sessionKey: undefined }]);
});

test("a session-only subscription rides the boot agent when it owns the key", () => {
	assert.deepEqual(plan(undefined, ["agent:main:t-1"]), [
		{ agentId: undefined, sessionKey: "agent:main:t-1" },
	]);
	// ...but not when it belongs to a different agent.
	assert.deepEqual(plan(undefined, ["agent:ops:t-1"]), [
		{ agentId: undefined, sessionKey: undefined },
	]);
});

test("a non-canonical session key is never carried", () => {
	assert.deepEqual(plan(["main"], ["constructor"]), [
		{ agentId: "main", sessionKey: undefined },
	]);
	assert.deepEqual(plan(["main"], ["not-a-key"]), [{ agentId: "main", sessionKey: undefined }]);
});
