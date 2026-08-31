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

	it("delivers a sub-agent DESCENDANT session to the client watching the parent", () => {
		// A spawned sub-agent runs under a child key `<parent>:subagent:<id>`.
		// The operator watching the parent session must receive its pi frames +
		// approval prompts — otherwise the sub-agent's `bash` approval never
		// surfaces and the turn hangs on the timeout.
		const sessionSubs = new Set(["agent:main:main"]);
		assert.equal(
			shouldDeliverFrame(undefined, sessionSubs, { sessionId: "agent:main:main:subagent:abc" }),
			true,
			"descendant sub-agent session is in-lane",
		);
		assert.equal(
			shouldDeliverFrame(undefined, sessionSubs, { sessionId: "agent:main:main:subagent:abc:subagent:def" }),
			true,
			"nested sub-agent session is in-lane",
		);
	});

	it("a sibling session is NOT treated as a descendant (trailing-colon guard)", () => {
		const sessionSubs = new Set(["agent:main:main"]);
		assert.equal(
			shouldDeliverFrame(undefined, sessionSubs, { sessionId: "agent:main:main2" }),
			false,
			"`…:main2` must not match `…:main`",
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

/* ────────────── session isolation across concurrent threads ────────────── */

describe("session isolation across concurrent threads", () => {


	it("a client bound to one thread does NOT receive another thread's frames", () => {
		// The reported bug: a web search or sub-agent running in one session showed
		// up in another session's UI. The TUI subscribes to BOTH its agentId and its
		// sessionId, and the filter tested agentId FIRST — so binding to one thread
		// delivered every frame from every session of that agent, cron and channel
		// sessions included.
		const agentSubs = new Set(["main"]);
		const sessionSubs = new Set(["agent:main:main"]);

		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, { agentId: "main", sessionId: "agent:main:main" }),
			true,
			"its own thread still arrives",
		);
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, { agentId: "main", sessionId: "agent:main:thread:other" }),
			false,
			"a sibling thread of the SAME agent must not leak in",
		);
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, { agentId: "main", sessionId: "agent:main:cron:nightly" }),
			false,
			"a cron session must not leak in",
		);
	});

	it("sub-agent frames still reach the parent's watcher, by parentSessionKey", () => {
		// A child key is `agent:<childAgent>:subagent:<uuid>` — built from the CHILD's
		// agent, so it shares no prefix with the parent's session key and the
		// descendant rule can never match it. Narrowing to session subs would have
		// hidden sub-agent output entirely without this.
		const agentSubs = new Set(["main"]);
		const sessionSubs = new Set(["agent:main:main"]);

		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, {
				agentId: "research",
				sessionId: "agent:research:subagent:abc-123",
				parentSessionKey: "agent:main:main",
			}),
			true,
			"my thread's child is mine to see",
		);
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, {
				agentId: "research",
				sessionId: "agent:research:subagent:def-456",
				parentSessionKey: "agent:main:thread:other",
			}),
			false,
			"another thread's child stays in that thread",
		);
	});

	it("a grandchild reaches the operator once tagged with its ROOT ancestor", () => {
		// `spawnedBy` names only the IMMEDIATE parent, so a depth-2 sub-agent's
		// parent key is another sub-agent session the operator never subscribed
		// to — rule 4 correctly narrowed and dropped it. The gateway now walks the
		// ancestry chain and tags the frame with the root, which is what makes
		// nesting work at the policy's full depth of 3.
		const agentSubs = new Set(["main"]);
		const sessionSubs = new Set(["agent:main:main"]);
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, {
				agentId: "deep",
				sessionId: "agent:deep:subagent:b",
				parentSessionKey: "agent:main:main", // resolved root, not the immediate parent
			}),
			true,
		);
		// An untagged-by-root grandchild of ANOTHER thread still stays out.
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, {
				agentId: "deep",
				sessionId: "agent:deep:subagent:c",
				parentSessionKey: "agent:main:thread:other",
			}),
			false,
		);
	});

	it("subscribing to an agent WITHOUT a session still gets the whole firehose", () => {
		// The agent rule is not removed — it is the fallback for a client that asked
		// for an agent rather than a thread.
		const agentSubs = new Set(["main"]);
		assert.equal(shouldDeliverFrame(agentSubs, undefined, { agentId: "main", sessionId: "agent:main:cron:x" }), true);
		assert.equal(shouldDeliverFrame(agentSubs, new Set(), { agentId: "main", sessionId: "agent:main:thread:y" }), true);
	});

	it("frames with no session tag still route by agent", () => {
		const agentSubs = new Set(["main"]);
		const sessionSubs = new Set(["agent:main:main"]);
		assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, { agentId: "main" }), true);
		assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, { agentId: "ops" }), false);
	});

	it("extractFrameTags carries parentSessionKey", () => {
		const tags = extractFrameTags({ agentId: "a", sessionId: "s", parentSessionKey: "p" });
		assert.equal(tags.parentSessionKey, "p");
		assert.equal(extractFrameTags({ agentId: "a" }).parentSessionKey, undefined);
	});
});

