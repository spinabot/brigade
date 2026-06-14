/**
 * `brigade agents <list|bindings|bind|unbind|add|set-identity|delete>` — the
 * seven CRUD command runners that drive the `cfg.agents` keyed map + the
 * `cfg.bindings.entries[]` routing layer.
 *
 * Brand-scrubbed lift of the reference codebase's
 * `src/commands/agents.commands.{list,bind,add,identity,delete}.ts`, adapted
 * to Brigade's surfaces:
 *
 *   - `loadConfig()` / `saveConfig()` from `core/config.ts` (NOT
 *     `replaceConfigFile`). Brigade ships its own write path with restore-
 *     env-var, top-level reordering, backup rotation, and audit logging.
 *   - `cfg.bindings.entries[]` wrapper (NOT a flat `cfg.bindings` array).
 *   - `cfg.agents.<id>` keyed map (NOT `cfg.agents.list[]`).
 *   - `resolveAgentWorkspaceDir(agentId)` / `resolveAgentDir(agentId)` /
 *     `resolveSessionsDir(agentId)` from `config/paths.ts`.
 *   - `DEFAULT_AGENT_ID` ("main") + `normalizeAgentId` from `agents/routing/
 *     session-key.ts`.
 *
 * Interactive prompts (clack wizard, readline confirm) are NOT lifted yet —
 * Brigade has no clack-prompter and the user explicitly opted for "non-
 * interactive first, interactive parity later". Every runner errors clearly
 * when a flag set requires interaction and the flag is missing.
 *
 * Each runner returns an exit code (0 success / 1 failure) — same shape as
 * `src/cli/commands/exec-cmd.ts` — and never calls `process.exit` itself so
 * a higher-level dispatcher can compose them.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { applyAutoEnableA2AOnAgentCreate as canonicalizedApplyAutoEnableA2AOnAgentCreate } from "../../agents/a2a-policy-canonicalize.js";
import { BUNDLED_MODULES, loadModules } from "../../agents/extensions/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listBindings } from "../../agents/routing/bindings.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../agents/routing/session-key.js";
import type { BindingEntry, BrigadeConfig } from "../../config/io.js";
import {
	resolveAgentDir,
	resolveAgentWorkspaceDir,
	resolveSessionsDir,
	resolveStateDir,
} from "../../config/paths.js";
import { loadConfig, saveConfig } from "../../core/config.js";
import { mutateConfigAtomic } from "../../config/io.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { bootstrapWorkspace } from "../../workspace/bootstrap.js";

import {
	applyAgentBindings,
	describeBinding,
	listRouteBindings,
	parseBindingSpecs,
	removeAgentBindings,
	type AgentRouteBinding,
	type BindingChannelDescriptor,
} from "./agents-bindings.js";
import {
	applyAgentConfig,
	buildAgentSummaries,
	findAgentEntryIndex,
	identityHasValues,
	listAgentEntries,
	loadAgentIdentity,
	parseIdentityMarkdown,
	pruneAgentConfig,
	type AgentSummary,
	type BrigadeAgentIdentity,
} from "./agents-config.js";

/* ───────────────────────── runtime + helpers ───────────────────────── */

interface OutputSink {
	log: (message: string) => void;
	error: (message: string) => void;
}

// Words that the connect-mode TUI, gateway, or shell scripting would mistake
// for sentinels ("none" meaning unset, "default" colliding with the cfg
// reserved key, "null"/"undefined" being JS literals). Keep this list short —
// `main` is already covered by DEFAULT_AGENT_ID elsewhere.
const RESERVED_AGENT_IDS = new Set(["none", "null", "undefined", "default", "all", "any"]);

function defaultSink(): OutputSink {
	return {
		log: (m) => process.stdout.write(`${m}\n`),
		error: (m) => process.stderr.write(`${m}\n`),
	};
}

function writeJson(sink: OutputSink, payload: unknown): void {
	sink.log(JSON.stringify(payload, null, 2));
}

/**
 * H2: when --json is set, error paths must emit a parseable JSON envelope
 * to stderr instead of a human-readable line. Returns the original message
 * so callers can keep a single `sink.error(msg)` shape behind a guard.
 */
function emitErrorJson(
	sink: OutputSink,
	opts: { json?: boolean } | undefined,
	message: string,
): void {
	if (opts?.json) {
		sink.error(JSON.stringify({ error: message }));
	} else {
		sink.error(message);
	}
}

/** Best-effort home-relative path renderer — keeps screenshots clean. */
function shortenHomePath(p: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (!home) return p;
	const abs = path.resolve(p);
	const homeAbs = path.resolve(home);
	if (abs === homeAbs) return "~";
	if (abs.startsWith(homeAbs + path.sep)) return `~${abs.slice(homeAbs.length)}`;
	return p;
}

/** Resolve user-typed path (`~`, env vars left literal, relative → cwd). */
function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (trimmed === "~") return home || trimmed;
	if (home && trimmed.startsWith("~/")) return path.resolve(home, trimmed.slice(2));
	return path.resolve(trimmed);
}

/** Look up the bundled channel catalog so parseBindingSpecs can validate. */
async function loadChannelCatalog(): Promise<BindingChannelDescriptor[]> {
	try {
		const config = loadConfig();
		const workspaceDir = resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
		const registry = await loadModules({
			modules: BUNDLED_MODULES,
			meta: { agentId: DEFAULT_AGENT_ID, workspaceDir, cwd: workspaceDir, config: config as never },
		});
		return registry.channels.map((adapter) => ({ id: adapter.id }));
	} catch {
		// Catalog load is best-effort — parseBindingSpecs treats undefined as
		// "skip validation", so binding still works against an empty registry.
		return [];
	}
}

function hasAgent(cfg: BrigadeConfig, agentId: string): boolean {
	return buildAgentSummaries(cfg).some((s) => s.id === agentId);
}

function resolveTargetAgentId(
	cfg: BrigadeConfig,
	agentInput: string | undefined,
	fallbackToDefault: boolean,
): string | null {
	if (agentInput?.trim()) return normalizeAgentId(agentInput);
	if (fallbackToDefault) return normalizeAgentId(resolveDefaultAgentId(cfg));
	return null;
}

function formatBindingOwnerLine(b: AgentRouteBinding): string {
	return `${normalizeAgentId(b.agentId)} <- ${describeBinding(b)}`;
}

