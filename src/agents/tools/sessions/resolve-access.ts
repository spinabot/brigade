/**
 * Session-tool access policy resolution from a config snapshot.
 *
 * Extracted from `agent-loop.ts` (2026-06-11) so BOTH the per-turn toolset
 * build AND the `sessions_send` LIVE re-check derive the policy identically.
 *
 * Why the live re-check exists: the agent loop captures the access policy
 * ONCE at run start and freezes it into the sessions tools. When the model
 * calls `manage_access` to enable cross-agent messaging and then immediately
 * retries `sessions_send` IN THE SAME RUN, the frozen policy still says
 * "denied" — the change only reached `brigade.json`, not the in-memory
 * closure. The operator saw "still blocked, try a gateway restart" (the
 * model's wrong inference). `sessions_send` now re-resolves from CURRENT
 * config on a denial, so a mid-run enable takes effect on the next call
 * without any restart. This module is the single source of that derivation.
 */

import { resolveDefaultAgentId } from "../../agent-scope.js";
import { deriveOrgGraph } from "../../org/derive-graph.js";
import { orgGraphAsA2APolicy } from "../../org/a2a-adapter.js";
import {
	createAgentToAgentPolicy,
	type AgentToAgentPolicy,
	type SessionToolsVisibility,
} from "./shared.js";

export interface ResolvedSessionAccess {
	visibility: SessionToolsVisibility;
	a2aPolicy: AgentToAgentPolicy;
}

/**
 * Resolve `{ visibility, a2aPolicy }` from a Brigade config snapshot.
 *
 * Mirrors the legacy agent-loop block exactly: visibility defaults to
 * "self"; the flat `session.agentToAgent.allow` `{from,to}` pairs flatten to
 * a union of ids for the matcher; and when `cfg.org` is present with a mode
 * OTHER than "explicit", the org-graph policy supersedes the flat allow
 * matrix (explicit / no-org keep the flat policy — same contract Stage C
 * shipped). Uses `deriveOrgGraph` (POLICY derivation — explicit → undefined
 * → flat fallback), NEVER `deriveOrgDisplayGraph`.
 */
export function resolveSessionAccessPolicy(cfg: unknown): ResolvedSessionAccess {
	const c = cfg as {
		session?: {
			sessionTools?: { visibility?: SessionToolsVisibility };
			agentToAgent?: { enabled?: boolean; allow?: Array<{ from?: unknown; to?: unknown }> };
		};
		org?: { a2a?: { mode?: string } };
	};
	const visibility: SessionToolsVisibility = c.session?.sessionTools?.visibility ?? "self";
	const a2aRaw = c.session?.agentToAgent;
	const a2aAllow: string[] = [];
	if (Array.isArray(a2aRaw?.allow)) {
		for (const pair of a2aRaw.allow) {
			const from = typeof pair?.from === "string" ? pair.from.trim() : "";
			const to = typeof pair?.to === "string" ? pair.to.trim() : "";
			if (from) a2aAllow.push(from);
			if (to) a2aAllow.push(to);
		}
	}
	let a2aPolicy = createAgentToAgentPolicy({ enabled: !!a2aRaw?.enabled, allow: a2aAllow });
	const orgCfg = c.org;
	if (orgCfg && orgCfg.a2a?.mode !== "explicit") {
		const graph = deriveOrgGraph(cfg as never);
		if (graph) {
			// Orchestrator bypass: the operator's DEFAULT agent is the
			// operator's own voice, not a chart member — in derived mode the
			// graph used to hard-refuse it as a non-member, so "ask eng-lead
			// if they're up for work" from main was forbidden out of the box
			// and the model offered to flip the whole org to explicit mode.
			// Pairs touching the default agent bypass the chart; everyone
			// else stays graph-governed. Lockdown installs opt out with
			// `org.a2a.restrictDefaultAgent: true`.
			const restrict =
				(orgCfg.a2a as { restrictDefaultAgent?: unknown } | undefined)
					?.restrictDefaultAgent === true;
			a2aPolicy = orgGraphAsA2APolicy(
				graph,
				restrict ? {} : { orchestratorId: resolveDefaultAgentId(cfg as never) },
			);
		}
	}
	return { visibility, a2aPolicy };
}
