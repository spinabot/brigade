/**
 * Provider-agnostic consumption limits.
 *
 * Brigade drives many backends, and every one of them reports "how much have
 * you got left" differently:
 *
 *   - Claude CLI     — `rate_limit_event` frames carrying rolling plan windows
 *                      (5-hour, 7-day) with a reset instant and no counts.
 *   - Anthropic API  — `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`
 *                      response headers: real counts, ISO-8601 reset.
 *   - OpenAI         — `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`:
 *                      real counts, a DURATION string ("1s", "6m0s") not an instant.
 *   - Ollama / local — nothing, because there is nothing to limit.
 *
 * Rather than teach the UI four vocabularies, every transport normalizes into
 * the one `ProviderLimitWindow` shape below and records it here. A client then
 * renders limits without knowing or caring which backend produced them — which
 * is the whole point of a model-agnostic harness, and the reason this module
 * does not live under any one provider's directory.
 *
 * State is per-process and deliberately NOT persisted: a quota window's entire
 * value is freshness, and a stale window restored from disk would be worse than
 * showing nothing. `observedAt` lets a consumer age one out.
 */

/** Normalized status across every provider's own vocabulary. */
export type LimitStatus = "ok" | "throttled" | "exhausted" | "unknown";

/** One limit window, provider-neutral. */
export interface ProviderLimitWindow {
	/** Which backend reported it (`claude-cli`, `anthropic`, `openai`, …). */
	provider: string;
	/** Window identifier within that provider (`five_hour`, `requests`, `tokens`, …). */
	kind: string;
	/** Human label — "5-hour window", "requests", "tokens". */
	label: string;
	/** Normalized status. `exhausted` is the one a UI must never get wrong. */
	status: LimitStatus;
	/** Units left in the window, when the provider reports a count. */
	remaining?: number;
	/** Window size in the same units as `remaining`, when known. */
	limit?: number;
	/** Fraction of the window consumed (0..1), derived when both counts exist. */
	usedFraction?: number;
	/** Epoch MILLISECONDS when the window resets. */
	resetsAt?: number;
	/** True when the account is drawing on paid overage past its base allowance. */
	usingOverage?: boolean;
	/** Free-text detail a provider supplied (e.g. why overage is unavailable). */
	note?: string;
	/** Epoch ms when Brigade observed this, so a consumer can age it out. */
	observedAt: number;
}

type Listener = (windows: ProviderLimitWindow[]) => void;

/** Latest observation per `${provider}:${kind}`. */
const windows = new Map<string, ProviderLimitWindow>();
const listeners = new Set<Listener>();

const key = (provider: string, kind: string): string => `${provider}:${kind}`;

/**
 * Parse a reset value into epoch ms, accepting every shape providers actually
 * send. Returns `undefined` rather than guessing when the value is unusable —
 * a wrong reset instant ("resets 56 years ago") is worse than no reset shown.
 *
 *   - number  — epoch SECONDS if it looks like seconds, else already ms.
 *               Claude CLI sends seconds; storing those unconverted lands every
 *               reset in January 1970.
 *   - ISO-8601 string — Anthropic's header format.
 *   - duration string — OpenAI's format ("1s", "6m0s", "1h2m3s"), relative to now.
 */
export function parseResetAt(value: unknown, now = Date.now()): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// Epoch seconds for any plausible date is ~1e9-2e10; ms is ~1e12+.
		// The 1e11 split cleanly separates them for every date this century.
		return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	const raw = value.trim();

	// OpenAI duration form: 1h2m3s / 6m0s / 250ms / 1s
	const duration = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(raw);
	if (duration && raw !== "" && duration.slice(1).some((g) => g !== undefined)) {
		const h = Number(duration[1] ?? 0);
		const m = Number(duration[2] ?? 0);
		const s = Number(duration[3] ?? 0);
		const ms = Number(duration[4] ?? 0);
		const total = h * 3_600_000 + m * 60_000 + s * 1000 + ms;
		if (total > 0) return now + total;
	}

	const parsed = Date.parse(raw);
	if (Number.isFinite(parsed)) return parsed;
	return undefined;
}

