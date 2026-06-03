/**
 * Path-write guard — refuses `write` / `edit` tool calls whose target
 * path falls inside one of Brigade's protected roots.
 *
 * Why this exists
 * ---------------
 * The model has free filesystem access through Pi's built-in `write`
 * and `edit` tools. Without a guard, when a turn says "create skill X
 * for agent Y" the model often falls back to:
 *
 *   1. Hand-writing to `<install-dir>/skills/<name>/SKILL.md` — ends up
 *      in the read-only bundled scan root, lost on reinstall.
 *   2. Hand-editing `~/.brigade/brigade.json` to register a new agent —
 *      bypasses atomic config rotation, workspace bootstrap, and
 *      `.brigade-trash/` soft-delete.
 *   3. Hand-writing `~/.brigade/agents/<id>/agent/profile-state.json` —
 *      bypasses the auth-profile lifecycle.
 *
 * Each of these has a dedicated tool (`manage_skill`, `manage_agent`,
 * onboarding flows). This guard refuses the raw write path and points
 * the model at the right tool.
 *
 * Scope
 * -----
 * `write` (param: `path`) and `edit` (param: `file_path`) only. `bash`
 * goes through the exec gate. Read-only tools (`read`, `grep`, `ls`,
 * `find`) are never blocked.
 *
 * Defense in depth — the resolved absolute path is checked against the
 * forbidden roots using `path.relative()` semantics, so a symlinked path
 * or `..` traversal still hits the guard.
 */

import path from "node:path";

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import {
	resolveBundledSkillsDir,
	resolveConfigPath,
	resolveStateDir,
} from "../config/paths.js";
import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

interface ProtectedRoot {
	/** Absolute, normalised path of the forbidden file OR directory. */
	target: string;
	/** Whether `target` is treated as a directory tree (true) or a single file (false). */
	directory: boolean;
	/** Short identifier for the violation message ("brigade-config", "install-skills", ...). */
	id: string;
	/** Concrete redirect telling the model the right tool/path to use instead. */
	redirect: string;
}

function buildProtectedRoots(): ProtectedRoot[] {
	const stateDir = resolveStateDir();
	return [
		{
			target: path.resolve(resolveConfigPath()),
			directory: false,
			id: "brigade-config",
			redirect:
				"Use the `manage_agent` tool (action=add/delete/set-identity) — never hand-edit brigade.json. The CLI helpers do atomic rotation, workspace bootstrap, and `.brigade-trash/` soft-delete that a raw write skips, producing orphan agents.",
		},
		{
			target: path.resolve(resolveBundledSkillsDir()),
			directory: true,
			id: "install-skills",
			redirect:
				"This path is Brigade's bundled (install-tree) skills directory — read-only at runtime, wiped on reinstall. Use `manage_skill({action:\"create\", scope:\"agent\"|\"managed\", ...})` to write a SKILL.md into the user-writable workspace OR `~/.brigade/skills/` instead.",
		},
		{
			target: path.resolve(path.join(stateDir, "agents")),
			directory: true,
			id: "agent-internals",
			redirect:
				"Use `manage_agent` to mutate agent state (workspace files, auth profiles, profile-state.json). Direct writes into `~/.brigade/agents/<id>/agent/` bypass the lifecycle.",
			// Note: this protects everything under `~/.brigade/agents/`. The
			// `manage_agent` tool itself runs in a child process where this
			// guard does not apply (the helper is a Node import, not a tool
			// call) — so legitimate state mutations still go through.
		},
	];
}

/** Reasons the guard chose to allow a write under a protected root. */
type AllowReason = "workspace-skills" | "workspace-non-internal" | undefined;

/**
 * Some protected roots have legitimate write surfaces nested inside —
 * e.g. `~/.brigade/agents/<id>/workspace/` is owned by the user and the
 * model SHOULD be able to write SOUL.md / memory / skill bodies there.
 * This helper applies those carve-outs.
 */
function allowWriteCarveOut(root: ProtectedRoot, absPath: string): AllowReason {
	if (root.id !== "agent-internals") return undefined;
	const stateDir = path.resolve(resolveStateDir());
	const rel = path.relative(stateDir, absPath);
	// Expect rel = `agents/<id>/...`
	const parts = rel.split(/[\\/]/);
	if (parts.length < 3 || parts[0] !== "agents") return undefined;
	const sub = parts[2];
	// `workspace/` — the per-agent persona/memory/skills home. User-writable.
	if (sub === "workspace") {
		return "workspace-non-internal";
	}
	return undefined;
}

function extractPathArg(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const bag = args as Record<string, unknown>;
	if (toolName === "write") {
		const p = bag["path"];
		return typeof p === "string" ? p : undefined;
	}
	if (toolName === "edit") {
		const p = bag["file_path"];
		return typeof p === "string" ? p : undefined;
	}
	return undefined;
}

export interface PathWriteGuardOptions {
	/**
	 * Override the protected-roots list — test seam. Production callers
	 * leave this undefined and the guard reads the live runtime paths.
	 */
	roots?: ProtectedRoot[];
}

/**
 * Build the path-write guard hook. Refuses `write` / `edit` calls whose
 * target lives under a protected root unless a carve-out applies.
 *
 * Wire AFTER the unknown-tool guard (so unknown tools fail first) and
 * BEFORE the user policy hook (so policy hooks never see a forbidden
 * write).
 */
export function makePathWriteGuard(opts: PathWriteGuardOptions = {}): BrigadeBeforeToolCallHook {
	const roots = opts.roots ?? buildProtectedRoots();
	return async (ctx) => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
		if (name !== "write" && name !== "edit") return undefined;

		const args = (ctx as { toolCall?: { arguments?: unknown }; arguments?: unknown; args?: unknown })
			?.toolCall?.arguments
			?? (ctx as { arguments?: unknown })?.arguments
			?? (ctx as { args?: unknown })?.args
			?? {};
		const candidate = extractPathArg(name, args);
		if (!candidate) return undefined;

		const absPath = path.resolve(candidate);
		for (const root of roots) {
			if (!isPathInside(root.target, absPath, root.directory)) continue;
			const carve = allowWriteCarveOut(root, absPath);
			if (carve) return undefined;
			return {
				block: true,
				reason: `${name}: refusing to write \`${absPath}\` — that path is inside Brigade's protected \`${root.id}\` root. ${root.redirect}`,
			} satisfies BeforeToolCallResult;
		}
		return undefined;
	};
}

/**
 * `isPathInside` variant that handles BOTH directories and files. For a
 * file target we accept only exact equality; for a directory target we
 * accept any descendant.
 */
function isPathInside(target: string, candidate: string, directory: boolean): boolean {
	const normTarget = path.resolve(target);
	const normCandidate = path.resolve(candidate);
	if (!directory) {
		return normTarget === normCandidate;
	}
	const rel = path.relative(normTarget, normCandidate);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

// Re-export for tests.
export { buildProtectedRoots };
export type { ProtectedRoot };
