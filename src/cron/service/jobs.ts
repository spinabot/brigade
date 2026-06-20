/**
 * Job-level math + invariants for the cron service.
 *
 * Three responsibilities:
 *
 *   1. **Construction** — `createJob` builds a `CronJob` from a
 *      `CronJobCreate` input (defaults filled by `normalize.ts`), assigns
 *      a UUID v4 id, stamps timestamps, computes the initial nextRunAtMs.
 *
 *   2. **Per-tick state hygiene** — `normalizeJobTickState` clears stale
 *      `runningAtMs` markers (> 2h means a crashed/killed prior run that
 *      never updated state), folds in the deterministic stagger offset,
 *      and applies error backoff to the next-fire time.
 *
 *   3. **Validation** — `assertSupportedJobSpec` enforces the pairing
 *      rules between `sessionTarget` and `payload.kind` (main↔systemEvent,
 *      isolated/session:*↔agentTurn). Throws on violation so the caller
 *      (CLI / RPC / agent tool) sees a clean refusal.
 *
 *   4. **Result application** — `applyJobResult` takes the outcome of an
 *      execution and updates the job's state: clears runningAtMs, stamps
 *      lastRunAtMs/lastStatus/lastError, recomputes nextRunAtMs (with
 *      backoff for transient errors, no-fire for permanent), increments
 *      the failure counter or clears it.
 */

import { randomUUID } from "node:crypto";

import { computeJobStaggerOffsetMs } from "../stagger.js";
import { computeNextRunAtMs, computePreviousRunAtMs } from "../schedule.js";
import {
	assertSafeCronSessionTargetId,
	extractSessionTargetId,
	isSessionTargetWithId,
} from "../session-target.js";
import type {
	CronJob,
	CronJobCreate,
	CronJobPatch,
	CronJobState,
	CronPayload,
	CronSchedule,
	CronSessionTarget,
} from "../types.js";

/** A run whose marker has been set this long is treated as crashed. */
export const STUCK_RUN_MS = 2 * 60 * 60 * 1000;

/** Per-failure backoff schedule. Index = consecutive error count - 1, capped at last. */
export const DEFAULT_ERROR_BACKOFF_SCHEDULE_MS: readonly number[] = [
	30_000,
	60_000,
	5 * 60_000,
	15 * 60_000,
	60 * 60_000,
];

/** Auto-disable a job after this many consecutive schedule-compute errors. */
export const MAX_SCHEDULE_ERRORS = 3;

/**
 * Cap consecutive failures on a `kind: "at"` (one-shot) job before auto-
 * disabling. A future-`at` job that hits a transient delivery error has no
 * "next schedule slot" to fall back to (`computeNextRunAtMs` returns
 * undefined for a past `at`), so without a cap the error-branch in
 * `applyJobResult` would keep stacking backoffs onto `result.endedAtMs`
 * and retry forever. After this many tries we treat the run as a permanent
 * failure and disable the job. Recurring (`every` / `cron`) jobs are
 * unaffected — they get the normal backoff schedule.
 */
export const MAX_AT_RETRIES = 3;

/** Result of one execution — fed into `applyJobResult`. */
export interface CronJobExecutionResult {
	status: "ok" | "error" | "skipped";
	startedAtMs: number;
	endedAtMs: number;
	error?: string;
	/** "permanent" → don't retry; "transient" → apply backoff. */
	errorKind?: "permanent" | "transient";
}

/**
 * Stamp a stable anchor on an `every` schedule so its fire grid survives
 * restarts and recomputes. Without a persisted anchor, `computeNextRunAtMs`
 * falls back to `anchorMs ?? nowMs` on EVERY call, so each restart's catchup
 * re-anchors the grid to "now" — an hourly reminder created at 5:29 keeps
 * sliding forward (6:33, 7:40, …) and never fires its promised slot. No-op
 * for non-`every` kinds and for `every` schedules with an explicit anchor.
 */
function stampEveryAnchor(schedule: CronSchedule, nowMs: number): CronSchedule {
	if (schedule.kind !== "every") return schedule;
	if (typeof schedule.anchorMs === "number") return schedule;
	return { ...schedule, anchorMs: nowMs };
}

/**
 * Build a fresh `CronJob` from a caller's (defaulted) input. Validates the
 * session-target safety + the supported-spec pairing rules — throws on
 * failure so the caller never persists a malformed job. UUID v4 ids.
 */
