// src/storage/boot.ts
//
// Process-boot entry for the storage layer. Every Brigade process calls
// `bootRuntimeContext()` exactly once before any subsystem touches state;
// after that, subsystems reach storage via `getRuntimeContext().store`.
//
// Idempotent by design: the CLI preAction hook, the gateway server, and any
// future embedder can all call it — the first caller pays the resolution +
// `store.init()` cost, everyone else gets the already-frozen context. A
// failed boot clears the in-flight slot so a retry (e.g. convex backend came
// back up) can succeed instead of replaying a cached rejection.

import { primeConfigCache } from "./config-cache.js";
import { primeSessionCache } from "./session-cache.js";
import {
	createRuntimeContext,
	setRuntimeContext,
	tryGetRuntimeContext,
	type RuntimeContext,
} from "./runtime-context.js";
import type { BrigadeStore } from "./store.js";

let _inflight: Promise<RuntimeContext> | undefined;

/** Resolve mode, build + init the store, and install the process-wide
 *  RuntimeContext. Safe to call from multiple places — only the first call
 *  does work. Throws when the backing store cannot initialise (e.g. convex
 *  mode with an unreachable deployment); callers that can operate without
 *  storage (doctor, status) catch and continue.
 *
 *  Convex mode additionally hydrates the in-process config cache so the
 *  codebase's synchronous `readConfigOrInit()` callers (per-turn loop, Pi
 *  boot paths) are served without touching disk. Long-lived processes call
 *  `enableConfigLiveRefresh()` afterwards to keep the cache hot. */
export async function bootRuntimeContext(): Promise<RuntimeContext> {
	const existing = tryGetRuntimeContext();
	if (existing) return existing;
	if (!_inflight) {
		_inflight = (async () => {
			const ctx = await createRuntimeContext();
			if (ctx.mode === "convex") {
				const { value } = await ctx.store.config.read();
				// First-boot parity with the disk path: an absent row reads as
				// `{}`; the disk path's absent-file shape is `{ agents: {} }`.
				const cfg =
					Object.keys(value as Record<string, unknown>).length === 0
						? ({ agents: {} } as typeof value)
						: value;
				primeConfigCache(cfg);
				await Promise.all([
					hydrateSessionCaches(ctx.store, cfg as Record<string, unknown>),
					hydrateApprovalCaches(ctx.store, cfg as Record<string, unknown>),
					hydrateAccessCaches(ctx.store),
					hydrateCronCache(ctx.store),
				]);
			}
			setRuntimeContext(ctx);
			return ctx;
		})();
		_inflight.catch(() => {
			// Allow a later retry after a transient failure. Without this, the
			// first rejection would be cached for the life of the process.
			_inflight = undefined;
		});
	}
	return _inflight;
}

/** Convex mode boot — fill the per-agent session caches so the codebase's
 *  synchronous sessions.json helpers serve from memory. Every agent in the
 *  config gets a slot (parallel queries — one wall-clock round-trip);
 *  agents added at runtime start from the empty shape, which is correct
 *  for a brand-new agent. */
async function hydrateSessionCaches(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	await Promise.all(
		Array.from(ids, async (agentId) => {
			try {
				const rows = await store.sessions.listEntries(agentId);
				const sessions: Record<string, unknown> = {};
				for (const { sessionKey, entry } of rows) sessions[sessionKey] = entry;
				primeSessionCache(agentId, {
					version: 1,
					sessions: sessions as never,
				});
			} catch (err) {
				// A failed hydration for one agent must not block boot; the
				// empty-slot fallback in readSessionStore covers reads, and the
				// error is loud enough for the operator to investigate.
				console.error(
					`brigade: session hydration failed for agent ${agentId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — fill the exec-approvals module cache so the
 *  synchronous bash gate (`decideApproval`) never touches disk or network
 *  on the hot path. Same agent set as the session hydration. */
async function hydrateApprovalCaches(
	store: BrigadeStore,
	cfg: Record<string, unknown>,
): Promise<void> {
	const { primeApprovalsCache } = await import("../core/exec-approvals.js");
	const agents = cfg.agents as Record<string, unknown> | undefined;
	const ids = new Set<string>(["main"]);
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	await Promise.all(
		Array.from(ids, async (agentId) => {
			try {
				const contents = await store.execApprovals.list(agentId);
				primeApprovalsCache(agentId, contents);
			} catch (err) {
				console.error(
					`brigade: approvals hydration failed for agent ${agentId} — ${(err as Error).message}`,
				);
			}
		}),
	);
}

/** Convex mode boot — install channel access state (allow lists + pending
 *  pairings) into the access-control module's cache. One query for the
 *  whole owner; the module groups rows by (channel, account, kind). */
async function hydrateAccessCaches(store: BrigadeStore): Promise<void> {
	try {
		const { primeAccessCacheFromRows } = await import(
			"../agents/channels/access-control/store.js"
		);
		const rows = await store.channels.listAllAccessRows();
		primeAccessCacheFromRows(rows);
	} catch (err) {
		console.error(
			`brigade: channel-access hydration failed — ${(err as Error).message}`,
		);
	}
}

/** Convex mode boot — install the cron jobs into the cron cache so the
 *  cron service's whole-file load/save choke points serve from memory. */
async function hydrateCronCache(store: BrigadeStore): Promise<void> {
	try {
		const { primeCronCache } = await import("./cron-cache.js");
		const jobs = await store.cron.listJobs();
		primeCronCache(jobs as never[]);
	} catch (err) {
		console.error(`brigade: cron hydration failed — ${(err as Error).message}`);
	}
}

let _configLiveUnsub: (() => void) | undefined;

/** Convex mode, long-lived processes only (the gateway): subscribe to the
 *  config live-query and re-prime the cache on every server-side change —
 *  the convex-mode equivalent of the filesystem hot-reload watcher. NOT
 *  called by short-lived CLI commands: the reactive WebSocket client would
 *  hold the process open. Idempotent; pair with
 *  `disableConfigLiveRefresh()` on shutdown. No-op in filesystem mode,
 *  where the existing fs.watch hot-reload already covers this. */
export function enableConfigLiveRefresh(): void {
	const ctx = tryGetRuntimeContext();
	if (!ctx || ctx.mode !== "convex") return;
	if (_configLiveUnsub) return; // already live
	_configLiveUnsub = ctx.store.config.subscribe((cfg) => {
		primeConfigCache(cfg);
	});
}

export function disableConfigLiveRefresh(): void {
	try {
		_configLiveUnsub?.();
	} finally {
		_configLiveUnsub = undefined;
	}
}

/** Test-only — clear the in-flight slot alongside
 *  `__resetRuntimeContextForTests()`. */
export function __resetBootForTests(): void {
	_inflight = undefined;
}
