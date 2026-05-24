import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT,
	DEFAULT_SUBAGENT_MAX_DEPTH,
	DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
	SubagentLimitError,
	buildChildSessionKey,
	clearSubagentRegistryForTests,
	countActiveChildren,
	filterToolsForSubagentDepth,
	getChildRunRecord,
	getSubagentDepthFromSessionKey,
	isSubagentSessionKey,
	listActiveChildren,
	listRecentlyEndedChildren,
	markSubagentRunStarted,
	releaseSubagentSlot,
	reserveSubagentSlot,
	resolveSubagentLimits,
} from "./subagent-policy.js";

const STANDARD_LIMITS = {
	maxDepth: 1,
	maxChildrenPerParent: 5,
	defaultTimeoutSeconds: 300,
};

afterEach(() => clearSubagentRegistryForTests());

describe("session key shape", () => {
	it("isSubagentSessionKey detects the ':subagent:' marker", () => {
		assert.equal(isSubagentSessionKey("agent:main:main"), false);
		assert.equal(isSubagentSessionKey("agent:main:subagent:abc"), true);
		assert.equal(isSubagentSessionKey(undefined), false);
		assert.equal(isSubagentSessionKey(""), false);
	});

	it("getSubagentDepthFromSessionKey counts markers", () => {
		assert.equal(getSubagentDepthFromSessionKey("agent:main:main"), 0);
		assert.equal(getSubagentDepthFromSessionKey("agent:main:subagent:abc"), 1);
		assert.equal(
			getSubagentDepthFromSessionKey("agent:main:subagent:abc:subagent:def"),
			2,
		);
		assert.equal(getSubagentDepthFromSessionKey(undefined), 0);
		assert.equal(getSubagentDepthFromSessionKey(""), 0);
	});

	it("buildChildSessionKey appends the marker + uuid", () => {
		const child = buildChildSessionKey("agent:main:main", "abc-123");
		assert.equal(child, "agent:main:main:subagent:abc-123");
		assert.equal(getSubagentDepthFromSessionKey(child), 1);
	});

	it("buildChildSessionKey rejects empty parent", () => {
		assert.throws(() => buildChildSessionKey("", "abc"), /parentSessionKey required/);
	});

	it("buildChildSessionKey nests cleanly when parent is itself a sub-agent", () => {
		const grandchild = buildChildSessionKey(
			"agent:main:main:subagent:abc",
			"xyz",
		);
		assert.equal(grandchild, "agent:main:main:subagent:abc:subagent:xyz");
		assert.equal(getSubagentDepthFromSessionKey(grandchild), 2);
	});
});

describe("resolveSubagentLimits", () => {
	it("returns the documented defaults when config is empty / undefined", () => {
		assert.deepEqual(resolveSubagentLimits(undefined), {
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			maxChildrenPerParent: DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT,
			defaultTimeoutSeconds: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
		});
		assert.deepEqual(resolveSubagentLimits({} as never), {
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			maxChildrenPerParent: DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT,
			defaultTimeoutSeconds: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
		});
	});

	it("honours config overrides", () => {
		const limits = resolveSubagentLimits({
			agents: {
				defaults: {
					subagents: {
						maxDepth: 2,
						maxChildrenPerParent: 8,
						defaultTimeoutSeconds: 600,
					},
				},
			},
		} as never);
		assert.deepEqual(limits, {
			maxDepth: 2,
			maxChildrenPerParent: 8,
			defaultTimeoutSeconds: 600,
		});
	});

	it("ignores invalid types (negative, NaN, string)", () => {
		const limits = resolveSubagentLimits({
			agents: {
				defaults: {
					subagents: {
						maxDepth: -1,
						maxChildrenPerParent: Number.NaN,
						defaultTimeoutSeconds: "300",
					},
				},
			},
		} as never);
		assert.deepEqual(limits, {
			maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
			maxChildrenPerParent: DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT,
			defaultTimeoutSeconds: DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
		});
	});

	it("floors fractional values", () => {
		const limits = resolveSubagentLimits({
			agents: {
				defaults: {
					subagents: { maxDepth: 1.9, maxChildrenPerParent: 5.7, defaultTimeoutSeconds: 60.3 },
				},
			},
		} as never);
		assert.deepEqual(limits, {
			maxDepth: 1,
			maxChildrenPerParent: 5,
			defaultTimeoutSeconds: 60,
		});
	});

	it("floors maxDepth / maxChildrenPerParent / defaultTimeoutSeconds at 1 (no zero footgun)", () => {
		// All three at 0 would otherwise make spawn impossible (depth check
		// refuses 0 >= 0; concurrent check refuses 0 >= 0; timeout=0 aborts
		// immediately). Floor to 1 so a misconfigured value degrades, not breaks.
		const limits = resolveSubagentLimits({
			agents: {
				defaults: {
					subagents: { maxDepth: 0, maxChildrenPerParent: 0, defaultTimeoutSeconds: 0 },
				},
			},
		} as never);
		assert.deepEqual(limits, {
			maxDepth: 1,
			maxChildrenPerParent: 1,
			defaultTimeoutSeconds: 1,
		});
	});
});