function formatBindingConflicts(
	conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>,
): string[] {
	return conflicts.map((c) => `${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
}

/** Render one agent-summary card for the human `agents list` output. */
function formatSummary(summary: AgentSummary): string {
	const defaultTag = summary.isDefault ? " (default)" : "";
	const header =
		summary.name && summary.name !== summary.id
			? `${summary.id}${defaultTag} (${summary.name})`
			: `${summary.id}${defaultTag}`;
	const identityParts: string[] = [];
	if (summary.identityEmoji) identityParts.push(summary.identityEmoji);
	if (summary.identityName) identityParts.push(summary.identityName);
	const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
	const identitySource =
		summary.identitySource === "identity"
			? "IDENTITY.md"
			: summary.identitySource === "config"
				? "config"
				: null;
	const lines = [`- ${header}`];
	if (identityLine) {
		lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
	}
	lines.push(`  Workspace: ${shortenHomePath(summary.workspace)}`);
	lines.push(`  Agent dir: ${shortenHomePath(summary.agentDir)}`);
	if (summary.model) lines.push(`  Model: ${summary.model}`);
	if (summary.provider) lines.push(`  Provider: ${summary.provider}`);
	lines.push(`  Routing rules: ${summary.bindings}`);
	if (summary.bindingDetails?.length) {
		lines.push("  Routing rules:");
		for (const b of summary.bindingDetails) lines.push(`    - ${b}`);
	}
	return lines.join("\n");
}

/**
 * UX-bridge helper: ensure `cfg.session.agentToAgent` carries a usable A2A
 * policy after an `agents add`. Without this, a freshly added agent has the
 * subagent allowlist seed (`applyAutoAllowOnCreate`) but A2A messaging via
 * `sessions_send` still refuses because the policy block is missing /
 * disabled — the model can spawn but cannot ping-pong.
 *
 * Thin wrapper around the shared `canonicalizeA2APolicy` helper
 * (`agents/a2a-policy-canonicalize.ts`) — see that module for the full
 * semantics matrix. Gated by `cfg.session.autoEnableA2AOnAgentCreate`
 * (default `true`); sibling boot-time variant `applyAutoEnableA2AAtBoot`
 * fires inside `continueBoot()`.
 *
 * The companion `pruneAgentConfig` (in agents-config.ts) strips the deleted
 * agent id from any `allow` pair on `agents delete`, so add+delete stay
 * symmetric without a separate code path.
 */
export function applyAutoEnableA2AOnAgentCreate(cfg: BrigadeConfig): BrigadeConfig {
	return canonicalizedApplyAutoEnableA2AOnAgentCreate(cfg);
}

/**
 * UX-bridge helper: extend `cfg.agents.defaults.subagents.allowAgents` with
 * the newly created agent id so it surfaces in the allowlist-scoped
 * `agents_list` tool (and becomes spawn-targetable) without the operator
 * having to know the second config key exists.
 *
 * Skipped when:
 *   - `cfg.agents.defaults.subagents.autoAllowOnCreate === false`
 *     (operator-driven strict allowlist mode — mirrors the reference's
 *     stock posture)
 *   - The list already contains `"*"` (wildcard already covers it)
 *   - The id is already in the list (idempotent re-runs)
 *
 * The companion `pruneAgentConfig` (in agents-config.ts) strips the id on
 * delete so add+delete are symmetric without a separate code path.
 */
/**
 * UX-bridge helper: implicit Pride-org init when `manage_agent({action:"add"})`
 * is called with any org-position field (department / reportsTo / role / bio)
 * AND `cfg.org` is absent.
 *
 * The operator should never have to run `brigade org init` separately just
 * to say "create a CEO" or "create an engineer reporting to main" from chat.
 * If the add carries an org seed, this helper:
 *
 *   1. Seeds `cfg.agents.<addedId>.org = { department?, reportsTo?, role?, bio? }`
 *      from the provided fields.
 *   2. If `cfg.org` is absent, initialises it:
 *        - `cfg.org.topOrder` = the new agent's id IF its reportsTo === null
 *          (operator said "make this one the top"); otherwise defaults to
 *          `main` (the default agent id) and main is auto-seeded as
 *          `{department:"executive", reportsTo:null, role:"Chief of Staff"}`.
 *        - `cfg.org.a2a = { mode: "derived" }`.
 *   3. If `cfg.org` is present, just merges the new agent's org block into
 *      `cfg.agents.<id>.org` (does NOT touch topOrder / a2a / departmentHeads).
 *
 * Opt-out: `cfg.session.autoEnableOrgOnHierarchicalAdd === false` short-
 * circuits the init step (the new agent's org seed still applies, but
 * cfg.org stays absent — strict mode for operators who curate cfg.org
 * by hand).
 *
 * Companion: when the agent is deleted, `pruneAgentConfig` already strips
 * its `cfg.agents.<id>.org` block (cleared with the agent entry). No
 * separate org-position teardown is needed.
 */
export function applyAutoEnableOrgOnHierarchicalAdd(
	cfg: BrigadeConfig,
	agentId: string,
	orgSeed:
		| {
				department?: string;
				reportsTo?: string | null;
				role?: string;
				bio?: string;
		  }
		| undefined,
): BrigadeConfig {
	if (!orgSeed) return cfg;
	const hasAnyOrgField =
		orgSeed.department !== undefined ||
		orgSeed.reportsTo !== undefined ||
		orgSeed.role !== undefined ||
		orgSeed.bio !== undefined;
	if (!hasAnyOrgField) return cfg;

	const id = normalizeAgentId(agentId);
	const sessionRaw = (cfg.session as Record<string, unknown> | undefined) ?? {};
	const autoEnable = sessionRaw["autoEnableOrgOnHierarchicalAdd"];

	const agentsRaw = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const newAgentEntry = agentsRaw[id];
	const newAgentObj =
		newAgentEntry && typeof newAgentEntry === "object" && !Array.isArray(newAgentEntry)
			? (newAgentEntry as Record<string, unknown>)
			: {};

	// Build the new agent's org block from the seed.
	const newAgentOrg: Record<string, unknown> = {};
	if (orgSeed.department !== undefined) newAgentOrg["department"] = orgSeed.department;
	if (orgSeed.reportsTo !== undefined) newAgentOrg["reportsTo"] = orgSeed.reportsTo;
	if (orgSeed.role !== undefined) newAgentOrg["role"] = orgSeed.role;
	if (orgSeed.bio !== undefined) newAgentOrg["bio"] = orgSeed.bio;

	const nextAgentObj = { ...newAgentObj, org: newAgentOrg };
	let nextAgents: Record<string, unknown> = { ...agentsRaw, [id]: nextAgentObj };

	// If cfg.org is already present, just seed the agent block and return.
	const orgRaw = (cfg as { org?: unknown }).org;
	if (orgRaw && typeof orgRaw === "object" && !Array.isArray(orgRaw)) {
		return { ...cfg, agents: nextAgents as BrigadeConfig["agents"] };
	}

	// cfg.org is absent — should we auto-init? Operator opt-out wins.
	if (autoEnable === false) {
		return { ...cfg, agents: nextAgents as BrigadeConfig["agents"] };
	}

	// Decide topOrder. If the new agent has reportsTo === null, the
	// operator clearly intends the new agent to BE the top. Otherwise
	// default to "main" + seed main's org block as Chief of Staff if it
	// doesn't have one already.
	let topOrder: string;
	if (orgSeed.reportsTo === null) {
		topOrder = id;
	} else {
		topOrder = DEFAULT_AGENT_ID;
		// Seed main's org block iff it's not already present.
		const mainRaw = nextAgents[DEFAULT_AGENT_ID];
		const mainObj =
			mainRaw && typeof mainRaw === "object" && !Array.isArray(mainRaw)
				? (mainRaw as Record<string, unknown>)
				: {};
		if (!mainObj["org"] || typeof mainObj["org"] !== "object") {
			const mainOrg = {
				department: "executive",
				reportsTo: null,
				role: "Chief of Staff",
			};
			nextAgents = {
				...nextAgents,
				[DEFAULT_AGENT_ID]: { ...mainObj, org: mainOrg },
			};
		}
	}

	const nextOrg = {
		topOrder,
		a2a: { mode: "derived" },
	};

	return {
		...cfg,
		agents: nextAgents as BrigadeConfig["agents"],
		org: nextOrg,
	} as BrigadeConfig;
}

export function applyAutoAllowOnCreate(cfg: BrigadeConfig, agentId: string): BrigadeConfig {
	const id = normalizeAgentId(agentId);
	const agentsRaw = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const defaultsRaw = agentsRaw["defaults"];
	const defaults =
		defaultsRaw && typeof defaultsRaw === "object" && !Array.isArray(defaultsRaw)
			? (defaultsRaw as Record<string, unknown>)
			: {};
	const subagentsRaw = defaults["subagents"];
	const subagents =
		subagentsRaw && typeof subagentsRaw === "object" && !Array.isArray(subagentsRaw)
			? (subagentsRaw as Record<string, unknown>)
			: {};

	// Operator opted out — leave the allowlist alone.
	if (subagents["autoAllowOnCreate"] === false) return cfg;

	const allowRaw = subagents["allowAgents"];
	const existing = Array.isArray(allowRaw)
		? allowRaw.filter((v): v is string => typeof v === "string")
		: [];
	// Wildcard already covers everything — skip.
	if (existing.some((v) => v.trim() === "*")) return cfg;
	// Already present (idempotent) — skip.
	if (existing.some((v) => normalizeAgentId(v) === id)) return cfg;

	const nextAllow = [...existing, id];
	const nextSubagents: Record<string, unknown> = { ...subagents, allowAgents: nextAllow };
	const nextDefaults: Record<string, unknown> = { ...defaults, subagents: nextSubagents };
	const nextAgents: Record<string, unknown> = { ...agentsRaw, defaults: nextDefaults };
	return { ...cfg, agents: nextAgents as BrigadeConfig["agents"] };
}

/* ───────────────────────── 1. agents list ───────────────────────── */

export async function runAgentsList(
	opts: { json?: boolean; bindings?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents list: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const summaries = buildAgentSummaries(cfg);
	const bindingMap = new Map<string, BindingEntry[]>();
	for (const b of listBindings(cfg)) {
		const id = normalizeAgentId(b.agentId);
		const list = bindingMap.get(id) ?? [];
		list.push(b);
		bindingMap.set(id, list);
	}

	if (opts.bindings) {
		for (const summary of summaries) {
			const bindings = bindingMap.get(summary.id) ?? [];
			if (bindings.length > 0) {
				summary.bindingDetails = bindings.map((b) => describeBinding(b));
			}
		}
	}

	if (opts.json) {
		// Keep the JSON contract as an array of summaries — matches OC's shape
		// and existing machine consumers. Orphans are emitted as a stderr
		// warning only (text path below handles them visibly).
		writeJson(sink, summaries);
		return 0;
	}

	const lines = ["Agents:", ...summaries.map(formatSummary)];
	lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
	const orphanDirs = findOrphanAgentDirs(summaries.map((s) => s.id));
	if (orphanDirs.length > 0) {
		lines.push("");
		lines.push(`⚠ Orphan dirs (on disk but NOT in brigade.json): ${orphanDirs.join(", ")}`);
		lines.push("  Clean up with: rm -rf ~/.brigade/agents/<id>/  (or re-register via `brigade agents add`)");
	}
	sink.log(lines.join("\n"));
	return 0;
}

// Scan ~/.brigade/agents/ for subdirs that look like agent state (have a
// workspace/ child) but whose id is NOT in cfg.agents. Catches half-created
// agents from a partial `agents add` failure, or hand-crafted dirs that
// skipped the CLI. Returns empty when the agents/ dir doesn't exist.
function findOrphanAgentDirs(configuredIds: string[]): string[] {
	const known = new Set(configuredIds);
	const agentsRoot = path.dirname(resolveAgentDir("__probe__"));
	if (!existsSync(agentsRoot)) return [];
	const orphans: string[] = [];
	try {
		const dirents = readdirSync(agentsRoot, { withFileTypes: true });
		for (const ent of dirents) {
			if (!ent.isDirectory()) continue;
			const id = ent.name;
			if (known.has(id)) continue;
			// Only flag dirs that look agent-ish (have a workspace/ subdir).
			const workspaceProbe = path.join(agentsRoot, id, "workspace");
			if (existsSync(workspaceProbe)) {
				orphans.push(id);
			}
		}
	} catch {
		// Best-effort — list shouldn't fail because of a scan error.
	}
	return orphans;
}

/* ───────────────────────── 2. agents bindings ───────────────────────── */

export async function runAgentsBindings(
	opts: { agent?: string; json?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents bindings: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const filterAgentId = opts.agent?.trim() ? normalizeAgentId(opts.agent) : null;
	if (opts.agent && !filterAgentId) {
		emitErrorJson(sink, opts, "Agent id is required.");
		return 1;
	}
	if (filterAgentId && !hasAgent(cfg, filterAgentId)) {
		emitErrorJson(sink, opts, `Agent "${filterAgentId}" not found.`);
		return 1;
	}

	const filtered = listRouteBindings(cfg).filter(
		(b) => !filterAgentId || normalizeAgentId(b.agentId) === filterAgentId,
	);

	if (opts.json) {
		writeJson(
			sink,
			filtered.map((b) => ({
				agentId: normalizeAgentId(b.agentId),
				match: b.match,
				description: describeBinding(b),
			})),
		);
		return 0;
	}

	if (filtered.length === 0) {
		sink.log(filterAgentId ? `No routing bindings for agent "${filterAgentId}".` : "No routing bindings.");
		return 0;
	}

	sink.log(["Routing bindings:", ...filtered.map((b) => `- ${formatBindingOwnerLine(b)}`)].join("\n"));
	return 0;
}

/* ───────────────────────── 3. agents bind ───────────────────────── */

export async function runAgentsBind(
	opts: { agent?: string; bind?: string[]; json?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents bind: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const agentId = resolveTargetAgentId(cfg, opts.agent, true);
	if (!agentId) {
		emitErrorJson(sink, opts, "Unable to resolve agent id.");
		return 1;
	}
	if (!hasAgent(cfg, agentId)) {
		emitErrorJson(sink, opts, `Agent "${agentId}" not found.`);
		return 1;
	}

	const specs = (opts.bind ?? []).map((v) => v.trim()).filter(Boolean);
	if (specs.length === 0) {
		emitErrorJson(sink, opts, "Provide at least one --bind <channel[:accountId]>.");
		return 1;
	}

	const catalog = await loadChannelCatalog();
	const parsed = parseBindingSpecs({ agentId, specs, config: cfg, channels: catalog });
	if (parsed.errors.length > 0) {
		emitErrorJson(sink, opts, parsed.errors.join("\n"));
		return 1;
	}

	const result = applyAgentBindings(cfg, parsed.bindings);
	if (result.added.length > 0 || result.updated.length > 0) {
		saveConfig(result.config);
	}

	const payload = {
		agentId,
		added: result.added.map(describeBinding),
		updated: result.updated.map(describeBinding),
		skipped: result.skipped.map(describeBinding),
		conflicts: formatBindingConflicts(result.conflicts),
	};
	if (opts.json) {
		writeJson(sink, payload);
		return result.conflicts.length > 0 ? 1 : 0;
	}

	if (result.added.length > 0) {
		sink.log("Added bindings:");
		for (const b of result.added) sink.log(`- ${describeBinding(b)}`);
	} else if (result.updated.length === 0) {
		sink.log("No new bindings added.");
	}
	if (result.updated.length > 0) {
		sink.log("Updated bindings:");
		for (const b of result.updated) sink.log(`- ${describeBinding(b)}`);
	}
	if (result.skipped.length > 0) {
		sink.log("Already present:");
		for (const b of result.skipped) sink.log(`- ${describeBinding(b)}`);
	}
	if (result.conflicts.length > 0) {
		sink.error("Skipped bindings already claimed by another agent:");
		for (const c of result.conflicts) {
			sink.error(`- ${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
		}
		return 1;
	}
	return 0;
}

