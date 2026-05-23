/**
 * `brigade skills list / info` — operator CLI introspection over Primitive #5.
 *
 * Brigade discovers skills from two roots (per `resolveBundledSkillsDir()` and
 * `resolveSkillsDir(agentId)`): the bundled set ships with the npm package, the
 * workspace set lives under `~/.brigade/workspace/skills/`. We walk both and
 * emit the name + first-line description; `info <name>` prints the body.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { DEFAULT_AGENT_ID, resolveBundledSkillsDir, resolveSkillsDir } from "../../config/paths.js";

interface SkillEntry {
	name: string;
	source: "bundled" | "workspace";
	path: string;
	description: string;
}

function readSkill(dir: string, name: string, source: SkillEntry["source"]): SkillEntry | null {
	const skillFile = ["SKILL.md", "skill.md"]
		.map((f) => path.join(dir, name, f))
		.find((p) => existsSync(p));
	if (!skillFile) return null;
	let description = "";
	try {
		const head = readFileSync(skillFile, "utf8").split(/\r?\n/).slice(0, 40);
		// Look for `description:` in frontmatter or the first non-empty body line.
		const desc = head.find((line) => /^description\s*:/i.test(line));
		description = desc ? desc.split(/:\s*/, 2)[1]?.trim() ?? "" : head.find((l) => l.trim() && !l.startsWith("---")) ?? "";
		description = description.slice(0, 140);
	} catch {
		/* ignore */
	}
	return { name, source, path: skillFile, description };
}

function scanSkillsDir(dir: string, source: SkillEntry["source"]): SkillEntry[] {
	if (!existsSync(dir)) return [];
	const out: SkillEntry[] = [];
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		const entry = readSkill(dir, name, source);
		if (entry) out.push(entry);
	}
	return out;
}

function discoverSkills(agentId: string): SkillEntry[] {
	const bundled = scanSkillsDir(resolveBundledSkillsDir(), "bundled");
	const workspace = scanSkillsDir(resolveSkillsDir(agentId), "workspace");
	// Workspace wins on name collision (operator overrides bundled).
	const byName = new Map<string, SkillEntry>();
	for (const s of bundled) byName.set(s.name, s);
	for (const s of workspace) byName.set(s.name, s);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function runSkillsList(opts: { json?: boolean } = {}): Promise<number> {
	const skills = discoverSkills(DEFAULT_AGENT_ID);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ skills }, null, 2)}\n`);
		return 0;
	}
	if (skills.length === 0) {
		process.stdout.write("No skills found.\n");
		return 0;
	}
	process.stdout.write(`${"NAME".padEnd(28)} ${"SOURCE".padEnd(10)}  DESCRIPTION\n`);
	for (const s of skills) {
		process.stdout.write(`${s.name.padEnd(28)} ${s.source.padEnd(10)}  ${s.description}\n`);
	}
	return 0;
}

export async function runSkillsInfo(args: { name: string }, opts: { json?: boolean } = {}): Promise<number> {
	const skills = discoverSkills(DEFAULT_AGENT_ID);
	const skill = skills.find((s) => s.name === args.name);
	if (!skill) {
		process.stderr.write(`Skill "${args.name}" not found.\n`);
		return 1;
	}
	let body = "";
	try {
		body = readFileSync(skill.path, "utf8");
	} catch (err) {
		process.stderr.write(`Failed to read ${skill.path}: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ...skill, body }, null, 2)}\n`);
	} else {
		process.stdout.write(`# ${skill.name} (${skill.source})\n${skill.path}\n\n${body}\n`);
	}
	return 0;
}
