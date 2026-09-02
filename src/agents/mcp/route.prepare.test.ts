/**
 * The MCP tool-plane must run a tool's `prepareArguments` before validating.
 *
 * Pi's loop does `prepareToolCallArguments` then `validateToolArguments`
 * (pi-agent-core `agent-loop.js:370-371`). This plane skipped the first step,
 * so `edit` — the only builtin carrying a shim — rejected two shapes real
 * models emit that a Pi-loop turn accepts. Same agent, same model, different
 * backend: an `edit` that works natively fails on the claude-cli harness.
 *
 * These drive the REAL `buildMcpTurnServer` dispatcher and Pi's REAL `edit`
 * tool. An earlier version of this file re-implemented the plane's ordering in
 * the test and asserted that — which proved the concept and nothing about the
 * wiring, exactly the weakness that let the original bug ship.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEditTool } from "@earendil-works/pi-coding-agent";

import { buildMcpTurnServer } from "./route.js";
import type { McpTurnContext } from "./tool-plane-host.js";
import type { AnyBrigadeTool } from "../tools/types.js";

const req = (method: string, params?: unknown, id: string | number = 1) => ({
	jsonrpc: "2.0" as const,
	id,
	method,
	params,
});

/** Pi's real `edit`, with `execute` replaced so nothing touches the disk. */
function editToolSpy(seen: unknown[]): AnyBrigadeTool {
	const real = createEditTool(process.cwd()) as unknown as Record<string, unknown>;
	return {
		...real,
		execute: async (_id: string, params: unknown) => {
			seen.push(params);
			return { content: [{ type: "text", text: "edited" }], details: undefined };
		},
	} as unknown as AnyBrigadeTool;
}

async function callEdit(args: Record<string, unknown>): Promise<{
	isError: boolean;
	text: string;
	params: unknown;
}> {
	const seen: unknown[] = [];
	const turn: McpTurnContext = {
		customTools: [editToolSpy(seen)],
		guard: async () => undefined,
		agentId: "main",
	} as McpTurnContext;
	const server = buildMcpTurnServer(turn);
	const res = await server.handle(req("tools/call", { name: "edit", arguments: args }));
	const result = res?.result as { isError?: boolean; content?: { text?: string }[] };
	return {
		isError: result?.isError === true,
		text: result?.content?.[0]?.text ?? "",
		params: seen[0],
	};
}

test("the real edit tool still carries a prepareArguments shim", () => {
	// If Pi ever drops it, everything below would pass vacuously.
	const real = createEditTool(process.cwd()) as unknown as { prepareArguments?: unknown };
	assert.equal(typeof real.prepareArguments, "function");
});

test("edits sent as a JSON STRING reach execute as an array", async () => {
	// Pi's own comment names the models that do this: "Opus 4.6, GLM-5.1".
	// Brigade serves both. Unrepaired, the schema rejects it and the model gets
	// a tool error for a call that would have worked on a Pi-loop turn.
	const out = await callEdit({
		path: "a.ts",
		edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
	});
	assert.equal(out.isError, false, `plane rejected it: ${out.text}`);
	const params = out.params as { edits?: unknown };
	assert.ok(Array.isArray(params?.edits), "the shim parsed the JSON string into an array");
	assert.deepEqual(params.edits, [{ oldText: "a", newText: "b" }]);
});

test("the legacy flat oldText/newText form is folded into edits", async () => {
	const out = await callEdit({ path: "a.ts", oldText: "a", newText: "b" });
	assert.equal(out.isError, false, `plane rejected it: ${out.text}`);
	const params = out.params as { edits?: unknown; oldText?: unknown };
	assert.deepEqual(params?.edits, [{ oldText: "a", newText: "b" }]);
	assert.equal(params?.oldText, undefined, "the legacy keys are consumed, not passed through");
});

test("a well-formed call is completely unaffected", async () => {
	const out = await callEdit({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] });
	assert.equal(out.isError, false);
	assert.deepEqual((out.params as { edits?: unknown }).edits, [{ oldText: "a", newText: "b" }]);
});

test("a genuinely invalid call is still rejected", async () => {
	// The shim repairs shapes; it must never become a way past validation.
	const noEdits = await callEdit({ path: "a.ts" });
	assert.equal(noEdits.isError, true);
	const noPath = await callEdit({ edits: [{ oldText: "a", newText: "b" }] });
	assert.equal(noPath.isError, true);
});

test("a tool with no shim is passed through untouched", async () => {
	// Every other builtin has no `prepareArguments`; the plane must not invent
	// behaviour for them.
	const seen: unknown[] = [];
	const plain = {
		name: "noop",
		label: "noop",
		description: "no shim",
		parameters: (createEditTool(process.cwd()) as unknown as { parameters: unknown }).parameters,
		execute: async (_id: string, params: unknown) => {
			seen.push(params);
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	} as unknown as AnyBrigadeTool;
	const server = buildMcpTurnServer({
		customTools: [plain],
		guard: async () => undefined,
		agentId: "main",
	} as McpTurnContext);
	const args = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
	await server.handle(req("tools/call", { name: "noop", arguments: args }));
	assert.deepEqual(seen[0], args);
});
