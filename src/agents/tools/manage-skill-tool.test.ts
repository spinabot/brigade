import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverEligibleSkills } from "../skills/index.js";
import { loadConfig } from "../../core/config.js";
import { makeManageSkillTool, sanitizeSkillName } from "./manage-skill-tool.js";
import { resolveAgentWorkspaceDir } from "../../config/paths.js";

interface ManageSkillResult {
	action: "create" | "delete";
	name: string;
	scope: "agent" | "managed";
	agentId?: string;
	skillDir: string;
	skillFile: string;
	created?: boolean;
	deleted?: boolean;
	ok: boolean;
	message: string;
}

function parseResult(content: unknown): ManageSkillResult {
	const arr = content as Array<{ type: string; text?: string }>;
	const text = arr[0]?.text ?? "";
	return JSON.parse(text) as ManageSkillResult;
}

let tmpRoot: string;
let prevState: string | undefined;
let prevConfig: string | undefined;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mskill-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevConfig = process.env.BRIGADE_CONFIG_PATH;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	process.env.BRIGADE_CONFIG_PATH = path.join(tmpRoot, "brigade.json");
	// Seed a minimal config so loadConfig() returns the defaults branch
	// and listAgentEntries returns []. The default-agent fallback still
	// covers "main".
	fs.writeFileSync(
		path.join(tmpRoot, "brigade.json"),
		JSON.stringify({ agents: {} }, null, 2),
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

describe("sanitizeSkillName", () => {
	it("accepts kebab-case names", () => {
		assert.equal(sanitizeSkillName("weather-fetcher"), "weather-fetcher");
		assert.equal(sanitizeSkillName("note-taker"), "note-taker");
	});

	it("rejects path traversal", () => {
		assert.equal(sanitizeSkillName("../../etc/passwd"), "");
		assert.equal(sanitizeSkillName("a/b"), "");
		assert.equal(sanitizeSkillName("a\\b"), "");
		assert.equal(sanitizeSkillName("a..b"), "");
	});

	it("rejects leading dots and NUL", () => {
		assert.equal(sanitizeSkillName(".hidden"), "");
		assert.equal(sanitizeSkillName("a\0b"), "");
	});
});

describe("manage_skill tool", () => {
	it("create scope=agent writes SKILL.md under the default agent workspace", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const result = parseResult(
			(
				await tool.execute("call-1", {
					action: "create",
					scope: "agent",
					name: "test-skill",
					description: "A test skill for verification.",
					body: "# test-skill\n\nDo the test thing.",
				})
			).content,
		);
		assert.equal(result.ok, true);
		assert.equal(result.created, true);
		assert.equal(result.scope, "agent");
		assert.equal(result.agentId, "main");
		// Default agent → <state>/workspace/skills/<name>/
		const expectedDir = path.join(tmpRoot, "workspace", "skills", "test-skill");
		assert.equal(path.resolve(result.skillDir), path.resolve(expectedDir));
		const onDisk = fs.readFileSync(result.skillFile, "utf8");
		assert.match(onDisk, /^---\nname: test-skill\n/);
		assert.match(onDisk, /description:/);
		assert.match(onDisk, /Do the test thing\./);
	});

	it("create scope=managed writes SKILL.md under ~/.brigade/skills/", async () => {
		const tool = makeManageSkillTool();
		const result = parseResult(
			(
				await tool.execute("call-2", {
					action: "create",
					scope: "managed",
					name: "shared-skill",
					description: "Shared across agents.",
				})
			).content,
		);
		assert.equal(result.ok, true);
		assert.equal(result.scope, "managed");
		assert.equal(result.agentId, undefined);
		const expectedDir = path.join(tmpRoot, "skills", "shared-skill");
		assert.equal(path.resolve(result.skillDir), path.resolve(expectedDir));
		assert.ok(fs.existsSync(result.skillFile));
	});

	it("create scope=agent for a non-existent agent refuses with helpful message", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const result = parseResult(
			(
				await tool.execute("call-3", {
					action: "create",
					scope: "agent",
					agentId: "nonexistent",
					name: "nope-skill",
				})
			).content,
		);
		assert.equal(result.ok, false);
		assert.match(result.message, /not configured/i);
		assert.match(result.message, /manage_agent/);
	});

	it("create twice refuses on second call (idempotency surface)", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const first = parseResult(
			(
				await tool.execute("call-4a", {
					action: "create",
					scope: "managed",
					name: "dup-skill",
				})
			).content,
		);
		assert.equal(first.ok, true);
		const second = parseResult(
			(
				await tool.execute("call-4b", {
					action: "create",
					scope: "managed",
					name: "dup-skill",
				})
			).content,
		);
		assert.equal(second.ok, false);
		assert.match(second.message, /already exists/i);
	});

	it("delete removes the directory", async () => {
		const tool = makeManageSkillTool();
		const created = parseResult(
			(
				await tool.execute("call-5a", {
					action: "create",
					scope: "managed",
					name: "ephemeral",
				})
			).content,
		);
		assert.equal(created.ok, true);
		assert.ok(fs.existsSync(created.skillDir));
		const deleted = parseResult(
			(
				await tool.execute("call-5b", {
					action: "delete",
					scope: "managed",
					name: "ephemeral",
				})
			).content,
		);
		assert.equal(deleted.ok, true);
		assert.equal(deleted.deleted, true);
		assert.equal(fs.existsSync(created.skillDir), false);
	});

	it("delete a nonexistent skill returns ok=false with a clear message", async () => {
		const tool = makeManageSkillTool();
		const result = parseResult(
			(
				await tool.execute("call-6", {
					action: "delete",
					scope: "managed",
					name: "never-existed",
				})
			).content,
		);
		assert.equal(result.ok, false);
		assert.match(result.message, /No skill at/);
	});

	it("rejects path-traversal names with a clear message", async () => {
		const tool = makeManageSkillTool();
		const result = parseResult(
			(
				await tool.execute("call-7", {
					action: "create",
					scope: "managed",
					name: "../escape",
				})
			).content,
		);
		assert.equal(result.ok, false);
		assert.match(result.message, /single safe segment/);
		// Nothing escaped onto disk
		assert.equal(fs.existsSync(path.join(tmpRoot, "escape")), false);
	});

	it("is owner-only (ownerOnly flag set)", () => {
		const tool = makeManageSkillTool();
		assert.equal(tool.ownerOnly, true);
	});
});

