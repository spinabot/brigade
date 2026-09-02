/**
 * Billing modes — the provider-agnostic answer to "what does consumption even
 * mean for this turn?".
 *
 * Brigade is a model-agnostic harness, so a single "tokens + cost" pair cannot
 * describe every backend it drives. Three genuinely different realities exist,
 * and collapsing them into one number is what makes usage figures unreadable:
 *
 *   - METERED      — per-token pricing. Dollars are the signal, and the
 *                    provider's rate-limit headers bound the throughput.
 *   - SUBSCRIPTION — a plan window (Claude's rolling 5-hour / 7-day allowances,
 *                    a Copilot seat). Marginal cost really is zero, so a dollar
 *                    figure is not just uninformative, it is actively
 *                    misleading. The window's remaining budget is the signal.
 *   - LOCAL        — self-hosted inference. Nothing to meter at all.
 *   - UNKNOWN      — a model with no pricing on record (a snapshot newer than
 *                    the bundled catalog, a synthesized id). The turn is
 *                    probably costing real money and we cannot say how much.
 *
 * The UNKNOWN case is the one that matters most and the one usually missed.
 * Without it, an unpriced model renders a confident `$0.0000` that is
 * indistinguishable from a genuinely free local turn — so the operator reads
 * "free" when the truth is "unmeasured". Every consumer of this module must
 * render UNKNOWN as an absence ("—", "not reported"), never as zero.
 */

import { PROVIDERS } from "../../providers/catalog.js";

/** How consumption is charged for a given turn. */
export type BillingMode = "metered" | "subscription" | "local" | "unknown";

/** Non-negative, finite, and greater than zero. Guards against pi-ai's `-1` sentinels. */
function isRealPrice(n: unknown): boolean {
	return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Classify a turn's billing mode from its provider and the resolved model's
 * price card.
 *
 * `costKnown` lets a transport override the inference when it has better
 * information than the catalog — a subscription backend that DID report a
 * real dollar figure for the turn, for instance.
 *
 * Order matters. Local and subscription are properties of the PROVIDER and win
 * over any price card, because a catalog entry carrying list prices for a model
 * you are running locally would otherwise bill you for your own GPU.
 */
export function classifyBillingMode(input: {
	/**
	 * The provider id. Prefer the PICKER id the operator actually chose
	 * (`claude-code`, `claude-cli`) over the resolved Pi provider — see the
	 * ambiguity note below.
	 */
	provider: string | undefined;
	/** The resolved model's per-Mtok price card, when one exists. */
	cost?: { input?: number; output?: number } | undefined;
	/** Transport-reported: did this turn come with a real cost figure? */
	costKnown?: boolean | undefined;
}): BillingMode {
	const provider = (input.provider ?? "").trim().toLowerCase();

	// The catalog is the single source of truth, so adding a provider there is
	// the only step needed to classify it. `unknown` in the catalog is not a
	// verdict — it means "ask the price card", which is what `custom` needs.
	const entry = provider ? PROVIDERS.find((p) => p.id.toLowerCase() === provider) : undefined;
	// An ABSENT `billing` is not a verdict either — treat it exactly like the
	// explicit `"unknown"` and fall through to the price card.
	//
	// This read `entry.billing !== "unknown"`, which is TRUE when the field is
	// missing, so it returned `undefined` — not a member of `BillingMode` at
	// all. Every current catalog entry sets it, so nothing broke; the first new
	// provider added without it silently disabled cost rendering for that
	// provider, because `shouldRenderCost(undefined)` is false. Found while
	// reviewing exactly such a PR, where the omitted field would have hidden
	// real spend on a metered gateway.
	if (entry && entry.billing !== undefined && entry.billing !== "unknown") return entry.billing;

	if (isRealPrice(input.cost?.input) || isRealPrice(input.cost?.output)) return "metered";
	// A transport that reported a real figure is metered even when the catalog
	// has no price card for the model — trust the observation over the table.
	if (input.costKnown === true) return "metered";
	return "unknown";
}

/**
 * Disambiguate the one provider that is billed two different ways.
 *
 * `providerId` routing collapses picker entries onto one Pi provider: onboarding
 * resolves `providerId ?? id` (src/ui/onboarding.ts:457, :1199), so BOTH the
 * "Anthropic" API-key entry and the "Claude (browser OAuth)" subscription entry
 * store their credential under, and route through, `anthropic`. The provider id
 * alone therefore cannot tell a metered turn from a Pro/Max subscription turn.
 *
 * The credential's `type` can. Onboarding writes `{ type: "oauth" }` for the
 * subscription login (src/ui/onboarding.ts:1213, :1650) and `{ type: "api_key" }`
 * for the key paths (:888, :1870). So for a provider the catalog marks
 * `metered`, an oauth/token credential means the operator is on a subscription
 * and no per-token charge applies.
 *
 * Pass the stored profile's `type` when you have it. Omitting it keeps the
 * catalog's answer, which errs toward `metered` — the safer failure, since it
 * shows a cost rather than silently hiding one.
 */
export function classifyBillingModeWithAuth(input: {
	provider: string | undefined;
	/** The stored credential's type, from `AuthProfile.type`. */
	authType?: "api_key" | "oauth" | "token" | undefined;
	cost?: { input?: number; output?: number } | undefined;
	costKnown?: boolean | undefined;
}): BillingMode {
	const base = classifyBillingMode(input);
	// Only ever narrows metered → subscription. A catalog entry that is already
	// `local` or `subscription` is not overridden by how its credential is
	// stored, and `unknown` stays unknown rather than being guessed at.
	if (base === "metered" && (input.authType === "oauth" || input.authType === "token")) {
		return "subscription";
	}
	return base;
}

/**
 * Whether a dollar figure should be rendered at all for this mode.
 *
 * `unknown` returns false — that is the entire point of the mode. A caller that
 * ignores this and prints `cost ?? 0` reintroduces the confident-$0.0000 bug.
 */
export function shouldRenderCost(mode: BillingMode): boolean {
	return mode === "metered";
}

/** Short, human label for a mode. Used where a UI needs to explain a missing cost. */
export function describeBillingMode(mode: BillingMode): string {
	switch (mode) {
		case "metered":
			return "billed per token";
		case "subscription":
			return "included in your plan";
		case "local":
			return "runs on your machine";
		case "unknown":
			return "no pricing on record";
	}
}
