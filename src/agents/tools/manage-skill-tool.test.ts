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
	action: "create" | "patch" | "delete" | "write_file" | "remove_file";
	name: string;
	scope: "agent" | "managed";
	agentId?: string;
	skillDir: string;
	skillFile: string;
	filePath?: string;
	created?: boolean;
	patched?: boolean;
	deleted?: boolean;
	wroteFile?: boolean;
	removedFile?: boolean;
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

	it("patch appends a section to an existing skill (keeps the original)", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		await tool.execute("p1", {
			action: "create",
			scope: "managed",
			name: "runbook",
			body: "# runbook\n\nstep one",
		});
		const res = parseResult(
			(
				await tool.execute("p2", {
					action: "patch",
					scope: "managed",
					name: "runbook",
					body: "## Pitfall\n\nrotate the key first",
				})
			).content,
		);
		assert.equal(res.ok, true);
		assert.equal(res.patched, true);
		const onDisk = fs.readFileSync(res.skillFile, "utf8");
		assert.match(onDisk, /step one/); // original preserved
		assert.match(onDisk, /rotate the key first/); // refinement appended
	});

	it("patch a non-existent skill fails with a clear message", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const res = parseResult(
			(await tool.execute("p3", { action: "patch", scope: "managed", name: "ghost", body: "## x" })).content,
		);
		assert.equal(res.ok, false);
		assert.match(res.message, /to patch|No skill/);
	});

	it("patch requires a body", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		await tool.execute("p4a", { action: "create", scope: "managed", name: "needs-body", body: "# x\n\ny" });
		const res = parseResult(
			(await tool.execute("p4b", { action: "patch", scope: "managed", name: "needs-body" })).content,
		);
		assert.equal(res.ok, false);
		assert.match(res.message, /body.*required/i);
	});
});

