/**
 * Workspace path jail — refuses tool calls that try to write or shell
 * outside the agent's workspace directory.
 *
 * Wired into Pi's `session.agent.beforeToolCall` hook AFTER the
 * unknown-tool guard. The two guards are composed in `agent-loop.ts`:
 * unknown-tool first (name validation), then workspace-jail (path
 * validation for path-taking tools).
 *
 * Three policies, one per risk level:
 *
 *   1. WRITES (`write`, `edit`) — path MUST resolve inside the workspace
 *      root, BOTH lexically and after realpath resolution. Relative
 *      paths resolve against the workspace root, NOT process cwd, so a
 *      tool call like `write({path: "USER.md"})` lands at
 *      `<workspace>/USER.md` — exactly what BOOTSTRAP.md tells the
 *      model to do. Absolute paths must be inside the workspace root.
 *      `..` traversal escapes are blocked. Windows UNC paths
 *      (`\\server\share`) are blocked. Symlink alias escapes
 *      (lexically-inside path that realpath-resolves outside) are
 *      blocked via a final realpath comparison.
 *
 *   2. SHELL (`bash`) — refused entirely in this layer. There is no
 *      command-pattern allowlist, no approval flow, no per-pattern
 *      caching in v1. The proper exec-policy layer (analyzer +
 *      allowlist + safe-bins + approval flow) ships in Primitive #3.
 *      Until then, shell is gated off so a turn cannot run arbitrary
 *      commands against the user's host.
 *
 *   3. READ-ONLY (`read`, `grep`, `find`, `ls`) — left open. These
 *      cannot mutate state, and the "AI lives inside your workspace"
 *      UX leans on the agent being able to inspect surrounding code.
 *      Primitive #3 may add finer-grained read-scope policies; v1
 *      keeps them broad to preserve the working flow.
 *
 * Architecture choice: hook-based gating (single `beforeToolCall`
 * function on the session) vs per-tool wrapping (each Pi tool
 * individually wrapped with its own validator). Brigade keeps the hook
 * pattern because (a) we have 7 tools, branching is trivial; (b) Pi's
 * `tools` field is an allowlist of names — switching to wrapped tools
 * means going through `customTools`, which is a Primitive #3 redesign.
 * The reference implementation in `pi-tools.read.ts:587-622` uses
 * wrappers because their tool set is 30+ and per-tool customization
 * (containerWorkdir, pathParamKeys) varies per tool family.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { BeforeToolCallContext, BeforeToolCallResult } from "@mariozechner/pi-agent-core";

import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

/**
 * Tools whose `path` argument is restricted to inside the workspace.
 * Adding a new mutating tool? Put it here too.
 */
const PATH_MUTATING_TOOLS = new Set(["write", "edit"]);

/**
 * Tools that are refused outright in v1. Until Primitive #3 ships
 * proper exec-policy + approval flow, blanket-deny rather than open
 * an unbounded shell to the host.
 */
const REFUSED_IN_V1 = new Set(["bash"]);

/**
 * Unicode whitespace codepoints that some providers occasionally emit
 * inside path arguments (NBSP, em-space, ideographic space, …). They
 * confuse `path.normalize` on POSIX and survive most regex string
 * checks. Normalize them to a single ASCII space before resolving.
 * Matches the reference implementation at `sandbox-paths.ts:15-20`.
 */
const UNICODE_WHITESPACE_RE =
	/[   -‍  　﻿]/g;

function normalizeWhitespace(input: string): string {
	return input.replace(UNICODE_WHITESPACE_RE, " ");
}

/**
 * Reject Windows UNC paths outright — `\\server\share\file` resolves
 * to a network share, which is never inside the local workspace by
 * any sane definition. Mirrors the reference at
 * `sandbox-paths.test.ts:311-324`.
 */
function isUncPath(input: string): boolean {
	return input.startsWith("\\\\") || input.startsWith("//");
}

/**
 * Resolve a path argument against the workspace root, normalizing `~`,
 * relative segments, `..` traversal, and Unicode whitespace. Returns
 * the absolute resolved path. Does NOT verify the result is inside
 * the workspace — that's what `isPathInsideWorkspace` does.
 */
export function resolveAgainstWorkspace(rawPath: string, workspaceRoot: string): string {
	if (!rawPath) return path.resolve(workspaceRoot);
	const cleaned = normalizeWhitespace(rawPath);
	const expanded = cleaned.startsWith("~")
		? cleaned.replace(/^~(?=$|[/\\])/, () => process.env.HOME ?? process.env.USERPROFILE ?? "~")
		: cleaned;
	if (path.isAbsolute(expanded)) return path.resolve(expanded);
	return path.resolve(workspaceRoot, expanded);
}

/**
 * Lexical check: is `candidate` (a possibly-relative path) inside
 * `workspaceRoot` after normalization? Returns true iff the resolved
 * path is `root` itself or a descendant of `root`.
 *
 * THIS DOES NOT detect symlink alias escapes — a path like
 * `<workspace>/symlink-to-etc-passwd` is lexically inside but
 * canonically points outside. Use `isPathInsideWorkspaceWithAlias`
 * for the full check.
 *
 * Case sensitivity follows the platform: Windows path comparisons are
 * case-insensitive, POSIX comparisons stay case-sensitive.
 */
