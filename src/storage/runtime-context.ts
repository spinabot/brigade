// src/storage/runtime-context.ts
//
// RuntimeContext — resolve storage mode ONCE at boot, freeze it, hand out a
// `BrigadeStore` to every subsystem. No subsystem branches on `ctx.mode`;
// they all call `ctx.store.X.Y(...)` and the adapter does the right thing.
//
// Mode resolution priority (first wins):
//   1. `opts.override`              — for tests, never persisted
//   2. `~/.brigade/mode.sentinel`   — sticky, written by onboard / migrate
//   3. `BRIGADE_MODE` env var       — runtime override (only when no sentinel,
//                                     unless `BRIGADE_FORCE_MODE=1`)
//   4. `BRIGADE_CONVEX_URL` env var — implies `convex` mode
//   5. default                      — `filesystem`
//
// Once initialised, the context is `Object.freeze`'d and `setRuntimeContext`
// will reject a second call. Tests reset via `__resetRuntimeContextForTests`.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";

import type { BrigadeStore } from "./store.js";

// =============================================================================
// Types
// =============================================================================

export type StorageMode = "filesystem" | "convex";

export interface ModeSentinel {
	mode: StorageMode;
	/** ISO timestamp when the toggle was flipped. */
	migratedAt?: string;
	/** Convex deployment URL when `mode === "convex"`. */
	convexUrl?: string;
	/** Hash of the pre-migration export manifest for round-trip verification. */
	manifestSha256?: string;
}

export interface RuntimeContext {
	readonly mode: StorageMode;
	readonly store: BrigadeStore;
	readonly clock: () => number;
	readonly stateDir: string;
}

// =============================================================================
// Sentinel I/O
// =============================================================================

function readSentinel(stateDir: string): ModeSentinel | undefined {
	const p = path.join(stateDir, "mode.sentinel");
	if (!existsSync(p)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as ModeSentinel;
		if (parsed.mode !== "filesystem" && parsed.mode !== "convex") {
			throw new Error(`invalid mode in sentinel: ${String(parsed.mode)}`);
		}
		return parsed;
	} catch (err) {
		// Refuse to boot with a corrupt sentinel — operator must fix or delete it.
		// Mis-routing storage IO is a far worse failure than refusing to start.
		throw new Error(
			`~/.brigade/mode.sentinel is unreadable — fix or delete it: ${(err as Error).message}`,
		);
	}
}

function resolveModeFromEnv(env: NodeJS.ProcessEnv): StorageMode | undefined {
	const explicit = env.BRIGADE_MODE?.trim();
	if (explicit === "filesystem" || explicit === "convex") return explicit;
	if (explicit && explicit.length > 0) {
		throw new Error(`BRIGADE_MODE must be "filesystem" or "convex"; got "${explicit}"`);
	}
	if (env.BRIGADE_CONVEX_URL && env.BRIGADE_CONVEX_URL.trim().length > 0) {
		return "convex";
	}
	return undefined;
}

// =============================================================================
// Factory
// =============================================================================

export interface CreateRuntimeContextOpts {
	/** Test-only — skip sentinel/env resolution and use this directly. */
	override?: ModeSentinel;
	/** Override state dir (e.g. tempdir for tests). Defaults to `resolveStateDir()`. */
	stateDir?: string;
	/** Override clock for tests. Defaults to `Date.now`. */
	clock?: () => number;
	/** Pre-built store (test injection). When set, mode resolution is skipped
	 *  and `store.mode` is treated as canonical. */
	store?: BrigadeStore;
}

export async function createRuntimeContext(opts: CreateRuntimeContextOpts = {}): Promise<RuntimeContext> {
	const stateDir = opts.stateDir ?? resolveStateDir();
	const clock = opts.clock ?? Date.now;

	// Test-injection path — caller already built a store.
	if (opts.store) {
		return Object.freeze({
			mode: opts.store.mode,
			store: opts.store,
			clock,
			stateDir,
		});
	}

	const mode = resolveMode(stateDir, opts.override, process.env);
	// Thread the operator's chosen backend URL into the store. resolveMode
	// consults the sentinel only for the MODE; the sentinel's `convexUrl`
	// (written by onboard / `store migrate`) is where the operator pinned their
	// deployment. Without passing it here, convex boot falls through to
	// resolveConvexUrl's env-var lookup and throws "requires a deployment URL"
	// unless BRIGADE_CONVEX_URL happens to be exported — even though the URL is
	// sitting in the sentinel the whole time. Priority: explicit override →
	// sentinel → (env, resolved downstream in resolveConvexUrl).
	// Only honor the sentinel's URL when the sentinel ITSELF is convex — a
	// dormant convexUrl on a FILESYSTEM sentinel (left by `migrate --to
	// filesystem` for round-trip convenience) must not hijack a
	// BRIGADE_FORCE_MODE=1 + BRIGADE_CONVEX_URL diagnostic run, where mode
	// resolves convex from ENV and the operator's exported URL should win.
	const sentinelForUrl = mode === "convex" ? readSentinel(stateDir) : undefined;
	const convexUrl =
		opts.override?.convexUrl ??
		(sentinelForUrl?.mode === "convex" ? sentinelForUrl.convexUrl : undefined);
	const store = await buildStoreForMode(mode, {
		stateDir,
		...(convexUrl !== undefined ? { convexUrl } : {}),
	});
	await store.init();

	return Object.freeze({
		mode,
		store,
		clock,
		stateDir,
	});
}

function resolveMode(
	stateDir: string,
	override: ModeSentinel | undefined,
	env: NodeJS.ProcessEnv,
): StorageMode {
	if (override) return override.mode;

	const sentinel = readSentinel(stateDir);
	const envMode = resolveModeFromEnv(env);

	if (sentinel && envMode && envMode !== sentinel.mode) {
		if (env.BRIGADE_FORCE_MODE !== "1") {
			throw new Error(
				`Storage mode in ~/.brigade/mode.sentinel (${sentinel.mode}) differs from BRIGADE_MODE/BRIGADE_CONVEX_URL (${envMode}). ` +
					`Set BRIGADE_FORCE_MODE=1 to override (one-shot diagnostic only); otherwise reconcile or delete the sentinel.`,
			);
		}
		return envMode;
	}

	if (sentinel) return sentinel.mode;
	if (envMode) return envMode;
	return "filesystem";
}

async function buildStoreForMode(
	mode: StorageMode,
	args: { stateDir: string; convexUrl?: string },
): Promise<BrigadeStore> {
	if (mode === "filesystem") {
		const { LocalBrigadeStore } = await import("./local/index.js");
		return new LocalBrigadeStore({ stateDir: args.stateDir });
	}
	const { ConvexBrigadeStore } = await import("./convex/index.js");
	return new ConvexBrigadeStore({
		stateDir: args.stateDir,
		...(args.convexUrl !== undefined ? { url: args.convexUrl } : {}),
	});
}

// =============================================================================
// Process-wide singleton
// =============================================================================

let _ctx: RuntimeContext | undefined;

export function setRuntimeContext(ctx: RuntimeContext): void {
	if (_ctx) {
		throw new Error("RuntimeContext already initialised — only one context per process");
	}
	_ctx = ctx;
}

export function getRuntimeContext(): RuntimeContext {
	if (!_ctx) {
		throw new Error("RuntimeContext not initialised — call setRuntimeContext() at boot");
	}
	return _ctx;
}

export function tryGetRuntimeContext(): RuntimeContext | undefined {
	return _ctx;
}

/** Reset the singleton. Tests only — production code MUST NOT call this. */
export function __resetRuntimeContextForTests(): void {
	_ctx = undefined;
}
