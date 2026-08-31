/**
 * Protocol error catalogue (Step 24).
 *
 * Brand-scrubbed analogue of upstream's `src/gateway/protocol/schema/error-codes.ts`.
 * Six structured codes cover every condition the gateway responds to —
 * intentionally small so the client-side switch never grows unbounded.
 *
 * Convention: codes are SCREAMING_SNAKE_CASE strings, NOT numbers. The
 * `errorShape(code, message, opts)` helper centralises the construction
 * pattern so every emit site has the same shape.
 */

import type { ProtocolErrorShape } from "./messages.js";

export const ErrorCodes = {
	/** Gateway expected paired-device auth but the request had none. */
	NOT_LINKED: "NOT_LINKED",
	/** Caller is not paired with this gateway yet. */
	NOT_PAIRED: "NOT_PAIRED",
	/** Agent turn timed out — caller may retry with `retryable: true`. */
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
	/** Request shape failed validation. */
	INVALID_REQUEST: "INVALID_REQUEST",
	/** Approval lookup by id missed (id never existed or already resolved). */
	APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
	/** Subsystem is loading / draining; caller may retry shortly. */
	UNAVAILABLE: "UNAVAILABLE",
	/**
	 * The remaining codes the gateway actually emits today (previously
	 * undocumented string literals — catalogued here so a web/mobile client has
	 * the COMPLETE, stable set to branch on). Values match the on-the-wire
	 * strings the server already sends.
	 */
	/** Per-connection rate limiter tripped; honour `retryAfterMs`. */
	RATE_LIMITED: "rate-limited",
	/** Unexpected server-side failure handling the request. */
	INTERNAL: "internal",
	/** Caller lacks permission for the target (owner/session gate). */
	FORBIDDEN: "forbidden",
	/** Caller's operator scope is insufficient for this method. */
	SCOPE_INSUFFICIENT: "scope-insufficient",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorShapeOptions {
	details?: unknown;
	retryable?: boolean;
	retryAfterMs?: number;
}

/** Helper to construct a typed `ProtocolErrorShape` from one of the known codes. */
export function errorShape(
	code: ErrorCode,
	message: string,
	opts: ErrorShapeOptions = {},
): ProtocolErrorShape {
	return {
		code,
		message,
		...(opts.details !== undefined ? { details: opts.details } : {}),
		...(opts.retryable !== undefined ? { retryable: opts.retryable } : {}),
		...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
	};
}

/* ─────────────────── structured request failures ─────────────────── */

/**
 * A failed request, with the server's structured error intact.
 *
 * The wire has always carried `{ code, message, retryable, retryAfterMs,
 * details }` (see `ResponseFrame.error`), and the client collapsed all of it
 * into `new Error(message)` before any caller saw it. So no renderer could tell
 * a rate-limit that will clear in 30 seconds from a permanent authorization
 * failure — both arrived as an indistinguishable red line — and the retry
 * classifier the agent loop uses internally had no way to reach the screen.
 *
 * Extends `Error`, so every existing `catch (err) { err.message }` site keeps
 * working untouched; the extra fields are additive.
 */
export class BrigadeRequestError extends Error {
	/** One of `ErrorCodes`, or whatever the server sent. */
	readonly code: string;
	/** Server's judgement: is retrying this same request worthwhile? */
	readonly retryable: boolean | undefined;
	/** How long to wait before retrying, when the server said. */
	readonly retryAfterMs: number | undefined;
	/** Optional structured context. */
	readonly details: unknown;

	constructor(init: {
		code?: string | undefined;
		message?: string | undefined;
		retryable?: boolean | undefined;
		retryAfterMs?: number | undefined;
		details?: unknown;
	}) {
		const code = init.code ?? "unknown";
		super(init.message ?? `request failed (${code})`);
		this.name = "BrigadeRequestError";
		this.code = code;
		this.retryable = init.retryable;
		this.retryAfterMs = init.retryAfterMs;
		this.details = init.details;
	}
}

/** Narrow an unknown catch value to a structured request error. */
export function isBrigadeRequestError(err: unknown): err is BrigadeRequestError {
	return err instanceof BrigadeRequestError;
}

/**
 * Compare two error codes ignoring the catalogue's spelling drift.
 *
 * The codes are inconsistent by history — `NOT_LINKED` and `AGENT_TIMEOUT` are
 * SCREAMING_SNAKE while `rate-limited` and `internal` are kebab-case — so any
 * consumer grouping by raw string would split the same condition in two.
 * Normalizing at comparison time fixes that without a breaking wire change.
 */
export function sameErrorCode(a: string | undefined, b: string | undefined): boolean {
	const norm = (v: string | undefined): string => (v ?? "").toLowerCase().replace(/[_-]/g, "");
	return norm(a) === norm(b) && norm(a) !== "";
}

/**
 * A short, actionable suffix for a failed request — "retry in 30s", "retryable",
 * or nothing when the server gave no guidance.
 *
 * Kept here rather than in the TUI so a web client renders the same words.
 */
export function describeRetry(err: unknown): string | undefined {
	if (!isBrigadeRequestError(err)) return undefined;
	if (err.retryable === false) return "not retryable";
	if (typeof err.retryAfterMs === "number" && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) {
		const secs = Math.max(1, Math.round(err.retryAfterMs / 1000));
		return `retry in ${secs}s`;
	}
	if (err.retryable === true) return "retryable";
	return undefined;
}
