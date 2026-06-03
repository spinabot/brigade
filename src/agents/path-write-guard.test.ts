import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import { buildProtectedRoots, makePathWriteGuard } from "./path-write-guard.js";

let tmpRoot: string;
let prevState: string | undefined;
let prevBundled: string | undefined;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-pwguard-"));
	prevState = process.env.BRIGADE_STATE_DIR;
	prevBundled = process.env.BRIGADE_BUNDLED_SKILLS_DIR;
	process.env.BRIGADE_STATE_DIR = tmpRoot;
	process.env.BRIGADE_BUNDLED_SKILLS_DIR = path.join(tmpRoot, "install", "skills");
});

afterEach(() => {
	process.env.BRIGADE_STATE_DIR = prevState;
	process.env.BRIGADE_BUNDLED_SKILLS_DIR = prevBundled;
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function makeCtx(toolName: string, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		toolCall: { name: toolName, arguments: args },
	} as unknown as BeforeToolCallContext;
}

async function runGuard(toolName: string, args: Record<string, unknown>): Promise<BeforeToolCallResult | undefined> {
	const guard = makePathWriteGuard();
	return await guard(makeCtx(toolName, args));
}

describe("path-write guard — protected roots", () => {
	it("builds the three canonical protected roots from runtime paths", () => {
		const roots = buildProtectedRoots();
		const ids = roots.map((r) => r.id).sort();
		assert.deepEqual(ids, ["agent-internals", "brigade-config", "install-skills"]);
	});

	it("refuses write to brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("write", { path: target, content: "{}" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /brigade-config/);
		assert.match(result?.reason ?? "", /manage_agent/);
	});

	it("refuses edit to brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("edit", { file_path: target, old_string: "a", new_string: "b" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /brigade-config/);
	});

	it("refuses write into install-dir skills/", async () => {
		const target = path.join(tmpRoot, "install", "skills", "mathematician", "SKILL.md");
		const result = await runGuard("write", { path: target, content: "hi" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /install-skills/);
		assert.match(result?.reason ?? "", /manage_skill/);
	});

	it("refuses write into ~/.brigade/agents/<id>/agent/ internals", async () => {
		const target = path.join(tmpRoot, "agents", "mathematician", "agent", "profile-state.json");
		const result = await runGuard("write", { path: target, content: "{}" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /agent-internals/);
		assert.match(result?.reason ?? "", /manage_agent/);
	});

	it("ALLOWS write into ~/.brigade/agents/<id>/workspace/ (user-writable carve-out)", async () => {
		const target = path.join(
			tmpRoot,
			"agents",
			"mathematician",
			"workspace",
			"skills",
			"hello",
			"SKILL.md",
		);
		const result = await runGuard("write", { path: target, content: "ok" });
		assert.equal(result, undefined);
	});

	it("ALLOWS write into ~/.brigade/workspace/ (default-agent persona dir)", async () => {
		const target = path.join(tmpRoot, "workspace", "skills", "hello", "SKILL.md");
		const result = await runGuard("write", { path: target, content: "ok" });
		assert.equal(result, undefined);
	});

	it("ALLOWS write into ~/.brigade/skills/ (managed skills root)", async () => {
		const target = path.join(tmpRoot, "skills", "shared", "SKILL.md");
		const result = await runGuard("write", { path: target, content: "ok" });
		assert.equal(result, undefined);
	});

	it("ignores tools other than write/edit (no surface for read/grep/etc.)", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const read = await runGuard("read", { path: target });
		const grep = await runGuard("grep", { pattern: ".", path: target });
		assert.equal(read, undefined);
		assert.equal(grep, undefined);
	});

	it("ignores write calls with no path arg (Pi will reject downstream)", async () => {
		const result = await runGuard("write", {});
		assert.equal(result, undefined);
	});

	it("normalises path so `..` traversal still hits the guard", async () => {
		const target = path.join(tmpRoot, "agents", "x", "workspace", "..", "agent", "profile-state.json");
		const result = await runGuard("write", { path: target, content: "{}" });
		assert.ok(result?.block);
	});

	it("uppercased tool names are recognised (normalised)", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("WRITE", { path: target, content: "{}" });
		assert.ok(result?.block);
	});
});
