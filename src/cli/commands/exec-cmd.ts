/**
 * `brigade exec <list|allow|allow-pattern|remove|deny-test|file>` — CRUD over
 * the exec-approvals allowlist that gates `bash` tool calls. The allowlist
 * file lives at `~/.brigade/exec-approvals.json` and is consulted at every
 * tool-call boundary by `src/agents/workspace-jail.ts`.
 *
 * v1 shape (single-user, file-backed):
 *   - exact-command approvals: the literal command string must match (after
 *     trim) for the gate to allow.
 *   - pattern approvals: operator-supplied regex; gate skips malformed
 *     regexes rather than crashing.
 *   - hard-deny patterns (rm -rf /, dd to raw disk, fork bomb, etc.) are
 *     coded into `exec-approvals.ts` and CANNOT be allowlisted. Operators
 *     can verify a command's classification via `brigade exec deny-test`.
 *
 * No interactive prompt UI in v1. Channels + async approval flows ship
 * in Phase 2 alongside multi-user mode.
 *
 * Mirrors the shape of `src/cli/commands/config-cmd.ts` — same exit-code
 * contract, same `--json` flag, same chalk-tinted human output.
 */

import chalk from "chalk";

import {
	_resetApprovalsCacheForTests,
	decideApproval,
	getApprovalsFilePath,
	recordApproval,
} from "../../core/exec-approvals.js";
import * as fs from "node:fs";

export interface ExecListOptions {
	json?: boolean;
}
export interface ExecAllowOptions {
	json?: boolean;
}
export interface ExecAllowPatternOptions {
	json?: boolean;
}
export interface ExecRemoveOptions {
	json?: boolean;
}
export interface ExecDenyTestOptions {
	json?: boolean;
}
export interface ExecFileOptions {
	json?: boolean;
}

interface ApprovalsFileShape {
	version: 1;
	commands: string[];
	patterns: string[];
}

function readApprovalsRaw(): ApprovalsFileShape {
	const filePath = getApprovalsFilePath();
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<ApprovalsFileShape>;
		return {
			version: 1,
			commands: Array.isArray(parsed.commands) ? parsed.commands.filter((s) => typeof s === "string") : [],
			patterns: Array.isArray(parsed.patterns) ? parsed.patterns.filter((s) => typeof s === "string") : [],
		};
	} catch {
		return { version: 1, commands: [], patterns: [] };
	}
}

/* ───────────────────────── list ───────────────────────── */

export async function runExecList(opts: ExecListOptions = {}): Promise<number> {
	const approvals = readApprovalsRaw();
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(approvals, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`${chalk.bold("exec-approvals")} (${getApprovalsFilePath()})\n`);
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
	const cmd = rawCommand.trim();
	if (!cmd) {
		writeError(opts.json, "brigade exec: command is empty", { code: "empty" });
		return 1;
	}
	// Surface hard-deny patterns BEFORE writing, so the operator gets an
	// immediate rejection instead of silently writing a command that the
	// gate will refuse anyway.
	if (decideApproval(cmd) === "deny") {
		writeError(opts.json, `brigade exec: "${cmd}" matches a hard-deny pattern and cannot be allowlisted`, {
			code: "hard-denied",
			command: cmd,
		});
		process.stderr.write(
			`${chalk.dim("  hard-deny patterns are coded into Brigade for safety (rm -rf /, dd to raw disk, fork bomb, etc.).")}\n`,
		);
		return 1;
	}
	recordApproval(cmd, "exact");
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, kind: "exact", command: cmd }, null, 2)}\n`);
	} else {
		process.stdout.write(`${chalk.green("allowed")} (exact): ${cmd}\n`);
	}
	return 0;
}

/* ───────────────────────── allow-pattern ───────────────────────── */

export async function runExecAllowPattern(
	rawPattern: string,
	opts: ExecAllowPatternOptions = {},
): Promise<number> {
	const pat = rawPattern.trim();
	if (!pat) {
		writeError(opts.json, "brigade exec: pattern is empty", { code: "empty" });
		return 1;
	}
	// Reject malformed regexes up front. The gate skips bad patterns at
	// runtime but warn-on-write is better UX than silent-no-op.
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
	recordApproval(pat, "pattern");
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, kind: "pattern", pattern: pat }, null, 2)}\n`);
	} else {
		process.stdout.write(`${chalk.green("allowed")} (pattern): /${pat}/\n`);
	}
	return 0;
}

/* ───────────────────────── remove ───────────────────────── */

export async function runExecRemove(rawValue: string, opts: ExecRemoveOptions = {}): Promise<number> {
	const value = rawValue.trim();
	if (!value) {
		writeError(opts.json, "brigade exec: command/pattern is empty", { code: "empty" });
		return 1;
	}
	const filePath = getApprovalsFilePath();
	const approvals = readApprovalsRaw();
	const beforeCmdCount = approvals.commands.length;
	const beforePatCount = approvals.patterns.length;
	approvals.commands = approvals.commands.filter((c) => c !== value);
	approvals.patterns = approvals.patterns.filter((p) => p !== value);
	const removedCmd = beforeCmdCount - approvals.commands.length;
	const removedPat = beforePatCount - approvals.patterns.length;
	if (removedCmd === 0 && removedPat === 0) {
		writeError(opts.json, `brigade exec: "${value}" not found in commands or patterns`, {
			code: "not-found",
			value,
		});
		return 1;
	}
	// Atomic replace via temp + rename, same shape as exec-approvals saver.
	const tmp = `${filePath}.tmp`;
	fs.mkdirSync(filePath.replace(/[/\\][^/\\]+$/, "") || ".", { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(approvals, null, 2), "utf8");
	fs.renameSync(tmp, filePath);
	// Drop the in-process cache so any subsequent `decideApproval` call
	// (e.g. inside the same brigade invocation) sees the new state.
	_resetApprovalsCacheForTests();
	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ ok: true, removedCommands: removedCmd, removedPatterns: removedPat }, null, 2)}\n`,
		);
	} else {
		const parts: string[] = [];
		if (removedCmd > 0) parts.push(`${removedCmd} command(s)`);
		if (removedPat > 0) parts.push(`${removedPat} pattern(s)`);
		process.stdout.write(`${chalk.yellow("removed")}: ${parts.join(", ")} matching "${value}"\n`);
	}
	return 0;
}

/* ───────────────────────── deny-test ───────────────────────── */

export async function runExecDenyTest(rawCommand: string, opts: ExecDenyTestOptions = {}): Promise<number> {
	const cmd = rawCommand.trim();
	if (!cmd) {
		writeError(opts.json, "brigade exec: command is empty", { code: "empty" });
		return 1;
	}
	const decision = decideApproval(cmd);
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ command: cmd, decision }, null, 2)}\n`);
		return 0;
	}
	const colored =
		decision === "allow"
			? chalk.green("allow")
			: decision === "deny"
				? chalk.red("deny")
				: chalk.yellow("prompt");
	process.stdout.write(`${cmd} → ${colored}\n`);
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
	const filePath = getApprovalsFilePath();
	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ path: filePath }, null, 2)}\n`);
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
