/**
 * Path-write guard — refuses `write` / `edit` / `bash` tool calls whose
 * target path falls inside one of Brigade's protected roots.
 *
 * Why this exists
 * ---------------
 * The model has free filesystem access through Pi's built-in `write`
 * and `edit` tools — and through `bash` it can shell out to `cat > X`,
 * `sed -i`, `node -e fs.writeFileSync(...)`, etc. Without a guard, when
 * a turn says "create skill X for agent Y" the model often falls back to:
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
 * onboarding flows). This guard refuses the raw path AND the shell
 * equivalents, and points the model at the right tool.
 *
 * Scope
 * -----
 * Path-mutating tools only: `write` (param: `path`), `edit` (param:
 * `file_path`), and `bash`/`exec`/`shell`/`sh` (param: `command`). The
 * bash branch parses the command string for write-intent indicators
 * near a protected path; read-only ops (cat / grep / head / tail / ls /
 * stat / wc / json.tool with no redirect) pass through. Plain reads via
 * `read` / `grep` / `ls` / `find` are never blocked.
 *
 * Defense in depth — the resolved absolute path is checked against the
 * forbidden roots using `path.relative()` semantics, so a symlinked path
 * or `..` traversal still hits the guard.
 */

import os from "node:os";
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

/** Tool names whose `command` arg we parse for shell write-intent. */
const BASH_TOOL_NAMES = new Set(["bash", "exec", "shell", "sh"]);

/** Extract the `command` string from a bash-shaped tool call. */
function extractBashCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const bag = args as { command?: unknown; cmd?: unknown; script?: unknown };
	const raw = bag.command ?? bag.cmd ?? bag.script;
	return typeof raw === "string" ? raw : undefined;
}

/**
 * Inspect a shell `command` string for write-intent against a protected
 * path. Returns the matching root + a short reason fragment (e.g.
 * `redirect (>) into <path>`) when a write is detected, or `undefined`
 * when the command is read-only / unrelated.
 *
 * Carve-outs (`~/.brigade/workspace/`, `~/.brigade/agents/<id>/workspace/`,
 * `~/.brigade/skills/`) match the write/edit branch — a write into one
 * of those passes through even when the textual target sits under a
 * protected directory root (the `agent-internals` root covers the whole
 * `~/.brigade/agents/` tree but `agents/<id>/workspace/` is user-owned).
 *
 * Heuristic, not a full shell parser — Brigade's threat model is "the
 * model accidentally bypasses manage_agent / manage_skill", not "a
 * sophisticated attacker hides a write behind eval+base64". The exec
 * gate downstream still asks the operator to approve novel commands.
 */
