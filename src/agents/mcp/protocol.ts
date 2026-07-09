// src/agents/mcp/protocol.ts
//
// Generic, transport-agnostic MCP (Model Context Protocol) JSON-RPC 2.0 dispatch
// over an ARBITRARY tool list. This is the generalization of the memory-only
// server in `../memory/memory-mcp-server.ts`: same wire protocol, but (a) the
// tool set is injected rather than hard-wired to memory, and (b) `tools/call`
// handlers are ASYNC and receive an AbortSignal — required to front Brigade's
// real (async, cancellable) tool surface behind an MCP endpoint.
//
// Deliberately kept SEPARATE from `memory-mcp-server.ts` rather than refactoring
// it: the memory stdio path is proven and its synchronous handler + stdio loop
// stay byte-identical. The wire-shape hardening mirrors the memory server
// exactly (a malformed request yields a JSON-RPC error, never a throw out of
// `handle`).
//
// No external SDK — the protocol surface Brigade speaks is small (initialize /
// tools/list / tools/call / ping), and staying SDK-free keeps the build
// air-gap-clean (matches the memory server's design note).

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}
export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

/** MCP `CallToolResult` shape — `content` is the model-facing payload. */
export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/** One MCP tool. `handler` is async and abort-aware so it can front a real
 *  Brigade tool (guard chain + `execute(callId, args, signal)`). */
export interface McpServerTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	handler: (args: Record<string, unknown>, signal?: AbortSignal) => McpToolResult | Promise<McpToolResult>;
}

export interface McpServer {
	/** Answer one request. Resolves `null` for a notification (no reply expected). */
	handle(req: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse | null>;
	toolCount: number;
}

/**
 * Build a transport-agnostic MCP server over `tools`. Feed it request objects
 * (from stdio, HTTP, or a test) — it never throws out of `handle`; every error
 * path becomes a JSON-RPC error response (or `null` for notifications).
 */
export function createMcpServer(
	tools: McpServerTool[],
	opts: { serverName?: string; serverVersion?: string } = {},
): McpServer {
	const byName = new Map(tools.map((t) => [t.name, t]));

	const handle = async (req: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse | null> => {
		// Validate the wire shape BEFORE reading fields — a malformed request must
		// produce a JSON-RPC error, never throw out of handle() and kill the transport.
		const rawId: unknown = (req as { id?: unknown })?.id;
		const id: string | number | null = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
		const method: unknown = (req as { method?: unknown })?.method;
		if (typeof method !== "string") {
			return rawId !== undefined
				? { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing or invalid 'method'" } }
				: null;
		}
		// A JSON-RPC notification (no `id`) or any `notifications/*` method gets no reply.
		const isNotification = rawId === undefined || method.startsWith("notifications/");
		const ok = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id, result });
		const fail = (code: number, message: string): JsonRpcResponse | null =>
			isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } };

		switch (method) {
			case "initialize":
				return ok({
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: opts.serverName ?? "brigade", version: opts.serverVersion ?? "1.0.0" },
				});
			case "notifications/initialized":
				return null;
			case "ping":
				return ok({});
			case "tools/list":
				return ok({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
			case "tools/call": {
				const p = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
				const tool = p?.name ? byName.get(p.name) : undefined;
				if (!tool) return fail(-32602, `unknown tool: ${p?.name ?? "(none)"}`);
				try {
					const result = await tool.handler(p?.arguments ?? {}, signal);
					return ok(result);
				} catch (e) {
					return fail(-32603, `tool error: ${(e as Error).message}`);
				}
			}
			default:
				return fail(-32601, `method not found: ${method}`);
		}
	};

	return { handle, toolCount: tools.length };
}
