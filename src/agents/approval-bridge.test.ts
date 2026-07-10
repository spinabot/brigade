/**
 * Tests for the approval bridge — pure unit-level coverage of the
 * in-memory request/resolve/timeout behaviour.
 *
 * Persistence behaviour (`applyApprovalDecision` calling `recordApproval`)
 * is tested in exec-approvals.test.ts; here we mock the broadcaster and
 * verify the bridge's own state machine.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import {
	type ApprovalDecisionKind,
	type ApprovalRequest,
	getActiveApprovalBridge,
	InMemoryApprovalBridge,
	setActiveApprovalBridge,
} from "./approval-bridge.js";

const DECISIONS: ReadonlyArray<ApprovalDecisionKind> = [
	"allow-once",
	"allow-always",
	"allow-pattern",
	"deny",
];

describe("InMemoryApprovalBridge", () => {
	afterEach(() => {
		setActiveApprovalBridge(null);
	});

	it("broadcasts a request and resolves the returned promise", async () => {
		const broadcasts: ApprovalRequest[] = [];
		const bridge = new InMemoryApprovalBridge((req) => broadcasts.push(req));
		const pending = bridge.requestApproval({
			command: "ls -la",
			toolName: "bash",
			cwd: "/tmp",
			timeoutMs: 10_000,
			decisions: DECISIONS,
		});
		assert.equal(broadcasts.length, 1);
		const broadcastId = broadcasts[0]!.id;
		const resolved = bridge.resolveApproval(broadcastId, { kind: "allow-once" });
		assert.equal(resolved, true);
		const decision = await pending;
		assert.equal(decision.kind, "allow-once");
		assert.equal(decision.timedOut, undefined);
	});

	it("times out with kind:'deny' + timedOut:true when the operator never replies", async () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const pending = bridge.requestApproval({
			command: "git status",
			toolName: "bash",
			timeoutMs: 30,
			decisions: DECISIONS,
		});
		// The production timeout timer is unref()'d (line ~155 of the bridge) so
		// a pending approval never keeps the gateway process alive. But a test
		// that AWAITS the timeout has nothing else holding the event loop open —
		// on some Node versions (seen on 22.12) the test runner sees the loop
		// drain before the 30ms timer fires and cancels the whole suite with
		// "Promise resolution is still pending but the event loop has already
		// resolved", cascading `cancelledByParent` to every sibling. A ref'd
		// keep-alive timer holds the loop open until the timeout resolves us.
		const keepAlive = setTimeout(() => {}, 5_000);
		try {
			const decision = await pending;
			assert.equal(decision.kind, "deny");
			assert.equal(decision.timedOut, true);
		} finally {
			clearTimeout(keepAlive);
		}
	});

	it("resolveApproval returns false for unknown id (stale / double-click)", () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const handled = bridge.resolveApproval("does-not-exist", { kind: "allow-once" });
		assert.equal(handled, false);
	});

	it("listPending shows only un-resolved requests", () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		void bridge.requestApproval({
			command: "echo a",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: DECISIONS,
		});
		void bridge.requestApproval({
			command: "echo b",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: DECISIONS,
		});
		const pending = bridge.listPending();
		assert.equal(pending.length, 2);
		// Drain so the dangling timers don't keep the test runner alive
		// beyond afterEach (the timer's unref guards against this anyway,
		// but explicit resolve is cleaner).
		for (const req of pending) bridge.resolveApproval(req.id, { kind: "deny" });
	});

	it("survives a broadcast that throws (e.g. no clients connected)", async () => {
		const bridge = new InMemoryApprovalBridge(() => {
			throw new Error("no clients");
		});
		const pending = bridge.requestApproval({
			command: "ls",
			toolName: "bash",
			timeoutMs: 60_000,
			decisions: DECISIONS,
		});
		const ids = bridge.listPending().map((r) => r.id);
		assert.equal(ids.length, 1);
		// Caller can still resolve manually (e.g. via a late-arriving client).
		assert.equal(bridge.resolveApproval(ids[0]!, { kind: "allow-once" }), true);
		const decision = await pending;
		assert.equal(decision.kind, "allow-once");
	});

	it("setActiveApprovalBridge / getActiveApprovalBridge round-trip", () => {
		assert.equal(getActiveApprovalBridge(), null);
		const bridge = new InMemoryApprovalBridge(() => {});
		setActiveApprovalBridge(bridge);
		assert.equal(getActiveApprovalBridge(), bridge);
		setActiveApprovalBridge(null);
		assert.equal(getActiveApprovalBridge(), null);
	});
});

/* ─────────────────── abort-aware cancellation ─────────────────── */

