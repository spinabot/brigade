// src/storage/convex/cron-store.ts
//
// ConvexCronStore — convex-mode adapter for the cronJobs + cronRuns tables.
//
// The disk store persists a CronJob verbatim as one JSON object inside
// `~/.brigade/cron.json`. The Convex schema instead FLATTENS that object into
// scalar columns (schedule-by-kind, createdBy*, state*) so the backend can
// index + query it. This module owns the round-trip:
//
//   jobToColumns(job)  — CronJob  → flat Convex column set (insert / patch)
//   rowToJob(row)      — Convex row → CronJob (list / get / subscribe / return)
//
// `payload` and `delivery` are operator-sensitive (reminder text, recent
// message snippets, webhook URLs) so they ride in `Enc()` byte columns —
// sealed on write, opened on read. Everything else is plain scalars.
//
// State-column clearing: Convex's arg serialiser strips `undefined`-valued
// object fields before they reach the server, so a column can't be cleared by
// patching it to `undefined` from the client. We therefore send an explicit
// `unset: string[]` list that the server turns into field deletions — this is
// how a finished run clears `stateRunningAtMs` (critical: a stale running
// marker would wedge the two-phase tick).

import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import type {
	CronJob as InternalCronJob,
	CronJobState as InternalCronJobState,
	CronJobOrigin,
	CronSchedule,
} from "../../cron/types.js";

import { getReactiveConvexClient } from "./client.js";

import { NotImplementedYet } from "../store.js";
import type {
	CronJob,
	CronJobState,
	CronRunLogEntry,
	CronStore,
	ReadCronRunLogOpts,
	Unsub,
} from "../store.js";

import { openJson, sealJson } from "../encryption.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

// ---------------------------------------------------------------------------
// Marshalling — CronJob ⇆ flat Convex columns
// ---------------------------------------------------------------------------

/** disk `schedule` (discriminated union) → flat `scheduleKind` + scalars. */
function flattenSchedule(schedule: CronSchedule | undefined): Record<string, unknown> {
	switch (schedule?.kind) {
		case "cron":
			return {
				scheduleKind: "cron",
				scheduleExpr: schedule.expr,
				...(schedule.tz !== undefined ? { scheduleTz: schedule.tz } : {}),
				...(schedule.staggerMs !== undefined ? { scheduleStaggerMs: schedule.staggerMs } : {}),
			};
		case "every":
			return {
				scheduleKind: "every",
				scheduleEveryMs: schedule.everyMs,
				...(schedule.anchorMs !== undefined ? { scheduleAnchorMs: schedule.anchorMs } : {}),
			};
		case "at":
			return { scheduleKind: "at", scheduleAt: schedule.at };
		default:
			// Normalised jobs always carry a schedule; guard so a malformed row
			// never crashes the flattener. A zero one-shot never fires.
			return { scheduleKind: "at", scheduleAt: 0 };
	}
}

/** flat `scheduleKind` + scalars → disk `schedule`. */
function rebuildSchedule(r: Record<string, unknown>): CronSchedule {
	const kind = r.scheduleKind as string | undefined;
	if (kind === "cron") {
		return {
			kind: "cron",
			expr: (r.scheduleExpr as string) ?? "",
			...(r.scheduleTz !== undefined ? { tz: r.scheduleTz as string } : {}),
			...(r.scheduleStaggerMs !== undefined ? { staggerMs: r.scheduleStaggerMs as number } : {}),
		};
	}
	if (kind === "every") {
		return {
			kind: "every",
			everyMs: (r.scheduleEveryMs as number) ?? 0,
			...(r.scheduleAnchorMs !== undefined ? { anchorMs: r.scheduleAnchorMs as number } : {}),
		};
	}
	return { kind: "at", at: (r.scheduleAt as number) ?? 0 };
}

