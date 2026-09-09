/** Compatibility entry. Canonical implementation lives in src/tideline/. */
export * from "../../tideline/api/tideline.js";
import { Tideline as CoreTideline, type StorageAdapter, type TidelineAdapters } from "../../tideline/api/tideline.js";
import { createBrigadeMemoryHostPorts } from "./host-ports.js";

/** Brigade convenience factory; standalone callers import src/tideline instead. */
export class Tideline extends CoreTideline {
	static override open(workspaceDir: string, adapters: TidelineAdapters = {}): Tideline {
		const Factory = this === Tideline || (typeof this === "function" && this.prototype instanceof Tideline) ? this : Tideline;
		return super.open.call(Factory, workspaceDir, {
			...adapters,
			hostPorts: adapters.hostPorts ?? createBrigadeMemoryHostPorts(),
		});
	}

	/** Detached calls still return the Brigade facade, without rebinding the store. */
	static override over(store: StorageAdapter, adapters: TidelineAdapters = {}): Tideline {
		const Factory = this === Tideline || (typeof this === "function" && this.prototype instanceof Tideline) ? this : Tideline;
		return super.over.call(Factory, store, adapters);
	}
}
