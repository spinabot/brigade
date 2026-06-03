/**
 * Normalization + defaulting layer.
 *
 * `ops.add` / `ops.update` take a partial `CronJobCreate` from the caller (CLI,
 * RPC, or agent tool) and the store needs a fully-realised `CronJob` with
 * every field decided. This file owns the defaulting rules so the timer
 * loop, the run log, and the delivery dispatcher can all trust that
 * downstream values are present.
 *
 * Defaulting rules locked from the reference architecture:
 *   - `enabled` defaults to `true`.
 *   - `wakeMode` defaults to `"next-heartbeat"` (less disruptive than `"now"`).
 *   - `deleteAfterRun` defaults to `true` for `kind: "at"`, undefined otherwise.
 *   - `sessionTarget` defaults to `"main"` for `systemEvent` payloads,
 *     `"isolated"` for `agentTurn` payloads.
 *   - `delivery.mode` defaults: `"none"` for `systemEvent`, `"announce"` for
 *     `agentTurn` (so the operator sees the result by default).
 *   - `delivery.bestEffort` defaults to `false`.
 *   - Top-of-hour `cron` patterns get a 5-minute stagger window unless
 *     explicit.
 *
 * Validation calls live in `service/jobs.ts:assertSupportedJobSpec`; this
 * file only fills defaults + light coercion.
 */

import { parseAbsoluteTimeMs } from "./parse.js";
import { assertSafeCronSessionTargetId } from "./session-target.js";
import { defaultStaggerMsForCronExpression } from "./stagger.js";
import type {
	CronDelivery,
	CronJobCreate,
	CronPayload,
	CronSchedule,
	CronSessionTarget,
	CronWakeMode,
} from "./types.js";

/** Default sessionTarget given a payload's kind. */
export function defaultSessionTargetForPayload(payload: CronPayload): CronSessionTarget {
	return payload.kind === "systemEvent" ? "main" : "isolated";
}

/** Default delivery mode given the payload's kind. */
function defaultDeliveryModeForPayload(payload: CronPayload): CronDelivery["mode"] {
	return payload.kind === "systemEvent" ? "none" : "announce";
}

/**
 * Coerce a permissive caller-supplied schedule into a canonical `CronSchedule`.
 *
 * The agent tool's TypeBox shape is `Type.Any()` so the LLM can pass any of:
 *   - a bare string  → `"0 9 * * *"` (treated as a cron expression)
 *   - a record missing `kind` but carrying `expr` / `cron` / `everyMs` / `at`
 *   - the canonical `{kind: "cron", expr: "..."}` shape
 *
 * Without this coercion a string slipped past `normalizeSchedule` unchanged,
 * landed on disk with no `kind`, and `computeNextRunAtMs`'s switch returned
 * `undefined` forever — the job never fired. Migration of already-stored
 * bad-shape schedules happens in `store.ts:ensureLoaded` using this same
 * helper, so an operator who hit the bug on an older build doesn't have to
 * hand-edit `~/.brigade/cron.json`.
 */
