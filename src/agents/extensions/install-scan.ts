/**
 * Install-time security scan — a static, read-only pattern sweep over an
 * installed extension's source so the operator sees what a freshly-added
 * module CAN reach BEFORE it ever runs.
 *
 * This is a transparency surface, NOT a sandbox. Every construct it flags is
 * dual-use: a channel adapter legitimately opens network sockets, a tool
 * legitimately spawns a subprocess, a memory backend legitimately writes files.
 * So the scan SURFACES findings as a warning the operator acknowledges — it
 * never hard-blocks an install. The point is informed consent: "this plugin
 * runs shell commands and reads your environment — proceed?".
 *
 * The scan is deliberately simple (line-regex over source text, no AST / no
 * execution): it must run fast on an untrusted tree without importing or
 * evaluating any of it. False positives are acceptable; the operator reads the
 * snippet and decides. It walks only the source-text files of the module
 * (skipping node_modules, lockfiles, binaries, and oversized files) so the
 * report stays focused on the author's own code.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** How alarming a finding is. `high` = direct code-exec or shell reach. */
export type ScanSeverity = "high" | "medium" | "low";

/** One matched risky construct in the installed source. */
export interface ScanFinding {
	/** Stable rule id (e.g. `dynamic-eval`). */
	rule: string;
	severity: ScanSeverity;
	/** One plain-language line: what this construct can do. */
	note: string;
	/** Source file the match was found in (relative to the scanned root). */
	file: string;
	/** 1-based line number of the match. */
	line: number;
	/** The matched line, trimmed + length-capped, for the operator to eyeball. */
	snippet: string;
}

/** Aggregate result of a scan pass. */
export interface ScanReport {
	/** Every finding, in file + line order. */
	findings: ScanFinding[];
	/** Count of source files actually scanned (after skip rules). */
	filesScanned: number;
	/** Tallies by severity, for the one-line summary. */
	counts: { high: number; medium: number; low: number };
}

/**
 * A single scan rule. `test` runs against ONE source line; returning true is a
 * hit. Kept as plain regexes so the rule set is auditable at a glance.
 */
interface ScanRule {
	rule: string;
	severity: ScanSeverity;
	note: string;
	pattern: RegExp;
}

// The rule set. Each entry is intentionally broad — a hit means "this construct
// is present", which the operator interprets. Ordered high → low so the most
// important rules read first in the source.
const RULES: ScanRule[] = [
	{
		rule: "dynamic-eval",
		severity: "high",
		note: "evaluates code from a string at runtime (eval)",
		pattern: /\beval\s*\(/,
	},
	{
		rule: "function-constructor",
		severity: "high",
		note: "builds and runs code via the Function constructor",
		pattern: /\bnew\s+Function\s*\(/,
	},
	{
		rule: "child-process",
		severity: "high",
		note: "runs other programs / shell commands (child_process)",
		pattern: /\bchild_process\b|\bnode:child_process\b/,
	},
	{
		rule: "process-spawn",
		severity: "high",
		note: "spawns or executes a subprocess (spawn / exec / execSync / fork)",
		pattern: /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/,
	},
	{
		rule: "network-client",
		severity: "medium",
		note: "opens outbound network connections (net / tls / dgram sockets)",
		pattern: /\b(?:node:)?(?:net|tls|dgram)\b|\.(?:createConnection|connect)\s*\(/,
	},
	{
		rule: "http-client",
		severity: "medium",
		note: "makes HTTP(S) requests (fetch / http / https / axios / got)",
		pattern: /\b(?:node:)?https?\b|\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bundici\b|\bXMLHttpRequest\b/,
	},
	{
		rule: "filesystem-write",
		severity: "medium",
		note: "writes or deletes files on disk (fs write / unlink / rm)",
		pattern:
			/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync)\s*\(/,
	},
	{
		rule: "env-enumeration",
		severity: "low",
		note: "reads the full process environment (process.env enumeration)",
		pattern: /process\.env\b\s*(?:\)|,|\]|\}|;|$)|Object\.(?:keys|entries|values|assign)\s*\(\s*process\.env\b|\{\s*\.\.\.\s*process\.env\b/,
	},
];

// Files whose CONTENT we scan — author source, not data/binaries/deps.
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]);

// Directories we never descend into: vendored deps + VCS metadata. A plugin's
// own code is what the operator is consenting to; its dependencies are out of
// scope for this lightweight surface (and would drown the report).
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".cache"]);

// Hard caps so a pathological tree can't wedge the scan.
const MAX_FILE_BYTES = 512 * 1024; // skip files larger than 512 KiB
const MAX_FILES = 2_000; // stop after this many source files
const SNIPPET_MAX = 160; // trim each surfaced snippet to this many chars

/** Recursively collect scannable source files under `root` (bounded). */
function collectSourceFiles(root: string): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0 && out.length < MAX_FILES) {
		const dir = stack.pop()!;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (out.length >= MAX_FILES) break;
			if (SKIP_DIRS.has(name)) continue;
			const full = path.join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				stack.push(full);
			} else if (st.isFile()) {
				const ext = path.extname(name).toLowerCase();
				if (SCANNED_EXTENSIONS.has(ext) && st.size <= MAX_FILE_BYTES) {
					out.push(full);
				}
			}
		}
	}
	return out;
}

/** Trim + length-cap a source line for safe display. */
function makeSnippet(rawLine: string): string {
	const trimmed = rawLine.trim();
	return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}…` : trimmed;
}

/**
 * Scan a single block of source TEXT (already read) for risky constructs. Split
 * out so tests can feed sample source directly without touching disk. `fileLabel`
 * is what each finding records as its `file`.
 */
export function scanSourceText(source: string, fileLabel: string): ScanFinding[] {
	const findings: ScanFinding[] = [];
	const lines = source.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// Cheap skip of obvious whole-line comments — cuts the most common false
		// positives (a rule name mentioned in a doc comment). This is best-effort;
		// the operator still reviews each snippet.
		const lead = line.trimStart();
		if (lead.startsWith("//") || lead.startsWith("*")) continue;
		for (const r of RULES) {
			if (r.pattern.test(line)) {
				findings.push({
					rule: r.rule,
					severity: r.severity,
					note: r.note,
					file: fileLabel,
					line: i + 1,
					snippet: makeSnippet(line),
				});
			}
		}
	}
	return findings;
}

/**
 * Statically scan an installed module directory for dual-use constructs. Reads
 * source files only (no import / no execution). Never throws — an unreadable
 * file is skipped. Findings are sorted by file then line for a stable report.
 */
export function scanInstalledModule(moduleDir: string): ScanReport {
	const files = collectSourceFiles(moduleDir);
	const findings: ScanFinding[] = [];
	let filesScanned = 0;
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		filesScanned++;
		const rel = path.relative(moduleDir, file) || path.basename(file);
		findings.push(...scanSourceText(text, rel.replace(/\\/g, "/")));
	}
	findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
	const counts = { high: 0, medium: 0, low: 0 };
	for (const f of findings) counts[f.severity]++;
	return { findings, filesScanned, counts };
}

/** One-line human summary of a scan report (e.g. "2 high, 1 medium"). */
export function summarizeScan(report: ScanReport): string {
	const { high, medium, low } = report.counts;
	if (high + medium + low === 0) return "no risky constructs found";
	const parts: string[] = [];
	if (high) parts.push(`${high} high`);
	if (medium) parts.push(`${medium} medium`);
	if (low) parts.push(`${low} low`);
	return parts.join(", ");
}