export function createJob(input: CronJobCreate, nowMs: number): CronJob {
	assertSupportedJobSpec({
		sessionTarget: input.sessionTarget,
		payload: input.payload,
	});
	assertScriptPayloadOwnerOnly(input.payload, input.createdBy);
	const id = randomUUID();
	const job: CronJob = {
		id,
		name: input.name,
		...(input.description !== undefined ? { description: input.description } : {}),
		enabled: input.enabled ?? true,
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
		schedule: stampEveryAnchor(input.schedule, nowMs),
		sessionTarget: input.sessionTarget,
		...(input.wakeMode !== undefined ? { wakeMode: input.wakeMode } : {}),
		payload: input.payload,
		...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
		...(input.failureAlert !== undefined ? { failureAlert: input.failureAlert } : {}),
		...(input.deleteAfterRun !== undefined ? { deleteAfterRun: input.deleteAfterRun } : {}),
		...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
		state: {},
	};
	job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
	return job;
}

/**
 * Apply a partial patch to an existing job. Schedule / payload / sessionTarget
 * changes go through `assertSupportedJobSpec` again. Returns the patched job
 * (caller persists). Mutates `updatedAtMs` + recomputes `nextRunAtMs` when
 * the schedule changed.
 */
export function applyJobPatch(
	job: CronJob,
	patch: CronJobPatch,
	nowMs: number,
): CronJob {
	const nextSessionTarget = patch.sessionTarget ?? job.sessionTarget;
	const nextPayload = patch.payload ?? job.payload;
	assertSupportedJobSpec({ sessionTarget: nextSessionTarget, payload: nextPayload });
	assertScriptPayloadOwnerOnly(nextPayload, patch.createdBy ?? job.createdBy);
	const scheduleChanged = patch.schedule !== undefined;
	const enabledChanged = patch.enabled !== undefined && patch.enabled !== job.enabled;
	const next: CronJob = {
		...job,
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
		...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
		...(patch.sessionKey !== undefined ? { sessionKey: patch.sessionKey } : {}),
		...(patch.schedule !== undefined ? { schedule: stampEveryAnchor(patch.schedule, nowMs) } : {}),
		sessionTarget: nextSessionTarget,
		...(patch.wakeMode !== undefined ? { wakeMode: patch.wakeMode } : {}),
		payload: nextPayload,
		...(patch.delivery !== undefined ? { delivery: patch.delivery } : {}),
		...(patch.failureAlert !== undefined ? { failureAlert: patch.failureAlert } : {}),
		...(patch.deleteAfterRun !== undefined ? { deleteAfterRun: patch.deleteAfterRun } : {}),
		updatedAtMs: nowMs,
	};
	if (scheduleChanged || enabledChanged) {
		next.state = {
			...next.state,
			nextRunAtMs: next.enabled ? computeJobNextRunAtMs(next, nowMs) : undefined,
			scheduleErrorCount: 0,
		};
	}
	return next;
}

/**
 * Compute the next-fire timestamp for a job. Adds the stagger offset to the
 * canonical fire-time. Returns `undefined` when the job is disabled OR the
 * schedule has no future fires (one-shot already past).
 *
 * Cursor-shift pattern lifted from the upstream reference (src/cron/service/jobs.ts:86-112):
 * the staggered branch uses a 4-attempt cursor-shift loop so a per-job
 * offset can never produce a `shifted` value that lies before `nowMs`
 * (the off-by-one stagger window). When the obvious "next base + offset"
 * lands in the past, we shift the cursor back by the offset, recompute the
 * next base from there, add the offset, and retry — up to 4 attempts
 * before giving up.
 */
export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
	if (!job.enabled) return undefined;
	const staggerMs =
		job.schedule.kind === "cron" ? job.schedule.staggerMs ?? 0 : 0;
	const offsetMs = staggerMs > 0 ? computeJobStaggerOffsetMs(job.id, staggerMs) : 0;
	if (offsetMs <= 0) {
		return computeNextRunAtMs(job.schedule, nowMs);
	}
	return computeStaggeredCronNextRunAtMs(job, nowMs, offsetMs);
}

/**
 * Cursor-shift loop for the staggered-cron next-fire path. Shifts the
 * schedule cursor backwards by the per-job offset so the CURRENT schedule
 * window's staggered slot is still reachable when it has not yet passed.
 * 4-attempt cap protects against pathological schedules that always
 * produce a past `shifted` (would be a bug in the cron expression, not
 * worth a hang).
 */
function computeStaggeredCronNextRunAtMs(
	job: CronJob,
	nowMs: number,
	offsetMs: number,
): number | undefined {
	let cursorMs = Math.max(0, nowMs - offsetMs);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const baseNext = computeNextRunAtMs(job.schedule, cursorMs);
		if (baseNext === undefined) return undefined;
		const shifted = baseNext + offsetMs;
		if (shifted > nowMs) return shifted;
		cursorMs = Math.max(cursorMs + 1, baseNext + 1_000);
	}
	return undefined;
}

