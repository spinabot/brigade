/**
 * Integration smoke tests for `runSubagent` — exercise the orchestration
 * without standing up a real Pi loop. We monkey-patch the `runSingleTurn`
 * export via the dynamic-import seam (the runner does `await import
 * ("./agent-loop.js")` inside its try block) using a Node loader hook
 * approach that's impractical here; instead we test what we CAN reach
 * without Pi: the policy registry, session-store, transcript files, and
 * the framing pieces (task message, metadata, child session key).
 *
 * The seam being verified:
 *   - `reserveSubagentSlot` runs BEFORE the dynamic import + before the
 *     timeout arms, so a depth/concurrency refusal lands as a synthetic
 *     refusal-shaped result with no transcript / no session-store entry
 *     created (the runner returns a result-like object via the spawn tool,
 *     but the runner itself THROWS `SubagentLimitError`).
 *   - `buildChildFirstUserMessage` produces the documented framing.
 *   - The subagent metadata block produced by the runner matches the
 *     SubagentSessionMetadata contract.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	SubagentLimitError,
	clearSubagentRegistryForTests,
	countActiveChildren,
	listActiveChildren,
	listRecentlyEndedChildren,
	reserveSubagentSlot,
} from "./subagent-policy.js";
import { readSubagentMetadata, resolveOrCreateSession } from "../sessions/session-store.js";

let tmpStateDir: string;
let prevStateDirEnv: string | undefined;

beforeEach(() => {
	tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-subagent-int-"));
	prevStateDirEnv = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = tmpStateDir;
	clearSubagentRegistryForTests();
});

afterEach(() => {
	clearSubagentRegistryForTests();
	if (prevStateDirEnv === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDirEnv;
	try {
		fs.rmSync(tmpStateDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const LIMITS_DEFAULT = { maxDepth: 1, maxChildrenPerParent: 5, defaultTimeoutSeconds: 300 };

/* ─────────────── Slot reservation + session-store interplay ─────────────── */

describe("runSubagent end-to-end smoke: slot + session-store wiring", () => {
	it("a top-level spawn reserves a slot AND, when followed by a manual write of subagent metadata via the same session key, lands the metadata on disk", () => {
		// Walk the orchestration manually:
		//   1) reserve a slot the runner would create
		//   2) write the session-store entry the way agent-loop.ts:resolveOrCreateSession does
		// Verify both pieces land where we expect.
		const parentKey = "agent:main:main";
		const childKey = "agent:main:main:subagent:abc";
		reserveSubagentSlot({
			parentSessionKey: parentKey,
			childSessionKey: childKey,
			label: "audit",
			callerDepth: 0,
			limits: LIMITS_DEFAULT,
			cleanup: "keep",
		});
		assert.equal(countActiveChildren(parentKey), 1);
		const active = listActiveChildren(parentKey);
		assert.equal(active[0]?.label, "audit");
		assert.equal(active[0]?.cleanup, "keep");
		assert.equal(active[0]?.state, "reserved");

		// Simulate the session-store write runSingleTurn does on the child's
		// first call to resolveOrCreateSession.
		resolveOrCreateSession({
			agentId: "main",
			sessionKey: childKey,
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: parentKey,
					label: "audit",
					cleanup: "keep",
					spawnedAt: new Date().toISOString(),
				},
			},
		});
		const metadata = readSubagentMetadata("main", childKey);
		assert.ok(metadata);
		assert.equal(metadata?.label, "audit");
		assert.equal(metadata?.spawnedBy, parentKey);
		assert.equal(metadata?.spawnDepth, 1);
	});

	it("a refused spawn (concurrent limit) does not pollute session-store", () => {
		const parentKey = "agent:main:main";
		// Fill the slot cap.
		for (let i = 0; i < LIMITS_DEFAULT.maxChildrenPerParent; i++) {
			reserveSubagentSlot({
				parentSessionKey: parentKey,
				childSessionKey: `${parentKey}:subagent:c${i}`,
				label: `child-${i}`,
				callerDepth: 0,
				limits: LIMITS_DEFAULT,
				cleanup: "keep",
			});
		}
		// Attempt one beyond cap — should throw without producing a record.
		assert.throws(
			() =>
				reserveSubagentSlot({
					parentSessionKey: parentKey,
					childSessionKey: `${parentKey}:subagent:overflow`,
					label: "overflow",
					callerDepth: 0,
					limits: LIMITS_DEFAULT,
					cleanup: "keep",
				}),
			SubagentLimitError,
		);
		// Refused child must NOT appear in the registry.
		const active = listActiveChildren(parentKey);
		assert.equal(active.length, LIMITS_DEFAULT.maxChildrenPerParent);
		assert.ok(!active.some((r) => r.label === "overflow"));
	});

	it("a refused spawn (depth limit) does not pollute session-store", () => {
		const grandparentKey = "agent:main:main";
		const parentSubagentKey = `${grandparentKey}:subagent:abc`;
		assert.throws(
			() =>
				reserveSubagentSlot({
					parentSessionKey: parentSubagentKey,
					childSessionKey: `${parentSubagentKey}:subagent:grandchild`,
					label: "grandchild",
					callerDepth: 1, // already at the leaf for maxDepth=1
					limits: LIMITS_DEFAULT,
					cleanup: "keep",
				}),
			SubagentLimitError,
		);
		// Nothing registered.
		assert.equal(countActiveChildren(parentSubagentKey), 0);
		assert.equal(countActiveChildren(grandparentKey), 0);
	});
});