/** disk `createdBy` → flat `createdBy*`. `undefined` origin ⇒ "legacy". */
function flattenCreatedBy(createdBy: CronJobOrigin | undefined): Record<string, unknown> {
	if (createdBy?.kind === "channel") {
		return {
			createdByKind: "channel",
			createdByChannelId: createdBy.channelId,
			createdByConversationId: createdBy.conversationId,
			...(createdBy.accountId !== undefined ? { createdByAccountId: createdBy.accountId } : {}),
		};
	}
	if (createdBy?.kind === "owner") return { createdByKind: "owner" };
	return { createdByKind: "legacy" };
}

/** flat `createdBy*` → disk `createdBy`. "legacy"/missing ⇒ `undefined`. */
function rebuildCreatedBy(r: Record<string, unknown>): CronJobOrigin | undefined {
	const kind = r.createdByKind as string | undefined;
	if (kind === "channel") {
		return {
			kind: "channel",
			channelId: (r.createdByChannelId as string) ?? "",
			conversationId: (r.createdByConversationId as string) ?? "",
			...(r.createdByAccountId !== undefined ? { accountId: r.createdByAccountId as string } : {}),
		};
	}
	if (kind === "owner") return { kind: "owner" };
	return undefined;
}

/** Ordered map of disk `state` keys → flat `state*` columns. */
const STATE_MAP: Array<[keyof InternalCronJobState, string]> = [
	["nextRunAtMs", "stateNextRunAtMs"],
	["lastRunAtMs", "stateLastRunAtMs"],
	["runningAtMs", "stateRunningAtMs"],
	["lastStatus", "stateLastStatus"],
	["lastError", "stateLastError"],
	["scheduleErrorCount", "stateScheduleErrorCount"],
	["consecutiveErrorCount", "stateConsecutiveErrorCount"],
	["lastFailureAlertAtMs", "stateLastFailureAlertAtMs"],
	["lastDelivered", "stateLastDelivered"],
	["lastDeliveryStatus", "stateLastDeliveryStatus"],
	["lastDeliveryError", "stateLastDeliveryError"],
];

/**
 * Merge-style state delta — touches ONLY keys present in the partial. A key
 * present with `undefined` value means "clear" (→ unset); present with a value
 * means "set". Mirrors LocalCronStore.recordJobOutcome's `{...old, ...patch}`
 * where a present-undefined drops the field on JSON round-trip.
 */
function statePartialDelta(
	state: Partial<InternalCronJobState> | undefined,
): { set: Record<string, unknown>; unset: string[] } {
	const s = (state ?? {}) as Record<string, unknown>;
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	for (const [k, col] of STATE_MAP) {
		if (!(k in s)) continue;
		const val = s[k as string];
		if (val === undefined) unset.push(col);
		else set[col] = val;
	}
	return { set, unset };
}

/**
 * Authoritative state delta — syncs ALL 11 columns to `state`. Keys with a
 * value are set; every other column is unset. Used by insert (set only) and
 * updateJob (full replace of the state sub-object).
 */
function stateFullDelta(
	state: InternalCronJobState | undefined,
): { set: Record<string, unknown>; unset: string[] } {
	const s = (state ?? {}) as Record<string, unknown>;
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	for (const [k, col] of STATE_MAP) {
		const val = s[k as string];
		if (val === undefined) unset.push(col);
		else set[col] = val;
	}
	return { set, unset };
}

/** flat `state*` columns → disk `state`. */
function rebuildState(r: Record<string, unknown>): InternalCronJobState {
	const out: Record<string, unknown> = {};
	for (const [k, col] of STATE_MAP) {
		const val = r[col];
		if (val !== undefined) out[k as string] = val;
	}
	return out as InternalCronJobState;
}

/**
 * Full CronJob → flat Convex column set (no `ownerUserId` — callers add it).
 * Includes the state SET columns; the matching unset list (for clearing) is
 * computed separately by callers that patch.
 */
