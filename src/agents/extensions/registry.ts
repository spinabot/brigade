/**
 * Brigade extension registry — the recorder + dispatcher behind the seam.
 *
 * A module registers through the `BrigadeExtensionContext` this produces; every
 * call is RECORDED here (not run live), because Brigade's gateway is per-turn:
 *   - agent-level registrations (tools/hooks/commands/model-providers) are replayed
 *     into EVERY Pi session via `toPiExtensionFactory()` (handed to
 *     `DefaultResourceLoader({ extensionFactories })`);
 *   - product-level registrations (channels/voice/media/integrations/services/
 *     http-routes/gateway-methods) are exposed to the gateway, which starts /
 *     mounts them ONCE at boot.
 *
 * Product registrations dedupe by id (last wins) so re-running modules is safe.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";
import { type BrigadeHookName, createHookRunner, type HookFireResult } from "./hook-runner.js";
import type { ChannelMessagingAdapter, ChannelSecurityAdapter } from "../channels/types.adapters.js";
import type {
	BrigadeExtensionContext,
	ChannelAdapter,
	ChannelCommand,
	CommandRegistration,
	GatewayMethodHandler,
	HookRegistration,
	HttpRoute,
	Integration,
	MediaGenProvider,
	ModelProviderRegistration,
	ProviderAuthMethodRegistration,
	Service,
	SpeechProvider,
	ToolRegistration,
	TranscriptionProvider,
} from "./types.js";

/** Per-load context Brigade supplies to each module's `register(b)`. */
export interface RegistryContextMeta {
	agentId: string;
	workspaceDir: string;
	cwd: string;
	config: BrigadeConfig;
	/** This module's validated config block (see `BrigadeExtensionContext.moduleConfig`). */
	moduleConfig?: unknown;
}

/**
 * Lifecycle state of one module on the live registry (FIX 4 — the durable
 * `PluginRecord` state machine the CLI can read live).
 *
 *   - `discovered` — the loader decided to run this module (it passed gating) but
 *     `register()` has not completed yet.
 *   - `activated`  — `register()` completed successfully; `capabilities` lists the
 *     capability ids this module contributed (attributed by diffing the registry
 *     before/after its `register()`).
 *   - `failed`     — `register()` threw (or another register-phase step failed);
 *     `failurePhase` names where.
 *
 * Unlike the discovery-only `brigade extensions list`, this reflects the
 * REGISTER phase — so an operator can see a module that imported fine but threw
 * while registering, which discovery alone never surfaces.
 */
export type PluginRecordStatus = "discovered" | "activated" | "failed";

/** Capability ids a module contributed, grouped by kind (empty arrays omitted-as-[]). */
export interface PluginCapabilityIds {
	tools: string[];
	hooks: string[];
	commands: string[];
	modelProviders: string[];
	channels: string[];
	channelCommands: string[];
	channelMessagingAdapters: string[];
	channelSecurityAdapters: string[];
	speechProviders: string[];
	transcriptionProviders: string[];
	mediaGenProviders: string[];
	memoryCapabilities: string[];
	contextEngines: string[];
	compactionProviders: string[];
	agentHarnesses: string[];
	webSearchProviders: string[];
	webFetchProviders: string[];
	integrations: string[];
	services: string[];
	httpRoutes: string[];
	gatewayMethods: string[];
}

/** A per-module runtime record on the live registry. */
export interface PluginRecord {
	id: string;
	status: PluginRecordStatus;
	/** When `status === "failed"`, the phase that failed (e.g. `"register"`). */
	failurePhase?: string;
	/** Capability ids this module registered (populated on `activated`). */
	capabilities: PluginCapabilityIds;
}

function emptyCapabilityIds(): PluginCapabilityIds {
	return {
		tools: [],
		hooks: [],
		commands: [],
		modelProviders: [],
		channels: [],
		channelCommands: [],
		channelMessagingAdapters: [],
		channelSecurityAdapters: [],
		speechProviders: [],
		transcriptionProviders: [],
		mediaGenProviders: [],
		memoryCapabilities: [],
		contextEngines: [],
		compactionProviders: [],
		agentHarnesses: [],
		webSearchProviders: [],
		webFetchProviders: [],
		integrations: [],
		services: [],
		httpRoutes: [],
		gatewayMethods: [],
	};
}

