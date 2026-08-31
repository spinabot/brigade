/**
 * claude-cli → provider-agnostic limits adapter.
 *
 * The binary reports plan-window telemetry (`rate_limit_event` frames carrying
 * a `rate_limit_info` block) rather than the rate-limit HEADERS a metered HTTP
 * provider sends. This module is the only place that vocabulary is understood;
 * everything downstream sees the neutral `ProviderLimitWindow` shape from
 * `../usage/limits.js`, so the TUI and any future web client render Claude plan
 * windows, Anthropic API token buckets, and OpenAI request buckets through one
 * code path.
 *
 * On a subscription backend this is the ONLY consumption signal that exists —
 * there is no per-token price — so dropping it (as `// no-op` did) left the
 * operator with neither a cost figure nor a quota figure, unable to tell a
 * healthy session from one about to be cut off mid-turn.
 */

import { CLAUDE_CLI_PROVIDER } from "./catalog.js";
import type { RateLimitInfo } from "./stream-json.js";
import { parseResetAt, recordLimit, type LimitStatus, type ProviderLimitWindow } from "../usage/limits.js";

/**
 * Turn `five_hour` into "5-hour window".
 *
 * An unrecognized kind renders readably rather than being dropped or, worse,
 * mislabelled as one of the kinds we do know — Anthropic can add windows.
 */
export function formatWindowLabel(kind: string): string {
	switch (kind) {
		case "five_hour":
			return "5-hour window";
		case "seven_day":
			return "7-day window";
		default:
			return kind.replace(/_/g, " ").trim() || "plan window";
	}
}

/**
 * Normalize one raw `rate_limit_info` block into the neutral shape.
 *
 * Returns `undefined` when the block carries nothing identifying — a frame with
 * neither a window kind nor a status tells us nothing, and recording it would
 * overwrite a good observation with an empty one.
 */
export function normalizePlanLimit(
	info: RateLimitInfo | undefined,
	now = Date.now(),
): ProviderLimitWindow | undefined {
	if (!info) return undefined;
	const rawKind = typeof info.rateLimitType === "string" ? info.rateLimitType.trim() : "";
	const rawStatus = typeof info.status === "string" ? info.status.trim() : "";
	if (!rawKind && !rawStatus) return undefined;

	const kind = rawKind || "plan_window";
	const overageStatus = typeof info.overageStatus === "string" ? info.overageStatus : undefined;

	// Exhausted when EITHER the window itself or its overage path is refusing.
	// An account whose base allowance is spent but whose overage is allowed is
	// still working; showing it as blocked would tell the operator to stop when
	// they don't have to.
	let status: LimitStatus;
	if (rawStatus === "rejected" || overageStatus === "rejected") status = "exhausted";
	else if (rawStatus === "allowed") status = "ok";
	else status = "unknown";

	// The CLI reports `resetsAt` in epoch SECONDS; `parseResetAt` converts.
	const resetsAt = parseResetAt(info.resetsAt, now);

	return {
		provider: CLAUDE_CLI_PROVIDER,
		kind,
		label: formatWindowLabel(kind),
		status,
		...(resetsAt !== undefined ? { resetsAt } : {}),
		...(typeof info.isUsingOverage === "boolean" ? { usingOverage: info.isUsingOverage } : {}),
		...(typeof info.overageDisabledReason === "string" && info.overageDisabledReason
			? { note: `overage unavailable: ${info.overageDisabledReason}` }
			: {}),
		observedAt: now,
	};
}

/** Record a `rate_limit_event` observation. No-op for an unidentifying block. */
export function recordPlanLimit(info: RateLimitInfo | undefined, now = Date.now()): void {
	const window = normalizePlanLimit(info, now);
	if (!window) return;
	recordLimit(window);
}
