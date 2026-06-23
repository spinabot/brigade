/**
 * Manifest-driven lazy activation planner (plugin SDK Step 5).
 *
 * Today the loader imports + runs `register()` EAGERLY for every eligible user
 * module. With many installed modules that's O(modules) cold-boot cost paid even
 * for modules whose capability is irrelevant to the active config (a Slack
 * channel module on an install with no Slack channel configured still gets
 * imported + registered). The `BrigadeModuleManifest.activation` block
 * (`onChannels` / `onProviders` / `onCommands` / `onCapabilities`) declares WHEN
 * a module is relevant; this planner consumes it so the loader can SKIP importing
 * a module whose triggers don't fire — O(manifest) boot instead of O(modules).
 *
 * ── Trigger semantics ──────────────────────────────────────────────────────
 * The planner takes a module's `activation` triggers + an `ActivationSnapshot`
 * (a cheap, config-derived view of what's active right now) and returns
 * `{ activate, reason? }`.
 *
 *   - NO manifest, or a manifest with NO `activation` block, or an `activation`
 *     block with NO non-empty trigger array ⇒ ALWAYS activate (back-compat:
 *     nothing that worked before regresses; a module that doesn't opt into lazy
 *     activation keeps loading eagerly).
 *
 *   - When `activation` declares one or more NON-EMPTY trigger arrays, the
 *     module activates iff AT LEAST ONE declared trigger matches the snapshot
 *     (OR across trigger kinds AND across entries within a kind — any single
 *     hit is enough). The intent of a trigger is "load me when X is present",
 *     so the union (not intersection) is the correct semantics: a module that
 *     declares both `onChannels: ["slack"]` and `onProviders: ["openai"]` wants
 *     to load if EITHER Slack is configured OR OpenAI is the active provider.
 *
 *   - A trigger array that is present but EMPTY (`onChannels: []`) is treated as
 *     "no constraint from this kind" — it neither forces activation nor blocks
 *     it; only non-empty arrays carry a constraint. If ALL declared arrays are
 *     empty the module falls back to the back-compat ALWAYS-activate rule.
 *
 *   Match rules per trigger kind (all case-insensitive, trimmed):
 *     - `onChannels`    matches a channel id that is CONFIGURED + ENABLED
 *                       (`cfg.channels.<id>` present and not `enabled === false`).
 *     - `onProviders`   matches the active model provider
 *                       (`cfg.agents.defaults.provider`) OR any provider id that
 *                       appears in a configured channel/model — the snapshot
 *                       collects the set; the planner only checks membership.
 *     - `onCommands`    matches an AVAILABLE command name. The snapshot's
 *                       `commands` set is the union of (a) the built-in channel
 *                       commands every configured channel exposes (`/help`,
 *                       `/status`, `/agent`, …) and (b) any extra command names
 *                       the loader supplies (e.g. command names the bundled
 *                       modules declare in their manifest). A module gated only
 *                       on `onCommands:[...]` activates when one of its named
 *                       commands is available — otherwise it stays dormant.
 *     - `onCapabilities` matches an `extensions.slots.<slot>` value the operator
 *                       pinned (memory / contextEngine / compaction /
 *                       agentHarness) — a module that PROVIDES the pinned backend
 *                       activates; others stay dormant.
 *
 * The planner is a PURE function: no I/O, no config reads of its own. The loader
 * builds the snapshot once (via `buildActivationSnapshot`) and consults the
 * planner per module BEFORE importing it.
 */

import type { BrigadeConfig } from "../../config/io.js";
import type { BrigadeModuleManifest } from "./types.js";

/**
 * A cheap, config-derived view of "what is active right now" the planner matches
 * activation triggers against. Built ONCE per load by `buildActivationSnapshot`
 * and reused for every module so the per-module decision stays O(triggers).
 * Every set holds lowercased + trimmed ids so matching is case-insensitive.
 */
