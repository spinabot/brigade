/**
 * `manage_agent` tool tests.
 *
 * Primary concern: STDIO + brigade.json mutation races. The CLI helpers
 * (`runAgentsAdd` etc.) capture process.stdout/stderr by REPLACING the
 * stream's `write` method. Two concurrent calls would each save the OTHER
 * call's hook as "original" and corrupt stdout permanently when restoring.
 * The serial mutex in `manage-agent-tool.ts` removes that race; this test
 * locks in the invariant.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeManageAgentTool } from "./manage-agent-tool.js";
import { makeAgentsListTool } from "./agents-list-tool.js";

let stateDir: string;
let prevStateDir: string | undefined;

function writeCfg(cfg: unknown): void {
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
}

function readCfg(): {
	agents?: {
		defaults?: { subagents?: { allowAgents?: unknown; autoAllowOnCreate?: unknown } };
		[k: string]: unknown;
	};
	session?: {
		agentToAgent?: unknown;
		autoEnableA2AOnAgentCreate?: unknown;
		[k: string]: unknown;
	};
	[k: string]: unknown;
} {
	return JSON.parse(readFileSync(join(stateDir, "brigade.json"), "utf8"));
}

function readAllowAgents(): string[] {
	const cfg = readCfg();
	const list = cfg.agents?.defaults?.subagents?.allowAgents;
	return Array.isArray(list) ? (list as string[]) : [];
}

function readAgentToAgent(): unknown {
	return readCfg().session?.agentToAgent;
}

async function runListTool(requesterAgentId: string): Promise<{
	requester: string;
	agents: Array<{
		id: string;
		name?: string;
		configured: boolean;
		self?: boolean;
		canSpawn: boolean;
		canSend: boolean;
	}>;
}> {
	const tool = makeAgentsListTool({ requesterAgentId });
	const result = await tool.execute("test-call-id", {});
	const text = result.content?.[0];
	if (!text || text.type !== "text") throw new Error("expected text content");
	return JSON.parse(text.text);
}

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "brigade-manage-agent-"));
	mkdirSync(join(stateDir, "agents"), { recursive: true });
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("manage_agent — concurrent-call safety", () => {
	it("5 parallel calls leave process.stdout intact (no captureStdio corruption)", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
		});
		const tool = makeManageAgentTool();
		const realStdoutWrite = process.stdout.write.bind(process.stdout);
		const realStderrWrite = process.stderr.write.bind(process.stderr);

		// Fire 5 concurrent add calls. Without the serial mutex, the second-
		// to-fire's captureStdio would save the first's hook as "original" and
		// restoring would leave process.stdout permanently broken.
		const results = await Promise.all(
			["alpha", "beta", "gamma", "delta", "epsilon"].map((id) =>
				tool.execute(`call-${id}`, { action: "add", id }),
			),
		);

		// CRITICAL: process.stdout.write must be the real one after all the
		// concurrent calls settle. If the race fired, it would be one of the
		// orphaned capture closures.
		assert.strictEqual(
			process.stdout.write.bind(process.stdout).toString(),
			realStdoutWrite.toString(),
			"process.stdout.write was not properly restored after concurrent calls",
		);
		assert.strictEqual(
			process.stderr.write.bind(process.stderr).toString(),
			realStderrWrite.toString(),
			"process.stderr.write was not properly restored after concurrent calls",
		);

		// All 5 calls must have completed (ok or expected failure — but no
		// hang and no rejection).
		assert.equal(results.length, 5);
		for (const r of results) {
			assert.ok(r.content);
		}
	});

	it("a failing call does not poison the serial chain", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
				existing: {},
			},
		});
		const tool = makeManageAgentTool();

		// First call: try to ADD an id that already exists (likely fails or
		// errors inside runAgentsAdd). Second call should still succeed.
		const first = tool.execute("call-1", { action: "add", id: "existing" });
		const second = tool.execute("call-2", { action: "add", id: "fresh-one" });

		// Both should resolve — the second must not be blocked or rejected by
		// the first's failure.
		const [, secondResult] = await Promise.all([first.catch(() => null), second]);
		assert.ok(secondResult.content, "second call must complete even if first errored");
	});
});

/**
 * Auto-allowlist seed on `manage_agent({action:"add"})`:
 *
 * Without this UX bridge, a fresh `manage_agent` call writes the new agent
 * into `cfg.agents.<id>` but never updates `cfg.agents.defaults.subagents.
 * allowAgents` — so the new agent would surface in `agents_list` with
 * `canSpawn: false`, and the model would have no way to spawn it as a
 * sub-agent without an extra config edit. (The catalog itself is unfiltered
 * under the enumerate-every-agent contract; the seed governs reachability,
 * not visibility.)
 *
 * These tests pin the contract:
 *   (a) add seeds `defaults.subagents.allowAgents` and the new id is
 *       spawn-reachable from `agents_list`
 *   (b) wildcard `"*"` short-circuits the seed (already covers everything)
 *   (c) duplicate-id seed is idempotent (no double-write)
 *   (d) delete strips the id back out of the allowlist
 *   (e) `autoAllowOnCreate: false` opts the operator out for strict-
 *       allowlist mode (new agent still listed, but `canSpawn: false`)
 *   (f) per-agent `subagents.allowAgents` override is left untouched (the
 *       seed only touches `defaults.subagents.allowAgents`)
 */
