/**
 * Scheduler tick loop + per-job execution dispatch.
 *
 * Three pieces work together here:
 *
 *   - **armTimer** — schedules the next `onTimer` call via `setTimeout`,
 *     clamped at `MAX_TIMER_DELAY_MS` (60 s) so process suspend / wall-clock
 *     skew can't leave us asleep past a missed fire. We use a fresh
 *     `setTimeout` each tick (not `setInterval`) so the scheduling is
 *     anchored to actual completion time, not nominal interval ticks.
 *
 *   - **onTimer** — the tick handler. Walks the job list, finds whatever's
 *     due (or marginally past-due), spawns up to `maxConcurrentRuns`
 *     parallel `runDueJob` calls, then rearms the timer to the next wake
 *     time. A watchdog also rearms during long-running jobs so the timer
 *     can't stay disarmed indefinitely.
 *
 *   - **runDueJob** — sets the `runningAtMs` marker, persists it, calls the
 *     injected `runIsolatedAgentJob` (or `enqueueSystemEvent` for main-
 *     session payloads), then applies the outcome via `applyJobResult`.
 *     Emits `started` + `finished` events for every fire. Writes a run-log
 *     entry on finish. Triggers failure-alert if the consecutive-error
 *     count crosses the configured threshold.
 *
 * The startup catchup (`runMissedJobs`) is invoked separately by `ops.start`
 * — it's a one-shot at-restart sweep, not part of the tick loop.
 */

import { withPerInstanceLock } from "./locked.js";
import {
	parseSessionRetention,
	reapIsolatedCronSessions,
	shouldRunSweep,
} from "../session-reaper.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { ensureLoaded, persist } from "./store.js";
import {
	applyJobResult,
	computeJobNextRunAtMs,
	errorBackoffMs,
	normalizeJobTickState,
	recordScheduleComputeError,
	type CronJobExecutionResult,
} from "./jobs.js";
import { appendCronRunLog } from "../run-log.js";
import type {
	CronEvent,
	CronJob,
	CronPayloadAgentTurn,
	CronRunLogEntry,
} from "../types.js";
import type {
	CronFailureAlertSendArgs,
	CronIsolatedRunOutcome,
	CronServiceState,
} from "./state.js";

/** Anti-drift clamp on the timer delay. */
export const MAX_TIMER_DELAY_MS = 60_000;
/** Spin-loop safety net — if the calculated delay rounds to 0, fall back to this. */
export const MIN_REFIRE_GAP_MS = 2_000;
/** How long to wait between watchdog-driven rearms during execution. */
const RUNNING_RECHECK_INTERVAL_MS = 60_000;
/** Per-execution wall-clock cap when the job didn't specify one. */
const DEFAULT_EXECUTION_TIMEOUT_MS = 15 * 60_000;

/** Compute the minimum next-fire across all enabled jobs. `undefined` = no work pending. */
export function nextWakeAtMs(state: CronServiceState): number | undefined {
	let earliest: number | undefined;
	for (const job of state.store.jobs) {
		if (!job.enabled) continue;
		const next = job.state.nextRunAtMs;
		if (next === undefined) continue;
		if (job.state.runningAtMs !== undefined) continue;
		if (earliest === undefined || next < earliest) earliest = next;
	}
	return earliest;
}

/** Cancel any pending scheduler timer. Safe to call when no timer is armed. */
export function stopTimer(state: CronServiceState): void {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = null;
	}
}

/**
 * Schedule the next `onTimer` call. Idempotent — cancels any previous timer
 * before scheduling the new one so multiple `armTimer` calls don't pile up.
 * The 60 s clamp ensures we wake up at least every minute even when no
 * jobs are pending; that lets the maintenance pass + watchdog do their work.
 */
