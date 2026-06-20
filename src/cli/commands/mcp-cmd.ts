// src/cli/commands/mcp-cmd.ts
//
// `brigade mcp` — expose this Brigade's long-term memory as an MCP server over
// stdio, so an MCP client (a desktop app, another agent runtime) can add /
// search / context against it. Bound to the OWNER principal (the operator runs
// it for their own memory); reads are owner-scoped, writes stamped owner.
//
// Protocol I/O is on STDOUT (newline-delimited JSON-RPC); the readiness line +
// any diagnostics go to STDERR so they can never corrupt the stream.

import { createMemoryMcpServer, runMemoryMcpStdio } from "../../agents/memory/memory-mcp-server.js";
import { Tideline } from "../../agents/memory/tideline.js";
import { resolveAgentWorkspaceDir } from "../../config/paths.js";
import { scanForThreats } from "../../security/injection-patterns.js";

export async function runMemoryMcpServerCli(opts: { agentId?: string } = {}): Promise<number> {
	const agentId = opts.agentId ?? "main";
	const workspaceDir = resolveAgentWorkspaceDir(agentId);
	// Wire the recall-time content threat-scan into the facade's injectable seam so
	// the MCP memory tools surface a poisoned fact as `[BLOCKED]` (never its raw
	// text) — the same net auto-recall applies in-process. Owner-exposed surface,
	// but legacy/owner-pasted payloads still get caught at recall.
	const tide = Tideline.open(workspaceDir, {
		threatScan: { scan: (c) => scanForThreats(c, "strict") },
	});
	const server = createMemoryMcpServer(tide, { origin: { kind: "owner" }, serverName: "brigade-memory" });
	process.stderr.write(
		`brigade memory MCP server ready — agent '${agentId}', ${server.toolCount} tools, MCP over stdio. ` +
			`Ctrl-C or close stdin to stop.\n`,
	);
	await runMemoryMcpStdio(server);
	return 0;
}