export function coerceScheduleInput(raw: unknown): CronSchedule {
	if (typeof raw === "string") {
		const expr = raw.trim();
		if (!expr) throw new Error("cron schedule string is empty");
		return { kind: "cron", expr };
	}
	if (raw === null || typeof raw !== "object") {
		throw new Error(
			"cron schedule must be a string (cron expr) or an object — got " + typeof raw,
		);
	}
	const rec = raw as Record<string, unknown>;
	const rawKind = typeof rec.kind === "string" ? rec.kind.toLowerCase() : undefined;
	const validKinds = new Set(["at", "every", "cron"]);
	const kind = rawKind && validKinds.has(rawKind) ? rawKind : undefined;
	// Pull expression out of either `expr` or the legacy `cron` alias.
	const rawExpr =
		typeof rec.expr === "string"
			? rec.expr
			: typeof rec.cron === "string"
				? rec.cron
				: undefined;
	const expr = rawExpr?.trim() || undefined;
	const everyMs = typeof rec.everyMs === "number" ? rec.everyMs : undefined;
	// Accept `at` OR `atMs` as the absolute timestamp field. Per reference
	// implementation parse.ts, BOTH channels accept (a) numeric epoch ms,
	// (b) digit-string epoch ms, and (c) ISO-8601 string with UTC fallback
	// (bare date → midnight Z; naive date-time → append Z; tz-suffixed
	// preserved). Failure to parse a string → undefined (caller error
	// surfaces below in the kind-"at" branch).
	const atMsRaw = rec.atMs;
	const atRaw = rec.at;
	const atString = typeof atRaw === "string" ? atRaw.trim() : "";
	const atMsString = typeof atMsRaw === "string" ? atMsRaw.trim() : "";
	const at: number | undefined =
		typeof atMsRaw === "number" && Number.isFinite(atMsRaw)
			? Math.floor(atMsRaw)
			: atMsString
				? (parseAbsoluteTimeMs(atMsString) ?? undefined)
				: typeof atRaw === "number" && Number.isFinite(atRaw)
					? Math.floor(atRaw)
					: atString
						? (parseAbsoluteTimeMs(atString) ?? undefined)
						: undefined;
	// A bare ISO string on `at` or `atMs` is enough to infer kind "at" — the
	// reference normalizer auto-detects this even when `kind` is omitted.
	const hasAtSignal =
		at !== undefined ||
		atString.length > 0 ||
		atMsString.length > 0 ||
		typeof atMsRaw === "number";
	// Infer kind from whichever discriminator field is present.
	const inferredKind =
		kind ??
		(hasAtSignal
			? "at"
			: everyMs !== undefined
				? "every"
				: expr
					? "cron"
					: undefined);
	if (!inferredKind) {
		throw new Error(
			"cron schedule object needs at least one of: kind, expr, everyMs, at",
		);
	}
	switch (inferredKind) {
		case "at": {
			if (at === undefined) {
				throw new Error(
					'cron schedule kind "at" requires `at` as ISO-8601 string ' +
						"OR epoch ms (number, or numeric/atMs string)",
				);
			}
			return { kind: "at", at };
		}
		case "every": {
			if (everyMs === undefined) {
				throw new Error('cron schedule kind "every" requires a numeric `everyMs`');
			}
			const anchorMs = typeof rec.anchorMs === "number" ? rec.anchorMs : undefined;
			return {
				kind: "every",
				everyMs,
				...(anchorMs !== undefined ? { anchorMs } : {}),
			};
		}
		case "cron": {
			if (!expr) {
				throw new Error('cron schedule kind "cron" requires `expr` (a cron expression)');
			}
			const tz = typeof rec.tz === "string" ? rec.tz : undefined;
			const staggerMs = typeof rec.staggerMs === "number" ? rec.staggerMs : undefined;
			return {
				kind: "cron",
				expr,
				...(tz !== undefined ? { tz } : {}),
				...(staggerMs !== undefined ? { staggerMs } : {}),
			};
		}
	}
	throw new Error(`cron schedule has unsupported kind: ${inferredKind}`);
}

/**
 * Fill in a schedule's optional fields. For `cron` kind, applies the
 * top-of-hour stagger default. Other kinds pass through unchanged.
 *
 * Always run AFTER `coerceScheduleInput` — accepts only canonical-shape
 * schedules. Stale callers that pass a bare string slip past here unchanged
 * (the type-guard `schedule.kind !== "cron"` is true for `undefined`), so
 * make sure the entry point calls coerce first.
 */
export function normalizeSchedule(schedule: CronSchedule): CronSchedule {
	if (schedule.kind !== "cron") return schedule;
	if (schedule.staggerMs !== undefined) return schedule;
	const stagger = defaultStaggerMsForCronExpression(schedule.expr);
	if (stagger <= 0) return schedule;
	return { ...schedule, staggerMs: stagger };
}

/**
 * Fill in a delivery block's missing fields. Returns `undefined` only if the
 * caller already opted out by omitting delivery AND the payload's natural
 * default is also `none`.
 */
export function normalizeDelivery(
	delivery: CronDelivery | undefined,
	payload: CronPayload,
): CronDelivery | undefined {
	const mode = delivery?.mode ?? defaultDeliveryModeForPayload(payload);
	if (mode === "none" && !delivery) return undefined;
	return {
		mode,
		...(delivery?.channel !== undefined ? { channel: delivery.channel } : {}),
		...(delivery?.to !== undefined ? { to: delivery.to } : {}),
		...(delivery?.accountId !== undefined ? { accountId: delivery.accountId } : {}),
		...(delivery?.threadId !== undefined ? { threadId: delivery.threadId } : {}),
		bestEffort: delivery?.bestEffort ?? false,
		...(delivery?.webhookUrl !== undefined ? { webhookUrl: delivery.webhookUrl } : {}),
	};
}

