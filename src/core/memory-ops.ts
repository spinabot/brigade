/**
 * Memory (Tideline) write + governance behind the `memory.*` gateway RPCs — the
 * write_memory + manage_memory surface, reachable from a remote client.
 *
 * Memory lives in `facts.jsonl` (a store, NOT brigade.json), so `config.set`
 * cannot reach it — these RPCs are the only typed remote path to MUTATE memory.
 * READ is already covered by the `memory-query` (list/search/inspect/stats) and
 * `memory-graph` RPCs.
 *
 * OPERATOR-SCOPED: operates on the OWNER origin over the agent's workspace,
 * exactly like the tools (filesystem AND Convex modes). Reuses the SAME
 * write_memory / manage_memory tool logic — their `execute()` is pure (owner-
 * gating is a session wrapper, not inside execute), so invoking them with an
 * owner scope from the gateway is correct and byte-identical to a turn.
 */

import { FactStore } from "../agents/memory/records.js";
import { makeManageMemoryTool } from "../agents/tools/manage-memory-tool.js";
import { makeWriteMemoryTool } from "../agents/tools/memory-tools.js";
import { DEFAULT_AGENT_ID, resolveAgentWorkspaceDir } from "../config/paths.js";

function workspaceFor(agentId?: string): string {
	const id = (agentId ?? "").trim() || DEFAULT_AGENT_ID;
	return resolveAgentWorkspaceDir(id);
}

/** `memory.write` — persist a durable fact. Params mirror the write_memory tool. */
export async function handleMemoryWrite(params: unknown): Promise<unknown> {
	const p = (params ?? {}) as { agentId?: string };
	const store = new FactStore(workspaceFor(p.agentId));
	const tool = makeWriteMemoryTool(store, { senderIsOwner: true });
	const res = await tool.execute("gateway", params as never);
	return res.details;
}

/** `memory.manage` — dream/purge/inspect/export/retention/vault/retract/restore/relink. */
export async function handleMemoryManage(params: unknown): Promise<unknown> {
	const p = (params ?? {}) as { agentId?: string };
	const agentId = (p.agentId ?? "").trim() || DEFAULT_AGENT_ID;
	const tool = makeManageMemoryTool(workspaceFor(agentId), { agentId });
	const res = await tool.execute("gateway", params as never);
	return res.details;
}
