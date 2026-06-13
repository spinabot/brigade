/**
 * Skills (Primitive #5) — public entry point.
 *
 * `discoverEligibleSkills` is the one call the runtime makes per turn: it reads
 * the skills config, resolves the bundled + workspace + config-extra roots, and
 * returns the eligible skills plus the rendered `<available_skills>` prompt
 * block. The agent-loop passes the block into the assembler (gated on
 * `capabilities.skills`) and the model loads a skill's body on demand with the
 * existing `read` tool — no skill-specific tool exists.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { BrigadeConfig } from "../../config/io.js";
import {
	resolveBundledSkillsDir,
	resolveManagedSkillsDir,
	resolveSkillsDir,
} from "../../config/paths.js";
import {
	resolveEffectiveAgentSkillFilter,
} from "./agent-filter.js";
import { discoverSkills, type DiscoveredSkill, type SkillDiscoveryResult } from "./discovery.js";
import { resolveOrgVisibleSkillAgents } from "./org-access.js";

export {
	discoverSkills,
	SOURCE_MANAGED,
	SOURCE_PERSONAL,
	SOURCE_PROJECT,
	type DiscoveredSkill,
	type SkillDiscoveryResult,
	type DiscoverSkillsArgs,
} from "./discovery.js";
export {
	isSkillEligible,
	hasBinary,
	readSkillEligibility,
	parseEligibility,
	type SkillEligibility,
} from "./eligibility.js";
export {
	resolveEffectiveAgentSkillFilter,
	isSkillAllowedForAgent,
} from "./agent-filter.js";

/** The empty result — skills disabled or none found. */
const EMPTY: SkillDiscoveryResult = {
	skills: [],
	promptBlock: undefined,
	totalDiscovered: 0,
	diagnostics: [],
};

/** Read a peer agent's `cfg.agents.<id>.workspace` override (string) or undefined. */
function readAgentWorkspaceOverride(config: BrigadeConfig, agentId: string): string | undefined {
	const agents = config.agents as Record<string, unknown> | undefined;
	const entry = agents?.[agentId];
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		const ws = (entry as { workspace?: unknown }).workspace;
		if (typeof ws === "string" && ws.trim().length > 0) return ws.trim();
	}
	return undefined;
}

/** Names disabled via `skills.entries[<name>].enabled === false`. */
function resolveDisabledNames(config: BrigadeConfig): Set<string> {
	const out = new Set<string>();
	const entries = config.skills?.entries;
	if (!entries) return out;
	for (const [name, entry] of Object.entries(entries)) {
		if (entry && entry.enabled === false) out.add(name);
	}
	return out;
}

export interface DiscoverEligibleSkillsArgs {
	/** Resolved workspace dir (same value memory/persona use) — skills live in `<workspaceDir>/skills`. */
	workspaceDir: string;
	/** The active config (caller already has it loaded; avoids a second read). */
	config: BrigadeConfig;
	/**
	 * Optional agent id. When supplied, the per-agent skill allowlist
	 * (`cfg.agents.<id>.skills`, falling back to `cfg.agents.defaults.skills`)
	 * gates which discovered skills land in the prompt block. Omit for
	 * single-agent / legacy callers that don't enforce per-agent scope.
	 */
	agentId?: string;
}

/**
 * Discover the skills eligible for this turn. Returns the empty result when the
 * subsystem is globally disabled (`skills.enabled === false`). Synchronous +
 * cheap (a small directory scan), so it runs per turn with no caching.
 */
export function discoverEligibleSkills(args: DiscoverEligibleSkillsArgs): SkillDiscoveryResult {
	if (args.config.skills?.enabled === false) return EMPTY;
	const allowlist = resolveEffectiveAgentSkillFilter(args.config, args.agentId);
	// 3c — org-hierarchy skill access. Resolve OTHER agents whose workspace
	// skills this agent may see (its reports / managers, per skills.orgAccess),
	// and add each as a low-precedence root tagged `org:<id>`. Honours each
	// peer's own `cfg.agents.<id>.workspace` override so the dir matches where
	// that agent actually keeps its skills.
	const orgSkillRoots = resolveOrgVisibleSkillAgents(
		args.config,
		args.agentId,
		args.config.skills?.orgAccess,
	).map((id) => ({ dir: resolveSkillsDir(id, readAgentWorkspaceOverride(args.config, id)), agentId: id }));
	return discoverSkills({
		workspaceSkillsDir: path.join(args.workspaceDir, "skills"),
		bundledSkillsDir: resolveBundledSkillsDir(),
		managedSkillsDir: resolveManagedSkillsDir(),
		personalSkillsDir: path.join(os.homedir(), ".agents", "skills"),
		projectSkillsDir: path.join(args.workspaceDir, ".agents", "skills"),
		extraPaths: args.config.skills?.paths ?? [],
		disabledNames: resolveDisabledNames(args.config),
		...(orgSkillRoots.length > 0 ? { orgSkillRoots } : {}),
		...(allowlist !== undefined ? { skillAllowlist: allowlist } : {}),
		// Pass the active config so `requires.config` paths actually gate
		// channel-specific skills (e.g. a bluebubbles skill is hidden when
		// the operator has no `channels.bluebubbles` section). Without this
		// the eligibility evaluator conservatively allows every skill that
		// passes os/bins/env — exactly the case that surfaced when the model
		// tried to invoke the bluebubbles skill to send a WhatsApp message.
		eligibilityCtx: {
			platform: process.platform,
			env: process.env,
			config: args.config,
		},
	});
}
