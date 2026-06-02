import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { extractFrameTags, shouldDeliverFrame } from "./ws-subscription-filter.js";

describe("ws-subscription-filter — shouldDeliverFrame (Wave I)", () => {
	it("untagged frames broadcast to everyone (no agentId, no sessionId)", () => {
		const agentSubs = new Set(["ops"]);
		const sessionSubs = new Set(["agent:ops:main"]);
		assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, {}), true);
		assert.equal(shouldDeliverFrame(undefined, undefined, {}), true);
	});

	it("clients with no subscriptions get every frame (back-compat)", () => {
		// A legacy single-agent TUI that never sent `subscribe` should still
		// receive tagged frames — multi-agent is opt-in via subscribe().
		assert.equal(
			shouldDeliverFrame(undefined, undefined, { agentId: "ops" }),
			true,
		);
		assert.equal(
			shouldDeliverFrame(undefined, undefined, { sessionId: "agent:ops:main" }),
			true,
		);
	});

	it("subscription on agentId routes the frame", () => {
		const agentSubs = new Set(["ops"]);
		assert.equal(
			shouldDeliverFrame(agentSubs, undefined, { agentId: "ops" }),
			true,
		);
		assert.equal(
			shouldDeliverFrame(agentSubs, undefined, { agentId: "main" }),
			false,
			"a different agent's frame is filtered out",
		);
	});

	it("subscription on sessionId routes the frame", () => {
		const sessionSubs = new Set(["agent:ops:main"]);
		assert.equal(
			shouldDeliverFrame(undefined, sessionSubs, { sessionId: "agent:ops:main" }),
			true,
		);
		assert.equal(
			shouldDeliverFrame(undefined, sessionSubs, { sessionId: "agent:main:main" }),
			false,
		);
	});

	it("an agentId match wins even if sessionId mismatches", () => {
		const agentSubs = new Set(["ops"]);
		const sessionSubs = new Set(["agent:main:main"]);
		// Frame is for ops + a session this client isn't tracking; the agent
		// subscription still routes the frame.
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, {
				agentId: "ops",
				sessionId: "agent:ops:main",
			}),
			true,
		);
	});

	it("two clients on two agents each only get their own frames (Wave I happy path)", () => {
		// Mirrors the gateway's two-operator topology. The problem Wave H was
		// supposed to fix was "every TUI sees every agent" — Wave I closes it by
		// making sure pi/log/system-event broadcasts ARE tagged so this filter
		// actually fires instead of falling through to the back-compat branch.
		const opsClientAgentSubs = new Set(["ops"]);
		const mainClientAgentSubs = new Set(["main"]);
		const opsFrame = { agentId: "ops", sessionId: "agent:ops:main" };
		const mainFrame = { agentId: "main", sessionId: "agent:main:main" };

		// Each client sees only its own agent's frame.
		assert.equal(shouldDeliverFrame(opsClientAgentSubs, undefined, opsFrame), true);
		assert.equal(shouldDeliverFrame(opsClientAgentSubs, undefined, mainFrame), false);
		assert.equal(shouldDeliverFrame(mainClientAgentSubs, undefined, opsFrame), false);
		assert.equal(shouldDeliverFrame(mainClientAgentSubs, undefined, mainFrame), true);
	});
});

describe("ws-subscription-filter — extractFrameTags", () => {
	it("returns empty tags for non-objects", () => {
		assert.deepEqual(extractFrameTags(null), {});
		assert.deepEqual(extractFrameTags(undefined), {});
		assert.deepEqual(extractFrameTags("string"), {});
		assert.deepEqual(extractFrameTags(42), {});
	});

	it("returns empty tags for objects without agentId/sessionId", () => {
		assert.deepEqual(extractFrameTags({ level: "info", message: "hi" }), {});
	});

	it("extracts only string agentId/sessionId fields", () => {
		assert.deepEqual(
			extractFrameTags({ agentId: "ops", sessionId: "agent:ops:main" }),
			{ agentId: "ops", sessionId: "agent:ops:main" },
		);
	});

	it("ignores non-string agentId/sessionId values", () => {
		// Defensive: payloads from untyped callsites must not coerce numbers.
		assert.deepEqual(extractFrameTags({ agentId: 42, sessionId: null }), {});
	});

	it("partial tagging is preserved (agentId only / sessionId only)", () => {
		assert.deepEqual(extractFrameTags({ agentId: "ops" }), { agentId: "ops" });
		assert.deepEqual(extractFrameTags({ sessionId: "s1" }), { sessionId: "s1" });
	});
});
