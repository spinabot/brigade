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
import { validateToolArguments } from "@earendil-works/pi-ai/base";

/**
 * Pi's `prepareToolCallArguments`, mirrored.
 *
 * Not exported from `pi-agent-core` (it is a module-local function in
 * `agent-loop.js`), so this plane has to carry its own copy. Kept
 * byte-for-byte equivalent to Pi's: a tool without `prepareArguments` is
 * untouched, and a shim that returns its input unchanged is a no-op.
 *
 * A tool's `prepareArguments` is its compatibility shim for shapes real models
 * emit that the schema does not accept — `edit` repairs `edits` sent as a JSON
 * string and the legacy flat `oldText`/`newText` pair. Pi's loop runs it before
 * validation; anything that validates without it diverges from a Pi-loop turn.
 */
function prepareToolCallArguments(
	tool: { prepareArguments?: (args: unknown) => unknown },
	args: Record<string, unknown>,
): unknown {
	if (typeof tool.prepareArguments !== "function") return args;
	try {
		return tool.prepareArguments(args);
	} catch {
		// A shim is a convenience, never a gate. If it throws, fall through to
		// validation with the raw arguments and let the validator produce the
		// error the model can act on.
		return args;
	}
}

import { emitAgentEvent } from "../agent-event-bus.js";
import { createMcpServer, type McpServer, type McpContentBlock, type McpToolResult, type McpServerTool } from "./protocol.js";
import type { McpTurnContext } from "./tool-plane-host.js";

/**
 * Map a Brigade tool result's content blocks to MCP content. Pi's loop hands the
 * model text AND image blocks; MCP carries both, so an image result (e.g.
 * `analyze_media`) passes through intact instead of degrading to a placeholder.
 */