/* ─────────── mid-turn compaction frames must reach the operator ─────────── */

describe("mid-turn compaction frame routing", () => {
	it("a synthetic mid-turn compaction frame reaches the session's watcher", () => {
	// The bug this locks down: the frame was tagged with `resolved.sessionId` —
	// a randomUUID — instead of the session KEY. Rule 4 then made the (false)
	// session match authoritative and dropped it, and since a depth-0 frame has
	// no `parentSessionKey`, rule 3 could not rescue it. The operator got the
	// silent two-minute stall the feature exists to prevent, and the
	// summarization was billed to an unparseable key.
	const agentSubs = new Set(["main"]);
	const sessionSubs = new Set(["agent:main:main"]);

	assert.equal(
		shouldDeliverFrame(agentSubs, sessionSubs, {
			agentId: "main",
			sessionId: "agent:main:main",
		}),
		true,
		"tagged with the session key — delivered",
	);
	assert.equal(
		shouldDeliverFrame(agentSubs, sessionSubs, {
			agentId: "main",
			sessionId: "3f8c1e2a-0b44-4c9e-9a11-77d2f0e5b6c3",
		}),
		false,
		"tagged with the raw sessionId UUID — silently dropped, which is the bug",
	);
});

	it("a sub-agent's mid-turn compaction frame reaches the parent's watcher", () => {
	// A child compacting its own context is still the operator's spend and the
	// operator's stall; it routes by parent, exactly as the child's other frames do.
	assert.equal(
		shouldDeliverFrame(new Set(["main"]), new Set(["agent:main:main"]), {
			agentId: "helper",
			sessionId: "agent:helper:subagent:abc",
			parentSessionKey: "agent:main:main",
		}),
		true,
	);
});
});

describe("subscription scope — the opt-out for the narrowing", () => {
	// Naming a session narrows delivery to that session. That is the
	// cross-session-bleed fix and stays the DEFAULT. But a client can name a
	// session for another reason entirely — Brigade's own desktop app sends
	// `subscribe { agentId, sessionId }` because its snapshot push is gated on
	// the session id, not because it wants a narrower stream.
	//
	// An opt-out rather than a version bump: `PROTOCOL_VERSION` is read by
	// nothing, Brigade cannot serve two behaviours at once, and a bump could
	// only ever mean "take it or leave it" to a client doing `=== 1`.
	const agentSubs = new Set(["main"]);
	const sessionSubs = new Set(["agent:main:main"]);
	const otherThread = { agentId: "main", sessionId: "agent:main:thread:cron" };

	it("defaults to narrow — another thread on the same agent is filtered out", () => {
		assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, otherThread), false);
	});

	it('scope "agent" restores the pre-narrowing breadth', () => {
		assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, otherThread, "agent"), true);
	});

	it('scope "session" is explicit-equals-default', () => {
		assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, otherThread, "session"), false);
	});

	it("the named session is delivered under either scope", () => {
		const own = { agentId: "main", sessionId: "agent:main:main" };
		for (const scope of ["session", "agent"] as const) {
			assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, own, scope), true, scope);
		}
	});

	it("a sub-agent of the watched thread is delivered under either scope", () => {
		const child = {
			agentId: "helper",
			sessionId: "agent:helper:subagent:x",
			parentSessionKey: "agent:main:main",
		};
		for (const scope of ["session", "agent"] as const) {
			assert.equal(shouldDeliverFrame(agentSubs, sessionSubs, child, scope), true, scope);
		}
	});

	it("broad scope still does not leak a DIFFERENT agent", () => {
		// The opt-out widens within an agent you subscribed to — never across agents.
		assert.equal(
			shouldDeliverFrame(agentSubs, sessionSubs, { agentId: "other", sessionId: "agent:other:main" }, "agent"),
			false,
		);
	});
});