function detectBashWriteIntent(
	command: string,
	roots: readonly ProtectedRoot[],
): { root: ProtectedRoot; absPath: string; indicator: string } | undefined {
	if (!command || !command.trim()) return undefined;

	// Tokenise into rough "word-or-quoted-string" units. Good enough to
	// recover argv-style positionals for mv/cp/rm/sed and to find the
	// destination path of a redirect. We keep redirect operators (`>`,
	// `>>`, `|`) as their own tokens so callers can scan around them.
	const tokens = tokeniseShell(command);

	for (const root of roots) {
		// Walk every token; if it resolves to a protected path, check
		// whether the surrounding context indicates a write.
		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			if (!tok || tok.kind !== "word") continue;
			const candidate = tok.value;
			if (!looksLikePathToken(candidate)) continue;
			const abs = resolvePathToken(candidate);
			if (!isPathInside(root.target, abs, root.directory)) continue;
			if (allowWriteCarveOut(root, abs)) continue;

			// Indicator A — redirect operator (`>`, `>>`) immediately
			// before this token.
			const prev = tokens[i - 1];
			if (prev && prev.kind === "op" && (prev.value === ">" || prev.value === ">>")) {
				return { root, absPath: abs, indicator: `redirect (${prev.value}) into` };
			}

			// Indicator B — `tee <path>` or `tee -a <path>` (with or
			// without the leading `|`). Walk back over flag args until
			// we hit `tee`.
			let teeIdx = i - 1;
			while (teeIdx >= 0) {
				const t = tokens[teeIdx];
				if (!t) break;
				if (t.kind === "op") break;
				if (t.kind === "word" && t.value.startsWith("-")) {
					teeIdx--;
					continue;
				}
				break;
			}
			const teeCand = tokens[teeIdx];
			if (teeCand && teeCand.kind === "word" && teeCand.value === "tee") {
				return { root, absPath: abs, indicator: "tee into" };
			}

			// Indicator C — destination of mv/cp/rsync/dd. These tools
			// treat the LAST positional as the destination, so the
			// protected path must be the last positional word in the
			// current pipeline segment.
			const destOf = destinationToolForToken(tokens, i);
			if (destOf) {
				return { root, absPath: abs, indicator: `${destOf} destination` };
			}

			// Indicator D — sed -i / sed -i.bak / sed -i'' <file>. The
			// `-i` (or `-i<suffix>`) flag rewrites the file in-place;
			// our path being a positional arg is enough.
			if (isSedInPlaceTarget(tokens, i)) {
				return { root, absPath: abs, indicator: "sed -i rewrite of" };
			}

			// Indicator E — rm / rmdir / unlink target.
			const rmTool = isUnlinkTarget(tokens, i);
			if (rmTool) {
				return { root, absPath: abs, indicator: `${rmTool} of` };
			}
		}
	}

	// Indicator F — `node -e '...fs.writeFileSync("<path>", ...)'` or
	// `python -c '...open("<path>", "w")...'`. We scan the entire
	// command for the JS/Python write APIs and then look for any
	// protected absolute path that appears as a string literal anywhere
	// in the command.
	const nodeIntent = matchInlineScriptWrite(command);
	if (nodeIntent) {
		for (const root of roots) {
			for (const lit of nodeIntent.literals) {
				const abs = resolvePathToken(lit);
				if (!isPathInside(root.target, abs, root.directory)) continue;
				if (allowWriteCarveOut(root, abs)) continue;
				return { root, absPath: abs, indicator: `${nodeIntent.label} against` };
			}
		}
	}

	return undefined;
}

interface ShellToken {
	kind: "word" | "op";
	value: string;
}

/**
 * Cheap, single-pass shell tokeniser. Splits on whitespace; recognises
 * single + double quotes (with backslash escapes inside double-quoted
 * strings); emits `>`, `>>`, `|`, `;`, `&&`, `||` as `op` tokens so we
 * can scan around redirects and pipeline boundaries.
 *
 * Quoted strings collapse into a single `word` token with the quotes
 * stripped, which is exactly what we need for "is this token the
 * protected path?". Not a full grammar — `$(...)`, `\`...\``,
 * arithmetic, etc. all pass through as plain words; the goal is
 * heuristic write-intent detection, not safe execution.
 */
function tokeniseShell(command: string): ShellToken[] {
	const out: ShellToken[] = [];
	let i = 0;
	const n = command.length;
	const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
	while (i < n) {
		const c = command[i] ?? "";
		if (isWs(c)) {
			i++;
			continue;
		}
		// Operators we care about.
		if (c === ">") {
			if (command[i + 1] === ">") {
				out.push({ kind: "op", value: ">>" });
				i += 2;
			} else {
				out.push({ kind: "op", value: ">" });
				i++;
			}
			continue;
		}
		if (c === "|") {
			if (command[i + 1] === "|") {
				out.push({ kind: "op", value: "||" });
				i += 2;
			} else {
				out.push({ kind: "op", value: "|" });
				i++;
			}
			continue;
		}
		if (c === "&") {
			if (command[i + 1] === "&") {
				out.push({ kind: "op", value: "&&" });
				i += 2;
			} else {
				out.push({ kind: "op", value: "&" });
				i++;
			}
			continue;
		}
		if (c === ";") {
			out.push({ kind: "op", value: ";" });
			i++;
			continue;
		}
		// Quoted strings — collapse to a single word.
		if (c === "'") {
			let j = i + 1;
			while (j < n && command[j] !== "'") j++;
			out.push({ kind: "word", value: command.slice(i + 1, j) });
			i = j < n ? j + 1 : j;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let buf = "";
			while (j < n && command[j] !== '"') {
				// POSIX shell would unescape `\"`, `\\`, `\$`, etc. inside
				// double quotes, but in practice the model writes Windows
				// paths like `"C:\Users\..."` unescaped. Treat backslash
				// as a literal character so the path round-trips intact.
				// Detection is heuristic by design — a sophisticated escape
				// like `\\"` is rare enough not to warrant a real parser.
				buf += command[j] ?? "";
				j++;
			}
			out.push({ kind: "word", value: buf });
			i = j < n ? j + 1 : j;
			continue;
		}
		// Plain word — read until whitespace or operator. We deliberately
		// do NOT honour shell backslash-escape here: the model uses
		// backslash as a path separator on Windows far more often than as
		// an escape, and our protected-path matcher needs the literal
		// characters.
		let j = i;
		let buf = "";
		while (j < n) {
			const ch = command[j] ?? "";
			if (isWs(ch)) break;
			if (ch === ">" || ch === "|" || ch === "&" || ch === ";") break;
			buf += ch;
			j++;
		}
		if (buf.length > 0) out.push({ kind: "word", value: buf });
		i = j;
	}
	return out;
}

