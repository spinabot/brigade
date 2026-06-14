/**
 * `brigade gateway supervise` — out-of-process gateway watchdog.
 *
 * The OS service-manager (launchd / systemd / Task Scheduler) already
 * restarts the gateway on a CRASH. What it can't catch is a WEDGED
 * gateway: process still alive, PID still listed, but the Node event
 * loop is starved (deadlock, runaway sync compute, exhausted FDs).
 * Symptoms: every WS RPC times out, every channel goes silent, every
 * cron tick is missed — yet `ps` shows the process up. To the OS,
 * everything is fine. To Brigade, nothing is fine.
 *
 * This supervisor closes that gap. On each cycle it reads
 * `~/.brigade/gateway.heartbeat` (which the gateway updates every
 * 30s from inside the tick loop, so a starved loop can't refresh it).
 * If the file is missing OR its `ts` is older than
 * `GATEWAY_HEARTBEAT_STALE_MS` (90s default) it kills the wedged
 * gateway via the existing `gateway stop` flow (SIGTERM + wait, then
 * SIGKILL fallback) and spawns a replacement via the standard
 * `ensureGatewayRunning` path.
 *
 * Once-mode (`--once`) is the building block: the looping
 * implementation just calls the once-mode check on an interval. Tests
 * and shell scripts can drive once-mode directly.
 */

import { setTimeout as sleep } from "node:timers/promises";

import {
	GATEWAY_HEARTBEAT_STALE_MS,
	isProcessAlive,
	readHeartbeat,
	readPid,
} from "../../core/gateway-probe.js";
import { ensureGatewayRunning } from "../../core/gateway-spawn.js";

export type SuperviseDecision =
	| { kind: "healthy"; ageMs: number; pid: number }
	| { kind: "no-pid"; reason: string }
	| { kind: "no-heartbeat"; reason: string }
	| { kind: "stale"; ageMs: number; pid: number; reason: string }
	| { kind: "dead-pid"; pid: number; reason: string };

export interface SuperviseOptions {
	/** Treat heartbeats older than this as wedged. Defaults to 90s. */
	maxStaleMs?: number;
	/** Override the wall clock (testing). */
	nowMs?: () => number;
	/** Override the PID file path. For tests; production reads ~/.brigade/gateway.pid. */
	pidPath?: string;
	/** Override the heartbeat file path. For tests; production reads ~/.brigade/gateway.heartbeat. */
	heartbeatPath?: string;
}

/**
 * Single, pure check that decides whether the gateway is healthy. Pure
 * because: no I/O beyond reading the heartbeat + PID file, no spawn,
 * no kill. Callers (loop mode, once mode, tests) decide what to DO
 * with the verdict.
 */
export async function checkGatewayHealth(opts: SuperviseOptions = {}): Promise<SuperviseDecision> {
	const now = (opts.nowMs ?? Date.now)();
	const maxStale = opts.maxStaleMs ?? GATEWAY_HEARTBEAT_STALE_MS;
	// Mode-aware: convex consults the gatewayCoord row; filesystem (or an
	// explicit pathOverride from tests) reads the files.
	const pid = await readPid(opts.pidPath);
	const heartbeat = await readHeartbeat(opts.heartbeatPath);

	if (pid === undefined) {
		// No PID file means the gateway is not running OR shut down cleanly.
		// Either way, nothing to supervise this cycle.
		return { kind: "no-pid", reason: "no gateway.pid file — gateway not running" };
	}
	if (!isProcessAlive(pid)) {
		// PID file points at a dead process — the gateway crashed without
		// cleaning up. The OS service-manager would normally restart it; the
		// supervisor's job here is to surface the failure clearly + nudge a
		// respawn so we recover even on hosts without an installed service.
		return { kind: "dead-pid", pid, reason: `gateway PID ${pid} is no longer alive` };
	}
	if (!heartbeat) {
		// Process is alive but no heartbeat file — either the file was
		// deleted out from under us, or the gateway hasn't started writing
		// yet (boot race). Treat as wedged ONLY after the same staleness
		// window so a slow boot doesn't trigger an unnecessary restart.
		return {
			kind: "no-heartbeat",
			reason: "gateway is alive but no gateway.heartbeat file is present",
		};
	}
	const ageMs = now - heartbeat.ts;
	if (ageMs > maxStale) {
		return {
			kind: "stale",
			ageMs,
			pid,
			reason: `heartbeat is ${ageMs}ms old (threshold ${maxStale}ms) — gateway event loop wedged`,
		};
	}
	return { kind: "healthy", ageMs, pid };
}

