/**
 * `agents_list` tool — read-only enumeration of EVERY configured Brigade agent.
 *
 * Single-source-of-truth design: the catalog itself is unfiltered — the
 * model sees every agent that exists in `cfg.agents` (defaults excluded).
 * Reachability is surfaced as per-row flags so the model can reason about
 * what to do with each agent without having to call additional tools.
 *
 * Contract:
 *
 *   {
 *     requester: string,
 *     agents: [{
 *       id: string,
 *       name?: string,
 *       configured: boolean,    // id is materialised in cfg.agents
 *       self?: boolean,         // true on the caller row (placed FIRST)
 *       canSpawn: boolean,      // id in subagents.allowAgents (or '*')
 *       canSend: boolean,       // A2A policy allows (caller → id)
 *     }, ...]
 *   }
 *
 * The caller row is ALWAYS first and marked `self: true`. Remaining rows
 * are configured agents in alphabetical order. The two reachability gates
 * — spawn-allowlist (`subagents.allowAgents`) and A2A policy
 * (`cfg.session.agentToAgent`) — are evaluated per row so the model can
 * tell at a glance which peers it may delegate to vs. spawn as a
 * subagent.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

import { listAgentEntries } from "../../cli/commands/agents-config.js";
import { loadConfig } from "../../core/config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { jsonResult } from "./common.js";
import { createAgentToAgentPolicy } from "./sessions/shared.js";
import type { BrigadeTool } from "./types.js";

const AgentsListParams = Type.Object({});

interface AgentsListEntry {
	id: string;
	name?: string;
	configured: boolean;
	self?: boolean;
	canSpawn: boolean;
	canSend: boolean;
}

interface AgentsListResult {
	requester: string;
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
			"List EVERY agent currently configured. canSpawn/canSend flags tell you what is actually reachable. CALL THIS for any who/which/how-many agents question — never enumerate from memory.",
		parameters: AgentsListParams,
		execute: async (_toolCallId: string): Promise<AgentToolResult<AgentsListResult>> => {
			const cfg = loadConfig();
			const requesterAgentId = normalizeAgentId(opts.requesterAgentId ?? DEFAULT_AGENT_ID);

			// Brigade's cfg.agents is a KEYED MAP. Pull non-defaults entries via
			// the same helper the `agents list` CLI uses; this is what powers
			// `configured: true` for every row.
			const entries = listAgentEntries(cfg);
			const configuredIds = new Set<string>();
			const nameMap = new Map<string, string>();
			for (const { id, entry } of entries) {
				const normId = normalizeAgentId(id);
				configuredIds.add(normId);
				const name = typeof entry.name === "string" ? entry.name.trim() : "";
				if (name) nameMap.set(normId, name);
			}

			// Spawn-allowlist resolution (subagents.allowAgents). Per-agent
			// override → defaults fallback → empty. `*` is the wildcard.
			const spawnAllow = resolveSpawnAllowAgents(cfg, requesterAgentId);
			const spawnAllowAny = spawnAllow.some((v) => v.trim() === "*");
			const spawnAllowSet = new Set(
				spawnAllow
					.filter((v) => v.trim() && v.trim() !== "*")
					.map((v) => normalizeAgentId(v)),
			);
			const canSpawnTarget = (id: string): boolean =>
				spawnAllowAny || spawnAllowSet.has(id);

			// A2A policy resolution (cfg.session.agentToAgent). brigade.json
			// stores `{from, to}` pairs — flatten to a single allow list (the
			// matcher checks both directions internally; see
			// `createAgentToAgentPolicy` in tools/sessions/shared.ts).
			const a2aRaw = (cfg as {
				session?: {
					agentToAgent?: {
						enabled?: boolean;
						allow?: Array<{ from?: unknown; to?: unknown }>;
					};
				};
			}).session?.agentToAgent;
			const a2aAllow: string[] = [];
			if (Array.isArray(a2aRaw?.allow)) {
				for (const pair of a2aRaw?.allow ?? []) {
					const from = typeof pair?.from === "string" ? pair.from.trim() : "";
					const to = typeof pair?.to === "string" ? pair.to.trim() : "";
					if (from) a2aAllow.push(from);
					if (to) a2aAllow.push(to);
				}
			}
			const a2aPolicy = createAgentToAgentPolicy({
				enabled: !!a2aRaw?.enabled,
				allow: a2aAllow,
			});

			// Build the caller row first so it leads the output and so its
			// `configured` flag accounts for the "default agent always exists"
			// rule.
			const requesterConfigured =
				configuredIds.has(requesterAgentId) || requesterAgentId === DEFAULT_AGENT_ID;
			const requesterRow: AgentsListEntry = {
				id: requesterAgentId,
				configured: requesterConfigured,
				self: true,
				// Self-send and self-spawn are always permitted (the A2A policy
				// short-circuits `requester === target`; spawn-on-self is a
				// no-op that the runtime allows so the model isn't gated on
				// trivial cases).
				canSpawn: true,
				canSend: true,
			};
			const requesterName = nameMap.get(requesterAgentId);
			if (requesterName) requesterRow.name = requesterName;

			// Every other configured agent — alphabetical. NO allowlist
			// filtering for visibility; reachability lives in the flags.
			const peerIds = [...configuredIds]
				.filter((id) => id !== requesterAgentId)
				.sort((a, b) => a.localeCompare(b));
			const peers: AgentsListEntry[] = peerIds.map((id) => {
				const row: AgentsListEntry = {
					id,
					configured: true,
					canSpawn: canSpawnTarget(id),
					canSend: a2aPolicy.isAllowed(requesterAgentId, id),
				};
				const name = nameMap.get(id);
				if (name) row.name = name;
				return row;
			});

			return jsonResult({
				requester: requesterAgentId,
				agents: [requesterRow, ...peers],
			}) as AgentToolResult<AgentsListResult>;
		},
	};
}

/**
 * Resolve `subagents.allowAgents` with per-agent override → defaults fallback.
 * Returns `[]` (no peers) when neither is configured.
 */
function resolveSpawnAllowAgents(cfg: unknown, agentId: string): string[] {
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
