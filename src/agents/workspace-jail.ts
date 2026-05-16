/**
 * Workspace path jail — refuses tool calls that try to write outside
 * the agent's workspace directory, and gates `bash` through the
 * exec-approvals allowlist.
 *
 * Wired into Pi's `session.agent.beforeToolCall` hook AFTER the
 * unknown-tool guard. The two guards are composed in `agent-loop.ts`:
 * unknown-tool first (name validation), then workspace-jail (path
 * validation for path-taking tools + bash policy gate).
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
 *   2. SHELL (`bash`) — routed through `decideApproval` from
 *      `../core/exec-approvals.js`:
 *        - `"deny"` (hard-deny pattern: rm -rf /, dd to raw disk,
 *          fork bomb, etc.) → blocked with a permanent-refusal reason.
 *        - `"allow"` (operator-approved exact command or pattern) →
 *          passes through to Pi's bash tool.
 *        - `"prompt"` (unknown command, v1 has no in-tui approval UI) →
 *          blocked with instructions on how to allowlist it via
 *          `brigade exec allow <cmd>` / `brigade exec allow-pattern <re>`.
 *      No mid-turn TUI prompt in v1 — single-user, file-backed
 *      allowlist is the v1 trust model. Channels + async approval
 *      flows ship in Phase 2.
 *
 *   3. READ-ONLY (`read`, `grep`, `find`, `ls`) — left open. These
 *      cannot mutate state, and the "AI lives inside your workspace"
 *      UX leans on the agent being able to inspect surrounding code.
 *      Finer-grained read-scope policies may land later; v1 keeps
 *      them broad to preserve the working flow.
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

import { decideApproval } from "../core/exec-approvals.js";
import type { BrigadeBeforeToolCallHook } from "./tool-guard.js";

/**
 * Tools whose `path` argument is restricted to inside the workspace.
 * Adding a new mutating tool? Put it here too.
 */
const PATH_MUTATING_TOOLS = new Set(["write", "edit"]);

/**
 * Tools whose invocation is gated through the exec-approvals allowlist.
 * v1 has only `bash`; the gate is general enough to take on additional
 * shell-shaped tools (`sh`, `pwsh`, `cmd`) when/if Brigade exposes them.
 */
const EXEC_GATED_TOOLS = new Set(["bash"]);

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
 * Resolve a path THE SAME WAY Pi will. Pi's `read` / `write` / `edit`
 * resolve non-absolute inputs against the cwd the session was created
 * with — NOT the workspace dir. The jail must mimic this resolution
 * exactly, otherwise a relative path looks safe (resolves against
 * workspace) but actually lands somewhere else.
 *
 * Concrete bug this prevents: model emits `write({path: "USER.md"})`,
 * agent runs from `F:\Brigade`, Pi writes `F:\Brigade\USER.md` —
 * outside the workspace. Without this function the lexical jail check
 * mistakenly allows it because `<workspace>/USER.md` is inside the
 * boundary, but Pi never resolved it that way.
 */
function actualPiResolvedPath(rawPath: string, processCwd: string): string {
	if (!rawPath) return path.resolve(processCwd);
	const cleaned = normalizeWhitespace(rawPath);
	const expanded = cleaned.startsWith("~")
		? cleaned.replace(/^~(?=$|[/\\])/, () => process.env.HOME ?? process.env.USERPROFILE ?? "~")
		: cleaned;
	if (path.isAbsolute(expanded)) return path.resolve(expanded);
	return path.resolve(processCwd, expanded);
}

/**
 * Build a `beforeToolCall` hook that enforces the three policies above.
 *
 * @param workspaceRoot — agent persona dir; mutating tools stay inside.
 * @param processCwd — cwd Pi was given when the session was created.
 *   Pi resolves relative tool paths against THIS, not workspaceRoot.
 *   Defaults to `process.cwd()` if omitted.
 *
 * Compose with `makeUnknownToolGuard` at the call site:
 *
 *   const nameGuard = makeUnknownToolGuard(enabledToolNames);
 *   const jailGuard = makeWorkspaceJailGuard(workspaceRoot, processCwd);
 *   session.agent.beforeToolCall = async (ctx, signal) => {
 *     return (await nameGuard(ctx, signal)) ?? (await jailGuard(ctx, signal));
 *   };
 */
