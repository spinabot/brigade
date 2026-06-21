/**
 * Telegram webhook gateway route.
 *
 * In webhook transport mode (`channels.telegram.mode: "webhook"`) Telegram POSTs
 * each update to a public URL instead of Brigade polling `getUpdates`. This
 * module builds the Brigade `HttpRoute` that receives those POSTs:
 *
 *   1. Verify the `X-Telegram-Bot-Api-Secret-Token` header against the
 *      configured secret (constant-time compare). A mismatch → 401, BEFORE the
 *      body is parsed, so a forged update can't reach the agent.
 *   2. Parse the JSON body as a Telegram `Update`.
 *   3. Hand it to the started Telegram adapter's `feedWebhookUpdate`, which runs
 *      it through the SAME normalize + dedupe + dispatch path as polling.
 *   4. Reply `200 {"ok":true}` so Telegram marks the update delivered.
 *
 * The route is registered with `auth: "none"` because Telegram authenticates via
 * the secret-token header, not Brigade's operator-auth (Telegram can't present
 * an operator credential). The secret-token check IS the auth.
 *
 * Polling mode never registers this route — it's added by the module only when
 * webhook mode is configured, so the default local-first install exposes no
 * inbound HTTP surface.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { HttpRoute } from "../sdk.js";

/** The header Telegram sends carrying the configured secret token. */
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** Cap on the webhook body (a Telegram update is small; 1 MiB is generous). */
const WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Constant-time string compare — avoids leaking the secret via timing. */
export function safeEqualSecret(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Verify the inbound secret-token header. When no secret is configured the check
 * passes (the operator opted out of header verification) — but configuring a
 * secret is strongly recommended and the setWebhook call always sends one.
 */
export function hasValidTelegramWebhookSecret(headerValue: string | undefined, expected: string): boolean {
	if (!expected) return true; // no secret configured → no header check
	if (typeof headerValue !== "string" || headerValue.length === 0) return false;
	return safeEqualSecret(headerValue, expected);
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

/** The minimal adapter surface the webhook route drives. */
export interface TelegramWebhookSink {
	/** Feed a parsed Telegram update into the inbound path. */
	feedWebhookUpdate(update: unknown): void;
}

export interface BuildTelegramWebhookRouteArgs {
	/** The gateway route path (e.g. `/telegram/webhook`). */
	path: string;
	/** The configured secret token (`""` → no header check). */
	secretToken: string;
	/** Resolve the started adapter to feed updates into (null when not started). */
	resolveSink: () => TelegramWebhookSink | null;
	/** Logger (token-redacted upstream). */
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Build the Brigade `HttpRoute` for the Telegram webhook. Register it via
 * `b.httpRoute(...)` from the module when webhook mode is active.
 */
export function buildTelegramWebhookRoute(args: BuildTelegramWebhookRouteArgs): HttpRoute {
	const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// Only POST carries updates.
		if ((req.method ?? "").toUpperCase() !== "POST") {
			res.statusCode = 405;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
			return;
		}
		// Secret-token check FIRST — refuse a forged update before parsing.
		const headerVal = req.headers[TELEGRAM_WEBHOOK_SECRET_HEADER];
		const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
		if (!hasValidTelegramWebhookSecret(headerStr, args.secretToken)) {
			args.log?.("telegram webhook rejected — bad secret token");
			res.statusCode = 401;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
			return;
		}
		const raw = await readBody(req, WEBHOOK_MAX_BODY_BYTES);
		if (raw === null) {
			res.statusCode = 413;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: false, error: "payload too large" }));
			return;
		}
		let update: unknown;
		try {
			update = JSON.parse(raw);
		} catch {
			res.statusCode = 400;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: false, error: "invalid json" }));
			return;
		}
		const sink = args.resolveSink();
		if (sink) {
			try {
				sink.feedWebhookUpdate(update);
			} catch (err) {
				args.log?.("telegram webhook dispatch threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// Always 200 so Telegram doesn't retry-storm — a dispatch error is ours to
		// fix, not Telegram's to redeliver.
		res.statusCode = 200;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ ok: true }));
	};

	return {
		method: "POST",
		path: args.path,
		auth: "none", // Telegram can't present operator-auth; the secret-token header IS the auth.
		match: "exact",
		maxBodyBytes: WEBHOOK_MAX_BODY_BYTES,
		skipSessionGuard: true,
		handler,
	};
}