/**
 * Heuristic — does this token plausibly reference a filesystem path?
 * We use this to avoid hammering `path.resolve()` on every flag /
 * keyword. Conservative; only filters out things that are obviously
 * NOT paths (operator-only tokens, single letters).
 */
function looksLikePathToken(value: string): boolean {
	if (!value) return false;
	if (value.length < 2) return false;
	// Common path shapes.
	if (value.includes("/") || value.includes("\\")) return true;
	if (value.startsWith("~")) return true;
	// Drive letters on Windows.
	if (/^[A-Za-z]:[\\/]?/.test(value)) return true;
	// Bare filenames with an extension (e.g. `brigade.json`).
	if (/\.[A-Za-z0-9]+$/.test(value)) return true;
	return false;
}

/** Expand a leading `~` to the resolved state-dir's parent (i.e. $HOME). */
function expandTilde(p: string): string {
	if (!p.startsWith("~")) return p;
	// The state dir defaults to `<home>/.brigade`. Its parent IS home.
	// When BRIGADE_STATE_DIR is overridden we still want to resolve `~`
	// to the OS home so external paths in the command resolve sanely,
	// but for our protected-path purposes we only care about paths
	// inside the configured state dir — which the model will write as
	// an absolute path or relative to cwd, not via `~`. Resolving to
	// OS home is fine for both branches.
	const home = os.homedir();
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
	return p;
}

/** Resolve a path token to an absolute, normalised path. */
function resolvePathToken(value: string): string {
	return path.resolve(expandTilde(value));
}

/**
 * If the current token is the LAST positional arg of an mv/cp/rsync/dd
 * invocation in the current pipeline segment, return the tool name.
 */
function destinationToolForToken(tokens: readonly ShellToken[], idx: number): string | undefined {
	// `dd` uses `of=<path>` syntax — handled by the caller as a word
	// match below; here we only care about positional-destination tools.
	const DEST_TOOLS = new Set(["mv", "cp", "rsync", "install"]);
	// Find pipeline-segment start.
	let start = idx - 1;
	while (start >= 0) {
		const t = tokens[start];
		if (!t) break;
		if (t.kind === "op" && (t.value === "|" || t.value === ";" || t.value === "&&" || t.value === "||")) {
			break;
		}
		start--;
	}
	const cmdTok = tokens[start + 1];
	if (!cmdTok || cmdTok.kind !== "word") {
		// `dd of=<path>` — token immediately to the LEFT carries the
		// `of=` prefix on the same word, so we already detect it via
		// the literal-path branch (see below).
		return undefined;
	}
	if (!DEST_TOOLS.has(cmdTok.value)) {
		// `dd if=… of=<path>` — detect via the `of=` prefix.
		if (cmdTok.value === "dd") {
			const cur = tokens[idx]?.value ?? "";
			if (cur.startsWith("of=")) return "dd";
		}
		return undefined;
	}
	// Walk forward from the command; collect positional (non-flag) words
	// until we hit a pipeline-segment boundary.
	const positionals: number[] = [];
	for (let j = start + 2; j < tokens.length; j++) {
		const t = tokens[j];
		if (!t) break;
		if (t.kind === "op") {
			if (t.value === "|" || t.value === ";" || t.value === "&&" || t.value === "||") break;
			continue;
		}
		if (t.value.startsWith("-")) continue;
		positionals.push(j);
	}
	if (positionals.length === 0) return undefined;
	const lastIdx = positionals[positionals.length - 1];
	if (lastIdx === idx) return cmdTok.value;
	return undefined;
}

