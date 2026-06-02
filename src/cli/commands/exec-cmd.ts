/**
 * `brigade exec <list|allow|allow-pattern|remove|deny-test|file>` — CRUD over
 * a per-agent exec-approvals allowlist that gates `bash` tool calls. The
 * allowlist file lives at `<agentDir>/exec-approvals.json` and is consulted
 * at every tool-call boundary by `src/agents/exec-gate.ts`.
 *
 * Pass `--agent <id>` to target a non-default agent's allowlist; without the
 * flag the canonical default agent ("main") is used.
 *
 * v1 shape (per-agent, file-backed):
 *   - exact-command approvals: the literal command string must match (after
 *     trim) for the gate to allow.
 *   - pattern approvals: operator-supplied regex; gate skips malformed
 *     regexes rather than crashing.
 *   - hard-deny patterns (rm -rf /, dd to raw disk, fork bomb, etc.) are
 *     coded into `exec-approvals.ts` and CANNOT be allowlisted. Operators
 *     can verify a command's classification via `brigade exec deny-test`.
 */

import chalk from "chalk";

import {
	BrigadeApprovalRefusedError,
	decideApproval,
	getApprovalsFilePath,
	recordApproval,
	removeApproval,
} from "../../core/exec-approvals.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import * as fs from "node:fs";

export interface ExecListOptions {
	json?: boolean;
	/** Agent id whose allowlist to inspect — defaults to the canonical agent. */
	agentId?: string;
}
export interface ExecAllowOptions {
	json?: boolean;
	/** Agent id whose allowlist to mutate — defaults to the canonical agent. */
	agentId?: string;
}
export interface ExecAllowPatternOptions {
	json?: boolean;
	/** Agent id whose allowlist to mutate — defaults to the canonical agent. */
	agentId?: string;
}
export interface ExecRemoveOptions {
	json?: boolean;
	/** Agent id whose allowlist to mutate — defaults to the canonical agent. */
	agentId?: string;
}
export interface ExecDenyTestOptions {
	json?: boolean;
	/** Agent id whose allowlist to consult — defaults to the canonical agent. */
	agentId?: string;
}
export interface ExecFileOptions {
	json?: boolean;
	/** Agent id whose allowlist path to print — defaults to the canonical agent. */
	agentId?: string;
}

interface ApprovalsFileShape {
	version: number;
	commands: string[];
	patterns: string[];
}

function resolveAgentId(agentId: string | undefined): string {
	const trimmed = (agentId ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_AGENT_ID;
}

/**
 * Read the raw file shape for the `list` view. UNLIKE `loadApprovals` in
 * exec-approvals.ts, this does NOT enforce schema v1 — `list` is the
 * operator's inspection tool, so we show whatever's on disk so they can
 * diagnose a future-version file or a corrupted entry. Returns null if
 * the file can't be read or parsed at all.
 */
function readApprovalsRaw(agentId: string): ApprovalsFileShape | null {
	const filePath = getApprovalsFilePath(agentId);
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		if (raw.trim().length === 0) return { version: 1, commands: [], patterns: [] };
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { version: 1, commands: [], patterns: [] };
		}
		const obj = parsed as Partial<ApprovalsFileShape>;
		return {
			version: typeof obj.version === "number" ? obj.version : 1,
			commands: Array.isArray(obj.commands) ? obj.commands.filter((s) => typeof s === "string") : [],
			patterns: Array.isArray(obj.patterns) ? obj.patterns.filter((s) => typeof s === "string") : [],
		};
	} catch {
		return null;
	}
}

/* ───────────────────────── list ───────────────────────── */

