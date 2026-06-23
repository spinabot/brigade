/**
 * Channel-messaging registry — the process-wide lookup behind "how do I
 * canonicalise / resolve an OUTBOUND target for channel <id>?".
 *
 * Mirrors the `channel-meta-registry.ts` pattern (FIX #9): a dynamic
 * registration seam keyed by lowercased channel id, resolved through one
 * process-global singleton so a hot reload (or CLI + gateway in one process)
 * shares a single slot.
 *
 * WHY A REGISTRY (and not "reach into the plugin off the manager"): the
 * `send_message` tool runs against the LEGACY `ChannelManager`
 * (`agents/channels/manager.ts`), which hands back a runtime `ChannelAdapter`
 * via `adapter(id)` and deliberately exposes NO `ChannelPlugin` (the plugins
 * live behind the multi-account plugin manager + `core/server.ts`). Pulling a
 * channel plugin module into the send path would also eagerly load its adapter
 * (Baileys sockets, the Telegram bot runtime). So instead the plugin engine
 * registers JUST the plugin's `messaging` adapter here — plain function
 * references, import-light — and the send tool consults this registry.
 *
 * A channel with NO `messaging` adapter simply never registers; the send tool's
 * `resolveOutboundTarget` then returns the raw `to` unchanged, so back-compat
 * is preserved by construction.
 */

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { ChannelMessagingAdapter } from "./types.adapters.js";

/** Process-global slot so a hot reload (or CLI+gateway in one process) shares one registry. */
const REGISTRY_STATE_KEY = Symbol.for("brigade.channelMessagingRegistry.state");

interface ChannelMessagingRegistryState {
	/** Dynamically-registered messaging adapters, keyed by lowercased channel id. */
	byChannelId: Map<string, ChannelMessagingAdapter>;
}

function createState(): ChannelMessagingRegistryState {
	return { byChannelId: new Map() };
}

function getState(): ChannelMessagingRegistryState {
	return resolveGlobalSingleton<ChannelMessagingRegistryState>(REGISTRY_STATE_KEY, createState);
}

/**
 * Register (or replace) a channel's OUTBOUND messaging adapter. The plugin
 * engine calls this when a channel module that declares `plugin.messaging`
 * registers, so the `send_message` tool can address by name/handle/explicit
 * target. Last registration per id wins. No-ops on an empty/unusable id.
 */
export function registerChannelMessagingAdapter(
	channelId: string | null | undefined,
	adapter: ChannelMessagingAdapter,
): void {
	const id = normalizeOptionalLowercaseString(channelId);
	if (!id) return;
	getState().byChannelId.set(id, adapter);
}

/**
 * Bulk-register every messaging adapter declared on a plugin list (skipping
 * plugins that omit the slot). The gateway bootstrap calls this once with its
 * `bundledChannelPlugins` — parallel to how it seeds the meta registry — so the
 * send tool can address by name/handle for any channel that opts in. Plugins
 * WITHOUT a `messaging` adapter are simply skipped, leaving raw-id passthrough.
 */
export function syncChannelMessagingAdaptersFromPlugins(
	plugins: ReadonlyArray<{ id: string; messaging?: ChannelMessagingAdapter }>,
): void {
	for (const plugin of plugins) {
		if (plugin.messaging) registerChannelMessagingAdapter(plugin.id, plugin.messaging);
	}
}

/** Test-only — drop every dynamically-registered messaging adapter. */
export function resetChannelMessagingRegistryForTests(): void {
	getState().byChannelId.clear();
}

/**
 * Look up a channel's registered OUTBOUND messaging adapter by id (or alias the
 * caller already normalized). Returns `undefined` when the channel registered
 * none — the caller then falls back to raw-id behaviour. Case-insensitive.
 */
export function getChannelMessagingAdapter(
	channelId: string | null | undefined,
): ChannelMessagingAdapter | undefined {
	const key = normalizeOptionalLowercaseString(channelId);
	if (!key) return undefined;
	return getState().byChannelId.get(key);
}

/* -------------------------------------------------------------------------
 * Default outbound-target resolution (the helper the send tool calls)
 * --------------------------------------------------------------------- */