describe("manage_skill — support files (write_file / remove_file)", () => {
	async function createSkill(name: string): Promise<void> {
		const tool = makeManageSkillTool();
		const res = parseResult(
			(await tool.execute(`mk-${name}`, { action: "create", scope: "managed", name, body: `# ${name}\n\nbody` })).content,
		);
		assert.equal(res.ok, true);
	}

	it("write_file attaches a reference doc under references/ on an existing skill", async () => {
		await createSkill("packaged");
		const tool = makeManageSkillTool();
		const res = parseResult(
			(
				await tool.execute("wf-1", {
					action: "write_file",
					scope: "managed",
					name: "packaged",
					filePath: "references/api-notes.md",
					fileContent: "# API notes\n\nThe endpoint is POST /v1/run.",
				})
			).content,
		);
		assert.equal(res.ok, true);
		assert.equal(res.wroteFile, true);
		assert.equal(res.filePath, "references/api-notes.md");
		const onDisk = fs.readFileSync(path.join(res.skillDir, "references", "api-notes.md"), "utf8");
		assert.match(onDisk, /POST \/v1\/run/);
	});

	it("write_file supports scripts/ (runnable support files)", async () => {
		await createSkill("with-script");
		const tool = makeManageSkillTool();
		const res = parseResult(
			(
				await tool.execute("wf-2", {
					action: "write_file",
					scope: "managed",
					name: "with-script",
					filePath: "scripts/check.sh",
					fileContent: "#!/usr/bin/env bash\necho ok\n",
				})
			).content,
		);
		assert.equal(res.ok, true);
		assert.ok(fs.existsSync(path.join(res.skillDir, "scripts", "check.sh")));
	});

	it("write_file REFUSES path traversal", async () => {
		await createSkill("guarded");
		const tool = makeManageSkillTool();
		const res = parseResult(
			(
				await tool.execute("wf-3", {
					action: "write_file",
					scope: "managed",
					name: "guarded",
					filePath: "../../../etc/passwd",
					fileContent: "x",
				})
			).content,
		);
		assert.equal(res.ok, false);
		assert.equal(res.wroteFile, false);
		assert.equal(fs.existsSync(path.join(tmpRoot, "etc", "passwd")), false);
	});

	it("write_file REFUSES a non-allowed subdir", async () => {
		await createSkill("subdir-guard");
		const tool = makeManageSkillTool();
		const res = parseResult(
			(
				await tool.execute("wf-4", {
					action: "write_file",
					scope: "managed",
					name: "subdir-guard",
					filePath: "secrets/leak.md",
					fileContent: "x",
				})
			).content,
		);
		assert.equal(res.ok, false);
		assert.match(res.message, /references\/, templates\/, scripts\/, or assets\//);
	});

	it("write_file to a non-existent skill fails clearly", async () => {
		const tool = makeManageSkillTool();
		const res = parseResult(
			(
				await tool.execute("wf-5", {
					action: "write_file",
					scope: "managed",
					name: "ghost-skill",
					filePath: "references/x.md",
					fileContent: "x",
				})
			).content,
		);
		assert.equal(res.ok, false);
		assert.match(res.message, /No skill at|Create it/);
	});

	it("write_file rejects oversized content", async () => {
		await createSkill("big");
		const tool = makeManageSkillTool();
		const res = parseResult(
			(
				await tool.execute("wf-6", {
					action: "write_file",
					scope: "managed",
					name: "big",
					filePath: "references/huge.md",
					fileContent: "x".repeat(300_000),
				})
			).content,
		);
		assert.equal(res.ok, false);
		assert.match(res.message, /limit/i);
	});

	it("remove_file deletes the support file and prunes the empty subdir", async () => {
		await createSkill("cleanup");
		const tool = makeManageSkillTool();
		await tool.execute("wf-7a", {
			action: "write_file",
			scope: "managed",
			name: "cleanup",
			filePath: "templates/start.txt",
			fileContent: "starter",
		});
		const removed = parseResult(
			(
				await tool.execute("wf-7b", {
					action: "remove_file",
					scope: "managed",
					name: "cleanup",
					filePath: "templates/start.txt",
				})
			).content,
		);
		assert.equal(removed.ok, true);
		assert.equal(removed.removedFile, true);
		assert.equal(fs.existsSync(path.join(removed.skillDir, "templates", "start.txt")), false);
		// emptied subdir pruned, skill root intact
		assert.equal(fs.existsSync(path.join(removed.skillDir, "templates")), false);
		assert.ok(fs.existsSync(path.join(removed.skillDir, "SKILL.md")));
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

describe("manage_skill — action=list", () => {
	// Production failure (2026-06-11): with no list action the model answered
	// "what skills exist?" by filesystem-spelunking (find/bash/ls) — and a
	// broken find led it to claim freshly-created skills "failed silently".
	// list is the grounded, single-call answer.
	interface ListResult {
		action: "list";
		ok: boolean;
		count: number;
		skills: Array<{
			name: string;
			scope: "agent" | "managed";
			agentId?: string;
			description?: string;
			skillDir: string;
		}>;
		message: string;
	}

	function parseList(content: unknown): ListResult {
		const arr = content as Array<{ type: string; text?: string }>;
		return JSON.parse(arr[0]?.text ?? "") as ListResult;
	}

	it("enumerates managed + agent scopes with descriptions", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		await tool.execute("c1", {
			action: "create",
			name: "weather-fetcher",
			scope: "managed",
			description: "Fetch the weather",
		});
		await tool.execute("c2", {
			action: "create",
			name: "gym-playbook",
			scope: "agent",
			agentId: "main",
			description: "Gym routines",
		});
		const res = await tool.execute("l1", { action: "list" });
		const list = parseList(res.content);
		assert.equal(list.ok, true);
		assert.equal(list.count, 2);
		const byName = new Map(list.skills.map((s) => [s.name, s]));
		assert.equal(byName.get("weather-fetcher")?.scope, "managed");
		assert.equal(byName.get("weather-fetcher")?.description, "Fetch the weather");
		assert.equal(byName.get("gym-playbook")?.scope, "agent");
		assert.equal(byName.get("gym-playbook")?.agentId, "main");
	});

	it("scope/agentId filters narrow the listing", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		await tool.execute("c3", { action: "create", name: "shared-one", scope: "managed" });
		await tool.execute("c4", { action: "create", name: "mine-one", scope: "agent", agentId: "main" });
		const managedOnly = parseList(
			(await tool.execute("l2", { action: "list", scope: "managed" })).content,
		);
		assert.deepEqual(
			managedOnly.skills.map((s) => s.name),
			["shared-one"],
		);
		const agentOnly = parseList(
			(await tool.execute("l3", { action: "list", scope: "agent", agentId: "main" })).content,
		);
		assert.deepEqual(
			agentOnly.skills.map((s) => s.name),
			["mine-one"],
		);
	});

	it("empty install lists zero skills without erroring", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const list = parseList((await tool.execute("l4", { action: "list" })).content);
		assert.equal(list.ok, true);
		assert.equal(list.count, 0);
		assert.deepEqual(list.skills, []);
	});

	it("create/delete without a name now fail with a clear message", async () => {
		const tool = makeManageSkillTool({ requesterAgentId: "main" });
		const res = await tool.execute("c5", { action: "create" });
		const parsed = JSON.parse(
			(res.content as Array<{ text?: string }>)[0]?.text ?? "",
		) as { ok: boolean; message: string };
		assert.equal(parsed.ok, false);
		assert.match(parsed.message, /`name` is required/);
	});
});