export class BrigadeExtensionRegistry {
	private readonly toolRegs: ToolRegistration[] = [];
	private readonly hookRegs: HookRegistration[] = [];
	private readonly commandRegs: CommandRegistration[] = [];
	private readonly modelProviderRegs: ModelProviderRegistration[] = [];
	private readonly providerAuthMethodRegs: ProviderAuthMethodRegistration[] = [];
	private readonly channelMap = new Map<string, ChannelAdapter>();
	private readonly channelCommandMap = new Map<string, ChannelCommand>();
	/** OUTBOUND messaging adapters declared on a channel slot, keyed by lowercased channel id. */
	private readonly channelMessagingMap = new Map<string, ChannelMessagingAdapter>();
	/** SUPPLEMENTARY security adapters declared on a channel slot, keyed by lowercased channel id. */
	private readonly channelSecurityMap = new Map<string, ChannelSecurityAdapter>();
	private readonly speechMap = new Map<string, SpeechProvider>();
	private readonly transcriptionMap = new Map<string, TranscriptionProvider>();
	private readonly mediaGenMap = new Map<string, MediaGenProvider>();
	private readonly memoryMap = new Map<string, import("./types.js").MemoryCapability>();
	private readonly memoryEmbeddingMap = new Map<string, import("./types.js").MemoryEmbeddingProvider>();
	private readonly contextEngineMap = new Map<string, import("./types.js").ContextEngineCapability>();
	private readonly compactionProviderMap = new Map<string, import("./types.js").CompactionProvider>();
	private readonly agentHarnessMap = new Map<string, import("./types.js").AgentHarness>();
	private readonly webSearchMap = new Map<string, import("./types.js").WebSearchProvider>();
	private readonly webFetchMap = new Map<string, import("./types.js").WebFetchProvider>();
	private readonly integrationMap = new Map<string, Integration>();
	private readonly serviceMap = new Map<string, Service>();
	private readonly httpRouteMap = new Map<string, HttpRoute>();
	private readonly gatewayMethodMap = new Map<string, GatewayMethodHandler>();

	/** Modules that successfully registered — the loader fills this (used for reload). */
	readonly loadedModules: import("./types.js").BrigadeModule[] = [];

	/**
	 * Per-module runtime lifecycle records (FIX 4). The loader populates these as
	 * it registers each module: `discovered` before `register()`, then `activated`
	 * (with attributed capabilities) or `failed`. Insertion-ordered (Map) so the
	 * CLI renders them in load order. Read via `pluginRecord(id)` / `pluginRecords()`.
	 */
	private readonly pluginRecordMap = new Map<string, PluginRecord>();