/** Default wake mode for `wake` actions when the caller didn't specify. */
export function defaultWakeMode(): CronWakeMode {
	return "next-heartbeat";
}

/**
 * Resolve `deleteAfterRun` for a schedule kind. Caller-supplied wins; else
 * one-shot `at` jobs auto-delete on success, recurring jobs do not.
 */
export function resolveDeleteAfterRun(
	caller: boolean | undefined,
	schedule: CronSchedule,
): boolean | undefined {
	if (caller !== undefined) return caller;
	return schedule.kind === "at" ? true : undefined;
}

/**
 * Optional context the caller can thread into `defaultCronJobCreate` so the
 * normalizer can resolve `sessionTarget: "current"` into a concrete
 * `session:<sessionKey>` value. CLI / headless callers omit it; the agent
 * tool (which knows its calling session) supplies it.
 */
export interface CronJobCreateNormalizeOpts {
	sessionContext?: {
		/** Caller's session key — used to resolve `sessionTarget: "current"`. */
		sessionKey?: string;
	};
}

/**
 * Resolve a possibly-aliased `sessionTarget` into the persisted form.
 *
 *   - `"current"` + session context → `session:<sessionKey>` (safe-id guarded).
 *   - `"current"` without context  → `"isolated"` (headless / CLI fallback).
 *   - any other value              → returned unchanged.
 *
 * Mirrors the reference normalizer's create-time resolver — persisted
 * `CronJob.sessionTarget` values are always one of
 * `"main" | "isolated" | "session:<id>"` after this runs.
 */
function resolveSessionTargetAlias(
	target: CronSessionTarget,
	opts: CronJobCreateNormalizeOpts | undefined,
): CronSessionTarget {
	if (target !== "current") return target;
	const key = opts?.sessionContext?.sessionKey?.trim();
	if (key) {
		// `assertSafeCronSessionTargetId` throws on path-special / control
		// characters; we re-throw with the original error to surface the
		// invalid-spec to the caller (matches reference behaviour).
		assertSafeCronSessionTargetId(key);
		return `session:${key}`;
	}
	return "isolated";
}

/**
 * Produce a fully-defaulted create input — every optional field decided.
 * Doesn't validate; that's `assertSupportedJobSpec`'s job. Doesn't write to
 * disk; the caller (ops.add) does that.
 *
 * Pass `opts.sessionContext.sessionKey` to resolve `sessionTarget: "current"`
 * into the caller's session. Existing callers that omit `opts` keep the
 * pre-existing single-agent behaviour (no "current" → no rewrite).
 */
export function defaultCronJobCreate(
	input: CronJobCreate,
	opts?: CronJobCreateNormalizeOpts,
): Required<Pick<CronJobCreate, "enabled" | "sessionTarget" | "wakeMode">> & CronJobCreate {
	// Coerce permissive caller input (bare string / object-without-kind) into
	// the canonical CronSchedule shape BEFORE we touch staggerMs etc. — see
	// `coerceScheduleInput` for the supported shapes.
	const coerced = coerceScheduleInput(input.schedule);
	const schedule = normalizeSchedule(coerced);
	const sessionTargetRaw =
		input.sessionTarget ?? defaultSessionTargetForPayload(input.payload);
	// Resolve `"current"` → `session:<id>` (or `"isolated"` when no session
	// context is available). Persisted value is never `"current"`.
	const sessionTarget = resolveSessionTargetAlias(sessionTargetRaw, opts);
	const wakeMode = input.wakeMode ?? defaultWakeMode();
	const delivery = normalizeDelivery(input.delivery, input.payload);
	const deleteAfterRun = resolveDeleteAfterRun(input.deleteAfterRun, schedule);
	return {
		...input,
		schedule,
		sessionTarget,
		wakeMode,
		enabled: input.enabled ?? true,
		...(delivery !== undefined ? { delivery } : {}),
		...(deleteAfterRun !== undefined ? { deleteAfterRun } : {}),
	};
}