export function makeWorkspaceJailGuard(
	workspaceRoot: string,
	processCwd: string = process.cwd(),
): BrigadeBeforeToolCallHook {
	const root = path.resolve(workspaceRoot);
	const cwd = path.resolve(processCwd);
	return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = typeof rawName === "string" ? rawName.trim() : "";
		if (!name) return undefined;

		const args = (ctx as { toolCall?: { arguments?: unknown }; args?: unknown; arguments?: unknown })
			?.toolCall?.arguments
			?? (ctx as { args?: unknown })?.args
			?? (ctx as { arguments?: unknown })?.arguments
			?? {};

		if (EXEC_GATED_TOOLS.has(name)) {
			// Pull the command out of the tool args. Pi's `bash` tool accepts
			// `command` (the OpenClaw/Anthropic convention); some providers
			// emit `cmd` or `script` instead — fall back through them.
			const cmdRaw =
				(args && typeof args === "object"
					? ((args as { command?: unknown }).command
						?? (args as { cmd?: unknown }).cmd
						?? (args as { script?: unknown }).script)
					: undefined);
			const cmd = typeof cmdRaw === "string" ? cmdRaw : "";
			const decision = decideApproval(cmd);
			if (decision === "allow") {
				return undefined;
			}
			if (decision === "deny") {
				return {
					block: true,
					reason:
						`Tool "${name}" was blocked: command "${cmd.slice(0, 120)}" ` +
						`matches a hard-deny pattern (e.g. rm -rf /, dd to raw disk, ` +
						`fork bomb). This pattern is permanently refused and cannot be ` +
						`allowlisted — pick a safer command.`,
				};
			}
			// "prompt" — operator hasn't allowlisted this command yet. v1
			// has no mid-turn TUI prompt UI, so we refuse and tell the
			// model exactly how the operator can approve it.
			const preview = cmd.slice(0, 200) || "(empty command)";
			return {
				block: true,
				reason:
					`Tool "${name}" was blocked: command "${preview}" is not on the ` +
					`exec-approvals allowlist. The operator must run\n` +
					`  brigade exec allow ${JSON.stringify(cmd || "<command>")}\n` +
					`(or \`brigade exec allow-pattern <regex>\` for a family of commands) ` +
					`before this command can execute. Until then, prefer ` +
					`"read", "grep", "find", or "ls" — those tools never need approval.`,
			};
		}

		if (!PATH_MUTATING_TOOLS.has(name)) return undefined;

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

		// Compute the path Pi will ACTUALLY use. Pi resolves non-absolute
		// inputs against the session cwd (`processCwd`), not the workspace.
		// Without this step the jail used to mis-validate relative paths:
		// a model emitting `write({path: "USER.md"})` looked safe because
		// `<workspace>/USER.md` is inside the boundary, but Pi wrote to
		// `<processCwd>/USER.md` instead — outside. Validate the path
		// Pi will USE, not the path the workspace would use.
		const piResolved = actualPiResolvedPath(candidate, cwd);
		const piResolvedOk = isPathInsideWorkspace(piResolved, root);
		if (!piResolvedOk) {
			const suggestedAbsolute = path.join(root, path.basename(candidate));
			return {
				block: true,
				reason:
					`Tool "${name}" was blocked: path "${candidate}" resolves to "${piResolved}" ` +
					`which is outside the workspace "${root}". Persona files (USER.md, ` +
					`IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, BOOTSTRAP.md, HEARTBEAT.md, ` +
					`MEMORY.md) belong inside the workspace. Retry with the absolute path ` +
					`"${suggestedAbsolute}" so it lands inside the workspace regardless of ` +
					`the agent's current working directory.`,
			};
		}

		// Final realpath check — catches the symlink-alias-escape case
		// where the path is lexically inside the workspace but the
		// canonical (realpath-resolved) path is outside.
		const aliasOk = await isPathInsideWorkspaceWithAlias(piResolved, root);
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