function jobToColumns(job: InternalCronJob): Record<string, unknown> {
	return {
		jobId: job.id,
		name: job.name,
		...(job.description !== undefined ? { description: job.description } : {}),
		enabled: job.enabled,
		...(job.agentId !== undefined ? { agentId: job.agentId } : {}),
		...(job.sessionKey !== undefined ? { sessionKey: job.sessionKey } : {}),
		...flattenSchedule(job.schedule),
		sessionTarget: job.sessionTarget,
		...(job.wakeMode !== undefined ? { wakeMode: job.wakeMode } : {}),
		payload: sealJson(job.payload),
		...(job.delivery !== undefined ? { delivery: sealJson(job.delivery) } : {}),
		...(job.failureAlert !== undefined ? { failureAlert: job.failureAlert } : {}),
		...(job.deleteAfterRun !== undefined ? { deleteAfterRun: job.deleteAfterRun } : {}),
		...flattenCreatedBy(job.createdBy),
		createdAtMs: job.createdAtMs,
		updatedAtMs: job.updatedAtMs,
		...stateFullDelta(job.state).set,
	};
}

/** Convex row → full CronJob. Inverse of `jobToColumns`. */
function rowToJob(row: Record<string, unknown>): InternalCronJob {
	const createdBy = rebuildCreatedBy(row);
	const job: Record<string, unknown> = {
		id: row.jobId,
		name: row.name,
		...(row.description !== undefined ? { description: row.description } : {}),
		enabled: row.enabled,
		...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
		...(row.sessionKey !== undefined ? { sessionKey: row.sessionKey } : {}),
		schedule: rebuildSchedule(row),
		sessionTarget: row.sessionTarget,
		...(row.wakeMode !== undefined ? { wakeMode: row.wakeMode } : {}),
		payload: openJson(row.payload as ArrayBuffer | undefined) ?? {},
		...(row.delivery !== undefined
			? { delivery: openJson(row.delivery as ArrayBuffer | undefined) }
			: {}),
		...(row.failureAlert !== undefined ? { failureAlert: row.failureAlert } : {}),
		...(row.deleteAfterRun !== undefined ? { deleteAfterRun: row.deleteAfterRun } : {}),
		...(createdBy !== undefined ? { createdBy } : {}),
		createdAtMs: row.createdAtMs,
		updatedAtMs: row.updatedAtMs,
		state: rebuildState(row),
	};
	return job as unknown as InternalCronJob;
}

/** Test seam — surface the pure marshalling fns without a live Convex client. */
export const __cronMarshalling = {
	flattenSchedule,
	rebuildSchedule,
	flattenCreatedBy,
	rebuildCreatedBy,
	statePartialDelta,
	stateFullDelta,
	rebuildState,
	jobToColumns,
	rowToJob,
};

export class ConvexCronStore implements CronStore {
	constructor(private readonly deps: Deps) {}

	async listJobs(filter?: { enabled?: boolean; query?: string; ownerOnly?: boolean }): Promise<CronJob[]> {
		const rows = (await this.deps.client.query(api.cron.listJobs, {
			ownerUserId: this.deps.ownerId,
			...(filter?.enabled !== undefined ? { enabledOnly: filter.enabled === true } : {}),
		})) as Array<Record<string, unknown>>;
		let jobs = rows.map(rowToJob);
		// `enabled === false` can't use the enabled index (it filters true), so
		// apply it in-memory; query + ownerOnly mirror LocalCronStore exactly.
		if (filter?.enabled === false) jobs = jobs.filter((j) => j.enabled === false);
		if (filter?.query) {
			const q = filter.query.toLowerCase();
			jobs = jobs.filter((j) => {
				const name = (j.name ?? "").toLowerCase();
				const desc = (j.description ?? "").toLowerCase();
				const id = (j.id ?? "").toLowerCase();
				return name.includes(q) || desc.includes(q) || id.includes(q);
			});
		}
		if (filter?.ownerOnly) {
			jobs = jobs.filter((j) => {
				// `createdBy.kind` narrows to owner|channel in the type, but a
				// migrated/legacy row can carry "legacy" — widen to string to
				// match LocalCronStore's identical owner-or-legacy gate.
				const kind = (j as { createdBy?: { kind?: string } }).createdBy?.kind;
				return kind === undefined || kind === "owner" || kind === "legacy";
			});
		}
		return jobs as unknown as CronJob[];
	}

