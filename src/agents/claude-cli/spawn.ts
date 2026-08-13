// Subprocess plumbing for the claude-cli backend: spawn the `claude` binary,
// stream its stdout as parsed NDJSON frames, and enforce a no-output watchdog
// that hard-kills a wedged process. Kept separate from `stream.ts` so the
// Pi-event mapping and the OS-process concerns test independently.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	buildClaudeCliEnv,
	CLAUDE_CLI_MCP_CONFIG_FLAG,
	CLAUDE_CLI_STRICT_MCP_FLAG,
	CLAUDE_CLI_SYSTEM_PROMPT_FILE_FLAG,
	resolveClaudeCliCommand,
} from "./catalog.js";
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

/**
 * Timeouts for a spawn carrying the Brigade MCP tool-plane.
 *
 * A tool-plane turn can legitimately sit silent for a long time: while the
 * binary blocks on our `/mcp` response, it writes NOTHING to stdout, so the
 * no-output watchdog keeps ticking. Two cases make the default 180s fatal:
 *   • an exec-gated tool (`bash`) awaits the operator's approval for up to 5
 *     minutes (exec-gate's `timeoutMs`), so a 180s watchdog would SIGKILL our
 *     own child before the operator could ever answer — the approval prompt
 *     would resolve into a dead process;
 *   • a long tool (`spawn_agent` running a whole sub-agent turn, media
 *     generation) can exceed both defaults.
 * So a tool-plane spawn gets a no-output grace comfortably ABOVE the approval
 * ceiling, and a proportionally larger hard ceiling. Non-tool-plane turns keep
 * the original, tighter numbers — a plain chat turn that goes silent for 3
 * minutes really is wedged.
 */
export const CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS = 360_000; // > exec-gate's 300s
export const CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS = 1_800_000;

/**
 * The one deadline a tool call cannot postpone.
 *
 * Both watchdogs above are PAUSED while the child waits on a Brigade tool, and the
 * hard ceiling slides forward by the paused span — correct, because the child is
 * healthy and we are the slow party. But it means a binary that issues a tool call
 * at least once per grace window keeps rearming both timers forever: the "hard"
 * ceiling bounds nothing. Nothing else bounds it either — the child's stdout is
 * silent (so no-output can't fire), and the MCP token now expires on IDLE time, so
 * an actively-calling turn refreshes it indefinitely.
 *
 * This timer is armed once at spawn and never paused, cleared, or slid. It is not a
 * liveness check — it is the ceiling on how long one turn may hold the operator's
 * shell, tokens, and billed tools while looping.
 */
export const CLAUDE_CLI_TOOL_PLANE_ABSOLUTE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h

export interface SpawnClaudeCliArgs {
	args: string[];
	/** Prompt delivered on stdin (the whole serialized conversation). */
	stdin: string;
	/**
	 * Composed system prompt. Written to a temp file inside the isolated cwd and
	 * passed via `--append-system-prompt-file` — NEVER on argv, so a large
	 * Brigade system prompt can't trip the OS command-line length limit
	 * (`spawn ENAMETOOLONG` on Windows). Omitted/empty ⇒ no system-prompt flag.
	 */
	systemPrompt?: string;
	/**
	 * Brigade MCP tool-plane config (JSON string — see tool-plane.ts). Written to
	 * a temp file inside the isolated cwd and passed via `--mcp-config` +
	 * `--strict-mcp-config`, so the binary sees EXACTLY Brigade's server and never
	 * the operator's personal MCP config. Omitted => no MCP flags (prior
	 * behaviour). A write failure fails OPEN unless `requireMcpConfig`.
	 */
	mcpConfigJson?: string;
	/**
	 * The caller denied the binary's own built-ins because this plane replaces
	 * them. Set on a full-plane turn: a failure to attach the plane must then FAIL
	 * the spawn, not silently produce an agent with no tools at all.
	 */
	requireMcpConfig?: boolean;
	/** External cancel (turn abort). Aborting SIGKILLs the child. */
	signal?: AbortSignal;
	noOutputTimeoutMs?: number;
	overallTimeoutMs?: number;
	/** Injectable spawn for tests. Defaults to node:child_process spawn. */
	spawnFn?: typeof spawn;
}

export type SpawnKillReason = "no-output-timeout" | "overall-timeout" | "absolute-ceiling" | "aborted";

