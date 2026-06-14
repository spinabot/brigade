// src/storage/local/extension-store.ts
//
// LocalExtensionStore — filesystem-mode wrapper around
// `agents/extensions/discovery.ts`. Implements `ExtensionStore`.
//
// Surface: read-only discovery in filesystem mode. The convex-mode adapter
// (later PR) will expose `registerSource` / `unregisterSource` for operators
// uploading bundles through the dashboard; filesystem mode leaves those
// optional methods absent (the interface marks them optional, and bundled
// modules ship via the extensions dir on disk).

import * as path from "node:path";

import {
	clearDiscoveryCache,
	extensionsRootExists,
	listExtensionSources,
} from "../../agents/extensions/discovery.js";
import { resolveStateDir } from "../../config/paths.js";

import type { ExtensionStore } from "../store.js";

/** Canonical extensions dir. Brigade ships bundled modules under the package's
 *  `extensions/` and users drop additional `.js`/`.mjs` modules under
 *  `<stateDir>/extensions/`. We surface the user dir here (the bundled dir
 *  is wired by the plugin loader at boot, not via this store). */
function resolveExtensionsDir(): string {
	return path.join(resolveStateDir(), "extensions");
}

export class LocalExtensionStore implements ExtensionStore {
	constructor(private readonly _stateDir: string) {}

	async listSources(): Promise<
		ReadonlyArray<{ source: string; kind: "file" | "dir-index"; safetyReason: string | null }>
	> {
		return listExtensionSources(resolveExtensionsDir());
	}

	async rootExists(): Promise<boolean> {
		return extensionsRootExists(resolveExtensionsDir());
	}

	invalidateDiscoveryCache(): void {
		clearDiscoveryCache();
	}

	// registerSource / unregisterSource are optional on `ExtensionStore` and
	// filesystem mode deliberately omits them — operators install modules by
	// dropping them in `~/.brigade/extensions/`. Convex mode's adapter ships
	// these so operators can upload bundles through the dashboard without
	// shell access.
}
