/**
 * Webhook + RPC guards — body-size cap, timeout, HMAC helpers.
 *
 * Used by the gateway's HTTP route dispatcher to enforce per-route guarantees
 * BEFORE a plugin's handler ever sees the request, and exposed to plugin
 * authors so a webhook handler can verify provider-signed payloads (Stripe,
 * GitHub, LINE, Slack, etc.) without re-implementing the careful crypto bits.
 *
 * Three primitives:
 *   - `readBodyWithLimit(req, res, opts)` — pre-buffer the body up to a byte
 *     cap. Sends `413 Payload Too Large` (or `408 Request Timeout`) directly
 *     and returns `null` so the handler can early-out. The cap defaults to
 *     1 MiB, mirroring the reference upstream's post-auth limit; the timeout
 *     defaults to 30s.
 *   - `computeHmacSha256(body, secret)` — canonical hex HMAC-SHA256 for the
 *     provider signature schemes that use hex (Stripe v1, GitHub `sha256=…`,
 *     etc). Returns the bare hex string so callers can prefix `sha256=` etc.
 *     to match the provider's wire format.
 *   - `safeEqualHmac(expected, actual)` — timing-safe string compare via
 *     `crypto.timingSafeEqual` on equal-length padded buffers. Avoids the
 *     early-exit length-leak that the naive `===` path has, and never
 *     throws on length mismatch (the LINE adapter taught us that one).
 *
 * Plugin-author contract: a webhook handler that opts into `auth: "none"`
 * MUST verify the signature itself — these helpers are the supported way.
 * Routes that opt into `auth: "operator"` are gated by the gateway before
 * the handler runs and can skip the HMAC step entirely.
 *
 * Replay defense (also author-facing): a valid signature does NOT prove a
 * payload is FRESH — a captured signed request replays forever. Pair
 * `verifyWebhookSignature` (multi-provider, computed over the RAW body,
 * fail-closed) with `verifyTimestampFresh` + a per-account `WebhookReplayGuard`
 * (delivery-id/nonce dedup) for at-most-once inbound processing.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Default cap when a route doesn't declare `maxBodyBytes`. Matches the reference upstream's post-auth limit. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Default timeout when a route doesn't declare `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000; // 30s

/**
 * Read a request body up to `maxBytes`. Streams the request, accumulating
 * chunks until either the body ends (returns the `Buffer`) or the running
 * total exceeds the cap (responds `413` + returns `null`). A per-call
 * timeout aborts the read and responds `408` if the client takes too long.
 *
 * Why pre-buffer at all? Plugin handlers want a `Buffer` they can HMAC-verify
 * against the provider's signature header. Letting the handler consume the
 * stream itself loses the size guard — and the typical "re-emit the chunks"
 * shim is a foot-gun (every author gets it slightly wrong). Buffering once,
 * up front, lands the body where it's wanted with the safety baked in.
 *
 * Always writes a JSON body on rejection so the caller (or curl) sees what
 * happened, never just a bare status line.
 */
export async function readBodyWithLimit(
	req: IncomingMessage,
	res: ServerResponse,
	opts?: { maxBytes?: number; timeoutMs?: number },
): Promise<Buffer | null> {
	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise<Buffer | null>((resolve) => {
		const chunks: Buffer[] = [];
		let received = 0;
		let settled = false;

		const finish = (value: Buffer | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("aborted", onAborted);
			resolve(value);
		};

		const writeStatus = (status: number, message: string): void => {
			if (!res.headersSent) {
				res.statusCode = status;
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify({ error: message }));
			} else if (!res.writableEnded) {
				try {
					res.end();
				} catch {
					/* socket already torn down */
				}
			}
		};

		const onData = (chunk: Buffer | string): void => {
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			received += buf.length;
			if (received > maxBytes) {
				writeStatus(413, `Payload too large (max ${maxBytes} bytes)`);
				// Drain the rest of the stream so the client doesn't hang on
				// a half-closed socket. Node ignores additional data after
				// res.end() but the request side still wants its end event.
				try {
					req.pause();
				} catch {
					/* ignore */
				}
				finish(null);
				return;
			}
			chunks.push(buf);
		};

		const onEnd = (): void => {
			finish(Buffer.concat(chunks, received));
		};

		const onError = (): void => {
			writeStatus(400, "Bad request body");
			finish(null);
		};

		const onAborted = (): void => {
			// Client hung up mid-body; nothing to respond with, just clean up.
			finish(null);
		};

		const timer = setTimeout(() => {
			writeStatus(408, `Request timeout (${timeoutMs}ms)`);
			finish(null);
		}, timeoutMs);
		// Don't keep the event loop alive on this timer alone.
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref: () => void }).unref();
		}

		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("aborted", onAborted);
	});
}

/**
 * Compute HMAC-SHA256 of `body` with `secret` and return the hex digest.
 * The hex shape is what GitHub (`sha256=…`), Stripe (`v1=…`), and most other
 * providers send on the wire; callers can prefix as needed.
 */
