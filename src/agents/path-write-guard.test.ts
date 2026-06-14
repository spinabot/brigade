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

/** Guard bound to a specific session cwd (the way the gateway wires it). */
async function runGuardCwd(
	cwd: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<BeforeToolCallResult | undefined> {
	const guard = makePathWriteGuard({ cwd });
	return await guard(makeCtx(toolName, args));
}

describe("path-write guard — tilde + relative resolution (audit P0)", () => {
	// The guard must resolve `~` and relative paths the SAME way Pi's tools do
	// (tilde-expand, resolve against the SESSION cwd). 2026-06-11: the guard
	// used bare path.resolve (gateway cwd, no tilde) so edit({path:
	// "~/.brigade/brigade.json"}) and a workspace-relative "../brigade.json"
	// hit the real config while the guard saw a non-matching path.
	it("blocks edit with a `~`-relative path to brigade.json", async () => {
		// expandTilde resolves ~ to os.homedir(); point STATE_DIR there so the
		// tilde target lands on a real protected root.
		const home = os.homedir();
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = path.join(home, ".brigade");
		try {
			const res = await runGuardCwd(
				path.join(home, ".brigade", "agents", "main", "workspace"),
				"edit",
				{ path: "~/.brigade/brigade.json", old_string: "a", new_string: "b" },
			);
			assert.ok(res?.block, "tilde path to config must be blocked");
		} finally {
			process.env.BRIGADE_STATE_DIR = prev;
		}
	});

	it("blocks a workspace-relative ../brigade.json escape", async () => {
		// Session cwd = <state>/workspace; "../brigade.json" climbs to the config.
		const sessionCwd = path.join(tmpRoot, "workspace");
		const res = await runGuardCwd(sessionCwd, "edit", {
			path: "../brigade.json",
			old_string: "a",
			new_string: "b",
		});
		assert.ok(res?.block, "relative escape to config must be blocked");
		assert.match(res?.reason ?? "", /brigade-config/);
	});

	it("still ALLOWS a workspace-relative write that stays in the workspace", async () => {
		const sessionCwd = path.join(tmpRoot, "agents", "main", "workspace");
		const res = await runGuardCwd(sessionCwd, "write", {
			path: "memory/note.md",
			content: "x",
		});
		assert.equal(res, undefined, "in-workspace relative write must pass");
	});
});

describe("path-write guard — protected roots", () => {
	it("builds the canonical protected roots from runtime paths", () => {
		const roots = buildProtectedRoots();
		const ids = [...new Set(roots.map((r) => r.id))].sort();
		assert.deepEqual(ids, [
			"agent-internals",
			"brigade-config",
			"brigade-state",
			"encryption-key",
			"install-skills",
		]);
	});

	it("refuses write to brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("write", { path: target, content: "{}" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /brigade-config/);
		assert.match(result?.reason ?? "", /manage_agent/);
	});

	it("refuses edit to brigade.json — Pi's REAL `path` arg (production bypass regression)", async () => {
		// 2026-06-11: the extractor read only `file_path`, Pi's edit schema
		// sends `path` → every edit was silently allowed and the model edited
		// the live config twice. This test pins the actual wire shape.
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("edit", { path: target, old_string: "a", new_string: "b" });
		assert.ok(result?.block, "edit with `path` must be blocked");
		assert.match(result?.reason ?? "", /brigade-config/);
	});

	it("refuses edit to brigade.json — legacy `file_path` spelling still covered", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("edit", { file_path: target, old_string: "a", new_string: "b" });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /brigade-config/);
	});

	for (const name of ["cron.json", "models.json", "exec-approvals.json", "mode.sentinel"]) {
		it(`refuses write/edit to state file ${name}`, async () => {
			const viaWrite = await runGuard("write", { path: path.join(tmpRoot, name), content: "x" });
			assert.ok(viaWrite?.block, `${name} write must block`);
			const viaEdit = await runGuard("edit", {
				path: path.join(tmpRoot, name),
				old_string: "a",
				new_string: "b",
			});
			assert.ok(viaEdit?.block, `${name} edit must block`);
		});
	}

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

