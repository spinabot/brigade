/**
 * Public API for the Brigade cron service.
 *
 * Everything CLI commands, the agent-callable `cron` tool, and gateway RPC
 * handlers depend on goes through this file. Each public function:
 *   - Holds the per-instance lock (`withPerInstanceLock`) for any mutation.
 *   - Reloads the store from disk before deciding what to write, so a
 *     concurrent edit by another process can't be silently clobbered.
 *   - Emits a lifecycle event (added/updated/removed) on changes.
 *   - Persists synchronously inside the lock, so callers can rely on the
 *     write being durable before the function resolves.
 *
 * Two execution modes:
 *   - `run(state, id, mode)` — INLINE execution, returns the outcome.
 *   - `enqueueRun(state, id, mode)` — QUEUED for the next tick; returns
 *     immediately. Useful when the caller doesn't want to block (RPC
 *     handlers, the agent tool).
 */

import { withPerInstanceLock } from "./locked.js";
import { ensureLoaded, persist } from "./store.js";
import {
	applyJobPatch,
	createJob,
	computeJobNextRunAtMs,
} from "./jobs.js";
import { defaultCronJobCreate } from "../normalize.js";
import { armTimer, onTimer, planStartupCatchup, stopTimer } from "./timer.js";
import { readCronRunLogEntries, type ReadCronRunLogOpts } from "../run-log.js";
import type {
	CronEvent,
	CronJob,
	CronJobCreate,
	CronJobPatch,
	CronRunLogEntry,
	CronWakeMode,
} from "../types.js";
import type { CronServiceState } from "./state.js";

/** Boot the scheduler — load store, replay missed runs (bounded), arm timer. */
export async function start(state: CronServiceState): Promise<void> {
	await planStartupCatchup(state);
	armTimer(state);
}

/** Disarm the timer. In-flight jobs continue to completion. */
export function stop(state: CronServiceState): void {
	stopTimer(state);
}

/** Read-only diagnostic snapshot. */
export interface CronServiceStatus {
	enabled: boolean;
	storePath: string;
	jobCount: number;
	enabledJobCount: number;
	runningJobCount: number;
	nextWakeAtMs: number | undefined;
}

export async function status(state: CronServiceState): Promise<CronServiceStatus> {
	return withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		let enabledCount = 0;
		let runningCount = 0;
		let earliest: number | undefined;
		for (const job of state.store.jobs) {
			if (job.enabled) enabledCount++;
			if (job.state.runningAtMs !== undefined) runningCount++;
			const next = job.state.nextRunAtMs;
			if (next !== undefined && (earliest === undefined || next < earliest)) {
				earliest = next;
			}
		}
		return {
			enabled: state.config.enabled !== false,
			storePath: state.storePath,
			jobCount: state.store.jobs.length,
			enabledJobCount: enabledCount,
			runningJobCount: runningCount,
			...(earliest !== undefined ? { nextWakeAtMs: earliest } : { nextWakeAtMs: undefined }),
		};
	});
}

export interface ListJobsOpts {
	includeDisabled?: boolean;
}

/** Simple list. For pagination/filtering use `listPage`. */
export async function list(
	state: CronServiceState,
	opts: ListJobsOpts = {},
): Promise<CronJob[]> {
	return withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const includeDisabled = opts.includeDisabled === true;
		const filtered = state.store.jobs.filter((j) => includeDisabled || j.enabled);
		return [...filtered].sort(
			(a, b) => (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity),
		);
	});
}

export interface ListPageOpts {
	limit?: number;
	offset?: number;
	query?: string;
	enabled?: "all" | "enabled" | "disabled";
	sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
	sortDir?: "asc" | "desc";
}

export interface ListPageResult {
	jobs: CronJob[];
	total: number;
	offset: number;
	limit: number;
	hasMore: boolean;
}

/** Paginated + filtered + sorted list. */
export async function listPage(
	state: CronServiceState,
	opts: ListPageOpts = {},
): Promise<ListPageResult> {
	return withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
		const offset = Math.max(0, opts.offset ?? 0);
		const enabledFilter = opts.enabled ?? "all";
		const queryLower = opts.query?.toLowerCase() ?? "";
		const sortBy = opts.sortBy ?? "nextRunAtMs";
		const sortDir = opts.sortDir ?? "asc";

		const filtered = state.store.jobs.filter((job) => {
			if (enabledFilter === "enabled" && !job.enabled) return false;
			if (enabledFilter === "disabled" && job.enabled) return false;
			if (queryLower.length === 0) return true;
			return (
				job.name.toLowerCase().includes(queryLower) ||
				(job.description ?? "").toLowerCase().includes(queryLower) ||
				(job.agentId ?? "").toLowerCase().includes(queryLower) ||
				job.id.toLowerCase().includes(queryLower)
			);
		});

		filtered.sort((a, b) => {
			let cmp = 0;
			switch (sortBy) {
				case "name":
					cmp = a.name.localeCompare(b.name);
					break;
				case "updatedAtMs":
					cmp = a.updatedAtMs - b.updatedAtMs;
					break;
				default:
					cmp = (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity);
			}
			return sortDir === "desc" ? -cmp : cmp;
		});

		const total = filtered.length;
		const page = filtered.slice(offset, offset + limit);
		return {
			jobs: page,
			total,
			offset,
			limit,
			hasMore: offset + page.length < total,
		};
	});
}

