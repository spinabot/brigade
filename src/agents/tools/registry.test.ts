import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { createBrigadeTools, listBrigadeToolNames } from "./registry.js";

// createBrigadeTools constructs a FileMemoryStore rooted at workspaceDir.
// Point it at a tempdir so the tools are real but isolated.
let tmpWorkspace: string;

before(() => {
	tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-"));
});

after(() => {
	try {
		fs.rmSync(tmpWorkspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("createBrigadeTools — Primitive #4 (memory) + agents_list + manage_agent + manage_skill", () => {
	it("returns the three memory tools + agents_list + manage_agent + manage_skill", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		assert.equal(tools.length, 6);
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, [
			"agents_list",
			"manage_agent",
			"manage_skill",
			"read_memory",
			"recall_memory",
			"write_memory",
		]);
	});

	it("each tool has the required AgentTool shape", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		for (const tool of tools) {
			assert.equal(typeof tool.name, "string");
			assert.equal(typeof tool.label, "string");
			assert.equal(typeof tool.description, "string");
			assert.ok(tool.parameters, "parameters schema present");
			assert.equal(typeof tool.execute, "function");
		}
	});

	it("includes the structured write_memory tool", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("write_memory"), "write_memory tool present");
	});

	it("does not throw on common option shapes (Windows + POSIX paths)", () => {
		assert.doesNotThrow(() =>
			createBrigadeTools({
				workspaceDir: "C:\\Users\\me\\.brigade\\workspace",
				agentId: "main",
				cwd: "C:\\Users\\me",
			}),
		);
	});
});

describe("createBrigadeTools — Primitive #6 (sub-agents)", () => {
	it("does NOT register spawn_agent when subagentContext is omitted", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("spawn_agent"), "spawn_agent absent without context");
	});

	it("registers spawn_agent when subagentContext is provided at the top-level depth", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "agent:main:main",
				callerDepth: 0,
			},
		});
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("spawn_agent"), "spawn_agent present for top-level turn");
		assert.ok(names.includes("spawn_agents"), "spawn_agents present for top-level turn");
	});

	it("drops BOTH spawn_agent + spawn_agents at leaf depth (callerDepth === maxDepth)", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "agent:main:main:subagent:abc",
				callerDepth: 1,
			},
			subagentMaxDepth: 1,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("spawn_agent"), "spawn_agent dropped at leaf");
		assert.ok(!names.includes("spawn_agents"), "spawn_agents dropped at leaf");
	});

	it("registers spawn_agent + spawn_agents at depth 1 when subagentMaxDepth allows depth 2", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "agent:main:main:subagent:abc",
				callerDepth: 1,
			},
			subagentMaxDepth: 2,
		});
		const names = tools.map((t) => t.name);
		assert.ok(
			names.includes("spawn_agent"),
			"spawn_agent present when child wouldn't be leaf",
		);
		assert.ok(
			names.includes("spawn_agents"),
			"spawn_agents present when child wouldn't be leaf",
		);
	});
});

describe("Wave P1 — cron-triggered runs can spawn sub-agents", () => {
	it("a cron-style turn (subagentContext + non-leaf depth) gets both spawn tools", () => {
		// Cron's isolated executor calls runSingleTurn which always threads
		// subagentContext through. As long as the depth is below the cap,
		// the model running inside the cron job has BOTH spawn tools.
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "cron:nightly-research:run:abc-123",
				callerDepth: 0,
			},
			// Default subagentMaxDepth (3) — cron at depth 0 is well below.
		});
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("spawn_agent"), "cron run can call spawn_agent");
		assert.ok(names.includes("spawn_agents"), "cron run can call spawn_agents (parallel fan-out)");
	});

	it("a cron-style turn at the depth cap drops both spawn tools (no infinite delegation)", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "cron:nightly:run:abc:subagent:x:subagent:y:subagent:z",
				callerDepth: 3,
			},
			subagentMaxDepth: 3,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("spawn_agent"));
		assert.ok(!names.includes("spawn_agents"));
	});
});

describe("listBrigadeToolNames", () => {
	it("returns the memory tool names", () => {
		assert.deepEqual(listBrigadeToolNames().sort(), ["read_memory", "recall_memory", "write_memory"]);
	});

	it("returns a fresh array on each call (callers may mutate)", () => {
		const a = listBrigadeToolNames();
		const b = listBrigadeToolNames();
		assert.notEqual(a, b, "different array instances");
		a.push("test-pollution");
		assert.deepEqual(
			listBrigadeToolNames().sort(),
			["read_memory", "recall_memory", "write_memory"],
			"subsequent calls unaffected",
		);
	});
});