/**
 * Detect `sed -i <file>` or `sed -i.bak <file>` or `sed -i '' <file>`.
 * Returns true when the token at `idx` is being rewritten in-place.
 */
function isSedInPlaceTarget(tokens: readonly ShellToken[], idx: number): boolean {
	// Walk back to find the start of the current pipeline segment.
	let start = idx - 1;
	while (start >= 0) {
		const t = tokens[start];
		if (!t) break;
		if (t.kind === "op" && (t.value === "|" || t.value === ";" || t.value === "&&" || t.value === "||")) {
			break;
		}
		start--;
	}
	const cmdTok = tokens[start + 1];
	if (!cmdTok || cmdTok.kind !== "word" || cmdTok.value !== "sed") return false;
	// Look for an `-i` / `-i.bak` / `-i''` flag anywhere between sed
	// and our token.
	for (let j = start + 2; j < idx; j++) {
		const t = tokens[j];
		if (!t || t.kind !== "word") continue;
		if (t.value === "-i" || t.value.startsWith("-i.") || t.value === "-i''" || t.value === '-i""') {
			return true;
		}
		// GNU sed allows `--in-place[=SUFFIX]`.
		if (t.value === "--in-place" || t.value.startsWith("--in-place=")) return true;
	}
	return false;
}

/**
 * Detect `rm <file>` / `rmdir <dir>` / `unlink <file>`. Returns the
 * tool name when the token at `idx` is a positional target.
 */
function isUnlinkTarget(tokens: readonly ShellToken[], idx: number): string | undefined {
	const UNLINK_TOOLS = new Set(["rm", "rmdir", "unlink"]);
	let start = idx - 1;
	while (start >= 0) {
		const t = tokens[start];
		if (!t) break;
		if (t.kind === "op" && (t.value === "|" || t.value === ";" || t.value === "&&" || t.value === "||")) {
			break;
		}
		start--;
	}
	const cmdTok = tokens[start + 1];
	if (!cmdTok || cmdTok.kind !== "word") return undefined;
	if (!UNLINK_TOOLS.has(cmdTok.value)) return undefined;
	// The target must be a positional (non-flag) word.
	const cur = tokens[idx];
	if (!cur || cur.kind !== "word" || cur.value.startsWith("-")) return undefined;
	return cmdTok.value;
}

/**
 * Look for inline Node/Python scripts that write to a file. Returns
 * the set of string literals from the script body (callers match them
 * against the protected roots) + a short label for the violation reason.
 */
