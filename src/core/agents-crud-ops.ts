/**
 * Agent CRUD behind the `agents.add` / `agents.delete` / `agents.set-identity`
 * gateway RPCs — reachable from a remote client.
 *
 * Reuses the `manage_agent` tool (which itself wraps `brigade agents
 * add/delete/set-identity`): its `execute()` is ctx-free (owner-gating is a
 * session wrapper, not inside execute), so invoking it from the gateway is
 * correct + identical to a turn. add seeds a workspace + brigade.json entry
 * atomically with rollback; delete soft-deletes to `.brigade-trash/`. Operator-
 * scoped (no per-session guard — allowlisted in the guard-sweep).
 */

import { makeManageAgentTool } from "../agents/tools/manage-agent-tool.js";

async function runManageAgent(args: Record<string, unknown>): Promise<unknown> {
	const tool = makeManageAgentTool();
	const res = await tool.execute("gateway", args as never);
	return res.details;
}

export async function handleAgentsAdd(params: unknown): Promise<unknown> {
	return runManageAgent({ ...((params ?? {}) as Record<string, unknown>), action: "add" });
}
export async function handleAgentsDelete(params: unknown): Promise<unknown> {
	return runManageAgent({ ...((params ?? {}) as Record<string, unknown>), action: "delete" });
}
export async function handleAgentsSetIdentity(params: unknown): Promise<unknown> {
	return runManageAgent({ ...((params ?? {}) as Record<string, unknown>), action: "set-identity" });
}
