/**
 * `find` tool — Brigade-native file search by glob pattern.
 *
 * Why Brigade ships its own instead of Pi's builtin
 * -------------------------------------------------
 * Pi's builtin `find` shells out to `fd` and, for any pattern containing a
 * `/` (e.g. `**` + `/SKILL.md`), switches fd into `--glob --full-path` mode.
 * On Windows that combination matches NOTHING — fd builds its full-path
 * candidates with backslashes while glob patterns use forward slashes, and
 * `--path-separator` only affects printing, not matching (verified against
 * fd 10.4.2 on a trivial tree: every `--glob --full-path` variant returned
 * zero results while regex mode found the file).
 *
 * Production impact (2026-06-11, operator field report): the model searched
 * `**` + `/SKILL.md` under `~/.brigade`, got "No files found", and concluded
 * that nine just-created agent skills "failed silently or got rolled back" —
 * they were all on disk. Node's own `fs.promises.glob` (v24.14) was probed
 * as a replacement and is ALSO broken for `**` patterns on win32, so this
 * implementation walks directories itself and matches with `minimatch`
 * (direct dependency) — the same matcher family the npm CLI uses.
 *
 * Behaviour parity with the Pi builtin it replaces:
 *   - Same name/schema (`pattern`, `path?`, `limit?`), so model-facing
 *     call shapes are unchanged.
 *   - Results are forward-slash paths relative to the search directory.
 *   - `node_modules` + `.git` subtrees are pruned.
 *   - Hidden (dot) entries ARE traversed and matchable (fd ran with
 *     `--hidden`; minimatch gets `dot: true`).
 *   - Empty result → the literal "No files found matching pattern" text the
 *     model already knows.
 *   - Default cap 1000 results with an explicit truncation notice.
 *
 * Deliberate differences:
 *   - `.gitignore` is NOT consulted (fd did). For Brigade's use — searching
 *     `~/.brigade` state and workspaces, which aren't git repos — ignoring
 *     gitignore is more often correct than not.
 *   - Symlinked directories are listed but never descended (cycle safety).
 */

import fs from "node:fs";
import path from "node:path";

import { minimatch } from "minimatch";
import { Type } from "typebox";

import type { AgentToolResult, BrigadeTool } from "./types.js";

const FindToolParams = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern to match files, e.g. '*.ts', '**" +
			"/*.json', or 'src/**" +
			"/*.spec.ts'. Matched against the path RELATIVE to the search directory using forward slashes.",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Directory to search in (default: current directory). Absolute Windows paths (C:\\…) are fine.",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of results (default: 1000)" }),
	),
});

const DEFAULT_LIMIT = 1000;
/** Directory names never descended into — matches the Pi builtin's pruning. */
const PRUNED_DIR_NAMES = new Set(["node_modules", ".git"]);

interface FindToolDetails {
	resultLimitReached?: number;
}

export interface MakeFindToolOptions {
	/** Base directory relative `path` arguments resolve against. */
	cwd: string;
}

export function makeFindTool(
	opts: MakeFindToolOptions,
): BrigadeTool<typeof FindToolParams, FindToolDetails> {
	return {
		name: "find",
		label: "find",
		displaySummary: "finding files",
		description:
			"Search for files by glob pattern. Returns matching file paths relative to the search " +
			"directory (forward slashes). Hidden files are included; node_modules and .git are " +
			`skipped. Output is capped at ${DEFAULT_LIMIT} results unless \`limit\` is set.`,
		parameters: FindToolParams,
		execute: async (
			_toolCallId,
			args,
			signal,
		): Promise<AgentToolResult<FindToolDetails>> => {
			const searchPath = path.resolve(opts.cwd, (args.path ?? ".").trim() || ".");
			let stat: fs.Stats;
			try {
				stat = await fs.promises.stat(searchPath);
			} catch {
				throw new Error(`Path not found: ${searchPath}`);
			}
			if (!stat.isDirectory()) {
				throw new Error(`Not a directory: ${searchPath}`);
			}
			const effectiveLimit =
				typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
					? Math.floor(args.limit)
					: DEFAULT_LIMIT;
			// Normalise the pattern to forward slashes — models on Windows
			// sometimes emit backslash separators; minimatch treats `\` as an
			// escape character, never a separator.
			const pattern = args.pattern.replace(/\\/g, "/");
			// Parity with the fd-backed builtin this replaces: a pattern with
			// NO `/` (e.g. `*.ts`, `SKILL.md`) matches by BASENAME at ANY depth
			// — fd's default glob behavior. minimatch on the full relative path
			// would only match root-level entries, so the model's habitual
			// `find {pattern:"*.md"}` would silently miss nested files (the
			// builtin found them). A pattern WITH `/` matches the full relative
			// path as written. `**/x` already works under both readings.
			const matchByBasename = !pattern.includes("/");
			const nocase = process.platform === "win32";
			const matcher = (rel: string): boolean => {
				if (minimatch(rel, pattern, { dot: true, nocase })) return true;
				if (matchByBasename) {
					const base = rel.slice(rel.lastIndexOf("/") + 1);
					return minimatch(base, pattern, { dot: true, nocase });
				}
				return false;
			};
			const results: string[] = [];
			await walk(searchPath, "", matcher, results, effectiveLimit, signal);
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No files found matching pattern" }],
					details: {},
				};
			}
			const limitReached = results.length >= effectiveLimit;
			let text = results.join("\n");
			if (limitReached) {
				text += `\n\n[${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern]`;
			}
			return {
				content: [{ type: "text", text }],
				details: limitReached ? { resultLimitReached: effectiveLimit } : {},
			};
		},
	};
}

/**
 * Depth-first directory walk. Appends forward-slash relative paths matching
 * `matcher` to `out` until `limit` is hit. Sorted per directory so output
 * is deterministic across platforms/filesystems.
 */
async function walk(
	absDir: string,
	relDir: string,
	matcher: (rel: string) => boolean,
	out: string[],
	limit: number,
	signal?: AbortSignal,
): Promise<void> {
	if (out.length >= limit) return;
	if (signal?.aborted) throw new Error("Operation aborted");
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(absDir, { withFileTypes: true });
	} catch {
		// Unreadable subdirectory (permissions, races) — skip rather than fail
		// the whole search.
		return;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		if (out.length >= limit) return;
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (PRUNED_DIR_NAMES.has(entry.name)) continue;
			if (matcher(rel)) {
				out.push(`${rel}/`);
				if (out.length >= limit) return;
			}
			await walk(path.join(absDir, entry.name), rel, matcher, out, limit, signal);
			continue;
		}
		// Files AND symlinks (not followed) are match candidates.
		if (matcher(rel)) out.push(rel);
	}
}
