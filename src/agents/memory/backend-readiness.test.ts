import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { __resetFactsCacheForTests, awaitFactsFlush, FactsHydrationError } from "../../storage/facts-cache.js";
import { __resetRuntimeContextForTests, createRuntimeContext, setRuntimeContext } from "../../storage/runtime-context.js";
import type { BrigadeStore } from "../../storage/store.js";
import { makeWriteMemoryTool } from "../tools/memory-tools.js";
import { makeManageMemoryTool } from "../tools/manage-memory-tool.js";
import { buildAutoRecallBlock } from "./auto-recall.js";
import { __resetCursorCacheForTests, awaitCursorFlush, getCursor, runExtractionSweep } from "./extract.js";
import { createMemoryMcpServer, runMemoryMcpStdio } from "./memory-mcp-server.js";
import { createDefaultMemoryCapability } from "./plugin-runtime.js";
import { FactStore, type MemoryRecord } from "./records.js";
import { Tideline } from "./tideline.js";

let dir: string;
let previousStateDir: string | undefined;
const owner = { kind: "owner" } as const;
const workspace = (id: string) => path.join(dir, "agents", id, "workspace");

function fakeBackend() {
	const rows = new Map<string, Map<string, MemoryRecord>>();
	const cursors = new Map<string, number>();
	const failures = { read: false, write: false, remove: false, relationships: false };
	const store = { mode: "convex", init: async () => {}, memory: {
		listAllFactRecordsRaw: async (id: string) => {
			if (failures.read) throw new Error("read unavailable");
			return structuredClone([...rows.get(id)?.values() ?? []]);
		},
		upsertFactRecordRaw: async (id: string, row: MemoryRecord) => {
			if (failures.write || (failures.relationships && (row.links?.length ?? 0) > 0)) throw new Error("write unavailable");
			let bucket = rows.get(id);
			if (!bucket) { bucket = new Map(); rows.set(id, bucket); }
			bucket.set(row.memoryId, structuredClone(row));
		},
		deleteFactRecordRaw: async (id: string, memoryId: string) => {
			if (failures.remove) throw new Error("delete unavailable");
			rows.get(id)?.delete(memoryId);
		},
		getExtractCursor: async (session: string) => cursors.get(session) ?? 0,
		setExtractCursor: async (session: string, cursor: number) => { cursors.set(session, cursor); },
	} } as unknown as BrigadeStore;
	return { rows, cursors, failures, store };
}

