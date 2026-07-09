import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import { buildMcpTurnServer } from "./route.js";
import type { McpTurnContext } from "./tool-plane-host.js";
import type { AnyBrigadeTool } from "../tools/types.js";

// Minimal fake Brigade tool — records calls + returns text content.
function fakeTool(name: string, over: Partial<AnyBrigadeTool> = {}, calls: string[] = []): AnyBrigadeTool {
	return {
		name,
		label: name,
		description: `the ${name} tool`,
		parameters: Type.Object({ text: Type.Optional(Type.String()) }),
		execute: async (_callId: string, params: unknown) => {
			calls.push(`${name}:${JSON.stringify(params)}`);
			return { content: [{ type: "text", text: `${name} ran` }], details: undefined };
		},
		...over,
	} as AnyBrigadeTool;
}

const req = (method: string, params?: unknown, id: string | number = 1) => ({ jsonrpc: "2.0" as const, id, method, params });

function turn(over: Partial<McpTurnContext>): McpTurnContext {
	return { customTools: [], guard: async () => undefined, agentId: "main", ...over };
}

test("tools/list surfaces the turn's tools with their schemas", async () => {
	const server = buildMcpTurnServer(turn({ customTools: [fakeTool("write_memory"), fakeTool("spawn_agent")] }));
	const res = await server.handle(req("tools/list"));
	const names = (res?.result as any).tools.map((t: any) => t.name);
	assert.deepEqual(names, ["write_memory", "spawn_agent"]);
	assert.equal((res?.result as any).tools[0].inputSchema.type, "object");
});

test("tools/call runs the guard THEN execute, returns content", async () => {
	const order: string[] = [];
	const calls: string[] = [];
	const tool = fakeTool("write_memory", {}, calls);
	const guard = async (ctx: any) => {
		order.push(`guard:${ctx.toolCall.name}`);
		return undefined; // pass
	};
	const server = buildMcpTurnServer(turn({ customTools: [tool], guard }));
	const res = await server.handle(req("tools/call", { name: "write_memory", arguments: { text: "hi" } }));
	assert.equal((res?.result as any).content[0].text, "write_memory ran");
	assert.equal((res?.result as any).isError, undefined);
	assert.deepEqual(order, ["guard:write_memory"]);
	assert.deepEqual(calls, ['write_memory:{"text":"hi"}'], "execute got the args");
});

test("guard BLOCK short-circuits — execute never runs, reason surfaces as isError", async () => {
	const calls: string[] = [];
	const tool = fakeTool("bash", {}, calls);
	const guard = async () => ({ block: true as const, reason: "Command needs approval." });
	const server = buildMcpTurnServer(turn({ customTools: [tool], guard }));
	const res = await server.handle(req("tools/call", { name: "bash", arguments: { command: "rm -rf /" } }));
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /needs approval/);
	assert.deepEqual(calls, [], "execute must NOT run when the guard blocks");
});

test("ownerOnly refusal (execute throws) surfaces as isError with the message", async () => {
	const tool = fakeTool("manage_provider", {
		execute: async () => {
			throw new Error("Tool restricted to the workspace owner.");
		},
	});
	const server = buildMcpTurnServer(turn({ customTools: [tool] }));
	const res = await server.handle(req("tools/call", { name: "manage_provider", arguments: {} }));
	assert.equal((res?.result as any).isError, true);
	assert.match((res?.result as any).content[0].text, /restricted to the workspace owner/);
});

test("the abort signal threads into BOTH guard and execute", async () => {
	const seen: Record<string, boolean> = {};
	const tool = fakeTool("slow", {
		execute: async (_id: string, _p: unknown, signal?: AbortSignal) => {
			seen.execute = !!signal?.aborted;
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	});
	const guard = async (_ctx: any, signal?: AbortSignal) => {
		seen.guard = !!signal?.aborted;
		return undefined;
	};
	const server = buildMcpTurnServer(turn({ customTools: [tool], guard }));
	const ac = new AbortController();
	ac.abort();
	await server.handle(req("tools/call", { name: "slow", arguments: {} }), ac.signal);
	assert.deepEqual(seen, { guard: true, execute: true });
});

test("a tool not in the turn's set is unknown (-32602), never fabricated", async () => {
	const server = buildMcpTurnServer(turn({ customTools: [fakeTool("write_memory")] }));
	const res = await server.handle(req("tools/call", { name: "send_message", arguments: {} }));
	assert.equal(res?.error?.code, -32602);
});
