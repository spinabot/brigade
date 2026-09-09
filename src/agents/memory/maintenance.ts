/** Compatibility entry. Canonical implementation lives in src/tideline/. */
export * from "../../tideline/lifecycle/maintenance.js";
import { runMemoryMaintenance as runCoreMaintenance } from "../../tideline/lifecycle/maintenance.js";
import { createBrigadeMemoryHostPorts } from "./host-ports.js";

export function runMemoryMaintenance(...args: Parameters<typeof runCoreMaintenance>): void {
	const [workspaceDir, onError, onContradictions, storeOptions = {}] = args;
	runCoreMaintenance(workspaceDir, onError, onContradictions, {
		...storeOptions,
		hostPorts: storeOptions.hostPorts ?? createBrigadeMemoryHostPorts(),
	});
}
