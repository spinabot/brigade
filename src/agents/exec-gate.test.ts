import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, beforeEach, describe, it } from "node:test";

// Repoint HOME at a per-test-file tempdir BEFORE the under-test modules
// resolve `BRIGADE_DIR` (which they pin at import time). exec-approvals
// reads/writes `<HOME>/.brigade/exec-approvals.json`; without this the
// gate tests would clobber the operator's real allowlist.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-exec-gate-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalBrigadeHome = process.env.BRIGADE_HOME;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
delete process.env.BRIGADE_HOME;

const { decideApproval: _ensureLoaded, recordApproval, getApprovalsFilePath, _resetApprovalsCacheForTests } =
	await import("../core/exec-approvals.js");
// Marker reference so eslint doesn't complain about unused import.
void _ensureLoaded;

const { makeExecGate } = await import("./exec-gate.js");
const { setExecAllowAll, isExecAllowAll, clearExecAllowAllForTests } = await import("./exec-session-allow.js");
const busMod = await import("./agent-event-bus.js");
const approvalBridgeMod = await import("./approval-bridge.js");

before(() => {
	process.on("exit", () => {
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
		else delete process.env.USERPROFILE;
		if (originalBrigadeHome !== undefined) process.env.BRIGADE_HOME = originalBrigadeHome;
		else delete process.env.BRIGADE_HOME;
		try {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});
});

beforeEach(() => {
	_resetApprovalsCacheForTests();
	try {
		fs.rmSync(getApprovalsFilePath(), { force: true });
	} catch {
		/* ignore */
	}
});

describe("makeExecGate — basic bash decisions", () => {
	it("returns undefined for non-shell tools (read / grep / find / ls / write / edit)", async () => {
		const gate = makeExecGate();
		for (const toolName of ["read", "grep", "find", "ls", "write", "edit"]) {
			const r = await gate({
				toolCall: { name: toolName, arguments: { path: "/anywhere" } },
			} as never);
			assert.equal(r, undefined, `${toolName} should pass through (not shell-gated)`);
		}
	});

	it('BLOCKS bash with a "prompt" decision (command not on allowlist)', async () => {
		const gate = makeExecGate();
		const r = await gate({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /is not pre-approved/);
		assert.match(r?.reason ?? "", /Do NOT retry with shell variants/);
	});

	it('BLOCKS bash with a "deny" decision (hard-deny pattern)', async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "rm -rf /" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /hard-deny pattern/);
	});

	it("ALLOWS bash when the command is on the exec-approvals allowlist", async () => {
		recordApproval("ls -la", "exact");
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls -la" } },
		} as never);
		assert.equal(r, undefined);
	});

	it("ALLOWS bash via pattern allowlist", async () => {
		recordApproval("^git (status|diff)( |$)", "pattern");
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "git status" } },
		} as never);
		assert.equal(r, undefined);
	});

	it("BLOCKS bash with empty command (treated as prompt)", async () => {
		const gate = makeExecGate();
		const r = await gate({ toolCall: { name: "bash", arguments: { command: "" } } } as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /is not pre-approved/);
	});

	it("accepts bash command under 'cmd' or 'script' fallback arg key (provider variation)", async () => {
		recordApproval("echo hi", "exact");
		const gate = makeExecGate();
		const a = await gate({ toolCall: { name: "bash", arguments: { cmd: "echo hi" } } } as never);
		assert.equal(a, undefined);
		const b = await gate({ toolCall: { name: "bash", arguments: { script: "echo hi" } } } as never);
		assert.equal(b, undefined);
	});

	it("trims whitespace from tool name (defence in depth)", async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "  bash  ", arguments: { command: "ls" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /is not pre-approved/);
	});
});