	/** Build the recording context a module's `register(b)` writes into. */
	context(meta: RegistryContextMeta): BrigadeExtensionContext {
		return {
			agentId: meta.agentId,
			workspaceDir: meta.workspaceDir,
			cwd: meta.cwd,
			config: meta.config,
			moduleConfig: meta.moduleConfig,
			// agent-level → recorded, replayed into each Pi session.
			// Wave K — accept either a bare `AnyBrigadeTool` or a
			// `BrigadeToolFactory` whose `create(ctx)` runs at session-init
			// with the per-turn `{ agentId, sessionKey }` so third-party
			// tools can scope state to the active turn.
			tool: (tool, opts) => {
				if (tool && typeof (tool as { create?: unknown }).create === "function") {
					this.toolRegs.push({
						factory: tool as import("./types.js").BrigadeToolFactory,
						toolset: opts?.toolset,
						eligible: opts?.eligible,
					});
				} else {
					this.toolRegs.push({
						tool: tool as AnyBrigadeTool,
						toolset: opts?.toolset,
						eligible: opts?.eligible,
					});
				}
			},
			hook: (event, handler, opts) => {
				this.hookRegs.push({ event, handler, priority: opts?.priority });
			},
			command: (name, options) => {
				this.commandRegs.push({ name, options });
			},
			modelProvider: (name, config) => {
				this.modelProviderRegs.push({ name, config });
			},
			providerAuthMethod: (providerName, method) => {
				this.providerAuthMethodRegs.push({ providerName, method });
			},
			// product-level → gateway-level registries (dedupe by id, last wins)
			channel: (adapter) => {
				this.channelMap.set(adapter.id, adapter);
			},
			channelCommand: (command) => {
				// Lowercase the key so dedup here agrees with the manager's
				// case-insensitive dispatch (both sides use lowercase).
				this.channelCommandMap.set(command.name.toLowerCase(), command);
			},
			channelMessaging: (channelId, adapter) => {
				// Lowercase the key so it agrees with the channel-messaging registry's
				// case-insensitive lookup (which normalizes the same way). A blank id
				// is dropped — the registry would reject it anyway.
				const id = channelId.trim().toLowerCase();
				if (id) this.channelMessagingMap.set(id, adapter);
			},
			channelSecurity: (channelId, adapter) => {
				// Lowercase the key so it agrees with the channel-security registry's
				// case-insensitive lookup. A blank id is dropped.
				const id = channelId.trim().toLowerCase();
				if (id) this.channelSecurityMap.set(id, adapter);
			},
			tts: (provider) => {
				this.speechMap.set(provider.id, provider);
			},
			stt: (provider) => {
				this.transcriptionMap.set(provider.id, provider);
			},
			mediaGen: (provider) => {
				this.mediaGenMap.set(provider.id, provider);
			},
			memory: (capability) => {
				this.memoryMap.set(capability.id, capability);
			},
			memoryEmbeddingProvider: (provider) => {
				this.memoryEmbeddingMap.set(provider.id, provider);
			},
			contextEngine: (engine) => {
				this.contextEngineMap.set(engine.id, engine);
			},
			compactionProvider: (provider) => {
				this.compactionProviderMap.set(provider.id, provider);
			},
			agentHarness: (harness) => {
				this.agentHarnessMap.set(harness.id, harness);
			},
			webSearch: (provider) => {
				this.webSearchMap.set(provider.id, provider);
			},
			webFetch: (provider) => {
				this.webFetchMap.set(provider.id, provider);
			},
			integration: (integration) => {
				this.integrationMap.set(integration.id, integration);
			},
			service: (service) => {
				this.serviceMap.set(service.id, service);
			},
			httpRoute: (route) => {
				// Dedupe by method+path (last wins) so two modules can't both bind
				// the same route with one silently dead.
				this.httpRouteMap.set(`${route.method ?? "ANY"} ${route.path}`, route);
			},
			gatewayMethod: (method) => {
				this.gatewayMethodMap.set(method.name, method);
			},
		};
	}

	/* ── plugin lifecycle records (FIX 4) ── */

	/**
	 * Snapshot the FULL set of currently-registered capability ids, grouped by
	 * kind. The loader takes one of these BEFORE a module's `register()` and one
	 * AFTER, then diffs them to attribute the newly-registered ids to that module
	 * (see `diffCapabilityIds`). Pure read.
	 */
	capabilitySnapshot(): PluginCapabilityIds {
		return {
			tools: this.toolRegs
				.map((t) => (t.tool ? t.tool.name : t.factory?.create({ agentId: "", sessionKey: "" }).name))
				.filter((n): n is string => typeof n === "string"),
			hooks: this.hookRegs.map((h) => h.event),
			commands: this.commandRegs.map((c) => c.name),
			modelProviders: this.modelProviderRegs.map((p) => p.name),
			channels: [...this.channelMap.keys()],
			channelCommands: [...this.channelCommandMap.keys()],
			channelMessagingAdapters: [...this.channelMessagingMap.keys()],
			channelSecurityAdapters: [...this.channelSecurityMap.keys()],
			speechProviders: [...this.speechMap.keys()],
			transcriptionProviders: [...this.transcriptionMap.keys()],
			mediaGenProviders: [...this.mediaGenMap.keys()],
			memoryCapabilities: [...this.memoryMap.keys()],
			contextEngines: [...this.contextEngineMap.keys()],
			compactionProviders: [...this.compactionProviderMap.keys()],
			agentHarnesses: [...this.agentHarnessMap.keys()],
			webSearchProviders: [...this.webSearchMap.keys()],
			webFetchProviders: [...this.webFetchMap.keys()],
			integrations: [...this.integrationMap.keys()],
			services: [...this.serviceMap.keys()],
			httpRoutes: [...this.httpRouteMap.keys()],
			gatewayMethods: [...this.gatewayMethodMap.keys()],
		};
	}

	/** Record that a module was selected to load (pre-`register()`). */
	markModuleDiscovered(id: string): void {
		this.pluginRecordMap.set(id, { id, status: "discovered", capabilities: emptyCapabilityIds() });
	}

