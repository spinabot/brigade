/**
 * Brigade-native `find` tool tests.
 *
 * The headline case is the production failure that motivated replacing Pi's
 * fd-backed builtin (2026-06-11): `**` + `/SKILL.md` under a real tree
 * returned "No files found" on Windows (fd's --glob --full-path matches
 * nothing there), so the model concluded nine freshly-created skills had
 * "failed silently" — they were all on disk. Node's fs.promises.glob was
 * probed as a replacement and is equally broken for `**` on win32, hence
 * the walker + minimatch implementation under test here.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeFindTool } from "./find-tool.js";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-find-test-"));
	// agents/<id>/workspace/skills/<name>/SKILL.md ×2 — mirrors the real
	// ~/.brigade layout the production failure ran against.
	for (const agent of ["ceo-agent", "eng-intern"]) {
		const dir = path.join(root, "agents", agent, "workspace", "skills", `${agent}-playbook`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: x\n---\n");
	}
	fs.writeFileSync(path.join(root, "top.md"), "x");
	// Pruned subtrees — must never appear in results.
	const nm = path.join(root, "node_modules", "pkg");
	fs.mkdirSync(nm, { recursive: true });
	fs.writeFileSync(path.join(nm, "SKILL.md"), "x");
	const git = path.join(root, ".git", "info");
	fs.mkdirSync(git, { recursive: true });
	fs.writeFileSync(path.join(git, "SKILL.md"), "x");
	// Hidden directory — fd ran with --hidden, so dot-dirs must be matchable.
	const hidden = path.join(root, ".secrets");
	fs.mkdirSync(hidden, { recursive: true });
	fs.writeFileSync(path.join(hidden, "SKILL.md"), "x");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	return res.content
		.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
		.join("\n");
}

describe("find tool — glob over absolute Windows-style paths", () => {
	it("`**/SKILL.md` finds deeply nested files (the fd-on-Windows regression)", async () => {
		const tool = makeFindTool({ cwd: root });
		const res = await tool.execute("t1", { pattern: "**/SKILL.md", path: root });
		const text = textOf(res);
		assert.match(text, /agents\/ceo-agent\/workspace\/skills\/ceo-agent-playbook\/SKILL\.md/);
		assert.match(text, /agents\/eng-intern\/workspace\/skills\/eng-intern-playbook\/SKILL\.md/);
		// Hidden dirs traversed, pruned dirs not.
		assert.match(text, /\.secrets\/SKILL\.md/);
		assert.doesNotMatch(text, /node_modules/);
		assert.doesNotMatch(text, /\.git\//);
	});

	it("relative `path` resolves against the tool cwd", async () => {
		const tool = makeFindTool({ cwd: root });
		const res = await tool.execute("t2", { pattern: "**/SKILL.md", path: "agents" });
		const text = textOf(res);
		assert.match(text, /ceo-agent\/workspace\/skills\/ceo-agent-playbook\/SKILL\.md/);
		assert.doesNotMatch(text, /\.secrets/);
	});

	it("slash-free patterns match by basename at ANY depth (fd builtin parity)", async () => {
		// The fd-backed builtin this replaces matched `*.md` against the
		// basename recursively; the model relies on that. A slash-free pattern
		// must find nested files, not just root-level ones.
		const tool = makeFindTool({ cwd: root });
		const text = textOf(await tool.execute("t3", { pattern: "*.md" }));
		assert.match(text, /^top\.md$/m, "root-level match");
		assert.match(text, /ceo-agent-playbook\/SKILL\.md/, "nested match by basename");
		assert.match(text, /\.secrets\/SKILL\.md/, "hidden-dir nested match");
	});

	it("patterns WITH a slash match the full relative path (not basename)", async () => {
		const tool = makeFindTool({ cwd: root });
		const text = textOf(await tool.execute("t3b", { pattern: "agents/*/workspace/skills/*/SKILL.md" }));
		assert.match(text, /ceo-agent\/workspace\/skills\/ceo-agent-playbook\/SKILL\.md/);
		assert.doesNotMatch(text, /\.secrets/, "slash pattern does not basename-match");
	});

	it("backslash patterns are normalised instead of silently matching nothing", async () => {
		const tool = makeFindTool({ cwd: root });
		const res = await tool.execute("t4", { pattern: "**\\SKILL.md", path: root });
		assert.match(textOf(res), /ceo-agent-playbook\/SKILL\.md/);
	});

	it("empty result returns the canonical no-match text", async () => {
		const tool = makeFindTool({ cwd: root });
		const res = await tool.execute("t5", { pattern: "**/*.nothing" });
		assert.equal(textOf(res), "No files found matching pattern");
	});

	it("missing search path throws Path not found", async () => {
		const tool = makeFindTool({ cwd: root });
		await assert.rejects(
			() => tool.execute("t6", { pattern: "*", path: path.join(root, "no-such-dir") }),
			/Path not found/,
		);
	});

	it("limit caps results and appends the truncation notice", async () => {
		const many = path.join(root, "many");
		fs.mkdirSync(many);
		for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "x");
		const tool = makeFindTool({ cwd: root });
		const res = await tool.execute("t7", { pattern: "many/*.txt", limit: 3 });
		const text = textOf(res);
		assert.equal(text.split("\n").filter((l) => l.endsWith(".txt")).length, 3);
		assert.match(text, /3 results limit reached/);
		assert.equal(res.details?.resultLimitReached, 3);
	});
});
