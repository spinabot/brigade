import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadHeartbeatFile, loadWorkspaceContextFiles } from "./workspace-loader.js";

let tmpWorkspace: string;

beforeEach(() => {
	tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-workspace-"));
});

afterEach(() => {
	try {
		fs.rmSync(tmpWorkspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function seed(name: string, content: string): void {
	fs.writeFileSync(path.join(tmpWorkspace, name), content, "utf8");
}

describe("loadWorkspaceContextFiles", () => {
	it("loads the full persona surface by default", async () => {
		seed("AGENTS.md", "agents");
		seed("SOUL.md", "soul");
		seed("TOOLS.md", "tools");
		seed("IDENTITY.md", "identity");
		seed("USER.md", "user");
		seed("BOOTSTRAP.md", "bootstrap");
		seed("MEMORY.md", "memory");
		const files = await loadWorkspaceContextFiles(tmpWorkspace);
		const names = files.map((f) => f.name);
		assert.deepEqual(names, [
			"AGENTS.md",
			"SOUL.md",
			"TOOLS.md",
			"IDENTITY.md",
			"USER.md",
			"BOOTSTRAP.md",
			"MEMORY.md",
		]);
	});

	it("drops BOOTSTRAP.md + MEMORY.md when subagentMode is true (Primitive #6)", async () => {
		seed("AGENTS.md", "agents");
		seed("SOUL.md", "soul");
		seed("TOOLS.md", "tools");
		seed("IDENTITY.md", "identity");
		seed("USER.md", "user");
		seed("BOOTSTRAP.md", "bootstrap");
		seed("MEMORY.md", "memory");
		const files = await loadWorkspaceContextFiles(tmpWorkspace, { subagentMode: true });
		const names = files.map((f) => f.name);
		assert.deepEqual(names, [
			"AGENTS.md",
			"SOUL.md",
			"TOOLS.md",
			"IDENTITY.md",
			"USER.md",
		]);
		assert.ok(!names.includes("BOOTSTRAP.md"));
		assert.ok(!names.includes("MEMORY.md"));
	});

	it("respects subagentMode even when only a partial set exists", async () => {
		seed("SOUL.md", "soul");
		seed("BOOTSTRAP.md", "bootstrap");
		const files = await loadWorkspaceContextFiles(tmpWorkspace, { subagentMode: true });
		const names = files.map((f) => f.name);
		assert.deepEqual(names, ["SOUL.md"]);
	});

	it("returns an empty array when subagent allowlist filters out every present file", async () => {
		seed("BOOTSTRAP.md", "bootstrap");
		seed("MEMORY.md", "memory");
		const files = await loadWorkspaceContextFiles(tmpWorkspace, { subagentMode: true });
		assert.equal(files.length, 0);
	});
});

describe("loadHeartbeatFile", () => {
	it("returns the heartbeat file when present", async () => {
		seed("HEARTBEAT.md", "## tick\nnow=2026-05-24");
		const heartbeat = await loadHeartbeatFile(tmpWorkspace);
		assert.ok(heartbeat);
		assert.equal(heartbeat?.name, "HEARTBEAT.md");
		assert.match(heartbeat?.content ?? "", /tick/);
	});

	it("returns undefined when the file is missing", async () => {
		const heartbeat = await loadHeartbeatFile(tmpWorkspace);
		assert.equal(heartbeat, undefined);
	});
});