	/**
	 * Record that a module's `register()` succeeded. `capabilities` is the diff of
	 * the registry's capability ids across the module's `register()` (what THIS
	 * module added), produced by `diffCapabilityIds(before, after)` in the loader.
	 */
	markModuleActivated(id: string, capabilities: PluginCapabilityIds): void {
		this.pluginRecordMap.set(id, { id, status: "activated", capabilities });
	}

	/** Record that a module failed during a register-phase `phase`. */
	markModuleFailed(id: string, phase: string): void {
		const prev = this.pluginRecordMap.get(id);
		this.pluginRecordMap.set(id, {
			id,
			status: "failed",
			failurePhase: phase,
			capabilities: prev?.capabilities ?? emptyCapabilityIds(),
		});
	}

	/** Live lifecycle record for one module id, or `undefined` if never seen. */
	pluginRecord(id: string): PluginRecord | undefined {
		const r = this.pluginRecordMap.get(id);
		return r ? clonePluginRecord(r) : undefined;
	}

	/** All live lifecycle records, in load order. */
	pluginRecords(): PluginRecord[] {
		return [...this.pluginRecordMap.values()].map(clonePluginRecord);
	}

	/* ── product-level getters (the gateway consumes these) ── */
	get channels(): ChannelAdapter[] {
		return [...this.channelMap.values()];
	}
	get channelCommands(): ChannelCommand[] {
		return [...this.channelCommandMap.values()];
	}
	/**
	 * OUTBOUND messaging adapters declared via `b.channelMessaging(id, adapter)`,
	 * shaped `{ id, messaging }` so the boot can hand them straight to
	 * `syncChannelMessagingAdaptersFromPlugins(...)`. Parallel to `channels`.
	 */
	get channelMessagingAdapters(): { id: string; messaging: ChannelMessagingAdapter }[] {
		return [...this.channelMessagingMap.entries()].map(([id, messaging]) => ({ id, messaging }));
	}
	/**
	 * SUPPLEMENTARY security adapters declared via `b.channelSecurity(id, adapter)`,
	 * shaped `{ id, security }` so the boot can hand them straight to
	 * `syncChannelSecurityAdaptersFromPlugins(...)`. Parallel to `channels`.
	 */
	get channelSecurityAdapters(): { id: string; security: ChannelSecurityAdapter }[] {
		return [...this.channelSecurityMap.entries()].map(([id, security]) => ({ id, security }));
	}
	get speechProviders(): SpeechProvider[] {
		return [...this.speechMap.values()];
	}
	get transcriptionProviders(): TranscriptionProvider[] {
		return [...this.transcriptionMap.values()];
	}
	get mediaGenProviders(): MediaGenProvider[] {
		return [...this.mediaGenMap.values()];
	}
	get memoryCapabilities(): import("./types.js").MemoryCapability[] {
		return [...this.memoryMap.values()];
	}
	get memoryEmbeddingProviders(): import("./types.js").MemoryEmbeddingProvider[] {
		return [...this.memoryEmbeddingMap.values()];
	}
	get contextEngines(): import("./types.js").ContextEngineCapability[] {
		return [...this.contextEngineMap.values()];
	}
	get compactionProviders(): import("./types.js").CompactionProvider[] {
		return [...this.compactionProviderMap.values()];
	}
	get agentHarnesses(): import("./types.js").AgentHarness[] {
		return [...this.agentHarnessMap.values()];
	}
	get webSearchProviders(): import("./types.js").WebSearchProvider[] {
		return [...this.webSearchMap.values()];
	}
	get webFetchProviders(): import("./types.js").WebFetchProvider[] {
		return [...this.webFetchMap.values()];
	}

	/**
	 * Resolve the active web-search provider for the agent loop.
	 *
	 *   1. If `tools.web.search.provider` is pinned in config, return that
	 *      provider — if missing or not-yet-configured, return `null` (the
	 *      pin is honored verbatim; we don't silently fall back).
	 *   2. Otherwise sort by `autoDetectOrder` ascending and return the
	 *      first provider whose `isConfigured(cfg, env)` returns true.
	 *   3. If none are credentialed, fall back to the first provider with
	 *      `requiresCredential === false` (e.g. DuckDuckGo HTML scrape).
	 *   4. Otherwise `null` — no search provider is reachable.
	 *
	 * Same shape (parallel function) for `resolveActiveWebFetchProvider`.
	 */
	resolveActiveWebSearchProvider(
		cfg: BrigadeConfig,
		env?: NodeJS.ProcessEnv,
	): import("./types.js").WebSearchProvider | null {
		return resolveActiveWebProvider(this.webSearchProviders, cfg, env, "search");
	}