export async function runExecList(opts: ExecListOptions = {}): Promise<number> {
	const agentId = resolveAgentId(opts.agentId);
	const approvals = readApprovalsRaw(agentId) ?? { version: 1, commands: [], patterns: [] };
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ agentId, ...approvals }, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(
		`${chalk.bold("exec-approvals")} ${chalk.dim(`(agent: ${agentId})`)} (${getApprovalsFilePath(agentId)})\n`,
	);
	// Surface a future-version file inline — operator sees the data they have
	// AND the warning that the gate refuses to operate on it.
	if (approvals.version !== 1) {
		process.stdout.write(
			`${chalk.yellow("⚠ schema version:")} file declares v${approvals.version}; this Brigade build only understands v1.\n`,
		);
		process.stdout.write(
			`${chalk.dim("  the gate REFUSES to operate on a future-version file. Move it aside and re-approve:")}\n`,
		);
		process.stdout.write(
			`${chalk.dim(`  mv "${getApprovalsFilePath(agentId)}" "${getApprovalsFilePath(agentId)}.from-v${approvals.version}.bak"`)}\n`,
		);
	}
	if (approvals.commands.length === 0 && approvals.patterns.length === 0) {
		process.stdout.write(
			`${chalk.dim("  (empty — every bash command will be refused until you approve one)")}\n`,
		);
		process.stdout.write(
			`${chalk.dim("  add an exact command:   brigade exec allow \"ls -la\"")}\n`,
		);
		process.stdout.write(
			`${chalk.dim("  add a regex pattern:    brigade exec allow-pattern \"^git (status|diff)( |$)\"")}\n`,
		);
		return 0;
	}
	if (approvals.commands.length > 0) {
		process.stdout.write(`${chalk.green("commands:")} (${approvals.commands.length})\n`);
		for (const c of approvals.commands) process.stdout.write(`  ${c}\n`);
	}
	if (approvals.patterns.length > 0) {
		process.stdout.write(`${chalk.green("patterns:")} (${approvals.patterns.length})\n`);
		for (const p of approvals.patterns) process.stdout.write(`  /${p}/\n`);
	}
	return 0;
}

/* ───────────────────────── allow ───────────────────────── */

export async function runExecAllow(rawCommand: string, opts: ExecAllowOptions = {}): Promise<number> {
	const agentId = resolveAgentId(opts.agentId);
	const cmd = rawCommand.trim();
	if (!cmd) {
		writeError(opts.json, "brigade exec: command is empty", { code: "empty" });
		return 1;
	}
	// Surface hard-deny patterns BEFORE writing.
	if (decideApproval(cmd, agentId) === "deny") {
		writeError(opts.json, `brigade exec: "${cmd}" matches a hard-deny pattern and cannot be allowlisted`, {
			code: "hard-denied",
			command: cmd,
		});
		process.stderr.write(
			`${chalk.dim("  hard-deny patterns are coded into Brigade for safety (rm -rf /, dd to raw disk, fork bomb, etc.).")}\n`,
		);
		return 1;
	}
	try {
		recordApproval(cmd, "exact", agentId);
	} catch (err) {
		if (err instanceof BrigadeApprovalRefusedError) {
			writeError(opts.json, `brigade exec: ${err.message}`, { code: "refused", command: cmd });
			return 1;
		}
		throw err;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, kind: "exact", command: cmd, agentId }, null, 2)}\n`);
	} else {
		process.stdout.write(`${chalk.green("allowed")} (exact, agent ${agentId}): ${cmd}\n`);
	}
	return 0;
}

/* ───────────────────────── allow-pattern ───────────────────────── */

export async function runExecAllowPattern(
	rawPattern: string,
	opts: ExecAllowPatternOptions = {},
): Promise<number> {
	const agentId = resolveAgentId(opts.agentId);
	const pat = rawPattern.trim();
	if (!pat) {
		writeError(opts.json, "brigade exec: pattern is empty", { code: "empty" });
		return 1;
	}
	try {
		// eslint-disable-next-line no-new
		new RegExp(pat);
	} catch (err) {
		writeError(opts.json, `brigade exec: invalid regex pattern: ${(err as Error).message}`, {
			code: "invalid-regex",
			pattern: pat,
		});
		return 1;
	}
	try {
		recordApproval(pat, "pattern", agentId);
	} catch (err) {
		if (err instanceof BrigadeApprovalRefusedError) {
			writeError(opts.json, `brigade exec: ${err.message}`, { code: "refused", pattern: pat });
			return 1;
		}
		throw err;
	}
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, kind: "pattern", pattern: pat, agentId }, null, 2)}\n`);
	} else {
		process.stdout.write(`${chalk.green("allowed")} (pattern, agent ${agentId}): /${pat}/\n`);
		if (!pat.startsWith("^")) {
			process.stdout.write(
				`${chalk.dim("  note: pattern does not start with `^` — it matches anywhere in the command line.")}\n`,
			);
			process.stdout.write(
				`${chalk.dim(`        if you meant "the command line starts with this", use ${JSON.stringify(`^${pat}`)} instead.`)}\n`,
			);
		}
	}
	return 0;
}

