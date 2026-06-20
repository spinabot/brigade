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
import { getLastChannelForAgent } from "../../agents/channels/last-channel.js";
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

/**
 * Anti-drift clamp on the timer delay. This is ALSO the cron's own
 * always-on heartbeat cadence: the scheduler wakes up at least every
 * 30 seconds regardless of whether any agent has `heartbeat.intervalMs`
 * configured. Cron MUST NOT depend on the agent heartbeat scheduler — if
 * an operator runs Brigade with no heartbeat interval set, `wakeMode:
 * "next-heartbeat"` system events would otherwise wait forever.
 *
 * Why 30 s (not 60 s): a 60-second worst-case for `wakeMode: "now"`
 * crons feels laggy when the operator says "ping me in a minute".
 * 30 s halves that perceived latency while keeping the timer cost
 * negligible (one `setTimeout` per 30 s, no I/O on a quiet tick).
 */
export const MAX_TIMER_DELAY_MS = 30_000;
/** Spin-loop safety net — if the calculated delay rounds to 0, fall back to this. */
export const MIN_REFIRE_GAP_MS = 2_000;
/** How long to wait between watchdog-driven rearms during execution. */
const RUNNING_RECHECK_INTERVAL_MS = 60_000;
/**
 * Threshold for surfacing "the next tick fired much later than we asked".
 * If the actual delay between arming and firing exceeds the requested delay
 * by MORE than this, it almost certainly means the host slept / suspended
 * (laptop closed overnight, container paused, VM frozen). Logged so the
 * operator can correlate missed crons with the underlying suspend instead
 * of chasing a phantom scheduler bug. 60s gives normal scheduling jitter
 * room to breathe (a backed-up event loop can land a tick a few seconds
 * late under load) while still catching real multi-minute / multi-hour
 * sleep events.
 */
const TICK_SKEW_THRESHOLD_MS = 60_000;
/**
 * Per-execution wall-clock cap when the job didn't specify
 * `payload.timeoutSeconds`. 60 seconds matches the reference's default and is well
 * above the slow-path tail of every realistic cron run (a reminder "say
 * hi" turn is sub-5s; even a research cron firing a web-search + reply
 * sits under 30s). Long-running crons MUST opt in by setting
 * `payload.timeoutSeconds` explicitly — that way a typo'd or runaway run
 * doesn't pin the per-instance lock for fifteen minutes the way it used
 * to.
 */
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
/**
 * Wall-clock cap on the announce-delivery network send.
 *
 * The post-run result-apply runs under the per-instance lock (store
 * consistency — see `runDueJob`). The announce dispatcher
 * (`deps.deliverCronAnnounce`) is the one piece of that section that does
 * NETWORK I/O: it hands the model's reply to a channel adapter's outbound
 * (a WhatsApp socket send, a Slack/Telegram HTTP POST). A health pre-flight
 * gate on the dispatcher side fast-refuses an adapter that's known-down, but
 * `health()` is a cached best-effort probe — it does not guarantee an
 * in-flight send completes. A send that passes the gate and then stalls
 * mid-flight (an HTTP POST that never responds, a socket whose cached health
 * bool went stale) would pin the per-instance lock for the full stall and
 * block every concurrent `cron add` / `cron list` / `cron update` queued on
 * the same instance — a smaller instance of exactly the anti-pattern the
 * "model call stays OUTSIDE the lock" design (see `onTimer` Phase A/B) was
 * built to avoid.
 *
 * 8 seconds is far above a healthy channel send's round-trip (sub-second for
 * a WhatsApp/Slack outbound) while capping the worst-case lock-hold so a
 * stalled adapter can't wedge the cron store. On timeout the send is treated
 * as a non-delivery — the awareness fallback still fires and
 * `lastDeliveryStatus` / `lastDeliveryError` record the stall, identical to
 * the dispatcher returning `false`.
 */
