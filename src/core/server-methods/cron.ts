/**
 * Cron-related gateway method handlers.
 *
 * Brand-scrubbed analogue of the reference cron handler module. Eight methods
 * covering the full operator surface:
 *
 *   - `wake`        — inject a system event into a session
 *   - `cron.list`   — paginated job list
 *   - `cron.status` — service-level snapshot
 *   - `cron.add`    — create job (flat-param recovery handled by tool layer)
 *   - `cron.update` — patch one job by id (accepts `id` or `jobId`)
 *   - `cron.remove` — delete one job by id
 *   - `cron.run`    — fire a job NOW (force or due-only; enqueued)
 *   - `cron.runs`   — read run-log history (scope: per-job or all jobs)
 *
 * All handlers are PURE — they take params + a service-context bundle and
 * return a result. The WebSocket framing + the in-process registry wire-up
 * live one level up in `server.ts` / `gateway-caller-impl.ts`.
 *
 * Error shaping matches the rest of the gateway: throw `Error(message)` on
 * validation / not-found / invalid-id; the response framer converts to a
 * typed `ProtocolErrorShape`. The single non-throw degrade path is
 * `cron.run` — when the persisted sessionTarget id is malformed, the
 * handler returns `{ok:true, ran:false, reason:"invalid-spec"}` instead of
 * throwing, mirroring the reference's soft-OK degrade.
 */

import {
	add as cronAdd,
	enqueueRun as cronEnqueueRun,
	list as cronList,
	listPage as cronListPage,
	remove as cronRemove,
	runs as cronRunsRead,
	status as cronStatus,
	update as cronUpdate,
	wake as cronWake,
	type CronServiceStatus,
	type ListPageResult,
} from "../../cron/service/ops.js";
import type { CronServiceState } from "../../cron/service/state.js";
import { isInvalidCronSessionTargetIdError } from "../../cron/session-target.js";
import type {
	CronJob,
	CronJobCreate,
	CronJobPatch,
	CronRunLogEntry,
	CronWakeMode,
} from "../../cron/types.js";

/* ─── shared param + result shapes ─────────────────────────────── */

/** Service context bundle every handler receives. */
export interface CronHandlerContext {
	/** Live cron service state — null when the service hasn't started. */
	state: CronServiceState | null;
}

export interface CronWakeParams {
	text: string;
	mode?: CronWakeMode;
	agentId?: string;
	sessionKey?: string;
}

export interface CronListParamsV2 {
	includeDisabled?: boolean;
	limit?: number;
	offset?: number;
	query?: string;
	enabled?: "all" | "enabled" | "disabled";
	sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
	sortDir?: "asc" | "desc";
}

export type CronStatusParamsV2 = Record<string, never>;

export type CronAddParamsV2 = CronJobCreate & {
	sessionKey?: string;
};

export interface CronUpdateParamsV2 {
	id?: string;
	jobId?: string;
	patch: CronJobPatch;
}

export interface CronRemoveParamsV2 {
	id?: string;
	jobId?: string;
}

export interface CronRunParamsV2 {
	id?: string;
	jobId?: string;
	mode?: "due" | "force";
}

export interface CronRunsParamsV2 {
	scope?: "job" | "all";
	id?: string;
	jobId?: string;
	limit?: number;
	offset?: number;
	status?: "ok" | "error" | "skipped";
}

export type CronAddResultV2 = CronJob;
export type CronListResultV2 = ListPageResult;
export type CronStatusResultV2 = CronServiceStatus;
export type CronUpdateResultV2 = CronJob;
export interface CronRemoveResultV2 {
	removed: boolean;
}
export type CronRunResultV2 =
	| { ok: true; enqueued: true; jobId: string; mode: "due" | "force" }
	| { ok: true; ran: false; reason: "invalid-spec" };
export interface CronRunsResultV2 {
	entries: ReadonlyArray<CronRunLogEntry>;
}

/* ─── helpers ──────────────────────────────────────────────────── */

function requireState(ctx: CronHandlerContext): CronServiceState {
	if (!ctx.state) {
		throw new Error("cron service not running — start the gateway daemon first");
	}
	return ctx.state;
}

function resolveJobId(params: { id?: unknown; jobId?: unknown }, method: string): string {
	const idRaw =
		typeof params.id === "string"
			? params.id
			: typeof params.jobId === "string"
				? params.jobId
				: undefined;
	const id = idRaw?.trim();
	if (!id) {
		throw new Error(`invalid ${method} params: id or jobId required`);
	}
	return id;
}

/* ─── wake ─────────────────────────────────────────────────────── */

export function handleWake(params: CronWakeParams, ctx: CronHandlerContext): void {
	const state = requireState(ctx);
	const text = typeof params?.text === "string" ? params.text.trim() : "";
	if (!text) {
		throw new Error("invalid wake params: text required");
	}
	const mode: CronWakeMode = params.mode === "now" ? "now" : "next-heartbeat";
	cronWake(state, text, mode, {
		...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
		...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
	});
}

/* ─── cron.list ────────────────────────────────────────────────── */

export async function handleCronList(
	params: CronListParamsV2 | undefined,
	ctx: CronHandlerContext,
): Promise<CronListResultV2> {
	const state = requireState(ctx);
	const p = params ?? {};
	// `includeDisabled` and `enabled` are two views on the same dimension —
	// caller may use either. `enabled` wins when both are supplied.
	const enabled =
		p.enabled !== undefined ? p.enabled : p.includeDisabled === true ? "all" : "enabled";
	return cronListPage(state, {
		enabled,
		...(typeof p.limit === "number" ? { limit: p.limit } : {}),
		...(typeof p.offset === "number" ? { offset: p.offset } : {}),
		...(typeof p.query === "string" ? { query: p.query } : {}),
		...(p.sortBy !== undefined ? { sortBy: p.sortBy } : {}),
		...(p.sortDir !== undefined ? { sortDir: p.sortDir } : {}),
	});
}

