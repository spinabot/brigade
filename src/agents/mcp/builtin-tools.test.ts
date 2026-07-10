import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { createGuardedBuiltinTools } from "./builtin-tools.js";
import { buildMcpTurnServer } from "./route.js";
import type { McpTurnContext } from "./tool-plane-host.js";

const CWD = tmpdir();

test("returns Pi's builtins as callable objects, filtered to the turn's allowlist", () => {
	const tools = createGuardedBuiltinTools({ cwd: CWD, allow: ["read", "write", "edit", "bash", "grep", "ls"] });
	const names = tools.map((t) => t.name).sort();
	assert.deepEqual(names, ["bash", "edit", "grep", "ls", "read", "write"]);
	for (const t of tools) assert.equal(typeof t.execute, "function", `${t.name} must be callable`);
});

test("never exposes a builtin the turn withheld (policy/cron toolsAllow honoured)", () => {
	const tools = createGuardedBuiltinTools({ cwd: CWD, allow: ["read", "grep"] });
	assert.deepEqual(tools.map((t) => t.name).sort(), ["grep", "read"]);
	// `find` is a Pi tool Brigade never enables — it must not leak in.
	assert.ok(!tools.some((t) => t.name === "find"));
});

test("empty allowlist or missing cwd yields nothing (fail-closed, never throws)", () => {
	assert.deepEqual(createGuardedBuiltinTools({ cwd: CWD, allow: [] }), []);
	assert.deepEqual(createGuardedBuiltinTools({ cwd: "", allow: ["bash"] }), []);
});

/* ── the security-critical property: a builtin served over MCP is still guarded ── */

test("bash over the tool-plane runs the guard FIRST and a block prevents execution", async () => {
	const [bash] = createGuardedBuiltinTools({ cwd: CWD, allow: ["bash"] });
	assert.ok(bash, "bash tool constructed");

	const seen: string[] = [];
	const turn: McpTurnContext = {
		customTools: [bash],
		// stand-in for the turn's real composed chain (exec-gate lives inside it)
		guard: async (ctx: any) => {
			seen.push(`guard:${ctx.toolCall.name}`);
			return { block: true as const, reason: "Command needs approval." };
		},
		agentId: "main",
	};

	const server = buildMcpTurnServer(turn);
	const res = await server.handle({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: "bash", arguments: { command: "rm -rf /" } },
	});

	assert.deepEqual(seen, ["guard:bash"], "guard consulted before execute");
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /needs approval/);
});

test("builtins are advertised in tools/list alongside the native tools", async () => {
	const builtins = createGuardedBuiltinTools({ cwd: CWD, allow: ["read", "bash"] });
	const turn: McpTurnContext = { customTools: builtins, guard: async () => undefined, agentId: "main" };
	const res = await buildMcpTurnServer(turn).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
	const names = (res?.result as any).tools.map((t: any) => t.name).sort();
	assert.deepEqual(names, ["bash", "read"]);
	// each carries a JSON-Schema inputSchema the binary can consume
	for (const t of (res?.result as any).tools) assert.equal(t.inputSchema.type, "object");
});
