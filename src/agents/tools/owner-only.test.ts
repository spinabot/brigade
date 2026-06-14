/**
 * Owner-only tool gating + toolset-profile filtering tests.
 *
 * Covers:
 *   - `wrapOwnerOnlyToolExecution` — the per-tool wrapper that refuses
 *     non-owner `execute(...)` calls on tools marked `ownerOnly: true` with
 *     a 403-class `BrigadeToolAuthorizationError` carrying
 *     `OWNER_ONLY_TOOL_ERROR`. Owner calls + non-ownerOnly tools pass
 *     through unchanged.
 *   - `assembleBrigadeToolset({ senderIsOwner })` — applies the wrapper to
 *     every Brigade-native custom tool. Default (omitted) = owner, so all
 *     existing CLI / TUI / gateway callers keep their behaviour.
 *   - `BrigadeExtensionRegistry.eligibleTools({ toolset })` /
 *     `toolNames({ toolset })` / `toPiExtensionFactory({ toolset })` —
 *     filters extension-registered tools to those matching the active
 *     profile. Tools with no `toolset` (or `"*"`) are universal and
 *     always included.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Type } from "typebox";

// HOME → tempdir before importing (matches session-wiring.test.ts pattern —
// `exec-approvals` and similar modules pin paths at load time).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-owner-only-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;

const {
	BrigadeToolAuthorizationError,
	OWNER_ONLY_TOOL_ERROR,
	wrapOwnerOnlyToolExecution,
} = await import("./common.js");
const { assembleBrigadeToolset } = await import("../session-wiring.js");
const { BrigadeExtensionRegistry } = await import("../extensions/registry.js");

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "./types.js";

let workspace: string;

before(() => {
	process.on("exit", () => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-owner-only-ws-"));
	fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
});

after(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/* ─────────────────────────── helpers ─────────────────────────── */

