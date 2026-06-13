import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeSpawnAgentsTool } from "./spawn-agents-tool.js";

interface SpawnAgentsChildResult {
	label: string;
	status: "ok" | "aborted" | "timed-out" | "limit-refused" | "error";
	childSessionKey?: string;
	durationMs?: number;
	reply?: string;
	error?: string;
	reason?: string;
}

interface SpawnAgentsResult {
	total: number;
	succeeded: number;
	failed: number;
	totalDurationMs: number;
	results: SpawnAgentsChildResult[];
}

function parseResult(content: unknown): SpawnAgentsResult {
	const arr = content as Array<{ type: string; text?: string }>;
	const text = arr[0]?.text ?? "";
	return JSON.parse(text) as SpawnAgentsResult;
}

let tmpRoot: string;
let prevState: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-spawnpar-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevConfig = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	process.env.BRIGADE_CONFIG_PATH = path.join(tmpRoot, "brigade.json");
	fs.writeFileSync(
		path.join(tmpRoot, "brigade.json"),
		JSON.stringify({ agents: { defaults: { subagents: { maxChildrenPerParent: 3 } } } }, null, 2),
		"utf8",
	);
});

afterEach(() => {
	process.env.BRIGADE_STATE_DIR = prevState;
	process.env.BRIGADE_CONFIG_PATH = prevConfig;
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("spawn_agents tool — shape + guard rails (no runSubagent execution)", () => {
	it("empty tasks array returns a zero envelope without dispatching", async () => {
		const tool = makeSpawnAgentsTool({
			parentSessionKey: "agent:main:main",
			parentAgentId: "main",
			bypassAccessGuard: true,
		});
		const result = parseResult((await tool.execute("c-empty", { tasks: [] })).content);
		assert.equal(result.total, 0);
		assert.equal(result.succeeded, 0);
		assert.equal(result.failed, 0);
		assert.deepEqual(result.results, []);
	});

	it("refuses when tasks.length > maxChildrenPerParent (3 in this config)", async () => {
		const tool = makeSpawnAgentsTool({
			parentSessionKey: "agent:main:main",
			parentAgentId: "main",
			bypassAccessGuard: true,
		});
		const result = parseResult(
			(
				await tool.execute("c-overflow", {
					tasks: [
						{ task: "a", label: "alpha" },
						{ task: "b", label: "beta" },
						{ task: "c", label: "gamma" },
						{ task: "d", label: "delta" },
					],
				})
			).content,
		);
		assert.equal(result.total, 4);
		assert.equal(result.succeeded, 0);
		assert.equal(result.failed, 4);
		for (const r of result.results) {
			assert.equal(r.status, "limit-refused");
			assert.equal(r.reason, "concurrent");
			assert.match(r.error ?? "", /maxChildrenPerParent=3/);
		}
	});

	it("fail-closed when access policy is unwired AND bypass is not set", async () => {
		const tool = makeSpawnAgentsTool({
			parentSessionKey: "agent:main:main",
			parentAgentId: "main",
			// No visibility, no a2aPolicy, no bypassAccessGuard.
		});
		const result = parseResult(
			(
				await tool.execute("c-unwired", {
					tasks: [{ task: "a", label: "alpha" }],
				})
			).content,
		);
		assert.equal(result.total, 1);
		assert.equal(result.failed, 1);
		assert.equal(result.results[0]!.status, "limit-refused");
		assert.equal(result.results[0]!.reason, "access-denied");
	});

	it("parent-abort fast-fail (D2): a pre-aborted parent signal refuses the whole batch without dispatching", async () => {
		// Reproduces the production cascade: a lead exhausts its run budget, its
		// run timer fires, THEN it emits a fan-out. The children must not be
		// dispatched onto a dead signal (they'd die in ~1ms and report as fake
		// `aborted`). Instead the batch is refused up-front with reason
		// "parent-aborted" so the lead gets an honest, actionable envelope.
		const ac = new AbortController();
		ac.abort();
		const tool = makeSpawnAgentsTool({
			parentSessionKey: "agent:main:main",
			parentAgentId: "main",
			bypassAccessGuard: true,
			parentSignal: ac.signal,
		});
		const result = parseResult(
			(
				await tool.execute("c-parentabort", {
					tasks: [
						{ task: "a", label: "alpha" },
						{ task: "b", label: "beta" },
					],
				})
			).content,
		);
		assert.equal(result.total, 2);
		assert.equal(result.succeeded, 0);
		assert.equal(result.failed, 2);
		assert.equal(result.totalDurationMs, 0);
		for (const r of result.results) {
			assert.equal(r.status, "limit-refused");
			assert.equal(r.reason, "parent-aborted");
			assert.match(r.error ?? "", /out of budget|cancelled/i);
			// Crucially NOT a real child result — no session key, no duration.
			assert.equal(r.childSessionKey, undefined);
		}
	});

	it("exposes ownerOnly=false (sub-agent tool, not owner-only)", () => {
		const tool = makeSpawnAgentsTool({
			parentSessionKey: "agent:main:main",
			parentAgentId: "main",
		});
		// spawn_agents is a model-facing tool (not owner-only), so the flag
		// is undefined / falsy.
		assert.ok(tool.ownerOnly !== true);
	});

	it("uses kebab-case tool name + carries the parallel description", () => {
		const tool = makeSpawnAgentsTool({
			parentSessionKey: "agent:main:main",
			parentAgentId: "main",
		});
		assert.equal(tool.name, "spawn_agents");
		assert.match(tool.description, /parallel/i);
		assert.match(tool.description, /maxChildrenPerParent/);
	});
});
