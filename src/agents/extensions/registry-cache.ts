/**
 * Per-agent extension registry cache.
 *
 * Without this layer, `loadModules` runs on EVERY agent turn — re-registering
 * every bundled module (whatsapp, arxiv, brave, duckduckgo, exa, firecrawl,
 * github-search, hackernews, npm-search, ollama-search, perplexity, searxng,
 * tavily, wikipedia — 14 today and growing) at the start of every prompt.
 * Each module's `register()` runs synchronous bookkeeping plus optional
 * `requiresEnv` checks; in the WhatsApp case it also touches the channel
 * registry. Doing this fourteen times per "remind me in 2 minutes" turn is
 * pure overhead, AND it amplifies any single module's slowness into a per-
 * turn tax — a hung register() that lasts 8s holds up EVERY turn.
 *
 * Why keyed by agentId (P0#15 — Wave H):
 *
 *   The `BrigadeExtensionContext` a module receives in `register(b)` carries
 *   AGENT-SCOPED metadata: `agentId`, `workspaceDir`, `cwd`, the validated
 *   per-module config block. Modules can (and do) capture these in closures
 *   handed to `pi.registerTool` / `pi.on` — see
 *   `registry.ts:toPiExtensionFactory` which replays every recorded
 *   `modelProviderReg` and tool back into Pi with the original closures. If
 *   we cached a SINGLE registry keyed by nothing, the FIRST agent to load
 *   the cache would freeze its `meta` into every subsequent agent's tools.
 *   Result: agent B's `recall_memory` tool would write to agent A's
 *   workspace; agent B's WhatsApp module would record itself against agent
 *   A's channel registry slot. We key the cache by `agentId` so each agent
 *   builds + reuses ITS OWN frozen-meta registry. The cost — one `loadModules`
 *   per agent at first turn — is paid once; every subsequent turn for that
 *   agent reuses the cached registry.
 *
 * Config changes — operator edits `brigade.json` mid-session — require a
 * gateway restart today (the brigade.json file isn't watched). When we add
 * config hot-reload later, we'll call `invalidateExtensionRegistryCache()`
 * from the watch handler and the next turn rebuilds.
 *
 * Safety properties:
 *
 *   - The registry is READ by every consumer (system prompt assembler,
 *     toolset registry, memory capability resolver). It's never MUTATED
 *     after `loadModules` returns. Reusing the same instance across turns
 *     for the same agent is therefore safe — there's no per-turn state
 *     that would leak.
 *
 *   - Module register() is supposed to be idempotent in Brigade's design,
 *     but we deliberately DON'T re-run it — even if a module's register()
 *     were side-effecting (e.g. registers a global hook), we want it
 *     called once per agent to avoid double-dispatch.
 */

import { loadModules, type LoadModulesArgs } from "./loader.js";
import type { BrigadeExtensionRegistry } from "./registry.js";

/** Per-agent cached registry + outstanding-build coalescer. */
type AgentCacheEntry = {
	registry?: BrigadeExtensionRegistry;
	inFlightLoad?: Promise<BrigadeExtensionRegistry>;
};

/**
 * Per-agentId cache. We key by agentId because the `BrigadeExtensionContext`
 * a module captures during `register()` carries agent-scoped meta (workspace
 * dir, cwd, config) — sharing one registry across agents would freeze the
 * first agent's meta into every later agent's tools (the "capture trap"
 * documented above + on `BrigadeExtensionContext`).
 */
const cacheByAgent = new Map<string, AgentCacheEntry>();

function getEntry(agentId: string): AgentCacheEntry {
	const existing = cacheByAgent.get(agentId);
	if (existing) return existing;
	const fresh: AgentCacheEntry = {};
	cacheByAgent.set(agentId, fresh);
	return fresh;
}

/**
 * Return the cached extension registry for `args.meta.agentId`, building
 * it on the first call for that agent. Subsequent calls for the SAME
 * agent return the same instance — `loadModules` is NOT re-run.
 *
 * Concurrency: if N callers race the first build for one agent, only
 * ONE `loadModules` actually runs for that agent. The others await its
 * promise so the gateway boot path + the first inbound turn (which can
 * arrive micro-seconds apart) don't double-register.
 */
export async function getOrLoadExtensionRegistry(
	args: LoadModulesArgs,
): Promise<BrigadeExtensionRegistry> {
	const agentId = args.meta.agentId;
	const entry = getEntry(agentId);
	if (entry.registry) return entry.registry;
	if (entry.inFlightLoad) return entry.inFlightLoad;
	entry.inFlightLoad = loadModules(args).then(
		(registry) => {
			entry.registry = registry;
			entry.inFlightLoad = undefined;
			return registry;
		},
		(err) => {
			// Don't cache failures — the next caller should be free to retry
			// with possibly-different config. Clear the in-flight slot so
			// concurrent retries get fresh build attempts.
			entry.inFlightLoad = undefined;
			throw err;
		},
	);
	return entry.inFlightLoad;
}

/**
 * Drop the cached registries. Optionally scope to a single agentId — when
 * omitted, every agent's cached registry is invalidated. The next call to
 * `getOrLoadExtensionRegistry` for an invalidated agent rebuilds. Wired in by:
 *   - Tests that need a fresh registry per case.
 *   - Future config hot-reload — when `brigade.json` changes on disk, the
 *     watcher calls this so the next turn picks up the new extensions /
 *     allow-list / disabled set.
 */
export function invalidateExtensionRegistryCache(agentId?: string): void {
	if (agentId) {
		cacheByAgent.delete(agentId);
		return;
	}
	cacheByAgent.clear();
}

/** Diagnostic — `true` if a registry has been built and cached for `agentId`. */
export function isExtensionRegistryCached(agentId: string): boolean {
	const entry = cacheByAgent.get(agentId);
	return entry?.registry !== undefined;
}