describe("manage_skill — full round-trip (create → discover)", () => {
	it("scope=managed: created skill is discovered for any agent on next turn", async () => {
		const tool = makeManageSkillTool();
		const created = parseResult(
			(
				await tool.execute("rt-1", {
					action: "create",
					scope: "managed",
					name: "ledger-watcher",
					description: "Watch the ledger.",
					body: "# ledger-watcher\n\nWatch the ledger; alert on anomalies.",
				})
			).content,
		);
		assert.equal(created.ok, true);
		// Next-turn discovery — the runtime call site.
		const cfg = loadConfig();
		const result = discoverEligibleSkills({
			workspaceDir: resolveAgentWorkspaceDir("main"),
			config: cfg,
			agentId: "main",
		});
		const names = result.skills.map((s) => s.name).sort();
		assert.ok(
			names.includes("ledger-watcher"),
			`managed skill must surface for default agent; got ${JSON.stringify(names)}`,
		);
	});

	it("scope=agent: skill written for agent Y is discovered by Y only", async () => {
		// Configure a second agent so the path-write guard allows it AND
		// the `configured` check inside manage_skill passes.
		const configPath = path.join(tmpRoot, "brigade.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify(
				{
					agents: {
						"mathematician": {
							name: "Mathematician",
						},
					},
				},
				null,
				2,
			),
			"utf8",
		);

		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const created = parseResult(
			(
				await tool.execute("rt-2", {
					action: "create",
					scope: "agent",
					agentId: "mathematician",
					name: "quadratic-solver",
					description: "Solve quadratics step-by-step.",
					body: "# quadratic-solver\n\nWalk through the standard derivation.",
				})
			).content,
		);
		assert.equal(created.ok, true);
		assert.match(
			path.resolve(created.skillDir),
			/agents[\\/]+mathematician[\\/]+workspace[\\/]+skills[\\/]+quadratic-solver$/,
		);

		const cfg = loadConfig();

		// Mathematician sees its own skill.
		const mathResult = discoverEligibleSkills({
			workspaceDir: resolveAgentWorkspaceDir("mathematician"),
			config: cfg,
			agentId: "mathematician",
		});
		const mathNames = mathResult.skills.map((s) => s.name);
		assert.ok(
			mathNames.includes("quadratic-solver"),
			`mathematician must see its own skill; got ${JSON.stringify(mathNames)}`,
		);

		// Default agent ("main") does NOT see it — workspace isolation.
		const mainResult = discoverEligibleSkills({
			workspaceDir: resolveAgentWorkspaceDir("main"),
			config: cfg,
			agentId: "main",
		});
		const mainNames = mainResult.skills.map((s) => s.name);
		assert.ok(
			!mainNames.includes("quadratic-solver"),
			`main must NOT see mathematician's per-agent skill; got ${JSON.stringify(mainNames)}`,
		);
	});
});
