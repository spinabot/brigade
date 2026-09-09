/** Compatibility entry. Canonical implementation lives in src/tideline/. */
export * from "../../tideline/lifecycle/decay.js";
import { runDecayGc as runCoreDecayGc } from "../../tideline/lifecycle/decay.js";
import type { FactStoreOptions } from "../../tideline/store/records.js";
import { createBrigadeMemoryHostPorts } from "./host-ports.js";

export function runDecayGc(workspaceDir: string, now?: number, storeOptions: FactStoreOptions = {}) {
	return runCoreDecayGc(workspaceDir, now, {
		...storeOptions,
		hostPorts: storeOptions.hostPorts ?? createBrigadeMemoryHostPorts(),
	});
}
