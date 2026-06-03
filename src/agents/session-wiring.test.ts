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

const { assembleBrigadeToolset, composeBrigadeBeforeToolCall } = await import("./session-wiring.js");
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
	it("returns 7 builtins + 3 memory tools + agents_list + manage_agent + manage_skill = 13 enabled names", () => {
		const ts = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		assert.deepEqual(ts.builtinToolNames, ["read", "write", "edit", "bash", "grep", "find", "ls"]);
		assert.deepEqual(ts.brigadeToolNames.sort(), [
			"agents_list",
			"manage_agent",
			"manage_skill",
			"read_memory",
			"recall_memory",
			"write_memory",
		]);
		assert.equal(ts.enabledToolNames.length, 13);
		assert.equal(ts.customTools.length, 6);
	});

	it("derives capabilities.memory=true when recall_memory present", () => {
		const ts = assembleBrigadeToolset({ workspaceDir: workspace, agentId: "main", cwd: workspace });
		assert.equal(ts.capabilities.memory, true);
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