/** Outcome of {@link resolveOutboundTarget}. */
export type ResolvedOutboundTarget = {
	/**
	 * The concrete target id to hand `ChannelAdapter.sendText`. When no
	 * messaging adapter is registered (or it couldn't improve on the input),
	 * this is the caller's raw `to`, byte-for-byte.
	 */
	to: string;
	/**
	 * A different channel id the explicit form re-targeted to (e.g. the agent
	 * passed `telegram:123` while sending through whatsapp). `undefined` when
	 * the target stays on the same channel. The caller decides whether to honor
	 * a cross-channel hop (owner gate) — this helper only surfaces it.
	 */
	channelId?: string;
	/** Whether a messaging adapter actually participated (for logging/tests). */
	usedAdapter: boolean;
	/** Whether the optional `targetResolver` resolved a human name → id. */
	resolvedByName: boolean;
};

/**
 * Heuristic: does this `to` look like a human NAME / handle rather than an
 * already-concrete conversation id? Concrete ids carry channel-shape markers
 * (a `:` scheme, an `@` domain like `…@s.whatsapp.net`, a leading `+`, or are
 * all-digits). A bare word / `@handle` is treated as a name worth resolving.
 * Deliberately conservative — when unsure we DON'T treat it as a name, so we
 * never send a resolver a value that's plainly an id.
 */
export function looksLikeContactName(to: string): boolean {
	const t = to.trim();
	if (t.length === 0) return false;
	// `scheme:value` (telegram:123) — explicit id form, not a name.
	if (/^[a-z][a-z0-9_-]*:/i.test(t)) return false;
	// `user@domain` JID (14057144199@s.whatsapp.net) — an id, not a name.
	if (/@[^@\s]+\.[^@\s]+$/.test(t)) return false;
	// Phone-ish (+15551234567 / 15551234567) — an id, not a name.
	if (/^\+?\d[\d\s().-]{4,}$/.test(t)) return false;
	// `@handle` OR a plain word/words → treat as a name worth resolving.
	return true;
}

/**
 * Turn the agent's loose `to` into a concrete outbound target for `channelId`,
 * using that channel's registered `messaging` adapter when present. The order
 * matches the `ChannelMessagingAdapter` contract:
 *
 *   1. No adapter registered → return the raw `to` UNCHANGED (back-compat).
 *   2. `parseExplicitTarget(to)` — honor an explicit `scheme:value` / `@handle`
 *      form (and surface any cross-channel id it named).
 *   3. If we're still holding a NAME (not an explicit target) and the adapter
 *      ships a `targetResolver`, resolve name → id; on a null/throw result fall
 *      back to the name as-is.
 *   4. `normalizeTarget(...)` — canonicalise the final target id.
 *
 * NEVER throws: a misbehaving adapter (parse/normalize/resolve throwing) is
 * caught and degrades to the raw `to`, so a buggy channel can't break sends.
 */
export async function resolveOutboundTarget(params: {
	channelId: string;
	to: string;
}): Promise<ResolvedOutboundTarget> {
	const { channelId, to } = params;
	const adapter = getChannelMessagingAdapter(channelId);
	// (1) No messaging adapter → raw-id passthrough, byte-for-byte.
	if (!adapter) {
		return { to, usedAdapter: false, resolvedByName: false };
	}

	try {
		let target = to;
		let crossChannelId: string | undefined;
		let isExplicit = false;

		// (2) Explicit-target form?
		const parsed = adapter.parseExplicitTarget(to);
		if (parsed) {
			isExplicit = true;
			target = parsed.target;
			if (parsed.channelId) crossChannelId = parsed.channelId;
		}

		// (3) Name → id resolution (only when NOT an explicit target, the input
		//     reads like a name, and the channel ships a resolver).
		let resolvedByName = false;
		if (!isExplicit && typeof adapter.targetResolver === "function" && looksLikeContactName(target)) {
			const resolved = await adapter.targetResolver(target);
			if (resolved != null && resolved !== "") {
				target = resolved;
				resolvedByName = true;
			}
			// null/empty → fall through with the name unchanged (caller may still
			// send to it verbatim, matching the no-resolver path).
		}

		// (4) Canonicalise.
		const normalized = adapter.normalizeTarget(target);
		const finalTo = normalized && normalized.length > 0 ? normalized : target;

		return {
			to: finalTo,
			...(crossChannelId ? { channelId: crossChannelId } : {}),
			usedAdapter: true,
			resolvedByName,
		};
	} catch {
		// A misbehaving adapter must never break sends — degrade to the raw id.
		return { to, usedAdapter: false, resolvedByName: false };
	}
}
