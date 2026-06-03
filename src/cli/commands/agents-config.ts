/**
 * Shared CRUD helper layer for the `brigade agents <list|add|delete|...>`
 * subcommand family. Brand-scrubbed analogue of the reference codebase's
 * `src/commands/agents.config.ts` — same caller-facing surface
 * (`AgentSummary` / `buildAgentSummaries` / `applyAgentConfig` / `pruneAgentConfig`)
 * adapted to Brigade's keyed-map `cfg.agents` shape (vs. the reference's
 * ordered `cfg.agents.list[]` array).
 */

import fs from "node:fs";
import path from "node:path";

import type {
	AgentConfig,
	BindingEntry,
	BrigadeConfig,
} from "../../config/io.js";
import {
	DEFAULT_AGENT_ID,
	resolveAgentDir,
	resolveAgentWorkspaceDir,
} from "../../config/paths.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
	type BrigadeAgentIdentity,
	identityHasValues,
	loadAgentIdentity,
	parseIdentityMarkdown,
} from "../../agents/identity-file.js";
import { listBindings } from "../../agents/routing/bindings.js";
import { normalizeAgentId } from "../../agents/routing/session-key.js";

// Re-export so existing consumers (`agents-cmd.ts`, tests) keep working
// without touching their imports — same shape as the reference codebase's
// `agents.config.ts` re-export from `src/agents/identity-file.ts`.
export { type BrigadeAgentIdentity, identityHasValues, loadAgentIdentity, parseIdentityMarkdown };

/** Per-agent entry shape — Brigade's `AgentConfig` plus the fields the CRUD layer reads / writes. */
export type BrigadeAgentEntry = AgentConfig & {
	name?: string;
	model?: string | { primary?: string; fallbacks?: string[] };
	agentDir?: string;
	provider?: string;
	identity?: BrigadeAgentIdentity;
};

/** Row shape used by `agents list` / JSON output. */
export interface AgentSummary {
	id: string;
	name?: string;
	identityName?: string;
	identityEmoji?: string;
	identitySource?: "identity" | "config";
	workspace: string;
	agentDir: string;
	model?: string;
	provider?: string;
	bindings: number;
	bindingDetails?: string[];
	routes?: string[];
	providers?: string[];
	isDefault: boolean;
}

/** Enumerate the non-reserved entries in `cfg.agents`. */
export function listAgentEntries(
	cfg: BrigadeConfig | undefined | null,
): Array<{ id: string; entry: BrigadeAgentEntry }> {
	const agents = cfg?.agents as Record<string, unknown> | undefined;
	if (!agents || typeof agents !== "object") return [];
	const out: Array<{ id: string; entry: BrigadeAgentEntry }> = [];
	for (const key of Object.keys(agents)) {
		if (key === "defaults") continue;
		if (!key.trim()) continue;
		const value = agents[key];
		if (value === undefined || value === null || typeof value !== "object") continue;
		out.push({ id: key.trim(), entry: value as BrigadeAgentEntry });
	}
	return out;
}

/** Look up an entry by id; returns -1 if no match. */
export function findAgentEntryIndex(
	entries: Array<{ id: string; entry: BrigadeAgentEntry }>,
	agentId: string,
): number {
	const target = normalizeAgentId(agentId);
	return entries.findIndex((e) => normalizeAgentId(e.id) === target);
}

/** Has-key sibling — Brigade's keyed-map analogue of the reference's index check. */
export function hasAgentEntry(cfg: BrigadeConfig, agentId: string): boolean {
	return findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0;
}

/** Read a single entry by id, skipping the reserved 'defaults' key. */
export function getAgentEntry(
	cfg: BrigadeConfig,
	agentId: string,
): BrigadeAgentEntry | undefined {
	const target = normalizeAgentId(agentId);
	for (const e of listAgentEntries(cfg)) {
		if (normalizeAgentId(e.id) === target) return e.entry;
	}
	return undefined;
}

/** First non-empty string from string-or-{primary} model field. */
function primaryModelString(model: unknown): string | undefined {
	if (typeof model === "string" && model.trim().length > 0) return model.trim();
	if (model && typeof model === "object") {
		const p = (model as { primary?: unknown }).primary;
		if (typeof p === "string" && p.trim().length > 0) return p.trim();
	}
	return undefined;
}

/** Resolve effective model id for an agent (entry override → cfg.agents.defaults.model.primary). */
function resolveAgentModel(cfg: BrigadeConfig, agentId: string): string | undefined {
	const entry = getAgentEntry(cfg, agentId);
	const entryPrimary = primaryModelString(entry?.model);
	if (entryPrimary) return entryPrimary;
	const defaults = (cfg.agents as { defaults?: { model?: unknown } } | undefined)?.defaults;
	return primaryModelString(defaults?.model);
}

/** Resolve effective provider id for an agent (entry override → cfg.agents.defaults.provider). */
function resolveAgentProvider(cfg: BrigadeConfig, agentId: string): string | undefined {
	const entry = getAgentEntry(cfg, agentId);
	if (typeof entry?.provider === "string" && entry.provider.trim().length > 0) {
		return entry.provider.trim();
	}
	const defaults = (cfg.agents as { defaults?: { provider?: unknown } } | undefined)?.defaults;
	const p = defaults?.provider;
	if (typeof p === "string" && p.trim().length > 0) return p.trim();
	return undefined;
}

