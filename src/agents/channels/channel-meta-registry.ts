/**
 * Channel-meta registry — the process-wide lookup behind "what does channel
 * <id> declare about itself?" (markdown capability, exposure, aliases, …).
 *
 * Brand-scrubbed analogue of upstream's `src/channels/registry.ts` +
 * `src/channels/chat-meta.ts` two-tier lookup, collapsed to the slice Brigade
 * needs: a built-in catalog of the bundled channels' metas, plus a dynamic
 * registration seam for channels that register through the plugin engine.
 *
 * WHY A REGISTRY (and not "just read `bundledChannelPlugins`"): the gateway's
 * `bundledChannelPlugins` list (`core/server.ts`) is only populated for the
 * MULTI-ACCOUNT plugin path, and pulling a channel plugin module into the
 * system-prompt layer would eagerly load its adapter (Baileys sockets, the
 * Telegram bot runtime, …). This module is import-light on purpose: the
 * built-in metas are plain data constants (see `bundled-channel-metas.ts`),
 * so the markdown gate + exposure resolver can consult channel metadata from
 * anywhere — including the system-prompt assembly — without dragging the
 * runtime in.
 *
 * Lookup order (mirrors upstream's built-in-then-plugin precedence):
 *   1. Dynamically-registered plugin metas (last registration wins per id).
 *   2. The built-in bundled catalog (WhatsApp, Telegram).
 *
 * Ids and aliases are matched case-insensitively. Unknown ids return
 * `undefined` so callers can apply their own default (the markdown gate
 * deliberately defaults markdown ON for unknown channels — see
 * `isMarkdownCapableChannel`).
 */

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { BUNDLED_CHANNEL_METAS } from "./bundled-channel-metas.js";
import type { ChannelMeta } from "./types.core.js";

/** Process-global slot so a hot reload (or CLI+gateway in one process) shares one registry. */
const REGISTRY_STATE_KEY = Symbol.for("brigade.channelMetaRegistry.state");

interface ChannelMetaRegistryState {
	/** Dynamically-registered metas, keyed by lowercased channel id. */
	dynamic: Map<string, ChannelMeta>;
}

function createState(): ChannelMetaRegistryState {
	return { dynamic: new Map() };
}

function getState(): ChannelMetaRegistryState {
	return resolveGlobalSingleton<ChannelMetaRegistryState>(REGISTRY_STATE_KEY, createState);
}

/**
 * Register (or replace) a channel's meta at runtime. The plugin engine calls
 * this when a channel module registers, so external / future channels surface
 * in the same lookups as the bundled ones. Last registration per id wins.
 * No-ops on a meta without a usable id.
 */
export function registerChannelMeta(meta: ChannelMeta): void {
	const id = normalizeOptionalLowercaseString(meta?.id);
	if (!id) return;
	getState().dynamic.set(id, meta);
}

/** Test-only — drop every dynamically-registered meta (the built-in catalog is untouched). */
export function resetChannelMetaRegistryForTests(): void {
	getState().dynamic.clear();
}

/**
 * Build the merged lookup map for a single resolution pass: built-in catalog
 * first, then dynamic registrations layered on top (dynamic wins per id).
 * Each meta is indexed by its own id AND every declared alias (all lowercased).
 */
function buildLookup(): Map<string, ChannelMeta> {
	const byKey = new Map<string, ChannelMeta>();
	const index = (meta: ChannelMeta) => {
		const id = normalizeOptionalLowercaseString(meta.id);
		if (!id) return;
		byKey.set(id, meta);
		for (const alias of meta.aliases ?? []) {
			const a = normalizeOptionalLowercaseString(alias);
			if (a) byKey.set(a, meta);
		}
	};
	for (const meta of BUNDLED_CHANNEL_METAS) index(meta);
	// Dynamic registrations layer on top so an external plugin can override a
	// bundled channel's meta (and so its id/aliases win on collision).
	for (const meta of getState().dynamic.values()) index(meta);
	return byKey;
}

/**
 * Look up a registered channel plugin's full `ChannelMeta` by id or alias.
 * Returns `undefined` for an unknown channel. Case-insensitive.
 *
 * Named to mirror the upstream accessor (`getRegisteredChannelPluginMeta`) so
 * the parity story is legible; `getChatChannelMeta` is the friendlier alias.
 */
export function getRegisteredChannelPluginMeta(channelId: string | null | undefined): ChannelMeta | undefined {
	const key = normalizeOptionalLowercaseString(channelId);
	if (!key) return undefined;
	return buildLookup().get(key);
}

/** Friendlier alias for {@link getRegisteredChannelPluginMeta}. */
export function getChatChannelMeta(channelId: string | null | undefined): ChannelMeta | undefined {
	return getRegisteredChannelPluginMeta(channelId);
}

/** Every channel meta currently known (built-in + dynamic), de-duplicated by id. */
export function listChannelMetas(): ChannelMeta[] {
	const seen = new Set<string>();
	const out: ChannelMeta[] = [];
	const push = (meta: ChannelMeta) => {
		const id = normalizeOptionalLowercaseString(meta.id);
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push(meta);
	};
	// Dynamic first so an override replaces the bundled entry in the output.
	for (const meta of getState().dynamic.values()) push(meta);
	for (const meta of BUNDLED_CHANNEL_METAS) push(meta);
	return out;
}