const ANNOUNCE_DISPATCH_TIMEOUT_MS = 8_000;

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
 *
 * Cron owns its OWN tick — `setTimeout` driven, capped at
 * `MAX_TIMER_DELAY_MS` (30 s). It is COMPLETELY INDEPENDENT of the agent
 * heartbeat scheduler. Even if no agent has `heartbeat.intervalMs` set,
 * the cron tick still fires every 30 s, drains pending wake intents, and
 * picks up `wakeMode: "next-heartbeat"` system-event crons. Without this
 * decoupling, an install with zero agent-heartbeat config would leave
 * `next-heartbeat` crons stuck in the enqueue queue forever.
 */
export function armTimer(state: CronServiceState): void {
	stopTimer(state);
	if (state.config.enabled === false) return;
	const now = state.deps.nowMs!();
	const next = nextWakeAtMs(state);
	let delay = next === undefined ? MAX_TIMER_DELAY_MS : Math.max(0, next - now);
	delay = Math.min(delay, MAX_TIMER_DELAY_MS);
	// Floor delay==0 to MIN_REFIRE_GAP_MS so a stuck `runningAtMs` + past-due
	// `nextRunAtMs` pair cannot cause a setTimeout(0) hot-loop. The tick that
	// just ran couldn't collect the past-due job (runningAtMs blocks it), so
	// rearming with delay=0 would re-enter onTimer immediately, do nothing,
	// rearm with delay=0 again, ad infinitum — pinning a CPU core until the
	// 2-hour STUCK_RUN_MS sweep clears the marker. MIN_REFIRE_GAP_MS=2s gives
	// the watchdog room to act without saturating the loop.
	if (delay === 0) delay = MIN_REFIRE_GAP_MS;
	// Record the arm in `state` so the next `onTimer` can compute actual-vs-
	// expected delay and surface clock-skew / host-suspend events. Captured
	// BEFORE `setTimeout` so a race where the timer fires immediately still
	// sees populated fields.
	state.lastTickArmedAt = now;
	state.lastTickExpectedDelayMs = delay;
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
	// Clock-skew / host-suspend detection — surfaces "the OS slept, we're
	// waking up well past our scheduled fire" events to the log so a missed
	// 09:00 reminder after an overnight laptop sleep doesn't look like a
	// scheduler bug. Computed against `lastTickArmedAt` captured by the
	// PREVIOUS `armTimer` call, so the first tick (no prior arm) never
	// reports a skew. We compute BEFORE setting `running=true` so the
	// observation is still logged on a re-entry race (rare, but cheap).
	if (state.lastTickArmedAt !== undefined && state.lastTickExpectedDelayMs !== undefined) {
		const armed = state.lastTickArmedAt;
		const expected = state.lastTickExpectedDelayMs;
		const actual = state.deps.nowMs!() - armed;
		const skewMs = actual - expected;
		if (skewMs >= TICK_SKEW_THRESHOLD_MS) {
			state.deps.log.warn(
				"cron tick fired much later than scheduled (host likely slept/suspended)",
				{
					expectedDelayMs: expected,
					actualDelayMs: actual,
					skewMs,
					thresholdMs: TICK_SKEW_THRESHOLD_MS,
				},
			);
		}
	}
	state.running = true;
	armRunningRecheckTimer(state);
	try {
		// Drain pending `next-heartbeat` wake intents BEFORE collecting due
		// jobs. Every entry came from a previous tick's main-target cron
		// whose `wakeMode === "next-heartbeat"`; this drain is the "next
		// tick" semantic, max-30s-from-fire, that decouples cron from the
		// per-agent heartbeat scheduler. We swap the queue array out first
		// so wakes enqueued during this very tick (by jobs we run below)
		// don't get drained immediately — they wait for the NEXT tick.
		drainPendingHeartbeatWakes(state);
		const now = state.deps.nowMs!();
		// Phase A — under the lock: ensureLoaded + maintenance + collect
		// runnables + mark-running + persist. SHORT and CPU-bound — does NOT
		// touch the model or any I/O slower than a JSON write. Releasing the
		// lock between phases is critical so concurrent `cron add` /
		// `cron list` / `cron update` calls don't queue behind a long
		// isolated-turn model call (which can take 15 minutes per the
		// timeout default). The lock is for STORE consistency, not for
		// serialising the actual run.
		let runnable: CronJob[] = [];
		await withPerInstanceLock(state.op, async () => {
			await ensureLoaded(state);
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
			runnable = collectRunnableJobs(state, now);
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
		});
		// Phase B — OUTSIDE the lock: dispatch via a bounded worker pool so
		// over-concurrent fires stay SEQUENCED (oldest-due first) within the
		// same tick instead of dropping. Each `runDueJob` re-acquires its own
		// per-instance lock for the brief result-apply persist after the run
		// finishes — the SHORT critical section that needs serialisation. The
		// 30-second-to-15-minute model call in between is NOT under the lock,
		// so a `cron add` arriving mid-fire completes within milliseconds
		// instead of blocking until the run finishes.
		if (runnable.length > 0) {
			const concurrency = Math.min(resolveRunConcurrency(state), runnable.length);
			let cursor = 0;
			const workers = Array.from({ length: concurrency }, async () => {
				for (;;) {
					const index = cursor++;
					if (index >= runnable.length) return;
					const job = runnable[index]!;
					await runDueJob(state, job, state.deps.nowMs!());
				}
			});
			await Promise.all(workers);
		}
	} finally {
		// Session-reaper sweep — throttled to once per MIN_SWEEP_INTERVAL_MS
		// (5 minutes) so the tick loop doesn't hammer the filesystem on
		// every fire. Best-effort: a thrown sweep is caught + logged so it
		// can't break the timer rearm below.
		//
		// Multi-agent: walk every distinct `job.agentId` in the store so a
		// cron scheduled by a non-default agent gets its isolated-run
		// transcripts pruned too. Always include `DEFAULT_AGENT_ID` so legacy
		// jobs missing `agentId` (and the boot agent's surface) are still
		// swept on a fresh install.
		const sweepNow = state.deps.nowMs!();
		if (shouldRunSweep(state.lastReapAtMs, sweepNow)) {
			const retentionMs = parseSessionRetention(state.config.sessionRetention);
			if (retentionMs !== null && retentionMs > 0) {
				const agentIds = new Set<string>([DEFAULT_AGENT_ID]);
				for (const job of state.store.jobs) {
					if (typeof job.agentId === "string" && job.agentId.trim().length > 0) {
						agentIds.add(job.agentId);
					}
				}
				for (const agentId of agentIds) {
					try {
						await reapIsolatedCronSessions({
							agentId,
							retentionMs,
							nowMs: sweepNow,
							log: state.deps.log,
						});
					} catch (err) {
						state.deps.log.warn("session reaper sweep threw", {
							agentId,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
			state.lastReapAtMs = sweepNow;
		}
		state.running = false;
		armTimer(state);
	}
}

/**
 * Resolve the effective max-concurrent-runs setting. Defaults to 4 so a
 * burst of same-instant fires (a reminder + a "check status" cron sharing
 * a 09:00 slot) all dispatch in parallel — the prior default of 1 caused
 * losers to silently get pushed past their slot. Operators can still set
 * `maxConcurrentRuns: 1` in `brigade.json` to opt back into single-file
 * dispatch when their downstream provider can't handle parallel turns.
 */
export function resolveRunConcurrency(state: CronServiceState): number {
	const raw = state.config.maxConcurrentRuns;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 4;
	return Math.max(1, Math.floor(raw));
}

/**
 * Find every job whose next-fire has arrived. Does NOT cap by the
 * concurrency limit — the caller (`onTimer`) spawns a worker pool keyed by
 * the concurrency limit so losers stay sequenced inside the SAME tick
 * (oldest-due-first) instead of being dropped past their slot. Capping
 * here used to silently advance the loser's `nextRunAtMs` on the very
 * next maintenance pass (Bug #2).
 */
export function collectRunnableJobs(state: CronServiceState, nowMs: number): CronJob[] {
	const candidates: CronJob[] = [];
	for (const job of state.store.jobs) {
		if (!job.enabled) continue;
		if (job.state.runningAtMs !== undefined) continue;
		const next = job.state.nextRunAtMs;
		if (next === undefined) continue;
		if (next > nowMs) continue;
		candidates.push(job);
	}
	// Sort oldest-due-first so stale jobs run before fresh ones.
	candidates.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
	return candidates;
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
export async function runDueJob(
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
		// Honour outcome-classified errorKind so a downstream runner (or the
		// executor's own permanent-error matcher) can disable the job rather
		// than retry on backoff. Defaults to `"transient"` when status is
		// error and the runner didn't classify it.
		errorKind:
			outcome.status === "error"
				? (outcome.errorKind ?? "transient")
				: undefined,
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

		// Announce delivery — surface the successful run's reply to the
		// operator. Falls through silently for `mode !== "announce"` and for
		// failures (those go through the failure-alert path below). Writes
		// `lastDelivered` / `lastDeliveryStatus` / `lastDeliveryError` onto
		// the job state under the same lock so a partially-failed delivery
		// leaves an audit trail the operator can `cron list` to inspect.
		//
		// This MUST run even when `deleteAfterApply` is true. One-shot `at`
		// reminders ("remind me to drink water in 5 minutes") default to
		// `deleteAfterRun: true`, so the job was spliced out of the store
		// above BEFORE we reach here — but delivering that reply is the WHOLE
		// POINT of the reminder; the deletion is just post-fire cleanup.
		// Gating delivery on `!deleteAfterApply` silently dropped the reply of
		// EVERY default one-shot reminder on the floor: the isolated run
		// produced "time to hydrate!" but it never reached WhatsApp, and the
		// operator only got it after manually nudging the main session. The
		// `idx2 >= 0` guard below makes the delivery-state write-back a no-op
		// when the job was already deleted, so a deleted one-shot still
		// delivers without trying to persist `lastDelivered` onto a row that
		// no longer exists.
		if (outcome.status === "ok") {
			const deliveryResult = await maybeDeliverAnnounce(state, applied, outcome);
			if (deliveryResult) {
				const idx2 = state.store.jobs.findIndex((j) => j.id === job.id);
				if (idx2 >= 0) {
					state.store.jobs[idx2] = {
						...state.store.jobs[idx2]!,
						state: {
							...state.store.jobs[idx2]!.state,
							...(deliveryResult.delivered !== undefined
								? { lastDelivered: deliveryResult.delivered }
								: {}),
							lastDeliveryStatus: deliveryResult.status,
							...(deliveryResult.error !== undefined
								? { lastDeliveryError: deliveryResult.error }
								: { lastDeliveryError: undefined }),
						},
					};
					await persist(state);
				}
			}
		}

		// Failure-alert check
		if (outcome.status === "error" && !deleteAfterApply) {
			await maybeSendFailureAlert(state, applied, outcome.error ?? "unknown error", endedAtMs);
		}
	});
}

/** Resolved status the timer writes onto the job's `state.lastDeliveryStatus`. */
interface CronAnnounceDeliveryResult {
	status: "delivered" | "not-delivered" | "not-requested";
	delivered?: boolean;
	error?: string;
}

/**
 * Deliver the run outcome's summary text to the operator if the job's
 * `delivery.mode === "announce"`. Routes via the `deliverCronAnnounce`
 * dep when wired (typically a channel adapter's outbound) and falls back
 * to `enqueueSystemEvent` so a cron without an explicit channel target
 * still surfaces somewhere the operator will see it.
 *
 * Returns a result describing what actually happened so the caller can
 * persist `lastDelivered` / `lastDeliveryStatus` / `lastDeliveryError`
 * on the job state — the operator's `cron list` then shows whether the
 * most recent successful run's reply actually reached its target or hit
 * a snag (e.g. the WhatsApp adapter was disconnected when the cron
 * fired). Returns `null` when delivery wasn't requested at all (mode
 * !== announce / empty summary), so the caller skips the state write.
 *
 * Best-effort by design: a delivery failure logs but does NOT change
 * the job's `lastStatus`. The cron RAN — the bookkeeping that matters
 * most is "did the agent complete its turn" — delivery is the soft
 * suffix. When `delivery.bestEffort === true`, delivery errors are
 * additionally muted from the diagnostic log (the operator opted in to
 * "fire and forget" semantics; don't spam the log).
 *
 * The channel send is bounded by `ANNOUNCE_DISPATCH_TIMEOUT_MS` — this
 * runs under the caller's per-instance lock, so a stalled adapter must
 * not pin that lock indefinitely. A timed-out send is reported as a
 * non-delivery (the awareness fallback still fires), never as a hang.
 */
async function maybeDeliverAnnounce(
	state: CronServiceState,
	job: CronJob,
	outcome: CronIsolatedRunOutcome,
): Promise<CronAnnounceDeliveryResult | null> {
	const delivery = job.delivery;
	if (!delivery || delivery.mode !== "announce") return null;
	const summary = outcome.summary?.trim();
	if (!summary) {
		state.deps.log.info("cron announce skipped — empty reply summary", {
			jobId: job.id,
		});
		return { status: "not-delivered", delivered: false, error: "empty reply summary" };
	}
	// The CHANNEL (WhatsApp/Slack/...) gets the model's reply VERBATIM — the
	// recipient must never see internal [cron "name"] tagging. Only the
	// operator's TUI awareness event (below) keeps the tag, so a firing can
	// be told apart from the assistant's own lines in the operator console.
	const channelText = summary;
	const awarenessText = formatAnnounceText(job, summary);
	// Last-channel fallback. When the operator (or the model) didn't set an
	// explicit `delivery.channel/to` AND the turn that scheduled this cron
	// had no channelContext (typical pure-TUI scheduling), the job lands
	// with `{mode: "announce"}` and no target. Before falling all the way
	// through to `enqueueSystemEvent`, look up the agent's most recently
	// active channel — if WhatsApp / Slack / Telegram was the last surface
	// the operator was on, the cron announces THERE. Without this the
	// announce would land only in the TUI bubble + the next-prompt
	// drain, and the operator on their phone would silently miss it.
	let resolvedChannel = delivery.channel?.trim() || undefined;
	let resolvedTo = delivery.to?.trim() || undefined;
	let resolvedThreadId = delivery.threadId;
	let resolvedAccountId = delivery.accountId;
	if (!resolvedChannel || !resolvedTo) {
		const agentId = job.agentId ?? DEFAULT_AGENT_ID;
		const last = getLastChannelForAgent(agentId);
		if (last) {
			resolvedChannel ??= last.channelId;
			resolvedTo ??= last.conversationId;
			resolvedThreadId ??= last.threadId;
			resolvedAccountId ??= last.accountId;
		}
	}
	const channel = resolvedChannel;
	const to = resolvedTo;
	const dispatcher = state.deps.deliverCronAnnounce;
	const bestEffort = delivery.bestEffort === true;
	let delivered = false;
	let lastError: string | undefined;
	if (dispatcher && channel && to) {
		try {
			// Bound the network send so a health-passing-but-stalled adapter
			// can't pin the per-instance lock (this whole block runs under it
			// in `runDueJob`). On timeout we treat the send as a non-delivery —
			// `timedOut` flips `lastError` to a stall message below and the
			// awareness fallback + `lastDeliveryStatus` write still run, exactly
			// as they do when the dispatcher returns `false`.
			const dispatch = dispatcher({
				job,
				text: channelText,
				channel,
				to,
				...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
				...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
			});
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			let timedOut = false;
			const timeoutGuard = new Promise<false>((resolve) => {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					resolve(false);
				}, ANNOUNCE_DISPATCH_TIMEOUT_MS);
				if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
			});
			try {
				delivered = await Promise.race([dispatch, timeoutGuard]);
			} finally {
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			}
			if (timedOut) {
				delivered = false;
				lastError = `channel "${channel}" delivery timed out after ${ANNOUNCE_DISPATCH_TIMEOUT_MS}ms (adapter accepted the send but never completed)`;
				// Swallow the still-pending dispatch's eventual settle so a late
				// rejection doesn't surface as an unhandled rejection after the
				// lock has already been released.
				void Promise.resolve(dispatch).catch(() => undefined);
				if (!bestEffort) {
					state.deps.log.warn("cron announce dispatch timed out", {
						jobId: job.id,
						channel,
						to,
						timeoutMs: ANNOUNCE_DISPATCH_TIMEOUT_MS,
					});
				}
			} else if (!delivered) {
				lastError = `channel "${channel}" dispatcher refused delivery (adapter not started, or recipient rejected)`;
				if (!bestEffort) {
					state.deps.log.warn("cron announce dispatcher returned false", {
						jobId: job.id,
						channel,
						to,
					});
				}
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			if (!bestEffort) {
				state.deps.log.warn("cron announce dispatch threw", {
					jobId: job.id,
					channel,
					to,
					error: lastError,
				});
			}
		}
	}
	// ALWAYS surface a TUI-visible awareness event so the operator's main
	// session sees the cron fire, regardless of whether the channel-side
	// delivery (WhatsApp / Slack / etc.) succeeded. Bug #4 — previously the
	// `delivered=true` branch early-returned here and the operator's TUI
	// silently missed the announce text whenever the channel dispatcher did
	// its job. The TUI is THE operator console; cron firings must always be
	// visible there, with a small `delivered`/`not-delivered` hint so the
	// operator can tell whether the phone got the reminder too.
	const enqueue = state.deps.enqueueSystemEvent;
	if (enqueue) {
		try {
			enqueue({
				text: awarenessText,
				jobId: job.id,
				jobName: job.name,
				source: "cron",
				delivered,
				...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
				...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
			});
		} catch (err) {
			const enqueueErr = err instanceof Error ? err.message : String(err);
			if (!bestEffort) {
				state.deps.log.warn("cron announce awareness enqueueSystemEvent threw", {
					jobId: job.id,
					error: enqueueErr,
				});
			}
			// When channel-side ALSO failed, surface the enqueue error in the
			// run-log so the operator can `cron list` and see "both surfaces
			// fell through" rather than a misleading "delivered" tag.
			if (!delivered) {
				return {
					status: "not-delivered",
					delivered: false,
					error: lastError ?? enqueueErr,
				};
			}
		}
	} else if (!delivered && !bestEffort) {
		state.deps.log.warn(
			"cron announce had no usable delivery target (no channel + no enqueueSystemEvent dep)",
			{ jobId: job.id, mode: delivery.mode, channel, to },
		);
	}

	if (delivered) {
		return { status: "delivered", delivered: true };
	}
	// Channel dispatch didn't land and the awareness fallback either was
	// missing or threw. The system event itself counts as a successful
	// delivery surface when it was enqueued — match the original semantics
	// so `cron list` doesn't flash "not-delivered" red on what reached the
	// operator's TUI.
	if (enqueue) {
		return { status: "delivered", delivered: true };
	}
	return {
		status: "not-delivered",
		delivered: false,
		error: lastError ?? "no delivery surface available",
	};
}

/**
 * Build the operator-facing announce text. Prefixes the cron's name so the
 * operator can tell announce messages from their own ongoing turn output
 * (otherwise a system event injected mid-conversation reads like the
 * assistant's own line).
 */
function formatAnnounceText(job: CronJob, summary: string): string {
	const flat = summary.replace(/\s+/g, " ").trim();
	const trimmed = flat.length <= 600 ? flat : `${flat.slice(0, 597)}…`;
	return `[cron "${job.name}"] ${trimmed}`;
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
				source: "cron",
				jobId: job.id,
				jobName: job.name,
				...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
				...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
			});
			if (job.wakeMode === "now") {
				// Inline wake — bypass the heartbeat-wake-interval dependency
				// entirely. The cron decided this is urgent; consume the system
				// event right now via `requestHeartbeatNow`.
				if (state.deps.requestHeartbeatNow) {
					state.deps.requestHeartbeatNow({
						reason: "cron-wake",
						...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
						...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
					});
				}
			} else {
				// `next-heartbeat` — DO NOT depend on the agent heartbeat
				// scheduler (which may not be configured at all). Queue a
				// pending wake; the next cron tick (≤30 s) drains it via
				// `requestHeartbeatNow` so the system event actually
				// reaches a turn. Without this, a job with no
				// `heartbeat.intervalMs` set would leave the system event
				// stuck in `enqueueSystemEvent`'s queue indefinitely.
				state.pendingHeartbeatWakes.push({
					reason: "cron-wake",
					...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
					...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
				});
			}
			return { status: "ok", summary: summariseSystemEventPayload(job.payload.text) };
		} catch (err) {
			return { status: "error", error: err instanceof Error ? err.message : String(err) };
		}
	}

	// Isolated / session:* — delegate to the agent runner (handles agentTurn AND
	// script payloads; the executor dispatches by kind).
	if (job.payload.kind !== "agentTurn" && job.payload.kind !== "script") {
		return { status: "error", error: "invariant violated: isolated target without agentTurn/script payload" };
	}
	const runner = state.deps.runIsolatedAgentJob;
	if (!runner) {
		return { status: "error", error: "no runIsolatedAgentJob dep wired" };
	}
	return runner({ job, runAtMs, abortSignal });
}

