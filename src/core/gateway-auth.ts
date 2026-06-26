/**
 * Optional, multi-token authentication for the Brigade gateway.
 *
 * The gateway is localhost-only and UNAUTHENTICATED by default: every local
 * connection is the operator and is granted full scope (see the connection
 * handler in `core/server.ts`). That is the right default for a single-user
 * machine. When the operator configures one or more tokens — `gateway.auth`
 * in brigade.json, or the `BRIGADE_GATEWAY_TOKENS` env var — the gateway flips
 * to REQUIRING a valid token on every WebSocket connection, and `brigade
 * expose`'s auth-proxy accepts those same tokens.
 *
 * MULTIPLE tokens are supported on purpose: hand a distinct token to each
 * client/device, and revoke one without disturbing the others. Any token in
 * the list is equally valid.
 *
 * A token may travel three ways so browsers, CLIs, and WebSocket libraries can
 * all authenticate:
 *   - `Authorization: Bearer <token>`
 *   - `x-brigade-token: <token>` header
 *   - `?token=<token>` query string
 *
 * This module is the single source of truth shared by BOTH the gateway
 * connection gate and the expose auth-proxy, so the two can never drift.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Header carrying a raw token (no `Bearer ` prefix). Brigade-native name. */
export const TOKEN_HEADER = "x-brigade-token";

/**
 * Constant-time string equality. Returns `false` (never throws) when the
 * candidate is missing or a different length — `timingSafeEqual` itself throws
 * on length mismatch, so we guard that first. The length check is not itself
 * constant-time, but a token's length is not the secret; its bytes are.
 */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
	if (!provided) return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * `true` when `provided` equals ANY token in the list. Every token is compared
 * (no early `break`) so the elapsed time can't reveal which token matched, or
 * how many tokens are configured.
 */
export function matchesAnyToken(tokens: readonly string[], provided: string | undefined): boolean {
	if (!provided) return false;
	let ok = false;
	for (const t of tokens) {
		if (tokenMatches(t, provided)) ok = true;
	}
	return ok;
}

/** Pull a candidate token from the Authorization header, the token header, or `?token=`. */
export function extractToken(reqUrl: string | undefined, headers: IncomingHttpHeaders): string | undefined {
	const auth = headers["authorization"];
	if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
		const t = auth.slice(7).trim();
		if (t.length > 0) return t;
	}
	const hdr = headers[TOKEN_HEADER];
	if (typeof hdr === "string" && hdr.length > 0) return hdr;
	if (Array.isArray(hdr) && hdr.length > 0 && hdr[0]) return hdr[0];
	if (reqUrl) {
		const qIdx = reqUrl.indexOf("?");
		if (qIdx >= 0) {
			const t = new URLSearchParams(reqUrl.slice(qIdx + 1)).get("token");
			if (t) return t;
		}
	}
	return undefined;
}

/** Split a `BRIGADE_GATEWAY_TOKENS` value on commas and/or whitespace. */
function splitEnvTokens(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** The auth slice of `gateway` config this module reads. */
export interface GatewayAuthConfig {
	/** Explicit on/off override. `"none"` forces auth OFF even if tokens exist. */
	mode?: "none" | "token" | "password";
	/** Legacy single token (still honored, merged into the effective list). */
	token?: string;
	/** Multiple valid tokens. Any one authenticates a connection. */
	tokens?: readonly string[];
	password?: string;
}

/**
 * Effective token list = `auth.token` (legacy single) ∪ `auth.tokens` ∪
 * `BRIGADE_GATEWAY_TOKENS`, trimmed, blanks dropped, de-duplicated (order
 * preserved). An empty result means the gateway stays unauthenticated.
 */
export function resolveGatewayTokens(
	auth: GatewayAuthConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (t: string | undefined): void => {
		if (typeof t !== "string") return;
		const v = t.trim();
		if (v.length > 0 && !seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	};
	push(auth?.token);
	for (const t of auth?.tokens ?? []) push(t);
	for (const t of splitEnvTokens(env.BRIGADE_GATEWAY_TOKENS)) push(t);
	return out;
}

/**
 * Whether the gateway should ENFORCE a token. Auth is on when there is at
 * least one effective token AND the operator hasn't explicitly set
 * `auth.mode: "none"` (the off-switch). Returns the resolved token list too so
 * callers don't resolve twice.
 */
export function resolveGatewayAuth(
	auth: GatewayAuthConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): { required: boolean; tokens: string[] } {
	const tokens = resolveGatewayTokens(auth, env);
	const required = tokens.length > 0 && auth?.mode !== "none";
	return { required, tokens };
}

/** A fresh URL-safe token (192 bits of entropy, base64url, no padding). */
export function generateGatewayToken(): string {
	return randomBytes(24).toString("base64url");
}

/** Mask a token for display — first 4 + last 4, the middle elided. */
export function maskToken(token: string): string {
	if (token.length <= 8) return "*".repeat(Math.max(token.length, 1));
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Pick the token a LOCAL client should present to reach an authenticated
 * gateway on this machine. Priority: explicit override (a `--token` flag) →
 * the `BRIGADE_GATEWAY_TOKEN` env var → the first configured token. Returns
 * `undefined` when the gateway is unauthenticated — there is simply nothing to
 * send and the connection works exactly as before.
 */
export function resolveClientToken(
	auth: GatewayAuthConfig | undefined,
	opts: { override?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const override = opts.override?.trim();
	if (override) return override;
	const env = opts.env ?? process.env;
	const single = env.BRIGADE_GATEWAY_TOKEN?.trim();
	if (single) return single;
	return resolveGatewayTokens(auth, env)[0];
}

/** `ws` connection headers carrying the token, if any (empty object otherwise). */
export function clientAuthHeaders(token: string | undefined): Record<string, string> {
	return token ? { [TOKEN_HEADER]: token } : {};
}
