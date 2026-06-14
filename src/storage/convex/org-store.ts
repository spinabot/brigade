// src/storage/convex/org-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import type { OrgDeriveAuditEntry, OrgStore } from "../store.js";

interface Deps { client: ConvexHttpClient; ownerId: string }

export class ConvexOrgStore implements OrgStore {
	private readonly transientLocators = new Set<string>();

	constructor(private readonly deps: Deps) {}

	async appendDeriveAudit(entry: OrgDeriveAuditEntry): Promise<void> {
		const e = entry as unknown as Record<string, unknown>;
		await this.deps.client.mutation(api.org.appendDeriveAudit, {
			ownerId: this.deps.ownerId,
			ts: (e.ts as string) ?? new Date().toISOString(),
			topOrder: (e.topOrder as string) ?? "main",
			mode: ((e.mode as string) ?? "derived") as never,
			edgeCount: (e.edgeCount as number) ?? 0,
			memberCount: (e.memberCount as number) ?? 0,
			extraAllowCount: (e.extraAllowCount as number) ?? 0,
			extraDenyCount: (e.extraDenyCount as number) ?? 0,
			warnings: (e.warnings as number) ?? 0,
		});
	}

	async listDeriveAudit(filter?: { since?: string; limit?: number }): Promise<OrgDeriveAuditEntry[]> {
		const rows = (await this.deps.client.query(api.org.listDeriveAudit, {
			ownerId: this.deps.ownerId,
			...(filter?.limit !== undefined ? { limit: filter.limit } : {}),
		})) as Array<Record<string, unknown>>;
		const since = filter?.since;
		const filtered = since ? rows.filter((r) => (r.ts as string) >= since) : rows;
		return filtered as unknown as OrgDeriveAuditEntry[];
	}

	async getChartImage(hash: string): Promise<
		| { bytes: Uint8Array; width: number; height: number; mimeType: "image/png"; mtimeMs: number }
		| undefined
	> {
		const row = (await this.deps.client.query(api.org.getChart, {
			ownerId: this.deps.ownerId,
			hash,
		})) as
			| { pngBytes: ArrayBuffer; width: number; height: number; mtimeMs: number }
			| null;
		if (!row) return undefined;
		return {
			bytes: new Uint8Array(row.pngBytes),
			width: row.width,
			height: row.height,
			mimeType: "image/png",
			mtimeMs: row.mtimeMs,
		};
	}

	async putChartImage(
		hash: string,
		bytes: Uint8Array,
		meta: { width: number; height: number; themeId: string; themeName: string; mimeType: "image/png" },
	): Promise<{ locator: string }> {
		await this.deps.client.mutation(api.org.putChart, {
			ownerId: this.deps.ownerId,
			hash,
			pngBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
			width: meta.width,
			height: meta.height,
			themeId: meta.themeId,
			themeName: meta.themeName,
		});
		return { locator: `convex://org-chart/${hash}` };
	}

	async deleteChartImage(hash: string): Promise<void> {
		await this.deps.client.mutation(api.org.deleteChart, {
			ownerId: this.deps.ownerId,
			hash,
		});
	}

	async listChartImages(): Promise<Array<{ hash: string; mtimeMs: number; bytes: number }>> {
		const rows = (await this.deps.client.query(api.org.listCharts, {
			ownerId: this.deps.ownerId,
		})) as Array<{ hash: string; mtimeMs: number; pngBytes: ArrayBuffer }>;
		return rows.map((r) => ({
			hash: r.hash,
			mtimeMs: r.mtimeMs,
			bytes: r.pngBytes.byteLength ?? 0,
		}));
	}

	markChartTransient(locator: string): void {
		this.transientLocators.add(locator);
	}

	consumeChartTransient(locator: string): boolean {
		return this.transientLocators.delete(locator);
	}

	async gcChartImages(opts?: { maxAgeMs?: number; maxFiles?: number }): Promise<void> {
		const all = await this.listChartImages();
		const now = Date.now();
		const targets: string[] = [];
		if (opts?.maxAgeMs !== undefined) {
			for (const c of all) {
				if (now - c.mtimeMs > opts.maxAgeMs) targets.push(c.hash);
			}
		}
		if (opts?.maxFiles !== undefined && all.length > opts.maxFiles) {
			const sorted = [...all].sort((a, b) => a.mtimeMs - b.mtimeMs);
			const overflow = sorted.slice(0, sorted.length - opts.maxFiles);
			for (const c of overflow) targets.push(c.hash);
		}
		for (const hash of new Set(targets)) {
			await this.deleteChartImage(hash);
		}
	}
}
