/**
 * Brigade extension loader — runs modules into a registry, gated by config + env.
 *
 * Loads bundled (in-tree) modules PLUS user modules discovered under
 * `~/.brigade/extensions/`. Gating mirrors the plugins/skills model: global
 * `extensions.enabled`, an `allow` allowlist, a `disabled` deny-list, per-module
 * `entries[id].enabled`, each module's own `requiresEnv` + `eligible()` check,
 * and per-module `configSchema` validation of `entries[id].config`. A module
 * that throws (or fails validation) is skipped, never fatal. Bundled modules win
 * id conflicts with user modules (a user module can't shadow a core capability).
 *
 * Activation traceability: EVERY module decision (activated / skipped) emits a
 * structured log line under the `extensions/loader` subsystem. The reason is a
 * stable enum (`disabled`/`requiresEnv`/`eligible`/`allowlist`/`configSchema`/
 * `registerFailed`/`activation-not-triggered`) so an operator running
 * `brigade doctor` or scraping the JSONL log can answer "why didn't my plugin
 * load" without source-diving.
 *
 * Step 5 — manifest-driven LAZY activation. User modules are no longer imported
 * eagerly. The loader lists candidates WITHOUT importing, reads each one's
 * sidecar `brigade.extension.json` manifest, and consults the activation planner
 * (`activation-planner.ts`) against an active-config snapshot. A module whose
 * declared `activation` triggers don't fire is NEVER imported (its top-level
 * never runs) — O(manifest) boot. A module with no sidecar manifest is imported
 * to recover its `manifest` field, then re-planned from the body, so back-compat
 * holds (no manifest / no triggers ⇒ always activate). Skips here log
 * `reason=activation-not-triggered`.
 */

import { Check, Errors } from "typebox/value";

import type { BrigadeConfig } from "../../config/io.js";
import { resolveExtensionsDir } from "../../config/paths.js";
import { withTimeout } from "../../core/extension-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import {
	buildActivationSnapshot,
	planActivation,
	type ActivationSnapshot,
} from "./activation-planner.js";
import {
	type DiscoveredModule,
	importDiscoveredModules,
	listDiscoveryCandidates,
} from "./discovery.js";
import { BrigadeExtensionRegistry, diffCapabilityIds, type RegistryContextMeta } from "./registry.js";
import type { BrigadeModule } from "./types.js";

const log = createSubsystemLogger("extensions/loader");

// A module's register() should just record capabilities and return; cap it so a
// buggy/hung one can't wedge boot or a turn.
const REGISTER_TIMEOUT_MS = 10_000;

interface ExtensionEntryView {
	enabled?: boolean;
	config?: unknown;
}

interface ExtensionsConfigView {
	enabled?: boolean;
	allow?: string[];
	disabled?: string[];
	entries?: Record<string, ExtensionEntryView>;
}

function extensionsConfig(config: BrigadeConfig): ExtensionsConfigView | undefined {
	return (config as { extensions?: ExtensionsConfigView }).extensions;
}

/** Module ids disabled via `extensions.disabled[]` or `extensions.entries[id].enabled === false`. */
function resolveDisabled(config: BrigadeConfig): Set<string> {
	const out = new Set<string>();
	const ext = extensionsConfig(config);
	for (const id of ext?.disabled ?? []) out.add(id);
	for (const [id, entry] of Object.entries(ext?.entries ?? {})) {
		if (entry && entry.enabled === false) out.add(id);
	}
	return out;
}

export interface LoadModulesArgs {
	/** Bundled (in-tree) modules to load. */
	modules: BrigadeModule[];
	meta: RegistryContextMeta;
	/** Injected env for gating (tests); defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Override the user-extensions dir (tests); defaults to `~/.brigade/extensions`. */
	extensionsDir?: string;
	/** Skip filesystem discovery of user modules (tests / bundled-only callers). */
	noDiscovery?: boolean;
}

/** Per-module decision tag the loader emits on every load attempt. */
type ActivationReason =
	| "disabled"
	| "requiresEnv"
	| "eligible"
	| "allowlist"
	| "configSchema"
	| "registerFailed"
	// Step 5 (manifest-driven lazy activation): the module's declared
	// `activation` triggers did not match the active config, so the loader
	// never imported it (its top-level never ran).
	| "activation-not-triggered"
	// The module's manifest declares `enabledByDefault: false` (an opt-out) and
	// nothing in config explicitly turned it back on, so it stays dormant.
	| "enabledByDefault";

/**
 * Run the eligible modules into a fresh registry. Returns the populated
 * registry; the list of modules that actually registered is on
 * `registry.loadedModules` (for reload). Agent-level capabilities come back via
 * `toPiExtensionFactory()`, product-level via the getters.
 */
