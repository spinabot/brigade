// src/storage/local/memory-store.ts
//
// LocalMemoryStore — filesystem-mode wrapper around `agents/memory/*`.
// Implements `MemoryStore`.
//
// Scope (additive, PR11):
//   ✓ listFacts / writeFact / searchFacts / markFactsAccessed /
//     setFactsLifecycle / countActiveFacts  — wrap FactStore directly
//   ✓ searchNotes / readNote / notesStatus  — wrap FileMemoryStore directly
//   ✓ getExtractCursor                     — wrap extract.ts:getCursor
//   ✓ setExtractCursor                     — inline tmp+rename (writer is private upstream)
//   ✓ getConsolidateLastRunAt              — read consolidate-state.json inline
//   ✓ markConsolidateRunAt                 — wrap consolidate.ts:markConsolidationRun
//   ✗ findSimilar                          — vector recall ships in PR19
//   ✗ decay                                — needs a sweep helper upstream
//   ✗ subscribe                            — no-op (filesystem mode reads on demand)
//
// All on-disk semantics (dedup-on-write, supersede archive, origin filter,
// atomic whole-file rewrite) live in the wrapped FactStore; the adapter
// is a typed seam, not a behavioural change.

import * as fs from "node:fs";
import * as path from "node:path";

import {
	FactStore,
	type ListFilter as InternalListFilter,
	type MemoryRecord as InternalMemoryRecord,
	type NewFact as InternalNewFact,
	type RecordOriginFilter as InternalRecordOriginFilter,
} from "../../agents/memory/records.js";
import { FileMemoryStore } from "../../agents/memory/storage.js";
import { getCursor } from "../../agents/memory/extract.js";
import { resolveAgentWorkspaceDir, DEFAULT_AGENT_ID } from "../../config/paths.js";

import { watchFile } from "./file-watcher.js";

import { NotImplementedYet } from "../store.js";
import type {
	ListFilter,
	MemoryDelta,
	MemoryLifecycle,
	MemoryRecord,
	MemoryStore,
	NewFact,
	RecordOriginFilter,
	Scope,
	Unsub,
} from "../store.js";

/** Resolve the active agent's workspace dir. Memory operations are scoped to
 *  a single workspace today; multi-agent fan-out reads via the agent kernel
 *  pass an explicit workspaceDir through the existing call sites. */
function activeWorkspaceDir(): string {
	return resolveAgentWorkspaceDir(DEFAULT_AGENT_ID);
}

function activeFactStore(): FactStore {
	return new FactStore(activeWorkspaceDir());
}

function activeMemoryStore(): FileMemoryStore {
	return new FileMemoryStore(activeWorkspaceDir());
}

export class LocalMemoryStore implements MemoryStore {
	constructor(private readonly _stateDir: string) {}

	async listFacts(filter: ListFilter): Promise<MemoryRecord[]> {
		const records = activeFactStore().list(filter as InternalListFilter);
		return records as unknown as MemoryRecord[];
	}

	async writeFact(fact: NewFact): Promise<MemoryRecord> {
		const record = activeFactStore().write(fact as unknown as InternalNewFact);
		return record as unknown as MemoryRecord;
	}