	async getJob(jobId: string): Promise<CronJob | null> {
		const row = (await this.deps.client.query(api.cron.getJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
		})) as Record<string, unknown> | null;
		return row ? (rowToJob(row) as unknown as CronJob) : null;
	}

	async insertJob(job: CronJob): Promise<void> {
		const internal = job as unknown as InternalCronJob;
		await this.deps.client.mutation(api.cron.insertJob, {
			ownerUserId: this.deps.ownerId,
			...jobToColumns(internal),
		} as never);
	}

	async updateJob(jobId: string, mutate: (job: CronJob) => CronJob): Promise<CronJob> {
		const existing = await this.getJob(jobId);
		if (!existing) throw new Error(`cron: job ${jobId} not found`);
		const next = mutate(existing) as unknown as InternalCronJob;
		// Full state replace: set present columns, unset the rest.
		const { unset } = stateFullDelta(next.state);
		const row = (await this.deps.client.mutation(api.cron.patchJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
			patch: jobToColumns(next),
			...(unset.length ? { unset } : {}),
		} as never)) as Record<string, unknown>;
		return rowToJob(row) as unknown as CronJob;
	}

	async deleteJob(jobId: string): Promise<boolean> {
		return (await this.deps.client.mutation(api.cron.deleteJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
		})) as boolean;
	}

	async markJobRunning(jobId: string, runningAtMs: number): Promise<boolean> {
		return (await this.deps.client.mutation(api.cron.markRunning, {
			ownerUserId: this.deps.ownerId,
			jobId,
			runningAtMs,
		})) as boolean;
	}

	async recordJobOutcome(
		jobId: string,
		patch: { state: Partial<CronJobState>; deleteAfterApply: boolean },
	): Promise<CronJob | null> {
		if (patch.deleteAfterApply) {
			await this.deleteJob(jobId);
			return null;
		}
		// Merge semantics: only the keys present in the state partial are
		// touched; present-undefined clears the column (via unset).
		const { set, unset } = statePartialDelta(patch.state as Partial<InternalCronJobState>);
		const row = (await this.deps.client.mutation(api.cron.patchJob, {
			ownerUserId: this.deps.ownerId,
			jobId,
			patch: set,
			...(unset.length ? { unset } : {}),
		} as never)) as Record<string, unknown> | null;
		return row ? (rowToJob(row) as unknown as CronJob) : null;
	}

	async appendRunLog(entry: CronRunLogEntry): Promise<void> {
		const e = entry as unknown as Record<string, unknown>;
		const usage = (e.usage as Record<string, unknown> | undefined) ?? undefined;
		await this.deps.client.mutation(api.cron.appendRunLog, {
			ownerUserId: this.deps.ownerId,
			jobId: (e.jobId as string) ?? "",
			ts: (e.ts as number) ?? Date.now(),
			status: (e.status as never) ?? "ok",
			...(e.error !== undefined ? { error: e.error as string } : {}),
			...(e.summary !== undefined ? { summary: sealJson(e.summary) } : {}),
			...(e.delivered !== undefined ? { delivered: e.delivered as boolean } : {}),
			...(e.deliveryStatus !== undefined ? { deliveryStatus: e.deliveryStatus as string } : {}),
			...(e.deliveryError !== undefined ? { deliveryError: e.deliveryError as string } : {}),
			...(e.sessionId !== undefined ? { sessionId: e.sessionId as string } : {}),
			...(e.sessionKey !== undefined ? { sessionKey: e.sessionKey as string } : {}),
			...(e.runAtMs !== undefined ? { runAtMs: e.runAtMs as number } : {}),
			...(e.durationMs !== undefined ? { durationMs: e.durationMs as number } : {}),
			...(e.nextRunAtMs !== undefined ? { nextRunAtMs: e.nextRunAtMs as number } : {}),
			...(e.model !== undefined ? { model: e.model as string } : {}),
			...(e.provider !== undefined ? { provider: e.provider as string } : {}),
			...(usage?.input !== undefined ? { usageInput: usage.input as number } : {}),
			...(usage?.output !== undefined ? { usageOutput: usage.output as number } : {}),
			...(usage?.cacheRead !== undefined ? { usageCacheRead: usage.cacheRead as number } : {}),
			...(usage?.cacheWrite !== undefined ? { usageCacheWrite: usage.cacheWrite as number } : {}),
			...(usage?.totalTokens !== undefined ? { usageTotalTokens: usage.totalTokens as number } : {}),
			...(usage?.costUsd !== undefined ? { usageCostUsd: usage.costUsd as number } : {}),
		} as never);
	}

	async listRunLog(jobId: string, opts: ReadCronRunLogOpts): Promise<CronRunLogEntry[]> {
		const rows = (await this.deps.client.query(api.cron.listRunLog, {
			ownerUserId: this.deps.ownerId,
			jobId,
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
		})) as Array<Record<string, unknown>>;
		return rows.map(runRowToEntry) as unknown as CronRunLogEntry[];
	}

	async listIsolatedCronSessions(): Promise<
		Array<{ sessionKey: string; sessionId: string; lastUsedAt: string }>
	> {
		throw new NotImplementedYet("cron.listIsolatedCronSessions (use store.sessions.listEntries)");
	}

	async deleteIsolatedCronSession(): Promise<void> {
		throw new NotImplementedYet("cron.deleteIsolatedCronSession (use store.sessions.deleteEntry)");
	}

	async withMutation<T>(work: () => Promise<T>): Promise<T> {
		// Convex serialises mutations on the same document keys — no extra lock.
		return work();
	}

	subscribe(cb: (jobs: CronJob[]) => void): Unsub {
		const reactive = getReactiveConvexClient();
		const unsub = reactive.onUpdate(
			api.cron.listJobs,
			{ ownerUserId: this.deps.ownerId },
			(rows) => {
				try {
					const jobs = (rows as Array<Record<string, unknown>>).map(rowToJob);
					cb(jobs as unknown as CronJob[]);
				} catch {
					// Subscriber threw — stay alive.
				}
			},
		);
		return () => {
			try {
				unsub();
			} catch {
				// Idempotent.
			}
		};
	}
}