export function isPathInsideWorkspace(candidate: string, workspaceRoot: string): boolean {
	if (isUncPath(candidate)) return false;
	const resolvedCandidate = resolveAgainstWorkspace(candidate, workspaceRoot);
	const resolvedRoot = path.resolve(workspaceRoot);
	const rel = path.relative(resolvedRoot, resolvedCandidate);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

/**
 * Walk up to find an existing ancestor and realpath it, then re-append
 * the missing tail. Mirrors the algorithm at `boundary-path.ts:54,
 * 682-690` in the reference: handles broken symlinks (path doesn't
 * exist but ancestor does) and missing leaf components without
 * losing alias-escape detection on the realpath portion of the chain.
 */
async function realpathOrAncestor(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		const parent = path.dirname(target);
		if (parent === target) return target;
		const realParent = await realpathOrAncestor(parent);
		return path.join(realParent, path.basename(target));
	}
}

/**
 * Full alias-aware check: candidate must be lexically inside the
 * workspace AND must realpath-resolve to a location inside the
 * realpath of the workspace root. This catches symlink escapes —
 * e.g., a model that calls `write({path: "USER.md"})` when
 * `<workspace>/USER.md` is a pre-existing symlink to `/etc/passwd`.
 *
 * Cost: one realpath syscall on the candidate path, one on the
 * workspace root (could be cached per-guard but isn't yet — the
 * cost is dominated by the realpath of the candidate, not the
 * already-fast realpath of a long-lived dir). Mirrors the
 * algorithm in `path-alias-guards.ts` referenced from
 * `sandbox-paths.ts:87-92`.
 */
export async function isPathInsideWorkspaceWithAlias(
	candidate: string,
	workspaceRoot: string,
): Promise<boolean> {
	if (!isPathInsideWorkspace(candidate, workspaceRoot)) return false;
	const lexical = resolveAgainstWorkspace(candidate, workspaceRoot);
	const realCandidate = await realpathOrAncestor(lexical);
	const realRoot = await realpathOrAncestor(path.resolve(workspaceRoot));
	const rel = path.relative(realRoot, realCandidate);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	if (path.isAbsolute(rel)) return false;
	return true;
}

/**
 * Build a `beforeToolCall` hook that enforces the three policies above.
 * Compose with `makeUnknownToolGuard` at the call site:
 *
 *   const nameGuard = makeUnknownToolGuard(enabledToolNames);
 *   const jailGuard = makeWorkspaceJailGuard(workspaceRoot);
 *   session.agent.beforeToolCall = async (ctx, signal) => {
 *     return (await nameGuard(ctx, signal)) ?? (await jailGuard(ctx, signal));
 *   };
 */
export function makeWorkspaceJailGuard(workspaceRoot: string): BrigadeBeforeToolCallHook {
	const root = path.resolve(workspaceRoot);
	return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = typeof rawName === "string" ? rawName.trim() : "";
		if (!name) return undefined;

		if (REFUSED_IN_V1.has(name)) {
			return {
				block: true,
				reason:
					`Tool "${name}" is disabled in this build. Shell access is gated until ` +
					`the exec-policy layer ships. If you need to inspect the workspace, ` +
					`use "read", "grep", "find", or "ls" instead.`,
			};
		}

		if (!PATH_MUTATING_TOOLS.has(name)) return undefined;

		const args = (ctx as { toolCall?: { arguments?: unknown }; args?: unknown; arguments?: unknown })
			?.toolCall?.arguments
			?? (ctx as { args?: unknown })?.args
			?? (ctx as { arguments?: unknown })?.arguments
			?? {};

		if (!args || typeof args !== "object") return undefined;
		const candidate = (args as { path?: unknown }).path;
		if (typeof candidate !== "string" || candidate.length === 0) return undefined;

		// UNC rejection runs first — `\\server\share` would confuse
		// path.relative on Windows in non-obvious ways and is never a
		// legitimate workspace path.
		if (isUncPath(candidate)) {
			return {
				block: true,
				reason:
					`Tool "${name}" was blocked: UNC / network paths (\\\\server\\share or //host/path) ` +
					`are not allowed. Persona files belong inside the workspace at "${root}".`,
			};
		}

		const lexicalOk = isPathInsideWorkspace(candidate, root);
		if (!lexicalOk) {
			const resolved = resolveAgainstWorkspace(candidate, root);
			return {
				block: true,
				reason:
					`Tool "${name}" was blocked: path "${candidate}" resolves to "${resolved}" ` +
					`which is outside the workspace "${root}". Persona files (USER.md, ` +
					`IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, BOOTSTRAP.md, HEARTBEAT.md, ` +
					`MEMORY.md) belong inside the workspace — use a relative path like ` +
					`"USER.md" and the tool will resolve it against the workspace root.`,
			};
		}

		// Final realpath check — catches the symlink-alias-escape case
		// where the lexical path is inside the workspace but the
		// canonical (realpath-resolved) path is outside. The check is
		// async because realpath is async; the caller's hook signature
		// is already Promise-returning so this is free.
		const aliasOk = await isPathInsideWorkspaceWithAlias(candidate, root);
		if (!aliasOk) {
			return {
				block: true,
				reason:
					`Tool "${name}" was blocked: path "${candidate}" lexically resolves inside ` +
					`the workspace but its canonical (realpath) location is outside "${root}". ` +
					`This usually means the path passes through a symlink that escapes the ` +
					`workspace boundary. Pick a path that doesn't traverse a symlink.`,
			};
		}
		return undefined;
	};
}