	/**
	 * Error-time fallback chain for `web_search` — the ordered list of
	 * providers the tool may try when the active provider THROWS (rate
	 * limit, anti-bot block, network failure). Production incident: the
	 * default provider 429'd on a weekly quota and, with no fallback, the
	 * agent lost web search entirely.
	 *
	 *   - Operator pin (`tools.web.search.provider`) → `[]`. A pin is
	 *     honored verbatim; we never silently reroute around it.
	 *   - Allow/deny filtered, exactly like the default resolver.
	 *   - GENERAL-PURPOSE tier only (`autoDetectOrder <= 100`): the
	 *     specialised keyless providers above 100 (wikipedia, arxiv,
	 *     github, …) answer a different question — falling back to them
	 *     for a general query would return junk with a 200 face.
	 *   - Configured providers only. Keyless DDG self-reports configured,
	 *     so the chain always ends at a zero-config rung unless the
	 *     operator denied it.
	 */
	listWebSearchFallbackChain(
		cfg: BrigadeConfig,
		env?: NodeJS.ProcessEnv,
	): import("./types.js").WebSearchProvider[] {
		const slot = (cfg as {
			tools?: { web?: { search?: { provider?: string; allow?: string[]; deny?: string[] } } };
		}).tools?.web?.search;
		if (slot?.provider?.trim()) return [];
		return filterByAllowDeny(this.webSearchProviders, slot?.allow, slot?.deny)
			.filter((p) => (p.autoDetectOrder ?? 100) <= 100)
			.filter((p) => {
				try {
					return p.isConfigured(cfg, env);
				} catch {
					return false;
				}
			})
			.sort(
				(a, b) => (a.autoDetectOrder ?? 100) - (b.autoDetectOrder ?? 100) || a.id.localeCompare(b.id),
			);
	}

	/**
	 * Look up a web-search provider by id, respecting the operator's
	 * allow/deny lists. Returns null when the id is unknown OR is gated
	 * out by config. Used for per-call `provider` overrides on
	 * `web_search`.
	 */
	lookupWebSearchProviderById(
		id: string,
		cfg: BrigadeConfig,
	): import("./types.js").WebSearchProvider | null {
		const target = id.trim().toLowerCase();
		if (!target) return null;
		const slot = (cfg as {
			tools?: { web?: { search?: { allow?: string[]; deny?: string[] } } };
		}).tools?.web?.search;
		const allow = slot?.allow;
		const deny = slot?.deny;
		const allowSet = allow && allow.length > 0 ? new Set(allow.map((s) => s.trim().toLowerCase())) : null;
		const denySet = deny && deny.length > 0 ? new Set(deny.map((s) => s.trim().toLowerCase())) : null;
		for (const p of this.webSearchProviders) {
			if (p.id.toLowerCase() !== target) continue;
			if (allowSet && !allowSet.has(target)) return null;
			if (denySet && denySet.has(target)) return null;
			return p;
		}
		return null;
	}

	resolveActiveWebFetchProvider(
		cfg: BrigadeConfig,
		env?: NodeJS.ProcessEnv,
	): import("./types.js").WebFetchProvider | null {
		return resolveActiveWebProvider(this.webFetchProviders, cfg, env, "fetch");
	}

	/**
	 * Resolve the active slot-selected capability for a given slot key.
	 * `extensions.slots.<slot>` in `brigade.json` names the active plugin id;
	 * when unset, returns `undefined` (Brigade's built-in path takes over).
	 *
	 *   const memory = registry.resolveSlot("memory", cfg, registry.memoryCapabilities);
	 *
	 * Generic so any slot uses the same lookup shape.
	 */
	resolveSlot<T extends { id: string }>(
		slotName: "memory" | "contextEngine" | "compaction" | "agentHarness",
		cfg: BrigadeConfig,
		candidates: ReadonlyArray<T>,
	): T | undefined {
		const slots = (cfg as { extensions?: { slots?: Record<string, string> } }).extensions?.slots;
		const pinnedId = slots?.[slotName]?.trim();
		if (!pinnedId) return undefined;
		return candidates.find((c) => c.id === pinnedId);
	}