/** Fetch one job by id. Throws if not found. */
export async function getJob(state: CronServiceState, jobId: string): Promise<CronJob> {
	return withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const job = state.store.jobs.find((j) => j.id === jobId);
		if (!job) throw new Error(`cron job not found: ${jobId}`);
		return job;
	});
}

/** Create + persist + rearm timer. Returns the created job (with id). */
export async function add(
	state: CronServiceState,
	input: CronJobCreate,
): Promise<CronJob> {
	const defaulted = defaultCronJobCreate(input);
	// Channel-target validation. When the operator (or the model on their
	// behalf) sets `delivery.channel`, refuse the add if that channel id
	// doesn't match a started adapter — typos like "whatapp" / "slak" would
	// otherwise silently persist and fail every fire. Skipped when the
	// channel registry isn't wired (tests / standalone CLI) so unit tests
	// don't need to mock a manager just to add a cron.
	assertDeliveryChannelIsKnown(state, defaulted.delivery);
	const created = await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const now = state.deps.nowMs!();
		const job = createJob(defaulted, now);
		state.store.jobs.push(job);
		await persist(state);
		const evt: CronEvent = {
			action: "added",
			jobId: job.id,
			...(job.state.nextRunAtMs !== undefined
				? { nextRunAtMs: job.state.nextRunAtMs }
				: {}),
		};
		emit(state, evt);
		return job;
	});
	armTimer(state);
	return created;
}

/** Patch + persist + rearm. Returns the updated job. */
export async function update(
	state: CronServiceState,
	jobId: string,
	patch: CronJobPatch,
): Promise<CronJob> {
	// Same channel-target validation as `add` — applies to update too so an
	// operator can't rename a job's delivery.channel to a typo'd value via
	// the update path either.
	if (patch.delivery !== undefined) {
		assertDeliveryChannelIsKnown(state, patch.delivery);
	}
	const updated = await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const now = state.deps.nowMs!();
		const idx = state.store.jobs.findIndex((j) => j.id === jobId);
		if (idx < 0) throw new Error(`cron job not found: ${jobId}`);
		const current = state.store.jobs[idx]!;
		const next = applyJobPatch(current, patch, now);
		state.store.jobs[idx] = next;
		await persist(state);
		const evt: CronEvent = {
			action: "updated",
			jobId: next.id,
			...(next.state.nextRunAtMs !== undefined
				? { nextRunAtMs: next.state.nextRunAtMs }
				: {}),
		};
		emit(state, evt);
		return next;
	});
	armTimer(state);
	return updated;
}

/** Delete + persist + rearm. Returns true if removed, false if not found. */
export async function remove(state: CronServiceState, jobId: string): Promise<boolean> {
	const removed = await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const before = state.store.jobs.length;
		state.store.jobs = state.store.jobs.filter((j) => j.id !== jobId);
		const wasRemoved = state.store.jobs.length < before;
		if (wasRemoved) {
			await persist(state);
			emit(state, { action: "removed", jobId });
		}
		return wasRemoved;
	});
	if (removed) armTimer(state);
	return removed;
}

/** Quick-set the enabled flag without going through the full patch path. */
export async function setEnabled(
	state: CronServiceState,
	jobId: string,
	enabled: boolean,
): Promise<CronJob> {
	return update(state, jobId, { enabled });
}

/**
 * Trigger a job now. Two modes:
 *   - `"due"`   — only fire if the job's `nextRunAtMs` has actually arrived.
 *   - `"force"` — fire regardless of schedule.
 *
 * Runs INLINE (returns when the job completes). For non-blocking trigger,
 * use `enqueueRun`. Bypasses the concurrency limit — the caller is
 * explicitly asking for this run.
 */
export async function run(
	state: CronServiceState,
	jobId: string,
	mode: "due" | "force" = "force",
): Promise<void> {
	const now = state.deps.nowMs!();
	const targetJob = await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const job = state.store.jobs.find((j) => j.id === jobId);
		if (!job) throw new Error(`cron job not found: ${jobId}`);
		if (mode === "due") {
			const next = job.state.nextRunAtMs;
			if (next === undefined || next > now) {
				throw new Error(`cron job not due: ${jobId}`);
			}
		}
		// Mark the run as starting so concurrent ticks don't double-fire.
		const idx = state.store.jobs.findIndex((j) => j.id === jobId);
		if (idx < 0) throw new Error(`cron job not found: ${jobId}`);
		state.store.jobs[idx] = {
			...job,
			state: { ...job.state, runningAtMs: now, nextRunAtMs: now },
		};
		await persist(state);
		return state.store.jobs[idx]!;
	});
	// Outside the per-instance lock: the timer loop's runDueJob path will
	// handle the rest if armTimer fires soon. To make `run` return AFTER
	// the run completes, we drive the tick ourselves.
	void targetJob; // referenced for clarity; the tick loop reloads from disk
	await onTimer(state);
}