describe("reserveSubagentSlot — atomic check + register", () => {
	it("returns a ChildRunRecord in 'reserved' state with createdAt stamped", () => {
		const record = reserveSubagentSlot({
			parentSessionKey: "agent:main:main",
			childSessionKey: "agent:main:main:subagent:c1",
			label: "audit",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "keep",
		});
		assert.equal(record.state, "reserved");
		assert.equal(record.label, "audit");
		assert.equal(record.cleanup, "keep");
		assert.equal(record.callerDepth, 0);
		assert.ok(record.createdAt > 0);
		assert.equal(record.startedAt, undefined);
		assert.equal(record.endedAt, undefined);
		assert.equal(record.outcome, undefined);
	});

	it("counts the reserved slot as active immediately", () => {
		reserveSubagentSlot({
			parentSessionKey: "agent:main:main",
			childSessionKey: "agent:main:main:subagent:c1",
			label: "audit",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "keep",
		});
		assert.equal(countActiveChildren("agent:main:main"), 1);
	});

	it("throws SubagentLimitError(depth) when caller is at max depth", () => {
		try {
			reserveSubagentSlot({
				parentSessionKey: "agent:main:subagent:abc",
				childSessionKey: "agent:main:subagent:abc:subagent:c1",
				label: "audit",
				callerDepth: 1,
				limits: STANDARD_LIMITS,
				cleanup: "keep",
			});
			assert.fail("expected SubagentLimitError");
		} catch (err) {
			assert.ok(err instanceof SubagentLimitError);
			assert.equal(err.kind, "depth");
			assert.match(err.message, /depth 1/);
		}
	});

	it("throws SubagentLimitError(concurrent) when parent is at max children", () => {
		for (let i = 0; i < STANDARD_LIMITS.maxChildrenPerParent; i++) {
			reserveSubagentSlot({
				parentSessionKey: "agent:main:main",
				childSessionKey: `agent:main:main:subagent:c${i}`,
				label: `child-${i}`,
				callerDepth: 0,
				limits: STANDARD_LIMITS,
				cleanup: "keep",
			});
		}
		try {
			reserveSubagentSlot({
				parentSessionKey: "agent:main:main",
				childSessionKey: "agent:main:main:subagent:overflow",
				label: "overflow",
				callerDepth: 0,
				limits: STANDARD_LIMITS,
				cleanup: "keep",
			});
			assert.fail("expected SubagentLimitError");
		} catch (err) {
			assert.ok(err instanceof SubagentLimitError);
			assert.equal(err.kind, "concurrent");
			assert.match(err.message, /5 active sub-agent/);
		}
	});

	it("closes the TOCTOU window — sequential reserves either succeed or refuse, never overshoot", () => {
		// Simulate the race: pre-cap reserve, then a "concurrent" reserve hits.
		for (let i = 0; i < STANDARD_LIMITS.maxChildrenPerParent; i++) {
			reserveSubagentSlot({
				parentSessionKey: "agent:main:main",
				childSessionKey: `agent:main:main:subagent:c${i}`,
				label: `child-${i}`,
				callerDepth: 0,
				limits: STANDARD_LIMITS,
				cleanup: "keep",
			});
		}
		// At this point we're AT the cap. The next reserve MUST refuse, even
		// though the slot would only become "free" if a previous one released.
		assert.throws(
			() =>
				reserveSubagentSlot({
					parentSessionKey: "agent:main:main",
					childSessionKey: "agent:main:main:subagent:cN+1",
					label: "no-room",
					callerDepth: 0,
					limits: STANDARD_LIMITS,
					cleanup: "keep",
				}),
			SubagentLimitError,
		);
		assert.equal(countActiveChildren("agent:main:main"), STANDARD_LIMITS.maxChildrenPerParent);
	});

	it("refuses to register the same childSessionKey twice", () => {
		reserveSubagentSlot({
			parentSessionKey: "agent:main:main",
			childSessionKey: "agent:main:main:subagent:c1",
			label: "first",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "keep",
		});
		assert.throws(
			() =>
				reserveSubagentSlot({
					parentSessionKey: "agent:main:main",
					childSessionKey: "agent:main:main:subagent:c1",
					label: "duplicate",
					callerDepth: 0,
					limits: STANDARD_LIMITS,
					cleanup: "keep",
				}),
			/already registered/,
		);
	});
});