/** Coerce a header value that should be an integer count. */
function toCount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value !== "string") return undefined;
	const n = Number(value.trim());
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Derive a status from counts when the provider gave no explicit one.
 *
 * The 10%-remaining threshold for `throttled` is a display hint only — nothing
 * in Brigade throttles on it. It exists so a UI can warn BEFORE the window is
 * spent, which is the only point at which the operator can still act.
 */
function statusFromCounts(remaining: number | undefined, limit: number | undefined): LimitStatus {
	if (remaining === undefined) return "unknown";
	if (remaining <= 0) return "exhausted";
	if (limit !== undefined && limit > 0 && remaining / limit <= 0.1) return "throttled";
	return "ok";
}

/**
 * Record one normalized observation.
 *
 * Notifies listeners only when a field a viewer would SEE has changed —
 * `observedAt` moves on every frame by definition, so comparing it would make
 * every observation a "change" and turn quota telemetry into a broadcast storm
 * on a chatty backend.
 */
export function recordLimit(window: ProviderLimitWindow): void {
	const k = key(window.provider, window.kind);
	const prev = windows.get(k);
	windows.set(k, window);
	const same =
		prev !== undefined &&
		prev.status === window.status &&
		prev.remaining === window.remaining &&
		prev.limit === window.limit &&
		prev.resetsAt === window.resetsAt &&
		prev.usingOverage === window.usingOverage;
	if (same) return;
	const snapshot = getLimits();
	for (const fn of [...listeners]) {
		try {
			fn(snapshot);
		} catch {
			/* a listener must never break the turn that produced the observation */
		}
	}
}

/**
 * Record from a standard rate-limit HEADER family — the shape every metered
 * HTTP provider uses. Handles both the `anthropic-ratelimit-*` and
 * `x-ratelimit-*` conventions, including OpenAI's inverted word order
 * (`x-ratelimit-remaining-tokens` vs `anthropic-ratelimit-tokens-remaining`).
 *
 * Returns the windows it recorded, so a caller can log or assert on them.
 */
export function recordLimitsFromHeaders(
	provider: string,
	headers: Record<string, string | string[] | undefined>,
	now = Date.now(),
): ProviderLimitWindow[] {
	const get = (name: string): string | undefined => {
		const v = headers[name] ?? headers[name.toLowerCase()];
		return Array.isArray(v) ? v[0] : v;
	};
	const recorded: ProviderLimitWindow[] = [];

	for (const kind of ["requests", "tokens"] as const) {
		// Both conventions, checked in order. Absent families are skipped entirely
		// rather than recorded as zeroes — "no data" and "none left" are opposites.
		const limit = toCount(get(`anthropic-ratelimit-${kind}-limit`) ?? get(`x-ratelimit-limit-${kind}`));
		const remaining = toCount(get(`anthropic-ratelimit-${kind}-remaining`) ?? get(`x-ratelimit-remaining-${kind}`));
		const resetRaw = get(`anthropic-ratelimit-${kind}-reset`) ?? get(`x-ratelimit-reset-${kind}`);
		if (limit === undefined && remaining === undefined && resetRaw === undefined) continue;

		const resetsAt = parseResetAt(resetRaw, now);
		const window: ProviderLimitWindow = {
			provider,
			kind,
			label: kind,
			status: statusFromCounts(remaining, limit),
			...(remaining !== undefined ? { remaining } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(remaining !== undefined && limit !== undefined && limit > 0
				? { usedFraction: Math.min(1, Math.max(0, 1 - remaining / limit)) }
				: {}),
			...(resetsAt !== undefined ? { resetsAt } : {}),
			observedAt: now,
		};
		recordLimit(window);
		recorded.push(window);
	}
	return recorded;
}

/** Every known window, newest observation first. */
export function getLimits(): ProviderLimitWindow[] {
	return [...windows.values()].sort((a, b) => b.observedAt - a.observedAt);
}

/** Windows for one provider only. */
export function getLimitsForProvider(provider: string): ProviderLimitWindow[] {
	return getLimits().filter((w) => w.provider === provider);
}

/** Subscribe to changes. Returns a disposer; calling it twice is a no-op. */
export function onLimitChange(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Test hook — drops all observations and listeners. */
export function resetLimitsForTest(): void {
	windows.clear();
	listeners.clear();
}
