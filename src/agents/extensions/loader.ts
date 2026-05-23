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
 */

import { Check, Errors } from "typebox/value";

import type { BrigadeConfig } from "../../config/io.js";
import { resolveExtensionsDir } from "../../config/paths.js";
import { withTimeout } from "../../core/extension-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { discoverUserModules } from "./discovery.js";
import { BrigadeExtensionRegistry, type RegistryContextMeta } from "./registry.js";
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
	const bundledIds = new Set(args.modules.map((m) => m.id));
	const userModules: BrigadeModule[] = [];
	if (!args.noDiscovery) {
		const discovered = await discoverUserModules(args.extensionsDir ?? resolveExtensionsDir());
		for (const d of discovered) {
			if (bundledIds.has(d.module.id)) {
				log.warn("user extension shadows a bundled module id — ignoring the user one", {
					id: d.module.id,
					source: d.source,
				});
				continue;
			}
			userModules.push(d.module);
		}
	}
	const all = [...args.modules, ...userModules];

	for (const m of all) {
		if (disabled.has(m.id)) continue;
		// Allowlist: when non-empty, only listed modules load.
		if (allow.length > 0 && !allow.includes(m.id)) continue;
		if (m.requiresEnv && m.requiresEnv.some((v) => !env[v] || env[v]?.trim() === "")) continue;
		if (m.eligible && !m.eligible({ config, env })) continue;

		// Per-module config-schema validation against entries[id].config.
		const moduleConfig = entries[m.id]?.config;
		if (m.configSchema && !Check(m.configSchema, moduleConfig ?? {})) {
			// Surface the first validation error so the operator knows WHAT to set.
			const first = Errors(m.configSchema, moduleConfig ?? {})[0] as { path?: string; message?: string } | undefined;
			log.warn("extension config failed validation — skipping module", {
				module: m.id,
				path: first?.path,
				reason: first?.message,
			});
			continue;
		}

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
		} catch (err) {
			log.warn("extension module register failed", {
				module: m.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return registry;
}
