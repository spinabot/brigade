// src/agents/mcp/tool-plane-host.ts
//
// The gateway-hosted MCP tool-plane's per-turn registry + process-global host
// handle.
//
// WHY THIS EXISTS: to expose Brigade's FULL tool surface to the claude-cli
// binary without weakening a single guard, the MCP endpoint must run INSIDE the
// gateway process (that's where the live singletons — cron/channel/registry —
// and the approval bridge live). But a tool's authorization, exec-approval, and
// memory ORIGIN are per-TURN closure state (owner vs peer, this session's
// channelContext), not ambient. So we do NOT rebuild the toolset in the MCP
// host; instead, for each eligible turn the agent-loop REGISTERS the turn's
// already-built `customTools` + `beforeToolCall` guard here under a single-use
// token, and the `/mcp` route resolves that token per request. Every `tools/call`
// then runs the turn's OWN guard + the turn's OWN tool object — byte-identical to
// a Pi-loop dispatch (ownerOnly wrap, exec-gate, origin, timeouts all inherited).
//
// The host handle is a process-global set only by the gateway at boot (mirrors
// `getActiveApprovalBridge()` / `getActiveCronService()`), so on the cold
// `brigade agent` path — which has no HTTP server and no approval bridge — it is
// `null` and the agent-loop simply skips the tool-plane (fail-open).

import { randomBytes } from "node:crypto";

import type { BrigadeBeforeToolCallHook } from "../tool-guard.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

/**
 * The execution context of ONE turn, captured by reference. The `/mcp` route
 * needs exactly this to serve the binary's callbacks with the turn's real
 * authorization + guards.
 */
export interface McpTurnContext {
	/** The turn's tools — ALREADY ownerOnly-wrapped + timeout-wrapped + origin-bound
	 *  by `assembleBrigadeToolset` for this turn's senderIsOwner/channelContext. */
	customTools: AnyBrigadeTool[];
	/** The turn's composed guard chain (unknown-tool → path-write → cmd-ism →
	 *  config-write → loop → exec-gate). Closes over the turn's `gateCtxRef`, so it
	 *  routes approval prompts to the right operator. Run this BEFORE any execute. */
	guard: BrigadeBeforeToolCallHook;
	/** The turn's abort signal (per-call controllers chain to it). */
	signal?: AbortSignal;
	/** For diagnostics / logging correlation only — never a trust input. */
	agentId: string;
	sessionKey?: string;
}

/** A live registration. `dispose()` is idempotent; the agent-loop calls it in
 *  its `finally`, so a token never outlives its turn. */
export interface McpTurnRegistration {
	token: string;
	dispose(): void;
}

export interface McpTurnRegistry {
	register(ctx: McpTurnContext): McpTurnRegistration;
	lookup(token: string): McpTurnContext | undefined;
	/** Live registration count (diagnostics/tests). */
	size(): number;
}

/** In-memory single-use token registry. Tokens are 256-bit; lookups are exact. */
export function createMcpTurnRegistry(): McpTurnRegistry {
	const entries = new Map<string, McpTurnContext>();
	return {
		register(ctx: McpTurnContext): McpTurnRegistration {
			// 32 bytes = 256 bits of CSPRNG entropy → unguessable path token.
			const token = randomBytes(32).toString("hex");
			entries.set(token, ctx);
			let disposed = false;
			return {
				token,
				dispose(): void {
					if (disposed) return;
					disposed = true;
					entries.delete(token);
				},
			};
		},
		lookup(token: string): McpTurnContext | undefined {
			// Reject anything that isn't a well-formed token BEFORE the map hit, so a
			// malformed/empty path segment can never alias a live entry.
			if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return undefined;
			return entries.get(token);
		},
		size(): number {
			return entries.size;
		},
	};
}

/** The gateway-published host handle: where the `/mcp` endpoint is reachable and
 *  the registry it resolves tokens against. */
export interface McpToolPlaneHost {
	/** Loopback base URL the binary connects back to, e.g. `http://127.0.0.1:7777`. */
	baseUrl: string;
	registry: McpTurnRegistry;
}

const HOST_KEY = Symbol.for("brigade.mcp.toolPlaneHost");

/** Publish (or clear, with `null`) the tool-plane host. Called ONLY by the
 *  gateway once its HTTP server is bound + the `/mcp` route is mounted. */
export function setActiveMcpToolPlaneHost(host: McpToolPlaneHost | null): void {
	resolveGlobalSingleton<{ value: McpToolPlaneHost | null }>(HOST_KEY, () => ({ value: null })).value = host;
}

/** Resolve the active host, or `null` when the loop runs outside a gateway
 *  (cold `brigade agent` path) — in which case the full tool-plane is unavailable
 *  and the caller must fall back (fail-open). */
export function getActiveMcpToolPlaneHost(): McpToolPlaneHost | null {
	return resolveGlobalSingleton<{ value: McpToolPlaneHost | null }>(HOST_KEY, () => ({ value: null })).value;
}