export function armTimer(state: CronServiceState): void {
	stopTimer(state);
	if (state.config.enabled === false) return;
	const now = state.deps.nowMs!();
	const next = nextWakeAtMs(state);
	let delay = next === undefined ? MAX_TIMER_DELAY_MS : Math.max(0, next - now);
	delay = Math.min(delay, MAX_TIMER_DELAY_MS);
	if (delay < MIN_REFIRE_GAP_MS && next !== undefined && next <= now) {
		// We're past-due on something — fire immediately rather than wait
		// the MIN_REFIRE_GAP_MS, but use a microtask-ish 0ms timeout so the
		// stack still unwinds before re-entering.
		delay = 0;
	} else if (delay === 0 && next === undefined) {
		// No work + zero delay would spin — use MAX_TIMER_DELAY_MS instead.
		delay = MAX_TIMER_DELAY_MS;
	}
	state.timer = setTimeout(() => {
		void onTimer(state);
	}, delay);
	// Don't keep the event loop alive solely for the cron timer — the
	// gateway daemon has its own keepalive (HTTP server). Standalone CLI
	// invocations want the process to exit when their work is done.
	if (typeof state.timer.unref === "function") state.timer.unref();
}

/** Watchdog: re-arm the timer even while a long job is running. */
function armRunningRecheckTimer(state: CronServiceState): void {
	stopTimer(state);
	state.timer = setTimeout(() => {
		if (!state.running) {
			void onTimer(state);
			return;
		}
		armRunningRecheckTimer(state);
	}, RUNNING_RECHECK_INTERVAL_MS);
	if (typeof state.timer.unref === "function") state.timer.unref();
}

/**
 * One tick of the scheduler. Always re-arms before returning.
 *
 * Lifecycle: load fresh from disk → normalize every job's tick-state →
 * collect runnables (within concurrency budget) → spawn them in parallel
 * → wait for all → recompute next-fire → persist → rearm.
 */
