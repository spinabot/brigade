import assert from "node:assert/strict";
import { test } from "node:test";

import { createMcpServer, MCP_PROTOCOL_VERSION, type McpServerTool } from "./protocol.js";

function fixtureTools(log: string[] = []): McpServerTool[] {
	return [
		{
			name: "echo",
			description: "echo back",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			handler: async (args) => ({ content: [{ type: "text", text: String(args.text ?? "") }] }),
		},
		{
			name: "sync_tool",
			description: "a synchronous handler still works",
			inputSchema: { type: "object", properties: {} },
			handler: () => ({ content: [{ type: "text", text: "sync-ok" }] }),
		},
		{
			name: "boom",
			description: "throws",
			inputSchema: { type: "object", properties: {} },
			handler: async () => {
				throw new Error("kaboom");
			},
		},
		{
			name: "watches_signal",
			description: "records whether it saw an abort signal",
			inputSchema: { type: "object", properties: {} },
			handler: async (_args, signal) => {
				log.push(signal?.aborted ? "aborted" : "live");
				return { content: [{ type: "text", text: "ok" }] };
			},
		},
	];
}

const req = (method: string, params?: unknown, id: string | number | null = 1) => ({ jsonrpc: "2.0" as const, id, method, params });

test("initialize returns protocol version + serverInfo", async () => {
	const s = createMcpServer(fixtureTools(), { serverName: "brigade", serverVersion: "9.9" });
	const res = await s.handle(req("initialize"));
	assert.equal((res?.result as any).protocolVersion, MCP_PROTOCOL_VERSION);
	assert.equal((res?.result as any).serverInfo.name, "brigade");
	assert.deepEqual((res?.result as any).capabilities, { tools: {} });
});

test("tools/list enumerates name/description/inputSchema", async () => {
	const s = createMcpServer(fixtureTools());
	const res = await s.handle(req("tools/list"));
	const names = (res?.result as any).tools.map((t: any) => t.name);
	assert.deepEqual(names, ["echo", "sync_tool", "boom", "watches_signal"]);
	assert.equal((res?.result as any).tools[0].inputSchema.required[0], "text");
});

test("tools/call runs an async handler and returns content", async () => {
	const s = createMcpServer(fixtureTools());
	const res = await s.handle(req("tools/call", { name: "echo", arguments: { text: "hi" } }));
	assert.deepEqual((res?.result as any).content, [{ type: "text", text: "hi" }]);
});

test("tools/call supports a synchronous handler too", async () => {
	const s = createMcpServer(fixtureTools());
	const res = await s.handle(req("tools/call", { name: "sync_tool", arguments: {} }));
	assert.equal((res?.result as any).content[0].text, "sync-ok");
});

test("tools/call: a throwing handler becomes a -32603 error, never crashes handle()", async () => {
	const s = createMcpServer(fixtureTools());
	const res = await s.handle(req("tools/call", { name: "boom", arguments: {} }));
	assert.equal(res?.error?.code, -32603);
	assert.match(res?.error?.message ?? "", /kaboom/);
});

test("tools/call: unknown tool → -32602", async () => {
	const s = createMcpServer(fixtureTools());
	const res = await s.handle(req("tools/call", { name: "nope" }));
	assert.equal(res?.error?.code, -32602);
});

test("tools/call threads the AbortSignal to the handler", async () => {
	const log: string[] = [];
	const s = createMcpServer(fixtureTools(log));
	const ac = new AbortController();
	ac.abort();
	await s.handle(req("tools/call", { name: "watches_signal", arguments: {} }), ac.signal);
	assert.deepEqual(log, ["aborted"]);
});

test("notifications get no reply; unknown method → -32601; malformed method with id → -32600", async () => {
	const s = createMcpServer(fixtureTools());
	assert.equal(await s.handle(req("notifications/initialized", undefined, null) as any), null);
	// a true notification has no id at all
	assert.equal(await s.handle({ jsonrpc: "2.0", method: "ping" } as any), null);
	assert.equal((await s.handle(req("does/not/exist")))?.error?.code, -32601);
	assert.equal((await s.handle({ jsonrpc: "2.0", id: 5 } as any))?.error?.code, -32600);
});
