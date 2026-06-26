/**
 * Integration control behind the `composio` and `oauth` gateway RPCs — the
 * Composio connector (1,000+ apps) and the DIY OAuth-2 authorize flow, reachable
 * from a remote client.
 *
 * Both reuse the owner-scoped tools (ctx-free execute; owner-gating is a session
 * wrapper). Operator-scoped (allowlisted in the guard-sweep). Action-based,
 * mirroring the tools 1:1.
 *
 * REMOTE NOTES:
 *  - `composio` is fully remote-capable: Composio HOSTS the OAuth callback, so
 *    `connect` returns a click-link the operator opens anywhere and the gateway
 *    just polls `status` — no gateway loopback involved.
 *  - `oauth` is the DIY loopback flow: `start` opens a 127.0.0.1 listener ON THE
 *    GATEWAY HOST with a loopback redirect_uri, so the round-trip only completes
 *    when the operator's browser can reach the GATEWAY's loopback (local to the
 *    gateway, or tunneled). A pure-remote browser would hit its OWN loopback.
 *    `status`/`token` work remotely. For remote app integrations prefer
 *    `composio`.
 */

import { DEFAULT_AGENT_ID } from "../agents/routing/session-key.js";
import { makeComposioTool } from "../agents/tools/composio-tool.js";
import { makeOAuthAuthorizeTool } from "../agents/tools/oauth-authorize-tool.js";

/** `composio` — Composio connector: set-key/apps/connect/status/search/execute/disconnect/refresh. */
export async function handleComposio(params: unknown): Promise<unknown> {
	const p = (params ?? {}) as { agentId?: string };
	const agentId = (p.agentId ?? "").trim() || DEFAULT_AGENT_ID;
	const tool = makeComposioTool({ agentId });
	const res = await tool.execute("gateway", params as never);
	return res.details;
}

/** `oauth` — DIY OAuth-2 authorize: start/await/cancel/status/token (see loopback caveat above). */
export async function handleOauth(params: unknown): Promise<unknown> {
	const p = (params ?? {}) as { agentId?: string };
	const agentId = (p.agentId ?? "").trim() || DEFAULT_AGENT_ID;
	const tool = makeOAuthAuthorizeTool({ agentId });
	const res = await tool.execute("gateway", params as never);
	return res.details;
}