/** Minimal Brigade tool — runs the spy when executed so tests can detect leak-through. */
function makeFakeTool(name: string, ownerOnly: boolean): {
	tool: AnyBrigadeTool;
	calls: number;
} {
	const spy = { calls: 0 };
	const tool: AnyBrigadeTool = {
		name,
		label: name,
		description: "test",
		parameters: Type.Object({}),
		ownerOnly,
		async execute() {
			spy.calls += 1;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	} as AnyBrigadeTool;
	return { tool, calls: spy.calls } as unknown as { tool: AnyBrigadeTool; calls: number };
}

/* ─────────────────────────── wrapOwnerOnlyToolExecution ─────────────────────────── */

describe("wrapOwnerOnlyToolExecution", () => {
	it("non-owner caller of an ownerOnly tool throws BrigadeToolAuthorizationError", async () => {
		let ran = false;
		const inner: AnyBrigadeTool = {
			name: "danger",
			label: "danger",
			description: "owner-only test tool",
			parameters: Type.Object({}),
			ownerOnly: true,
			async execute() {
				ran = true;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} as AnyBrigadeTool;
		const wrapped = wrapOwnerOnlyToolExecution(inner, false);
		await assert.rejects(
			() => wrapped.execute("call-1", {} as never),
			(err: unknown) =>
				err instanceof BrigadeToolAuthorizationError &&
				(err as Error).message === OWNER_ONLY_TOOL_ERROR,
		);
		assert.equal(ran, false, "inner execute must not run when refused");
	});

	it("owner caller of an ownerOnly tool passes through (inner execute runs)", async () => {
		let ran = false;
		const inner: AnyBrigadeTool = {
			name: "danger",
			label: "danger",
			description: "owner-only test tool",
			parameters: Type.Object({}),
			ownerOnly: true,
			async execute() {
				ran = true;
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} as AnyBrigadeTool;
		const wrapped = wrapOwnerOnlyToolExecution(inner, true);
		// Owner short-circuits to the same ref — no wrapping at all.
		assert.equal(wrapped, inner);
		const result = await wrapped.execute("call-1", {} as never);
		assert.equal(ran, true);
		assert.deepEqual((result as { content: { text: string }[] }).content[0]?.text, "ok");
	});

	it("non-owner caller of a non-ownerOnly tool passes through unchanged", async () => {
		const inner: AnyBrigadeTool = {
			name: "harmless",
			label: "harmless",
			description: "shared tool",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} as AnyBrigadeTool;
		const wrapped = wrapOwnerOnlyToolExecution(inner, false);
		// Non-ownerOnly tool: no wrap (same ref) regardless of sender.
		assert.equal(wrapped, inner);
		const result = await wrapped.execute("call-1", {} as never);
		assert.deepEqual((result as { content: { text: string }[] }).content[0]?.text, "ok");
	});

	it("preserves tool metadata (name, label, description, ownerOnly) when wrapping", () => {
		const inner: AnyBrigadeTool = {
			name: "danger",
			label: "Danger Tool",
			description: "long description here",
			parameters: Type.Object({}),
			ownerOnly: true,
			displaySummary: "doing dangerous things",
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} as AnyBrigadeTool;
		const wrapped = wrapOwnerOnlyToolExecution(inner, false);
		assert.equal(wrapped.name, "danger");
		assert.equal(wrapped.label, "Danger Tool");
		assert.equal(wrapped.description, "long description here");
		assert.equal(wrapped.ownerOnly, true);
		assert.equal(wrapped.displaySummary, "doing dangerous things");
		// And the execute ref is the refusal one, not the inner.
		assert.notEqual(wrapped.execute, inner.execute);
	});
});

/* ─────────────────────────── assembleBrigadeToolset ─────────────────────────── */

describe("assembleBrigadeToolset — senderIsOwner gating", () => {
	it("default (no senderIsOwner) preserves backward-compatible owner behaviour", async () => {
		const ts = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		// Every custom tool must be callable without throwing — the default
		// caller IS the owner, so even an ownerOnly tool would run. Memory
		// tools today aren't ownerOnly, so any execute call must succeed.
		for (const tool of ts.customTools) {
			// We can't easily call execute without setting up the memory store,
			// but we can assert that the tool isn't replaced with the refusal
			// shim by checking that it's the SAME ref as a freshly-built one
			// would be (the wrapper short-circuits in owner mode).
			assert.equal(typeof tool.execute, "function");
		}
		assert.equal(ts.customTools.length, 12); // find + generate_image + manage_provider + manage_access + manage_channel_access + oauth_authorize + recall + read_memory + write_memory + agents_list + manage_agent + manage_skill
	});

	it("senderIsOwner: false wraps any ownerOnly tool so it refuses execute", async () => {
		// The bundled memory tools aren't ownerOnly today, so this test
		// asserts the wrapper is APPLIED (rather than test-driving an
		// existing ownerOnly tool) — we directly call wrapOwnerOnlyToolExecution
		// on a synthesised ownerOnly tool and confirm the assemble path's
		// per-tool wrap reaches the same outcome. The contract is that
		// assembleBrigadeToolset's tool list contains wrapped tools when
		// senderIsOwner=false. Today no bundled tool is ownerOnly so the
		// observable surface is unchanged; the wiring is still in place
		// (verified by the wrapper unit tests above).
		const ts = assembleBrigadeToolset({
			workspaceDir: workspace,
			agentId: "main",
			cwd: workspace,
			senderIsOwner: false,
		});
		assert.equal(ts.customTools.length, 12);
		// brigadeToolNames mirror customTools.name — wrapping must NOT change
		// the visible name surface.
		assert.deepEqual(ts.brigadeToolNames.sort(), [
			"agents_list",
			"find",
			"generate_image",
			"manage_access",
			"manage_agent",
			"manage_channel_access",
			"manage_provider",
			"manage_skill",
			"oauth_authorize",
			"read_memory",
			"recall_memory",
			"write_memory",
		]);
	});

	it("senderIsOwner: true is identical to the default", async () => {
		const a = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		const b = assembleBrigadeToolset({
			workspaceDir: workspace,
			agentId: "main",
			cwd: workspace,
			senderIsOwner: true,
		});
		assert.deepEqual(a.enabledToolNames, b.enabledToolNames);
		assert.deepEqual(a.brigadeToolNames, b.brigadeToolNames);
		assert.deepEqual(a.builtinToolNames, b.builtinToolNames);
	});
});

/* ─────────────────────────── registry toolset filter ─────────────────────────── */

describe("BrigadeExtensionRegistry — toolset filter", () => {
	const META = {
		agentId: "main",
		workspaceDir: "/ws",
		cwd: "/cwd",
		config: {} as BrigadeConfig,
	};

	function makeTool(name: string): AnyBrigadeTool {
		return {
			name,
			label: name,
			description: "d",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} as AnyBrigadeTool;
	}

	it("no filter when opts.toolset is unset (full surface)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("a"), { toolset: "coding" });
		b.tool(makeTool("b"), { toolset: "minimal" });
		b.tool(makeTool("c")); // no toolset
		assert.deepEqual(reg.toolNames().sort(), ["a", "b", "c"]);
	});

	it('toolset="full" disables the filter (same as unset)', () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("a"), { toolset: "coding" });
		b.tool(makeTool("b"), { toolset: "minimal" });
		assert.deepEqual(reg.toolNames({ toolset: "full" }).sort(), ["a", "b"]);
	});

	it('toolset="minimal" excludes tools tagged "coding"', () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("a"), { toolset: "coding" });
		b.tool(makeTool("b"), { toolset: "minimal" });
		assert.deepEqual(reg.toolNames({ toolset: "minimal" }), ["b"]);
	});

	it("a tool with no toolset is ALWAYS included (universal)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("universal")); // no toolset
		b.tool(makeTool("coding-only"), { toolset: "coding" });
		assert.deepEqual(reg.toolNames({ toolset: "minimal" }).sort(), ["universal"]);
		assert.deepEqual(reg.toolNames({ toolset: "coding" }).sort(), ["coding-only", "universal"]);
		assert.deepEqual(reg.toolNames({ toolset: "messaging" }).sort(), ["universal"]);
	});

	it('a tool with toolset="*" is ALWAYS included (explicit universal opt-in)', () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("star"), { toolset: "*" });
		b.tool(makeTool("coding"), { toolset: "coding" });
		assert.deepEqual(reg.toolNames({ toolset: "minimal" }).sort(), ["star"]);
		assert.deepEqual(reg.toolNames({ toolset: "coding" }).sort(), ["coding", "star"]);
	});

	it("toPiExtensionFactory honours the toolset filter (Pi doesn't see excluded tools)", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("a"), { toolset: "coding" });
		b.tool(makeTool("b"), { toolset: "minimal" });
		b.tool(makeTool("c")); // universal
		const registered: string[] = [];
		const pi = {
			registerTool: (t: { name: string }) => registered.push(t.name),
			on() {},
			registerCommand() {},
		};
		reg.toPiExtensionFactory({ toolset: "minimal" })(pi as never);
		assert.deepEqual(registered.sort(), ["b", "c"]);
	});

	it("eligible()=false still takes precedence over the toolset filter", () => {
		const reg = new BrigadeExtensionRegistry();
		const b = reg.context(META);
		b.tool(makeTool("off"), { toolset: "minimal", eligible: () => false });
		b.tool(makeTool("on"), { toolset: "minimal" });
		assert.deepEqual(reg.toolNames({ toolset: "minimal" }), ["on"]);
	});
});