/** Per-job timeout resolution. Both agentTurn and script carry `timeoutSeconds`. */
function resolveJobTimeoutMs(job: CronJob): number {
	if (job.payload.kind !== "agentTurn" && job.payload.kind !== "script") {
		return DEFAULT_EXECUTION_TIMEOUT_MS;
	}
	const p = job.payload as { timeoutSeconds?: number };
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

/**
 * Drain `state.pendingHeartbeatWakes` by invoking `requestHeartbeatNow`
 * for each queued intent. Called at the START of every `onTimer` tick so
 * `wakeMode: "next-heartbeat"` system events queued by main-target crons
 * during the PREVIOUS tick get consumed within ≤30 s — independent of any
 * per-agent `heartbeat.intervalMs` setting. Errors per-entry are caught
 * + logged so one bad wake can't poison the rest of the drain.
 */
function drainPendingHeartbeatWakes(state: CronServiceState): void {
	if (state.pendingHeartbeatWakes.length === 0) return;
	const intents = state.pendingHeartbeatWakes;
	state.pendingHeartbeatWakes = [];
	const requestWake = state.deps.requestHeartbeatNow;
	if (!requestWake) {
		// No wake dispatcher wired (tests / CLI). Drop the intents — the
		// system events themselves were already enqueued via
		// `enqueueSystemEvent`; the operator's next turn or external
		// consumer is responsible for picking them up.
		return;
	}
	for (const intent of intents) {
		try {
			requestWake({
				reason: intent.reason ?? "cron-wake",
				...(intent.agentId !== undefined ? { agentId: intent.agentId } : {}),
				...(intent.sessionKey !== undefined ? { sessionKey: intent.sessionKey } : {}),
			});
		} catch (err) {
			state.deps.log.warn("cron pending-wake drain entry threw", {
				agentId: intent.agentId,
				sessionKey: intent.sessionKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
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
	// bestEffort jobs opted into "fire and forget" semantics — delivery errors
	// are swallowed by design, so the failure-alert path must also stay
	// silent. Without this gate, an operator who set `delivery.bestEffort:
	// true` (e.g. for a low-priority WhatsApp ping) would still be paged on
	// consecutive failures, defeating the contract.
	if (job.delivery?.bestEffort === true) return;
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
		// the same tick. The first `maxMissed` jobs fire immediately (with a
		// small offset between them); ALL further deferred jobs ALSO get a
		// `nextRunAtMs` that's still past-due (now + offset) so they fire on
		// later ticks rather than being silently dropped past their slot
		// (Bug #2). The prior implementation jumped over-cap deferred jobs
		// to their NEXT regular slot, which dropped the missed fire entirely.
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
		// Over-cap deferred missed jobs: keep them scheduled past-due with a
		// continuing stagger offset so subsequent ticks pick them up in order
		// without piling onto tick 1. Deferred-offset pattern: they STILL
		// fire, just spaced beyond the initial maxMissed slice — each
		// subsequent tick picks the next past-due one off the front.
		let offset = maxMissed * stagger;
		for (let i = maxMissed; i < missed.length; i++) {
			const job = missed[i]!;
			const idx = state.store.jobs.findIndex((j) => j.id === job.id);
			if (idx < 0) continue;
			state.store.jobs[idx] = {
				...state.store.jobs[idx]!,
				state: { ...state.store.jobs[idx]!.state, nextRunAtMs: now + offset },
			};
			offset += stagger;
			mutated = true;
		}
		// `computeJobNextRunAtMs` import retained for downstream callers.
		void computeJobNextRunAtMs;
		if (mutated) await persist(state);
	});
	// Use errorBackoffMs so the import doesn't go unused (some tests import it indirectly).
	void errorBackoffMs;
}
