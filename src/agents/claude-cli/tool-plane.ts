// Tool-plane wiring for the claude-cli harness backend (memory/graph).
//
// The `claude` binary runs its OWN agent loop, so Brigade's tools can't be
// passed inline the way a raw model API (anthropic/openai/ollama) accepts them.
// The binary's official mechanism for external tools is MCP (`--mcp-config`).
// This module is the bridge: for an ELIGIBLE claude-cli turn we hand the binary
// an MCP config pointing back at Brigade's OWN memory MCP server
// (`brigade mcp --agent <id>` — the same server `brigade mcp` already ships for
// desktop MCP clients), so the free-tier engine can call
// `mcp__brigade__memory_add / memory_search / memory_context` and the memory
// graph becomes live on this backend.
//
// SCOPING (load-bearing — the whole design):
//   • claude-cli ONLY. The stamp is applied inside the per-dispatch stream-fn
//     wrapper and gated on `model.api === "claude-cli"`, so raw-API providers
//     (where Pi drives the loop and passes tools inline) never see any of this.
//   • OWNER turns only. The bundled memory MCP server is owner-origin pinned;
//     handing it to a channel peer's turn would let the peer read/write owner
//     memory and break Tideline's origin isolation. `senderIsOwner` is stamped
//     by the agent loop (the same signal the tool registry gates on) and
//     enforced here — a peer turn simply gets no MCP config.
//   • NEVER on structured (distiller) turns. The memory-extraction /
//     consolidation subagents are deliberately tool-less on every backend
//     (`makeIsolatedLlm` passes `tools: []`); a distiller that could call tools
//     mid-extraction would be a regression. `stream.ts` gates on
//     `isStructuredJsonPrompt` before building the config.
//   • FAIL-OPEN. Any missing precondition (no CLI entry path, bad agent id,
//     config write failure) yields "no MCP config" — the spawn proceeds exactly
//     as before (chat works, tools absent). The tool-plane can only ADD.

/** Per-turn tool-plane context, stamped onto Pi's context object by the agent
 *  loop's stream-fn wrapper and read back by the claude-cli transport. */
export interface ClaudeCliToolPlane {
	agentId: string;
	senderIsOwner: boolean;
	/**
	 * When the gateway registered this turn's FULL guarded tool surface with the
	 * MCP tool-plane host, its loopback HTTP endpoint
	 * (`http://127.0.0.1:<port>/mcp/<token>`). Present => the transport hands the
	 * binary the full plane over HTTP instead of the memory-only stdio server.
	 * Owner-gated + gateway-only upstream.
	 */
	mcpHttpUrl?: string;
}

// Property key used to stamp the tool-plane onto Pi's per-turn context object.
// The context is a plain object Pi threads to the api-provider stream fn; an
// extra own-property is invisible to every other transport (they read only
// systemPrompt/messages) and is never serialized into a request payload.
const TOOL_PLANE_KEY = "__brigadeClaudeCliToolPlane";

/** Stamp the tool-plane onto the per-turn context (in place — the same object
 *  reference flows through the stream-wrapper chain down to the transport, since
 *  every hop forwards it by reference and pi-ai's `stream()` passes it verbatim).
 *  FAIL-OPEN: if the context is frozen/sealed/exotic and the assignment throws,
 *  swallow it — the transport then simply finds no stamp and runs tool-less,
 *  never a broken turn. */
export function stampClaudeCliToolPlane(context: unknown, plane: ClaudeCliToolPlane): void {
	if (!context || typeof context !== "object") return;
	try {
		(context as Record<string, unknown>)[TOOL_PLANE_KEY] = plane;
	} catch {
		/* frozen/sealed context — no tool-plane this turn (fail-open). */
	}
}

/** Read a previously-stamped tool-plane. Undefined when absent/malformed. */
export function readClaudeCliToolPlane(context: unknown): ClaudeCliToolPlane | undefined {
	if (!context || typeof context !== "object") return undefined;
	const v = (context as Record<string, unknown>)[TOOL_PLANE_KEY];
	if (!v || typeof v !== "object") return undefined;
	const plane = v as { agentId?: unknown; senderIsOwner?: unknown; mcpHttpUrl?: unknown };
	if (typeof plane.agentId !== "string" || plane.agentId.length === 0) return undefined;
	return {
		agentId: plane.agentId,
		senderIsOwner: plane.senderIsOwner === true,
		...(typeof plane.mcpHttpUrl === "string" && plane.mcpHttpUrl.length > 0
			? { mcpHttpUrl: plane.mcpHttpUrl }
			: {}),
	};
}

// Agent ids are directory names (`~/.brigade/agents/<id>/`) — enforce the safe
// charset before an id lands in a subprocess argv.
const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Build the MCP config JSON handed to the binary via `--mcp-config`. Points the
 * server named `brigade` at Brigade's own CLI entry (`<node> <entry> mcp
 * --agent <id>`) — replicating exactly how THIS process was started, so it works
 * for a global install (`brigade.mjs` shim) and a local dist alike. The
 * `BRIGADE_STATE_DIR` override is forwarded so a custom state dir resolves the
 * same store in the child (the claude-cli env scrub strips it otherwise).
 * Returns undefined (→ no tool-plane, fail-open) when the entry path is
 * unavailable or the agent id is unsafe.
 */
export function buildClaudeCliMcpConfig(agentId: string): string | undefined {
	const entry = process.argv[1];
	if (!entry || typeof entry !== "string") return undefined;
	if (!SAFE_AGENT_ID.test(agentId)) return undefined;
	const env: Record<string, string> = {};
	const stateDir = process.env.BRIGADE_STATE_DIR?.trim();
	if (stateDir) env.BRIGADE_STATE_DIR = stateDir;
	const config = {
		mcpServers: {
			brigade: {
				command: process.execPath,
				args: [entry, "mcp", "--agent", agentId],
				...(Object.keys(env).length > 0 ? { env } : {}),
			},
		},
	};
	return JSON.stringify(config);
}

/**
 * The HTTP MCP config pointing the binary at the gateway's in-process tool-plane
 * endpoint (`http://127.0.0.1:<port>/mcp/<token>`). The token in the URL both
 * authenticates the caller and selects the turn context. `claude` 2.1.x accepts
 * an `{type:"http", url}` server in `--mcp-config`. Returns undefined (=> fall
 * back / no plane) for a malformed non-loopback URL — the endpoint is
 * loopback-only, so we refuse to emit anything else.
 */
export function buildClaudeCliHttpMcpConfig(url: string): string | undefined {
	if (typeof url !== "string") return undefined;
	if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/mcp\/[0-9a-f]{64}$/.test(url)) return undefined;
	return JSON.stringify({ mcpServers: { brigade: { type: "http", url } } });
}
