// src/agents/mcp/route.ts
//
// Turn the registered per-turn context (tools + guard) into a live MCP server the
// claude-cli binary can drive. This is the security-critical adapter: for EVERY
// `tools/call` it runs the turn's OWN `beforeToolCall` guard FIRST (unknown-tool
// → path-write → cmd-ism → config-write → loop → exec-gate, with the turn's
// `gateCtxRef` routing approval prompts), and only then invokes the turn's OWN
// tool object (already ownerOnly-wrapped + origin-bound by
// `assembleBrigadeToolset`). Result: an MCP call is byte-identical to a Pi-loop
// dispatch — no guard is re-implemented, none is skipped.
//
// A guard BLOCK and a tool THROW both surface as an `isError` tool result (the
// model sees the reason/message inline), exactly as Pi turns a block into a
// synthetic tool_result and surfaces a thrown tool error's `.message`.

import { randomBytes } from "node:crypto";

import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";

import { createMcpServer, type McpServer, type McpToolResult, type McpServerTool } from "./protocol.js";
import type { McpTurnContext } from "./tool-plane-host.js";

/** Map a Brigade tool result's content blocks to MCP text content. Non-text
 *  blocks (images) are summarized — the tool-plane consumes text. */
function mapContent(content: unknown): McpToolResult["content"] {
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const out: McpToolResult["content"] = [];
	for (const block of content) {
		const b = block as { type?: unknown; text?: unknown };
		if (b?.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
		else out.push({ type: "text", text: `[${String(b?.type ?? "non-text")} content omitted]` });
	}
	return out.length > 0 ? out : [{ type: "text", text: "" }];
}

/**
 * Build the MCP server that fronts ONE turn's toolset. Each MCP tool's handler:
 *   1. runs the turn's guard (approval/exec-gate/unknown-tool/path-write/loop);
 *   2. on block → returns the reason as an `isError` result (execute NOT run);
 *   3. otherwise executes the turn's own tool with a per-call callId + the signal;
 *   4. a thrown tool error (ownerOnly 403, input 400, timeout 504, …) → `isError`
 *      with `.message` — matching how Pi surfaces tool failures to the model.
 */
export function buildMcpTurnServer(turn: McpTurnContext, opts: { serverName?: string } = {}): McpServer {
	const tools: McpServerTool[] = turn.customTools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// TypeBox params ARE JSON Schema; symbol-keyed TypeBox internals drop on
		// serialization, leaving a clean `{type:"object", properties, required}`.
		inputSchema: tool.parameters as unknown as McpServerTool["inputSchema"],
		handler: async (args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> => {
			// (1) GUARD — same composed chain the Pi loop installs, closing over the
			// turn's gateCtxRef. Construct the ctx shape the guard reads defensively.
			const guardCtx = { toolCall: { name: tool.name, arguments: args } } as unknown as BeforeToolCallContext;
			const verdict = await turn.guard(guardCtx, signal);
			if (verdict?.block) {
				return { content: [{ type: "text", text: verdict.reason ?? "Tool call blocked." }], isError: true };
			}
			// (2) EXECUTE the turn's OWN tool (ownerOnly wrap + origin already baked in).
			const callId = `mcp-${randomBytes(6).toString("hex")}`;
			try {
				const result = await tool.execute(callId, args as never, signal);
				return { content: mapContent((result as { content?: unknown })?.content) };
			} catch (e) {
				return { content: [{ type: "text", text: (e as Error).message }], isError: true };
			}
		},
	}));
	return createMcpServer(tools, { serverName: opts.serverName ?? "brigade" });
}