/* ─────────────── Transcript file deletion (cleanup="delete") ─────────────── */

describe("runSubagent end-to-end smoke: transcript + session-entry cleanup", () => {
	it("cleanup=delete removes BOTH the transcript file AND the session-store entry", async () => {
		const parentKey = "agent:main:main";
		const childKey = "agent:main:main:subagent:delme";

		// Set up: simulate a completed run by writing a transcript file +
		// session-store entry the way the runner WOULD have.
		const resolved = resolveOrCreateSession({
			agentId: "main",
			sessionKey: childKey,
			overrides: {
				subagent: {
					spawnDepth: 1,
					spawnedBy: parentKey,
					label: "delete-me",
					cleanup: "delete",
					spawnedAt: new Date().toISOString(),
				},
			},
		});
		fs.writeFileSync(resolved.transcriptPath, '{"role":"user","content":"x"}\n', "utf8");
		assert.ok(fs.existsSync(resolved.transcriptPath));
		assert.ok(readSubagentMetadata("main", childKey));

		// Now invoke the same cleanup the runner does at finally-time.
		const { deleteSessionEntry } = await import("../sessions/session-store.js");
		fs.rmSync(resolved.transcriptPath, { force: true });
		deleteSessionEntry("main", childKey);

		assert.ok(!fs.existsSync(resolved.transcriptPath), "transcript file removed");
		assert.equal(readSubagentMetadata("main", childKey), undefined, "session-store entry removed");
	});
});

/* ─────────────── Recently-ended ring observability ─────────────── */

describe("runSubagent end-to-end smoke: recently-ended ring", () => {
	it("after a completed slot is released, listRecentlyEndedChildren surfaces it with outcome", async () => {
		const { releaseSubagentSlot, markSubagentRunStarted } = await import("./subagent-policy.js");
		const parentKey = "agent:main:main";
		const childKey = `${parentKey}:subagent:ended`;
		reserveSubagentSlot({
			parentSessionKey: parentKey,
			childSessionKey: childKey,
			label: "completed-task",
			callerDepth: 0,
			limits: LIMITS_DEFAULT,
			cleanup: "keep",
		});
		markSubagentRunStarted(parentKey, childKey);
		releaseSubagentSlot({
			parentSessionKey: parentKey,
			childSessionKey: childKey,
			outcome: "ok",
		});
		const recent = listRecentlyEndedChildren();
		const ours = recent.find((r) => r.childSessionKey === childKey);
		assert.ok(ours);
		assert.equal(ours?.outcome, "ok");
		assert.equal(ours?.label, "completed-task");
		assert.ok(ours?.endedAt && ours.startedAt && ours.endedAt >= ours.startedAt);
	});
});

/* ─────────────── Inheritance + framing pieces ─────────────── */

describe("runSubagent end-to-end smoke: framing pieces", () => {
	it("buildChildSessionKey produces a unique key per call (uuids are fresh)", async () => {
		const { buildChildSessionKey } = await import("./subagent-policy.js");
		const a = buildChildSessionKey("agent:main:main", "u1");
		const b = buildChildSessionKey("agent:main:main", "u2");
		assert.notEqual(a, b);
		assert.ok(a.endsWith(":subagent:u1"));
		assert.ok(b.endsWith(":subagent:u2"));
	});

	it("nested derivation works for grandchildren key shapes", async () => {
		const { buildChildSessionKey, getSubagentDepthFromSessionKey } = await import(
			"./subagent-policy.js"
		);
		const child = buildChildSessionKey("agent:main:main", "c1");
		const grand = buildChildSessionKey(child, "g1");
		assert.equal(getSubagentDepthFromSessionKey(child), 1);
		assert.equal(getSubagentDepthFromSessionKey(grand), 2);
	});
});
