/**
 * Brigade extension layer — public surface.
 *
 * The plugin engine for agent-level capabilities is Pi 0.73's native extension
 * system; Brigade adds thin capability registries for product surfaces (channels,
 * voice, media, integrations). One `defineModule` registers across both. See the
 * memory note `project_brigade_extensibility_plan`.
 */

export { defineModule } from "./types.js";
export type {
	BrigadeExtensionContext,
	BrigadeModule,
	ChannelAdapter,
	ChannelCommand,
	ChannelCommandContext,
	ChannelStartContext,
	GatewayMethodHandler,
	HttpRoute,
	HttpRouteHandler,
	InboundMessage,
	Integration,
	MediaGenProvider,
	Service,
	ServiceStartContext,
	SpeechProvider,
	TranscriptionProvider,
} from "./types.js";
export { BrigadeExtensionRegistry, type RegistryContextMeta } from "./registry.js";
export { clearDiscoveryCache, discoverUserModules, type DiscoveredModule } from "./discovery.js";
export { loadModules, type LoadModulesArgs } from "./loader.js";
export { BUNDLED_MODULES } from "./modules/index.js";
