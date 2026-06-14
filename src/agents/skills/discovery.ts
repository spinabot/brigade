/**
 * Skill discovery — the Brigade-native facade over Pi's skill loader.
 *
 * Pi (`loadSkillsFromDir`) does the heavy lifting we want to reuse: SKILL.md
 * discovery (folder-per-skill), frontmatter parse + validation (name matches
 * dir, lowercase, description present), and the standard agentskills.io
 * `<available_skills>` XML render (`formatSkillsForPrompt`). Brigade layers on
 * what Pi structurally lacks: two-root merge (bundled + user workspace),
 * config enable/disable, and OS/binary/env ELIGIBILITY filtering — see
 * `eligibility.ts`.
 *
 * WHY render here instead of letting Pi inject: Brigade pins the whole system
 * prompt via `applyPersonaOverrideToSession`, which replaces Pi's prompt-build
 * hook — so Pi's own skills injection never survives. The agent-loop passes
 * the rendered block into the assembler, so the assembled persona prompt owns
 * the `<available_skills>` section directly. The session's Pi resource loader
 * runs with `noSkills` so nothing is discovered twice.
 *
 * Discovery is a synchronous filesystem scan (Pi's loader is sync). At
 * single-user scale with a handful of skills it's sub-millisecond, so it runs
 * per turn with no cache — a dropped-in skill is live on the very next turn
 * (the "drop-a-folder-it-works" contract) with no watcher to wire.
 */

import * as fs from "node:fs";

import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	type EligibilityEnv,
	isSkillEligible,
	readSkillEligibility,
	type SkillEligibility,
} from "./eligibility.js";

const log = createSubsystemLogger("skills/discovery");

/** Source roots, lowest → highest precedence (later wins on a name collision). */
const SOURCE_BUNDLED = "bundled";
const SOURCE_CONFIG = "config";
/** `~/.brigade/skills/` — managed-dir installs (`skills.install` RPC). */
export const SOURCE_MANAGED = "managed";
/** `~/.agents/skills/` — operator's personal skills shared across projects. */
export const SOURCE_PERSONAL = "agents-skills-personal";
/** `<workspace>/.agents/skills/` — project-scoped skills. */
export const SOURCE_PROJECT = "agents-skills-project";
const SOURCE_WORKSPACE = "workspace";

/** A discovered, eligible skill — lean metadata for status/diagnostics. */
export interface DiscoveredSkill {
	name: string;
	description: string;
	/** Absolute path to the skill's SKILL.md (or .md) — what the model reads. */
	filePath: string;
	/** Which root it came from ("bundled" | "workspace"). */
	source: string;
	eligibility: SkillEligibility;
}

export interface SkillDiscoveryResult {
	/** Eligible + enabled skills, sorted by name. */
	skills: DiscoveredSkill[];
	/** The rendered `<available_skills>` block, or undefined when none are eligible. */
	promptBlock: string | undefined;
	/** Total skills found on disk BEFORE eligibility/enabled filtering. */
	totalDiscovered: number;
	/** Loader validation diagnostics (bad frontmatter, name mismatch, …). */
	diagnostics: unknown[];
}

export interface DiscoverSkillsArgs {
	/** `<workspace>/skills` — user-authored skills (highest precedence). */
	workspaceSkillsDir: string;
	/** `<packageRoot>/skills` — shipped starter skills. Omit/missing to skip. */
	bundledSkillsDir?: string;
	/** `~/.brigade/skills/` — `skills.install` RPC drop-zone. Above bundled. */
	managedSkillsDir?: string;
	/** `~/.agents/skills/` — operator's cross-project personal skills. */
	personalSkillsDir?: string;
	/** `<workspace>/.agents/skills/` — project-scoped skills. */
	projectSkillsDir?: string;
	/** Extra search roots from config (`skills.paths`). Above bundled, below managed. */
	extraPaths?: string[];
	/**
	 * Org-hierarchy-visible roots — OTHER agents' workspace skill dirs the
	 * current agent may see via `skills.orgAccess`. Each becomes a root tagged
	 * `org:<agentId>`, inserted just ABOVE bundled and BELOW every other root
	 * (config paths, managed, personal, project, workspace) so an org-visible
	 * skill can never shadow a skill the operator placed locally, and the
	 * agent's own workspace always wins a name collision. Still subject to the
	 * per-agent allowlist + eligibility (they're shared surface, unlike the
	 * agent's OWN workspace skills which are allowlist-exempt).
	 */
	orgSkillRoots?: Array<{ dir: string; agentId: string }>;
	/** Names disabled via config (`skills.entries[name].enabled === false`). */
	disabledNames?: Set<string>;
	/**
	 * Per-agent skill allowlist (`cfg.agents.<id>.skills`, falling back to
	 * `cfg.agents.defaults.skills`). `undefined` means "no restriction"; `[]`
	 * means "deny all". When a name isn't in the allowlist, the skill is
	 * dropped from the rendered prompt block but still counted in
	 * `totalDiscovered` so diagnostics can show the operator what was hidden.
	 */
	skillAllowlist?: string[];
	/** Injected platform/env for eligibility (tests). Defaults to the live host. */
	eligibilityCtx?: EligibilityEnv;
}

