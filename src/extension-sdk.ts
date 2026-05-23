/**
 * `brigade/extension-sdk` — the stable surface for authoring Brigade extensions.
 *
 * Out-of-tree modules dropped into `~/.brigade/extensions/` import from HERE,
 * never from Brigade internals:
 *
 * ```ts
 * import { defineModule } from "brigade/extension-sdk";
 *
 * export default defineModule({
 *   id: "my-channel",
 *   register(b) {
 *     b.channel(myAdapter);          // product-level (gateway)
 *     b.tool(myTool);                // agent-level (replayed into Pi)
 *     b.gatewayMethod({ name: "my.status", handler: async () => ({ ok: true }) });
 *   },
 * });
 * ```
 *
 * Everything re-exported here is part of Brigade's public extension contract and
 * is versioned with the package — module authors can rely on it not shifting
 * underneath them. (Internal wiring — the registry, loader, discovery — is NOT
 * exported; authors never touch it.)
 */

export { defineModule } from "./agents/extensions/types.js";
export type { AgentToolResult, AgentToolUpdateCallback, AnyBrigadeTool, BrigadeTool } from "./agents/tools/types.js";
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
} from "./agents/extensions/types.js";