/* ───────────────────────── 4. agents unbind ───────────────────────── */

export async function runAgentsUnbind(
	opts: { agent?: string; bind?: string[]; all?: boolean; json?: boolean } = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents unbind: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const agentId = resolveTargetAgentId(cfg, opts.agent, true);
	if (!agentId) {
		emitErrorJson(sink, opts, "Unable to resolve agent id.");
		return 1;
	}
	if (!hasAgent(cfg, agentId)) {
		emitErrorJson(sink, opts, `Agent "${agentId}" not found.`);
		return 1;
	}

	if (opts.all && (opts.bind?.length ?? 0) > 0) {
		emitErrorJson(sink, opts, "Use either --all or --bind, not both.");
		return 1;
	}

	if (opts.all) {
		const existing = listRouteBindings(cfg);
		const removed = existing.filter((b) => normalizeAgentId(b.agentId) === agentId);
		const kept = existing.filter((b) => normalizeAgentId(b.agentId) !== agentId);
		if (removed.length === 0) {
			if (opts.json) {
				writeJson(sink, { agentId, removed: [], missing: [], conflicts: [] });
			} else {
				sink.log(`No bindings to remove for agent "${agentId}".`);
			}
			return 0;
		}
		const next: BrigadeConfig = {
			...cfg,
			bindings: { entries: kept },
		};
		saveConfig(next);
		const payload = {
			agentId,
			removed: removed.map(describeBinding),
			missing: [] as string[],
			conflicts: [] as string[],
		};
		if (opts.json) {
			writeJson(sink, payload);
		} else {
			sink.log(`Removed ${removed.length} binding(s) for "${agentId}".`);
		}
		return 0;
	}

	const specs = (opts.bind ?? []).map((v) => v.trim()).filter(Boolean);
	if (specs.length === 0) {
		emitErrorJson(sink, opts, "Provide at least one --bind <channel[:accountId]> or use --all.");
		return 1;
	}

	const catalog = await loadChannelCatalog();
	const parsed = parseBindingSpecs({ agentId, specs, config: cfg, channels: catalog });
	if (parsed.errors.length > 0) {
		emitErrorJson(sink, opts, parsed.errors.join("\n"));
		return 1;
	}

	const result = removeAgentBindings(cfg, parsed.bindings);
	if (result.removed.length > 0) {
		saveConfig(result.config);
	}

	const payload = {
		agentId,
		removed: result.removed.map(describeBinding),
		missing: result.missing.map(describeBinding),
		conflicts: formatBindingConflicts(result.conflicts),
	};
	if (opts.json) {
		writeJson(sink, payload);
		return result.conflicts.length > 0 ? 1 : 0;
	}

	if (result.removed.length > 0) {
		sink.log("Removed bindings:");
		for (const b of result.removed) sink.log(`- ${describeBinding(b)}`);
	} else {
		sink.log("No bindings removed.");
	}
	if (result.missing.length > 0) {
		sink.log("Not found:");
		for (const b of result.missing) sink.log(`- ${describeBinding(b)}`);
	}
	if (result.conflicts.length > 0) {
		sink.error("Bindings are owned by another agent:");
		for (const c of result.conflicts) {
			sink.error(`- ${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
		}
		return 1;
	}
	return 0;
}

/* ───────────────────────── 5. agents add ───────────────────────── */

export async function runAgentsAdd(
	opts: {
		name?: string;
		workspace?: string;
		model?: string;
		provider?: string;
		agentDir?: string;
		bind?: string[];
		nonInteractive?: boolean;
		json?: boolean;
		/**
		 * Optional ORG-position seed. When any field is set on add AND
		 * cfg.org is absent, Brigade auto-initialises a minimal cfg.org
		 * so the operator can stand up a virtual office implicitly from
		 * chat / TUI / channels — without a separate `brigade org init`
		 * step. `manage_agent({action:"add", department, reportsTo, role,
		 * bio})` routes through here.
		 */
		org?: {
			department?: string;
			reportsTo?: string | null;
			role?: string;
			bio?: string;
		};
	} = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents add: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const nameInput = opts.name?.trim();
	const workspaceFlag = opts.workspace?.trim();

	if (!nameInput) {
		emitErrorJson(
			sink,
			opts,
			"Agent name is required. Usage: brigade agents add <name> [--workspace <dir>]",
		);
		return 1;
	}

	const agentId = normalizeAgentId(nameInput);
	if (agentId === DEFAULT_AGENT_ID) {
		emitErrorJson(sink, opts, `"${DEFAULT_AGENT_ID}" is reserved. Choose another name.`);
		return 1;
	}
	if (RESERVED_AGENT_IDS.has(agentId)) {
		emitErrorJson(
			sink,
			opts,
			`"${agentId}" is a reserved word and cannot be used as an agent id. Reserved: ${[...RESERVED_AGENT_IDS].join(", ")}.`,
		);
		return 1;
	}
	if (agentId !== nameInput) {
		sink.log(`Normalized agent id to "${agentId}".`);
	}
	if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
		emitErrorJson(sink, opts, `Agent "${agentId}" already exists.`);
		return 1;
	}

	const workspaceDir = workspaceFlag ? resolveUserPath(workspaceFlag) : resolveAgentWorkspaceDir(agentId);
	const agentDir = opts.agentDir?.trim() ? resolveUserPath(opts.agentDir.trim()) : resolveAgentDir(agentId);
	const model = opts.model?.trim();
	const provider = opts.provider?.trim();

	let nextConfig = applyAgentConfig(cfg, {
		agentId,
		name: nameInput,
		workspace: workspaceDir,
		agentDir,
		...(model ? { model } : {}),
		...(provider ? { provider } : {}),
	});

	const catalog = await loadChannelCatalog();
	const parsed = parseBindingSpecs({ agentId, specs: opts.bind, config: nextConfig, channels: catalog });
	if (parsed.errors.length > 0) {
		emitErrorJson(sink, opts, parsed.errors.join("\n"));
		return 1;
	}
	const bindingResult =
		parsed.bindings.length > 0
			? applyAgentBindings(nextConfig, parsed.bindings)
			: { config: nextConfig, added: [] as AgentRouteBinding[], updated: [] as AgentRouteBinding[], skipped: [] as AgentRouteBinding[], conflicts: [] as Array<{ binding: AgentRouteBinding; existingAgentId: string }> };

	nextConfig = bindingResult.config;

	// H7: saveConfig + bootstrapWorkspace must be atomic from the caller's
	// perspective. If bootstrap throws (e.g. invalid workspace path) after
	// we already persisted the new agent entry, roll the entry back so the
	// operator does not end up with a half-created agent that boots up but
	// has no workspace files.
	//
	// H8: the agent-add diff is re-applied against the freshest on-disk cfg
	// inside the in-process mutex (mutateConfigAtomic). A concurrent set-model
	// or set-thinking can no longer be silently stomped by the snapshot we
	// read at the top of this function. The rollback also runs through the
	// mutex so it can't race with another writer either.
	try {
		await mutateConfigAtomic((cur) => {
			let staged = applyAgentConfig(cur as BrigadeConfig, {
				agentId,
				name: nameInput,
				workspace: workspaceDir,
				agentDir,
				...(model ? { model } : {}),
				...(provider ? { provider } : {}),
			});
			if (parsed.bindings.length > 0) {
				const reapplied = applyAgentBindings(staged, parsed.bindings);
				staged = reapplied.config;
			}
			// UX-bridge: auto-extend `cfg.agents.defaults.subagents.allowAgents`
			// so the newly added agent is immediately spawn-targetable + visible
			// to peers via `agents_list` (which is allowlist-scoped). Without
			// this, a fresh `manage_agent({action:"add"})` creates an entry the
			// operator can SEE in `brigade agents list` but the model cannot
			// see in `agents_list` until the operator hand-edits the allowlist.
			//
			// Opt-out: `cfg.agents.defaults.subagents.autoAllowOnCreate = false`
			// disables the seed for operators who manage the allowlist by hand
			// (strict-allowlist mode mirroring the reference's stock posture).
			//
			// Idempotent: skipped when the list already contains `"*"` (wildcard
			// already covers it) or the agent id is already present.
			staged = applyAutoAllowOnCreate(staged, agentId);
			// UX-bridge (sibling seed): ensure `cfg.session.agentToAgent` carries
			// a usable A2A policy so the new agent can ping-pong via
			// `sessions_send` immediately. Without this, the subagent allowlist
			// seed above lets the model see + spawn the new agent — but the A2A
			// flow still refuses because the policy block is absent / disabled.
			// Same opt-out story: `cfg.session.autoEnableA2AOnAgentCreate = false`.
			staged = applyAutoEnableA2AOnAgentCreate(staged);
			// UX-bridge (Pride org): when manage_agent was called with any
			// org field (department / reportsTo / role / bio), seed the new
			// agent's cfg.agents.<id>.org block AND auto-init cfg.org if
			// it's absent. Lets the operator stand up a virtual office
			// implicitly from chat — "create a CEO" or "create eng-lead
			// reporting to main" works without a separate `brigade org
			// init` step. Opt-out: cfg.session.autoEnableOrgOnHierarchicalAdd
			// = false (operator curates cfg.org by hand).
			staged = applyAutoEnableOrgOnHierarchicalAdd(staged, agentId, opts.org);
			return staged as unknown as typeof cur;
		});
		await bootstrapWorkspace(workspaceDir);
	} catch (err) {
		// Roll back the just-added agent (plus any bindings keyed to it).
		try {
			await mutateConfigAtomic((cur) => {
				const pruned = pruneAgentConfig(cur as BrigadeConfig, agentId);
				return pruned.config as unknown as typeof cur;
			});
		} catch (rollbackErr) {
			emitErrorJson(
				sink,
				opts,
				`brigade agents add: rollback also failed: ${
					rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
				}`,
			);
		}
		emitErrorJson(
			sink,
			opts,
			`brigade agents add: failed to bootstrap workspace, rolled back agent "${agentId}": ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return 1;
	}

	const payload = {
		agentId,
		name: nameInput,
		workspace: workspaceDir,
		agentDir,
		model: model ?? null,
		provider: provider ?? null,
		bindings: {
			added: bindingResult.added.map(describeBinding),
			updated: bindingResult.updated.map(describeBinding),
			skipped: bindingResult.skipped.map(describeBinding),
			conflicts: bindingResult.conflicts.map(
				(c) => `${describeBinding(c.binding)} (agent=${c.existingAgentId})`,
			),
		},
	};
	if (opts.json) {
		writeJson(sink, payload);
		return bindingResult.conflicts.length > 0 ? 1 : 0;
	}

	sink.log(`Agent: ${agentId}`);
	sink.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
	sink.log(`Agent dir: ${shortenHomePath(agentDir)}`);
	if (model) sink.log(`Model: ${model}`);
	if (provider) sink.log(`Provider: ${provider}`);
	if (bindingResult.added.length > 0) {
		sink.log("Added bindings:");
		for (const b of bindingResult.added) sink.log(`- ${describeBinding(b)}`);
	}
	if (bindingResult.conflicts.length > 0) {
		sink.error("Skipped bindings already claimed by another agent:");
		for (const c of bindingResult.conflicts) {
			sink.error(`- ${describeBinding(c.binding)} (agent=${c.existingAgentId})`);
		}
		return 1;
	}
	return 0;
}

/* ───────────────────────── 6. agents set-identity ───────────────────────── */

const normalizeWorkspacePath = (input: string) => path.resolve(resolveUserPath(input));

function trimOpt(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

function resolveAgentIdByWorkspace(cfg: BrigadeConfig, workspaceDir: string): string[] {
	const list = listAgentEntries(cfg);
	const ids =
		list.length > 0
			? list.map((e) => normalizeAgentId(e.id))
			: [normalizeAgentId(resolveDefaultAgentId(cfg))];
	const target = normalizeWorkspacePath(workspaceDir);
	return ids.filter((id) => normalizeWorkspacePath(resolveAgentWorkspaceDir(id)) === target);
}

async function loadIdentityFromFile(filePath: string): Promise<BrigadeAgentIdentity | null> {
	try {
		const fs = await import("node:fs/promises");
		const content = await fs.readFile(filePath, "utf8");
		const parsed = parseIdentityMarkdown(content);
		return identityHasValues(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export async function runAgentsSetIdentity(
	opts: {
		agent?: string;
		workspace?: string;
		identityFile?: string;
		fromIdentity?: boolean;
		name?: string;
		theme?: string;
		emoji?: string;
		avatar?: string;
		json?: boolean;
	} = {},
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents set-identity: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const agentRaw = trimOpt(opts.agent);
	const nameRaw = trimOpt(opts.name);
	const emojiRaw = trimOpt(opts.emoji);
	const themeRaw = trimOpt(opts.theme);
	const avatarRaw = trimOpt(opts.avatar);
	const hasExplicitIdentity = Boolean(nameRaw || emojiRaw || themeRaw || avatarRaw);

	const identityFileRaw = trimOpt(opts.identityFile);
	const workspaceRaw = trimOpt(opts.workspace);
	const wantsIdentityFile = Boolean(opts.fromIdentity || identityFileRaw || !hasExplicitIdentity);

	let identityFilePath: string | undefined;
	let workspaceDir: string | undefined;
	if (identityFileRaw) {
		identityFilePath = normalizeWorkspacePath(identityFileRaw);
		workspaceDir = path.dirname(identityFilePath);
	} else if (workspaceRaw) {
		workspaceDir = normalizeWorkspacePath(workspaceRaw);
	} else if (wantsIdentityFile || !agentRaw) {
		workspaceDir = path.resolve(process.cwd());
	}

	let agentId = agentRaw ? normalizeAgentId(agentRaw) : undefined;
	if (!agentId) {
		if (!workspaceDir) {
			emitErrorJson(
				sink,
				opts,
				"Select an agent with --agent or provide a workspace via --workspace.",
			);
			return 1;
		}
		const matches = resolveAgentIdByWorkspace(cfg, workspaceDir);
		if (matches.length === 0) {
			emitErrorJson(
				sink,
				opts,
				`No agent workspace matches ${shortenHomePath(workspaceDir)}. Pass --agent to target a specific agent.`,
			);
			return 1;
		}
		if (matches.length > 1) {
			emitErrorJson(
				sink,
				opts,
				`Multiple agents match ${shortenHomePath(workspaceDir)}: ${matches.join(", ")}. Pass --agent to choose one.`,
			);
			return 1;
		}
		agentId = matches[0] as string;
	}

	let identityFromFile: BrigadeAgentIdentity | null = null;
	if (wantsIdentityFile) {
		if (identityFilePath) {
			identityFromFile = await loadIdentityFromFile(identityFilePath);
		} else if (workspaceDir) {
			identityFromFile = loadAgentIdentity(workspaceDir);
		}
		if (!identityFromFile) {
			const targetPath =
				identityFilePath ??
				(workspaceDir ? path.join(workspaceDir, "IDENTITY.md") : "IDENTITY.md");
			emitErrorJson(sink, opts, `No identity data found in ${shortenHomePath(targetPath)}.`);
			return 1;
		}
	}

	const fileTheme = identityFromFile?.theme ?? identityFromFile?.creature ?? identityFromFile?.vibe ?? undefined;
	const incomingIdentity: BrigadeAgentIdentity = {
		...(nameRaw || identityFromFile?.name ? { name: nameRaw ?? identityFromFile?.name } : {}),
		...(emojiRaw || identityFromFile?.emoji ? { emoji: emojiRaw ?? identityFromFile?.emoji } : {}),
		...(themeRaw || fileTheme ? { theme: themeRaw ?? fileTheme } : {}),
		...(avatarRaw || identityFromFile?.avatar
			? { avatar: avatarRaw ?? identityFromFile?.avatar }
			: {}),
	};

	if (
		!incomingIdentity.name &&
		!incomingIdentity.emoji &&
		!incomingIdentity.theme &&
		!incomingIdentity.avatar
	) {
		emitErrorJson(
			sink,
			opts,
			"No identity fields provided. Use --name/--emoji/--theme/--avatar or --from-identity.",
		);
		return 1;
	}

	const nextConfig = applyAgentConfig(cfg, {
		agentId,
		identity: incomingIdentity,
	});
	saveConfig(nextConfig);

	if (opts.json) {
		writeJson(sink, {
			agentId,
			identity: incomingIdentity,
			workspace: workspaceDir ?? null,
			identityFile: identityFilePath ?? null,
		});
		return 0;
	}

	sink.log(`Agent: ${agentId}`);
	if (incomingIdentity.name) sink.log(`Name: ${incomingIdentity.name}`);
	if (incomingIdentity.theme) sink.log(`Theme: ${incomingIdentity.theme}`);
	if (incomingIdentity.emoji) sink.log(`Emoji: ${incomingIdentity.emoji}`);
	if (incomingIdentity.avatar) sink.log(`Avatar: ${incomingIdentity.avatar}`);
	if (workspaceDir) sink.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
	return 0;
}

/* ───────────────────────── 7. agents delete ───────────────────────── */

/**
 * H6: move-to-trash instead of hard rm. A typo on `agents delete <id>`
 * used to be unrecoverable; we now rename the target into a sibling
 * `.brigade-trash/` and let the operator restore by hand.
 *
 * Trash sits next to the original parent and is capped at 10 entries
 * (oldest first) to keep state-dir from ballooning over time.
 */
function safeRm(target: string, sink: OutputSink): void {
	if (!existsSync(target)) return;
	try {
		const parent = path.dirname(target);
		const trashDir = path.join(parent, ".brigade-trash");
		try {
			mkdirSync(trashDir, { recursive: true });
		} catch {
			/* fall through — the rename below will surface a real error */
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const moved = path.join(trashDir, `${path.basename(target)}-${stamp}`);
		renameSync(target, moved);
		// Cap the trash at 10 entries: drop the oldest first (lexicographic
		// order matches creation order because we stamp with ISO timestamps).
		try {
			const entries = readdirSync(trashDir)
				.map((name) => ({ name, full: path.join(trashDir, name) }))
				.sort((a, b) => a.name.localeCompare(b.name));
			while (entries.length > 10) {
				const oldest = entries.shift();
				if (oldest) {
					try {
						rmSync(oldest.full, { recursive: true, force: true });
					} catch {
						/* best-effort GC */
					}
				}
			}
		} catch {
			/* best-effort GC */
		}
	} catch (err) {
		sink.error(
			`Warning: failed to move ${shortenHomePath(target)} to trash: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function runAgentsDelete(
	opts: { id: string; force?: boolean; json?: boolean; allowExternalWorkspace?: boolean },
): Promise<number> {
	const sink = defaultSink();
	let cfg: BrigadeConfig;
	try {
		cfg = loadConfig();
	} catch (err) {
		emitErrorJson(
			sink,
			opts,
			`brigade agents delete: failed to read brigade.json: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}

	const input = opts.id?.trim();
	if (!input) {
		emitErrorJson(sink, opts, "Agent id is required.");
		return 1;
	}
	const agentId = normalizeAgentId(input);
	if (agentId !== input) sink.log(`Normalized agent id to "${agentId}".`);
	if (agentId === DEFAULT_AGENT_ID) {
		emitErrorJson(sink, opts, `"${DEFAULT_AGENT_ID}" cannot be deleted.`);
		return 1;
	}
	if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
		emitErrorJson(sink, opts, `Agent "${agentId}" not found.`);
		return 1;
	}

	if (!opts.force) {
		emitErrorJson(
			sink,
			opts,
			`Refusing to delete agent "${agentId}" without --force. (Interactive confirm ships in a follow-up.)`,
		);
		return 1;
	}

	// C3: read the configured workspace override BEFORE wiping. The old
	// code always called resolveAgentWorkspaceDir(agentId) which produces
	// the default <state>/agents/<id>/workspace path — orphaning any
	// custom workspace the agent was configured with.
	const agentsMapRaw = (cfg.agents as Record<string, unknown> | undefined) ?? {};
	const agentEntryRaw = agentsMapRaw[agentId];
	const configuredWorkspace =
		agentEntryRaw && typeof agentEntryRaw === "object" && !Array.isArray(agentEntryRaw)
			? (agentEntryRaw as { workspace?: unknown }).workspace
			: undefined;
	const configuredWorkspaceStr =
		typeof configuredWorkspace === "string" && configuredWorkspace.trim()
			? configuredWorkspace.trim()
			: "";

	const workspaceDir = configuredWorkspaceStr
		? path.resolve(configuredWorkspaceStr)
		: resolveAgentWorkspaceDir(agentId);

	// External-workspace guard: refuse to wipe anything outside the state
	// dir unless the operator explicitly opts in.
	const stateDir = path.resolve(resolveStateDir());
	const isInsideState = (() => {
		const rel = path.relative(stateDir, workspaceDir);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	})();
	if (!isInsideState && !opts.allowExternalWorkspace) {
		emitErrorJson(
			sink,
			opts,
			`Refusing to remove external workspace ${shortenHomePath(workspaceDir)}. ` +
				`Re-run with --allow-external-workspace to wipe it.`,
		);
		return 1;
	}

	sink.log(`Workspace target: ${shortenHomePath(workspaceDir)}`);

	const agentDir = resolveAgentDir(agentId);
	const sessionsDir = resolveSessionsDir(agentId);

	const result = pruneAgentConfig(cfg, agentId);
	saveConfig(result.config);

	safeRm(workspaceDir, sink);
	safeRm(agentDir, sink);
	safeRm(sessionsDir, sink);

	// Convex mode: the disk rm's above only clear the (mostly empty) local
	// surface — without this, EVERY backend row of the deleted agent survived
	// forever: sessions + transcripts, sealed auth profiles, mirrored persona
	// files, memory facts, and its cron jobs kept firing. Purge per domain via
	// the store; best-effort per domain so one failure can't strand the whole
	// delete (the config prune above already made the agent unroutable).
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		const purged = await purgeAgentBackendRows(rctx.store, agentId, sink);
		sink.log(
			`Backend cleanup: ${purged.sessions} session(s), ${purged.transcripts} transcript(s), ` +
				`${purged.profiles} auth profile(s), ${purged.personas} persona file(s), ` +
				`${purged.facts} memory fact(s), ${purged.cronJobs} cron job(s).`,
		);
	}

	if (opts.json) {
		writeJson(sink, {
			agentId,
			workspace: workspaceDir,
			agentDir,
			sessionsDir,
			removedBindings: result.removedBindings,
			removedAllow: result.removedAllow,
		});
	} else {
		sink.log(`Deleted agent: ${agentId}`);
		if (result.removedBindings > 0) sink.log(`Removed ${result.removedBindings} routing binding(s).`);
		if (result.removedAllow > 0) sink.log(`Removed ${result.removedAllow} agent-to-agent allow pair(s).`);
	}
	return 0;
}

/** Names the boot mirror + live mirror sync — the set a deleted agent may
 *  have rows for in the personaFiles table. */
const PURGE_PERSONA_NAMES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"TOOLS.md",
	"BOOTSTRAP.md",
	"MEMORY.md",
	"HEARTBEAT.md",
] as const;

/**
 * Convex-mode backend cleanup for `agents delete`. Removes the deleted
 * agent's rows across every per-agent domain the store exposes: sessions
 * (+ their transcripts), sealed auth profiles, mirrored persona files,
 * memory facts, and cron jobs pinned to the agent (which otherwise kept
 * firing forever — pruneAgentConfig only strips bindings + allow pairs).
 * Also drops the regenerable OS-cache transcript JSONLs. Best-effort per
 * domain: a failure logs and moves on, never aborts the delete.
 */
async function purgeAgentBackendRows(
	store: import("../../storage/store.js").BrigadeStore,
	agentId: string,
	sink: OutputSink,
): Promise<{
	sessions: number;
	transcripts: number;
	profiles: number;
	personas: number;
	facts: number;
	cronJobs: number;
}> {
	const purged = { sessions: 0, transcripts: 0, profiles: 0, personas: 0, facts: 0, cronJobs: 0 };

	// Sessions + transcripts.
	try {
		const entries = await store.sessions.listEntries(agentId);
		for (const { sessionKey, entry } of entries) {
			const sessionId = (entry as { sessionId?: string }).sessionId;
			if (typeof sessionId === "string" && sessionId) {
				try {
					await store.messages.deleteTranscript(agentId, sessionId);
					purged.transcripts += 1;
				} catch {
					/* per-row best-effort */
				}
			}
			try {
				if (await store.sessions.deleteEntry(agentId, sessionKey)) purged.sessions += 1;
			} catch {
				/* per-row best-effort */
			}
		}
	} catch (err) {
		sink.log(`Backend cleanup: sessions purge failed — ${(err as Error).message}`);
	}

	// Sealed auth profiles.
	try {
		const profiles = await store.auth.listProfiles(agentId);
		for (const p of profiles) {
			const profileId = (p as { profileId?: string }).profileId;
			if (!profileId) continue;
			try {
				await store.auth.deleteProfile(agentId, profileId);
				purged.profiles += 1;
			} catch {
				/* per-row best-effort */
			}
		}
	} catch (err) {
		sink.log(`Backend cleanup: auth purge failed — ${(err as Error).message}`);
	}

	// Mirrored persona files.
	for (const name of PURGE_PERSONA_NAMES) {
		try {
			if (await store.workspace.deletePersona(agentId, name as never)) purged.personas += 1;
		} catch {
			/* per-row best-effort */
		}
	}

	// Memory facts (workspaceId === agentId for per-agent workspaces).
	try {
		const records = await store.memory.listAllFactRecordsRaw(agentId);
		for (const r of records) {
			const id = (r as { id?: string }).id;
			if (!id) continue;
			try {
				await store.memory.deleteFactRecordRaw(agentId, id);
				purged.facts += 1;
			} catch {
				/* per-row best-effort */
			}
		}
	} catch (err) {
		sink.log(`Backend cleanup: memory purge failed — ${(err as Error).message}`);
	}

	// Cron jobs pinned to the deleted agent.
	try {
		const jobs = await store.cron.listJobs();
		for (const job of jobs) {
			if ((job as { agentId?: string }).agentId !== agentId) continue;
			// The store interface types rows as {jobId}; the convex impl's
			// rebuilt rows carry the internal {id}. Accept either spelling.
			const raw = job as { id?: string; jobId?: string };
			const jobId = raw.id ?? raw.jobId;
			if (!jobId) continue;
			try {
				if (await store.cron.deleteJob(jobId)) purged.cronJobs += 1;
			} catch {
				/* per-row best-effort */
			}
		}
	} catch (err) {
		sink.log(`Backend cleanup: cron purge failed — ${(err as Error).message}`);
	}

	// Regenerable OS-cache transcripts for this agent.
	try {
		const { rm } = await import("node:fs/promises");
		const { resolveOsCacheDir } = await import("../../config/paths.js");
		await rm(path.join(resolveOsCacheDir(), "sessions", agentId), { recursive: true, force: true });
	} catch {
		/* cache cleanup is cosmetic */
	}

	return purged;
}