export async function onTimer(state: CronServiceState): Promise<void> {
	if (state.running) return; // re-entry guard (shouldn't happen, but cheap)
	state.running = true;
	armRunningRecheckTimer(state);
	try {
		await withPerInstanceLock(state.op, async () => {
			await ensureLoaded(state);
			const now = state.deps.nowMs!();
			let storeMutated = false;

			// Maintenance pass: clear stuck runningAtMs, refresh stale nextRunAtMs.
			for (let i = 0; i < state.store.jobs.length; i++) {
				const job = state.store.jobs[i]!;
				const normalized = normalizeJobTickState(job, now);
				if (normalized.changed) {
					state.store.jobs[i] = normalized.job;
					storeMutated = true;
				}
			}

			const runnable = collectRunnableJobs(state, now);
			if (runnable.length === 0) {
				if (storeMutated) await persist(state);
				return;
			}

			// Mark every job-we're-about-to-run as `running` + persist BEFORE
			// dispatching. If we crash mid-dispatch, the next startup will
			// see the marker, treat it as stuck (after STUCK_RUN_MS), and
			// clear it — no double-execution.
			for (const job of runnable) {
				const idx = state.store.jobs.findIndex((j) => j.id === job.id);
				if (idx < 0) continue;
				state.store.jobs[idx] = {
					...state.store.jobs[idx]!,
					state: { ...state.store.jobs[idx]!.state, runningAtMs: now },
				};
			}
			await persist(state);

			// Spawn the runs in parallel — `runDueJob` is fully self-contained
			// (it locks again internally for its persist call).
			await Promise.all(runnable.map((job) => runDueJob(state, job, now)));
		});
	} finally {
		// Session-reaper sweep — throttled to once per MIN_SWEEP_INTERVAL_MS
		// (5 minutes) so the tick loop doesn't hammer the filesystem on
		// every fire. Operates on the "main" agent's sessions for v1; a
		// multi-agent setup can iterate later. Best-effort: a thrown sweep
		// is caught + logged so it can't break the timer rearm below.
		const sweepNow = state.deps.nowMs!();
		if (shouldRunSweep(state.lastReapAtMs, sweepNow)) {
			const retentionMs = parseSessionRetention(state.config.sessionRetention);
			if (retentionMs !== null && retentionMs > 0) {
				try {
					await reapIsolatedCronSessions({
						agentId: DEFAULT_AGENT_ID,
						retentionMs,
						nowMs: sweepNow,
						log: state.deps.log,
					});
				} catch (err) {
					state.deps.log.warn("session reaper sweep threw", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			state.lastReapAtMs = sweepNow;
		}
		state.running = false;
		armTimer(state);
	}
}

/** Find jobs whose next-fire has arrived and we can dispatch right now. */
function collectRunnableJobs(state: CronServiceState, nowMs: number): CronJob[] {
	const maxConcurrent = Math.max(1, state.config.maxConcurrentRuns ?? 1);
	let alreadyRunning = 0;
	const candidates: CronJob[] = [];
	for (const job of state.store.jobs) {
		if (job.state.runningAtMs !== undefined) alreadyRunning++;
		if (!job.enabled) continue;
		if (job.state.runningAtMs !== undefined) continue;
		const next = job.state.nextRunAtMs;
		if (next === undefined) continue;
		if (next > nowMs) continue;
		candidates.push(job);
	}
	// Sort oldest-due-first so stale jobs run before fresh ones.
	candidates.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
	const slots = Math.max(0, maxConcurrent - alreadyRunning);
	return candidates.slice(0, slots);
}

/**
 * Execute one job. Dispatches based on `sessionTarget`:
 *   - `"main"` → enqueue system event (parent operator session sees it).
 *   - other     → call `runIsolatedAgentJob` dep with the job spec.
 *
 * Outcome path:
 *   - emit `started` event
 *   - run + capture outcome
 *   - apply outcome to job state (clears runningAtMs, sets nextRunAtMs +
 *     backoff for transient errors, disables for permanent / one-shot ok)
 *   - persist
 *   - emit `finished` event
 *   - append run-log entry
 *   - maybe send failure-alert
 *   - maybe delete one-shot
 */
async function runDueJob(
	state: CronServiceState,
	job: CronJob,
	runAtMs: number,
): Promise<void> {
	emit(state, { action: "started", jobId: job.id, runAtMs });

	const startedAtMs = state.deps.nowMs!();
	const outcome = await executeJobCoreWithTimeout(state, job, runAtMs).catch(
		(err): CronIsolatedRunOutcome => ({
			status: "error",
			error: err instanceof Error ? err.message : String(err),
		}),
	);
	const endedAtMs = state.deps.nowMs!();

	const execResult: CronJobExecutionResult = {
		status: outcome.status,
		startedAtMs,
		endedAtMs,
		...(outcome.error !== undefined ? { error: outcome.error } : {}),
		errorKind: outcome.status === "error" ? "transient" : undefined,
	};

	await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const idx = state.store.jobs.findIndex((j) => j.id === job.id);
		if (idx < 0) {
			// Job was deleted while running. Nothing to update.
			return;
		}
		const current = state.store.jobs[idx]!;
		const { job: applied, deleteAfterApply } = applyJobResult(current, execResult);
		if (deleteAfterApply) {
			state.store.jobs.splice(idx, 1);
		} else {
			state.store.jobs[idx] = applied;
		}
		await persist(state);

		const finishedEvent: CronEvent = {
			action: "finished",
			jobId: job.id,
			status: outcome.status,
			...(outcome.error !== undefined ? { error: outcome.error } : {}),
			...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
			...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
			...(outcome.sessionKey !== undefined ? { sessionKey: outcome.sessionKey } : {}),
			...(outcome.model !== undefined ? { model: outcome.model } : {}),
			...(outcome.provider !== undefined ? { provider: outcome.provider } : {}),
			...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
			runAtMs,
			durationMs: endedAtMs - startedAtMs,
			...(applied.state.nextRunAtMs !== undefined
				? { nextRunAtMs: applied.state.nextRunAtMs }
				: {}),
		};
		emit(state, finishedEvent);

		const logEntry: CronRunLogEntry = {
			ts: endedAtMs,
			jobId: job.id,
			action: "finished",
			status: outcome.status,
			...(outcome.error !== undefined ? { error: outcome.error } : {}),
			...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
			...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
			...(outcome.sessionKey !== undefined ? { sessionKey: outcome.sessionKey } : {}),
			runAtMs,
			durationMs: endedAtMs - startedAtMs,
			...(applied.state.nextRunAtMs !== undefined
				? { nextRunAtMs: applied.state.nextRunAtMs }
				: {}),
			...(outcome.model !== undefined ? { model: outcome.model } : {}),
			...(outcome.provider !== undefined ? { provider: outcome.provider } : {}),
			...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
		};
		// Fire-and-forget — appendCronRunLog has its own internal error log.
		void appendCronRunLog(logEntry, state.config.runLog);

		// Failure-alert check
		if (outcome.status === "error" && !deleteAfterApply) {
			await maybeSendFailureAlert(state, applied, outcome.error ?? "unknown error", endedAtMs);
		}
	});
}

/**
 * Execute the per-job timeout wrapper. Returns a `CronIsolatedRunOutcome`
 * regardless of how the underlying call resolved/rejected.
 */
async function executeJobCoreWithTimeout(
	state: CronServiceState,
	job: CronJob,
	runAtMs: number,
): Promise<CronIsolatedRunOutcome> {
	const timeoutMs = resolveJobTimeoutMs(job);
	const timeoutController = new AbortController();
	const timeoutHandle = setTimeout(() => {
		timeoutController.abort(new Error(`cron job timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
	try {
		return await executeJobCore(state, job, runAtMs, timeoutController.signal);
	} catch (err) {
		if (timeoutController.signal.aborted) {
			return {
				status: "error",
				error: `cron job timed out after ${timeoutMs}ms`,
			};
		}
		throw err;
	} finally {
		clearTimeout(timeoutHandle);
	}
}

/** Dispatch based on session target. */
async function executeJobCore(
	state: CronServiceState,
	job: CronJob,
	runAtMs: number,
	abortSignal: AbortSignal,
): Promise<CronIsolatedRunOutcome> {
	if (job.sessionTarget === "main") {
		// systemEvent payload — inject into main session. We don't WAIT for
		// the agent's response; the cron's "outcome" is just whether the
		// event was successfully enqueued.
		if (job.payload.kind !== "systemEvent") {
			return { status: "error", error: "invariant violated: main target without systemEvent payload" };
		}
		const enqueue = state.deps.enqueueSystemEvent;
		if (!enqueue) {
			return { status: "error", error: "no enqueueSystemEvent dep wired" };
		}
		try {
			enqueue({
				text: job.payload.text,
				...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
				...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
			});
			if (job.wakeMode === "now" && state.deps.requestHeartbeatNow) {
				state.deps.requestHeartbeatNow({ reason: "cron-wake" });
			}
			return { status: "ok", summary: summariseSystemEventPayload(job.payload.text) };
		} catch (err) {
			return { status: "error", error: err instanceof Error ? err.message : String(err) };
		}
	}

	// Isolated / session:* — delegate to the agent runner.
	if (job.payload.kind !== "agentTurn") {
		return { status: "error", error: "invariant violated: isolated target without agentTurn payload" };
	}
	const runner = state.deps.runIsolatedAgentJob;
	if (!runner) {
		return { status: "error", error: "no runIsolatedAgentJob dep wired" };
	}
	return runner({ job, runAtMs, abortSignal });
}

/** Per-job timeout resolution. */
function resolveJobTimeoutMs(job: CronJob): number {
	if (job.payload.kind !== "agentTurn") return DEFAULT_EXECUTION_TIMEOUT_MS;
	const p = job.payload as CronPayloadAgentTurn;
	if (typeof p.timeoutSeconds === "number" && p.timeoutSeconds > 0) {
		return p.timeoutSeconds * 1000;
	}
	return DEFAULT_EXECUTION_TIMEOUT_MS;
}

/** Truncate a long system-event text into a one-line summary for the run log. */
function summariseSystemEventPayload(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= 120 ? flat : `${flat.slice(0, 117)}…`;
}

/** Emit a lifecycle event, swallowing listener errors. */
function emit(state: CronServiceState, event: CronEvent): void {
	const cb = state.deps.onEvent;
	if (!cb) return;
	try {
		cb(event);
	} catch (err) {
		state.deps.log.warn("cron event listener threw", {
			action: (event as { action: string }).action,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Send a failure-alert if the consecutive-error count crossed the configured
 * `after` threshold AND the cooldown window has elapsed since the last alert.
 * Updates `lastFailureAlertAtMs` on success so the cooldown is honoured.
 */
async function maybeSendFailureAlert(
	state: CronServiceState,
	job: CronJob,
	error: string,
	endedAtMs: number,
): Promise<void> {
	const resolved = resolveFailureAlertConfig(state, job);
	if (!resolved) return;
	const count = job.state.consecutiveErrorCount ?? 0;
	if (count < resolved.after) return;
	const lastSentAtMs = job.state.lastFailureAlertAtMs ?? 0;
	if (endedAtMs - lastSentAtMs < resolved.cooldownMs) return;

	const sender = state.deps.sendCronFailureAlert;
	if (!sender) {
		state.deps.log.warn("failure-alert configured but no sendCronFailureAlert dep wired", {
			jobId: job.id,
		});
		return;
	}
	const text = formatFailureAlertText(job, count, error);
	const args: CronFailureAlertSendArgs = {
		job,
		text,
		mode: resolved.mode,
		...(resolved.channel !== undefined ? { channel: resolved.channel } : {}),
		...(resolved.to !== undefined ? { to: resolved.to } : {}),
		...(resolved.accountId !== undefined ? { accountId: resolved.accountId } : {}),
		...(resolved.webhookUrl !== undefined ? { webhookUrl: resolved.webhookUrl } : {}),
	};
	try {
		await sender(args);
		// Update lastFailureAlertAtMs under the lock.
		const idx = state.store.jobs.findIndex((j) => j.id === job.id);
		if (idx >= 0) {
			state.store.jobs[idx] = {
				...state.store.jobs[idx]!,
				state: { ...state.store.jobs[idx]!.state, lastFailureAlertAtMs: endedAtMs },
			};
			await persist(state);
		}
	} catch (err) {
		state.deps.log.warn("failure-alert send threw", {
			jobId: job.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

interface ResolvedFailureAlertConfig {
	after: number;
	cooldownMs: number;
	channel?: string;
	to?: string;
	accountId?: string;
	mode: "announce" | "webhook";
	webhookUrl?: string;
}

/** Resolve the effective failure-alert config: per-job overrides global. */
function resolveFailureAlertConfig(
	state: CronServiceState,
	job: CronJob,
): ResolvedFailureAlertConfig | null {
	const perJob = job.failureAlert;
	if (perJob === false) return null;
	const global = state.config.failureAlert;
	const globalEnabled = global?.enabled === true;
	const perJobPresent = perJob !== undefined;
	if (!globalEnabled && !perJobPresent) return null;
	const merged = {
		after: perJob?.after ?? global?.after ?? 2,
		cooldownMs: perJob?.cooldownMs ?? global?.cooldownMs ?? 60 * 60_000,
		channel: perJob?.channel,
		to: perJob?.to,
		accountId: perJob?.accountId ?? global?.accountId,
		mode: (perJob?.mode ?? global?.mode ?? "announce") as "announce" | "webhook",
		webhookUrl: perJob?.webhookUrl,
	};
	if (merged.after < 1) merged.after = 1;
	if (merged.cooldownMs < 0) merged.cooldownMs = 0;
	return merged;
}

function formatFailureAlertText(job: CronJob, count: number, error: string): string {
	const trimmedError = error.length > 200 ? `${error.slice(0, 197)}…` : error;
	return `Cron job "${job.name}" failed ${count} consecutive run(s)\nLast error: ${trimmedError}`;
}

/**
 * Bounded startup catchup. Called by `ops.start`. Find missed recurring jobs,
 * cap at `maxMissedJobsPerRestart`, schedule them with staggered offsets.
 * One-shot `at` jobs whose `runningAtMs` was set get the marker cleared
 * (interrupted mid-run, can't re-fire — they're presumed done).
 */
export async function planStartupCatchup(state: CronServiceState): Promise<void> {
	await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const now = state.deps.nowMs!();
		const maxMissed = Math.max(1, state.config.maxMissedJobsPerRestart ?? 5);
		const stagger = Math.max(0, state.config.missedJobStaggerMs ?? 5_000);
		let mutated = false;
		const missed: CronJob[] = [];

		for (let i = 0; i < state.store.jobs.length; i++) {
			const job = state.store.jobs[i]!;
			// Clear stale runningAtMs markers regardless of kind — we restarted.
			if (job.state.runningAtMs !== undefined) {
				state.store.jobs[i] = {
					...job,
					state: { ...job.state, runningAtMs: undefined },
				};
				mutated = true;
			}
			// One-shot interrupted: don't replay; we can't tell if it ran.
			if (job.schedule.kind === "at" && job.state.lastStatus === undefined) {
				continue;
			}
			if (!job.enabled) continue;
			const next = job.state.nextRunAtMs;
			if (next === undefined) {
				// Try to recompute — if a schedule-compute error happened earlier,
				// this might succeed now.
				try {
					const recomputed = computeJobNextRunAtMs(job, now);
					if (recomputed !== undefined) {
						state.store.jobs[i] = {
							...state.store.jobs[i]!,
							state: { ...state.store.jobs[i]!.state, nextRunAtMs: recomputed },
						};
						mutated = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					state.store.jobs[i] = recordScheduleComputeError(job, message);
					mutated = true;
				}
				continue;
			}
			// Past-due → mark as missed; we'll defer fire to a staggered time below.
			if (next < now) {
				missed.push(state.store.jobs[i]!);
			}
		}

		// Stagger missed-job replays so a hundred catchups don't all fire on
		// the same tick. Capped at maxMissed; the others stay deferred to
		// their NEXT regular slot.
		const slice = missed.slice(0, maxMissed);
		for (let i = 0; i < slice.length; i++) {
			const job = slice[i]!;
			const idx = state.store.jobs.findIndex((j) => j.id === job.id);
			if (idx < 0) continue;
			const replayAt = now + i * stagger;
			state.store.jobs[idx] = {
				...state.store.jobs[idx]!,
				state: { ...state.store.jobs[idx]!.state, nextRunAtMs: replayAt },
			};
			mutated = true;
		}
		// Jobs past their slot beyond the cap: jump to their next NEW slot to
		// avoid them piling up on tick 1.
		for (let i = maxMissed; i < missed.length; i++) {
			const job = missed[i]!;
			const idx = state.store.jobs.findIndex((j) => j.id === job.id);
			if (idx < 0) continue;
			try {
				const skipAhead = computeJobNextRunAtMs(state.store.jobs[idx]!, now);
				state.store.jobs[idx] = {
					...state.store.jobs[idx]!,
					state: { ...state.store.jobs[idx]!.state, nextRunAtMs: skipAhead },
				};
				mutated = true;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				state.store.jobs[idx] = recordScheduleComputeError(state.store.jobs[idx]!, message);
				mutated = true;
			}
		}
		if (mutated) await persist(state);
	});
	// Use errorBackoffMs so the import doesn't go unused (some tests import it indirectly).
	void errorBackoffMs;
}