describe("path-write guard — bash command inspection", () => {
	function refusalReasonHas(result: BeforeToolCallResult | undefined, fragment: string): void {
		assert.ok(result?.block, `expected a block, got ${JSON.stringify(result)}`);
		assert.match(
			result?.reason ?? "",
			new RegExp("refusing to mutate"),
			`expected canonical refusal phrasing, got: ${result?.reason}`,
		);
		assert.ok(
			(result?.reason ?? "").includes(fragment),
			`expected reason to mention "${fragment}", got: ${result?.reason}`,
		);
	}

	it("(a) refuses `echo {} > brigade.json` (redirect into config)", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `echo {} > ${target}` });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /brigade structural guard/i);
		assert.match(result?.reason ?? "", /manage_agent/);
	});

	it("(a2) refuses `>>` append redirect into brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `printf '{}' >> ${target}` });
		refusalReasonHas(result, target);
	});

	it("(a3) refuses `| tee` into brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `echo {} | tee ${target}` });
		refusalReasonHas(result, target);
	});

	it("(a4) refuses `| tee -a` append into brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `echo {} | tee -a ${target}` });
		refusalReasonHas(result, target);
	});

	it("(b) refuses `node -e fs.writeFileSync(...)` against brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const command = `node -e "require('fs').writeFileSync('${target.replace(/\\/g, "\\\\")}', '{}')"`;
		const result = await runGuard("bash", { command });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /node -e write/);
	});

	it("(b2) refuses `python -c open(..., 'w')` against brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const command = `python -c "open('${target.replace(/\\/g, "\\\\")}', 'w').write('{}')"`;
		const result = await runGuard("bash", { command });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /python -c write/);
	});

	it("(c) ALLOWS `cat brigade.json` (read-only)", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `cat ${target}` });
		assert.equal(result, undefined);
	});

	it("(c2) ALLOWS `grep / head / tail / less / more / ls / stat / wc` over brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		for (const tool of ["grep '.'", "head -n 5", "tail -n 5", "less", "more", "ls -la", "stat", "wc -l"]) {
			const result = await runGuard("bash", { command: `${tool} ${target}` });
			assert.equal(result, undefined, `expected '${tool}' to be allowed, got: ${JSON.stringify(result)}`);
		}
	});

	it("(c3) ALLOWS `python -m json.tool brigade.json` with no redirect", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `python -m json.tool ${target}` });
		assert.equal(result, undefined);
	});

	it("(d) refuses `sed -i` against brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `sed -i 's/a/b/' ${target}` });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /sed -i/);
	});

	it("(d2) refuses `sed -i.bak` against brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `sed -i.bak 's/a/b/' ${target}` });
		refusalReasonHas(result, target);
	});

	it("(d3) refuses `rm` against brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `rm -f ${target}` });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /rm of/);
	});

	it("(d4) refuses `unlink` against brigade.json", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `unlink ${target}` });
		refusalReasonHas(result, target);
	});

	it("(d5) refuses `mv X brigade.json` (path as destination)", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `mv /tmp/source.json ${target}` });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /mv destination/);
	});

	it("(d6) refuses `cp X brigade.json`", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `cp /tmp/source.json ${target}` });
		refusalReasonHas(result, target);
	});

	it("(e) ALLOWS write to an unrelated path", async () => {
		const elsewhere = path.join(tmpRoot, "unrelated", "file.txt");
		const cmds = [
			`echo hi > ${elsewhere}`,
			`echo hi >> ${elsewhere}`,
			`sed -i 's/a/b/' ${elsewhere}`,
			`mv /tmp/x ${elsewhere}`,
			`rm -f ${elsewhere}`,
		];
		for (const command of cmds) {
			const result = await runGuard("bash", { command });
			assert.equal(result, undefined, `expected '${command}' to be allowed, got: ${JSON.stringify(result)}`);
		}
	});

	it("(f) refuses write into install-tree skills/", async () => {
		const target = path.join(tmpRoot, "install", "skills", "mathematician", "SKILL.md");
		const result = await runGuard("bash", { command: `echo hi > ${target}` });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /install-skills/);
	});

	it("(f2) refuses `node -e fs.appendFileSync` into install-tree skills/", async () => {
		const target = path.join(tmpRoot, "install", "skills", "mathematician", "SKILL.md");
		const command = `node -e "require('fs').appendFileSync('${target.replace(/\\/g, "\\\\")}', 'extra')"`;
		const result = await runGuard("bash", { command });
		refusalReasonHas(result, target);
	});

	it("(g) ALLOWS write into ~/.brigade/workspace/ (default-agent persona dir)", async () => {
		const target = path.join(tmpRoot, "workspace", "skills", "hello", "SKILL.md");
		const cmds = [
			`echo body > ${target}`,
			`echo body >> ${target}`,
			`echo body | tee ${target}`,
			`sed -i 's/a/b/' ${target}`,
			`rm -f ${target}`,
			`mv /tmp/skill.md ${target}`,
		];
		for (const command of cmds) {
			const result = await runGuard("bash", { command });
			assert.equal(result, undefined, `expected '${command}' to be allowed, got: ${JSON.stringify(result)}`);
		}
	});

	it("(g2) ALLOWS write into ~/.brigade/agents/<id>/workspace/ (per-agent persona dir)", async () => {
		const target = path.join(
			tmpRoot,
			"agents",
			"mathematician",
			"workspace",
			"skills",
			"hello",
			"SKILL.md",
		);
		const result = await runGuard("bash", { command: `echo body > ${target}` });
		assert.equal(result, undefined);
	});

	it("(g3) refuses write into ~/.brigade/agents/<id>/agent/ internals via bash", async () => {
		const target = path.join(tmpRoot, "agents", "mathematician", "agent", "profile-state.json");
		const result = await runGuard("bash", { command: `echo {} > ${target}` });
		refusalReasonHas(result, target);
		assert.match(result?.reason ?? "", /agent-internals/);
	});

	it("ignores bash calls with no command arg", async () => {
		const result = await runGuard("bash", {});
		assert.equal(result, undefined);
	});

	it("ignores bash calls with a non-string command (exec-gate handles those)", async () => {
		const result = await runGuard("bash", { command: ["ls", "-la"] as unknown as string });
		assert.equal(result, undefined);
	});

	it("ignores bash calls with whitespace-only command", async () => {
		const result = await runGuard("bash", { command: "   " });
		assert.equal(result, undefined);
	});

	it("recognises `exec` / `shell` / `sh` aliases identically", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		for (const name of ["exec", "shell", "sh", "EXEC", "Shell", "SH"]) {
			const result = await runGuard(name, { command: `echo {} > ${target}` });
			refusalReasonHas(result, target);
		}
	});

	it("does not refuse when the protected path appears only inside a single-quoted comment", async () => {
		// Single-quoted strings still tokenise as words, but with no
		// write-intent operator nearby. `echo 'brigade.json is cool'`
		// should not match.
		const result = await runGuard("bash", { command: `echo 'brigade.json is cool'` });
		assert.equal(result, undefined);
	});

	it("refusal message tells the model to use manage_agent / manage_skill", async () => {
		const target = path.join(tmpRoot, "brigade.json");
		const result = await runGuard("bash", { command: `echo {} > ${target}` });
		assert.ok(result?.block);
		assert.match(result?.reason ?? "", /manage_agent/);
		assert.match(result?.reason ?? "", /manage_skill/);
	});
});
