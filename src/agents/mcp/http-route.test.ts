import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import { createMcpHttpRoute } from "./http-route.js";
import { createMcpTurnRegistry, type McpTurnContext } from "./tool-plane-host.js";
import type { AnyBrigadeTool } from "../tools/types.js";

function fakeReq(over: { method?: string; url?: string; body?: unknown; remote?: string }) {
	return {
		method: over.method ?? "POST",
		url: over.url ?? "/mcp/x",
		socket: { remoteAddress: over.remote ?? "127.0.0.1" },
		headers: { "content-type": "application/json" },
		body: over.body !== undefined ? Buffer.from(JSON.stringify(over.body)) : undefined,
	} as never;
}

function fakeRes() {
	const state: { statusCode: number; headers: Record<string, string>; body: string } = {
		statusCode: 0,
		headers: {},
		body: "",
	};
	const res = {
		set statusCode(v: number) {
			state.statusCode = v;
		},
		get statusCode() {
			return state.statusCode;
		},
		setHeader(k: string, v: string) {
			state.headers[k.toLowerCase()] = v;
		},
		end(s?: string) {
			if (s) state.body = s;
		},
	};
	return { res: res as never, state };
}

function echoTool(calls: string[]): AnyBrigadeTool {
	return {
		name: "echo",
		label: "echo",
		description: "echo",
		parameters: Type.Object({ text: Type.Optional(Type.String()) }),
		execute: async (_id: string, params: any) => {
			calls.push(params?.text ?? "");
			return { content: [{ type: "text", text: `echo:${params?.text ?? ""}` }], details: undefined };
		},
	} as AnyBrigadeTool;
}

function registerTurn(over: Partial<McpTurnContext> = {}) {
	const registry = createMcpTurnRegistry();
	const reg = registry.register({ customTools: [], guard: async () => undefined, agentId: "main", ...over });
	return { registry, token: reg.token, reg };
}

test("POST tools/call on a valid token runs the tool and returns JSON-RPC", async () => {
	const calls: string[] = [];
	const { registry, token } = registerTurn({ customTools: [echoTool(calls)] });
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(
		fakeReq({
			url: `/mcp/${token}`,
			body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
		}),
		res,
	);
	assert.equal(state.statusCode, 200);
	assert.equal(JSON.parse(state.body).result.content[0].text, "echo:hi");
	assert.deepEqual(calls, ["hi"]);
});

test("unknown token → 404 (no oracle)", async () => {
	const { registry } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(fakeReq({ url: "/mcp/deadbeef", body: { jsonrpc: "2.0", id: 1, method: "ping" } }), res);
	assert.equal(state.statusCode, 404);
});

test("disposed token stops resolving (turn ended)", async () => {
	const { registry, token, reg } = registerTurn();
	reg.dispose();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", id: 1, method: "ping" } }), res);
	assert.equal(state.statusCode, 404);
});

test("non-loopback caller → 401", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(
		fakeReq({ url: `/mcp/${token}`, remote: "8.8.8.8", body: { jsonrpc: "2.0", id: 1, method: "ping" } }),
		res,
	);
	assert.equal(state.statusCode, 401);
});

test("GET (server→client SSE) → 405; we never push", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(fakeReq({ method: "GET", url: `/mcp/${token}` }), res);
	assert.equal(state.statusCode, 405);
});

test("notification (no id) → 202 no body", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	await (route.handler as any)(
		fakeReq({ url: `/mcp/${token}`, body: { jsonrpc: "2.0", method: "notifications/initialized" } }),
		res,
	);
	assert.equal(state.statusCode, 202);
	assert.equal(state.body, "");
});

test("malformed JSON body → -32700 parse error", async () => {
	const { registry, token } = registerTurn();
	const route = createMcpHttpRoute(registry);
	const { res, state } = fakeRes();
	const req = fakeReq({ url: `/mcp/${token}` });
	(req as any).body = Buffer.from("{not json");
	await (route.handler as any)(req, res);
	assert.equal(state.statusCode, 400);
	assert.equal(JSON.parse(state.body).error.code, -32700);
});