describe("requestApproval — abort cancels the prompt", () => {
	it("aborting a pending request settles as deny+aborted and withdraws it", async () => {
		const seen: ApprovalRequest[] = [];
		const bridge = new InMemoryApprovalBridge((r) => seen.push(r));
		const ac = new AbortController();
		const pending = bridge.requestApproval(
			{ command: "rm -rf /", toolName: "bash", cwd: "/tmp", timeoutMs: 60_000, decisions: ["allow-once", "deny"] },
			ac.signal,
		);
		assert.equal(bridge.listPending().length, 1, "prompt is live");
		assert.equal(seen.length, 1, "operator was asked");

		ac.abort();
		const decision = await pending;
		assert.equal(decision.kind, "deny", "fails closed");
		assert.equal(decision.aborted, true);
		assert.equal(decision.timedOut, undefined, "an abort is not a timeout");
		assert.equal(bridge.listPending().length, 0, "withdrawn — a reconnecting client won't re-render it");
	});

	it("an already-aborted signal never registers or broadcasts a prompt", async () => {
		const seen: ApprovalRequest[] = [];
		const bridge = new InMemoryApprovalBridge((r) => seen.push(r));
		const ac = new AbortController();
		ac.abort();
		const decision = await bridge.requestApproval(
			{ command: "ls", toolName: "bash", cwd: "/tmp", timeoutMs: 60_000, decisions: ["allow-once", "deny"] },
			ac.signal,
		);
		assert.equal(decision.aborted, true);
		assert.deepEqual(seen, [], "never bothers the operator about a dead turn");
		assert.equal(bridge.listPending().length, 0);
	});

	it("an operator answering a withdrawn prompt is safely ignored", async () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const ac = new AbortController();
		const pending = bridge.requestApproval(
			{ command: "ls", toolName: "bash", cwd: "/tmp", timeoutMs: 60_000, decisions: ["allow-once", "deny"] },
			ac.signal,
		);
		const id = bridge.listPending()[0]?.id as string;
		ac.abort();
		await pending;
		// the late answer lands on an absent entry — the WS handler treats false as a no-op
		assert.equal(bridge.resolveApproval(id, { kind: "allow-once" as ApprovalDecisionKind }), false);
	});

	it("the timeout path is unchanged when a live signal never fires", async () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const ac = new AbortController();
		const decision = await bridge.requestApproval(
			{ command: "ls", toolName: "bash", cwd: "/tmp", timeoutMs: 20, decisions: ["allow-once", "deny"] },
			ac.signal,
		);
		assert.equal(decision.kind, "deny");
		assert.equal(decision.timedOut, true);
		assert.equal(decision.aborted, undefined);
		assert.equal(bridge.listPending().length, 0);
	});

	it("abort listeners do not accumulate across approvals sharing one turn signal", async () => {
		const bridge = new InMemoryApprovalBridge(() => {});
		const ac = new AbortController();
		for (let i = 0; i < 3; i++) {
			const p = bridge.requestApproval(
				{ command: `echo ${i}`, toolName: "bash", cwd: "/tmp", timeoutMs: 60_000, decisions: ["allow-once", "deny"] },
				ac.signal,
			);
			const id = bridge.listPending()[0]?.id as string;
			bridge.resolveApproval(id, { kind: "allow-once" as ApprovalDecisionKind });
			await p;
		}
		assert.equal(bridge.listPending().length, 0, "all drained");
		// every settle detached its listener; aborting now must not throw or resolve anything
		assert.doesNotThrow(() => ac.abort());
	});
});