export function computeHmacSha256(body: Buffer | string, secret: string): string {
	const data = typeof body === "string" ? Buffer.from(body) : body;
	return createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Timing-safe HMAC compare. Always reads the same number of bytes regardless
 * of where the strings differ, and tolerates length mismatch by padding both
 * sides to the longest length before the constant-time compare (then returns
 * `false` if the original lengths differed). Never throws — a length mismatch
 * passed to `crypto.timingSafeEqual` directly would.
 *
 * Use for any string-vs-string secret comparison: HMAC hex digests, base64
 * signatures, shared-secret tokens. NOT for password hashes — use a slow KDF
 * for those (bcrypt/argon2).
 */
export function safeEqualHmac(expected: string, actual: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(actual);
	const maxLen = Math.max(a.length, b.length);
	// Allocate fixed-length buffers so timingSafeEqual never throws on
	// mismatched lengths. We still return false below when the original
	// lengths differ — the constant-time compare is just for the bytes.
	const padA = Buffer.alloc(maxLen);
	const padB = Buffer.alloc(maxLen);
	a.copy(padA);
	b.copy(padB);
	// Call timingSafeEqual unconditionally so the && short-circuit can't
	// leak length information through wall-clock timing.
	const bytesEqual = timingSafeEqual(padA, padB);
	return a.length === b.length && bytesEqual;
}

/**
 * Reject STALE or REPLAYED webhook deliveries. A provider signature proves a
 * payload was signed with the shared secret — it does NOT prove the payload is
 * fresh: a captured signed request is otherwise replayable forever. Pair
 * `verifyTimestampFresh` (reject deliveries outside a clock-skew window) with
 * `WebhookReplayGuard` (reject a delivery-id/nonce seen before) for at-most-once
 * inbound processing. Both are author-facing, same as the HMAC helpers above.
 */

/** True if `tsMs` is within `windowMs` of now (default ±5 min). Reject otherwise. */
export function verifyTimestampFresh(tsMs: number, opts: { windowMs?: number; nowMs?: number } = {}): boolean {
	if (!Number.isFinite(tsMs)) return false;
	const windowMs = opts.windowMs && opts.windowMs > 0 ? opts.windowMs : 300_000;
	const nowMs = opts.nowMs ?? Date.now();
	return Math.abs(nowMs - tsMs) <= windowMs;
}

/**
 * Bounded, TTL'd dedup of webhook delivery ids / nonces. `check(id)` returns
 * `true` if `id` was already seen within the TTL (a REPLAY — reject it) and
 * `false` otherwise (first sight — recorded, accept). Size-capped with oldest-
 * first eviction so a flood can't grow it unbounded; entries also expire by TTL.
 * One instance per webhook account/channel (held in the adapter's runtime).
 */
export class WebhookReplayGuard {
	private readonly seen = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
		this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 300_000;
		this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : 5000;
	}

	/** Record `id` and report whether it was a replay. Empty id → not a replay
	 *  (the caller should fall back to timestamp-only freshness in that case). */
	check(id: string, nowMs: number = Date.now()): boolean {
		if (!id) return false;
		const exp = this.seen.get(id);
		if (exp !== undefined && exp > nowMs) return true; // within TTL → replay
		// (Re)insert at the tail; Map preserves insertion order for oldest-first eviction.
		this.seen.delete(id);
		this.seen.set(id, nowMs + this.ttlMs);
		while (this.seen.size > this.maxEntries) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			this.seen.delete(oldest);
		}
		return false;
	}

	/** Tracked-id count (diagnostics/tests). */
	get size(): number {
		return this.seen.size;
	}
}

export type WebhookSignatureProvider = "github" | "slack" | "gitlab" | "hmac-sha256";

/** Case-insensitive header lookup (Node lowercases inbound headers, but be defensive). */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
	}
	return undefined;
}

/**
 * Verify a provider-signed webhook over the RAW body bytes. The HMAC MUST be
 * computed BEFORE any JSON parse — re-serializing a parsed body changes the
 * bytes and breaks the signature, the single most common webhook-auth bug. Fails
 * CLOSED: a missing/blank secret or a missing expected header returns
 * `{ok:false}` rather than silently skipping the check. For Slack it also
 * enforces the signed timestamp's freshness (the v0 signature covers the ts, so
 * a replay outside the window fails here without a separate guard).
 */
export function verifyWebhookSignature(
	provider: WebhookSignatureProvider,
	args: {
		headers: Record<string, string | string[] | undefined>;
		rawBody: Buffer | string;
		secret: string;
		nowMs?: number;
		timestampWindowMs?: number;
	},
): { ok: boolean; reason?: string } {
	const { headers, rawBody, secret } = args;
	if (!secret) return { ok: false, reason: "no signing secret configured" };
	switch (provider) {
		case "github": {
			const sig = headerValue(headers, "x-hub-signature-256");
			if (!sig) return { ok: false, reason: "missing x-hub-signature-256 header" };
			return { ok: safeEqualHmac(`sha256=${computeHmacSha256(rawBody, secret)}`, sig) };
		}
		case "gitlab": {
			const token = headerValue(headers, "x-gitlab-token");
			if (!token) return { ok: false, reason: "missing x-gitlab-token header" };
			return { ok: safeEqualHmac(secret, token) };
		}
		case "slack": {
			const sig = headerValue(headers, "x-slack-signature");
			const ts = headerValue(headers, "x-slack-request-timestamp");
			if (!sig || !ts) return { ok: false, reason: "missing slack signature/timestamp headers" };
			const fresh = verifyTimestampFresh(Number(ts) * 1000, {
				...(args.timestampWindowMs !== undefined ? { windowMs: args.timestampWindowMs } : {}),
				...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
			});
			if (!fresh) return { ok: false, reason: "stale or invalid slack timestamp" };
			const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
			return { ok: safeEqualHmac(`v0=${computeHmacSha256(`v0:${ts}:${body}`, secret)}`, sig) };
		}
		case "hmac-sha256": {
			const sig = headerValue(headers, "x-webhook-signature");
			if (!sig) return { ok: false, reason: "missing x-webhook-signature header" };
			const normalized = sig.startsWith("sha256=") ? sig.slice(7) : sig;
			return { ok: safeEqualHmac(computeHmacSha256(rawBody, secret), normalized) };
		}
		default:
			return { ok: false, reason: "unknown signature provider" };
	}
}
