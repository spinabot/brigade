// src/storage/local/skill-store.ts
//
// LocalSkillStore — filesystem-mode wrapper around `agents/skills/*`.
// Implements `SkillStore`.
//
// Skill discovery is 6-source (bundled / config-extras / managed / personal /
// project / workspace) with last-root-wins precedence. Reads are stateless
// directory scans — no caching at this layer (the per-turn `discoverEligible-
// Skills` is sub-millisecond at user scale).
//
// Write surface (managed + workspace scopes only) maps to drop-a-folder-it-
// works: `<scopeRoot>/<name>/SKILL.md`. Bundled is read-only.

import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { discoverSkills } from "../../agents/skills/discovery.js";
import { buildSkillStatusReport } from "../../agents/skills/status.js";
import type { BrigadeConfig } from "../../config/io.js";
import {
	resolveAgentWorkspaceDir,
	resolveBundledSkillsDir,
} from "../../config/paths.js";

import type {
	SkillBody,
	SkillRecord,
	SkillStatusReport,
	SkillStore,
} from "../store.js";

function resolveScopeRoot(
	scope: "managed" | "workspace",
	agentId: string | undefined,
	stateDir: string,
): string {
	// Managed root is pinned to THIS store's stateDir, NOT the mode-aware
	// resolveManagedSkillsDir(): the Local store IS the filesystem backend by
	// definition. During `store migrate --to filesystem` the process runs
	// under a CONVEX context (the backend must be up to read the source), so
	// the mode-aware resolver would route the target's managed-skill writes
	// to the OS cache — invisible to filesystem discovery after the flip,
	// with a false-green verify (list scans the same wrong dir). Identical
	// path in plain filesystem mode.
	if (scope === "managed") return path.join(stateDir, "skills");
	// workspace scope — per-agent workspace
	const id = agentId ?? "main";
	return path.join(resolveAgentWorkspaceDir(id), "skills");
}

function sanitizeSkillName(name: string): string {
	if (!/^[A-Za-z0-9_\-]+$/.test(name)) {
		throw new Error(
			`LocalSkillStore: skill name "${name}" is invalid (only letters / digits / "_" / "-" allowed)`,
		);
	}
	return name;
}

export class LocalSkillStore implements SkillStore {
	constructor(private readonly _stateDir: string) {}

	async list(args: {
		workspaceDir: string;
		managedDir?: string;
		bundledDir?: string;
		personalDir?: string;
		projectDir?: string;
		extraPaths?: string[];
	}): Promise<{ records: SkillRecord[]; diagnostics: unknown[] }> {
		const result = discoverSkills({
			workspaceSkillsDir: path.join(args.workspaceDir, "skills"),
			bundledSkillsDir: args.bundledDir ?? resolveBundledSkillsDir(),
			// Same stateDir pin as resolveScopeRoot — list/verify must scan the
			// exact root write() lands in, regardless of the process's mode.
			managedSkillsDir: args.managedDir ?? path.join(this._stateDir, "skills"),
			personalSkillsDir:
				args.personalDir ?? path.join(os.homedir(), ".agents", "skills"),
			projectSkillsDir:
				args.projectDir ?? path.join(args.workspaceDir, ".agents", "skills"),
			extraPaths: args.extraPaths ?? [],
		});
		// `DiscoveredSkill` has name / description / filePath / source / eligibility.
		// The public SkillRecord is structurally compatible (loose {name: string}
		// brand). Cast through.
		return {
			records: result.skills as unknown as SkillRecord[],
			diagnostics: result.diagnostics,
		};
	}

	async read(ref: string): Promise<SkillBody | undefined> {
		// `ref` is a file path to SKILL.md (or its containing dir). We accept
		// both shapes — convex-mode would use a more abstract ref, filesystem
		// mode keeps it concrete.
		let filePath = ref;
		try {
			const stat = fs.statSync(filePath);
			if (stat.isDirectory()) {
				filePath = path.join(filePath, "SKILL.md");
			}
		} catch {
			return undefined;
		}
		try {
			const body = fs.readFileSync(filePath, "utf8");
			return { body, path: filePath } as unknown as SkillBody;
		} catch {
			return undefined;
		}
	}

	async write(args: {
		scope: "managed" | "workspace";
		agentId?: string;
		name: string;
		content: string;
	}): Promise<{ ref: string; created: boolean }> {
		const safeName = sanitizeSkillName(args.name);
		const root = resolveScopeRoot(args.scope, args.agentId, this._stateDir);
		const dir = path.join(root, safeName);
		const file = path.join(dir, "SKILL.md");
		const created = !fs.existsSync(file);
		await fsAsync.mkdir(dir, { recursive: true });
		// Atomic tmp+rename — same discipline as workspace persona writes.
		const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`;
		await fsAsync.writeFile(tmp, args.content, { encoding: "utf-8" });
		await fsAsync.rename(tmp, file);
		return { ref: file, created };
	}

	async remove(args: {
		scope: "managed" | "workspace";
		agentId?: string;
		name: string;
	}): Promise<{ removed: boolean }> {
		const safeName = sanitizeSkillName(args.name);
		const root = resolveScopeRoot(args.scope, args.agentId, this._stateDir);
		const dir = path.join(root, safeName);
		if (!fs.existsSync(dir)) return { removed: false };
		await fsAsync.rm(dir, { recursive: true, force: true });
		return { removed: true };
	}

	async status(args: {
		workspaceDir: string;
		config: BrigadeConfig;
		agentId?: string;
	}): Promise<SkillStatusReport> {
		// `buildSkillStatusReport` owns its own root walk + discovery — pass
		// the workspaceDir + config directly. Discovery is sub-millisecond so
		// the redundancy of "discover then status" is not worth keeping.
		const report = buildSkillStatusReport({
			workspaceDir: args.workspaceDir,
			config: args.config,
			...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
		});
		return report as unknown as SkillStatusReport;
	}
}
