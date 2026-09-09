/** Brigade binding. Canonical memory implementation lives in src/tideline/. */
import { FactStore as TidelineFactStore, type FactStoreOptions } from "../../tideline/store/records.js";
import { createBrigadeMemoryHostPorts } from "./host-ports.js";

export * from "../../tideline/store/records.js";

/** Preserve Brigade's runtime-backed behavior without changing standalone instances. */
export class FactStore extends TidelineFactStore {
	constructor(workspaceDir: string, opts: FactStoreOptions = {}) {
		super(workspaceDir, { ...opts, hostPorts: opts.hostPorts ?? createBrigadeMemoryHostPorts() });
	}
}