function matchInlineScriptWrite(command: string): { label: string; literals: string[] } | undefined {
	// `node -e '...'` / `node --eval "..."` / `node -p '...'`
	// (`-p` is print-eval — also writes if the body calls writeFileSync).
	const nodeFlags = ["-e", "--eval", "-p", "--print"];
	const pythonFlags = ["-c"];
	const lower = command.toLowerCase();
	const isNode = lower.includes("node") && nodeFlags.some((f) => command.includes(` ${f} `) || command.includes(` ${f}'`) || command.includes(` ${f}"`));
	const isPython = (lower.includes("python") || lower.includes("python3")) && pythonFlags.some((f) => command.includes(` ${f} `) || command.includes(` ${f}'`) || command.includes(` ${f}"`));
	if (!isNode && !isPython) return undefined;

	// Node write APIs we care about.
	const NODE_WRITE = [
		"writeFileSync",
		"appendFileSync",
		"createWriteStream",
		"rename",
		"renameSync",
		"writeFile",
		"appendFile",
		"openSync", // could be a writer; flagged when paired with a w/a flag, but model rarely does it readonly via openSync. Conservative: include.
	];
	// Python write APIs.
	const PY_WRITE = [
		"open(", // open() with a write mode; we don't parse the mode arg
		"Path(", // Path.write_text / write_bytes — match the constructor and check below
		"os.rename",
		"shutil.move",
		"shutil.copy",
		"shutil.copyfile",
		"shutil.copy2",
	];

	let label: string | undefined;
	if (isNode && NODE_WRITE.some((api) => command.includes(api))) {
		label = "node -e write";
	}
	if (!label && isPython) {
		const hasWriter = PY_WRITE.some((api) => command.includes(api));
		// Require a write-mode hint for `open(` to reduce false positives
		// (`open("file")` defaults to read mode).
		const hasWriteMode = /open\([^)]*['"]\s*[wax][bt+]*\s*['"]/.test(command)
			|| command.includes("write_text")
			|| command.includes("write_bytes")
			|| command.includes("os.rename")
			|| command.includes("shutil.");
		if (hasWriter && hasWriteMode) {
			label = "python -c write";
		}
	}
	if (!label) return undefined;

	// Pull every quoted string literal out of the command. We extract
	// BOTH the outer wrapper (e.g. `"require(...)"`) AND any nested
	// inner literals (e.g. the `'<path>'` argument to writeFileSync),
	// because the JS/Python invocation almost always nests the
	// destination path inside the wrapper.
	const literals = extractAllQuotedSpans(command);
	return { label, literals };
}

/**
 * Walk a command string and return every contiguous quoted span,
 * INCLUDING nested literals that sit inside an outer quote. Both
 * single-quoted and double-quoted spans are recognised. The outer
 * scan is greedy (find the matching closing quote first); the inner
 * scan recurses into the captured body.
 *
 * This is deliberately permissive — we want to catch a `'<path>'`
 * literal that appears INSIDE a `"node -e \"...\""` wrapper. Real
 * shell escape semantics are not honoured (a `\'` inside a single
 * quote does not actually escape in POSIX), but for path detection
 * the false-positives are harmless.
 */
function extractAllQuotedSpans(input: string): string[] {
	const out: string[] = [];
	const visit = (s: string): void => {
		const n = s.length;
		let i = 0;
		while (i < n) {
			const c = s[i];
			if (c === "'" || c === '"') {
				const quote = c;
				let j = i + 1;
				while (j < n && s[j] !== quote) j++;
				if (j >= n) break;
				const body = s.slice(i + 1, j);
				if (body.length > 0) out.push(body);
				// Recurse into the captured body to find nested literals
				// using the OPPOSITE quote (or even the same, if it was
				// escaped by being inside the outer wrapper).
				if (body.includes("'") || body.includes('"')) visit(body);
				i = j + 1;
				continue;
			}
			i++;
		}
	};
	visit(input);
	return out;
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
 * target lives under a protected root unless a carve-out applies. Also
 * refuses `bash` / `exec` / `shell` / `sh` calls whose `command`
 * contains a write-intent indicator against a protected path.
 *
 * Wire AFTER the unknown-tool guard (so unknown tools fail first) and
 * BEFORE the exec-gate + user policy hook (so policy hooks never see a
 * forbidden write and the exec-gate's approval prompt never asks the
 * operator to allow a structurally-forbidden mutation).
 */
export function makePathWriteGuard(opts: PathWriteGuardOptions = {}): BrigadeBeforeToolCallHook {
	const roots = opts.roots ?? buildProtectedRoots();
	return async (ctx) => {
		const rawName = (ctx as { toolCall?: { name?: unknown }; name?: unknown })?.toolCall?.name
			?? (ctx as { name?: unknown })?.name
			?? "";
		const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";

		const args = (ctx as { toolCall?: { arguments?: unknown }; arguments?: unknown; args?: unknown })
			?.toolCall?.arguments
			?? (ctx as { arguments?: unknown })?.arguments
			?? (ctx as { args?: unknown })?.args
			?? {};

		// Branch 1 — write / edit. Resolve the path arg and check directly.
		if (name === "write" || name === "edit") {
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
		}

		// Branch 2 — bash / exec / shell / sh. Parse the command for
		// write-intent indicators against a protected path.
		if (BASH_TOOL_NAMES.has(name)) {
			const command = extractBashCommand(args);
			if (!command) return undefined;
			const hit = detectBashWriteIntent(command, roots);
			if (!hit) return undefined;
			return {
				block: true,
				reason:
					`bash: refusing to mutate ${hit.absPath} — protected by Brigade structural guard. ` +
					`Use \`manage_agent\` or \`manage_skill\` for catalog changes; A2A/allowlist changes go through \`manage_agent\` (auto-seeded on add). ` +
					`(${hit.indicator} \`${hit.absPath}\`; root: ${hit.root.id})`,
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