/**
 * Companion to `computeJobNextRunAtMs` — the staggered version of
 * `computePreviousRunAtMs`. Used by catchup math to find the most-recent
 * scheduled slot whose `shifted` value is at-or-before `nowMs`. Same
 * 4-attempt cursor-shift pattern as the next-run helper for symmetry.
 */
export function computeJobPreviousRunAtMs(job: CronJob, nowMs: number): number | undefined {
	if (!job.enabled) return undefined;
	const staggerMs =
		job.schedule.kind === "cron" ? job.schedule.staggerMs ?? 0 : 0;
	const offsetMs = staggerMs > 0 ? computeJobStaggerOffsetMs(job.id, staggerMs) : 0;
	if (offsetMs <= 0) {
		return computePreviousRunAtMs(job.schedule, nowMs);
	}
	let cursorMs = Math.max(0, nowMs - offsetMs);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const basePrevious = computePreviousRunAtMs(job.schedule, cursorMs);
		if (basePrevious === undefined) return undefined;
		const shifted = basePrevious + offsetMs;
		if (shifted <= nowMs) return shifted;
		cursorMs = Math.max(0, basePrevious - 1_000);
	}
	return undefined;
}

/**
 * Per-tick maintenance. Idempotent.
 *
 * Two cleanups:
 *   1. Stale `runningAtMs` (> STUCK_RUN_MS) — clear, log not required here.
 *      The actual crashed run can't write its outcome, so the marker is the
 *      only evidence; clearing it lets the next tick fire the job again.
 *   2. Past-due `nextRunAtMs` on a stuck job — recompute from `now` so a
 *      job that was blocked on its own runningAtMs doesn't fire its entire
 *      backlog the moment we clear it.
 */
export function normalizeJobTickState(
	job: CronJob,
	nowMs: number,
): { job: CronJob; changed: boolean } {
	let changed = false;
	const next: CronJob = { ...job, state: { ...job.state } };
	// Anchor normalization (reference-codebase parity): an `every` job MUST carry a
	// stable anchor, or computeNextRunAtMs's `anchorMs ?? nowMs` fallback
	// re-anchors the fire grid to "now" on every recompute and drifts it
	// forward (the hourly-reminder bug). If the anchor is missing — a legacy
	// job, or one built outside createJob — stamp it from the job's CREATION
	// time, never `nowMs`. Mirrors the reference per-tick resolveEveryAnchorMs.
	if (next.schedule.kind === "every" && next.schedule.anchorMs === undefined) {
		const anchor = typeof next.createdAtMs === "number" ? next.createdAtMs : nowMs;
		next.schedule = { ...next.schedule, anchorMs: anchor };
		changed = true;
	}
	if (typeof next.state.runningAtMs === "number" && nowMs - next.state.runningAtMs > STUCK_RUN_MS) {
		delete next.state.runningAtMs;
		changed = true;
	}
	if (
		next.enabled &&
		(next.state.nextRunAtMs === undefined ||
			(next.state.nextRunAtMs < nowMs - STUCK_RUN_MS && next.state.runningAtMs === undefined))
	) {
		const recomputed = computeJobNextRunAtMs(next, nowMs);
		if (recomputed !== next.state.nextRunAtMs) {
			next.state.nextRunAtMs = recomputed;
			changed = true;
		}
	}
	return { job: next, changed };
}

/**
 * Apply an execution outcome. Mutates state in place on the returned copy.
 *   - status "ok"        → clear error counter, recompute next-fire normally
 *   - status "skipped"   → same as ok
 *   - status "error"     → increment counter; apply backoff to nextRunAtMs;
 *                          permanent errors disable the job
 *
 * Returns the patched job + a `delete` flag that callers (timer) honour for
 * one-shot `at` jobs with `deleteAfterRun: true` and `status: "ok"`.
 */
