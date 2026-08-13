/**
 * Tests for the per-kind installer.
 *
 * Uses a stub `spawn` so we assert the right binary + args were invoked
 * without launching a real child process. The `download` kind is tested
 * with a stub `fetch`.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { installSkill } from "./install.js";
import type { SpawnLike } from "./install.js";

let tmpRoot: string;
beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-install-"));
});
afterEach(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

interface SpawnCall {
	command: string;
	args: readonly string[];
}

function makeStubSpawn(captured: SpawnCall[], code = 0): SpawnLike {
	return ((command: string, args: readonly string[]) => {
		captured.push({ command, args });
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		// Settle on next tick so the EventEmitter listeners are attached first.
		setImmediate(() => child.emit("close", code));
		return child as never;
	}) as SpawnLike;
}

describe("installSkill", () => {
	it("kind=node invokes `npm install -g <package>`", async () => {
		const calls: SpawnCall[] = [];
		const res = await installSkill(
			{ kind: "node", target: "cowsay" },
			{ spawn: makeStubSpawn(calls), hasBinaryImpl: () => true },
		);
		assert.equal(res.ok, true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.command, "npm");
		assert.deepEqual([...calls[0]!.args], ["install", "-g", "cowsay"]);
	});

	it("kind=brew invokes `brew install <formula>`", async () => {
		const calls: SpawnCall[] = [];
		const res = await installSkill(
			{ kind: "brew", formula: "gh" },
			{ spawn: makeStubSpawn(calls), hasBinaryImpl: () => true },
		);
		assert.equal(res.ok, true);
		assert.equal(calls[0]!.command, "brew");
		assert.deepEqual([...calls[0]!.args], ["install", "gh"]);
	});

	it("kind=go invokes `go install <module>`", async () => {
		const calls: SpawnCall[] = [];
		const res = await installSkill(
			{ kind: "go", module: "github.com/x/y@latest" },
			{ spawn: makeStubSpawn(calls), hasBinaryImpl: () => true },
		);
		assert.equal(res.ok, true);
		assert.equal(calls[0]!.command, "go");
		assert.deepEqual([...calls[0]!.args], ["install", "github.com/x/y@latest"]);
	});

	it("kind=uv invokes `uv pip install <package>`", async () => {
		const calls: SpawnCall[] = [];
		const res = await installSkill(
			{ kind: "uv", package: "ruff" },
			{ spawn: makeStubSpawn(calls), hasBinaryImpl: () => true },
		);
		assert.equal(res.ok, true);
		assert.equal(calls[0]!.command, "uv");
		assert.deepEqual([...calls[0]!.args], ["pip", "install", "ruff"]);
	});

	it("returns ok=false when the installer binary is missing", async () => {
		const res = await installSkill(
			{ kind: "node", target: "cowsay" },
			{ spawn: makeStubSpawn([]), hasBinaryImpl: () => false },
		);
		assert.equal(res.ok, false);
		assert.match(res.message ?? "", /npm/);
	});

	it("kind=node fails fast without target", async () => {
		const res = await installSkill(
			{ kind: "node" },
			{ spawn: makeStubSpawn([]), hasBinaryImpl: () => true },
		);
		assert.equal(res.ok, false);
		assert.match(res.message ?? "", /package/);
	});

	it("kind=download writes the fetched bytes to targetDir/<basename>", async () => {
		const url = "https://example.test/files/hello.txt";
		const dest = path.join(tmpRoot, "out");
		const stubFetch = (async () =>
			new Response(new Uint8Array([0x68, 0x69]), { status: 200 })) as typeof fetch;
		const res = await installSkill(
			{ kind: "download", url, targetDir: dest },
			{ fetchImpl: stubFetch },
		);
		assert.equal(res.ok, true);
		assert.equal(res.downloadedTo, path.join(dest, "hello.txt"));
		assert.equal(fs.readFileSync(res.downloadedTo!, "utf8"), "hi");
	});

	it("kind=download confines the write to targetDir for a traversal-shaped URL", async () => {
		const dest = path.join(tmpRoot, "out");
		const stubFetch = (async () =>
			new Response(new Uint8Array([0x68, 0x69]), { status: 200 })) as typeof fetch;
		for (const url of [
			"https://example.test/a/../../../etc/passwd",
			"https://example.test/..%2f..%2fetc%2fpasswd",
			"https://example.test/",
			"https://example.test/..",
		]) {
			const res = await installSkill({ kind: "download", url, targetDir: dest }, { fetchImpl: stubFetch });
			assert.equal(res.ok, true, url);
			const written = path.resolve(res.downloadedTo!);
			assert.equal(path.dirname(written), path.resolve(dest), url);
			const rel = path.relative(path.resolve(dest), written);
			assert.ok(rel.length > 0 && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), url);
		}
	});

	it("kind=download surfaces non-2xx HTTP as ok=false", async () => {
		const stubFetch = (async () =>
			new Response("nope", { status: 404 })) as typeof fetch;
		const res = await installSkill(
			{ kind: "download", url: "https://example.test/x", targetDir: tmpRoot },
			{ fetchImpl: stubFetch },
		);
		assert.equal(res.ok, false);
		assert.match(res.message ?? "", /404/);
	});
});
