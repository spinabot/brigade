/**
 * Skill authoring behind the `skills.create` / `skills.delete` /
 * `skills.write-file` gateway RPCs — reachable from a remote client.
 *
 * Skills are SKILL.md files on disk (NOT config), so `config.set` can't author
 * them; `skills.status`/`skills.install`/`skills.update` already cover read /
 * install / enable. These close create/delete/support-file. Reuses the
 * `manage_skill` tool (ctx-free execute, owner-gated via wrapper). Operator-
 * scoped (no per-session guard — allowlisted in the guard-sweep).
 */

import { DEFAULT_AGENT_ID } from "../agents/routing/session-key.js";
import { makeManageSkillTool } from "../agents/tools/manage-skill-tool.js";

async function runManageSkill(args: Record<string, unknown>): Promise<unknown> {
	const requesterAgentId =
		typeof args.agentId === "string" && args.agentId.trim().length > 0 ? args.agentId : DEFAULT_AGENT_ID;
	const tool = makeManageSkillTool({ requesterAgentId });
	const res = await tool.execute("gateway", args as never);
	return res.details;
}

export async function handleSkillsCreate(params: unknown): Promise<unknown> {
	return runManageSkill({ ...((params ?? {}) as Record<string, unknown>), action: "create" });
}
export async function handleSkillsDelete(params: unknown): Promise<unknown> {
	return runManageSkill({ ...((params ?? {}) as Record<string, unknown>), action: "delete" });
}
export async function handleSkillsWriteFile(params: unknown): Promise<unknown> {
	return runManageSkill({ ...((params ?? {}) as Record<string, unknown>), action: "write_file" });
}
