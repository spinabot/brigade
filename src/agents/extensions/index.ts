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
	GatewayCaller,
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
export {
	BrigadeExtensionRegistry,
	diffCapabilityIds,
	type PluginCapabilityIds,
	type PluginRecord,
	type PluginRecordStatus,
	type RegistryContextMeta,
} from "./registry.js";
export {
	clearDiscoveryCache,
	discoverUserModules,
	type DiscoveredModule,
	type DiscoveryCandidate,
	importDiscoveredModules,
	listDiscoveryCandidates,
	readSidecarManifest,
} from "./discovery.js";
export {
	type ActivationDecision,
	type ActivationSnapshot,
	BUILTIN_CHANNEL_COMMAND_NAMES,
	buildActivationSnapshot,
	planActivation,
} from "./activation-planner.js";
export { loadModules, type LoadModulesArgs } from "./loader.js";
export { BUNDLED_MODULES } from "./modules/index.js";