function mapContent(content: unknown): McpToolResult["content"] {
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const out: McpContentBlock[] = [];
	for (const block of content) {
		const b = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
		if (b?.type === "text" && typeof b.text === "string") {
			out.push({ type: "text", text: b.text });
		} else if (b?.type === "image" && typeof b.data === "string") {
			out.push({ type: "image", data: b.data, mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png" });
		} else {
			out.push({ type: "text", text: `[${String(b?.type ?? "non-text")} content omitted]` });
		}
	}
	return out.length > 0 ? out : [{ type: "text", text: "" }];
}

const errorResult = (text: string): McpToolResult => ({ content: [{ type: "text", text }], isError: true });

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
			// Mirror Pi's own `prepareToolCall` pipeline exactly — validate, guard on
			// the VALIDATED args, re-check abort, then execute. Skipping any step
			// makes an MCP call subtly different from a Pi-loop dispatch, which is
			// precisely the guarantee this plane is built on.

			// (1) PREPARE, then VALIDATE + COERCE against the tool's schema, using
			// Pi's own validator. Without validation a malformed call from the
			// binary reaches `execute` raw; a failure is a tool error carrying the
			// validator's message — exactly what Pi surfaces.
			//
			// PREPARE FIRST. Pi's loop does `prepareToolCallArguments` and only then
			// `validateToolArguments` (pi-agent-core agent-loop.js:370-371), and
			// skipping the first step broke `edit` on this plane specifically:
			// its `prepareArguments` repairs two shapes real models emit — `edits`
			// arriving as a JSON *string* (Pi's own comment names Opus 4.6 and
			// GLM-5.1) and the legacy flat `oldText`/`newText` form. Both are
			// rejected by the schema unrepaired, so the identical call succeeded on
			// a Pi-loop turn and failed on a claude-cli harness turn — same agent,
			// same model, different backend.
			const prepared = prepareToolCallArguments(tool, args);
			let validated: Record<string, unknown>;
			try {
				validated = validateToolArguments(tool as never, {
					name: tool.name,
					arguments: prepared,
				} as never) as Record<string, unknown>;
			} catch (e) {
				return errorResult((e as Error).message);
			}

			// (2) GUARD — the turn's composed chain, closing over its gateCtxRef.
			//
			// Pi hands `beforeToolCall` the ORIGINAL toolCall (raw arguments) and puts
			// the validated args only in `ctx.args` (agent-loop.js: `beforeToolCall({
			// toolCall, args: validatedArgs })`). Every Brigade guard reads
			// `ctx.toolCall.arguments` first, so passing validated args in BOTH slots
			// would make guards see coerced values here and raw values in a Pi-loop
			// turn — e.g. `command: 123` reaches the exec-gate as "123" over MCP but
			// hits its non-string branch natively, and the loop-detector hashes differ.
			// Same objects, same guard, same inputs: mirror Pi's split exactly.
			const guardCtx = { toolCall: { name: tool.name, arguments: args }, args: validated } as unknown as BeforeToolCallContext;
			const verdict = await turn.guard(guardCtx, signal);
			if (verdict?.block) return errorResult(verdict.reason ?? "Tool call blocked.");

			// (3) ABORT between guard and execute — an approval can take minutes, and
			// the turn (or the binary) may die while we wait. Pi checks here too; without
			// it an aborted turn still runs the tool.
			if (signal?.aborted) return errorResult("Operation aborted");

			// (4) EXECUTE the turn's OWN tool (ownerOnly wrap + origin already baked in).
			const callId = `mcp-${randomBytes(6).toString("hex")}`;

			// Mint the pi-shaped tool events Pi's loop would have emitted. On this
			// backend the binary runs the loop, so Pi dispatches no tool and the TUI
			// showed a silent gap — often many seconds — while a file was read or a
			// command ran. connect.ts already renders these by `toolCallId`; nothing
			// downstream changes. Emitted only AFTER the guard passes, matching Pi
			// (a blocked call produces no start/end; the block surfaces separately).
			const emitTool = (piEvent: Record<string, unknown>): void => {
				if (!turn.runId) return; // cold path (no gateway) — nothing to render
				emitAgentEvent({
					type: "pi",
					runId: turn.runId,
					agentId: turn.agentId,
					sessionId: turn.sessionKey ?? "",
					synthetic: true,
					// A sub-agent's tool calls must render indented, exactly as a Pi-loop
					// sub-agent's do. Without this they arrive at depth 0 and a child's
					// `bash` is indistinguishable from the parent running it.
					...(turn.subagentDepth !== undefined ? { subagentDepth: turn.subagentDepth } : {}),
					...(turn.subagentLabel !== undefined ? { subagentLabel: turn.subagentLabel } : {}),
					piEvent,
				});
			};
			emitTool({ type: "tool_execution_start", toolCallId: callId, toolName: tool.name, args: validated });

			// Pi passes `onUpdate` as the 4th arg to every `execute`, and tools use it to
			// stream progress (`bash` partial output, `web-fetch`'s "fetching → extracting").
			// Dropping it made a long tool look like a hang: a start chip, silence, a result.
			// The binary can't consume partials (an MCP `tools/call` is one response), but
			// the operator's TUI can — so tee them onto the bus, exactly as Pi's loop does.
			const onUpdate = (update: unknown): void => {
				emitTool({ type: "tool_execution_update", toolCallId: callId, toolName: tool.name, update });
			};

			// Report the call to the harness-transcript layer, so the session records
			// what the binary did. A transcript write must never break a tool call.
			const record = (content: McpContentBlock[], isError: boolean): void => {
				try {
					turn.recordToolCall?.({ toolCallId: callId, toolName: tool.name, args: validated, content, isError });
				} catch {
					/* best-effort */
				}
			};

			try {
				const result = await tool.execute(callId, validated as never, signal, onUpdate as never);
				const content = mapContent((result as { content?: unknown })?.content);
				// Pi's `result` shape — connect.ts feeds it to summarizeToolResult().
				emitTool({ type: "tool_execution_end", toolCallId: callId, toolName: tool.name, args: validated, result: { content }, isError: false });
				record(content, false);
				return { content };
			} catch (e) {
				const message = (e as Error).message;
				const content: McpContentBlock[] = [{ type: "text", text: message }];
				emitTool({
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: tool.name,
					args: validated,
					result: { content },
					isError: true,
				});
				record(content, true);
				return errorResult(message);
			}
		},
	}));
	return createMcpServer(tools, { serverName: opts.serverName ?? "brigade" });
}
