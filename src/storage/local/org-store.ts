// src/storage/local/org-store.ts
//
// LocalOrgStore — filesystem-mode wrapper around
// `src/agents/org/audit-log.ts` (append-only derivation audit) +
// `src/agents/org/pride-image.ts` (chart PNG cache). Implements `OrgStore`.
//
// PR8 scope:
//   ✓ appendDeriveAudit       — direct via existing helper
//   ✓ listDeriveAudit         — wired against the JSONL file the audit writes
//   ✓ getChartImage           — reads cached PNG from disk
//   ✓ putChartImage           — direct via existing helper
//   ✓ deleteChartImage        — single fs.unlink
//   ✓ listChartImages         — directory scan
//   ✓ markChartTransient      — direct
//   ✓ consumeChartTransient   — direct
//   ✓ gcChartImages           — direct
//
// All on-disk semantics (atomic appends, content-addressed hashing) live in
// the wrapped modules. We just type-wrap.

import * as fs from "node:fs";
import * as path from "node:path";

import {
	appendOrgDeriveAudit,
	resolveOrgDeriveAuditPath,
} from "../../agents/org/audit-log.js";
import {
	consumeTransientImage,
	gcOrgChartsCache,
	markTransientImage,
} from "../../agents/org/pride-image.js";
import { resolveStateDir } from "../../config/paths.js";

import type { OrgDeriveAuditEntry, OrgStore } from "../store.js";

function resolveChartsDir(): string {
	return path.join(resolveStateDir(), "workspace", "logs", "org-charts");
}

function chartPathFor(hash: string): string {
	return path.join(resolveChartsDir(), `${hash}.png`);
}

export class LocalOrgStore implements OrgStore {
	constructor(private readonly _stateDir: string) {}

	async appendDeriveAudit(entry: OrgDeriveAuditEntry): Promise<void> {
		// Best-effort write — the existing helper swallows fs errors so the
		// derivation hot-path never crashes on a read-only workspace.
		appendOrgDeriveAudit(entry as never);
	}

	async listDeriveAudit(
		filter?: { since?: string; limit?: number },
	): Promise<OrgDeriveAuditEntry[]> {
		const file = resolveOrgDeriveAuditPath();
		if (!fs.existsSync(file)) return [];
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			return [];
		}
		const out: OrgDeriveAuditEntry[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed) as OrgDeriveAuditEntry);
			} catch {
				// Skip malformed lines — the audit is observability, not a
				// contract; one bad line doesn't poison the whole read.
			}
		}
		const since = filter?.since;
		const filtered = since ? out.filter((e) => (e.ts as string) >= since) : out;
		const limit = filter?.limit;
		return limit && limit > 0 ? filtered.slice(-limit) : filtered;
	}

	async getChartImage(
		hash: string,
	): Promise<
		| {
				bytes: Uint8Array;
				width: number;
				height: number;
				mimeType: "image/png";
				mtimeMs: number;
		  }
		| undefined
	> {
		const p = chartPathFor(hash);
		if (!fs.existsSync(p)) return undefined;
		try {
			const bytes = fs.readFileSync(p);
			const stat = fs.statSync(p);
			// Width/height aren't recorded on disk in PR8 — the schema doc lists
			// them for convex-mode but in filesystem mode we don't sidecar the
			// dimensions. Return zeros so callers know the bytes are real but
			// the metadata isn't authoritative; agents that care can decode
			// the PNG header themselves.
			return {
				bytes,
				width: 0,
				height: 0,
				mimeType: "image/png" as const,
				mtimeMs: stat.mtimeMs,
			};
		} catch {
			return undefined;
		}
	}

	async putChartImage(
		hash: string,
		bytes: Uint8Array,
		_meta: {
			width: number;
			height: number;
			themeId: string;
			themeName: string;
			mimeType: "image/png";
		},
	): Promise<{ locator: string }> {
		// `saveOrgChartImage` in pride-image.ts is the RENDERER (graph → PNG);
		// not appropriate for "store these pre-rendered bytes". Inline the
		// content-addressed write here. The on-disk shape matches what the
		// renderer produces so getChartImage / listChartImages see both.
		const dir = resolveChartsDir();
		fs.mkdirSync(dir, { recursive: true });
		const out = chartPathFor(hash);
		const tmp = `${out}.tmp.${process.pid}.${Date.now().toString(36)}`;
		fs.writeFileSync(tmp, Buffer.from(bytes));
		fs.renameSync(tmp, out);
		return { locator: out };
	}

	async deleteChartImage(hash: string): Promise<void> {
		const p = chartPathFor(hash);
		try {
			fs.unlinkSync(p);
		} catch {
			// Best-effort — caller treats "not found" as success.
		}
	}

	async listChartImages(): Promise<Array<{ hash: string; mtimeMs: number; bytes: number }>> {
		const dir = resolveChartsDir();
		if (!fs.existsSync(dir)) return [];
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return [];
		}
		const out: Array<{ hash: string; mtimeMs: number; bytes: number }> = [];
		for (const name of names) {
			if (!name.endsWith(".png")) continue;
			const hash = name.slice(0, -4);
			try {
				const stat = fs.statSync(path.join(dir, name));
				out.push({ hash, mtimeMs: stat.mtimeMs, bytes: stat.size });
			} catch {
				// Skip unreadable entries.
			}
		}
		return out;
	}

	markChartTransient(locator: string): void {
		markTransientImage(locator);
	}

	consumeChartTransient(locator: string): boolean {
		return consumeTransientImage(locator);
	}

	async gcChartImages(opts?: { maxAgeMs?: number; maxFiles?: number }): Promise<void> {
		await gcOrgChartsCache({
			...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
			...(opts?.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {}),
		});
	}
}
