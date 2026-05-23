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

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";

import type { BrigadeConfig } from "../../config/io.js";
import type { AnyBrigadeTool } from "../tools/types.js";
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

export class BrigadeExtensionRegistry {
	private readonly toolRegs: ToolRegistration[] = [];
	private readonly hookRegs: HookRegistration[] = [];
	private readonly commandRegs: CommandRegistration[] = [];
	private readonly modelProviderRegs: ModelProviderRegistration[] = [];
	private readonly channelMap = new Map<string, ChannelAdapter>();
	private readonly channelCommandMap = new Map<string, ChannelCommand>();
	private readonly speechMap = new Map<string, SpeechProvider>();
	private readonly transcriptionMap = new Map<string, TranscriptionProvider>();
	private readonly mediaGenMap = new Map<string, MediaGenProvider>();
	private readonly integrationMap = new Map<string, Integration>();
	private readonly serviceMap = new Map<string, Service>();
	private readonly httpRouteMap = new Map<string, HttpRoute>();
	private readonly gatewayMethodMap = new Map<string, GatewayMethodHandler>();

	/** Modules that successfully registered — the loader fills this (used for reload). */
	readonly loadedModules: import("./types.js").BrigadeModule[] = [];

	/** Build the recording context a module's `register(b)` writes into. */
	context(meta: RegistryContextMeta): BrigadeExtensionContext {
		return {
			agentId: meta.agentId,
			workspaceDir: meta.workspaceDir,
			cwd: meta.cwd,
			config: meta.config,
			moduleConfig: meta.moduleConfig,
			// agent-level → recorded, replayed into each Pi session
			tool: (tool, opts) => {
				this.toolRegs.push({ tool, toolset: opts?.toolset, eligible: opts?.eligible });
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
			// product-level → gateway-level registries (dedupe by id, last wins)
			channel: (adapter) => {
				this.channelMap.set(adapter.id, adapter);
			},
			channelCommand: (command) => {
				// Lowercase the key so dedup here agrees with the manager's
				// case-insensitive dispatch (both sides use lowercase).
				this.channelCommandMap.set(command.name.toLowerCase(), command);
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

	/* ── product-level getters (the gateway consumes these) ── */
	get channels(): ChannelAdapter[] {
		return [...this.channelMap.values()];
	}
	get channelCommands(): ChannelCommand[] {
		return [...this.channelCommandMap.values()];
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

	/* ── agent-level ── */

	/** Eligible tool objects (passes the per-tool `check_fn` gate). */
	eligibleTools(): AnyBrigadeTool[] {
		return this.toolRegs.filter((t) => !t.eligible || t.eligible()).map((t) => t.tool);
	}

	/** Names of eligible tools — feed into `enabledToolNames` so the unknown-tool guard allows them. */
	toolNames(): string[] {
		return this.eligibleTools().map((t) => t.name);
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
	 */
	toPiExtensionFactory(): ExtensionFactory {
		return (pi: ExtensionAPI) => {
			for (const t of this.toolRegs) {
				if (t.eligible && !t.eligible()) continue;
				// AgentTool → Pi ToolDefinition: Pi's tool wrapper invokes execute with
				// `ctx` as a trailing positional arg, which Brigade's 4-arg execute
				// simply ignores; the required fields (name/label/description/parameters)
				// all match. Cast bridges the nominal gap without changing authoring.
				pi.registerTool(t.tool as never);
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
