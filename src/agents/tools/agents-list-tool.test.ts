import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeAgentsListTool } from "./agents-list-tool.js";

let stateDir: string;
let prevStateDir: string | undefined;

function writeCfg(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-agents-list-"));
	mkdirSync(join(stateDir, "agents"), { recursive: true });
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

interface ListedAgent {
	id: string;
	name?: string;
	configured: boolean;
	self?: boolean;
	canSpawn: boolean;
	canSend: boolean;
}

interface ListedResult {
	requester: string;
	agents: ListedAgent[];
}

async function runTool(requesterAgentId?: string): Promise<ListedResult> {
	const tool = makeAgentsListTool(requesterAgentId !== undefined ? { requesterAgentId } : {});
	const result = await tool.execute("test-call-id", {});
	const text = result.content?.[0];
	if (!text || text.type !== "text") throw new Error("expected text content");
	return JSON.parse(text.text) as ListedResult;
}

describe("agents_list tool — enumerate-every-agent contract", () => {
	it("returns just the caller when cfg has only one configured agent", async () => {
		writeCfg({ agents: { defaults: { provider: "openrouter" }, main: {} } });
		const out = await runTool("main");
		assert.equal(out.requester, "main");
		assert.equal(out.agents.length, 1);
		assert.equal(out.agents[0]?.id, "main");
		assert.equal(out.agents[0]?.configured, true);
		assert.equal(out.agents[0]?.self, true);
	});

	it("enumerates ALL 6 configured agents regardless of spawn allowlist", async () => {
		// Six configured agents, empty allowlist. The catalog is unfiltered —
		// every configured agent surfaces, and the model uses canSpawn/canSend
		// to decide what's reachable.
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				alpha: {},
				beta: {},
				gamma: {},
				delta: {},
				epsilon: {},
			},
		});
		const out = await runTool("main");
		assert.equal(out.requester, "main");
		assert.equal(out.agents.length, 6, "all six configured agents must appear");
		const ids = out.agents.map((a) => a.id).sort();
		assert.deepEqual(ids, ["alpha", "beta", "delta", "epsilon", "gamma", "main"]);
		// With no allowlist and A2A disabled, peers have canSpawn=false and
		// canSend=false; only the self row has both true.
		for (const row of out.agents) {
			if (row.self) {
				assert.equal(row.canSpawn, true, "self.canSpawn must be true");
				assert.equal(row.canSend, true, "self.canSend must be true");
			} else {
				assert.equal(row.canSpawn, false, `${row.id}.canSpawn must be false`);
				assert.equal(row.canSend, false, `${row.id}.canSend must be false`);
			}
		}
	});

	it("marks the caller row with self:true and places it FIRST", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				alpha: {},
				zeta: {},
			},
		});
		const out = await runTool("zeta");
		assert.equal(out.agents[0]?.id, "zeta", "caller row must be first");
		assert.equal(out.agents[0]?.self, true, "caller row must be self:true");
		// Other rows must NOT carry self:true.
		for (const row of out.agents.slice(1)) {
			assert.notEqual(row.self, true, `${row.id} must not be self`);
		}
	});

	it("caller-first ordering survives when caller is alphabetically late", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				alpha: {},
				beta: {},
				zeta: {},
			},
		});
		const out = await runTool("zeta");
		assert.equal(out.agents[0]?.id, "zeta");
		// Remaining peers are alphabetical (alpha, beta, main).
		const tail = out.agents.slice(1).map((a) => a.id);
		assert.deepEqual(tail, ["alpha", "beta", "main"]);
	});

	it("canSpawn is true for every peer under allowAgents wildcard", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", subagents: { allowAgents: ["*"] } },
				main: {},
				alpha: {},
				beta: {},
			},
		});
		const out = await runTool("main");
		for (const row of out.agents) {
			assert.equal(row.canSpawn, true, `${row.id}.canSpawn must be true under '*'`);
		}
	});

	it("canSpawn only true for ids listed in subagents.allowAgents", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					subagents: { allowAgents: ["netpulse"] },
				},
				main: {},
				netpulse: {},
				support: {},
			},
		});
		const out = await runTool("main");
		const netpulse = out.agents.find((a) => a.id === "netpulse");
		const support = out.agents.find((a) => a.id === "support");
		assert.equal(netpulse?.canSpawn, true, "netpulse is on allowlist");
		assert.equal(support?.canSpawn, false, "support is NOT on allowlist");
		// Both still surface as configured (no allowlist visibility filter).
		assert.equal(netpulse?.configured, true);
		assert.equal(support?.configured, true);
	});

	it("canSend is true for every peer under A2A wildcard allow", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				alpha: {},
				beta: {},
			},
			session: {
				agentToAgent: {
					enabled: true,
					allow: [{ from: "*", to: "*" }],
				},
			},
		});
		const out = await runTool("main");
		for (const row of out.agents) {
			assert.equal(row.canSend, true, `${row.id}.canSend must be true under A2A '*' → '*'`);
		}
	});

	it("canSend is false for peers when A2A is disabled", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				alpha: {},
			},
			session: { agentToAgent: { enabled: false } },
		});
		const out = await runTool("main");
		const alpha = out.agents.find((a) => a.id === "alpha");
		assert.equal(alpha?.canSend, false, "A2A disabled → canSend false for peers");
		// Self row is always reachable.
		assert.equal(out.agents[0]?.canSend, true);
	});

	it("per-agent subagents.allowAgents override beats defaults", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: { subagents: { allowAgents: ["*"] } },
				netpulse: {},
				support: {},
			},
		});
		const out = await runTool("main");
		const ids = out.agents.map((a) => a.id);
		assert.ok(ids.includes("netpulse"));
		assert.ok(ids.includes("support"));
		for (const row of out.agents) {
			assert.equal(row.canSpawn, true, `${row.id}.canSpawn must be true (per-agent '*')`);
		}
	});

	it("propagates name when configured", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter" },
				main: {},
				mathematician: { name: "Mathematician" },
			},
		});
		const out = await runTool("main");
		const math = out.agents.find((a) => a.id === "mathematician");
		assert.equal(math?.name, "Mathematician");
	});

	it("tool description steers the model to ALWAYS call (not enumerate from memory)", () => {
		const tool = makeAgentsListTool({ requesterAgentId: "main" });
		assert.match(tool.description, /List EVERY agent currently configured/);
		assert.match(tool.description, /canSpawn\/canSend flags/);
		assert.match(tool.description, /CALL THIS for any who\/which\/how-many agents question/);
		assert.match(tool.description, /never enumerate from memory/);
	});
});
