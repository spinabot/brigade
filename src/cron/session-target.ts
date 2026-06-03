/**
 * Session-target validation for cron jobs.
 *
 * `sessionTarget` selects where the cron's work lands:
 *   - `"main"`     — operator's primary session (must pair with `systemEvent`).
 *   - `"isolated"` — fresh per-run session (must pair with `agentTurn`).
 *   - `"session:<id>"` — named persistent session (must pair with `agentTurn`).
 *
 * The `<id>` portion needs guard-railing because it lands in:
 *   - A session-key string that flows to disk paths.
 *   - The session-store entry's key.
 *
 * Anything path-special (`/`, `\`, NUL) OR control-char-like would let a
 * malicious cron spec break out of its directory. Empty strings would create
 * keyless entries that collide with the bare `session:` parse.
 *
 * Used by `assertSupportedJobSpec` (in `service/jobs.ts`) to refuse bad
 * specs before they hit disk.
 */

import type { CronSessionTarget } from "./types.js";

const SESSION_PREFIX = "session:";

/** Custom error for invalid session-target ids — caller may translate. */
export class InvalidCronSessionTargetIdError extends Error {
	readonly id: string;
	constructor(id: string, reason: string) {
		super(`invalid cron sessionTarget session id "${id}": ${reason}`);
		this.name = "InvalidCronSessionTargetIdError";
		this.id = id;
	}
}

/**
 * Discriminator for the cron RPC layer's soft-OK degrade path
 * (`cron.run` returns `{ok:true, ran:false, reason:"invalid-spec"}` when
 * a persisted sessionTarget id is malformed). Instance-of catches the
 * structured throw; the name-fallback covers cross-realm cases (workers,
 * vm contexts) where the prototype chain doesn't survive.
 */
export function isInvalidCronSessionTargetIdError(err: unknown): boolean {
	if (err instanceof InvalidCronSessionTargetIdError) return true;
	if (err && typeof err === "object" && (err as { name?: unknown }).name === "InvalidCronSessionTargetIdError") {
		return true;
	}
	return false;
}

/** Narrowing type-guard: is this string a `"session:<id>"` form? */
export function isSessionTargetWithId(value: string): value is `session:${string}` {
	return value.startsWith(SESSION_PREFIX);
}

/** Extract the `<id>` portion of `"session:<id>"`. Returns `""` if not. */
export function extractSessionTargetId(value: string): string {
	if (!isSessionTargetWithId(value)) return "";
	return value.slice(SESSION_PREFIX.length);
}

/**
 * Throws `InvalidCronSessionTargetIdError` if the id is unsafe to use as a
 * session-key segment. Used by `assertSupportedJobSpec` for `"session:*"`
 * targets only; other targets (`main`, `isolated`) skip this check.
 *
 * Rules: non-empty, no `/`, no `\`, no NUL, no control chars (anything <
 * 0x20 or === 0x7f).
 */
export function assertSafeCronSessionTargetId(id: string): void {
	if (id.length === 0) {
		throw new InvalidCronSessionTargetIdError(id, "must not be empty");
	}
	if (id.includes("/") || id.includes("\\")) {
		throw new InvalidCronSessionTargetIdError(id, "must not contain path separators");
	}
	for (let i = 0; i < id.length; i++) {
		const c = id.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) {
			throw new InvalidCronSessionTargetIdError(id, "must not contain control characters");
		}
	}
}

/**
 * Type-guard / narrowing for the full union. Returns true only for the three
 * shapes Brigade accepts: `"main"`, `"isolated"`, `"session:<safe-id>"`.
 *
 * Note this is permissive about the id-safety check — it returns `true` for
 * any `session:*` shape. Use `assertSafeCronSessionTargetId` for the strict
 * version that throws.
 */
export function isValidCronSessionTarget(value: string): value is CronSessionTarget {
	// `current` is a create-time alias — the input layer must accept it so
	// callers (agent tool / RPC) can pass the literal, and the normalizer
	// later resolves it to `session:<id>` or `"isolated"`. After resolution
	// the persisted value will never be `"current"` again, but defensive
	// downstream callers (assertSupportedJobSpec, delivery-plan) still
	// recognise it for safety against hand-edited cron.json.
	if (value === "main" || value === "isolated" || value === "current") return true;
	return isSessionTargetWithId(value);
}