	get integrations(): Integration[] {
		return [...this.integrationMap.values()];
	}
	get services(): Service[] {
		return [...this.serviceMap.values()];
	}
	get httpRoutes(): HttpRoute[] {
		return [...this.httpRouteMap.values()];
	}
	get gatewayMethods(): GatewayMethodHandler[] {
		return [...this.gatewayMethodMap.values()];
	}

	/**
	 * Recorded provider auth methods, optionally filtered to a single provider.
	 * Order = registration order — that's the order onboarding/resolution should
	 * try methods in (first viable wins). Today this is shape-only — the
	 * consumer-side resolver lands when the first OAuth provider plugin ships.
	 */
	providerAuthMethods(providerName?: string): ProviderAuthMethodRegistration[] {
		if (!providerName) return [...this.providerAuthMethodRegs];
		return this.providerAuthMethodRegs.filter((r) => r.providerName === providerName);
	}

	/* ── agent-level ── */

	/**
	 * Eligible tool objects (passes the per-tool `check_fn` gate).
	 *
	 * When `opts.toolset` is supplied (e.g. `"minimal" | "coding" | "messaging"
	 * | "full"`), the result is additionally filtered to tools whose recorded
	 * `toolset` either matches that string, is `"*"` (universal opt-in), or is
	 * `undefined` (no profile declared — always included so legacy / un-tagged
	 * tools never disappear behind a profile switch). Unset / empty `toolset`
	 * disables the filter — the tool list returns as if the knob weren't there
	 * (full surface), which is the desired default for `agents.defaults.toolset`
	 * being absent from `brigade.json`.
	 */
	eligibleTools(opts: { toolset?: string } = {}): AnyBrigadeTool[] {
		const profile = opts.toolset?.trim();
		const profileActive = profile !== undefined && profile.length > 0 && profile !== "full";
		return this.toolRegs
			.filter((t) => !t.eligible || t.eligible())
			.filter((t) => {
				if (!profileActive) return true;
				if (t.toolset === undefined) return true;
				if (t.toolset === "*") return true;
				return t.toolset === profile;
			})
			.map((t) => {
				// Wave K — factory entries materialise with an empty ctx for
				// diagnostic queries (the per-turn ctx isn't known here). The
				// real per-turn build runs inside `toPiExtensionFactory` below.
				if (t.tool) return t.tool;
				if (t.factory) return t.factory.create({ agentId: "", sessionKey: "" });
				throw new Error("ToolRegistration has neither tool nor factory");
			});
	}

	/** Names of eligible tools — feed into `enabledToolNames` so the unknown-tool guard allows them. */
	toolNames(opts: { toolset?: string } = {}): string[] {
		return this.eligibleTools(opts).map((t) => t.name);
	}

	/**
	 * Fire a Brigade-native hook event through the 4-pattern runner. The pattern
	 * is looked up by name from `HOOK_PATTERNS` (telemetry/modifying/claiming/
	 * sync) — callers pass the payload and get back the merged outcome.
	 *
	 *   const claim = await registry.fireHook("inbound_claim", { channel, msg });
	 *   if (claim.handled) return; // a plugin owns this inbound
	 *
	 * Returns `{ handlerCount }` plus pattern-specific fields:
	 *   - claiming → `{ handled, by? }` (handler index 0-based that claimed)
	 *   - modifying → `{ modifications }` (merged payload patch)
	 *   - void / sync → just the count
	 */
	async fireHook<T = unknown>(name: BrigadeHookName, payload: T): Promise<HookFireResult> {
		const matching = this.hookRegs.filter((h) => h.event === name);
		const runner = createHookRunner(
			matching.map((h) => ({
				handler: h.handler as (p: unknown) => unknown,
				priority: h.priority,
			})),
		);
		return runner.fire(name, payload);
	}

	/** Recorded hooks sorted by priority (higher first); ties keep registration order. */
	private sortedHooks(): HookRegistration[] {
		// Stable sort: decorate with index so equal priorities preserve insertion order.
		return this.hookRegs
			.map((h, i) => ({ h, i }))
			.sort((a, b) => (b.h.priority ?? 0) - (a.h.priority ?? 0) || a.i - b.i)
			.map((x) => x.h);
	}

