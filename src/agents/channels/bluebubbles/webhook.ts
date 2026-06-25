/**
 * BlueBubbles inbound gateway route.
 *
 * BlueBubbles POSTs each event to a Brigade gateway HTTP route. Because a
 * BlueBubbles webhook CANNOT send custom headers, the server PASSWORD is embedded
 * in the registered webhook URL's QUERY STRING (`?password=…` / `?guid=…`) and
 * verified on each inbound POST. (Some BlueBubbles versions also send the token
 * as a header — those are accepted too.) Verification happens FIRST, before the
 * body is parsed / routed, so a forged event can't reach the agent.
 *
 * Mirrors `slack/webhook.ts` (the webhook-ingress blueprint): build an
 * `HttpRoute`, register it via `b.httpRoute(...)` from the module, resolve the
 * started adapter (`resolveSink`) at REQUEST time (late binding — the route is
 * registered before the plugin starts accounts), always reply 200 so BlueBubbles
 * doesn't retry-storm.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpRoute } from "../sdk.js";

/** Cap on the webhook body (a BlueBubbles event is small; 4 MiB is generous). */
const WEBHOOK_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Default fixed-window rate-limit: max authenticated requests per window. */
export const WEBHOOK_RATE_LIMIT_MAX = 240;
/** Default fixed-window length (ms). 240 req / 10s ≈ 24 rps sustained per account. */
export const WEBHOOK_RATE_LIMIT_WINDOW_MS = 10_000;
/** Default bound on concurrently in-flight handler bodies (normalize/dedupe/dispatch). */
export const WEBHOOK_MAX_IN_FLIGHT = 32;

/**
 * A fixed-window request rate-limiter. `hit()` records one request against the
 * current window and returns whether it is WITHIN the limit. The window resets
 * lazily on the first hit after it elapses (no timers held). Self-contained so
 * the webhook route can bound a replay-storm / hostile sender on the `auth:none`
 * path without a central dependency.
 */
export interface FixedWindowRateLimiter {
	/** Record a request; returns true when it is allowed (within the window's cap). */
	hit(nowMs?: number): boolean;
}

/** Build a fixed-window rate limiter (`max` requests per `windowMs`). */
export function createFixedWindowRateLimiter(max: number, windowMs: number): FixedWindowRateLimiter {
	const cap = Math.max(1, Math.floor(max));
	const span = Math.max(1, Math.floor(windowMs));
	let windowStart = 0;
	let count = 0;
	return {
		hit(nowMs = Date.now()): boolean {
			if (nowMs - windowStart >= span) {
				windowStart = nowMs;
				count = 0;
			}
			count++;
			return count <= cap;
		},
	};
}

/**
 * A bounded concurrency gate. `tryAcquire()` reserves a slot (returns a release
 * fn) or returns null when the cap is already reached. The handler releases its
 * slot in a `finally` so a thrown handler can't leak the count.
 */
export interface InFlightLimiter {
	tryAcquire(): (() => void) | null;
	inFlight(): number;
}

/** Build an in-flight concurrency limiter capped at `max` simultaneous holders. */
export function createInFlightLimiter(max: number): InFlightLimiter {
	const cap = Math.max(1, Math.floor(max));
	let active = 0;
	return {
		tryAcquire(): (() => void) | null {
			if (active >= cap) return null;
			active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				active--;
			};
		},
		inFlight: () => active,
	};
}

/** Constant-time compare of two strings — avoids leaking via timing. */
export function safeEqualToken(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
	} catch {
		return false;
	}
}

/**
 * Verify a BlueBubbles webhook request's password. The supplied token comes from
 * the URL query (`password` / `guid`) or, when present, a header. When
 * `expectedPassword` is empty the check is SKIPPED (returns true) — the operator
 * opted out (not recommended). Returns false when a password is configured but
 * the supplied one is missing / wrong.
 */
export function verifyBlueBubblesWebhook(args: {
	expectedPassword: string;
	suppliedToken: string | undefined;
}): boolean {
	if (!args.expectedPassword) return true; // no password configured → skip
	const supplied = (args.suppliedToken ?? "").trim();
	if (!supplied) return false;
	return safeEqualToken(supplied, args.expectedPassword);
}

/** Pull the auth token from the request URL query or a header. */
function extractSuppliedToken(req: IncomingMessage): string | undefined {
	// URL query (BlueBubbles can't set custom headers, so this is the primary path).
	const rawUrl = req.url ?? "";
	const qIdx = rawUrl.indexOf("?");
	if (qIdx >= 0) {
		const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
		const fromQuery = params.get("password") ?? params.get("guid");
		if (fromQuery) return fromQuery;
	}
	// Header fallbacks (some BB proxy setups inject them).
	const header = (name: string): string | undefined => {
		const v = req.headers[name];
		const s = Array.isArray(v) ? v[0] : v;
		return s ? s.replace(/^Bearer\s+/i, "").trim() : undefined;
	};
	return header("x-password") ?? header("x-guid") ?? header("x-bluebubbles-guid") ?? header("authorization");
}

/** Read a request body up to `maxBytes`, rejecting (→ null) when it overflows. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflowed = false;
		req.on("data", (chunk: Buffer) => {
			if (overflowed) return;
			size += chunk.length;
			if (size > maxBytes) {
				overflowed = true;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (overflowed) return;
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", () => resolve(null));
	});
}

/**
 * Parse the request body. BlueBubbles delivers JSON; a form-encoded fallback
 * (some proxy setups) carries the JSON under a `payload`/`data` field.
 */
