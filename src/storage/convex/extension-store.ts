// src/storage/convex/extension-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import type { BrigadeModuleManifest, ExtensionStore } from "../store.js";

interface Deps { client: ConvexHttpClient }

export class ConvexExtensionStore implements ExtensionStore {
	constructor(private readonly deps: Deps) {}

	async listSources(): Promise<
		ReadonlyArray<{ source: string; kind: "file" | "dir-index"; safetyReason: string | null }>
	> {
		const rows = (await this.deps.client.query(api.extensions.list, {})) as Array<{
			moduleId: string;
			sourceLabel: string;
		}>;
		return rows.map((r) => ({
			source: `convex://extension/${r.moduleId}`,
			kind: "file" as const,
			safetyReason: null,
		}));
	}

	async rootExists(): Promise<boolean> {
		const rows = (await this.deps.client.query(api.extensions.list, {})) as Array<unknown>;
		return rows.length >= 0; // Convex mode always has the table available.
	}

	invalidateDiscoveryCache(): void {
		// No cache to invalidate in convex mode — every list() round-trips.
	}

	async registerSource(args: {
		id: string;
		bytes: Uint8Array;
		manifest?: BrigadeModuleManifest;
	}): Promise<{ source: string }> {
		const buffer = new Uint8Array(args.bytes).buffer.slice(0) as ArrayBuffer;
		await this.deps.client.mutation(api.extensions.upsert, {
			moduleId: args.id,
			origin: "user",
			bundleBytes: buffer,
			sourceLabel: `uploaded:${args.id}`,
			...(args.manifest !== undefined ? { manifest: args.manifest } : {}),
			enabled: true,
			createdBy: "operator",
		});
		return { source: `convex://extension/${args.id}` };
	}

	async unregisterSource(args: { id: string }): Promise<void> {
		await this.deps.client.mutation(api.extensions.remove, { moduleId: args.id });
	}
}
