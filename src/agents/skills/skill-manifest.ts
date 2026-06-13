/**
 * Skill command manifest — the optional, machine-readable list of shell
 * commands a skill needs, declared in its SKILL.md frontmatter. Used by the
 * grant flow (grant.ts) to bulk-pre-approve a skill's commands so the operator
 * isn't prompted for each one while the agent follows the skill.
 *
 * Two shapes, mirroring eligibility.ts:
 *   1. Flat top-level keys (hand-authored):
 *        commands:
 *          - "node oauth-flow.mjs"
 *        command-patterns:
 *          - "^node .*gmail-oauth"
 *   2. Nested metadata.brigade block (ported skills):
 *        metadata: { brigade: { commands: [...], commandPatterns: [...] } }
 *
 * Semantics intentionally narrow: `commands` are EXACT strings, `command-
 * patterns` are anchored regexes. Granting copies whatever the manifest holds
 * RIGHT NOW into the agent's allowlist (snapshot-at-grant) — so a later edit to
 * the skill can never silently widen an existing grant.
 */

import * as fs from "node:fs";

import YAML from "yaml";

import { extractFrontmatterBlock } from "./eligibility.js";

export interface SkillCommandManifest {
	/** Exact command strings to pre-approve. */
	commands: string[];
	/** Regex patterns to pre-approve. */
	patterns: string[];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Coerce a YAML value into a clean string list (sequence, or single scalar). */
function toStrList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
	}
	if (typeof value === "string") {
		const t = value.trim();
		return t.length > 0 ? [t] : [];
	}
	return [];
}

/**
 * Parse the command manifest from a frontmatter block. `metadata.brigade`
 * wins per-field; flat keys fill anything unset. Never throws — malformed
 * frontmatter yields an empty manifest (nothing to grant).
 */
export function parseSkillCommandManifest(frontmatter: string): SkillCommandManifest {
	const out: SkillCommandManifest = { commands: [], patterns: [] };
	let doc: unknown;
	try {
		doc = YAML.parse(frontmatter);
	} catch {
		return out;
	}
	const fm = asObject(doc);
	if (!fm) return out;

	const brigadeMeta = asObject(asObject(fm.metadata)?.brigade);
	if (brigadeMeta) {
		out.commands = toStrList(brigadeMeta.commands);
		out.patterns = toStrList(brigadeMeta.commandPatterns);
	}
	if (out.commands.length === 0) out.commands = toStrList(fm.commands);
	if (out.patterns.length === 0) out.patterns = toStrList(fm["command-patterns"]);

	// De-dupe while preserving order.
	out.commands = [...new Set(out.commands)];
	out.patterns = [...new Set(out.patterns)];
	return out;
}

/** Read + parse a SKILL.md file's command manifest. Missing/unreadable → empty. */
export function readSkillCommandManifest(filePath: string): SkillCommandManifest {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return { commands: [], patterns: [] };
	}
	return parseSkillCommandManifest(extractFrontmatterBlock(content));
}