	/**
	 * Replay the recorded agent-level registrations into a Pi session. Hand the
	 * result to `new DefaultResourceLoader({ extensionFactories: [factory] })`
	 * (and remember to `await loader.reload()` — Brigade passes the loader in, so
	 * `createAgentSession` won't reload it itself).
	 *
	 * `opts.toolset` mirrors `eligibleTools()` — when supplied, tools whose
	 * `toolset` doesn't match (and isn't `"*"` / unset) are NOT registered into
	 * Pi. The same value must be threaded into both `toolNames(opts)` (for the
	 * unknown-tool guard's allowlist) and the factory so the two views agree.
	 */
	toPiExtensionFactory(
		opts: { toolset?: string; agentId?: string; sessionKey?: string } = {},
	): ExtensionFactory {
		const profile = opts.toolset?.trim();
		const profileActive = profile !== undefined && profile.length > 0 && profile !== "full";
		// Wave K — per-turn ctx for `b.tool({ create })` factory entries. Bare
		// tool entries (legacy path) ignore the ctx and replay verbatim.
		const factoryCtx: import("./types.js").BrigadeToolFactoryContext = {
			agentId: opts.agentId ?? "",
			sessionKey: opts.sessionKey ?? "",
		};
		return (pi: ExtensionAPI) => {
			for (const t of this.toolRegs) {
				if (t.eligible && !t.eligible()) continue;
				if (profileActive) {
					if (t.toolset !== undefined && t.toolset !== "*" && t.toolset !== profile) continue;
				}
				// AgentTool → Pi ToolDefinition: Pi's tool wrapper invokes execute with
				// `ctx` as a trailing positional arg, which Brigade's 4-arg execute
				// simply ignores; the required fields (name/label/description/parameters)
				// all match. Cast bridges the nominal gap without changing authoring.
				const built = t.tool ?? t.factory?.create(factoryCtx);
				if (!built) continue;
				pi.registerTool(built as never);
			}
			// Pi has no native hook priority — handlers fire in registration order — so
			// we replay in Brigade's priority order (higher first).
			for (const h of this.sortedHooks()) {
				if (h.event === "before_agent_start") {
					// Brigade PINS the persona (it overwrites Pi's _baseSystemPrompt).
					// Pi lets a `before_agent_start` handler replace the system prompt
					// for the turn, which would silently clobber that pin — so we strip
					// any `systemPrompt` a module returns while preserving the rest of
					// the result (e.g. an injected `message`).
					const inner = h.handler;
					const guarded = async (...a: unknown[]): Promise<unknown> => {
						const res = await inner(...a);
						if (res && typeof res === "object" && "systemPrompt" in (res as Record<string, unknown>)) {
							const { systemPrompt: _dropped, ...rest } = res as Record<string, unknown>;
							return rest;
						}
						return res;
					};
					pi.on(h.event as never, guarded as never);
				} else {
					pi.on(h.event as never, h.handler as never);
				}
			}
			for (const c of this.commandRegs) {
				pi.registerCommand(c.name, c.options as never);
			}
			// Model-provider registration: guard at runtime so a Pi API rename can't
			// break the build (no providers ship as modules yet).
			const registerProvider = (pi as unknown as { registerProvider?: (n: string, c: unknown) => void })
				.registerProvider;
			if (typeof registerProvider === "function") {
				for (const p of this.modelProviderRegs) registerProvider.call(pi, p.name, p.config);
			}
		};
	}
}

/**
 * Shared resolver for `webSearch` and `webFetch` providers — same selection
 * algorithm both sides. Reads `tools.web.<kind>.provider` for an explicit
 * pin; otherwise sorts candidates by `autoDetectOrder` (ascending; lower
 * wins) and returns the first one whose `isConfigured` returns true.
 * Falls back to the first `requiresCredential: false` candidate when no
 * credentialed provider exists — so a zero-config provider like DuckDuckGo
 * always works on a fresh install.
 */
function resolveActiveWebProvider<
	T extends {
		id: string;
		autoDetectOrder?: number;
		requiresCredential?: boolean;
		isConfigured(cfg: BrigadeConfig, env?: NodeJS.ProcessEnv): boolean;
	},