export interface ClaudeCliRunHandle {
	/** Async iterator of parsed stdout frames (blank/garbage lines skipped). */
	frames: AsyncGenerator<ClaudeCliFrame>;
	/** Suspend the liveness watchdogs while the child blocks on a Brigade tool
	 *  call; the returned fn resumes them. Nested pauses are counted. */
	pause: () => () => void;
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
	// A tool-plane spawn blocks silently while Brigade executes its tools (and
	// possibly waits on an operator approval), so it needs the wider watchdogs.
	const hasToolPlane = (args.mcpConfigJson?.trim().length ?? 0) > 0;
	const noOutputMs =
		args.noOutputTimeoutMs ??
		(hasToolPlane ? CLAUDE_CLI_TOOL_PLANE_NO_OUTPUT_TIMEOUT_MS : CLAUDE_CLI_NO_OUTPUT_TIMEOUT_MS);
	const overallMs =
		args.overallTimeoutMs ??
		(hasToolPlane ? CLAUDE_CLI_TOOL_PLANE_OVERALL_TIMEOUT_MS : CLAUDE_CLI_OVERALL_TIMEOUT_MS);
	const doSpawn = args.spawnFn ?? spawn;

	// Isolated, empty working dir — the tool-containment boundary. `mkdtempSync`
	// gives it a random suffix nobody can pre-claim, at mode 0700: what lands in
	// here is the composed system prompt and the tool-plane config (which carries
	// this turn's MCP token), and a fixed name under a world-writable /tmp (mode
	// 1777) is a path any local user can create or symlink ahead of us.
	//
	// There is deliberately NO fallback to the bare temp dir. That would hand both
	// files a predictable path AND drop the containment boundary itself, pointing a
	// `bypassPermissions` binary at everyone's /tmp. A machine that cannot make a
	// temp dir cannot run this turn safely, so say so.
	let cwd: string;
	try {
		cwd = mkdtempSync(path.join(tmpdir(), "brigade-claude-cli-"));
	} catch (err) {
		throw new Error(`claude-cli: could not create an isolated working dir under ${tmpdir()}: ${String(err)}`);
	}
	// Every exit from here on — thrown or spawned — goes through this.
	const removeCwd = () => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {
			/* leave it for the OS temp reaper */
		}
	};

	// Prefer Brigade's OWN Claude login (dedicated grant in its managed config
	// dir) when present — the binary auths + refreshes there, isolated from the
	// operator's personal ~/.claude. Absent it, leave CLAUDE_CONFIG_DIR unset so
	// the binary uses its default (the operator's own login).
	const configDir = hasBrigadeClaudeLogin() ? resolveBrigadeClaudeConfigDir() : undefined;

	// Deliver the (potentially large) system prompt via a FILE, not argv — this
	// keeps argv tiny and dodges `spawn ENAMETOOLONG`. Written into the throwaway
	// cwd, so it's removed with it on exit.
	const finalArgs = [...args.args];
	const sys = args.systemPrompt?.trim();
	if (sys && sys.length > 0) {
		try {
			const sysFile = path.join(cwd, "system-prompt.txt");
			writeFileSync(sysFile, sys, { encoding: "utf8", mode: 0o600 });
			finalArgs.push(CLAUDE_CLI_SYSTEM_PROMPT_FILE_FLAG, sysFile);
		} catch {
			/* couldn't write the file — proceed without the appended prompt rather
			   than fail the turn (the CLI still has its own default identity). */
		}
	}

	// Brigade MCP tool-plane (memory tools) — same temp-file lifecycle as the
	// system prompt: lives in the throwaway cwd, removed with it on exit.
	// `--strict-mcp-config` pins the binary's MCP surface to EXACTLY this file.
	const mcpJson = args.mcpConfigJson?.trim();
	if (mcpJson && mcpJson.length > 0) {
		try {
			const mcpFile = path.join(cwd, "mcp-config.json");
			writeFileSync(mcpFile, mcpJson, { encoding: "utf8", mode: 0o600 });
			finalArgs.push(CLAUDE_CLI_MCP_CONFIG_FLAG, mcpFile, CLAUDE_CLI_STRICT_MCP_FLAG);
		} catch (err) {
			// Fail-open is only safe when the binary keeps its own tools. On a FULL-PLANE
			// turn the caller already denied every built-in (the plane replaces them), so
			// spawning without the plane hands the model ZERO tools while its system prompt
			// promises a filesystem — it would confidently report work it cannot do.
			// Fail LOUD instead: the retry layer respawns, and the operator sees why.
			if (args.requireMcpConfig === true) {
				// Nothing will ever start here, so nothing will ever run `finish` — take the
				// system prompt we just wrote with us.
				removeCwd();
				throw new Error(
					`claude-cli: could not write the tool-plane config; refusing to spawn a tool-less agent: ${String(err)}`,
				);
			}
			/* memory-only plane: the binary keeps its own tools, so proceed without ours. */
		}
	}

	let child: ChildProcessWithoutNullStreams;
	try {
		child = doSpawn(command, finalArgs, {
			cwd,
			env: buildClaudeCliEnv(process.env, { configDir }),
			stdio: ["pipe", "pipe", "pipe"],
			// No shell — argv is passed verbatim so nothing is word-split or expanded.
			shell: false,
		}) as ChildProcessWithoutNullStreams;
	} catch (err) {
		// A synchronous spawn failure (bad argv, EPERM) never reaches the 'error'
		// handler below, so this is the only place the prompt file can be removed.
		removeCwd();
		throw err;
	}

	let killReason: SpawnKillReason | undefined;
	let settled = false;
	let stderr = "";
	const STDERR_CAP = 8_000;

	// ── watchdog timers ──
	let noOutputTimer: NodeJS.Timeout | undefined;
	let overallTimer: NodeJS.Timeout | undefined;
	// Armed once, never paused and never slid — see CLAUDE_CLI_TOOL_PLANE_ABSOLUTE_TIMEOUT_MS.
	// Only a tool-plane spawn can chain pauses, so only it needs the ceiling; a plain
	// turn is already bounded by `overallMs`.
	let absoluteTimer: NodeJS.Timeout | undefined;
	// Nested pause depth + the wall-clock deadline for the hard ceiling. Time spent
	// PAUSED (i.e. time Brigade spent executing a tool the child asked for) does not
	// count against the child's budget — the deadline slides forward by that much.
	let pauseDepth = 0;
	let pausedAt = 0;
	let overallDeadline = Date.now() + overallMs;
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
	// Only a tool-plane spawn can chain pauses and slide its ceiling; a plain turn is
	// already bounded by `overallMs`, so it needs no second, unpausable deadline.
	if (hasToolPlane) {
		absoluteTimer = setTimeout(() => kill("absolute-ceiling"), CLAUDE_CLI_TOOL_PLANE_ABSOLUTE_TIMEOUT_MS);
		absoluteTimer.unref?.();
	}
	const armNoOutput = () => {
		if (pauseDepth > 0) return; // Brigade is working; the child is not wedged.
		if (noOutputTimer) clearTimeout(noOutputTimer);
		noOutputTimer = setTimeout(() => kill("no-output-timeout"), noOutputMs);
		// Don't keep the event loop alive purely for the watchdog.
		noOutputTimer.unref?.();
	};
	const armOverall = (ms: number) => {
		if (overallTimer) clearTimeout(overallTimer);
		overallTimer = setTimeout(() => kill("overall-timeout"), Math.max(ms, 0));
		overallTimer.unref?.();
	};

	/**
	 * Suspend both watchdogs while the child blocks on a Brigade tool call. The
	 * child writes NOTHING to stdout for that whole window — a `spawn_agent` may
	 * run a full sub-agent turn, a `generate_video` has its own 20-minute budget,
	 * an exec-gated `bash` waits on the operator — so the liveness timers would
	 * otherwise kill a perfectly healthy process for waiting on us. Brigade bounds
	 * that time itself (every tool carries its own timeout).
	 */
	const pauseWatchdogs = (): (() => void) => {
		if (settled) return () => {};
		if (pauseDepth++ === 0) {
			pausedAt = Date.now();
			clearTimers();
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--pauseDepth > 0 || settled) return;
			// Give back the time we spent working, then rearm.
			overallDeadline += Date.now() - pausedAt;
			armNoOutput();
			armOverall(overallDeadline - Date.now());
		};
	};

	armOverall(overallMs);
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
				// Deliberately NOT in clearTimers(): that runs on every pause, and the
				// absolute ceiling is the one deadline a tool call may not postpone.
				if (absoluteTimer) clearTimeout(absoluteTimer);
				absoluteTimer = undefined;
				if (args.signal) args.signal.removeEventListener("abort", onAbort);
				// Flush a final unterminated line.
				const tail = parseClaudeCliLine(buffer);
				if (tail) queue.push(tail);
				buffer = "";
				closed = true;
				pump();
				// Best-effort cleanup of the throwaway cwd.
				removeCwd();
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

	return { frames: frames(), done: exit, pause: pauseWatchdogs };
}
