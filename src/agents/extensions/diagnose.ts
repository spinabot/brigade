/**
 * Extension diagnosis — the shared, registry-free analysis behind
 * `brigade extensions list` and `brigade extensions doctor`.
 *
 * It answers two questions for the operator authoring a plugin:
 *   1. WHAT modules exist — the bundled set that ships with Brigade plus every
 *      module dropped into `~/.brigade/extensions/`.
 *   2. For each user module, WOULD IT LOAD — did it pass the safety gate, did it
 *      import cleanly, and did it export a usable module? When the answer is no,
 *      the exact reason (so the author can fix it).
 *
 * This deliberately does NOT run a module's `register()` or touch a registry —
 * it inspects candidates the same way discovery would, so it's safe to call from
 * a short-lived CLI command. The richer config-gating decisions (allowlist /
 * disabled / requiresEnv / configSchema) live in the loader's structured logs;
 * this surface covers the discovery half ("did Brigade even find + import it").
 */

import {
	checkPosixSafety,
	importCandidateForDiagnosis,
	listExtensionSources,
} from "./discovery.js";
import type { BrigadeExtensionRegistry, PluginRecord } from "./registry.js";
import type { BrigadeModule } from "./types.js";

/** Where a module came from. */
export type ExtensionOrigin = "bundled" | "user";

/** Headline status shown in the `list` table. */
export type ExtensionStatus = "loaded" | "skipped";

/**
 * One diagnosed extension entry — a bundled module OR a user candidate. The same
 * shape feeds both the `list` table and the deeper `doctor` view.
 */
export interface DiagnosedExtension {
	/** The module's declared id, or — for a user candidate that never produced a
	 *  module — a readable label derived from its file. */
	id: string;
	origin: ExtensionOrigin;
	/** Absolute source path the module was found at. */
	source: string;
	status: ExtensionStatus;
	/** One short, non-jargony line explaining a `skipped` status. */
	reason?: string;
	/** Per-candidate detail (user modules only) for the `doctor` view. */
	checks?: {
		/** Passed the file-safety gate. */
		safe: boolean;
		/** Imported without error. */
		imported: boolean;
		/** Exported a usable module. */
		exportedModule: boolean;
	};
	/**
	 * Live REGISTER-phase status (FIX 4), present ONLY when a live registry was
	 * passed to `diagnoseExtensions`. Discovery alone never runs `register()`, so
	 * without a live registry this is undefined and the discovery-only path is
	 * byte-identical to before. When present it reflects the durable
	 * `PluginRecord`: did the module activate, fail, or just get discovered, and
	 * which capability ids it registered.
	 */
	live?: {
		status: PluginRecord["status"];
		failurePhase?: string;
		/** Flat list of `kind:id` strings for the capabilities the module registered. */
		capabilities: string[];
	};
}

/** Result of a full diagnosis pass over the bundled + user extension sets. */
export interface ExtensionDiagnosis {
	/** The extensions directory that was scanned. */
	extensionsDir: string;
	/** Every diagnosed entry, bundled first then user, each set id-sorted. */
	extensions: DiagnosedExtension[];
}

/** Derive a friendly label for a user candidate that never yielded a module id. */
function labelFromSource(source: string): string {
	// `<dir>/index.ts` → the folder name; otherwise the file's base name.
	const parts = source.replace(/\\/g, "/").split("/");
	const base = parts[parts.length - 1] ?? source;
	if (/^index\.(js|mjs|ts|mts)$/i.test(base) && parts.length >= 2) {
		return parts[parts.length - 2] ?? base;
	}
	return base.replace(/\.(js|mjs|ts|mts)$/i, "");
}

/**
 * Diagnose every bundled module + every user candidate under `extensionsDir`.
 *
 * Bundled modules are always reported as `loaded` (they ship in-tree and import
 * at build time). User candidates are taken through the same gate discovery uses
 * — safety check, then import, then valid-module check — and reported with the
 * first failing step as the skip reason.
 *
 * `liveRegistry` (optional, FIX 4) — when a caller has a LIVE registry (one that
 * actually ran `register()`), pass it to overlay each entry's `live` field with
 * the durable `PluginRecord` (register-phase status + attributed capabilities).
 * Omit it (the CLI's default) and the result is byte-identical to the pure
 * discovery pass — no `register()` is ever run here.
 */
export async function diagnoseExtensions(
	bundled: ReadonlyArray<BrigadeModule>,
	extensionsDir: string,
	liveRegistry?: BrigadeExtensionRegistry,
): Promise<ExtensionDiagnosis> {
	const out: DiagnosedExtension[] = [];

	const overlayLive = (entry: DiagnosedExtension): DiagnosedExtension => {
		if (!liveRegistry) return entry;
		const rec = liveRegistry.pluginRecord(entry.id);
		if (!rec) return entry;
		return { ...entry, live: pluginRecordToLive(rec) };
	};

	// Bundled set — sorted by id for a stable table.
	for (const m of [...bundled].sort((a, b) => a.id.localeCompare(b.id))) {
		out.push(overlayLive({ id: m.id, origin: "bundled", source: "(built in)", status: "loaded" }));
	}

	// User candidates — diagnosed one by one.
	const userEntries: DiagnosedExtension[] = [];
	for (const candidate of listExtensionSources(extensionsDir)) {
		const { source } = candidate;
		// Re-run the safety check rather than trust `candidate.safetyReason`
		// alone, so the verdict and the rest of the diagnosis share one source.
		const safetyReason = candidate.safetyReason ?? checkPosixSafety(source, extensionsDir);
		if (safetyReason) {
			userEntries.push({
				id: labelFromSource(source),
				origin: "user",
				source,
				status: "skipped",
				reason: "blocked by a safety check on the file",
				checks: { safe: false, imported: false, exportedModule: false },
			});
			continue;
		}

		const result = await importCandidateForDiagnosis(source);
		if (!result.imported) {
			userEntries.push({
				id: labelFromSource(source),
				origin: "user",
				source,
				status: "skipped",
				reason: "the file could not be loaded — check it for errors",
				checks: { safe: true, imported: false, exportedModule: false },
			});
			continue;
		}
		if (!result.hasValidModule) {
			userEntries.push({
				id: labelFromSource(source),
				origin: "user",
				source,
				status: "skipped",
				reason: "the file does not export a Brigade module (use `export default defineModule({...})`)",
				checks: { safe: true, imported: true, exportedModule: false },
			});
			continue;
		}
		userEntries.push({
			id: result.moduleId ?? labelFromSource(source),
			origin: "user",
			source,
			status: "loaded",
			checks: { safe: true, imported: true, exportedModule: true },
		});
	}

	userEntries.sort((a, b) => a.id.localeCompare(b.id));
	out.push(...userEntries.map(overlayLive));
	return { extensionsDir, extensions: out };
}

/** Flatten a `PluginRecord` into the diagnosis `live` view (`kind:id` capability strings). */
function pluginRecordToLive(rec: PluginRecord): NonNullable<DiagnosedExtension["live"]> {
	const capabilities: string[] = [];
	for (const [kind, ids] of Object.entries(rec.capabilities)) {
		for (const id of ids) capabilities.push(`${kind}:${id}`);
	}
	return {
		status: rec.status,
		...(rec.failurePhase !== undefined ? { failurePhase: rec.failurePhase } : {}),
		capabilities,
	};
}
