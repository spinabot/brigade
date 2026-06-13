/**
 * Skill command grants — bulk pre-approval of a skill's declared commands.
 *
 * Point 3b: "an agent is the whole-and-sole owner of its skills; stop asking
 * me to approve every command its own skill documents." The SAFE realisation
 * (a SKILL.md is just markdown the model itself can write, so we can NEVER
 * blanket-trust whatever the file currently says): the operator GRANTS a skill
 * once; granting copies the skill's CURRENT command manifest into the agent's
 * exec-approvals allowlist via the normal `recordApproval` path. Because it's a
 * snapshot, a later edit to the skill can't silently widen the grant — newly
 * added commands simply aren't in the allowlist until the operator re-grants.
 *
 * No schema change: grants land as ordinary `commands` / `patterns` entries the
 * exec-gate already consults. Hard-deny commands are refused (never approvable).
 * Revoking re-reads the manifest and removes those entries.
 *
 * The grant flow is OPERATOR-INITIATED (the TUI `/grant-skill` command). The
 * agent can't silently self-trust: a grant always runs in an owner-driven turn
 * and reports exactly what it approved.
 */

import type { BrigadeConfig } from "../../config/io.js";
import {
	isHardDenied,
	patternMatchesHardDeny,
	recordApproval,
	removeApproval,
} from "../../core/exec-approvals.js";
import { discoverEligibleSkills } from "./index.js";
import { readSkillCommandManifest, type SkillCommandManifest } from "./skill-manifest.js";

export interface SkillGrantResult {
	/** Whether a skill of this name was found in the agent's discovered set. */
	found: boolean;
	/** The resolved skill name (as discovered). */
	skill: string;
	/** Commands + patterns the skill declares (its manifest). */
	manifest: SkillCommandManifest;
	/** Entries actually granted (excludes hard-denied + already-present). */
	granted: { commands: string[]; patterns: string[] };
	/** Entries refused because they match a hard-deny pattern. */
	refused: string[];
	/** True when the grant was applied; false for a dry-run preview. */
	applied: boolean;
	/** Set when the skill has no command manifest to grant. */
	emptyManifest: boolean;
}

/** Locate a discovered skill's SKILL.md path by name for the given agent. */
function resolveSkillFilePath(
	config: BrigadeConfig,
	workspaceDir: string,
	agentId: string,
	skillName: string,
): string | undefined {
	const target = skillName.trim().toLowerCase();
	if (!target) return undefined;
	const discovered = discoverEligibleSkills({ workspaceDir, config, agentId });
	return discovered.skills.find((s) => s.name.toLowerCase() === target)?.filePath;
}

/**
 * Preview or apply a skill grant. `apply: false` (default) is a dry run that
 * reports the manifest without writing — the operator sees what they'd approve.
 * `apply: true` records each command/pattern into the agent's allowlist.
 */
export function grantSkill(args: {
	config: BrigadeConfig;
	workspaceDir: string;
	agentId: string;
	skillName: string;
	apply: boolean;
}): SkillGrantResult {
	const filePath = resolveSkillFilePath(args.config, args.workspaceDir, args.agentId, args.skillName);
	const base: SkillGrantResult = {
		found: filePath !== undefined,
		skill: args.skillName.trim(),
		manifest: { commands: [], patterns: [] },
		granted: { commands: [], patterns: [] },
		refused: [],
		applied: false,
		emptyManifest: false,
	};
	if (!filePath) return base;

	const manifest = readSkillCommandManifest(filePath);
	base.manifest = manifest;
	if (manifest.commands.length === 0 && manifest.patterns.length === 0) {
		base.emptyManifest = true;
		return base;
	}

	// Filter out hard-denied entries up front so the preview is honest about
	// what would actually be approvable.
	const grantableCommands = manifest.commands.filter((c) => {
		if (isHardDenied(c)) {
			base.refused.push(c);
			return false;
		}
		return true;
	});
	const grantablePatterns = manifest.patterns.filter((p) => {
		if (patternMatchesHardDeny(p)) {
			base.refused.push(p);
			return false;
		}
		return true;
	});

	if (!args.apply) {
		// Dry run — report the grantable set without writing.
		base.granted = { commands: grantableCommands, patterns: grantablePatterns };
		return base;
	}

	for (const cmd of grantableCommands) {
		recordApproval(cmd, "exact", args.agentId);
		base.granted.commands.push(cmd);
	}
	for (const pat of grantablePatterns) {
		recordApproval(pat, "pattern", args.agentId);
		base.granted.patterns.push(pat);
	}
	base.applied = true;
	return base;
}

/**
 * Revoke a prior grant by re-reading the skill's CURRENT manifest and removing
 * those exact entries from the allowlist. Note: if the skill was edited since
 * the grant, manifest entries that changed won't be matched — the operator can
 * always remove stragglers with `brigade exec` directly.
 */
export function revokeSkill(args: {
	config: BrigadeConfig;
	workspaceDir: string;
	agentId: string;
	skillName: string;
}): { found: boolean; skill: string; removed: number } {
	const filePath = resolveSkillFilePath(args.config, args.workspaceDir, args.agentId, args.skillName);
	if (!filePath) return { found: false, skill: args.skillName.trim(), removed: 0 };
	const manifest = readSkillCommandManifest(filePath);
	let removed = 0;
	for (const value of [...manifest.commands, ...manifest.patterns]) {
		const r = removeApproval(value, args.agentId);
		removed += r.removedCommands + r.removedPatterns;
	}
	return { found: true, skill: args.skillName.trim(), removed };
}