/** cronRuns row → CronRunLogEntry (opens the sealed summary, rebuilds usage). */
function runRowToEntry(row: Record<string, unknown>): CronRunLogEntry {
	const r = row;
	const usage: Record<string, unknown> = {};
	if (r.usageInput !== undefined) usage.input = r.usageInput;
	if (r.usageOutput !== undefined) usage.output = r.usageOutput;
	if (r.usageCacheRead !== undefined) usage.cacheRead = r.usageCacheRead;
	if (r.usageCacheWrite !== undefined) usage.cacheWrite = r.usageCacheWrite;
	if (r.usageTotalTokens !== undefined) usage.totalTokens = r.usageTotalTokens;
	if (r.usageCostUsd !== undefined) usage.costUsd = r.usageCostUsd;
	const summary = openJson<string>(r.summary as ArrayBuffer | undefined);
	const out: Record<string, unknown> = {
		ts: r.ts,
		jobId: r.jobId,
		action: "finished",
		...(r.status !== undefined ? { status: r.status } : {}),
		...(r.error !== undefined ? { error: r.error } : {}),
		...(summary !== undefined ? { summary } : {}),
		...(r.delivered !== undefined ? { delivered: r.delivered } : {}),
		...(r.deliveryStatus !== undefined ? { deliveryStatus: r.deliveryStatus } : {}),
		...(r.deliveryError !== undefined ? { deliveryError: r.deliveryError } : {}),
		...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
		...(r.sessionKey !== undefined ? { sessionKey: r.sessionKey } : {}),
		...(r.runAtMs !== undefined ? { runAtMs: r.runAtMs } : {}),
		...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
		...(r.nextRunAtMs !== undefined ? { nextRunAtMs: r.nextRunAtMs } : {}),
		...(r.model !== undefined ? { model: r.model } : {}),
		...(r.provider !== undefined ? { provider: r.provider } : {}),
		...(Object.keys(usage).length ? { usage } : {}),
	};
	return out as unknown as CronRunLogEntry;
}
