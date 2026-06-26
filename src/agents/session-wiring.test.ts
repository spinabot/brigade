import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// HOME → tempdir before importing (exec-approvals pins BRIGADE_DIR at load).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-wiring-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;
// Neutralize a shell-exported Composio key so the exact tool-count assertions
// (baseline, no-Composio surface) don't flake on machines that have it set.
delete process.env.COMPOSIO_API_KEY;

const { assembleBrigadeToolset, composeBrigadeBeforeToolCall, makeToolPolicyPredicate, resolveSpawnToolTimeoutMs } =
	await import("./session-wiring.js");
const { wrapToolExecutionTimeout } = await import("./tools/common.js");
const approvalsMod = await import("../core/exec-approvals.js");
const busMod = await import("./agent-event-bus.js");

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
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-wiring-ws-"));
	fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
	approvalsMod._resetApprovalsCacheForTests();
	try {
		fs.rmSync(approvalsMod.getApprovalsFilePath(), { force: true });
	} catch {
		/* ignore */
	}
	busMod.__resetAgentBusForTests();
});

after(() => {
	try {
		fs.rmSync(workspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("assembleBrigadeToolset", () => {
	it("returns 6 builtins + 20 brigade tools (composio/connect_channel/message_action/find/generate_image/generate_speech/make_document/edit_document/manage_provider/manage_access/manage_channel_access/manage_memory/oauth_authorize + 3 memory + agents_list + manage_agent + manage_skill) = 26 enabled names", () => {
		// `find` moved from the Pi builtin list to a Brigade-native custom tool
		// (fd's --glob --full-path matches nothing on Windows — see find-tool.ts).
		const ts = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		assert.deepEqual(ts.builtinToolNames, ["read", "write", "edit", "bash", "grep", "ls"]);
		assert.deepEqual(ts.brigadeToolNames.sort(), [
			"agents_list",
			"analyze_media",
			"composio",
			"connect_channel",
			"edit_document",
			"find",
			"generate_image",
			"generate_speech",
			"make_document",
			"manage_access",
			"manage_agent",
			"manage_channel_access",
			"manage_memory",
			"manage_provider",
			"manage_skill",
			"message_action",
			"oauth_authorize",
			"read_memory",
			"recall_memory",
			"write_memory",
		]);
		assert.equal(ts.enabledToolNames.length, 26);
		assert.equal(ts.customTools.length, 20);
	});

	it("derives capabilities.memory=true when recall_memory present", () => {
		const ts = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		assert.equal(ts.capabilities.memory, true);
	});
});

describe("makeToolPolicyPredicate — pure per-group/per-sender tool-name filter", () => {
	it("allow restricts the set to exactly the allowlisted names", () => {
		const allows = makeToolPolicyPredicate({ allow: ["read", "web_search"] });
		assert.equal(allows("read"), true);
		assert.equal(allows("web_search"), true);
		// Anything not in the allowlist is dropped.
		assert.equal(allows("bash"), false);
		assert.equal(allows("write"), false);
	});

	it("alsoAllow widens an explicit allowlist (union with allow)", () => {
		const allows = makeToolPolicyPredicate({ allow: ["read"], alsoAllow: ["web_search"] });
		assert.equal(allows("read"), true);
		assert.equal(allows("web_search"), true);
		assert.equal(allows("bash"), false);
	});

	it("deny removes a tool (deny wins over an allow that contains it)", () => {
		const allows = makeToolPolicyPredicate({ deny: ["exec"] });
		// No allow set → everything else passes.
		assert.equal(allows("read"), true);
		assert.equal(allows("bash"), true);
		// Denied name is removed.
		assert.equal(allows("exec"), false);
	});

	it("deny wins even when the name is also in allow ∪ alsoAllow", () => {
		const allows = makeToolPolicyPredicate({ allow: ["read", "exec"], alsoAllow: ["exec"], deny: ["exec"] });
		assert.equal(allows("read"), true);
		assert.equal(allows("exec"), false);
	});

	it("alsoAllow alone (no allow) does NOT restrict — everything passes", () => {
		// alsoAllow only widens an explicit allowlist; with no `allow` the
		// default is "all tools", so alsoAllow is inert.
		const allows = makeToolPolicyPredicate({ alsoAllow: ["read"] });
		assert.equal(allows("read"), true);
		assert.equal(allows("bash"), true);
		assert.equal(allows("anything"), true);
	});

	it("empty policy ({}) is a no-op — every name passes", () => {
		const allows = makeToolPolicyPredicate({});
		assert.equal(allows("read"), true);
		assert.equal(allows("bash"), true);
	});
});

describe("assembleBrigadeToolset — toolPolicy enforcement at the assembly site", () => {
	it("allow narrows the assembled toolset to (allow ∪ alsoAllow) only", () => {
		// `read` is a Pi builtin; `recall_memory` is a Brigade-native tool —
		// both are in the default surface, so this proves the filter spans
		// builtins AND custom tools.
		const ts = assembleBrigadeToolset({
			workspaceDir: workspace,
			agentId: "main",
			cwd: workspace,
			toolPolicy: { allow: ["read"], alsoAllow: ["recall_memory"] },
		});
		assert.deepEqual(ts.builtinToolNames, ["read"]);
		assert.deepEqual(ts.brigadeToolNames, ["recall_memory"]);
		assert.deepEqual(ts.enabledToolNames.sort(), ["read", "recall_memory"]);
		// customTools is narrowed in lockstep with the names.
		assert.deepEqual(ts.customTools.map((t) => t.name), ["recall_memory"]);
	});

	it("deny removes the named tool but keeps everything else", () => {
		const base = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		const denied = assembleBrigadeToolset({
			workspaceDir: workspace,
			agentId: "main",
			cwd: workspace,
			toolPolicy: { deny: ["bash"] },
		});
		// `bash` (a builtin) is gone…
		assert.equal(denied.builtinToolNames.includes("bash"), false);
		// …and the rest of the surface is exactly the unfiltered set minus bash.
		assert.deepEqual(
			denied.enabledToolNames.sort(),
			base.enabledToolNames.filter((n) => n !== "bash").sort(),
		);
	});

	it("no toolPolicy → toolset is byte-identical to the unfiltered surface", () => {
		const withUndefinedPolicy = assembleBrigadeToolset({
			workspaceDir: workspace,
			agentId: "main",
			cwd: workspace,
			toolPolicy: undefined,
		});
		const baseline = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		assert.deepEqual(withUndefinedPolicy.builtinToolNames, baseline.builtinToolNames);
		assert.deepEqual(withUndefinedPolicy.brigadeToolNames, baseline.brigadeToolNames);
		assert.deepEqual(withUndefinedPolicy.enabledToolNames, baseline.enabledToolNames);
		assert.equal(withUndefinedPolicy.customTools.length, baseline.customTools.length);
	});

	it("toolPolicy composes with the cron toolsAllow filter (both narrow; deny wins)", () => {
		// toolsAllow first clamps to {read, recall_memory, bash}; the policy then
		// denies bash and restricts to read — intersection minus deny = {read}.
		const ts = assembleBrigadeToolset({
			workspaceDir: workspace,
			agentId: "main",
			cwd: workspace,
			toolsAllow: ["read", "recall_memory", "bash"],
			toolPolicy: { allow: ["read", "bash"], deny: ["bash"] },
		});
		assert.deepEqual(ts.enabledToolNames, ["read"]);
		assert.deepEqual(ts.customTools.map((t) => t.name), []);
	});
});

describe("composeBrigadeBeforeToolCall — chain order + behavior", () => {
	const enabledToolNames = ["read", "write", "edit", "bash", "grep", "find", "ls", "recall_memory", "read_memory"];

	function makeChain(extra?: Parameters<typeof composeBrigadeBeforeToolCall>[0]["userBeforeHook"]) {
		return composeBrigadeBeforeToolCall({
			enabledToolNames,
			gateCtxRef: { value: { runId: "r1", agentId: "main", sessionKey: "k1" } },
			displayCwd: "/ws",
			...(extra ? { userBeforeHook: extra } : {}),
		});
	}

	it("unknown-tool guard blocks a hallucinated name", async () => {
		const chain = makeChain();
		const r = await chain({ toolCall: { name: "frobnicate", arguments: {} } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /not available/i);
	});

	it("exec-gate blocks an unapproved bash command", async () => {
		const chain = makeChain();
		const r = await chain({ toolCall: { name: "bash", arguments: { command: "ls -la" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /is not pre-approved/);
	});

	it("exec-gate allows an approved bash command", async () => {
		approvalsMod.recordApproval("ls -la", "exact");
		const chain = makeChain();
		const r = await chain({ toolCall: { name: "bash", arguments: { command: "ls -la" } } } as never);
		assert.equal(r, undefined);
	});

	it("memory tools pass through the gate (not shell, not unknown)", async () => {
		const chain = makeChain();
		const r = await chain({
			toolCall: { name: "recall_memory", arguments: { query: "x" } },
		} as never);
		assert.equal(r, undefined);
	});

	it("decodeArgs runs before the guards", async () => {
		let decoded = false;
		const chain = composeBrigadeBeforeToolCall({
			enabledToolNames,
			gateCtxRef: { value: {} },
			displayCwd: "/ws",
			decodeArgs: () => {
				decoded = true;
			},
		});
		await chain({ toolCall: { name: "read", arguments: { path: "x" } } } as never);
		assert.equal(decoded, true);
	});

	it("userBeforeHook runs only after built-in guards pass", async () => {
		let userHookRan = false;
		const chain = makeChain(async () => {
			userHookRan = true;
			return undefined;
		});
		// Allowed tool → guards pass → user hook runs.
		await chain({ toolCall: { name: "read", arguments: { path: "x" } } } as never);
		assert.equal(userHookRan, true);

		// Unknown tool → guard blocks → user hook must NOT run.
		userHookRan = false;
		await chain({ toolCall: { name: "nope", arguments: {} } } as never);
		assert.equal(userHookRan, false);
	});

	it("a throwing userBeforeHook fails closed (block)", async () => {
		const chain = makeChain(async () => {
			throw new Error("boom");
		});
		const r = await chain({ toolCall: { name: "read", arguments: { path: "x" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /policy hook error/);
	});
});

describe("resolveSpawnToolTimeoutMs — spawn tools escape the blanket 60s watchdog", () => {
	// Production failure (2026-06-11): spawn_agents awaits its children
	// (up to 300s each by contract) but the uniform 60s execution-timeout
	// wrapper killed every longer fan-out with "assume the call hung" while
	// the children kept running and announced later.
	it("defaults to the sub-agent child timeout + slack", () => {
		assert.equal(resolveSpawnToolTimeoutMs({}), 300_000 + 30_000);
		assert.equal(resolveSpawnToolTimeoutMs(undefined), 300_000 + 30_000);
	});

	it("honours the call's own per-child timeoutSeconds", () => {
		assert.equal(resolveSpawnToolTimeoutMs({ timeoutSeconds: 600 }), 600_000 + 30_000);
	});

	it("ignores invalid timeoutSeconds values", () => {
		assert.equal(resolveSpawnToolTimeoutMs({ timeoutSeconds: -5 }), 330_000);
		assert.equal(resolveSpawnToolTimeoutMs({ timeoutSeconds: "x" }), 330_000);
	});

	// Audit F4 (2026-06-11): spawn_agents carries timeoutSeconds PER-TASK, not
	// top-level. Reading only the top-level field left every spawn_agents call
	// on the 300s default, so a >300s task was still watchdog-killed at 330s.
	it("takes the MAX over spawn_agents tasks[].timeoutSeconds", () => {
		assert.equal(
			resolveSpawnToolTimeoutMs({ tasks: [{ timeoutSeconds: 120 }, { timeoutSeconds: 600 }] }),
			600_000 + 30_000,
		);
	});

	it("spawn_agents with no per-task timeout falls back to the default", () => {
		assert.equal(
			resolveSpawnToolTimeoutMs({ tasks: [{ prompt: "x" }, { prompt: "y" }] }),
			330_000,
		);
	});

	it("ignores invalid per-task timeouts and keeps the largest valid one", () => {
		assert.equal(
			resolveSpawnToolTimeoutMs({ tasks: [{ timeoutSeconds: -1 }, { timeoutSeconds: 450 }, { timeoutSeconds: "x" }] }),
			450_000 + 30_000,
		);
	});
});

describe("wrapToolExecutionTimeout — per-call budget resolver", () => {
	it("a slow tool survives when the resolver grants a bigger budget", async () => {
		const slowTool = {
			name: "spawn_agents",
			label: "t",
			description: "d",
			parameters: {} as never,
			execute: async () => {
				await new Promise((r) => setTimeout(r, 80));
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		// Static budget 30ms would kill it; resolver grants 5s.
		const wrapped = wrapToolExecutionTimeout(slowTool as never, 30, () => 5_000);
		const res = await wrapped.execute("id", {} as never);
		assert.equal((res.content[0] as { text: string }).text, "ok");
	});

	it("without a resolver the static budget still applies", async () => {
		const slowTool = {
			name: "x",
			label: "t",
			description: "d",
			parameters: {} as never,
			execute: async () => {
				await new Promise((r) => setTimeout(r, 200));
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		};
		const wrapped = wrapToolExecutionTimeout(slowTool as never, 30);
		await assert.rejects(() => wrapped.execute("id", {} as never), /did not return within/);
	});
});