	async searchFacts(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter },
	): Promise<Array<MemoryRecord & { score: number }>> {
		const result = activeFactStore().search(query, {
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
			...(opts.markAccessed !== undefined ? { markAccessed: opts.markAccessed } : {}),
			...(opts.origin !== undefined ? { origin: opts.origin as InternalRecordOriginFilter } : {}),
		});
		return result as unknown as Array<MemoryRecord & { score: number }>;
	}

	async markFactsAccessed(memoryIds: string[]): Promise<void> {
		activeFactStore().markAccessed(memoryIds);
	}

	async setFactsLifecycle(memoryIds: string[], lifecycle: MemoryLifecycle): Promise<void> {
		activeFactStore().setLifecycle(memoryIds, lifecycle);
	}

	async countActiveFacts(): Promise<number> {
		const all = activeFactStore().readAll() as InternalMemoryRecord[];
		return all.filter((r) => r.lifecycle === "active").length;
	}

	async findSimilar(
		_text: string,
		_scope: Scope,
		_k?: number,
	): Promise<Array<MemoryRecord & { score: number }>> {
		// Vector recall lands in Phase 2 PR19 (memoryFacts.embedding + ANN).
		// Filesystem mode has no embedding store today; throw rather than
		// silently degrade to substring search (callers should use
		// `searchFacts` for that).
		throw new NotImplementedYet("memory.findSimilar (vector recall — Phase 2 PR19)");
	}

	async searchNotes(query: string, opts: unknown): Promise<unknown[]> {
		const results = await activeMemoryStore().search(query, opts as never);
		return results as unknown as unknown[];
	}

	async readNote(relPath: string, opts: unknown): Promise<unknown> {
		return activeMemoryStore().read(relPath, opts as never);
	}

	async notesStatus(): Promise<unknown> {
		return activeMemoryStore().status();
	}

	async getExtractCursor(sessionId: string): Promise<number> {
		return getCursor(activeWorkspaceDir(), sessionId);
	}

	async setExtractCursor(sessionId: string, processedCount: number): Promise<void> {
		// `writeCursor` is private upstream; mirror its tmp+rename semantics
		// inline so we don't need to widen the module's surface for this PR.
		const dir = activeWorkspaceDir();
		const cursorFile = path.join(dir, "memory", ".dreams", "extract-cursor.json");
		let payload: { version: number; cursors: Record<string, number> } = {
			version: 1,
			cursors: {},
		};
		try {
			const raw = fs.readFileSync(cursorFile, "utf8");
			const parsed = JSON.parse(raw) as Partial<typeof payload>;
			if (parsed && typeof parsed === "object" && typeof parsed.cursors === "object") {
				payload = {
					version: 1,
					cursors: { ...(parsed.cursors ?? {}) } as Record<string, number>,
				};
			}
		} catch {
			// Fresh / missing / unparseable — proceed with the empty payload.
		}
		payload.cursors[sessionId] = processedCount;
		fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
		const tmp = `${cursorFile}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
		fs.renameSync(tmp, cursorFile);
	}

	async getConsolidateLastRunAt(): Promise<number | undefined> {
		const file = path.join(
			activeWorkspaceDir(),
			"memory",
			".dreams",
			"consolidate-state.json",
		);
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { lastRunAt?: number };
			return typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : undefined;
		} catch {
			return undefined;
		}
	}

	async markConsolidateRunAt(at: number): Promise<void> {
		// Disk-direct, NOT via markConsolidationRun — that helper branches on
		// the global runtime context and would write to convex when this store
		// is a migrate TARGET while the operator is still in convex mode. The
		// LocalMemoryStore impl must always stamp the local file (mirrors the
		// inline read in getConsolidateLastRunAt).
		const file = path.join(
			activeWorkspaceDir(),
			"memory",
			".dreams",
			"consolidate-state.json",
		);
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
			fs.writeFileSync(tmp, JSON.stringify({ lastRunAt: at }), "utf8");
			fs.renameSync(tmp, file);
		} catch {
			/* best-effort — a missed stamp just reruns consolidation sooner */
		}
	}

	async decay(_now?: number): Promise<{ archived: number; pruned: number }> {
		// The decay sweep lives in the agent-loop background tick today
		// (calls FactStore.setLifecycle in a batch per the per-tier
		// thresholds). Exposing it as a single store-level operation needs
		// a sweep helper upstream; PR11 leaves it stubbed so callers fall
		// back to the existing post-turn path.
		throw new NotImplementedYet("memory.decay (needs upstream sweep helper)");
	}

	subscribe(_scope: Scope, cb: (delta: MemoryDelta) => void): Unsub {
		// Watch facts.jsonl with the standard 500 ms debounce. Filesystem
		// mode doesn't surface per-record deltas — we emit a coarse "facts
		// changed" payload carrying the new active count, which is enough
		// for the recall + dashboard call sites to know they need to re-read.
		// Convex mode (PR16) will swap this for a per-row live query.
		const dir = activeWorkspaceDir();
		const factsFile = path.join(dir, "memory", "facts.jsonl");
		return watchFile(factsFile, () => {
			try {
				const store = activeFactStore();
				const all = store.readAll();
				const activeCount = all.filter((r) => r.lifecycle === "active").length;
				cb({
					kind: "facts-changed",
					activeCount,
					totalCount: all.length,
				} as unknown as MemoryDelta);
			} catch {
				// Mid-write or missing file — skip.
			}
		});
	}

	// Raw per-record surface — DISK-DIRECT on purpose. FactStore.readAll /
	// writeAll branch on the global runtime context (convex cache vs disk),
	// which is wrong when this store is a MIGRATE TARGET while the operator is
	// still in convex mode (target=local must land on disk, not the cache).
	// These three always touch the local JSONL, matching the LocalMemoryStore
	// contract. In plain filesystem mode this is identical to FactStore.readAll.

	private factsFilePath(workspaceId: string): string {
		return path.join(resolveAgentWorkspaceDir(workspaceId), "memory", "facts.jsonl");
	}

	private readFactsFromDisk(workspaceId: string): MemoryRecord[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.factsFilePath(workspaceId), "utf8");
		} catch {
			return [];
		}
		const out: MemoryRecord[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const rec = JSON.parse(trimmed) as { memoryId?: unknown; content?: unknown };
				if (typeof rec.memoryId === "string" && typeof rec.content === "string") {
					out.push(rec as unknown as MemoryRecord);
				}
			} catch {
				// Skip a corrupt line rather than failing the whole read.
			}
		}
		return out;
	}

	private writeFactsToDisk(workspaceId: string, records: MemoryRecord[]): void {
		const file = this.factsFilePath(workspaceId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const body =
			records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, file);
	}

	async listAllFactRecordsRaw(workspaceId: string): Promise<MemoryRecord[]> {
		return this.readFactsFromDisk(workspaceId);
	}

	async upsertFactRecordRaw(workspaceId: string, record: MemoryRecord): Promise<void> {
		// Upsert by memoryId — idempotent so a re-run of `store migrate`
		// reconciles rather than duplicating.
		const id = (record as { memoryId?: string }).memoryId;
		if (!id) return;
		const all = this.readFactsFromDisk(workspaceId);
		const idx = all.findIndex((r) => (r as { memoryId?: string }).memoryId === id);
		if (idx >= 0) all[idx] = record;
		else all.push(record);
		this.writeFactsToDisk(workspaceId, all);
	}

	async deleteFactRecordRaw(workspaceId: string, memoryId: string): Promise<void> {
		const all = this.readFactsFromDisk(workspaceId);
		const next = all.filter((r) => (r as { memoryId?: string }).memoryId !== memoryId);
		if (next.length !== all.length) this.writeFactsToDisk(workspaceId, next);
	}
}