describe("makeExecGate — session allow-all (point 4)", () => {
	const SESSION = "agent:main:main";
	const gateFor = (sessionKey: string) =>
		makeExecGate({ ctxRef: { value: { sessionKey } } });

	beforeEach(() => clearExecAllowAllForTests());

	it("waives the approval PROMPT for an armed session (a would-be prompt now passes)", async () => {
		setExecAllowAll(SESSION, true);
		const r = await gateFor(SESSION)({
			toolCall: { name: "bash", arguments: { command: "node oauth.mjs" } },
		} as never);
		assert.equal(r, undefined, "armed session should pass a prompt-decision command");
	});

	it("does NOT waive a hard-deny pattern even when armed", async () => {
		setExecAllowAll(SESSION, true);
		const r = await gateFor(SESSION)({
			toolCall: { name: "bash", arguments: { command: "rm -rf /" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /hard-deny pattern/);
	});

	it("does NOT waive a workdir / env hijack even when armed", async () => {
		setExecAllowAll(SESSION, true);
		const wd = await gateFor(SESSION)({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: "/etc" } },
		} as never);
		assert.equal(wd?.block, true);
		assert.match(wd?.reason ?? "", /override .* is not allowed/);
		const env = await gateFor(SESSION)({
			toolCall: { name: "bash", arguments: { command: "ls", env: { LD_PRELOAD: "/tmp/x" } } },
		} as never);
		assert.equal(env?.block, true);
		assert.match(env?.reason ?? "", /env` override is not allowed/);
	});

	it("does NOT cascade to other sessions (sub-agents run distinct keys)", async () => {
		setExecAllowAll(SESSION, true);
		const child = await gateFor("agent:main:main:subagent:abc")({
			toolCall: { name: "bash", arguments: { command: "node oauth.mjs" } },
		} as never);
		assert.equal(child?.block, true, "an un-armed (child) session still prompts");
		assert.match(child?.reason ?? "", /is not pre-approved/);
	});

	it("disarming restores the prompt", async () => {
		setExecAllowAll(SESSION, true);
		setExecAllowAll(SESSION, false);
		const r = await gateFor(SESSION)({
			toolCall: { name: "bash", arguments: { command: "node oauth.mjs" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /is not pre-approved/);
	});

	it("the prompt's 'allow-session' decision allows the call AND arms the session", async () => {
		// Operator picked [S] in the approval prompt. The gate must allow THIS
		// call and arm allow-all so the NEXT command skips the prompt entirely.
		approvalBridgeMod.setActiveApprovalBridge({
			requestApproval: async () => ({ kind: "allow-session" as const }),
			resolveApproval: () => true,
			listPending: () => [],
		});
		try {
			const first = await gateFor(SESSION)({
				toolCall: { name: "bash", arguments: { command: "node oauth.mjs" } },
			} as never);
			assert.equal(first, undefined, "the call that chose allow-session is allowed");
			assert.equal(isExecAllowAll(SESSION), true, "session is now armed");
			// A SECOND command on the same session passes with NO bridge call.
			approvalBridgeMod.setActiveApprovalBridge({
				requestApproval: async () => {
					throw new Error("bridge should not be consulted once armed");
				},
				resolveApproval: () => true,
				listPending: () => [],
			});
			const second = await gateFor(SESSION)({
				toolCall: { name: "bash", arguments: { command: "ls -la /tmp" } },
			} as never);
			assert.equal(second, undefined, "subsequent command skips the prompt");
		} finally {
			approvalBridgeMod.setActiveApprovalBridge(null);
		}
	});
});

describe("makeExecGate — exec-gated tool name aliases", () => {
	it("gates 'exec', 'shell', 'sh' the same way as 'bash'", async () => {
		const gate = makeExecGate();
		for (const toolName of ["exec", "shell", "sh"]) {
			const r = await gate({
				toolCall: { name: toolName, arguments: { command: "ls" } },
			} as never);
			assert.equal(r?.block, true, `${toolName} should be gated`);
			assert.match(r?.reason ?? "", /is not pre-approved/);
		}
	});

	it('"Bash" / "SHELL" / "Exec" (case-insensitive) all trip the gate', async () => {
		const gate = makeExecGate();
		for (const toolName of ["Bash", "BASH", "SHELL", "Exec", "SH"]) {
			const r = await gate({
				toolCall: { name: toolName, arguments: { command: "ls" } },
			} as never);
			assert.equal(r?.block, true, `${toolName} should be gated`);
		}
	});
});

describe("makeExecGate — workdir / cwd refusal", () => {
	it("refuses bash with a non-empty `workdir` even when the command is allowlisted", async () => {
		recordApproval("ls -la", "exact");
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls -la", workdir: "/etc" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /override .* is not allowed/);
		assert.match(r?.reason ?? "", /\/etc/);
	});

	it("refuses bash with a non-empty `cwd` (provider alias for workdir)", async () => {
		recordApproval("ls", "exact");
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls", cwd: "/tmp/elsewhere" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /workdir|cwd/);
	});

	it("allows bash when `workdir` is empty / whitespace-only", async () => {
		recordApproval("ls", "exact");
		const gate = makeExecGate();
		const a = await gate({ toolCall: { name: "bash", arguments: { command: "ls", workdir: "" } } } as never);
		assert.equal(a, undefined);
		const b = await gate({ toolCall: { name: "bash", arguments: { command: "ls", workdir: "  " } } } as never);
		assert.equal(b, undefined);
	});

	it("refuses non-string workdir (number / object / boolean)", async () => {
		recordApproval("ls", "exact");
		const gate = makeExecGate();
		for (const w of [42, { x: 1 }, true]) {
			const r = await gate({
				toolCall: { name: "bash", arguments: { command: "ls", workdir: w } },
			} as never);
			assert.equal(r?.block, true, `workdir=${JSON.stringify(w)} should refuse`);
		}
	});

	it("both workdir and cwd set — workdir takes precedence in the message", async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: "/etc", cwd: "/tmp" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /workdir.*"\/etc"/);
	});

	it("displayCwd option is reflected in the workdir-refusal message", async () => {
		recordApproval("ls", "exact");
		const gate = makeExecGate({ displayCwd: "/home/op/.brigade/workspace" });
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls", workdir: "/etc" } },
		} as never);
		assert.match(r?.reason ?? "", /\/home\/op\/\.brigade\/workspace/);
	});
});

describe("makeExecGate — env refusal", () => {
	it("refuses bash with a non-empty env object (env hijack defence)", async () => {
		recordApproval("git status", "exact");
		const gate = makeExecGate();
		const r = await gate({
			toolCall: {
				name: "bash",
				arguments: { command: "git status", env: { GIT_SSH_COMMAND: "/tmp/evil" } },
			},
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /env.*override.*not allowed/i);
		assert.match(r?.reason ?? "", /GIT_SSH_COMMAND|LD_PRELOAD/);
	});

	it("allows bash when env is an empty object (same as no env)", async () => {
		recordApproval("ls", "exact");
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls", env: {} } },
		} as never);
		assert.equal(r, undefined);
	});

	it("refuses non-object env (number / array)", async () => {
		recordApproval("ls", "exact");
		const gate = makeExecGate();
		const r1 = await gate({
			toolCall: { name: "bash", arguments: { command: "ls", env: 42 } },
		} as never);
		assert.equal(r1?.block, true);
		const r2 = await gate({
			toolCall: { name: "bash", arguments: { command: "ls", env: ["FOO=bar"] } },
		} as never);
		assert.equal(r2?.block, true);
	});
});

describe("makeExecGate — non-string command argument", () => {
	it("rejects bash({command: array}) with 'an array, not a string' message", async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: ["ls", "-la"] } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /command.*argument.*an array.*not a string/i);
		// Must not leak the misleading "(empty command)" placeholder.
		assert.doesNotMatch(r?.reason ?? "", /\(empty command\)/);
	});

	it("rejects bash({command: 42}) with 'a number' message", async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: 42 } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /number.*not a string/i);
	});

	it("rejects bash({command: {nested: true}}) with 'an object' message", async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: { nested: true } } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /object.*not a string/i);
	});

	it("bash({command: null}) routes gracefully (treated as empty)", async () => {
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: null } },
		} as never);
		assert.equal(r?.block, true);
	});
});

describe("makeExecGate — tool-blocked bus events", () => {
	beforeEach(() => {
		busMod.__resetAgentBusForTests();
	});

	it("emits tool-blocked for an unapproved bash with runId+agentId from ctxRef", async () => {
		const observed: Array<{ toolName: string; reason: string; runId: string; agentId: string }> = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") {
				observed.push({ toolName: e.toolName, reason: e.reason, runId: e.runId, agentId: e.agentId });
			}
		});
		const ctxRef = { value: { runId: "turn-42", agentId: "main" } };
		const gate = makeExecGate({ ctxRef });
		await gate({ toolCall: { name: "bash", arguments: { command: "ls -la" } } } as never);
		assert.equal(observed.length, 1);
		assert.equal(observed[0]?.toolName, "bash");
		assert.equal(observed[0]?.runId, "turn-42");
		assert.equal(observed[0]?.agentId, "main");
		assert.match(observed[0]?.reason ?? "", /is not pre-approved/);
	});

	it("emits tool-blocked for hard-deny", async () => {
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const gate = makeExecGate();
		await gate({ toolCall: { name: "bash", arguments: { command: "rm -rf /" } } } as never);
		assert.equal(observed.length, 1);
		assert.match(observed[0] ?? "", /hard-deny pattern/);
	});

	it("emits tool-blocked for workdir refusal", async () => {
		recordApproval("ls", "exact");
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const gate = makeExecGate();
		await gate({ toolCall: { name: "bash", arguments: { command: "ls", workdir: "/etc" } } } as never);
		assert.equal(observed.length, 1);
		assert.match(observed[0] ?? "", /workdir/);
	});

	it("emits tool-blocked for env refusal", async () => {
		recordApproval("ls", "exact");
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const gate = makeExecGate();
		await gate({
			toolCall: { name: "bash", arguments: { command: "ls", env: { FOO: "bar" } } },
		} as never);
		assert.equal(observed.length, 1);
		assert.match(observed[0] ?? "", /env/i);
	});

	it("uses empty-string runId/agentId when no ctxRef supplied (back-compat)", async () => {
		const observed: Array<{ runId: string; agentId: string }> = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push({ runId: e.runId, agentId: e.agentId });
		});
		const gate = makeExecGate();
		await gate({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(observed.length, 1);
		assert.equal(observed[0]?.runId, "");
		assert.equal(observed[0]?.agentId, "");
	});

	it("does NOT emit tool-blocked for an allowed bash call", async () => {
		recordApproval("ls", "exact");
		const observed: string[] = [];
		busMod.onAgentEvent((e) => {
			if (e.type === "tool-blocked") observed.push(e.reason);
		});
		const gate = makeExecGate();
		const r = await gate({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r, undefined);
		assert.equal(observed.length, 0);
	});

	it("throwing listener does NOT crash the gate (block result still returned)", async () => {
		const originalWarning = process.emitWarning;
		process.emitWarning = (() => {}) as never;
		try {
			busMod.onAgentEvent(() => {
				throw new Error("boom");
			});
			const gate = makeExecGate();
			const r = await gate({
				toolCall: { name: "bash", arguments: { command: "ls" } },
			} as never);
			assert.equal(r?.block, true);
			assert.match(r?.reason ?? "", /is not pre-approved/);
		} finally {
			process.emitWarning = originalWarning;
		}
	});
});

describe("makeExecGate — Wave K operator attribution", () => {
	beforeEach(() => {
		approvalBridgeMod.setActiveApprovalBridge(null);
	});

	it("forwards agentId + sessionId (from ctxRef.sessionKey) to bridge.requestApproval", async () => {
		const seen: Array<{ agentId?: string; sessionId?: string; subagentLabel?: string }> = [];
		approvalBridgeMod.setActiveApprovalBridge({
			requestApproval: async (req) => {
				seen.push({
					agentId: req.agentId,
					sessionId: req.sessionId,
					subagentLabel: req.subagentLabel,
				});
				return { kind: "allow-once" };
			},
			resolveApproval: () => false,
			listPending: () => [],
		});
		const ctxRef = {
			value: {
				runId: "turn-77",
				agentId: "ops",
				sessionKey: "agent:ops:main",
			},
		};
		const gate = makeExecGate({ ctxRef });
		const r = await gate({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(r, undefined, "operator allowed once → gate passes through");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.agentId, "ops");
		assert.equal(seen[0]?.sessionId, "agent:ops:main");
	});

	it("omits agentId + sessionId when ctxRef has neither (back-compat)", async () => {
		const seen: Array<{ agentId?: string; sessionId?: string }> = [];
		approvalBridgeMod.setActiveApprovalBridge({
			requestApproval: async (req) => {
				seen.push({ agentId: req.agentId, sessionId: req.sessionId });
				return { kind: "allow-once" };
			},
			resolveApproval: () => false,
			listPending: () => [],
		});
		const gate = makeExecGate();
		await gate({ toolCall: { name: "bash", arguments: { command: "ls" } } } as never);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.agentId, undefined);
		assert.equal(seen[0]?.sessionId, undefined);
	});
});

describe("makeExecGate — schema-version-error passthrough", () => {
	it("decideApproval throwing version-error → gate refuses tool call with a remediation reason", async () => {
		// Plant a future-version file. decideApproval will throw on first read.
		fs.mkdirSync(path.dirname(getApprovalsFilePath()), { recursive: true });
		fs.writeFileSync(
			getApprovalsFilePath(),
			JSON.stringify({ version: 99, commands: [] }, null, 2),
			"utf8",
		);
		const future = new Date(Date.now() + 100);
		fs.utimesSync(getApprovalsFilePath(), future, future);
		_resetApprovalsCacheForTests();
		const gate = makeExecGate();
		const r = await gate({
			toolCall: { name: "bash", arguments: { command: "ls" } },
		} as never);
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /schema version/);
		assert.match(r?.reason ?? "", /upgrade Brigade/);
	});
});
