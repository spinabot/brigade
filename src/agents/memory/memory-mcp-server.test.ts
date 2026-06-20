import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createMemoryMcpServer, MCP_PROTOCOL_VERSION, type JsonRpcRequest, runMemoryMcpStdio } from "./memory-mcp-server.js";
import { Tideline } from "./tideline.js";

/** Tideline Step 23 — the MCP server dispatch (JSON-RPC over the memory tools). */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mcpsrv-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function server() {
	return createMemoryMcpServer(Tideline.open(dir), { origin: { kind: "owner" } });
}
const req = (id: number | null | undefined, method: string, params?: unknown): JsonRpcRequest =>
	({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) }) as JsonRpcRequest;

describe("memory-mcp-server dispatch", () => {
	it("initialize advertises the protocol + tools capability + serverInfo", () => {
		const res = server().handle(req(1, "initialize"));
		const r = res?.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
		assert.equal(r.protocolVersion, MCP_PROTOCOL_VERSION);
		assert.ok(r.capabilities.tools);
		assert.equal(r.serverInfo.name, "brigade-memory");
	});

	it("tools/list returns the three memory tools with schemas", () => {
		const s = server();
		assert.equal(s.toolCount, 3);
		const res = s.handle(req(2, "tools/list"));
		const tools = (res?.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools;
		assert.equal(tools.length, 3);
		assert.deepEqual(tools.map((t) => t.name).sort(), ["memory_add", "memory_context", "memory_search"]);
		assert.ok(tools.every((t) => t.inputSchema.type === "object"));
	});

	it("tools/call drives add → search round-trip", () => {
		const s = server();
		const add = s.handle(req(3, "tools/call", { name: "memory_add", arguments: { content: "I live in Pune", segment: "identity" } }));
		assert.equal((add?.result as { isError?: boolean }).isError, undefined);
		const found = s.handle(req(4, "tools/call", { name: "memory_search", arguments: { query: "where do I live" } }));
		const text = (found?.result as { content: Array<{ text: string }> }).content[0]!.text;
		assert.match(text, /Pune/);
	});

	it("a notification (notifications/initialized) gets NO response; ping replies", () => {
		const s = server();
		assert.equal(s.handle(req(undefined, "notifications/initialized")), null);
		assert.equal(s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "no-id notification → null");
		assert.deepEqual((s.handle(req(9, "ping")) as { result: unknown }).result, {});
	});

	it("unknown method → -32601; unknown tool → -32602", () => {
		const s = server();
		assert.equal(s.handle(req(5, "frobnicate"))?.error?.code, -32601);
		assert.equal(s.handle(req(6, "tools/call", { name: "nope", arguments: {} }))?.error?.code, -32602);
	});

	it("a malformed request (id but no method) returns Invalid Request (-32600) — never throws", () => {
		const s = server();
		// missing `method` entirely — used to throw TypeError on req.method.startsWith
		const res = s.handle({ jsonrpc: "2.0", id: 7 } as unknown as JsonRpcRequest);
		assert.equal(res?.error?.code, -32600, "addressable malformed request → Invalid Request");
		assert.equal(res?.id, 7, "the error is addressed to the request id");
		// non-string method
		assert.equal(s.handle({ jsonrpc: "2.0", id: 8, method: 42 } as unknown as JsonRpcRequest)?.error?.code, -32600);
		// malformed WITHOUT an id is un-addressable ⇒ dropped (null), still no throw
		assert.equal(s.handle({ jsonrpc: "2.0" } as unknown as JsonRpcRequest), null);
	});

	it("a stdin READ error resolves runMemoryMcpStdio instead of crashing + hanging", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const done = runMemoryMcpStdio(server(), { input, output });
		// Simulate a real stdin fd error (terminal disconnect / parent killed).
		input.destroy(new Error("stdin read failure"));
		const outcome = await Promise.race([
			done.then(() => "resolved"),
			new Promise((r) => setTimeout(() => r("timed-out"), 2000)),
		]);
		assert.equal(outcome, "resolved", "the run resolved on a stdin error (no uncaught crash, no hang)");
	});

	it("processes newline-delimited requests over a real stdio transport", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let buf = "";
		output.on("data", (c) => {
			buf += c.toString();
		});
		const done = runMemoryMcpStdio(server(), { input, output });
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
		input.write("not json — must be skipped, not crash\n");
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
		input.end();
		await done;
		assert.match(buf, /"id":1/, "tools/list answered");
		assert.match(buf, /"id":2/, "ping answered after a malformed line was safely skipped");
	});
});
