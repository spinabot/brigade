/**
 * Gateway-call factory (types-only at this milestone).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/call.ts`. Defines
 * the call surface that agent tools use to dial back into the gateway
 * (e.g. `sessions.send`, `sessions.spawn`, `cron.add`, `approvals.respond`).
 *
 * What this file IS:
 *
 *   - The TypeScript signatures + the `GatewayCallOptions` shape.
 *   - The `GatewayCaller` interface every tool depends on.
 *   - A `setGlobalGatewayCaller` injection point so tools resolve the
 *     concrete dispatcher at boot time — without coupling to whichever
 *     transport (in-process function, WebSocket, named pipe) the
 *     gateway is running under.
 *
 * What this file is NOT (deferred to Step 25):
 *
 *   - The actual transport implementation (the WebSocket client +
 *     least-privilege scope handshake + TLS pinning live in the
 *     server-methods step).
 *   - The per-method routing table (which method name → which server
 *     handler) — that's Step 25's gateway dispatcher.
 *
 * Why split now: a number of upstream's tools (the `sessions_*` tool
 * surface in Steps 19-23, the `subagent-spawn` flow in Step 20) take a
 * `GatewayCaller` argument so the test fixtures can supply a stub.
 * Defining the signature now keeps those steps unblocked even though
 * Brigade has no concrete dispatcher to wire yet.
 */

import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export interface GatewayCallOptions {
	method: string;
	params?: unknown;
	timeoutMs?: number;
	/** Token override — used when calling a remote gateway. Defaults to local creds. */
	token?: string;
	/** Optional remote URL — defaults to the local gateway's listen address. */
	url?: string;
}

export interface GatewayCaller {
	call: <T = Record<string, unknown>>(opts: GatewayCallOptions) => Promise<T>;
}

type GatewayCallerSlot = { caller: GatewayCaller | null };

const GATEWAY_CALLER_SLOT_KEY = Symbol.for("brigade.gatewayCall.slot");

function getSlot(): GatewayCallerSlot {
	return resolveGlobalSingleton<GatewayCallerSlot>(GATEWAY_CALLER_SLOT_KEY, () => ({
		caller: null,
	}));
}

/**
 * Install the concrete gateway-call dispatcher. Boot code (Step 25)
 * calls this once with the WebSocket-backed implementation. Tests call
 * it with a stub.
 *
 * Returns a disposer that unsets the caller.
 */
export function setGlobalGatewayCaller(caller: GatewayCaller | null): () => void {
	const slot = getSlot();
	slot.caller = caller;
	return () => {
		if (slot.caller === caller) slot.caller = null;
	};
}

/** Read the current dispatcher (or `null` if none is installed). */
export function getGlobalGatewayCaller(): GatewayCaller | null {
	return getSlot().caller;
}

/**
 * Convenience caller — throws if no dispatcher has been installed yet.
 * Most tools call this directly; tests inject a custom `GatewayCaller`
 * via `setGlobalGatewayCaller`.
 */
export async function callGateway<T = Record<string, unknown>>(
	opts: GatewayCallOptions,
): Promise<T> {
	const caller = getGlobalGatewayCaller();
	if (!caller) {
		throw new Error(
			`callGateway invoked before a dispatcher was registered (method: ${opts.method}). ` +
				`Make sure the gateway boot path calls setGlobalGatewayCaller(...) before tool dispatch.`,
		);
	}
	return await caller.call<T>(opts);
}

/** Test-only — drop the registered caller. */
export function resetGatewayCallerForTests(): void {
	getSlot().caller = null;
}

/* ─── Method-signature catalogue (Step 25 fills in handlers) ────── */

/**
 * Type-only catalogue of the gateway methods agent tools can call. Each
 * entry maps method name → `{ params, result }` types. Step 25 lifts
 * the handler registry implementing these signatures.
 */
export type GatewayMethodSignatures = {
	"sessions.send": {
		params: { sessionKey: string; text: string; attachments?: Array<{ type: string; url: string }> };
		result: { ok: boolean };
	};
	"sessions.spawn": {
		params: {
			parentSessionKey: string;
			task: string;
			model?: string;
			workspaceDir?: string;
			runTimeoutSeconds?: number;
			cleanup?: "delete" | "keep";
		};
		result: { runId: string; childSessionKey: string };
	};
	"sessions.list": {
		params: { agentId?: string; activeOnly?: boolean };
		result: {
			sessions: Array<{
				sessionKey: string;
				agentId: string;
				lastActivityAt?: number;
				state?: string;
			}>;
		};
	};
	"sessions.history": {
		params: { sessionKey: string; limit?: number };
		result: { messages: Array<{ role: string; text: string; ts: number }> };
	};
	// Cron methods — full reference parity. Params + results live in
	// `core/server-methods/cron.ts` as the source of truth; we widen to
	// `unknown` here to avoid a circular import between gateway-call (low-
	// level dispatch) and the handler module (high-level). Tool callers
	// cast through the typed handler module directly when needed.
	"cron.add": {
		params: Record<string, unknown>;
		result: Record<string, unknown>;
	};
	"cron.list": {
		params: Record<string, unknown>;
		result: Record<string, unknown>;
	};
	"cron.status": {
		params: Record<string, unknown>;
		result: Record<string, unknown>;
	};
	"cron.update": {
		params: Record<string, unknown>;
		result: Record<string, unknown>;
	};
	"cron.remove": {
		params: Record<string, unknown>;
		result: { removed: boolean };
	};
	"cron.run": {
		params: Record<string, unknown>;
		result: Record<string, unknown>;
	};
	"cron.runs": {
		params: Record<string, unknown>;
		result: Record<string, unknown>;
	};
	wake: {
		params: { text: string; mode?: "now" | "next-heartbeat"; agentId?: string; sessionKey?: string };
		result: void;
	};
	"approvals.respond": {
		params: { approvalId: string; decision: "allow-once" | "allow-always" | "allow-pattern" | "deny" };
		result: { ok: boolean };
	};
};

export type GatewayMethodName = keyof GatewayMethodSignatures;
