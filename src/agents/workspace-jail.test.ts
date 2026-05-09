import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
	isPathInsideWorkspace,
	isPathInsideWorkspaceWithAlias,
	makeWorkspaceJailGuard,
	resolveAgainstWorkspace,
} from "./workspace-jail.js";

const WS = path.resolve("/tmp/.brigade/workspace");

describe("isPathInsideWorkspace", () => {
	it("treats workspace root itself as inside", () => {
		assert.equal(isPathInsideWorkspace(WS, WS), true);
	});

	it("accepts a relative path that lands inside the workspace", () => {
		assert.equal(isPathInsideWorkspace("USER.md", WS), true);
		assert.equal(isPathInsideWorkspace("memory/notes.md", WS), true);
	});

	it("accepts an absolute path inside the workspace", () => {
		assert.equal(isPathInsideWorkspace(path.join(WS, "IDENTITY.md"), WS), true);
	});

	it("rejects an absolute path outside the workspace", () => {
		assert.equal(isPathInsideWorkspace("/etc/passwd", WS), false);
		assert.equal(isPathInsideWorkspace("/tmp/elsewhere/file.md", WS), false);
	});

	it("rejects relative paths that traverse outside via ..", () => {
		assert.equal(isPathInsideWorkspace("../escape.md", WS), false);
		assert.equal(isPathInsideWorkspace("../../etc/passwd", WS), false);
	});

	it("rejects mixed traversal that resolves outside", () => {
		// foo/../../escape resolves to one level above WS
		assert.equal(isPathInsideWorkspace("foo/../../escape.md", WS), false);
	});

	it("accepts redundant traversal that resolves back inside", () => {
		// foo/../USER.md normalises to USER.md → inside
		assert.equal(isPathInsideWorkspace("foo/../USER.md", WS), true);
	});
});

describe("resolveAgainstWorkspace", () => {
	it("resolves relative paths against the workspace root", () => {
		assert.equal(resolveAgainstWorkspace("USER.md", WS), path.resolve(WS, "USER.md"));
	});

	it("preserves absolute paths", () => {
		assert.equal(resolveAgainstWorkspace("/abs/path.md", WS), path.resolve("/abs/path.md"));
	});

	it("falls back to workspace root for empty input", () => {
		assert.equal(resolveAgainstWorkspace("", WS), path.resolve(WS));
	});
});

