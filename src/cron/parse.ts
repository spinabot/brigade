/**
 * Absolute-time string parser for cron schedules.
 *
 * Single decoder for two callers:
 *   - `schedule.at`   — input layer (agent tool / RPC) accepts ISO-8601
 *     strings; we convert here.
 *   - `schedule.atMs` — legacy alias; accepts numeric ms OR digit-string ms.
 *
 * Three input shapes, one entry point:
 *   1. Pure-digit string  → treated as epoch ms.
 *   2. ISO with explicit tz suffix `Z` / `[+-]HH:MM` / `[+-]HHMM` → passed to
 *      `Date.parse` as-is.
 *   3. ISO without tz suffix → UTC fallback (deterministic, no local-time
 *      surprises):
 *        - bare `YYYY-MM-DD`  → suffix `T00:00:00Z`
 *        - `YYYY-MM-DDT...`   → suffix `Z`
 *        - `YYYY-MM-DD ...`   → separator rewritten to `T`, then suffix `Z`
 *          (the space form is ISO-legal and common; left alone `Date.parse`
 *          reads it as LOCAL time, making the resolved fire-time depend on the
 *          host's timezone)
 *
 * Returns `null` for anything `Date.parse` rejects; caller decides whether
 * to throw or fall back. Never throws itself.
 *
 * Mirrored from the upstream reference cron parser (parse.ts) so Brigade
 * accepts the same caller surface — ISO-string `at` from agent tools while
 * keeping the on-disk `at` field as epoch ms (Brigade's persisted shape;
 * see `CronScheduleAt.at: number` in `types.ts`).
 */

const ISO_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The date/time separator is `T` OR a single space — both are ISO-8601 (the
// space form is what `datetime.strftime("%Y-%m-%d %H:%M:%S")`, SQL literals
// and plenty of agent-authored timestamps actually emit).
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]/;

function normalizeUtcIso(raw: string): string {
	if (ISO_TZ_RE.test(raw)) {
		return raw;
	}
	if (ISO_DATE_RE.test(raw)) {
		return `${raw}T00:00:00Z`;
	}
	if (ISO_DATE_TIME_RE.test(raw)) {
		// Rewrite the separator to `T` before stamping `Z`. Without this the
		// space form reaches `Date.parse` unadorned, which reads it as LOCAL
		// time — so a tz-less `at` schedule resolved to a different instant
		// depending on the gateway host's timezone, which is exactly the
		// "deterministic, no local-time surprises" this function promises.
		return `${raw.replace(ISO_DATE_TIME_RE, (m) => `${m.slice(0, 10)}T`)}Z`;
	}
	return raw;
}

export function parseAbsoluteTimeMs(input: string): number | null {
	const raw = input.trim();
	if (!raw) {
		return null;
	}
	if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0) {
			return Math.floor(n);
		}
	}
	const parsed = Date.parse(normalizeUtcIso(raw));
	return Number.isFinite(parsed) ? parsed : null;
}
