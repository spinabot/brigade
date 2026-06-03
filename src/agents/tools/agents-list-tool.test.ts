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

async function runTool(requesterAgentId?: string) {
	const tool = makeAgentsListTool(requesterAgentId !== undefined ? { requesterAgentId } : {});
	const result = await tool.execute("test-call-id", {});
	const text = result.content?.[0];
	if (!text || text.type !== "text") throw new Error("expected text content");
	return JSON.parse(text.text) as {
		requester: string;
		allowAny: boolean;
		agents: Array<{ id: string; name?: string; configured: boolean }>;
	};
}

describe("agents_list tool", () => {
	it("returns just the default agent when cfg has no extra entries", async () => {
		writeCfg({ agents: { defaults: { provider: "openrouter" }, main: {} } });
		const out = await runTool("main");
		assert.equal(out.requester, "main");
		assert.equal(out.allowAny, false);
		assert.equal(out.agents.length, 1);
		assert.equal(out.agents[0]?.id, "main");
		assert.equal(out.agents[0]?.configured, true);
	});

	it("includes all configured agents when allowAgents=['*']", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					subagents: { allowAgents: ["*"] },
				},
				main: {},
				netpulse: { name: "NetPulse" },
				support: {},
			},
		});
		const out = await runTool("main");
		assert.equal(out.allowAny, true);
		const ids = out.agents.map((a) => a.id).sort();
		assert.deepEqual(ids, ["main", "netpulse", "support"]);
		const np = out.agents.find((a) => a.id === "netpulse");
		assert.equal(np?.name, "NetPulse");
		assert.equal(np?.configured, true);
	});

	it("restricts to allowAgents list (not '*')", async () => {
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
		assert.equal(out.allowAny, false);
		const ids = out.agents.map((a) => a.id).sort();
		assert.deepEqual(ids, ["main", "netpulse"]);
	});

	it("requester is always first in the returned list", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", subagents: { allowAgents: ["*"] } },
				main: {},
				alpha: {},
				zeta: {},
			},
		});
		const out = await runTool("zeta");
		assert.equal(out.agents[0]?.id, "zeta");
	});
});