describe("makeWorkspaceJailGuard", () => {
	it("returns undefined for unrelated tool names", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "read", arguments: { path: "/etc/hosts" } } } as never);
		assert.equal(r, undefined);
	});

	it("blocks bash outright (no exec-policy in v1)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /disabled in this build/);
		assert.match(r?.reason ?? "", /exec-policy/);
	});

	it("blocks write to a path outside the workspace", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "/etc/escape.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /outside the workspace/);
	});

	it("blocks write to a path that traverses out via ..", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "../../escape.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("blocks edit outside the workspace too", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "edit", arguments: { path: "/somewhere/else.md", oldText: "a", newText: "b" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("allows write with a relative path WHEN the agent cwd is inside the workspace", async () => {
		// Pi resolves relative paths against `processCwd`, so when the agent
		// is running with cwd = workspace, "USER.md" lands inside.
		const guard = makeWorkspaceJailGuard(WS, WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "USER.md", content: "..." } },
		} as never);
		assert.equal(r, undefined);
	});

	it("BLOCKS write with a relative path when agent cwd is OUTSIDE the workspace (the Claude bug)", async () => {
		// Real-world: agent runs from F:\Brigade (the source tree), workspace is
		// ~/.brigade/workspace. Claude emits write({path: "USER.md"}). Pi
		// resolves "USER.md" against F:\Brigade — outside the workspace. The
		// jail must catch this. The earlier (broken) jail let it through
		// because it resolved the path against the workspace, not against cwd.
		const projectCwd = path.resolve("/tmp/some-project");
		const guard = makeWorkspaceJailGuard(WS, projectCwd);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "USER.md", content: "..." } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /outside the workspace/);
		assert.match(r?.reason ?? "", /Retry with the absolute path/);
	});

	it("allows write with an absolute path inside the workspace (cwd irrelevant)", async () => {
		const projectCwd = path.resolve("/tmp/anywhere");
		const guard = makeWorkspaceJailGuard(WS, projectCwd);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: path.join(WS, "IDENTITY.md"), content: "..." } },
		} as never);
		assert.equal(r, undefined);
	});

	it("ignores write calls with no path arg (let downstream handle)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { content: "..." } },
		} as never);
		assert.equal(r, undefined);
	});

	it("does not interfere with read/grep/find/ls (kept open in v1)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		for (const name of ["read", "grep", "find", "ls"]) {
			const r = await guard({
				toolCall: { name, arguments: { path: "/etc/passwd" } },
			} as never);
			assert.equal(r, undefined, `${name} should pass through`);
		}
	});

	it("trims whitespace from tool name (defence in depth)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "  bash  ", arguments: { command: "ls" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("blocks Windows UNC paths (\\\\server\\share)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "\\\\attacker\\share\\loot.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /UNC.*paths/i);
	});

	it("blocks POSIX-style network paths (//host/share)", async () => {
		const guard = makeWorkspaceJailGuard(WS);
		const r = await guard({
			toolCall: { name: "write", arguments: { path: "//host/share/file.md", content: "x" } },
		} as never);
		assert.equal(r?.block, true);
	});

	it("normalizes Unicode whitespace inside path arguments", async () => {
		// Pass cwd = workspace so the relative path resolves inside the
		// boundary; this test is about whitespace normalization, not the
		// cwd-vs-workspace check (covered in its own test above).
		const guard = makeWorkspaceJailGuard(WS, WS);
		const sneaky = "USER .md"; // NBSP between USER and .md
		const r = await guard({
			toolCall: { name: "write", arguments: { path: sneaky, content: "x" } },
		} as never);
		assert.equal(r, undefined);
	});
});

describe("isPathInsideWorkspace edge cases", () => {
	it("rejects UNC paths outright", () => {
		assert.equal(isPathInsideWorkspace("\\\\server\\share\\file", WS), false);
		assert.equal(isPathInsideWorkspace("//host/path", WS), false);
	});
});

describe("isPathInsideWorkspaceWithAlias — symlink escape detection", () => {
	let tmpRoot: string;
	let tmpWs: string;
	let outsideTarget: string;
	let symlinkSupported = true;

	before(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-jail-"));
		tmpWs = path.join(tmpRoot, "workspace");
		await fs.mkdir(tmpWs);
		outsideTarget = path.join(tmpRoot, "secret.txt");
		await fs.writeFile(outsideTarget, "secret");
		// Probe whether we can create symlinks (Windows requires admin or Dev Mode).
		try {
			const probe = path.join(tmpRoot, "_probe");
			await fs.symlink(outsideTarget, probe);
			await fs.unlink(probe);
		} catch {
			symlinkSupported = false;
		}
	});

	after(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	it("accepts a normal path inside the workspace", async () => {
		const ok = await isPathInsideWorkspaceWithAlias("USER.md", tmpWs);
		assert.equal(ok, true);
	});

	it("rejects an absolute path outside the workspace (no symlink involved)", async () => {
		const ok = await isPathInsideWorkspaceWithAlias(outsideTarget, tmpWs);
		assert.equal(ok, false);
	});

	it("rejects a path that lexically matches but realpath-resolves outside (symlink alias escape)", async (t) => {
		if (!symlinkSupported) {
			t.skip("symlink creation not permitted on this host (Windows Dev Mode required)");
			return;
		}
		const sneaky = path.join(tmpWs, "USER.md");
		await fs.symlink(outsideTarget, sneaky);
		try {
			const ok = await isPathInsideWorkspaceWithAlias("USER.md", tmpWs);
			assert.equal(ok, false, "alias escape MUST be rejected");
		} finally {
			await fs.unlink(sneaky).catch(() => {});
		}
	});

	it("accepts a path that doesn't exist yet (broken-symlink-style — ancestor walk works)", async () => {
		const ok = await isPathInsideWorkspaceWithAlias("brand-new-file.md", tmpWs);
		assert.equal(ok, true);
	});
});
