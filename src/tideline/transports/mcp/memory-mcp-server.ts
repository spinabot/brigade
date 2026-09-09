// src/tideline/transports/mcp/memory-mcp-server.ts
//
// Tideline Step 23 — a spec-compliant MCP server over the memory tool surface.
//
// `createMemoryMcpServer` is the TRANSPORT-AGNOSTIC dispatch: it answers the
// JSON-RPC 2.0 methods an MCP client speaks (initialize / tools/list /
// tools/call / ping), backed by `memoryMcpTools` bound to a principal. Fully
// unit-testable (feed it request objects). `runMemoryMcpStdio` is the thin
// stdio transport shell (newline-delimited JSON-RPC on stdin/stdout) the
// `brigade mcp` CLI runs. No external SDK — the protocol is small and Brigade
// stays air-gap-clean.

import * as readline from "node:readline";

import { memoryMcpTools } from "./memory-mcp.js";
import type { MemoryRecordOrigin } from "../../store/records.js";
import type { Tideline } from "../../api/tideline.js";

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

export interface MemoryMcpServer {
	/** Answer one request. Returns `null` for a notification (no reply expected). */
	handle(req: JsonRpcRequest): JsonRpcResponse | null;
	/** Await backend readiness and durability when serving asynchronous hosts. */
	handleAsync?(req: JsonRpcRequest): Promise<JsonRpcResponse | null>;
	/** The tool count exposed (for diagnostics). */
	toolCount: number;
}

export function createMemoryMcpServer(
	tide: Tideline,
	opts: { origin: MemoryRecordOrigin; serverName?: string; serverVersion?: string },
): MemoryMcpServer {
	const tools = memoryMcpTools(tide, { origin: opts.origin });
	const byName = new Map(tools.map((t) => [t.name, t]));

	const handle = (req: JsonRpcRequest): JsonRpcResponse | null => {
		// Validate the wire shape BEFORE reading fields: a malformed request (missing
		// or non-string `method`) must produce a JSON-RPC error, never throw out of
		// handle() and crash the transport.
		const rawId: unknown = (req as { id?: unknown })?.id;
		const id: string | number | null = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
		const method: unknown = (req as { method?: unknown })?.method;
		if (typeof method !== "string") {
			// Had an id ⇒ addressable, reply Invalid Request; otherwise un-addressable ⇒ drop.
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
					serverInfo: { name: opts.serverName ?? "brigade-memory", version: opts.serverVersion ?? "1.0.0" },
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
					return ok(tool.handler(p?.arguments ?? {}));
				} catch (e) {
					return fail(-32603, `tool error: ${(e as Error).message}`);
				}
			}
			default:
				return fail(-32601, `method not found: ${method}`);
		}
	};

	const handleAsync = async (req: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
		if (req?.method !== "tools/call") return handle(req);
		try {
			await tide.ready();
			const response = handle(req);
			await tide.flush();
			return response;
		} catch (error) {
			if (req.id === undefined) return null;
			const id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
			return {
				jsonrpc: "2.0", id,
				error: { code: -32603, message: `memory backend error: ${error instanceof Error ? error.message : String(error)}` },
			};
		}
	};
	return { handle, handleAsync, toolCount: tools.length };
}

/**
 * Run the server over stdio (newline-delimited JSON-RPC). Protocol I/O goes on
 * stdout; everything else (diagnostics) MUST go to stderr so it can't corrupt
 * the stream. Resolves when stdin closes.
 */
export function runMemoryMcpStdio(
	server: MemoryMcpServer,
	io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
	const input = io.input ?? process.stdin;
	const output = io.output ?? process.stdout;
	return new Promise<void>((resolve) => {
		let pending = Promise.resolve();
		const finish = (): void => { void pending.then(() => resolve()); };
		const safeWrite = (res: JsonRpcResponse): void => {
			try {
				output.write(`${JSON.stringify(res)}\n`);
			} catch {
				// EPIPE / closed peer — the client went away; drop the reply rather
				// than throw out of the line handler.
			}
		};
		// A stdin READ error (fd error, terminal/parent disconnect) must resolve the
		// run, not crash. readline re-emits input 'error' events onto the interface,
		// and an interface with NO error listener throws (uncaught). So we listen on
		// the raw input (registered BEFORE createInterface) AND on `rl` itself.
		input.on("error", finish);
		const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("error", finish);
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let req: JsonRpcRequest;
			try {
				req = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				// Malformed line — can't recover an id; skip (per JSON-RPC, a parse
				// error with no id has no addressable response).
				return;
			}
			// A single bad request must never crash the transport: handle() is
			// hardened, but belt-and-suspenders the dispatch too.
			pending = pending.then(async () => {
				try {
					const res = await (server.handleAsync?.(req) ?? server.handle(req));
					if (res) safeWrite(res);
				} catch {
					/* keep the server alive for the next line */
				}
			});
		});
		// A closed stdout surfaced as an async 'error' event (EPIPE) must not crash.
		output.on("error", () => {
			/* peer gone; subsequent writes are no-ops via safeWrite */
		});
		rl.on("close", finish);
	});
}