export interface ActivationSnapshot {
	/** Channel ids that are configured + enabled (`cfg.channels.<id>`, not `enabled:false`). */
	readonly channels: ReadonlySet<string>;
	/** Active / referenced model provider ids (`agents.defaults.provider` + any seen on channels). */
	readonly providers: ReadonlySet<string>;
	/**
	 * Command names available to the active install — the union of the built-in
	 * channel commands every configured channel exposes (`/help`, `/status`, …)
	 * and any extra names the loader supplies. An `onCommands` trigger matches
	 * against this set.
	 */
	readonly commands: ReadonlySet<string>;
	/** Capability backends pinned via `extensions.slots.<slot>` (memory/contextEngine/…). */
	readonly capabilities: ReadonlySet<string>;
}

/** Outcome of an activation decision for a single module. */
export interface ActivationDecision {
	/** Whether the module should be imported + registered. */
	activate: boolean;
	/**
	 * When `activate` is false, a stable, operator-facing reason naming the
	 * triggers that failed to match (fed into the loader's skip log). Undefined
	 * when the module activates.
	 */
	reason?: string;
}

/**
 * The built-in channel command names Brigade wires for EVERY configured channel
 * (`buildBundledCommands` in the inbound pipeline produces these). They are a
 * stable, channel-neutral constant, so the snapshot can fold them into the
 * `commands` set whenever at least one channel is configured WITHOUT importing
 * the pipeline (which would pull a heavy module into this pure planner). A bundled
 * channel like `/help` is therefore matchable by an `onCommands:["help"]` trigger
 * on any install that has a channel. Module-contributed commands are passed in
 * separately via `buildActivationSnapshot(config, availableCommands)`.
 */
export const BUILTIN_CHANNEL_COMMAND_NAMES: readonly string[] = [
	"help",
	"start",
	"pending",
	"approve",
	"deny",
	"status",
	"allowlist",
	"agent",
	"agents",
	"whoami",
	"org",
];

/** Lowercase + trim a list into a set, dropping empties. */
function toSet(values: ReadonlyArray<string> | undefined): Set<string> {
	const out = new Set<string>();
	for (const v of values ?? []) {
		const norm = typeof v === "string" ? v.trim().toLowerCase() : "";
		if (norm) out.add(norm);
	}
	return out;
}

/** Does any entry of `wanted` appear in `have`? (case-insensitive; inputs pre-normalized.) */
function anyMatch(wanted: ReadonlyArray<string>, have: ReadonlySet<string>): boolean {
	for (const w of wanted) {
		const norm = typeof w === "string" ? w.trim().toLowerCase() : "";
		if (norm && have.has(norm)) return true;
	}
	return false;
}

/**
 * Build the activation snapshot from the active config. Pure read — never
 * mutates config, never touches disk. The loader calls this once before the
 * per-module loop.
 *
 * `availableCommands` (optional) lets the caller fold in EXTRA command names
 * that aren't derivable from config alone — e.g. the command names the bundled
 * modules declare in their manifest. They are merged with the built-in channel
 * command set (the latter added only when at least one channel is configured),
 * so an `onCommands` trigger can fire off either source.
 */