/**
 * Non-blocking variant of `run`: stamps the job as due-now and rearms the
 * timer; returns immediately. The next tick (within MIN_REFIRE_GAP_MS at
 * latest) picks it up.
 */
export async function enqueueRun(
	state: CronServiceState,
	jobId: string,
	mode: "due" | "force" = "force",
): Promise<void> {
	const now = state.deps.nowMs!();
	await withPerInstanceLock(state.op, async () => {
		await ensureLoaded(state);
		const idx = state.store.jobs.findIndex((j) => j.id === jobId);
		if (idx < 0) throw new Error(`cron job not found: ${jobId}`);
		const job = state.store.jobs[idx]!;
		if (mode === "due") {
			const next = job.state.nextRunAtMs;
			if (next === undefined || next > now) {
				throw new Error(`cron job not due: ${jobId}`);
			}
		}
		state.store.jobs[idx] = {
			...job,
			state: { ...job.state, nextRunAtMs: now },
		};
		await persist(state);
	});
	armTimer(state);
}

/**
 * Read run log entries for a job.
 *
 * Bypasses the per-instance lock — the run log is a separate file and
 * doesn't share state with the store.
 */
export async function runs(
	state: CronServiceState,
	jobId: string,
	opts: ReadCronRunLogOpts = {},
): Promise<CronRunLogEntry[]> {
	void state;
	return readCronRunLogEntries(jobId, opts);
}

/** Optional routing for a manual `wake` — when set, the system event +
 *  forced heartbeat target this agent's session rather than the gateway's
 *  boot default. Defaults to undefined for legacy single-agent installs. */
export interface CronWakeOpts {
	/** Target agent id (defaults to boot agent when omitted). */
	agentId?: string;
	/** Explicit session key override (defaults to that agent's main session). */
	sessionKey?: string;
}

/**
 * Inject a system event into the operator's main session. Mode controls
 * urgency:
 *   - `"now"`            — force a heartbeat tick to deliver immediately.
 *   - `"next-heartbeat"` — queue and let the natural heartbeat pick it up.
 *
 * `opts.agentId` / `opts.sessionKey` route both the system-event enqueue and
 * the forced heartbeat to a specific agent's session (multi-agent installs).
 */
export function wake(
	state: CronServiceState,
	text: string,
	mode: CronWakeMode = "next-heartbeat",
	opts: CronWakeOpts = {},
): void {
	state.pendingSystemEvents.push({ text, mode });
	const enqueue = state.deps.enqueueSystemEvent;
	if (enqueue) {
		try {
			enqueue({
				text,
				...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
				...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
			});
		} catch (err) {
			state.deps.log.warn("wake: enqueueSystemEvent threw", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (mode === "now" && state.deps.requestHeartbeatNow) {
		try {
			state.deps.requestHeartbeatNow({
				reason: "cron-wake",
				...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
				...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
			});
		} catch (err) {
			state.deps.log.warn("wake: requestHeartbeatNow threw", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Re-export so callers don't have to grab it separately. */
export { computeJobNextRunAtMs };

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
 * Refuse a `cron add`/`update` whose `delivery.channel` doesn't correspond
 * to a started channel adapter. Catches typos ("whatapp", "slak") that
 * would otherwise silently persist and produce a "channel not started"
 * warning every fire — the operator never seeing the cron's reply and
 * never understanding why.
 *
 * Skipped when:
 *   - No `listKnownChannelIds` dep is wired (tests / standalone CLI).
 *   - The returned list is empty (no channels active yet — don't block
 *     adding a cron BEFORE the first channel adapter starts).
 *   - `delivery` is unset / `delivery.channel` is unset / `delivery.mode`
 *     isn't `"announce"`.
 */
function assertDeliveryChannelIsKnown(
	state: CronServiceState,
	delivery: CronJob["delivery"] | undefined,
): void {
	if (!delivery) return;
	if (delivery.mode !== "announce") return;
	const channelRaw = delivery.channel?.trim();
	if (!channelRaw) return;
	const list = state.deps.listKnownChannelIds?.();
	if (!list || list.length === 0) return;
	if (list.includes(channelRaw)) return;
	throw new Error(
		`cron delivery.channel "${channelRaw}" is not a started channel adapter — ` +
			`available channels: ${list.join(", ") || "(none)"}. ` +
			`Either start the adapter first or change the channel id.`,
	);
}