/* ─── cron.status ──────────────────────────────────────────────── */

export async function handleCronStatus(
	_params: CronStatusParamsV2 | undefined,
	ctx: CronHandlerContext,
): Promise<CronStatusResultV2> {
	const state = requireState(ctx);
	return cronStatus(state);
}

/* ─── cron.add ─────────────────────────────────────────────────── */

export async function handleCronAdd(
	params: CronAddParamsV2,
	ctx: CronHandlerContext,
): Promise<CronAddResultV2> {
	const state = requireState(ctx);
	if (!params || typeof params !== "object") {
		throw new Error("invalid cron.add params: object required");
	}
	const sessionKey =
		typeof (params as { sessionKey?: unknown }).sessionKey === "string"
			? (params as { sessionKey: string }).sessionKey
			: undefined;
	// `sessionKey` doubles as the create-time session context so the
	// normalizer can resolve `sessionTarget: "current"` to
	// `session:<sessionKey>`. The same field is also persisted on the job
	// as the announce-fallback session key (Brigade-side; existing
	// behaviour). When the caller hasn't supplied a session context, the
	// normalizer falls back to `"isolated"` per the reference policy.
	return cronAdd(
		state,
		params as CronJobCreate,
		sessionKey !== undefined ? { sessionContext: { sessionKey } } : undefined,
	);
}

/* ─── cron.update ──────────────────────────────────────────────── */

export async function handleCronUpdate(
	params: CronUpdateParamsV2,
	ctx: CronHandlerContext,
): Promise<CronUpdateResultV2> {
	const state = requireState(ctx);
	if (!params || typeof params !== "object") {
		throw new Error("invalid cron.update params: object required");
	}
	const jobId = resolveJobId(params, "cron.update");
	const patch = (params as { patch?: unknown }).patch;
	if (!patch || typeof patch !== "object") {
		throw new Error("invalid cron.update params: patch required");
	}
	return cronUpdate(state, jobId, patch as CronJobPatch);
}

/* ─── cron.remove ──────────────────────────────────────────────── */

export async function handleCronRemove(
	params: CronRemoveParamsV2,
	ctx: CronHandlerContext,
): Promise<CronRemoveResultV2> {
	const state = requireState(ctx);
	const jobId = resolveJobId(params, "cron.remove");
	const removed = await cronRemove(state, jobId);
	return { removed };
}

/* ─── cron.run ─────────────────────────────────────────────────── */

export async function handleCronRun(
	params: CronRunParamsV2,
	ctx: CronHandlerContext,
): Promise<CronRunResultV2> {
	const state = requireState(ctx);
	const jobId = resolveJobId(params, "cron.run");
	const mode: "due" | "force" = params.mode === "due" ? "due" : "force";
	try {
		// Reference RPC path uses `enqueueRun` (non-blocking) — the operator
		// sees `{enqueued: true}` and can read back the latest run via
		// `cron.runs` once the tick fires. The in-process cron-tool keeps
		// its inline-run behaviour for the operator-facing surface (see
		// `cron-tool.ts` case "run").
		await cronEnqueueRun(state, jobId, mode);
		return { ok: true, enqueued: true, jobId, mode };
	} catch (err) {
		// Soft-OK degrade: when the persisted sessionTarget id is malformed
		// (e.g. a hand-edited cron.json with a control character), refuse
		// gracefully so the operator can still cron-remove the broken job
		// rather than being unable to interact with it at all.
		if (isInvalidCronSessionTargetIdError(err)) {
			return { ok: true, ran: false, reason: "invalid-spec" };
		}
		throw err;
	}
}

/* ─── cron.runs ────────────────────────────────────────────────── */

export async function handleCronRuns(
	params: CronRunsParamsV2,
	ctx: CronHandlerContext,
): Promise<CronRunsResultV2> {
	const state = requireState(ctx);
	const p = params ?? ({} as CronRunsParamsV2);
	const jobIdRaw =
		typeof p.id === "string" ? p.id : typeof p.jobId === "string" ? p.jobId : undefined;
	const jobId = jobIdRaw?.trim() || undefined;
	const scope: "job" | "all" = p.scope ?? (jobId ? "job" : "all");
	const limit = typeof p.limit === "number" ? p.limit : 50;
	const offset = typeof p.offset === "number" ? p.offset : 0;
	if (scope === "job") {
		if (!jobId) {
			throw new Error("invalid cron.runs params: id or jobId required for scope=job");
		}
		const entries = await cronRunsRead(state, jobId, {
			limit,
			offset,
			...(p.status !== undefined ? { status: p.status } : {}),
		});
		return { entries };
	}
	// scope === "all" — aggregate across every job by reading each job's
	// run-log and merging newest-first up to limit/offset. Brigade's
	// run-log helper is per-job; we list jobs (including disabled) and
	// concatenate. Cap heavy enumeration at a reasonable per-job slice so
	// a very-active store doesn't blow up memory.
	const jobs = await cronList(state, { includeDisabled: true });
	const perJobSlice = Math.min(200, Math.max(limit + offset, 50));
	const collected: CronRunLogEntry[] = [];
	for (const job of jobs) {
		const rows = await cronRunsRead(state, job.id, {
			limit: perJobSlice,
			offset: 0,
			...(p.status !== undefined ? { status: p.status } : {}),
		});
		collected.push(...rows);
	}
	collected.sort((a, b) => b.ts - a.ts);
	return { entries: collected.slice(offset, offset + limit) };
}
