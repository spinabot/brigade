/**
 * End-to-end integration test for the sub-agent spawn flow (Step 27).
 *
 * Verifies that Step 20's `spawnSubagentDirect` integrates cleanly with:
 *
 *   - Step 10's subagent-registry (`registerSubagentRun`, `countActiveRunsForSession`,
 *     `markSubagentRunCompleted`, completion hook gate)
 *   - Step 18's agent-events bus (subagent_started + subagent_ended emitted)
 *   - Step 18's `wireAgentEventsBridge` (hook routes through to the event bus)
 *   - Step 20's depth + concurrency caps (forbidden when exceeded)
 *
 * The test installs a STUB `GatewayCaller` so the spawn engine can hand
 * off without a real gateway. The stub records the dispatched params so
 * the assertions can verify the engine threaded everything correctly.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	resetAgentEventsForTests,
	wireAgentEventsBridge,
	onAgentEvent,
} from "./agent-events.js";
import type { AgentEventPayload } from "./agent-events.types.js";
import {
	resetGatewayCallerForTests,
	setGlobalGatewayCaller,
	type GatewayCallOptions,
	type GatewayCaller,
} from "./gateway-call.js";
import {
	countActiveRunsForSession,
	getSubagentRun,
	markSubagentRunCompleted,
	resetSubagentRegistryForTests,
	snapshotSubagentRunsForTests,
} from "./subagent-registry.js";
import {
	SUBAGENT_ENDED_OUTCOME_OK,
	type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { DEFAULT_SUBAGENT_RUN_TIMEOUT_SECONDS, spawnSubagentDirect } from "./subagent-spawn.js";
import { DEFAULT_SUBAGENT_MAX_CONCURRENT } from "../config/agent-limits.js";

const PARENT_KEY = "agent:test:integration-parent";

function makeStubCaller(): {
	caller: GatewayCaller;
	calls: GatewayCallOptions[];
} {
	const calls: GatewayCallOptions[] = [];
	const caller: GatewayCaller = {
		call: async <T = Record<string, unknown>>(opts: GatewayCallOptions): Promise<T> => {
			calls.push(opts);
			return { ok: true } as T;
		},
	};
	return { caller, calls };
}

describe("subagent-spawn integration (Steps 10, 18, 20)", () => {
	beforeEach(() => {
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
		resetGatewayCallerForTests();
	});

	afterEach(() => {
		resetSubagentRegistryForTests();
		resetAgentEventsForTests();
		resetGatewayCallerForTests();
	});

	it("spawns, registers, and hands off to the gateway", async () => {
		const { caller, calls } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		const result = await spawnSubagentDirect(
			{ task: "summarise the README" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
		);

		assert.equal(result.status, "accepted", "spawn accepted");
		assert.ok(result.childSessionKey, "child session key minted");
		assert.ok(result.runId, "run id minted");
		assert.equal(result.mode, "run", "default spawn mode is run");

		const entry = getSubagentRun(result.runId!);
		assert.ok(entry, "run registered in subagent-registry");
		assert.equal(entry?.task, "summarise the README");
		assert.equal(entry?.requesterSessionKey, PARENT_KEY);

		// Phase 8 of the multi-routing wiring added a `sessions.patch` call
		// BEFORE the `agent` handoff so child-session metadata is persisted.
		// The integration now expects: 1× sessions.patch + 1× agent = 2 calls.
		assert.equal(calls.length, 2, "exactly two gateway calls (patch + agent)");
		const patchCall = calls.find((c) => c.method === "sessions.patch");
		assert.ok(patchCall, "calls sessions.patch to persist child metadata");
		const patchParams = patchCall?.params as Record<string, unknown>;
		assert.equal(patchParams.sessionKey, result.childSessionKey);
		const agentCall = calls.find((c) => c.method === "agent");
		assert.ok(agentCall, "calls the agent method");
		const params = agentCall?.params as Record<string, unknown>;
		assert.equal(params.sessionKey, result.childSessionKey, "targets child session");
		assert.equal(params.spawnedBy, PARENT_KEY, "passes parent key");
		assert.equal(params.deliver, false, "deliver suppressed for sub-agents");
	});

	it("rejects malformed agentId before normalisation", async () => {
		const { caller } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		const result = await spawnSubagentDirect(
			{ task: "x", agentId: "bad agent name!" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
		);
		assert.equal(result.status, "error", "rejected malformed agentId");
		assert.match(result.error ?? "", /Invalid agentId/);
	});

	it("forbids spawn when depth cap is reached", async () => {
		const { caller } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		const result = await spawnSubagentDirect(
			{ task: "deep dive" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 3, maxSpawnDepth: 3 },
		);
		assert.equal(result.status, "forbidden");
		assert.match(result.error ?? "", /not allowed at this depth/);
	});

	it("forbids spawn when max-children cap is reached", async () => {
		const { caller } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		// Pre-register two children to occupy the slot count.
		const first = await spawnSubagentDirect(
			{ task: "task 1" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0, maxChildrenPerAgent: 2 },
		);
		const second = await spawnSubagentDirect(
			{ task: "task 2" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0, maxChildrenPerAgent: 2 },
		);
		assert.equal(first.status, "accepted");
		assert.equal(second.status, "accepted");
		assert.equal(countActiveRunsForSession(PARENT_KEY), 2);

		const third = await spawnSubagentDirect(
			{ task: "task 3" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0, maxChildrenPerAgent: 2 },
		);
		assert.equal(third.status, "forbidden");
		assert.match(third.error ?? "", /max active children/);
	});

	it("emits subagent_lifecycle:subagent_started on accepted spawn", async () => {
		const { caller } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		const events: AgentEventPayload[] = [];
		const dispose = onAgentEvent((event) => events.push(event));
		try {
			const result = await spawnSubagentDirect(
				{ task: "fire event", label: "smoke-test" },
				{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
			);
			assert.equal(result.status, "accepted");
			const lifecycle = events.find(
				(event) =>
					event.stream === "subagent_lifecycle" &&
					(event.data as Record<string, unknown>).kind === "subagent_started",
			);
			assert.ok(lifecycle, "lifecycle event emitted");
			const data = lifecycle?.data as Record<string, unknown>;
			assert.equal(data.runId, result.runId);
			assert.equal(data.childSessionKey, result.childSessionKey);
			assert.equal(data.label, "smoke-test");
		} finally {
			dispose();
		}
	});

	it("completion routes through the wired bridge to subagent_ended event", async () => {
		const { caller } = makeStubCaller();
		setGlobalGatewayCaller(caller);
		const disposeBridge = wireAgentEventsBridge();

		const events: AgentEventPayload[] = [];
		const disposeListener = onAgentEvent((event) => events.push(event));

		try {
			const spawn = await spawnSubagentDirect(
				{ task: "ends quickly" },
				{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
			);
			assert.equal(spawn.status, "accepted");

			const completed = await markSubagentRunCompleted({
				runId: spawn.runId!,
				outcome: { status: "ok", text: "done" },
				reason: "complete" as SubagentLifecycleEndedReason,
				lifecycleOutcome: SUBAGENT_ENDED_OUTCOME_OK,
			});
			assert.ok(completed, "registry stamped endedAt");
			assert.ok(completed?.endedAt, "endedAt set");

			const endedEvent = events.find(
				(event) =>
					event.stream === "subagent_lifecycle" &&
					(event.data as Record<string, unknown>).kind === "subagent_ended",
			);
			assert.ok(endedEvent, "ended event emitted through bridge");
			const endedData = endedEvent?.data as Record<string, unknown>;
			assert.equal(endedData.runId, spawn.runId);
			assert.equal(endedData.outcome, SUBAGENT_ENDED_OUTCOME_OK);
		} finally {
			disposeListener();
			disposeBridge();
		}
	});

	it("Wave N4 — applies DEFAULT_SUBAGENT_RUN_TIMEOUT_SECONDS (180s) when caller omits runTimeoutSeconds", async () => {
		const { caller, calls } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		const result = await spawnSubagentDirect(
			{ task: "no timeout supplied" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
		);
		assert.equal(result.status, "accepted");

		// Verify the engine forwarded the documented default (180s) to the
		// gateway `agent` handler, NOT `undefined`. Pre-Wave-N4 this was
		// undefined and children ran uncapped.
		const agentCall = calls.find((c) => c.method === "agent");
		const params = agentCall?.params as Record<string, unknown>;
		assert.equal(params.timeout, DEFAULT_SUBAGENT_RUN_TIMEOUT_SECONDS, "default 180s applied");
		assert.equal(DEFAULT_SUBAGENT_RUN_TIMEOUT_SECONDS, 180, "Wave N4 documented default");
	});

	it("Wave N4 — caller-supplied runTimeoutSeconds wins over the default", async () => {
		const { caller, calls } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		const result = await spawnSubagentDirect(
			{ task: "explicit cap", runTimeoutSeconds: 30 },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
		);
		assert.equal(result.status, "accepted");
		const agentCall = calls.find((c) => c.method === "agent");
		const params = agentCall?.params as Record<string, unknown>;
		assert.equal(params.timeout, 30, "operator override wins");
	});

	it("Wave N4 — DEFAULT_SUBAGENT_MAX_CONCURRENT is 8 (parallel-spawn budget)", () => {
		// Smoke test the locked default. Bumping this needs a corresponding
		// review of `subagent-budget.ts` semaphore behaviour and the
		// operator-facing `agents.defaults.maxSubagentConcurrent` docs.
		assert.equal(DEFAULT_SUBAGENT_MAX_CONCURRENT, 8);
	});

	it("snapshot contains the registered entries (test-only helper)", async () => {
		const { caller } = makeStubCaller();
		setGlobalGatewayCaller(caller);

		await spawnSubagentDirect(
			{ task: "snapshot probe" },
			{ agentSessionKey: PARENT_KEY, callerDepth: 0 },
		);
		const snapshot = snapshotSubagentRunsForTests();
		assert.equal(snapshot.length, 1, "snapshot returns one entry");
		assert.equal(snapshot[0]?.requesterSessionKey, PARENT_KEY);
	});
});
