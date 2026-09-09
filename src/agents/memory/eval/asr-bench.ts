/** Compatibility entry. Canonical implementation lives in src/tideline/. */
export * from "../../../tideline/eval/asr-bench.js";
import { runDefaultAsrBench as runCoreAsrBench } from "../../../tideline/eval/asr-bench.js";
import type { FactStoreOptions } from "../../../tideline/store/records.js";
import { createBrigadeMemoryHostPorts } from "../host-ports.js";

export function runDefaultAsrBench(workspaceDir: string, storeOptions: FactStoreOptions = {}) {
	return runCoreAsrBench(workspaceDir, {
		...storeOptions,
		hostPorts: storeOptions.hostPorts ?? createBrigadeMemoryHostPorts(),
	});
}