export function applyJobResult(
	job: CronJob,
	result: CronJobExecutionResult,
): { job: CronJob; deleteAfterApply: boolean } {
	const next: CronJob = { ...job, state: { ...job.state } };
	next.state.lastRunAtMs = result.startedAtMs;
	next.state.lastStatus = result.status;
	delete next.state.runningAtMs;

	if (result.status === "error") {
		next.state.lastError = result.error;
		const count = (next.state.consecutiveErrorCount ?? 0) + 1;
		next.state.consecutiveErrorCount = count;
		// One-shot `at` jobs have no future schedule slot to fall back to —
		// after `result.endedAtMs > schedule.at`, `computeJobNextRunAtMs`
		// returns undefined and the error branch otherwise keeps stacking
		// backoffs on top of `endedAtMs` forever (no auto-disable). Cap at
		// MAX_AT_RETRIES so a transient outage doesn't leave a one-shot
		// hammering the provider until an operator notices.
		if (next.schedule.kind === "at" && count >= MAX_AT_RETRIES) {
			next.enabled = false;
			next.state.nextRunAtMs = undefined;
			return { job: next, deleteAfterApply: false };
		}
		if (result.errorKind === "permanent") {
			next.enabled = false;
			next.state.nextRunAtMs = undefined;
		} else {
			const baseNext = computeJobNextRunAtMs(next, result.endedAtMs) ?? result.endedAtMs;
			const backoff = errorBackoffMs(count);
			next.state.nextRunAtMs = Math.max(baseNext, result.endedAtMs + backoff);
		}
		return { job: next, deleteAfterApply: false };
	}

	// success / skipped path
	delete next.state.lastError;
	next.state.consecutiveErrorCount = 0;
	delete next.state.lastFailureAlertAtMs;
	const isOneShot = next.schedule.kind === "at";
	if (isOneShot) {
		next.enabled = false;
		next.state.nextRunAtMs = undefined;
		const shouldDelete = next.deleteAfterRun === true && result.status === "ok";
		return { job: next, deleteAfterApply: shouldDelete };
	}
	next.state.nextRunAtMs = computeJobNextRunAtMs(next, result.endedAtMs);
	return { job: next, deleteAfterApply: false };
}

/**
 * Schedule-compute failed (croner threw, etc.). Increment the counter; if it
 * reaches MAX_SCHEDULE_ERRORS, auto-disable the job. The reason is preserved
 * in `lastError` so the operator can see it via `cron list`.
 */
export function recordScheduleComputeError(job: CronJob, message: string): CronJob {
	const next: CronJob = { ...job, state: { ...job.state } };
	const count = (next.state.scheduleErrorCount ?? 0) + 1;
	next.state.scheduleErrorCount = count;
	next.state.lastError = message;
	if (count >= MAX_SCHEDULE_ERRORS) {
		next.enabled = false;
		next.state.nextRunAtMs = undefined;
	}
	return next;
}

/**
 * Spec-pairing validation. Throws plain `Error` (caller decides whether to
 * wrap). Three rules:
 *   1. session-target "session:*" must have a safe id (no `/`, `\`, NUL, etc.).
 *   2. session-target "main" must pair with payload.kind "systemEvent".
 *   3. session-target "isolated" / "session:*" must pair with payload.kind
 *      "agentTurn" OR "script" (both run in an isolated/session context).
 */
export function assertSupportedJobSpec(args: {
	sessionTarget: CronSessionTarget;
	payload: CronPayload;
}): void {
	const { sessionTarget, payload } = args;
	if (isSessionTargetWithId(sessionTarget)) {
		assertSafeCronSessionTargetId(extractSessionTargetId(sessionTarget));
	}
	if (sessionTarget === "main" && payload.kind !== "systemEvent") {
		throw new Error('cron sessionTarget "main" requires payload.kind "systemEvent"');
	}
	// `"current"` is normally resolved to `"session:<id>"` or `"isolated"`
	// by `defaultCronJobCreate`, but assertSupportedJobSpec is also called
	// from `createJob` / `applyJobPatch` and any external paths that
	// bypass normalize. Defensive: still require an isolated-compatible payload.
	const isIsolatedLike =
		sessionTarget === "isolated" ||
		sessionTarget === "current" ||
		isSessionTargetWithId(sessionTarget);
	if (isIsolatedLike && payload.kind !== "agentTurn" && payload.kind !== "script") {
		throw new Error(
			'cron sessionTarget "isolated"/"current"/"session:*" requires payload.kind "agentTurn" or "script"',
		);
	}
}

/**
 * Shell-exec via cron is OWNER-ONLY. A channel-peer-created job must never carry
 * a `script` payload — that would be remote code execution as the gateway from a
 * messaging peer. Legacy jobs (createdBy undefined) are treated as owner. Enforced
 * at create + patch; the executor re-checks at run time (defense in depth).
 */
function assertScriptPayloadOwnerOnly(
	payload: CronPayload,
	createdBy: { kind: string } | undefined,
): void {
	if (payload.kind === "script" && createdBy !== undefined && createdBy.kind !== "owner") {
		throw new Error('cron payload.kind "script" is owner-only (a channel peer may not schedule shell execution)');
	}
}

/** Look up the backoff window for the Nth consecutive failure (1-indexed). */
export function errorBackoffMs(consecutiveErrorCount: number): number {
	if (consecutiveErrorCount <= 0) return 0;
	const idx = Math.min(consecutiveErrorCount - 1, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS.length - 1);
	return DEFAULT_ERROR_BACKOFF_SCHEDULE_MS[idx]!;
}

/** Initial state struct for a fresh job. */
export function freshJobState(): CronJobState {
	return {};
}
