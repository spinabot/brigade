/**
 * How a cost figure is written in the UI.
 *
 * Four situations used to render as the same `$0.0000`, and an operator could
 * not tell them apart:
 *
 *   - a metered turn that genuinely cost almost nothing,
 *   - a subscription turn where marginal cost really is zero,
 *   - a local turn where there is nothing to meter,
 *   - and a turn on an unpriced model that IS costing money and we cannot say
 *     how much.
 *
 * The last one is the dangerous one: a confident `$0.0000` over an unmeasured
 * turn reads as "free". So `unknown` renders as an absence, never a number —
 * the same discipline `BillingMode` was introduced for.
 *
 * Amounts show two decimals, not four. `$0.0342` implies a precision the
 * pricing tables do not have, and the reader wants magnitude.
 */

import type { BillingMode } from "./billing-mode.js";

/** `$0.42`, or `<$0.01` for a non-zero amount that would round away to nothing. */
export function formatUsd(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
	if (amount < 0.005) return "<$0.01";
	return `$${amount.toFixed(2)}`;
}

/**
 * The header's cost segment, or `undefined` when there is nothing honest to
 * say (so the caller omits it rather than printing a misleading zero).
 *
 * `costComplete: false` means the total is a FLOOR — some contribution arrived
 * with no cost signal — so it is prefixed with `≥`. Silently presenting a
 * partial sum as the whole is how a $16 session reads as $4.
 */
export function formatCostSegment(input: {
	billing: BillingMode | undefined;
	costUsd: number;
	costComplete?: boolean;
}): string | undefined {
	switch (input.billing) {
		case "local":
			// Nothing to meter, and saying so is friendlier than a bare `$0.00`
			// that invites "is that broken?".
			return "local";
		case "subscription":
			// Marginal cost is genuinely zero here, so a dollar figure is not
			// wrong — it is uninformative. The plan window is the real signal and
			// is surfaced separately.
			return "on your plan";
		case "unknown":
			return "cost n/a";
		case "metered":
		case undefined: {
			// `undefined` covers a gateway older than the `billing` field: fall
			// back to the previous behaviour of showing the number when we have one.
			// INCOMPLETENESS IS CHECKED FIRST, and that ordering is the whole point.
			//
			// This branch used to return a confident `$0.00` before ever looking at
			// `costComplete`. A metered session whose every contribution arrived
			// unpriced — a compaction Pi reports no usage for, a sweep that timed
			// out — has `costUsd === 0` AND `costComplete === false`, and rendered
			// as "$0.00": the precise "unmeasured reads as free" claim this module
			// exists to refuse. Reachable on the first render of any session
			// restored from a transcript with no cost recorded, because
			// `seedFromStats` sets `costComplete: cost > 0`.
			if (input.costComplete === false) {
				return input.costUsd > 0 ? `≥${formatUsd(input.costUsd)}` : "cost n/a";
			}
			if (!(input.costUsd > 0)) return input.billing === "metered" ? formatUsd(0) : undefined;
			return formatUsd(input.costUsd);
		}
	}
}
