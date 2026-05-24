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
 * Fill in a schedule's optional fields. For `cron` kind, applies the
 * top-of-hour stagger default. Other kinds pass through unchanged.
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
 * Produce a fully-defaulted create input — every optional field decided.
 * Doesn't validate; that's `assertSupportedJobSpec`'s job. Doesn't write to
 * disk; the caller (ops.add) does that.
 */
export function defaultCronJobCreate(input: CronJobCreate): Required<
	Pick<CronJobCreate, "enabled" | "sessionTarget" | "wakeMode">
> & CronJobCreate {
	const schedule = normalizeSchedule(input.schedule);
	const sessionTarget = input.sessionTarget ?? defaultSessionTargetForPayload(input.payload);
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