>(
	candidates: ReadonlyArray<T>,
	cfg: BrigadeConfig,
	env: NodeJS.ProcessEnv | undefined,
	kind: "search" | "fetch",
): T | null {
	if (candidates.length === 0) return null;
	const cfgRoot = cfg as {
		tools?: {
			web?: {
				search?: { provider?: string; allow?: string[]; deny?: string[] };
				fetch?: { provider?: string; allow?: string[]; deny?: string[] };
			};
		};
	};
	const slot = cfgRoot.tools?.web?.[kind];
	const pinnedId = slot?.provider?.trim();
	const allowed = filterByAllowDeny(candidates, slot?.allow, slot?.deny);
	if (allowed.length === 0) return null;
	if (pinnedId) {
		// Explicit pin: honor it verbatim. If the operator pinned a provider
		// that isn't yet configured (or is excluded via deny), return null
		// so the tool surfaces an actionable error rather than silently
		// choosing a different one.
		const pinned = allowed.find((c) => c.id === pinnedId);
		if (!pinned) return null;
		const isConfigured = (() => {
			try {
				return pinned.isConfigured(cfg, env);
			} catch {
				return false;
			}
		})();
		return isConfigured ? pinned : null;
	}
	const sorted = [...allowed].sort(
		(a, b) => (a.autoDetectOrder ?? 100) - (b.autoDetectOrder ?? 100) || a.id.localeCompare(b.id),
	);
	for (const c of sorted) {
		try {
			if (c.isConfigured(cfg, env)) return c;
		} catch {
			/* a buggy isConfigured shouldn't sink the whole pick */
		}
	}
	// No credentialed provider — fall back to the first keyless candidate.
	for (const c of sorted) {
		if (c.requiresCredential === false) return c;
	}
	return null;
}

/**
 * Apply operator allow / deny lists to the candidate set.
 *
 *   - `allow` (when non-empty): only providers whose id is listed survive.
 *   - `deny` (always): listed providers are dropped.
 *
 * Allow runs before deny — if a provider is both allowed and denied, deny
 * wins (fail-closed). An empty/missing allow list means "all allowed".
 */
function filterByAllowDeny<T extends { id: string }>(
	candidates: ReadonlyArray<T>,
	allow: string[] | undefined,
	deny: string[] | undefined,
): T[] {
	const allowSet = allow && allow.length > 0 ? new Set(allow.map((s) => s.trim().toLowerCase())) : null;
	const denySet = deny && deny.length > 0 ? new Set(deny.map((s) => s.trim().toLowerCase())) : null;
	return candidates.filter((c) => {
		const id = c.id.toLowerCase();
		if (allowSet && !allowSet.has(id)) return false;
		if (denySet && denySet.has(id)) return false;
		return true;
	});
}

/** Deep-ish clone of a PluginRecord so callers can't mutate the registry's copy. */
function clonePluginRecord(r: PluginRecord): PluginRecord {
	const caps = {} as PluginCapabilityIds;
	for (const key of Object.keys(r.capabilities) as (keyof PluginCapabilityIds)[]) {
		caps[key] = [...r.capabilities[key]];
	}
	return {
		id: r.id,
		status: r.status,
		...(r.failurePhase !== undefined ? { failurePhase: r.failurePhase } : {}),
		capabilities: caps,
	};
}

/**
 * Diff two capability-id snapshots (`before`/`after` a single module's
 * `register()`), returning ONLY the ids the module added. Multiset-aware per
 * kind: if `before` had one `web_search` tool and `after` has two, the new one
 * is attributed. Used by the loader to attribute capabilities to the module that
 * registered them for its `PluginRecord`.
 */
export function diffCapabilityIds(before: PluginCapabilityIds, after: PluginCapabilityIds): PluginCapabilityIds {
	const out = {} as PluginCapabilityIds;
	for (const key of Object.keys(after) as (keyof PluginCapabilityIds)[]) {
		const beforeCounts = new Map<string, number>();
		for (const id of before[key]) beforeCounts.set(id, (beforeCounts.get(id) ?? 0) + 1);
		const added: string[] = [];
		for (const id of after[key]) {
			const remaining = beforeCounts.get(id) ?? 0;
			if (remaining > 0) {
				beforeCounts.set(id, remaining - 1); // consumed a pre-existing one
			} else {
				added.push(id);
			}
		}
		out[key] = added;
	}
	return out;
}