/** Scan one root, tolerating a missing dir. Returns Pi skills + diagnostics. */
function scanRoot(dir: string | undefined, source: string): { skills: Skill[]; diagnostics: unknown[] } {
	if (!dir || !fs.existsSync(dir)) return { skills: [], diagnostics: [] };
	try {
		const res = loadSkillsFromDir({ dir, source });
		return { skills: res.skills, diagnostics: res.diagnostics };
	} catch (err) {
		log.warn("skill root scan failed", {
			dir,
			source,
			error: err instanceof Error ? err.message : String(err),
		});
		return { skills: [], diagnostics: [] };
	}
}

/**
 * Discover skills across the bundled + workspace roots, merge by name
 * (workspace wins), drop config-disabled and ineligible ones, and render the
 * survivors into the `<available_skills>` prompt block.
 */
export function discoverSkills(args: DiscoverSkillsArgs): SkillDiscoveryResult {
	const diagnostics: unknown[] = [];
	// Merge lowest → highest precedence so a workspace skill overrides a
	// same-named bundled (or config-path / managed / personal / project) one —
	// the user can shadow a shipped skill by dropping a same-named folder
	// further up the chain. Order:
	//   bundled < config.skills.paths < managed (~/.brigade/skills)
	//          < personal (~/.agents/skills) < project (<ws>/.agents/skills)
	//          < workspace (<ws>/skills)
	const roots: Array<[string | undefined, string]> = [[args.bundledSkillsDir, SOURCE_BUNDLED]];
	// Org-visible peers sit just above bundled — below everything operator-
	// placed, so they can shadow only a shipped starter, never a local skill.
	for (const r of args.orgSkillRoots ?? []) roots.push([r.dir, `org:${r.agentId}`]);
	for (const p of args.extraPaths ?? []) roots.push([p, SOURCE_CONFIG]);
	roots.push([args.managedSkillsDir, SOURCE_MANAGED]);
	roots.push([args.personalSkillsDir, SOURCE_PERSONAL]);
	roots.push([args.projectSkillsDir, SOURCE_PROJECT]);
	roots.push([args.workspaceSkillsDir, SOURCE_WORKSPACE]);

	const byName = new Map<string, { skill: Skill; source: string }>();
	for (const [dir, source] of roots) {
		const { skills, diagnostics: diags } = scanRoot(dir, source);
		diagnostics.push(...diags);
		for (const skill of skills) byName.set(skill.name, { skill, source });
	}

	const totalDiscovered = byName.size;
	const disabled = args.disabledNames ?? new Set<string>();
	const ctx = args.eligibilityCtx;
	const allowlist = args.skillAllowlist;

	const eligiblePi: Skill[] = [];
	const skills: DiscoveredSkill[] = [];
	for (const { skill, source } of byName.values()) {
		if (disabled.has(skill.name)) continue;
		// Per-agent allowlist (S1) — `undefined` is "no restriction"; `[]` is
		// explicit deny-all. `includes` keeps it O(n*m) for small lists; if
		// the catalogue grows past dozens of skills this becomes a Set lookup.
		//
		// 3a: an agent's OWN workspace skills are EXEMPT from the allowlist —
		// it is the whole-and-sole owner of what it authored, so a shared
		// `agents.defaults.skills` allowlist (set for shared-skill hygiene) can
		// never silently blind an agent to its own self-authored skills. The
		// allowlist still gates every SHARED root (bundled/config/org/managed/
		// personal/project). `skills.entries[x].enabled=false` and global
		// `skills.enabled=false` remain operator kill-switches that DO apply.
		if (allowlist !== undefined && source !== SOURCE_WORKSPACE && !allowlist.includes(skill.name)) {
			continue;
		}
		const eligibility = readSkillEligibility(skill.filePath);
		if (!(ctx ? isSkillEligible(eligibility, ctx) : isSkillEligible(eligibility))) continue;
		eligiblePi.push(skill);
		skills.push({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			source,
			eligibility,
		});
	}

	skills.sort((a, b) => a.name.localeCompare(b.name));
	eligiblePi.sort((a, b) => a.name.localeCompare(b.name));

	// formatSkillsForPrompt itself drops disableModelInvocation skills, so the
	// rendered block can be empty even when `skills` is not — guard on the
	// rendered text, and treat a whitespace-only render as "nothing".
	const rendered = eligiblePi.length > 0 ? formatSkillsForPrompt(eligiblePi).trim() : "";
	return {
		skills,
		promptBlock: rendered.length > 0 ? rendered : undefined,
		totalDiscovered,
		diagnostics,
	};
}
