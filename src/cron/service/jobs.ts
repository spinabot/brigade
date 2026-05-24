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
import { computeNextRunAtMs } from "../schedule.js";
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
 * Build a fresh `CronJob` from a caller's (defaulted) input. Validates the
 * session-target safety + the supported-spec pairing rules — throws on
 * failure so the caller never persists a malformed job. UUID v4 ids.
 */
export function createJob(input: CronJobCreate, nowMs: number): CronJob {
	assertSupportedJobSpec({
		sessionTarget: input.sessionTarget,
		payload: input.payload,
	});
	const id = randomUUID();
	const job: CronJob = {
		id,
		name: input.name,
		...(input.description !== undefined ? { description: input.description } : {}),
		enabled: input.enabled ?? true,
		...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
		...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
		schedule: input.schedule,
		sessionTarget: input.sessionTarget,
		...(input.wakeMode !== undefined ? { wakeMode: input.wakeMode } : {}),
		payload: input.payload,
		...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
		...(input.failureAlert !== undefined ? { failureAlert: input.failureAlert } : {}),
		...(input.deleteAfterRun !== undefined ? { deleteAfterRun: input.deleteAfterRun } : {}),
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
	const scheduleChanged = patch.schedule !== undefined;
	const enabledChanged = patch.enabled !== undefined && patch.enabled !== job.enabled;
	const next: CronJob = {
		...job,
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
		...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
		...(patch.sessionKey !== undefined ? { sessionKey: patch.sessionKey } : {}),
		...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
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
 */
export function computeJobNextRunAtMs(job: CronJob, nowMs: number): number | undefined {
	if (!job.enabled) return undefined;
	const base = computeNextRunAtMs(job.schedule, nowMs);
	if (base === undefined) return undefined;
	const staggerMs =
		job.schedule.kind === "cron" ? job.schedule.staggerMs ?? 0 : 0;
	if (staggerMs <= 0) return base;
	return base + computeJobStaggerOffsetMs(job.id, staggerMs);
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
 *   3. session-target "isolated" / "session:*" must pair with payload.kind "agentTurn".
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
	if (
		(sessionTarget === "isolated" || isSessionTargetWithId(sessionTarget)) &&
		payload.kind !== "agentTurn"
	) {
		throw new Error(
			'cron sessionTarget "isolated"/"session:*" requires payload.kind "agentTurn"',
		);
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
