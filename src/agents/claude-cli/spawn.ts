// Subprocess plumbing for the claude-cli backend: spawn the `claude` binary,
// stream its stdout as parsed NDJSON frames, and enforce a no-output watchdog
// that hard-kills a wedged process. Kept separate from `stream.ts` so the
// Pi-event mapping and the OS-process concerns test independently.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildClaudeCliEnv, resolveClaudeCliCommand } from "./catalog.js";
import { hasBrigadeClaudeLogin, resolveBrigadeClaudeConfigDir } from "./claude-config.js";
import { parseClaudeCliLine, type ClaudeCliFrame } from "./stream-json.js";

/**
 * No-output watchdog. The timer is reset on every stdout/stderr chunk, so a
 * slow-but-streaming turn survives while a genuinely wedged process (waiting on
 * an interactive prompt that can never arrive, or hung on the network) trips it
 * and is SIGKILL'd. Fresh runs get a longer grace (CLI startup + auth); we have
 * no resume path in v1 so a single profile suffices.
 */
export const CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS = 180_000;
/** Hard ceiling on a single turn regardless of trickle output. */
export const CLAUDE_CLI_OVERALL_TIMEOUT_MS = 600_000;

export interface SpawnClaudeCliArgs {
	args: string[];
	/** Prompt delivered on stdin (the whole serialized conversation). */
	stdin: string;
	/** External cancel (turn abort). Aborting SIGKILLs the child. */
	signal?: AbortSignal;
	noOutputTimeoutMs?: number;
	overallTimeoutMs?: number;
	/** Injectable spawn for tests. Defaults to node:child_process spawn. */
	spawnFn?: typeof spawn;
}

export type SpawnKillReason = "no-output-timeout" | "overall-timeout" | "aborted";

export interface ClaudeCliRunHandle {
	/** Async iterator of parsed stdout frames (blank/garbage lines skipped). */
	frames: AsyncGenerator<ClaudeCliFrame>;
	/** Resolves once the process exits: its code, and any kill reason we forced. */
	done: Promise<{ code: number | null; killReason?: SpawnKillReason; stderr: string }>;
}

/**
 * Spawn `claude` with the given argv, feed `stdin`, and stream parsed frames.
 * The isolated empty temp cwd contains the CLI's tool blast radius: even under
 * `bypassPermissions` any file/read tool it reaches acts on a throwaway dir,
 * never the operator's project. The dir is removed when the process exits.
 */
export function spawnClaudeCli(args: SpawnClaudeCliArgs): ClaudeCliRunHandle {
	const command = resolveClaudeCliCommand();
	const noOutputMs = args.noOutputTimeoutMs ?? CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS;
	const overallMs = args.overallTimeoutMs ?? CLAUDE_CLI_OVERALL_TIMEOUT_MS;
	const doSpawn = args.spawnFn ?? spawn;

	// Isolated, empty working dir — the tool-containment boundary.
	let cwd: string;
	try {
		cwd = mkdtempSync(path.join(tmpdir(), "brigade-claude-cli-"));
	} catch {
		cwd = tmpdir();
	}

	// Prefer Brigade's OWN Claude login (dedicated grant in its managed config
	// dir) when present — the binary auths + refreshes there, isolated from the
	// operator's personal ~/.claude. Absent it, leave CLAUDE_CONFIG_DIR unset so
	// the binary uses its default (the operator's own login).
	const configDir = hasBrigadeClaudeLogin() ? resolveBrigadeClaudeConfigDir() : undefined;
	const child: ChildProcessWithoutNullStreams = doSpawn(command, args.args, {
		cwd,
		env: buildClaudeCliEnv(process.env, { configDir }),
		stdio: ["pipe", "pipe", "pipe"],
		// No shell — argv is passed verbatim so nothing is word-split or expanded.
		shell: false,
	}) as ChildProcessWithoutNullStreams;

	let killReason: SpawnKillReason | undefined;
	let settled = false;
	let stderr = "";
	const STDERR_CAP = 8_000;

	// ── watchdog timers ──
	let noOutputTimer: NodeJS.Timeout | undefined;
	let overallTimer: NodeJS.Timeout | undefined;
	const clearTimers = () => {
		if (noOutputTimer) clearTimeout(noOutputTimer);
		if (overallTimer) clearTimeout(overallTimer);
		noOutputTimer = undefined;
		overallTimer = undefined;
	};
	const kill = (reason: SpawnKillReason) => {
		if (settled || killReason) return;
		killReason = reason;
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	};
	const armNoOutput = () => {
		if (noOutputTimer) clearTimeout(noOutputTimer);
		noOutputTimer = setTimeout(() => kill("no-output-timeout"), noOutputMs);
		// Don't keep the event loop alive purely for the watchdog.
		noOutputTimer.unref?.();
	};
	overallTimer = setTimeout(() => kill("overall-timeout"), overallMs);
	overallTimer.unref?.();
	armNoOutput();

	const onAbort = () => kill("aborted");
	if (args.signal) {
		if (args.signal.aborted) onAbort();
		else args.signal.addEventListener("abort", onAbort, { once: true });
	}

	// ── stderr capture (bounded) ──
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		armNoOutput(); // stderr progress also counts as "alive"
		if (stderr.length < STDERR_CAP) stderr += chunk;
	});

	// ── stdout → line-buffered frame queue ──
	// A small async queue bridges the 'data'/'close' events to the generator.
	const queue: ClaudeCliFrame[] = [];
	let resolveNext: (() => void) | undefined;
	let closed = false;
	let buffer = "";

	const pump = () => {
		if (resolveNext) {
			const r = resolveNext;
			resolveNext = undefined;
			r();
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		armNoOutput();
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const frame = parseClaudeCliLine(line);
			if (frame) queue.push(frame);
		}
		pump();
	});

	const exit = new Promise<{ code: number | null; killReason?: SpawnKillReason; stderr: string }>(
		(resolve) => {
			const finish = (code: number | null) => {
				if (settled) return;
				settled = true;
				clearTimers();
				if (args.signal) args.signal.removeEventListener("abort", onAbort);
				// Flush a final unterminated line.
				const tail = parseClaudeCliLine(buffer);
				if (tail) queue.push(tail);
				buffer = "";
				closed = true;
				pump();
				// Best-effort cleanup of the throwaway cwd.
				try {
					rmSync(cwd, { recursive: true, force: true });
				} catch {
					/* leave it for the OS temp reaper */
				}
				resolve({ code, killReason, stderr });
			};
			child.on("close", (code) => finish(code));
			child.on("error", () => finish(null)); // spawn failure (binary missing, etc.)
		},
	);

	// Feed stdin, then close it so the CLI starts generating.
	try {
		child.stdin.write(args.stdin);
		child.stdin.end();
	} catch {
		/* the 'error' handler above will settle the run */
	}

	async function* frames(): AsyncGenerator<ClaudeCliFrame> {
		while (true) {
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (closed) return;
			await new Promise<void>((r) => {
				resolveNext = r;
			});
		}
	}

	return { frames: frames(), done: exit };
}