export interface SuperviseRunOptions extends SuperviseOptions {
	/** Cycle interval. Defaults to 30_000 (matches TICK_INTERVAL_MS). */
	intervalMs?: number;
	/**
	 * Max respawns allowed inside `respawnWindowMs`. Once the cap is hit,
	 * further wedge / dead-pid observations log a warning and skip the
	 * respawn until the rolling window clears. Prevents a config-broken
	 * gateway from being respawned 1440 times a day. Default 12 — twice
	 * the systemd `StartLimitBurst=5` of the reference codebase, sized so
	 * a once-per-hour real recovery never trips the limiter.
	 */
	maxRespawnsPerWindow?: number;
	/** Window for the respawn cap. Defaults to 3_600_000 (1 hour). */
	respawnWindowMs?: number;
	/** `--once`: run a single check and return without looping. */
	once?: boolean;
	/** Emit JSON lines instead of human-readable text. */
	json?: boolean;
	/** Abort signal for clean shutdown (tests, SIGTERM). */
	signal?: AbortSignal;
	/** Override sleep for testing. */
	sleeper?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Override the restart action (testing). */
	respawn?: () => Promise<void>;
	/** Override stdout/stderr for capture. */
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

/**
 * Exit code 3 is reserved for "wedge/dead-pid detected BUT respawn skipped
 * because rate-limit was hit". Lets shell wrappers (or a paging hook)
 * distinguish "I just fixed it" from "I'd fix it but the limiter says no
 * — investigate before unblocking".
 */
const EXIT_RATE_LIMITED = 3;

/**
 * Loop entrypoint for `brigade gateway supervise`. Returns the exit
 * code so callers (CLI + tests) can `process.exit(result)`.
 *
 * Exit codes:
 *   0 — once-mode found a healthy gateway, OR loop was cleanly aborted.
 *   1 — once-mode found a problem AND respawn failed.
 *   2 — once-mode found a problem AND respawned successfully (so the
 *       caller's shell loop can distinguish "everything ok" from "I
 *       just fixed something" without parsing JSON).
 */
export async function runGatewaySupervise(opts: SuperviseRunOptions = {}): Promise<number> {
	const interval = opts.intervalMs ?? 30_000;
	const sleeper = opts.sleeper ?? ((ms, sig) => sleep(ms, undefined, { signal: sig }).then(() => undefined));
	const stdout = opts.stdout ?? ((s) => process.stdout.write(`${s}\n`));
	const stderr = opts.stderr ?? ((s) => process.stderr.write(`${s}\n`));
	const respawn =
		opts.respawn ??
		(async () => {
			// `ensureGatewayRunning` is the same idempotent helper `brigade
			// chat` uses to spawn a detached daemon. It's a no-op if a healthy
			// one is already up; on stale-PID it spawns a fresh one.
			await ensureGatewayRunning();
		});

	// Respawn rate-limiter. Rolling window of epoch-ms timestamps; on every
	// would-be respawn we prune entries older than `respawnWindowMs` and
	// refuse if the surviving length is at-cap. A config-broken gateway
	// (missing auth, corrupt brigade.json, port hijack) would otherwise
	// loop forever consuming CPU and noisy log lines; the limiter stops
	// the loop after enough attempts to give the operator a clear signal.
	const respawnWindowMs = opts.respawnWindowMs ?? 60 * 60_000;
	const maxRespawns = opts.maxRespawnsPerWindow ?? 12;
	const respawnAtMs: number[] = [];
	const nowMs = (): number => (opts.nowMs ?? Date.now)();
	const isOverLimit = (): boolean => {
		const cutoff = nowMs() - respawnWindowMs;
		while (respawnAtMs.length > 0 && (respawnAtMs[0] as number) < cutoff) respawnAtMs.shift();
		return respawnAtMs.length >= maxRespawns;
	};

	const emit = (msg: string, kind: SuperviseDecision["kind"], extra?: Record<string, unknown>): void => {
		if (opts.json) {
			stdout(JSON.stringify({ ts: new Date().toISOString(), kind, msg, ...extra }));
		} else {
			stdout(`[brigade supervise] ${kind}: ${msg}`);
		}
	};

	const cycle = async (): Promise<{ exitCode: number; acted: boolean }> => {
		const decision = await checkGatewayHealth(opts);
		if (decision.kind === "healthy") {
			emit(`gateway healthy (pid ${decision.pid}, heartbeat age ${decision.ageMs}ms)`, "healthy", {
				pid: decision.pid,
				ageMs: decision.ageMs,
			});
			return { exitCode: 0, acted: false };
		}
		if (decision.kind === "no-pid") {
			// Nothing to do — gateway is intentionally down OR never started.
			// Don't auto-spawn here; that's the user's call (a supervised
			// service that auto-starts would re-spawn after `brigade
			// gateway stop`, which is unexpected).
			emit(decision.reason, decision.kind);
			return { exitCode: 0, acted: false };
		}
		// Anything else means the gateway is wedged / dead. Before respawning,
		// honour the rate limiter — a config-broken gateway would otherwise
		// be respawned every cycle forever. The limiter audit log makes the
		// give-up state observable to the operator instead of silent.
		if (isOverLimit()) {
			stderr(
				`[brigade supervise] respawn rate-limit hit (${maxRespawns} per ${Math.round(
					respawnWindowMs / 60_000,
				)}min) — skipping respawn for ${decision.kind}: ${decision.reason}`,
			);
			emit(
				`respawn rate-limit hit — investigate before unblocking`,
				decision.kind,
				{ ...decision, rateLimited: true, maxRespawns, respawnWindowMs },
			);
			return { exitCode: EXIT_RATE_LIMITED, acted: false };
		}
		// Surface the reason then attempt a respawn. ensureGatewayRunning
		// kills the stale PID if needed and waits for the new one to accept
		// WS connections before returning. We record the respawn attempt
		// BEFORE awaiting so a respawn that hangs still counts against the
		// budget (an in-flight respawn that never returns is its own bug).
		stderr(`[brigade supervise] ${decision.kind}: ${decision.reason} — respawning…`);
		respawnAtMs.push(nowMs());
		try {
			await respawn();
			emit(`gateway respawned after ${decision.kind}`, decision.kind, decision);
			return { exitCode: 2, acted: true };
		} catch (err) {
			stderr(
				`[brigade supervise] respawn failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { exitCode: 1, acted: true };
		}
	};

	if (opts.once) {
		return (await cycle()).exitCode;
	}

	stdout(
		opts.json
			? JSON.stringify({
					ts: new Date().toISOString(),
					kind: "start",
					intervalMs: interval,
					maxStaleMs: opts.maxStaleMs ?? GATEWAY_HEARTBEAT_STALE_MS,
				})
			: `[brigade supervise] watching gateway heartbeat every ${interval}ms (stale > ${
					opts.maxStaleMs ?? GATEWAY_HEARTBEAT_STALE_MS
				}ms)…`,
	);

	while (!opts.signal?.aborted) {
		await cycle();
		try {
			await sleeper(interval, opts.signal);
		} catch {
			// AbortError — clean shutdown, fall through.
			break;
		}
	}
	return 0;
}