export async function loadModules(args: LoadModulesArgs): Promise<BrigadeExtensionRegistry> {
	const registry = new BrigadeExtensionRegistry();
	const config = args.meta.config;
	const ext = extensionsConfig(config);
	if (ext?.enabled === false) {
		return registry; // subsystem globally disabled → empty
	}
	const env = args.env ?? process.env;
	const disabled = resolveDisabled(config);
	const allow = ext?.allow ?? [];
	const entries = ext?.entries ?? {};

	// Bundled first; then user modules (deduped — a bundled id wins).
	//
	// Step 5 — manifest-driven LAZY activation. Instead of importing every user
	// candidate up front (eager, O(modules)), we list candidates WITHOUT
	// importing, read each one's sidecar `brigade.extension.json` manifest, and
	// consult the activation planner against the active-config snapshot. A
	// candidate whose declared activation triggers don't fire is NEVER imported
	// (its top-level never runs) — that's the cold-boot win. A candidate with no
	// sidecar manifest is imported to recover its `manifest` field, then planned
	// again from the body so back-compat is preserved (no manifest / no triggers
	// ⇒ always activate).
	const bundledIds = new Set(args.modules.map((m) => m.id));
	const userModules: DiscoveredModule[] = [];
	if (!args.noDiscovery) {
		// Fold the command names the bundled modules declare in their manifest
		// into the activation snapshot, so a user module gated only on
		// `onCommands:["foo"]` can match when a bundled module contributes `foo`
		// (the built-in channel commands are added by the snapshot itself when a
		// channel is configured).
		const declaredCommands = collectDeclaredCommandNames(args.modules);
		const snapshot: ActivationSnapshot = buildActivationSnapshot(config, declaredCommands);
		const candidates = listDiscoveryCandidates(args.extensionsDir ?? resolveExtensionsDir());
		for (const cand of candidates) {
			if (cand.safetyReason) {
				log.warn("rejected user extension — POSIX safety check failed", {
					source: cand.source,
					reason: cand.safetyReason,
				});
				continue;
			}

			// (a) Sidecar present → plan BEFORE importing. A non-triggered module is
			// skipped here and its body never runs (the lazy-activation win).
			if (cand.manifest) {
				const decision = planActivation(cand.manifest, snapshot);
				if (!decision.activate) {
					logSkip(
						cand.manifest.id,
						"user",
						cand.source,
						"activation-not-triggered",
						decision.reason ?? "activation triggers did not match active config",
					);
					continue;
				}
			}

			// (b) Import the body (sidecar said activate, or there was no sidecar so
			// we must read the module's own `manifest` field). The sidecar manifest,
			// when present, is authoritative over a body-carried one.
			const discovered = await importDiscoveredModules(cand.source, cand.manifest);
			for (const d of discovered) {
				// (c) No sidecar → re-plan from the body manifest (could carry its own
				// activation triggers). If it doesn't trigger, skip registration —
				// the body did run (no sidecar to gate on), but we still don't
				// register a module the active config doesn't want.
				if (!cand.manifest) {
					const decision = planActivation(d.manifest, snapshot);
					if (!decision.activate) {
						logSkip(
							d.module.id,
							"user",
							d.source,
							"activation-not-triggered",
							decision.reason ?? "activation triggers did not match active config",
						);
						continue;
					}
				}
				if (bundledIds.has(d.module.id)) {
					log.warn("user extension shadows a bundled module id — ignoring the user one", {
						id: d.module.id,
						source: d.source,
					});
					continue;
				}
				userModules.push(d);
			}
		}
	}

	// Pair each module with its origin/source so the activation log can record
	// provenance for both bundled and user modules.
	type Decision = { module: BrigadeModule; origin: "bundled" | "user"; source?: string };
	const all: Decision[] = [
		...args.modules.map<Decision>((m) => ({ module: m, origin: "bundled" })),
		...userModules.map<Decision>((d) => ({ module: d.module, origin: "user", source: d.source })),
	];

	for (const { module: m, origin, source } of all) {
		if (disabled.has(m.id)) {
			logSkip(m.id, origin, source, "disabled", "extensions.disabled[] or entries[id].enabled=false");
			continue;
		}
		// Allowlist: when non-empty, only listed modules load.
		if (allow.length > 0 && !allow.includes(m.id)) {
			logSkip(m.id, origin, source, "allowlist", "extensions.allow does not include this id");
			continue;
		}
		// `enabledByDefault: false` opt-out — a module (typically a bundled one)
		// can declare it does NOT auto-activate. It stays dormant unless the
		// operator explicitly turns it back on via `extensions.entries[id].enabled
		// = true` or by naming it in a non-empty `extensions.allow`. (An explicit
		// `disabled` already short-circuited above; the allowlist gate above means
		// that if we got here with a non-empty allow list, the id IS listed.)
		if (m.manifest?.enabledByDefault === false) {
			const forcedOn = entries[m.id]?.enabled === true || (allow.length > 0 && allow.includes(m.id));
			if (!forcedOn) {
				logSkip(
					m.id,
					origin,
					source,
					"enabledByDefault",
					"manifest enabledByDefault=false and not explicitly enabled (set extensions.entries[id].enabled=true to opt in)",
				);
				continue;
			}
		}
		if (m.requiresEnv) {
			const missing = m.requiresEnv.find((v) => !env[v] || env[v]?.trim() === "");
			if (missing) {
				logSkip(m.id, origin, source, "requiresEnv", `missing ${missing}`);
				continue;
			}
		}
		if (m.eligible && !m.eligible({ config, env })) {
			logSkip(m.id, origin, source, "eligible", "eligible() returned false");
			continue;
		}

		// Per-module config-schema validation against entries[id].config.
		const moduleConfig = entries[m.id]?.config;
		if (m.configSchema && !Check(m.configSchema, moduleConfig ?? {})) {
			// Surface the first validation error so the operator knows WHAT to set.
			const first = Errors(m.configSchema, moduleConfig ?? {})[0] as { path?: string; message?: string } | undefined;
			logSkip(
				m.id,
				origin,
				source,
				"configSchema",
				`config invalid at ${first?.path ?? "<root>"}: ${first?.message ?? "validation error"}`,
			);
			continue;
		}

		// FIX 4 — mark the module discovered (it passed gating) and snapshot the
		// registry's capability ids so we can attribute what THIS module registers.
		registry.markModuleDiscovered(m.id);
		const capsBefore = registry.capabilitySnapshot();
		try {
			// Time-box register so a hung module (e.g. a stray network await) can't
			// wedge boot or the per-turn path. A well-behaved register just records
			// and resolves instantly.
			await withTimeout(
				Promise.resolve(m.register(registry.context({ ...args.meta, moduleConfig }))),
				REGISTER_TIMEOUT_MS,
				`module ${m.id} register`,
			);
			registry.loadedModules.push(m);
			// FIX 4 — register() succeeded: attribute the newly-registered ids to
			// this module and flip its record to `activated`.
			registry.markModuleActivated(m.id, diffCapabilityIds(capsBefore, registry.capabilitySnapshot()));
			// Per-module activation trace — one line per bundled module. At `info`
			// this floods every short-lived CLI command (channels/pairing/agents all
			// activate the full bundle just to enumerate adapters) and gateway boot.
			// It's diagnostic detail, so it lives at `debug` (surface with --verbose
			// / BRIGADE_LOG_LEVEL=debug). Failures + shadows still log at warn above.
			log.debug("extension activated", { id: m.id, origin, source });
		} catch (err) {
			// FIX 4 — record the register-phase failure so the CLI can show it live.
			registry.markModuleFailed(m.id, "register");
			logSkip(
				m.id,
				origin,
				source,
				"registerFailed",
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	return registry;
}

/**
 * Collect the command names the given (bundled) modules declare in their
 * manifest's `provides.commands` slot. Used to seed the activation snapshot's
 * `commands` set so an `onCommands` trigger on a USER module can match a command
 * a BUNDLED module provides. Deduped + trimmed; empties dropped.
 *
 * Note: a module's runtime `command()` / `channelCommand()` registrations aren't
 * known until it's imported + registered, so we use the declarative manifest
 * rather than running anything — keeping lazy activation lazy.
 */
function collectDeclaredCommandNames(modules: ReadonlyArray<BrigadeModule>): string[] {
	const out = new Set<string>();
	for (const m of modules) {
		const provided = m.manifest?.provides?.commands ?? [];
		for (const name of provided) {
			const norm = typeof name === "string" ? name.trim() : "";
			if (norm) out.add(norm);
		}
	}
	return [...out];
}

/**
 * Emit a stable, structured `extension skipped` log line. The shape is
 * deliberately fixed (`id`/`origin`/`source`/`reason`/`cause`) so a future
 * `brigade doctor` UI can render skip explanations without source-diving.
 */
function logSkip(
	id: string,
	origin: "bundled" | "user",
	source: string | undefined,
	reason: ActivationReason,
	cause: string,
): void {
	const fields: Record<string, unknown> = { id, origin, reason, cause };
	if (source) fields.source = source;
	// `registerFailed` is a real error (the module threw); everything else is a
	// configured skip and stays at warn so it doesn't drown an operator who's
	// just running a constrained allowlist.
	if (reason === "registerFailed") {
		log.warn("extension register failed", fields);
	} else {
		// Per-module skip trace — same flood concern as "extension activated".
		// Diagnostic detail → debug (surface with --verbose).
		log.debug("extension skipped", fields);
	}
}