beforeEach(() => {
	__resetFactsCacheForTests(); __resetRuntimeContextForTests(); __resetCursorCacheForTests();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-memory-readiness-"));
	previousStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
});
afterEach(async () => {
	await awaitFactsFlush().catch(() => {});
	await awaitCursorFlush();
	__resetFactsCacheForTests(); __resetRuntimeContextForTests(); __resetCursorCacheForTests();
	if (previousStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = previousStateDir;
	fs.rmSync(dir, { recursive: true, force: true });
});

test("production write/manage tools await cold hydration and reject undurable mutations", async () => {
	const fake = fakeBackend();
	setRuntimeContext(await createRuntimeContext({ store: fake.store, stateDir: dir }));
	const capability = createDefaultMemoryCapability({ workspaceDir: workspace("tools") });
	const tool = makeWriteMemoryTool(capability, { senderIsOwner: true });
	fake.failures.write = true;
	await assert.rejects(tool.execute("write", { content: "Quartz ledger uses amber envelopes.", segment: "knowledge" } as never), AggregateError);
	assert.equal(fake.rows.get("tools")?.size ?? 0, 0, "no success acknowledgement for optimistic-only state");
	fake.failures.write = false;
	const written = await tool.execute("retry", { content: "Quartz ledger uses amber envelopes.", segment: "knowledge" } as never);
	assert.equal(fake.rows.get("tools")?.size, 1, "retry persists one same-origin record");
	const id = written.details.memoryId;
	assert.ok(fake.rows.get("tools")?.has(id));
	fake.failures.remove = true;
	await assert.rejects(makeManageMemoryTool(workspace("tools")).execute("purge", { action: "purge", memory_id: id }), AggregateError);
	assert.ok(fake.rows.get("tools")?.has(id), "backend still contains a failed delete");
	fake.failures.remove = false;
	await capability.factStore.flush();
	assert.equal(fake.rows.get("tools")?.size, 0);
	assert.ok(!fs.existsSync(workspace("tools")), "no parallel filesystem memory");
});

test("auto-recall and capability status surface hydration failure and recover on a later call", async () => {
	const fake = fakeBackend();
	setRuntimeContext(await createRuntimeContext({ store: fake.store, stateDir: dir }));
	const capability = createDefaultMemoryCapability({ workspaceDir: workspace("recall") });
	fake.failures.read = true;
	await assert.rejects(buildAutoRecallBlock(capability, "quartz ledger", { origin: owner }), FactsHydrationError);
	await assert.rejects(capability.status!(), FactsHydrationError);
	fake.failures.read = false;
	await capability.recordFact("Quartz ledger uses amber envelopes.", { meta: { segment: "knowledge" } });
	__resetFactsCacheForTests();
	const block = await buildAutoRecallBlock(capability, "quartz ledger envelopes", { origin: owner });
	assert.match(block ?? "", /amber envelopes/);
	assert.equal(await buildAutoRecallBlock(capability, "quartz ledger", { origin: {
		kind: "channel", channelId: "test", conversationId: "room", sessionKey: "peer",
	} }), undefined);
});

test("extraction holds its cursor on failed persistence and a healthy workspace progresses independently", async () => {
	const fake = fakeBackend();
	setRuntimeContext(await createRuntimeContext({ store: fake.store, stateDir: dir }));
	const messages = [{ role: "user", content: "Quartz ledger uses amber envelopes." }, { role: "assistant", content: "Noted." }];
	const args = { workspaceDir: workspace("extract"), sessionId: "extract-session", messages, origin: owner,
		llm: async () => JSON.stringify({ facts: [{ content: "Quartz ledger uses amber envelopes.", segment: "knowledge" }] }) };
	fake.failures.write = true;
	assert.equal((await runExtractionSweep(args)).ran, false);
	assert.equal(getCursor(args.workspaceDir, args.sessionId), 0);
	assert.equal(fake.cursors.size, 0);
	fake.failures.write = false;
	const healthy = await runExtractionSweep({ ...args, workspaceDir: workspace("healthy"), sessionId: "healthy-session" });
	assert.equal(healthy.ran, true);
	assert.equal(getCursor(workspace("healthy"), "healthy-session"), 2);
	const retried = await runExtractionSweep(args);
	assert.equal(retried.ran, true);
	await awaitCursorFlush();
	assert.equal(fake.rows.get("extract")?.size, 1, "retry dedupes the retained optimistic record");
	assert.equal(fake.cursors.get("extract-session"), 2);
});

test("extraction does not advance past failed relationship writes", async () => {
	const fake = fakeBackend();
	setRuntimeContext(await createRuntimeContext({ store: fake.store, stateDir: dir }));
	const args = { workspaceDir: workspace("edges"), sessionId: "edge-session", origin: owner,
		messages: [{ role: "user", content: "The compiler needs strict types and the build requires Node." }, { role: "assistant", content: "Noted." }],
		llm: async () => JSON.stringify({ facts: [
			{ content: "The compiler requires strict types.", segment: "knowledge" },
			{ content: "The build requires a Node runtime.", segment: "knowledge" },
		], relationships: [{ a: "new:0", b: "new:1", type: "co_constrains", reason: "both build requirements", strength: 4 }] }),
	};
	fake.failures.relationships = true;
	assert.equal((await runExtractionSweep(args)).ran, false);
	assert.equal(getCursor(args.workspaceDir, args.sessionId), 0);
	assert.equal(fake.rows.get("edges")?.size, 2, "facts landed, but edges have not");
	assert.ok([...fake.rows.get("edges")!.values()].every((row) => (row.links?.length ?? 0) === 0));
	fake.failures.relationships = false;
	assert.equal((await runExtractionSweep(args)).ran, true);
	assert.ok([...fake.rows.get("edges")!.values()].every((row) => (row.links?.length ?? 0) > 0));
	assert.equal(getCursor(args.workspaceDir, args.sessionId), 2);
});

test("MCP stdio returns errors for failed durability and waits for successful writes before EOF completion", async () => {
	const fake = fakeBackend();
	setRuntimeContext(await createRuntimeContext({ store: fake.store, stateDir: dir }));
	const tide = Tideline.open(workspace("mcp"));
	const server = createMemoryMcpServer(tide, { origin: owner });
	const input = new PassThrough(); const output = new PassThrough();
	let text = "";
	output.on("data", (chunk: Buffer) => { text += chunk.toString(); });
	const done = runMemoryMcpStdio(server, { input, output });
	fake.failures.write = true;
	const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: {
		name: "memory_add", arguments: { content: "Quartz ledger uses amber envelopes.", segment: "knowledge" },
	} };
	input.write(`${JSON.stringify(request)}\n`);
	await new Promise<void>((resolve) => output.once("data", () => resolve()));
	const failed = JSON.parse(text) as { error?: { code: number }; result?: unknown };
	assert.equal(failed.error?.code, -32603);
	assert.equal(failed.result, undefined);
	assert.equal(fake.rows.get("mcp")?.size ?? 0, 0);
	fake.failures.write = false;
	input.end(`${JSON.stringify({ ...request, id: 2 })}\n`);
	await done;
	const replies = text.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result?: unknown; error?: unknown });
	assert.equal(replies.length, 2);
	assert.equal(replies[1]?.id, 2);
	assert.equal(replies[1]?.error, undefined);
	assert.ok(replies[1]?.result);
	assert.equal(fake.rows.get("mcp")?.size, 1);
	__resetFactsCacheForTests();
	const reopened = new FactStore(workspace("mcp"));
	await reopened.ready();
	assert.equal(reopened.readAll().length, 1);
});