export function parseBlueBubblesBody(rawBody: string, contentType: string): { type?: string; payload: unknown } | null {
	const ct = (contentType ?? "").toLowerCase();
	const tryJson = (s: string): Record<string, unknown> | null => {
		try {
			const v = JSON.parse(s);
			return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};
	let body: Record<string, unknown> | null = null;
	if (ct.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(rawBody);
		const inner = params.get("payload") ?? params.get("data") ?? params.get("message");
		if (inner) body = tryJson(inner);
	}
	if (!body) body = tryJson(rawBody);
	if (!body) return null;
	const type = typeof body.type === "string" ? body.type : undefined;
	return { ...(type ? { type } : {}), payload: body };
}

/** The minimal adapter surface the webhook route drives. */
export interface BlueBubblesWebhookSink {
	/** Feed a parsed BlueBubbles webhook event into the inbound path. */
	feedWebhookEvent(eventType: string | undefined, payload: unknown): void;
}

export interface BuildBlueBubblesWebhookRouteArgs {
	/** The gateway route path (e.g. `/bluebubbles/webhook`). */
	path: string;
	/** The configured server password (`""` → no auth check). */
	password: string;
	/** Resolve the started adapter to feed events into (null when not started). */
	resolveSink: () => BlueBubblesWebhookSink | null;
	/** Logger. */
	log?: (msg: string, meta?: Record<string, unknown>) => void;
	/** Max authenticated requests per window before throttling (default {@link WEBHOOK_RATE_LIMIT_MAX}). */
	rateLimitMax?: number;
	/** Fixed-window length in ms (default {@link WEBHOOK_RATE_LIMIT_WINDOW_MS}). */
	rateLimitWindowMs?: number;
	/** Max concurrently in-flight handler bodies (default {@link WEBHOOK_MAX_IN_FLIGHT}). */
	maxInFlight?: number;
	/** TEST SEAM — inject the clock used by the rate limiter. */
	now?: () => number;
}

/**
 * Build the Brigade `HttpRoute` for the BlueBubbles webhook. Register it via
 * `b.httpRoute(...)` from the module.
 */
export function buildBlueBubblesWebhookRoute(args: BuildBlueBubblesWebhookRouteArgs): HttpRoute {
	// Per-route limiters (one route = one account). Built once and closed over so
	// the window/in-flight counters persist across requests.
	const rateLimiter = createFixedWindowRateLimiter(
		args.rateLimitMax ?? WEBHOOK_RATE_LIMIT_MAX,
		args.rateLimitWindowMs ?? WEBHOOK_RATE_LIMIT_WINDOW_MS,
	);
	const inFlight = createInFlightLimiter(args.maxInFlight ?? WEBHOOK_MAX_IN_FLIGHT);

	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const reply = (status: number, body: unknown): void => {
			res.statusCode = status;
			res.setHeader("content-type", "application/json");
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		};

		if ((req.method ?? "").toUpperCase() !== "POST") {
			reply(405, { ok: false, error: "method not allowed" });
			return;
		}

		// Auth FIRST — verify the password before reading / parsing the body.
		const supplied = extractSuppliedToken(req);
		if (!verifyBlueBubblesWebhook({ expectedPassword: args.password, suppliedToken: supplied })) {
			args.log?.("bluebubbles webhook rejected — bad password");
			reply(401, { ok: false, error: "unauthorized" });
			return;
		}

		// Rate-limit the authenticated stream — a replay-storm / hostile sender that
		// has the password must not run the normalize/dedupe/dispatch path
		// unbounded. Over-limit requests are dropped with 429 BEFORE the body is
		// read, so the cost of an abusive burst is bounded.
		if (!rateLimiter.hit(args.now?.())) {
			args.log?.("bluebubbles webhook throttled — over rate limit");
			reply(429, { ok: false, error: "rate limited" });
			return;
		}

		// Bound concurrent in-flight handler bodies. When the cap is reached, shed
		// load with 429 rather than letting unbounded parses/dispatches pile up.
		const release = inFlight.tryAcquire();
		if (!release) {
			args.log?.("bluebubbles webhook throttled — in-flight cap reached");
			reply(429, { ok: false, error: "busy" });
			return;
		}
		try {
			// The gateway dispatcher has ALREADY drained + buffered the body onto
			// `req.body`. Read that first; only stream when exercised outside the gateway.
			const pre = (req as IncomingMessage & { body?: Buffer }).body;
			const raw = pre ? pre.toString("utf8") : await readBody(req, WEBHOOK_MAX_BODY_BYTES);
			if (raw === null) {
				reply(413, { ok: false, error: "payload too large" });
				return;
			}

			const contentType = (() => {
				const c = req.headers["content-type"];
				return Array.isArray(c) ? (c[0] ?? "") : (c ?? "");
			})();
			const parsed = parseBlueBubblesBody(raw, contentType);
			if (!parsed) {
				reply(400, { ok: false, error: "invalid body" });
				return;
			}

			const sink = args.resolveSink();
			if (sink) {
				try {
					sink.feedWebhookEvent(parsed.type, parsed.payload);
				} catch (err) {
					args.log?.("bluebubbles webhook dispatch threw", { error: err instanceof Error ? err.message : String(err) });
				}
			}
			// Always 200 so BlueBubbles doesn't retry-storm.
			reply(200, { ok: true });
		} finally {
			release();
		}
	};

	return {
		method: "POST",
		path: args.path,
		auth: "none", // BlueBubbles can't present operator-auth; the password query IS the auth.
		match: "exact",
		maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
		skipSessionGuard: true,
		handler,
	};
}
