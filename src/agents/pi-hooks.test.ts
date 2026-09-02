/**
 * Pi hooks must be COMPOSED, never assigned over.
 *
 * `AgentSession` installs its own `beforeToolCall` at construction, and that
 * handler is the ONLY bridge from Pi's extension runner to the loop
 * (`agent-session.js:185-206`). It is a plain mutable field, so
 * `agent.beforeToolCall = ours` compiles, runs, and silently unbinds the whole
 * `tool_call` extension event — no error, no warning, no failing test. That is
 * the exact shape of the defect that left Brigade's `transformContext` chain
 * dead in production behind a green suite.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { installBrigadeBeforeToolCall } from "./pi-hooks.js";
import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

/** Stands in for the session shape the installer reaches through. */
function fakeSession(agent: Record<string, unknown>) {
	return { agent } as never;
}

const allow: BrigadeBeforeToolCallHook = async () => undefined;
const block = (reason: string): BrigadeBeforeToolCallHook => async () => ({ block: true, reason });

const ctx = { toolCall: { name: "bash", arguments: { command: "ls" } }, args: {} };

test("Pi's existing handler still runs — the extension bridge survives", async () => {
	// The regression: a bare assignment left an extension registering
	// `tool_call` loading cleanly, reporting as registered, and never firing.
	let piRan = 0;
	const agent: Record<string, unknown> = {
		beforeToolCall: async () => {
			piRan += 1;
			return undefined;
		},
	};
	installBrigadeBeforeToolCall(fakeSession(agent), allow);
	await (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx);
	assert.equal(piRan, 1);
});

test("Brigade's guard runs FIRST and short-circuits a blocked call", async () => {
	// A call the exec-gate refuses must never reach third-party extension code,
	// and the operator must never be prompted to approve something already
	// destined to be blocked.
	let piRan = 0;
	const order: string[] = [];
	const agent: Record<string, unknown> = {
		beforeToolCall: async () => {
			piRan += 1;
			order.push("pi");
			return undefined;
		},
	};
	installBrigadeBeforeToolCall(
		fakeSession(agent),
		async () => {
			order.push("brigade");
			return { block: true, reason: "refused by exec-gate" };
		},
	);
	const verdict = (await (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx)) as {
		block?: boolean;
		reason?: string;
	};
	assert.equal(verdict?.block, true);
	assert.equal(verdict?.reason, "refused by exec-gate");
	assert.equal(piRan, 0, "extensions are not consulted about a refused call");
	assert.deepEqual(order, ["brigade"]);
});

test("an extension's block is honoured when Brigade allows", async () => {
	const agent: Record<string, unknown> = {
		beforeToolCall: async () => ({ block: true, reason: "extension says no" }),
	};
	installBrigadeBeforeToolCall(fakeSession(agent), allow);
	const verdict = (await (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx)) as {
		block?: boolean;
		reason?: string;
	};
	assert.equal(verdict?.block, true);
	assert.equal(verdict?.reason, "extension says no");
});

test("both allowing means the call proceeds", async () => {
	const agent: Record<string, unknown> = { beforeToolCall: async () => undefined };
	installBrigadeBeforeToolCall(fakeSession(agent), allow);
	const verdict = await (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx);
	assert.equal((verdict as { block?: boolean } | undefined)?.block, undefined);
});

test("an extension that THROWS still blocks — its refusal is not swallowed", async () => {
	// Pi documents the bridge as throwing when an extension fails, and its loop
	// treats that as blocking execution. Catching it here would silently convert
	// a deliberate refusal into an allow.
	const agent: Record<string, unknown> = {
		beforeToolCall: async () => {
			throw new Error("Extension failed, blocking execution: nope");
		},
	};
	installBrigadeBeforeToolCall(fakeSession(agent), allow);
	await assert.rejects(
		() => (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx),
		/blocking execution/,
	);
});

test("a guard block wins even over a throwing extension", async () => {
	// Ordering matters for exactly this: the security verdict is returned before
	// the extension is ever invoked, so a broken extension cannot mask it.
	const agent: Record<string, unknown> = {
		beforeToolCall: async () => {
			throw new Error("boom");
		},
	};
	installBrigadeBeforeToolCall(fakeSession(agent), block("refused"));
	const verdict = (await (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx)) as {
		block?: boolean;
	};
	assert.equal(verdict?.block, true);
});

test("a session with no Pi handler still gets Brigade's guard", async () => {
	const agent: Record<string, unknown> = {};
	installBrigadeBeforeToolCall(fakeSession(agent), block("refused"));
	const verdict = (await (agent.beforeToolCall as (c: unknown) => Promise<unknown>)(ctx)) as {
		block?: boolean;
	};
	assert.equal(verdict?.block, true);
});

test("installing on a session with no agent is a no-op, not a crash", () => {
	assert.doesNotThrow(() => installBrigadeBeforeToolCall({} as never, allow));
});
