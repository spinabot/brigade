/**
 * `agents_list` tool — read-only enumeration of agents the caller can target.
 *
 * Brand-scrubbed port of the reference codebase's `src/agents/tools/agents-list-tool.ts`.
 * Same shape (empty params, `{requester, allowAny, agents[]}` return) adapted
 * to Brigade's keyed-map `cfg.agents` (vs the reference's array `cfg.agents.list`).
 *
 * Posture (mirrors the reference): the model can READ the agent catalog but
 * CANNOT create / delete / mutate agents. Mutation is operator-only via
 * `brigade agents add/delete/...` CLI. The tool's existence + description
 * steer the model toward "ask the operator" instead of hand-editing
 * brigade.json (which produces orphan dirs + missing persona files every time).
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

import { listAgentEntries } from "../../cli/commands/agents-config.js";
import { loadConfig } from "../../core/config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { jsonResult } from "./common.js";
import type { BrigadeTool } from "./types.js";

const AgentsListParams = Type.Object({});

interface AgentsListEntry {
	id: string;
	name?: string;
	configured: boolean;
}

interface AgentsListResult {
	requester: string;
	allowAny: boolean;
	agents: AgentsListEntry[];
}

export interface MakeAgentsListToolOptions {
	/** Caller's agent id (so the requester field is accurate). */
	requesterAgentId?: string;
}

export function makeAgentsListTool(
	opts: MakeAgentsListToolOptions = {},
): BrigadeTool<typeof AgentsListParams, AgentsListResult> {
	return {
		name: "agents_list",
		label: "Agents",
		description:
			"List Brigade agents you can target with `sessions_send({agentId, message})` or `sessions_spawn({runtime:\"subagent\"})`. Returns {requester, allowAny, agents[{id, name?, configured}]}. Read-only — to CREATE or DELETE agents, ask the operator to run `brigade agents add <name>` / `brigade agents delete <id> --force`. Do NOT hand-edit brigade.json — the CLI does this atomically with proper rollback.",
		parameters: AgentsListParams,
		execute: async (_toolCallId: string): Promise<AgentToolResult<AgentsListResult>> => {
			const cfg = loadConfig();
			const requesterAgentId = normalizeAgentId(opts.requesterAgentId ?? DEFAULT_AGENT_ID);

			// Brigade adaptation: cfg.agents is a KEYED MAP. Pull non-defaults
			// entries via listAgentEntries (the same helper `agents list` uses).
			const entries = listAgentEntries(cfg);
			const configuredIds = entries.map((e) => normalizeAgentId(e.id));
			const nameMap = new Map<string, string>();
			for (const { id, entry } of entries) {
				const name = typeof entry.name === "string" ? entry.name.trim() : "";
				if (name) nameMap.set(normalizeAgentId(id), name);
			}

			// Subagent allowlist — mirror the reference's
			// `subagents.allowAgents` shape. Present on a per-agent entry
			// or on `cfg.agents.defaults.subagents.allowAgents`. Absent =
			// allow only the requester (self).
			const allowAgents = resolveAllowAgents(cfg, requesterAgentId);
			const allowAny = allowAgents.some((v) => v.trim() === "*");
			const allowSet = new Set(
				allowAgents
					.filter((v) => v.trim() && v.trim() !== "*")
					.map((v) => normalizeAgentId(v)),
			);

			const allowed = new Set<string>();
			allowed.add(requesterAgentId);
			if (allowAny) {
				for (const id of configuredIds) allowed.add(id);
			} else {
				for (const id of allowSet) allowed.add(id);
			}

			const rest = Array.from(allowed)
				.filter((id) => id !== requesterAgentId)
				.sort((a, b) => a.localeCompare(b));
			const ordered = [requesterAgentId, ...rest];

			const agents: AgentsListEntry[] = ordered.map((id) => {
				const name = nameMap.get(id);
				const configured = configuredIds.includes(id) || id === DEFAULT_AGENT_ID;
				const entry: AgentsListEntry = { id, configured };
				if (name) entry.name = name;
				return entry;
			});

			return jsonResult({ requester: requesterAgentId, allowAny, agents }) as AgentToolResult<AgentsListResult>;
		},
	};
}

/**
 * Resolve `subagents.allowAgents` with per-agent override → defaults fallback.
 * Returns `[]` (no peers) when neither is configured. Matches the reference's
 * resolution order.
 */
function resolveAllowAgents(cfg: unknown, agentId: string): string[] {
	const agents = (cfg as { agents?: Record<string, unknown> } | undefined)?.agents;
	if (!agents || typeof agents !== "object") return [];
	const entry = agents[agentId] as { subagents?: { allowAgents?: string[] } } | undefined;
	const perAgent = entry?.subagents?.allowAgents;
	if (Array.isArray(perAgent)) return perAgent.filter((v): v is string => typeof v === "string");
	const defaults = agents.defaults as { subagents?: { allowAgents?: string[] } } | undefined;
	const fallback = defaults?.subagents?.allowAgents;
	if (Array.isArray(fallback)) return fallback.filter((v): v is string => typeof v === "string");
	return [];
}