describe("markSubagentRunStarted + releaseSubagentSlot lifecycle", () => {
	const PARENT = "agent:main:main";
	const CHILD = "agent:main:main:subagent:c1";

	function setup(): void {
		reserveSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: CHILD,
			label: "audit",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "keep",
		});
	}

	it("markSubagentRunStarted transitions reserved → running and stamps startedAt", () => {
		setup();
		markSubagentRunStarted(PARENT, CHILD);
		const record = getChildRunRecord(PARENT, CHILD);
		assert.ok(record);
		assert.equal(record?.state, "running");
		assert.ok(record?.startedAt && record.startedAt > 0);
	});

	it("releaseSubagentSlot stamps endedAt + outcome, then drops from active map", () => {
		setup();
		markSubagentRunStarted(PARENT, CHILD);
		const released = releaseSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: CHILD,
			outcome: "ok",
		});
		assert.ok(released);
		assert.equal(released?.state, "ended");
		assert.equal(released?.outcome, "ok");
		assert.ok(released?.endedAt && released.endedAt > 0);
		assert.equal(getChildRunRecord(PARENT, CHILD), undefined);
		assert.equal(countActiveChildren(PARENT), 0);
	});

	it("releaseSubagentSlot moves the record into the recently-ended ring", () => {
		setup();
		releaseSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: CHILD,
			outcome: "ok",
		});
		const recent = listRecentlyEndedChildren();
		assert.equal(recent.length, 1);
		assert.equal(recent[0]?.childSessionKey, CHILD);
		assert.equal(recent[0]?.outcome, "ok");
	});

	it("releaseSubagentSlot is idempotent (second call is a no-op)", () => {
		setup();
		releaseSubagentSlot({ parentSessionKey: PARENT, childSessionKey: CHILD, outcome: "ok" });
		const second = releaseSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: CHILD,
			outcome: "error",
		});
		assert.equal(second, undefined);
		assert.equal(listRecentlyEndedChildren().length, 1, "no duplicate in recent ring");
	});

	it("releaseSubagentSlot records error message when outcome is 'error'", () => {
		setup();
		releaseSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: CHILD,
			outcome: "error",
			error: "child crashed",
		});
		const recent = listRecentlyEndedChildren();
		assert.equal(recent[0]?.outcome, "error");
		assert.equal(recent[0]?.error, "child crashed");
	});
});

describe("listActiveChildren + getChildRunRecord", () => {
	const PARENT = "agent:main:main";

	it("returns all active records for the parent", () => {
		reserveSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: `${PARENT}:subagent:c1`,
			label: "one",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "keep",
		});
		reserveSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: `${PARENT}:subagent:c2`,
			label: "two",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "delete",
		});
		const active = listActiveChildren(PARENT);
		assert.equal(active.length, 2);
		const byLabel = Object.fromEntries(active.map((r) => [r.label, r]));
		assert.equal(byLabel.one?.cleanup, "keep");
		assert.equal(byLabel.two?.cleanup, "delete");
	});

	it("returns cloned records so caller mutation doesn't leak into the registry", () => {
		reserveSubagentSlot({
			parentSessionKey: PARENT,
			childSessionKey: `${PARENT}:subagent:c1`,
			label: "before",
			callerDepth: 0,
			limits: STANDARD_LIMITS,
			cleanup: "keep",
		});
		const snapshot = listActiveChildren(PARENT)[0];
		assert.ok(snapshot);
		snapshot!.label = "AFTER-MUTATION";
		const fresh = getChildRunRecord(PARENT, snapshot!.childSessionKey);
		assert.equal(fresh?.label, "before");
	});

	it("returns an empty array for an unknown parent", () => {
		assert.deepEqual(listActiveChildren("unknown-parent"), []);
	});
});

describe("filterToolsForSubagentDepth", () => {
	const fakeTool = (name: string) =>
		({
			name,
			label: name,
			description: name,
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => ({ content: [], details: {} }),
		}) as never;

	it("keeps spawn_agent when caller is below maxDepth (default config)", () => {
		const tools = [fakeTool("read"), fakeTool("spawn_agent"), fakeTool("bash")];
		const filtered = filterToolsForSubagentDepth({
			tools,
			callerDepth: 0,
			maxDepth: 1,
		});
		assert.deepEqual(
			filtered.map((t) => t.name),
			["read", "spawn_agent", "bash"],
		);
	});

	it("keeps spawn_agent for a depth-1 caller when maxDepth permits depth 2", () => {
		const tools = [fakeTool("read"), fakeTool("spawn_agent"), fakeTool("bash")];
		const filtered = filterToolsForSubagentDepth({
			tools,
			callerDepth: 1,
			maxDepth: 2,
		});
		assert.deepEqual(
			filtered.map((t) => t.name),
			["read", "spawn_agent", "bash"],
		);
	});

	it("drops spawn_agent when caller is AT maxDepth (default-config leaf)", () => {
		const tools = [fakeTool("read"), fakeTool("spawn_agent")];
		const filtered = filterToolsForSubagentDepth({
			tools,
			callerDepth: 1,
			maxDepth: 1,
		});
		assert.deepEqual(
			filtered.map((t) => t.name),
			["read"],
		);
	});

	it("drops spawn_agent when caller is PAST maxDepth", () => {
		const tools = [fakeTool("read"), fakeTool("spawn_agent")];
		const filtered = filterToolsForSubagentDepth({
			tools,
			callerDepth: 3,
			maxDepth: 1,
		});
		assert.deepEqual(
			filtered.map((t) => t.name),
			["read"],
		);
	});

	it("does not touch other tool names", () => {
		const tools = [fakeTool("recall_memory"), fakeTool("write_memory")];
		const filtered = filterToolsForSubagentDepth({
			tools,
			callerDepth: 5,
			maxDepth: 1,
		});
		assert.deepEqual(
			filtered.map((t) => t.name),
			["recall_memory", "write_memory"],
		);
	});
});
