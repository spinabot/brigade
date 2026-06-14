// src/storage/convex/client.ts
//
// Convex HTTP client bootstrap. Lazy-initialised, process-wide singleton so
// every sub-store reuses the same connection + transport. We deliberately
// use `ConvexHttpClient` (not the reactive `ConvexClient`) because the
// gateway is server-side Node — reactive WebSockets are wired LATER
// when the dashboard / live-query layer ships.

import { ConvexClient, ConvexHttpClient } from "convex/browser";

import { resolveStateDir } from "../../config/paths.js";

let _client: ConvexHttpClient | undefined;
let _reactive: ConvexClient | undefined;
let _resolvedUrl: string | undefined;

/**
 * Resolve the Convex deployment URL. Priority:
 *   1. `args.url` (explicit override from RuntimeContext)
 *   2. `BRIGADE_CONVEX_URL` env var
 *   3. `CONVEX_URL` env var (matches the `.env.local` written by
 *      scripts/convex-dev.mjs)
 *   4. `CONVEX_SELF_HOSTED_URL` env var (matches the self-hosted CLI vars)
 *
 * Throws when no URL is resolvable — convex mode without a URL is a
 * configuration error, not a silent fallback to filesystem.
 */
export function resolveConvexUrl(args: { url?: string } = {}): string {
	if (args.url && args.url.trim().length > 0) return args.url.trim();
	const candidates = [
		process.env.BRIGADE_CONVEX_URL,
		process.env.CONVEX_URL,
		process.env.CONVEX_SELF_HOSTED_URL,
	];
	for (const raw of candidates) {
		if (raw && raw.trim().length > 0) return raw.trim();
	}
	// Last resort — when a previous `getConvexClient(args)` cached a URL,
	// reuse it. This lets sub-store `subscribe` paths (which don't carry
	// the constructor's URL) reach the same backend without an env var.
	if (_resolvedUrl) return _resolvedUrl;
	throw new Error(
		"Convex mode requires a deployment URL. Set BRIGADE_CONVEX_URL (or CONVEX_URL) " +
			"to your backend, or run `brigade store mode set convex --convex-url http://127.0.0.1:3210`.",
	);
}

/**
 * Get-or-create the process-wide Convex HTTP client (one-shot queries +
 * mutations). Subsequent calls with a different URL re-create the client
 * (so tests can switch backends), but production code passes the URL
 * once at boot and never again.
 */
export function getConvexClient(args: { url?: string } = {}): ConvexHttpClient {
	const url = resolveConvexUrl(args);
	if (_client && _resolvedUrl === url) return _client;
	_client = new ConvexHttpClient(url);
	_resolvedUrl = url;
	return _client;
}

/**
 * Get-or-create the process-wide reactive Convex client (WebSocket — for
 * `subscribe(...)` paths). Brigade lazily instantiates this only when a
 * subscription is first taken so non-subscribing call sites don't pay the
 * connection cost. Reset when the URL changes (test-only).
 */
export function getReactiveConvexClient(args: { url?: string } = {}): ConvexClient {
	const url = resolveConvexUrl(args);
	if (_reactive && _resolvedUrl === url) return _reactive;
	// If the URL changed, dispose the old reactive client first.
	if (_reactive) {
		try {
			_reactive.close();
		} catch {
			// Idempotent close; ignore.
		}
	}
	_reactive = new ConvexClient(url);
	_resolvedUrl = url;
	return _reactive;
}

/** Reset the cached clients. Tests only. */
export function __resetConvexClientForTests(): void {
	if (_reactive) {
		try {
			_reactive.close();
		} catch {
			// Idempotent.
		}
	}
	_client = undefined;
	_reactive = undefined;
	_resolvedUrl = undefined;
}

/**
 * Resolve a stable per-machine `instanceId`. Convex tables use this as the
 * per-operator key (single-operator Phase 2; multi-tenant maps it to the
 * tenant id in Phase 3 — see `project_brigade_ip_split` memory).
 *
 * For Phase 2 we derive instanceId from `<stateDir>/mode.sentinel`'s host-
 * machine name. The convex orchestrator also writes a deterministic
 * `brigade-local` name to its own identity.json; we can read either but
 * we prefer the sentinel since it's a Brigade-owned file.
 */
export function resolveInstanceId(stateDir: string = resolveStateDir()): string {
	// Phase 2 simplification: the sentinel doesn't carry an instanceId field
	// yet, and the operator hostname is private. Use a constant for now —
	// every brigade install has exactly one instance. Phase 3 will switch
	// this to the tenant id from `brigade-cloud`'s overlay.
	void stateDir;
	return "brigade-local";
}

/**
 * Derive the ownerId. In Phase 2 single-operator this is always the same
 * value as `resolveInstanceId`. Phase 3 multi-tenant separates them so the
 * same instance can hold many operators.
 */
export function resolveOwnerId(stateDir: string = resolveStateDir()): string {
	return resolveInstanceId(stateDir);
}
