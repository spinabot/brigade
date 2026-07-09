// src/agents/mcp/http-route.ts
//
// The gateway HTTP transport for the MCP tool-plane. Registers a single prefix
// route `/mcp/<token>` on the gateway's existing loopback HTTP server. The
// `<token>` is the single-use per-turn credential the agent-loop minted (see
// tool-plane-host.ts); it both AUTHENTICATES the caller (only the binary we
// spawned holds it) and SELECTS the turn context (whose tools + guard we serve).
//
// Transport: minimal MCP "Streamable HTTP". The `claude` binary POSTs one
// JSON-RPC request per call; we answer with a single `application/json` JSON-RPC
// response (the spec permits a JSON answer instead of an SSE stream when the
// server doesn't push server→client messages). Notifications get 202. A GET (the
// optional server→client SSE channel) gets 405 — we never initiate, which the
// client must tolerate per spec.
//
// Defense in depth: loopback-only (mirrors the gateway's operator-auth check) +
// the 256-bit token + the registry's format guard. An unknown/expired token is
// 404 (indistinguishable from a wrong path — no oracle).

import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpRoute } from "../extensions/types.js";
import { buildMcpTurnServer } from "./route.js";
import type { JsonRpcRequest } from "./protocol.js";
import type { McpTurnRegistry } from "./tool-plane-host.js";

/** The URL prefix the tool-plane is served under. */
export const MCP_ROUTE_PREFIX = "/mcp";

function isLoopback(remote: string | undefined): boolean {
	return (
		remote === "127.0.0.1" ||
		remote === "::1" ||
		remote === "::ffff:127.0.0.1" ||
		remote === "localhost"
	);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(text);
}

/**
 * Build the `/mcp` HttpRoute backed by `registry`. Pure of any gateway internals
 * beyond the Node req/res it's handed, so it unit-tests with fake req/res.
 */
export function createMcpHttpRoute(registry: McpTurnRegistry): HttpRoute {
	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// Loopback only — the bind is already 127.0.0.1; this is belt-and-suspenders
		// in case the bind guard is ever relaxed (same posture as auth:"operator").
		if (!isLoopback(req.socket.remoteAddress ?? "")) {
			sendJson(res, 401, { error: "Unauthorized" });
			return;
		}

		const reqPath = (req.url ?? "").split("?")[0] ?? "";
		// token = the path segment after `/mcp/`
		const token = reqPath.startsWith(`${MCP_ROUTE_PREFIX}/`)
			? reqPath.slice(MCP_ROUTE_PREFIX.length + 1).split("/")[0] ?? ""
			: "";
		const turn = registry.lookup(token);
		if (!turn) {
			// Unknown/expired/malformed token — 404 (no distinction: no oracle).
			res.statusCode = 404;
			res.end("Not found");
			return;
		}

		const method = (req.method ?? "GET").toUpperCase();
		if (method === "GET") {
			// Optional server→client SSE channel — we never push, so decline.
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.end("Method Not Allowed");
			return;
		}
		if (method === "DELETE") {
			// Session teardown — the turn's lifecycle owns disposal; ack politely.
			res.statusCode = 200;
			res.end();
			return;
		}
		if (method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.end("Method Not Allowed");
			return;
		}

		// Body was pre-buffered by the gateway dispatcher onto `req.body`.
		const bodyBuf = (req as IncomingMessage & { body?: Buffer }).body;
		let rpc: JsonRpcRequest;
		try {
			rpc = JSON.parse((bodyBuf ?? Buffer.alloc(0)).toString("utf8")) as JsonRpcRequest;
		} catch {
			sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}

		const server = buildMcpTurnServer(turn);
		const response = await server.handle(rpc, turn.signal);
		if (response === null) {
			// Notification — accepted, no body.
			res.statusCode = 202;
			res.end();
			return;
		}
		sendJson(res, 200, response);
	};

	return {
		path: MCP_ROUTE_PREFIX,
		match: "prefix",
		auth: "none", // own token + loopback check inside the handler
		skipSessionGuard: true, // JSON-RPC body has no sessionKey/agentId targeting
		handler: handler as HttpRoute["handler"],
	};
}
