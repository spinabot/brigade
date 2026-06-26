/**
 * Agent routing-binding operations behind the `agents.*` gateway RPCs — the
 * `brigade agents <bindings|bind|unbind>` surface, reachable from a remote
 * client.
 *
 * These are the genuine no-other-path gap: agent ADD/DELETE/SET-IDENTITY are
 * already reachable over the gateway via the `manage_agent` tool (a prompt), but
 * routing bindings (which agent owns which channel/account) had no remote path
 * at all. This module closes that.
 *
 * OPERATOR-SCOPED config mutations (which agent routes which channel) — not
 * session-targeted, so no per-session access guard (allowlisted by name in the
 * guard-sweep). Reuses the SAME binding domain primitives the CLI calls, so
 * `brigade agents bind` and `agents.bind` over the wire behave identically,
 * including conflict detection (a slot already owned by another agent).
 */

import {
	type AgentRouteBinding,
	applyAgentBindings,
	describeBinding,
	listRouteBindings,
	parseBindingSpecs,
	removeAgentBindings,
} from "../cli/commands/agents-bindings.js";
import type { BrigadeConfig } from "../config/io.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../agents/routing/session-key.js";
import { loadConfig, saveConfig } from "./config.js";

/** Lightweight existence check — `main` always exists; otherwise a configured entry. */
function hasAgent(cfg: BrigadeConfig, agentId: string): boolean {
	if (agentId === DEFAULT_AGENT_ID) return true;
	const agents = (cfg.agents ?? {}) as Record<string, unknown>;
	return agentId !== "defaults" && agentId in agents;
}

function conflictLines(conflicts: ReadonlyArray<{ binding: AgentRouteBinding; existingAgentId: string }>): string[] {
	return conflicts.map((c) => `${describeBinding(c.binding)} (owned by ${c.existingAgentId})`);
}

export interface AgentsBindingsResult {
	bindings: Array<{ agentId: string; description: string }>;
}
export function handleAgentsBindings(params: unknown): AgentsBindingsResult {
	const p = (params ?? {}) as { agentId?: string };
	const cfg = loadConfig();
	const filter = p.agentId?.trim() ? normalizeAgentId(p.agentId) : null;
	const bindings = listRouteBindings(cfg)
		.filter((b) => !filter || normalizeAgentId(b.agentId) === filter)
		.map((b) => ({ agentId: normalizeAgentId(b.agentId), description: describeBinding(b) }));
	return { bindings };
}

export interface AgentsBindResult {
	ok: boolean;
	agentId: string;
	added: string[];
	updated: string[];
	skipped: string[];
	conflicts: string[];
	errors?: string[];
}
export function handleAgentsBind(params: unknown): AgentsBindResult {
	const p = (params ?? {}) as { agentId?: string; specs?: string[] };
	const cfg = loadConfig();
	const agentId = normalizeAgentId(p.agentId ?? DEFAULT_AGENT_ID);
	const fail = (errors: string[]): AgentsBindResult => ({
		ok: false,
		agentId,
		added: [],
		updated: [],
		skipped: [],
		conflicts: [],
		errors,
	});
	if (!hasAgent(cfg, agentId)) return fail([`agent "${agentId}" not found`]);
	const specs = (p.specs ?? []).map((s) => String(s).trim()).filter(Boolean);
	if (specs.length === 0) return fail(["provide at least one binding spec, e.g. \"whatsapp\" or \"slack:T123\""]);
	// channels omitted → skip channel-name validation (an operator RPC; a client
	// can validate against `system.capabilities`). An unknown channel just yields
	// an inert binding rather than a hard error.
	const parsed = parseBindingSpecs({ agentId, specs, config: cfg });
	if (parsed.errors.length > 0) return fail(parsed.errors);
	const result = applyAgentBindings(cfg, parsed.bindings);
	if (result.added.length > 0 || result.updated.length > 0) saveConfig(result.config);
	return {
		ok: result.conflicts.length === 0,
		agentId,
		added: result.added.map(describeBinding),
		updated: result.updated.map(describeBinding),
		skipped: result.skipped.map(describeBinding),
		conflicts: conflictLines(result.conflicts),
	};
}

export interface AgentsUnbindResult {
	ok: boolean;
	agentId: string;
	removed: string[];
	missing: string[];
	conflicts: string[];
	errors?: string[];
}
export function handleAgentsUnbind(params: unknown): AgentsUnbindResult {
	const p = (params ?? {}) as { agentId?: string; specs?: string[]; all?: boolean };
	const cfg = loadConfig();
	const agentId = normalizeAgentId(p.agentId ?? DEFAULT_AGENT_ID);
	const fail = (errors: string[]): AgentsUnbindResult => ({
		ok: false,
		agentId,
		removed: [],
		missing: [],
		conflicts: [],
		errors,
	});
	if (!hasAgent(cfg, agentId)) return fail([`agent "${agentId}" not found`]);
	if (p.all) {
		const existing = listRouteBindings(cfg);
		const removed = existing.filter((b) => normalizeAgentId(b.agentId) === agentId);
		const kept = existing.filter((b) => normalizeAgentId(b.agentId) !== agentId);
		if (removed.length > 0) saveConfig({ ...cfg, bindings: { entries: kept } });
		return { ok: true, agentId, removed: removed.map(describeBinding), missing: [], conflicts: [] };
	}
	const specs = (p.specs ?? []).map((s) => String(s).trim()).filter(Boolean);
	if (specs.length === 0) return fail(["provide at least one binding spec, or pass all:true"]);
	// channels omitted → skip channel-name validation (an operator RPC; a client
	// can validate against `system.capabilities`). An unknown channel just yields
	// an inert binding rather than a hard error.
	const parsed = parseBindingSpecs({ agentId, specs, config: cfg });
	if (parsed.errors.length > 0) return fail(parsed.errors);
	const result = removeAgentBindings(cfg, parsed.bindings);
	if (result.removed.length > 0) saveConfig(result.config);
	return {
		ok: result.conflicts.length === 0,
		agentId,
		removed: result.removed.map(describeBinding),
		missing: result.missing.map(describeBinding),
		conflicts: conflictLines(result.conflicts),
	};
}