/** Trim + collapse-undefined helper used for the AgentSummary name field. */
function trimOrUndef(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

/**
 * Build one row per configured agent (or the default agent stub when no
 * explicit entries exist). Bindings counts are tallied once across all
 * `cfg.bindings.entries[]`.
 */
export function buildAgentSummaries(cfg: BrigadeConfig): AgentSummary[] {
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	const configured = listAgentEntries(cfg);
	const orderedIds =
		configured.length > 0
			? configured.map((e) => normalizeAgentId(e.id))
			: [defaultId];

	const counts = new Map<string, number>();
	for (const b of listBindings(cfg)) {
		const id = normalizeAgentId(b.agentId);
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}

	const ordered = orderedIds.filter((id, i) => orderedIds.indexOf(id) === i);

	return ordered.map((id) => {
		const workspace = resolveAgentWorkspaceDir(id);
		const identity = loadAgentIdentity(workspace);
		const configEntry = configured.find((e) => normalizeAgentId(e.id) === id)?.entry;
		const configIdentity = configEntry?.identity;
		const identityName = identity?.name ?? trimOrUndef(configIdentity?.name);
		const identityEmoji = identity?.emoji ?? trimOrUndef(configIdentity?.emoji);
		const identitySource: AgentSummary["identitySource"] = identity
			? "identity"
			: configIdentity && (identityName || identityEmoji)
				? "config"
				: undefined;

		const summary: AgentSummary = {
			id,
			isDefault: id === defaultId,
			workspace,
			agentDir: resolveAgentDir(id),
			bindings: counts.get(id) ?? 0,
		};
		const name = trimOrUndef(configEntry?.name);
		if (name) summary.name = name;
		if (identityName) summary.identityName = identityName;
		if (identityEmoji) summary.identityEmoji = identityEmoji;
		if (identitySource) summary.identitySource = identitySource;
		const model = resolveAgentModel(cfg, id);
		if (model) summary.model = model;
		const provider = resolveAgentProvider(cfg, id);
		if (provider) summary.provider = provider;
		return summary;
	});
}

/**
 * Upsert one agent entry into `cfg.agents`. Returns a NEW config (immutable
 * — callers persist via `saveConfig`). The merge is shallow on top-level
 * fields and deep on the `identity` sub-object so callers can patch one
 * identity field without dropping the others.
 *
 * When the map has zero entries and the upsert target is not the default
 * agent, a stub for the default id is also created so the default never
 * silently disappears (mirrors the reference's preserve-default guard).
 */
export function applyAgentConfig(
	cfg: BrigadeConfig,
	params: {
		agentId: string;
		name?: string;
		workspace?: string;
		agentDir?: string;
		model?: string | { primary?: string; fallbacks?: string[] };
		provider?: string;
		identity?: BrigadeAgentIdentity;
	},
): BrigadeConfig {
	const agentId = normalizeAgentId(params.agentId);
	const trimmedName = params.name?.trim();
	const existingAgents = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const baseRaw = existingAgents[agentId];
	const base: BrigadeAgentEntry =
		baseRaw && typeof baseRaw === "object" && !Array.isArray(baseRaw)
			? (baseRaw as BrigadeAgentEntry)
			: {};
	const mergedIdentity = params.identity
		? { ...(base.identity ?? {}), ...params.identity }
		: base.identity;

	// C1: server.ts boot loop reads `entry.model.primary` — a bare string
	// would be silently skipped. Normalize {primary} for object writes;
	// pass through object form unchanged.
	let modelPatch: BrigadeAgentEntry["model"] | undefined;
	if (typeof params.model === "string") {
		const trimmedModel = params.model.trim();
		if (trimmedModel) modelPatch = { primary: trimmedModel };
	} else if (params.model && typeof params.model === "object") {
		modelPatch = params.model;
	}

	const nextEntry: BrigadeAgentEntry = {
		...base,
		...(trimmedName ? { name: trimmedName } : {}),
		...(params.workspace ? { workspace: params.workspace } : {}),
		...(params.agentDir ? { agentDir: params.agentDir } : {}),
		...(modelPatch ? { model: modelPatch } : {}),
		...(params.provider ? { provider: params.provider } : {}),
		...(mergedIdentity ? { identity: mergedIdentity } : {}),
	};

	const nextAgents: Record<string, unknown> = { ...existingAgents };
	const hadAnyEntries = listAgentEntries(cfg).length > 0;
	const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
	if (!hadAnyEntries && agentId !== defaultId && !(defaultId in nextAgents)) {
		nextAgents[defaultId] = {};
	}
	nextAgents[agentId] = nextEntry;

	return {
		...cfg,
		agents: nextAgents as BrigadeConfig["agents"],
	};
}

/**
 * Remove one agent entry plus every `cfg.bindings.entries[]` that targets it
 * and every `cfg.session.agentToAgent.allow[]` pair that names it on either
 * side. Returns a NEW config plus the counts of removed bindings / pairs.
 *
 * Also strips the id from every `subagents.allowAgents` list — the
 * `defaults.subagents.allowAgents` shared roster AND any per-agent
 * `cfg.agents.<other>.subagents.allowAgents` override. This is the
 * symmetric cleanup for `runAgentsAdd`'s `applyAutoAllowOnCreate` seed:
 * without it, deleting an agent leaves a dangling reference in the
 * allowlist that `agents_list` would render as `configured:false`.
 */
export function pruneAgentConfig(
	cfg: BrigadeConfig,
	agentId: string,
): { config: BrigadeConfig; removedBindings: number; removedAllow: number } {
	const id = normalizeAgentId(agentId);

	// Strip the entry from the keyed agents map AND strip the id from any
	// `subagents.allowAgents` list that names it (defaults + per-agent).
	const existingAgents = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const nextAgents: Record<string, unknown> = {};
	for (const key of Object.keys(existingAgents)) {
		if (normalizeAgentId(key) === id && key !== "defaults") continue;
		nextAgents[key] = stripAllowAgentsId(existingAgents[key], id);
	}

	// Strip every binding that targets the removed agent.
	const bindings = listBindings(cfg);
	const nextBindings: BindingEntry[] = bindings.filter(
		(b) => normalizeAgentId(b.agentId) !== id,
	);
	const removedBindings = bindings.length - nextBindings.length;

	// Strip every agentToAgent.allow pair that names the removed agent.
	// Brigade's allow matrix is { from, to }[] (vs. the reference's flat
	// string[]); we drop the pair when either side matches the deleted id.
	//
	// Wildcards (`"*"`) are deliberately preserved — `normalizeAgentId("*")`
	// collapses to the default-agent id (because `*` is not a valid id
	// character), which would otherwise silently delete the canonical
	// wide-open default pair seeded by `applyAutoEnableA2AOnAgentCreate`.
	// Compare against the raw string for wildcard detection BEFORE the
	// normalisation step.
	const session = (cfg.session as { agentToAgent?: { allow?: Array<{ from?: unknown; to?: unknown }> } } | undefined);
	const allow = Array.isArray(session?.agentToAgent?.allow) ? session.agentToAgent.allow : [];
	const filteredAllow = allow.filter((pair) => {
		const fromRaw = typeof pair?.from === "string" ? pair.from.trim() : "";
		const toRaw = typeof pair?.to === "string" ? pair.to.trim() : "";
		// Wildcards stay untouched on either side.
		const fromIsWildcard = fromRaw === "*";
		const toIsWildcard = toRaw === "*";
		const fromMatches = !fromIsWildcard && fromRaw !== "" && normalizeAgentId(fromRaw) === id;
		const toMatches = !toIsWildcard && toRaw !== "" && normalizeAgentId(toRaw) === id;
		return !fromMatches && !toMatches;
	});
	const removedAllow = allow.length - filteredAllow.length;

	const nextConfig: BrigadeConfig = { ...cfg, agents: nextAgents as BrigadeConfig["agents"] };

	if (removedBindings > 0 || nextBindings.length !== bindings.length) {
		nextConfig.bindings = nextBindings.length > 0 ? { entries: nextBindings } : { entries: [] };
	}

	if (removedAllow > 0) {
		const nextSession = { ...(cfg.session ?? {}) } as Record<string, unknown>;
		const a2a = { ...(session?.agentToAgent ?? {}) } as Record<string, unknown>;
		a2a.allow = filteredAllow;
		nextSession.agentToAgent = a2a;
		nextConfig.session = nextSession as BrigadeConfig["session"];
	}

	return { config: nextConfig, removedBindings, removedAllow };
}

/**
 * Return a shallow-cloned `agents.<key>` entry with the deleted agent id
 * removed from its `subagents.allowAgents` list (if present). Used by
 * `pruneAgentConfig` to keep the allowlist symmetric with
 * `applyAutoAllowOnCreate`. The `"*"` wildcard is left untouched.
 *
 * Non-object entries pass through unchanged so the `defaults` key (which
 * carries the shared `subagents.allowAgents`) and any peer agent entries
 * are both swept by the same code path.
 */
function stripAllowAgentsId(entry: unknown, id: string): unknown {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
	const obj = entry as Record<string, unknown>;
	const subagentsRaw = obj["subagents"];
	if (!subagentsRaw || typeof subagentsRaw !== "object" || Array.isArray(subagentsRaw)) {
		return entry;
	}
	const subagents = subagentsRaw as Record<string, unknown>;
	const allowRaw = subagents["allowAgents"];
	if (!Array.isArray(allowRaw)) return entry;
	const filtered = allowRaw.filter(
		(v) => typeof v !== "string" || normalizeAgentId(v) !== id,
	);
	if (filtered.length === allowRaw.length) return entry;
	const nextSubagents: Record<string, unknown> = { ...subagents, allowAgents: filtered };
	return { ...obj, subagents: nextSubagents };
}

/** Re-export the canonical default agent id so call sites don't need a second import. */
export { DEFAULT_AGENT_ID };