/* ───────────────────────── remove ───────────────────────── */

export async function runExecRemove(rawValue: string, opts: ExecRemoveOptions = {}): Promise<number> {
	const agentId = resolveAgentId(opts.agentId);
	const value = rawValue.trim();
	if (!value) {
		writeError(opts.json, "brigade exec: command/pattern is empty", { code: "empty" });
		return 1;
	}
	let result: { removedCommands: number; removedPatterns: number };
	try {
		result = removeApproval(value, agentId);
	} catch (err) {
		if (err instanceof BrigadeApprovalRefusedError) {
			writeError(opts.json, `brigade exec: ${err.message}`, { code: "refused", value });
			return 1;
		}
		throw err;
	}
	const { removedCommands, removedPatterns } = result;
	if (removedCommands === 0 && removedPatterns === 0) {
		writeError(opts.json, `brigade exec: "${value}" not found in commands or patterns`, {
			code: "not-found",
			value,
		});
		return 1;
	}
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, removedCommands, removedPatterns, agentId }, null, 2)}\n`,
		);
	} else {
		const parts: string[] = [];
		if (removedCommands > 0) parts.push(`${removedCommands} command(s)`);
		if (removedPatterns > 0) parts.push(`${removedPatterns} pattern(s)`);
		process.stdout.write(`${chalk.yellow("removed")} (agent ${agentId}): ${parts.join(", ")} matching "${value}"\n`);
	}
	return 0;
}

/* ───────────────────────── deny-test ───────────────────────── */

export async function runExecDenyTest(rawCommand: string, opts: ExecDenyTestOptions = {}): Promise<number> {
	const agentId = resolveAgentId(opts.agentId);
	const cmd = rawCommand.trim();
	if (!cmd) {
		writeError(opts.json, "brigade exec: command is empty", { code: "empty" });
		return 1;
	}
	const decision = decideApproval(cmd, agentId);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ command: cmd, decision, agentId }, null, 2)}\n`);
		return 0;
	}
	const colored =
		decision === "allow"
			? chalk.green("allow")
			: decision === "deny"
				? chalk.red("deny")
				: chalk.yellow("prompt");
	process.stdout.write(`${cmd} → ${colored} ${chalk.dim(`(agent ${agentId})`)}\n`);
	if (decision === "prompt") {
		process.stdout.write(
			`${chalk.dim("  approve with:  brigade exec allow ")}${JSON.stringify(cmd)}\n`,
		);
	}
	if (decision === "deny") {
		process.stdout.write(
			`${chalk.dim("  this command matches a hard-deny pattern and CANNOT be allowlisted.")}\n`,
		);
	}
	return 0;
}

/* ───────────────────────── file ───────────────────────── */

export async function runExecFile(opts: ExecFileOptions = {}): Promise<number> {
	const agentId = resolveAgentId(opts.agentId);
	const filePath = getApprovalsFilePath(agentId);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ path: filePath, agentId }, null, 2)}\n`);
	} else {
		process.stdout.write(`${filePath}\n`);
	}
	return 0;
}

/* ───────────────────────── helpers ───────────────────────── */

function writeError(
	json: boolean | undefined,
	message: string,
	details: Record<string, unknown>,
): void {
	if (json) {
		process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...details }, null, 2)}\n`);
	} else {
		process.stderr.write(`${chalk.red(message)}\n`);
	}
}