describe("manage_agent — auto-allowlist seed on add", () => {
	it("(a) add seeds defaults.subagents.allowAgents and the new id surfaces in agents_list", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		const res = await tool.execute("call-add", { action: "add", id: "netpulse" });
		assert.ok(res.content);

		// Config now carries `netpulse` in the defaults allowlist.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["netpulse"], "defaults.subagents.allowAgents must contain the new id");

		// agents_list (allowlist-scoped) now surfaces netpulse to the main caller.
		const listed = await runListTool("main");
		const ids = listed.agents.map((a) => a.id);
		assert.ok(ids.includes("main"), "requester always first");
		assert.ok(ids.includes("netpulse"), "newly added agent must appear in agents_list");
	});

	it("(b) wildcard '*' in allowAgents short-circuits the seed", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: ["*"] },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "support" });

		// The wildcard list must NOT have been extended.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["*"], "wildcard list left intact — seed must skip");
	});

	it("(c) seed is idempotent when the id is already in allowAgents", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: ["scout"] },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "scout" });

		// Only ONE entry — no double-write.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["scout"], "idempotent — no duplicate seed");
	});

	it("(d) delete strips the id from defaults.subagents.allowAgents", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: ["scout", "netpulse"] },
				},
				main: {},
				scout: { workspace: join(stateDir, "agents", "scout", "workspace") },
				netpulse: {},
			},
		});
		mkdirSync(join(stateDir, "agents", "scout", "workspace"), { recursive: true });

		const tool = makeManageAgentTool();
		await tool.execute("call-del", { action: "delete", id: "scout" });

		// scout must be stripped, netpulse must remain.
		const allow = readAllowAgents();
		assert.deepEqual(allow, ["netpulse"], "delete must strip the id from the allowlist");
	});

	it("(e) autoAllowOnCreate=false suppresses the seed (strict-allowlist mode)", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
					subagents: { allowAgents: [], autoAllowOnCreate: false },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "stealth" });

		// Operator-driven allowlist stays empty — the new agent must not become
		// spawn-reachable under strict mode.
		const allow = readAllowAgents();
		assert.deepEqual(allow, [], "autoAllowOnCreate=false must suppress the seed");

		// Under the enumerate-every-agent contract `stealth` still surfaces in
		// the catalog, but its `canSpawn` flag is false because the allowlist
		// wasn't extended. The strict-mode intent is preserved at the flag
		// layer rather than via visibility filtering.
		const listed = await runListTool("main");
		const stealth = listed.agents.find((a) => a.id === "stealth");
		assert.ok(stealth, "stealth surfaces in the catalog (no allowlist visibility filter)");
		assert.equal(
			stealth?.canSpawn,
			false,
			"stealth.canSpawn must be false under strict allowlist mode",
		);
	});

	it("(f) per-agent subagents.allowAgents override is left untouched", async () => {
		// A peer (`captain`) has its OWN per-agent allowlist. The seed only
		// touches `defaults.subagents.allowAgents`, never the per-agent one,
		// so captain's allowlist must stay exactly as the operator authored it.
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
				captain: { subagents: { allowAgents: ["specific-peer"] } },
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "recruit" });

		// Defaults got the seed.
		const allowDefaults = readAllowAgents();
		assert.deepEqual(allowDefaults, ["recruit"], "defaults gets the new id");

		// Captain's per-agent allowlist untouched.
		const cfg = readCfg();
		const captain = (cfg.agents as Record<string, { subagents?: { allowAgents?: unknown } }>)
			.captain;
		assert.deepEqual(
			captain?.subagents?.allowAgents,
			["specific-peer"],
			"per-agent override must NOT be modified by the seed",
		);

		// Under the enumerate-every-agent contract `recruit` surfaces for
		// captain too (the catalog is unfiltered), but captain's `canSpawn`
		// flag is false for it because the per-agent override beats defaults
		// and `recruit` is not in captain's allowlist.
		const captainView = await runListTool("captain");
		const recruitForCaptain = captainView.agents.find((a) => a.id === "recruit");
		assert.ok(recruitForCaptain, "recruit surfaces in the catalog for captain");
		assert.equal(
			recruitForCaptain?.canSpawn,
			false,
			"captain.canSpawn(recruit) must be false (per-agent override wins)",
		);
		const specificPeerForCaptain = captainView.agents.find((a) => a.id === "specific-peer");
		// `specific-peer` is on captain's allowlist but not in cfg.agents — it
		// won't be present because we only enumerate configured agents.
		assert.equal(
			specificPeerForCaptain,
			undefined,
			"specific-peer is not configured, so it does not surface",
		);
	});
});

