/**
 * `brigade secrets audit` — find leaked-key risk under ~/.brigade.
 *
 * Walks the state dir, applies plain-text regex patterns for the API-key shapes
 * Brigade depends on, and reports any matches. Exits non-zero on findings so
 * CI / cron / preflight scripts can gate.
 *
 * Pure best-effort: false positives are expected (an API key in an example
 * comment will match too). The point is to give operators a "did I leak a key"
 * answer in one command, not a perfect scanner.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

interface Match {
	file: string;
	line: number;
	pattern: string;
	excerpt: string;
}

const PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "anthropic-key", re: /sk-ant-[a-z0-9-_]{30,}/i },
	{ name: "openai-key", re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
	{ name: "google-key", re: /AIza[0-9A-Za-z\-_]{30,}/ },
	{ name: "google-key-aq", re: /\bAQ\.[0-9A-Za-z\-_]{30,}/ },
	{ name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
	{ name: "bearer-token-long", re: /Bearer\s+[A-Za-z0-9._-]{30,}/i },
	{ name: "generic-secret-line", re: /\b(?:secret|api[_-]?key|token|password)\s*[:=]\s*['"]?[A-Za-z0-9._\-+/=]{24,}/i },
];

// Don't scan these — they're huge + redundant.
const SKIP_DIRS = new Set(["cache", "logs"]);
const SKIP_FILE_RE = /\.bak(\.\d+)?$|\.clobbered\.\d+$|\.lock$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip giant files (likely binary)

function* walk(root: string): Generator<string> {
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (SKIP_DIRS.has(name)) continue;
			if (SKIP_FILE_RE.test(name)) continue;
			const full = path.join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) stack.push(full);
			else if (st.isFile() && st.size <= MAX_FILE_BYTES) yield full;
		}
	}
}

function scanFile(file: string): Match[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	// Cheap binary-file sniff: a NUL byte in the first 1KB → skip.
	if (text.slice(0, 1024).includes("\0")) return [];
	const out: Match[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		for (const { name, re } of PATTERNS) {
			if (re.test(line)) {
				out.push({ file, line: i + 1, pattern: name, excerpt: line.trim().slice(0, 160) });
			}
		}
	}
	return out;
}

export async function runSecretsAudit(
	args: { strict?: boolean },
	opts: { json?: boolean } = {},
): Promise<number> {
	const root = resolveStateDir();
	if (!existsSync(root)) {
		process.stdout.write(`Nothing to scan — ${root} doesn't exist.\n`);
		return 0;
	}
	const matches: Match[] = [];
	for (const file of walk(root)) {
		for (const m of scanFile(file)) matches.push(m);
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ root, matches }, null, 2)}\n`);
	} else if (matches.length === 0) {
		process.stdout.write(`No suspected secrets found under ${root}.\n`);
	} else {
		process.stdout.write(`Found ${matches.length} suspected secret(s) under ${root}:\n`);
		for (const m of matches) {
			process.stdout.write(`  ${m.file}:${m.line} [${m.pattern}]  ${m.excerpt}\n`);
		}
		process.stdout.write(
			"\nNot every match is a real leak (regex-based) — review each and either rotate the key or ignore.\n",
		);
	}
	// `--strict` makes findings a non-zero exit (CI gate). Default behavior
	// remains 0 so an audit doesn't break the shell pipeline by surprise.
	return matches.length > 0 && args.strict ? 1 : 0;
}
