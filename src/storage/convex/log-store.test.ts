import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { ConvexLogStore } from "./log-store.js";
import { open, sealJson } from "../encryption.js";

// Batch-4 fix: ConvexLogStore.appendSessionEvent used to forward only
// ts/day/ownerId/agentId/sessionKey/type — every event-specific field was
// dropped, making the convex session log useless for debugging and blinding
// findLastError. These tests pin that it now forwards the full event shape
// (sealing the sensitive byte columns) and reads them back into disk shape.

interface MutationCall {
	args: Record<string, unknown>;
}

/** Minimal fake of the bits of ConvexHttpClient the log store touches.
 *  Convex function refs are Proxies that throw on arbitrary property access,
 *  so we never inspect `ref` for mutations; for queries we route by ref
 *  identity (findLastError returns a single row; the tail/list queries return
 *  the full array). */
function makeFakeClient(queryRows: Array<Record<string, unknown>> = [], singleRow = false) {
	const mutations: MutationCall[] = [];
	const client = {
		async mutation(_ref: unknown, args: Record<string, unknown>) {
			mutations.push({ args });
			return undefined;
		},
		async query(_ref: unknown, _args: Record<string, unknown>) {
			// findLastError expects a single row|null; tail/list expect an array.
			// (Convex's generated `api` proxy gives no stable ref identity to
			// route on, so the caller declares which shape it wants.)
			return singleRow ? (queryRows[0] ?? null) : queryRows;
		},
	};
	return { client, mutations };
}

function makeStore(queryRows: Array<Record<string, unknown>> = [], singleRow = false) {
	const { client, mutations } = makeFakeClient(queryRows, singleRow);
	const store = new ConvexLogStore({
		client: client as never,
		ownerId: "owner-1",
		instanceId: "inst-1",
	});
	return { store, mutations };
}

describe("ConvexLogStore.appendSessionEvent — full field fidelity", () => {
	afterEach(() => {
		delete process.env.BRIGADE_ENCRYPTION_KEY;
	});

	it("forwards every tool_execution_end field and seals the result column", async () => {
		const { store, mutations } = makeStore();
		await store.appendSessionEvent({
			ts: "2026-06-10T12:00:00.000Z",
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			isError: true,
			result: { content: "command not found" },
		} as never);
		assert.equal(mutations.length, 1);
		const a = mutations[0]!.args;
		assert.equal(a.type, "tool_execution_end");
		assert.equal(a.toolCallId, "call-1");
		assert.equal(a.toolName, "bash");
		assert.equal(a.isError, true);
		assert.equal(a.day, "2026-06-10"); // derived from ts
		// result is sealed bytes — opens back to the original object.
		const opened = JSON.parse(open(a.result as ArrayBuffer).toString("utf8"));
		assert.deepEqual(opened, { content: "command not found" });
	});

	it("forwards message_end role/content/stopReason/errorMessage", async () => {
		const { store, mutations } = makeStore();
		await store.appendSessionEvent({
			ts: "2026-06-10T12:00:00.000Z",
			type: "message_end",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			stopReason: "error",
			errorMessage: "provider 500",
		} as never);
		const a = mutations[0]!.args;
		assert.equal(a.role, "assistant");
		assert.equal(a.stopReason, "error");
		assert.equal(a.errorMessage, "provider 500");
		const opened = JSON.parse(open(a.content as ArrayBuffer).toString("utf8"));
		assert.deepEqual(opened, [{ type: "text", text: "hi" }]);
	});

	it("forwards auto_retry_end success + finalError (no schema drop)", async () => {
		const { store, mutations } = makeStore();
		await store.appendSessionEvent({
			ts: "2026-06-10T12:00:00.000Z",
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "gave up",
		} as never);
		const a = mutations[0]!.args;
		assert.equal(a.success, false);
		assert.equal(a.attempt, 3);
		assert.equal(a.finalError, "gave up");
	});

	it("seals byte columns even with encryption enabled (no plaintext leak)", async () => {
		process.env.BRIGADE_ENCRYPTION_KEY = "b".repeat(64);
		const { store, mutations } = makeStore();
		await store.appendSessionEvent({
			ts: "2026-06-10T12:00:00.000Z",
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "rm secret-plaintext" },
		} as never);
		const bytes = Buffer.from(mutations[0]!.args.args as ArrayBuffer);
		assert.equal(bytes.includes(Buffer.from("secret-plaintext")), false);
		const opened = JSON.parse(open(bytes).toString("utf8"));
		assert.deepEqual(opened, { command: "rm secret-plaintext" });
	});
});

describe("ConvexLogStore.readSessionEventTail — opens + strips bookkeeping", () => {
	it("opens sealed result and drops _id/_creationTime", async () => {
		const { store } = makeStore([
			{
				_id: "abc",
				_creationTime: 1,
				ts: "2026-06-10T12:00:00.000Z",
				day: "2026-06-10",
				ownerId: "owner-1",
				agentId: "main",
				sessionKey: "main",
				type: "tool_execution_end",
				toolName: "bash",
				isError: true,
				// seal a value the same way the writer would
				result: sealJson({ stderr: "boom" }),
			},
		]);
		const rows = await store.readSessionEventTail({});
		const r = rows[0] as unknown as Record<string, unknown>;
		assert.equal("_id" in r, false);
		assert.equal("_creationTime" in r, false);
		assert.deepEqual(r.result, { stderr: "boom" });
		assert.equal(r.toolName, "bash");
	});
});

describe("ConvexLogStore.findLastSessionError — builds a snapshot", () => {
	it("renders a tool failure into a human message", async () => {
		const { store } = makeStore(
			[
				{
					ts: "2026-06-10T12:00:00.000Z",
					type: "tool_execution_end",
					toolName: "bash",
					isError: true,
					result: sealJson("permission denied"),
				},
			],
			true, // findLastError returns a single row
		);
		const snap = await store.findLastSessionError();
		assert.equal(snap?.type, "tool_execution_end");
		const message = String((snap as { message?: unknown } | undefined)?.message ?? "");
		assert.match(message, /bash failed/);
		assert.match(message, /permission denied/);
	});
});

describe("ConvexLogStore.readSubsystemRecords — flattens fields", () => {
	it("re-spreads the fields column to top-level and strips bookkeeping", async () => {
		const { store } = makeStore([
			{
				_id: "x",
				_creationTime: 2,
				ownerId: "owner-1",
				day: "2026-06-10",
				time: "2026-06-10T12:00:00.000Z",
				level: "warn",
				subsystem: "cron",
				message: "job failed",
				fields: { jobId: "j1", error: "timeout" },
			},
		]);
		const rows = await store.readSubsystemRecords({} as never);
		const r = rows[0] as unknown as Record<string, unknown>;
		assert.equal(r.level, "warn");
		assert.equal(r.subsystem, "cron");
		assert.equal(r.jobId, "j1"); // flattened
		assert.equal(r.error, "timeout"); // flattened
		assert.equal("_id" in r, false);
		assert.equal("fields" in r, false);
	});
});