/**
 * Auto-A2A-policy seed on `manage_agent({action:"add"})`:
 *
 * Sibling of the allowlist seed (`applyAutoAllowOnCreate`). Without it, the
 * model can SEE + spawn the freshly added agent but the `sessions_send` A2A
 * flow still refuses because `cfg.session.agentToAgent` is absent / disabled.
 * The seed writes a canonical wide-open policy when no usable one exists.
 *
 * These tests pin the contract:
 *   (a) add on no-A2A config seeds the canonical object
 *   (b) add on the broken legacy boolean-true shape coerces to canonical
 *   (b2) add on enabled=false object flips enabled while preserving allow
 *   (c) `autoEnableA2AOnAgentCreate: false` opts the operator out
 *   (d) the seed is idempotent on a second add
 */
describe("manage_agent — auto-A2A-policy seed on add", () => {
	it("(a) add on no-A2A config seeds canonical { enabled:true, allow:[{from:*,to:*}] }", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		const res = await tool.execute("call-add", { action: "add", id: "netpulse" });
		assert.ok(res.content);

		const a2a = readAgentToAgent();
		assert.deepEqual(
			a2a,
			{ enabled: true, allow: [{ from: "*", to: "*" }] },
			"missing agentToAgent must be seeded with the canonical wide-open default",
		);
	});

	it("(b) add on boolean-true (broken legacy shape) coerces to canonical object", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
			// Broken legacy shape — a literal boolean instead of the policy object.
			session: { agentToAgent: true },
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "scout" });

		const a2a = readAgentToAgent();
		assert.deepEqual(
			a2a,
			{ enabled: true, allow: [{ from: "*", to: "*" }] },
			"boolean-true must be coerced to the canonical object shape",
		);
	});

	it("(b2) add on enabled=false object flips enabled while preserving operator-authored allow", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
			session: {
				agentToAgent: {
					enabled: false,
					allow: [{ from: "main", to: "captain" }],
					maxPingPongTurns: 7,
				},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "recruit" });

		const a2a = readAgentToAgent() as {
			enabled?: boolean;
			allow?: Array<{ from: string; to: string }>;
			maxPingPongTurns?: number;
		};
		assert.equal(a2a?.enabled, true, "enabled must flip to true");
		assert.deepEqual(
			a2a?.allow,
			[{ from: "main", to: "captain" }],
			"operator-authored allow must be preserved",
		);
		assert.equal(a2a?.maxPingPongTurns, 7, "other operator-authored fields must be preserved");
	});

	it("(c) autoEnableA2AOnAgentCreate=false suppresses the seed", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
			session: { autoEnableA2AOnAgentCreate: false },
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add", { action: "add", id: "stealth" });

		const a2a = readAgentToAgent();
		assert.equal(a2a, undefined, "opt-out must leave agentToAgent absent");
	});

	it("(d) seed is idempotent on a second add", async () => {
		writeCfg({
			agents: {
				defaults: {
					provider: "openrouter",
					model: { primary: "anthropic/claude-sonnet-4.6" },
				},
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-add-1", { action: "add", id: "first" });
		const afterFirst = readAgentToAgent();
		assert.deepEqual(
			afterFirst,
			{ enabled: true, allow: [{ from: "*", to: "*" }] },
			"first add seeds canonical default",
		);

		await tool.execute("call-add-2", { action: "add", id: "second" });
		const afterSecond = readAgentToAgent();
		assert.deepEqual(
			afterSecond,
			{ enabled: true, allow: [{ from: "*", to: "*" }] },
			"second add must NOT mutate the already-seeded canonical default",
		);
	});
});

/**
 * Implicit Pride-org init on `manage_agent({action:"add"})`:
 *
 * Operator should never have to run `brigade org init` separately. Saying
 * "create a CEO" or "create an engineer reporting to main" in chat should
 * auto-initialise `cfg.org` AND seed the new agent's `org` block in one
 * atomic write.
 *
 * The companion `applyAutoEnableOrgOnHierarchicalAdd` helper in
 * `cli/commands/agents-cmd.ts` does the work; these tests pin the contract.
 */
describe("manage_agent — implicit Pride-org init on hierarchical add", () => {
	function readCfgOrg(): unknown {
		return readCfg().org;
	}
	function readAgentOrg(id: string): unknown {
		const cfg = readCfg();
		const agents = cfg.agents as Record<string, { org?: unknown }> | undefined;
		return agents?.[id]?.org;
	}

	it("(a) add with reportsTo:null → new agent becomes topOrder + cfg.org auto-init", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		const res = await tool.execute("call-ceo", {
			action: "add",
			id: "ceo",
			department: "executive",
			reportsTo: null,
			role: "Chief Executive Officer",
		});
		assert.ok(res.content);

		// cfg.org auto-initialised; new agent IS the topOrder.
		const org = readCfgOrg() as { topOrder?: string; a2a?: { mode?: string } } | undefined;
		assert.equal(org?.topOrder, "ceo", "new agent with reportsTo:null becomes topOrder");
		assert.equal(org?.a2a?.mode, "derived");

		// New agent's org block seeded from params.
		assert.deepEqual(readAgentOrg("ceo"), {
			department: "executive",
			reportsTo: null,
			role: "Chief Executive Officer",
		});
	});

	it("(b) add with reportsTo:'main' → main becomes topOrder + main org auto-seeded", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-eng", {
			action: "add",
			id: "eng_lead",
			department: "engineering",
			reportsTo: "main",
			role: "Engineering Lead",
		});

		const org = readCfgOrg() as { topOrder?: string } | undefined;
		assert.equal(org?.topOrder, "main", "main is topOrder when the new agent reports to it");

		// main's org block was auto-seeded as Chief of Staff.
		assert.deepEqual(readAgentOrg("main"), {
			department: "executive",
			reportsTo: null,
			role: "Chief of Staff",
		});

		// New agent's org block seeded from params.
		assert.deepEqual(readAgentOrg("eng_lead"), {
			department: "engineering",
			reportsTo: "main",
			role: "Engineering Lead",
		});
	});

	it("(c) add with org fields when cfg.org ALREADY present → seed new agent only, don't touch cfg.org", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: { org: { department: "executive", reportsTo: null, role: "Chief of Staff" } },
				ceo: { org: { department: "executive", reportsTo: null, role: "CEO" } },
			},
			org: { topOrder: "ceo", a2a: { mode: "derived" } },
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-cto", {
			action: "add",
			id: "cto",
			department: "engineering",
			reportsTo: "ceo",
			role: "CTO",
		});

		const org = readCfgOrg() as { topOrder?: string } | undefined;
		assert.equal(org?.topOrder, "ceo", "existing topOrder is NOT replaced");
		assert.deepEqual(readAgentOrg("cto"), {
			department: "engineering",
			reportsTo: "ceo",
			role: "CTO",
		});
	});

	it("(d) add WITHOUT any org field → cfg.org stays absent (no implicit init)", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: {},
			},
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-plain", { action: "add", id: "plain" });

		// cfg.org must remain absent — only the explicit org-field add triggers init.
		assert.equal(readCfgOrg(), undefined, "no org seed when no org field passed");
		assert.equal(readAgentOrg("plain"), undefined, "new agent has no org block");
	});

	it("(e) autoEnableOrgOnHierarchicalAdd=false → opt-out keeps cfg.org absent", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: {},
			},
			session: { autoEnableOrgOnHierarchicalAdd: false },
		});

		const tool = makeManageAgentTool();
		await tool.execute("call-strict", {
			action: "add",
			id: "strict_agent",
			department: "engineering",
			reportsTo: null,
			role: "Strict Lead",
		});

		// cfg.org stays absent — operator manages it by hand under strict mode.
		assert.equal(readCfgOrg(), undefined, "opt-out short-circuits init");
		// New agent's org block IS still seeded (it's per-agent state, not the global init).
		assert.deepEqual(readAgentOrg("strict_agent"), {
			department: "engineering",
			reportsTo: null,
			role: "Strict Lead",
		});
	});

	it("(f) reportsTo:'' (empty string) is coerced to null — bricked-gateway regression", async () => {
		// REGRESSION: the LLM sometimes passes `reportsTo: ""` meaning
		// "no parent". TypeBox's Union<String, Null> accepts that; the
		// auto-init then wrote `agents.<id>.org.reportsTo = ""` which
		// fails `validate.ts` (`"" is not a member`) and bricks the
		// gateway — every subsequent prompt throws during boot
		// validation. The tool must NORMALISE empty / whitespace
		// reportsTo strings to null (== "new agent IS topOrder").
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: {},
			},
		});
		const tool = makeManageAgentTool();
		await tool.execute("call-ceo-empty", {
			action: "add",
			id: "ceo_x",
			department: "executive",
			reportsTo: "", // ← THE BUG
			role: "CEO",
		});
		const org = readCfgOrg() as { topOrder?: string } | undefined;
		assert.equal(org?.topOrder, "ceo_x", "empty-string reportsTo treated as null → ceo is topOrder");
		assert.deepEqual(readAgentOrg("ceo_x"), {
			department: "executive",
			reportsTo: null,
			role: "CEO",
		});
	});

	it("(g) empty department/role/bio strings are dropped (not written as '')", async () => {
		writeCfg({
			agents: {
				defaults: { provider: "openrouter", model: { primary: "anthropic/claude-sonnet-4.6" } },
				main: {},
			},
			org: { topOrder: "main", a2a: { mode: "derived" } },
		});
		const tool = makeManageAgentTool();
		await tool.execute("call-blanks", {
			action: "add",
			id: "blanks",
			department: "  ", // whitespace-only
			reportsTo: "main",
			role: "",
			bio: "",
		});
		const block = readAgentOrg("blanks") as Record<string, unknown> | undefined;
		assert.equal(block?.reportsTo, "main");
		assert.ok(!("department" in (block ?? {})), "blank department dropped");
		assert.ok(!("role" in (block ?? {})), "blank role dropped");
		assert.ok(!("bio" in (block ?? {})), "blank bio dropped");
	});
});