export function buildActivationSnapshot(
	config: BrigadeConfig,
	availableCommands?: ReadonlyArray<string>,
): ActivationSnapshot {
	const channels = new Set<string>();
	const providers = new Set<string>();
	const commands = new Set<string>();
	const capabilities = new Set<string>();

	// ── channels: cfg.channels.<id> present and not explicitly disabled.
	const channelsCfg = (config as { channels?: Record<string, { enabled?: boolean; provider?: string } | undefined> })
		.channels;
	if (channelsCfg && typeof channelsCfg === "object") {
		for (const [id, slot] of Object.entries(channelsCfg)) {
			const norm = id.trim().toLowerCase();
			if (!norm) continue;
			// A slot that exists counts as "configured"; only an explicit
			// `enabled: false` opts out. (Mirrors the channel manager, which
			// treats an absent `enabled` as on once the slot has credentials.)
			if (slot && typeof slot === "object" && slot.enabled === false) continue;
			channels.add(norm);
			// A channel may name an owning provider; fold it into the provider set
			// so an `onProviders` trigger can fire off a channel's transport too.
			if (slot && typeof slot === "object" && typeof slot.provider === "string") {
				const p = slot.provider.trim().toLowerCase();
				if (p) providers.add(p);
			}
		}
	}

	// ── providers: the active model provider stamped at onboard time.
	const activeProvider = (config as { agents?: { defaults?: { provider?: string } } }).agents?.defaults?.provider;
	if (typeof activeProvider === "string") {
		const p = activeProvider.trim().toLowerCase();
		if (p) providers.add(p);
	}

	// ── capabilities: pinned slot backends (memory/contextEngine/compaction/agentHarness).
	const slots = (config as { extensions?: { slots?: Record<string, string | undefined> } }).extensions?.slots;
	if (slots && typeof slots === "object") {
		for (const value of Object.values(slots)) {
			if (typeof value !== "string") continue;
			const norm = value.trim().toLowerCase();
			if (norm) capabilities.add(norm);
		}
	}

	// ── commands: the built-in channel commands are wired for EVERY configured
	// channel, so they become "available" the moment any channel is configured.
	// (No channel ⇒ no channel command surface ⇒ leave them out.)
	if (channels.size > 0) {
		for (const name of BUILTIN_CHANNEL_COMMAND_NAMES) commands.add(name);
	}
	// Plus any extra command names the caller supplies (e.g. command names the
	// bundled modules declare). Normalized + deduped like every other set.
	for (const name of availableCommands ?? []) {
		const norm = typeof name === "string" ? name.trim().toLowerCase() : "";
		if (norm) commands.add(norm);
	}

	return { channels, providers, commands, capabilities };
}

/**
 * Decide whether a module should activate, given its manifest (or `undefined`)
 * and the active-config snapshot. PURE — see file header for the full trigger
 * semantics. The headline rules:
 *   - no manifest / no activation / no non-empty triggers ⇒ activate (back-compat)
 *   - otherwise activate iff at least one declared trigger matches the snapshot.
 */
export function planActivation(
	manifest: BrigadeModuleManifest | undefined,
	snapshot: ActivationSnapshot,
): ActivationDecision {
	const activation = manifest?.activation;
	if (!activation) {
		// No manifest or no activation block — always-on (eager, as before).
		return { activate: true };
	}

	const onChannels = toSet(activation.onChannels);
	const onProviders = toSet(activation.onProviders);
	const onCommands = toSet(activation.onCommands);
	const onCapabilities = toSet(activation.onCapabilities);

	const declaredKinds: Array<{ kind: string; wanted: Set<string>; have: ReadonlySet<string> }> = [];
	if (onChannels.size > 0) declaredKinds.push({ kind: "onChannels", wanted: onChannels, have: snapshot.channels });
	if (onProviders.size > 0)
		declaredKinds.push({ kind: "onProviders", wanted: onProviders, have: snapshot.providers });
	if (onCommands.size > 0) declaredKinds.push({ kind: "onCommands", wanted: onCommands, have: snapshot.commands });
	if (onCapabilities.size > 0)
		declaredKinds.push({ kind: "onCapabilities", wanted: onCapabilities, have: snapshot.capabilities });

	// No non-empty trigger arrays — the activation block carries no constraint,
	// so the module stays always-on (back-compat).
	if (declaredKinds.length === 0) {
		return { activate: true };
	}

	// Activate iff ANY declared trigger matches the snapshot.
	for (const { wanted, have } of declaredKinds) {
		if (anyMatch([...wanted], have)) {
			return { activate: true };
		}
	}

	// Nothing matched — describe what would have been needed.
	const detail = declaredKinds
		.map(({ kind, wanted }) => `${kind}=[${[...wanted].join(",")}]`)
		.join(" ");
	return {
		activate: false,
		reason: `no activation trigger matched active config (${detail})`,
	};
}
