// src/storage/convex/memory-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { open as openSealed, sealString } from "../encryption.js";

import { getReactiveConvexClient } from "./client.js";

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

interface Deps { client: ConvexHttpClient; workspaceId: string }

function bytesToString(b: ArrayBuffer | null | undefined): string {
	if (!b) return "";
	return openSealed(b).toString("utf8");
}
function stringToBytes(s: string): ArrayBuffer {
	return sealString(s);
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
	const content = bytesToString(row.content as ArrayBuffer);
	// Rebuild the filesystem shape: nested `createdBy` from the flattened
	// columns (origin filters read record.createdBy — without this, recall
	// scoping silently never matches), and strip convex bookkeeping.
	const {
		_id,
		_creationTime,
		workspaceId,
		createdByKind,
		createdByChannelId,
		createdByConversationId,
		createdBySessionKey,
		createdByAccountId,
		content: _rawContent,
		...rest
	} = row as Record<string, unknown> & { content?: unknown };
	void _id;
	void _creationTime;
	void workspaceId;
	void _rawContent;
	const record = { ...rest, content } as unknown as MemoryRecord;
	if (createdByKind !== undefined) {
		(record as Record<string, unknown>).createdBy = {
			kind: createdByKind,
			...(createdByChannelId !== undefined ? { channelId: createdByChannelId } : {}),
			...(createdByConversationId !== undefined
				? { conversationId: createdByConversationId }
				: {}),
			...(createdBySessionKey !== undefined ? { sessionKey: createdBySessionKey } : {}),
			...(createdByAccountId !== undefined ? { accountId: createdByAccountId } : {}),
		};
	}
	return record;
}

/** Filesystem-shaped record → upsertFactRecord mutation args. */
function recordToRowArgs(workspaceId: string, r: MemoryRecord): Record<string, unknown> {
	const rec = r as MemoryRecord & {
		createdBy?: {
			kind?: string;
			channelId?: string;
			conversationId?: string;
			sessionKey?: string;
			accountId?: string;
		};
		metadata?: unknown;
		embedding?: number[];
	};
	return {
		workspaceId,
		memoryId: rec.memoryId,
		content: stringToBytes(String(rec.content ?? "")),
		segment: rec.segment,
		tier: rec.tier,
		importance: rec.importance,
		decayRate: rec.decayRate,
		accessCount: rec.accessCount,
		lastAccessedAt: rec.lastAccessedAt,
		createdAt: rec.createdAt,
		lifecycle: rec.lifecycle,
		...(rec.sourceTurn !== undefined ? { sourceTurn: rec.sourceTurn } : {}),
		...(rec.supersedes !== undefined ? { supersedes: rec.supersedes } : {}),
		...(rec.createdBy?.kind !== undefined ? { createdByKind: rec.createdBy.kind } : {}),
		...(rec.createdBy?.channelId !== undefined
			? { createdByChannelId: rec.createdBy.channelId }
			: {}),
		...(rec.createdBy?.conversationId !== undefined
			? { createdByConversationId: rec.createdBy.conversationId }
			: {}),
		...(rec.createdBy?.sessionKey !== undefined
			? { createdBySessionKey: rec.createdBy.sessionKey }
			: {}),
		...(rec.createdBy?.accountId !== undefined
			? { createdByAccountId: rec.createdBy.accountId }
			: {}),
		...(rec.metadata !== undefined ? { metadata: rec.metadata } : {}),
		...(rec.embedding !== undefined ? { embedding: rec.embedding } : {}),
	};
}

/** Same as `rowToRecord` but returns `null` when the row was sealed with a
 *  key this process doesn't hold. List operations use this so a foreign-
 *  tenant row (or a row from a rotated-away key) doesn't poison the whole
 *  query. Single-row reads keep the strict behaviour. */
function rowToRecordOrNull(row: Record<string, unknown>): MemoryRecord | null {
	try {
		return rowToRecord(row);
	} catch {
		return null;
	}
}

export class ConvexMemoryStore implements MemoryStore {
	constructor(private readonly deps: Deps) {}

	async listFacts(filter: ListFilter): Promise<MemoryRecord[]> {
		const rows = (await this.deps.client.query(api.memory.listFacts, {
			workspaceId: this.deps.workspaceId,
			...(filter.lifecycle !== undefined ? { lifecycle: filter.lifecycle } : {}),
			...(filter.limit !== undefined ? { limit: filter.limit } : {}),
		})) as Array<Record<string, unknown>>;
		return rows.map(rowToRecordOrNull).filter((r): r is MemoryRecord => r !== null);
	}

	async writeFact(fact: NewFact): Promise<MemoryRecord> {
		const f = fact as unknown as {
			memoryId?: string;
			content?: string;
			segment?: "identity" | "preference" | "correction" | "relationship" | "project" | "knowledge" | "context";
			tier?: "short" | "long" | "permanent";
			importance?: number;
			decayRate?: number;
			sourceTurn?: string;
			supersedes?: string[];
			createdBy?: { kind?: "owner" | "channel"; channelId?: string; conversationId?: string; sessionKey?: string; accountId?: string };
			metadata?: Record<string, unknown>;
			embedding?: number[];
		};
		const memoryId = f.memoryId ?? crypto.randomUUID();
		const row = (await this.deps.client.mutation(api.memory.writeFact, {
			workspaceId: this.deps.workspaceId,
			memoryId,
			content: stringToBytes(f.content ?? ""),
			segment: f.segment ?? "context",
			tier: f.tier ?? "short",
			importance: f.importance ?? 0.5,
			decayRate: f.decayRate ?? 0.1,
			...(f.sourceTurn !== undefined ? { sourceTurn: f.sourceTurn } : {}),
			...(f.supersedes !== undefined ? { supersedes: f.supersedes } : {}),
			...(f.createdBy?.kind !== undefined ? { createdByKind: f.createdBy.kind } : {}),
			...(f.createdBy?.channelId !== undefined ? { createdByChannelId: f.createdBy.channelId } : {}),
			...(f.createdBy?.conversationId !== undefined ? { createdByConversationId: f.createdBy.conversationId } : {}),
			...(f.createdBy?.sessionKey !== undefined ? { createdBySessionKey: f.createdBy.sessionKey } : {}),
			...(f.createdBy?.accountId !== undefined ? { createdByAccountId: f.createdBy.accountId } : {}),
			...(f.metadata !== undefined ? { metadata: f.metadata } : {}),
			...(f.embedding !== undefined ? { embedding: f.embedding } : {}),
		})) as Record<string, unknown>;
		return rowToRecord(row);
	}

	async searchFacts(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter },
	): Promise<Array<MemoryRecord & { score: number }>> {
		const hits = (await this.deps.client.query(api.memory.searchContent, {
			workspaceId: this.deps.workspaceId,
			query,
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
		})) as Array<Record<string, unknown>>;
		const records = hits.map((r) => ({ ...rowToRecord(r), score: 1 }));
		if (opts.markAccessed !== false && records.length > 0) {
			await this.markFactsAccessed(records.map((r) => (r as { memoryId: string }).memoryId));
		}
		return records as unknown as Array<MemoryRecord & { score: number }>;
	}

	async markFactsAccessed(memoryIds: string[]): Promise<void> {
		if (memoryIds.length === 0) return;
		await this.deps.client.mutation(api.memory.markAccessed, {
			workspaceId: this.deps.workspaceId,
			memoryIds,
		});
	}

	async setFactsLifecycle(memoryIds: string[], lifecycle: MemoryLifecycle): Promise<void> {
		if (memoryIds.length === 0) return;
		await this.deps.client.mutation(api.memory.setLifecycle, {
			workspaceId: this.deps.workspaceId,
			memoryIds,
			lifecycle,
		});
	}

	async countActiveFacts(): Promise<number> {
		// Page-count until isDone — a single `.collect()` would exceed Convex's
		// 16 MiB per-execution read cap once the fact set is large. Lossless.
		let count = 0;
		let cursor: string | null = null;
		for (;;) {
			const res = (await this.deps.client.query(api.memory.countActiveFacts, {
				workspaceId: this.deps.workspaceId,
				cursor,
			})) as { count: number; isDone: boolean; continueCursor: string };
			count += res.count;
			if (res.isDone) break;
			cursor = res.continueCursor;
		}
		return count;
	}

	async findSimilar(
		text: string,
		_scope: Scope,
		k?: number,
	): Promise<Array<MemoryRecord & { score: number }>> {
		// PR19 — embedding-driven recall. The caller provides text; we ask
		// a configured embedding provider for a vector and run the vectorIndex
		// query against memoryFacts.embedding.
		//
		// Provider resolution: optional `BRIGADE_EMBEDDING_PROVIDER` env var
		// (defaults to "openai"). The provider's API key is the same one
		// already wired by the auth store. If no embedding provider is
		// configured, fall back to the lexical `searchFacts` path so callers
		// don't lose recall entirely.
		const embedding = await this._embed(text);
		if (!embedding) {
			// Graceful fallback — lexical search still works without embeddings.
			return this.searchFacts(text, { ...(k !== undefined ? { limit: k } : {}) });
		}
		const hits = (await this.deps.client.query(api.memory.findSimilar, {
			workspaceId: this.deps.workspaceId,
			embedding,
			...(k !== undefined ? { k } : {}),
		})) as Array<Record<string, unknown>>;
		return hits.map((r) => ({ ...rowToRecord(r), score: (r.score as number) ?? 0 })) as unknown as Array<
			MemoryRecord & { score: number }
		>;
	}

	/** Best-effort embedding generator. Returns `null` when no provider is
	 *  reachable so `findSimilar` can fall back to lexical search. */
	private async _embed(text: string): Promise<number[] | null> {
		const provider = (process.env.BRIGADE_EMBEDDING_PROVIDER ?? "openai").toLowerCase();
		if (provider === "openai") {
			const key = process.env.OPENAI_API_KEY;
			if (!key) return null;
			try {
				const res = await fetch("https://api.openai.com/v1/embeddings", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${key}`,
					},
					body: JSON.stringify({
						input: text,
						model: process.env.BRIGADE_EMBEDDING_MODEL ?? "text-embedding-3-small",
					}),
				});
				if (!res.ok) return null;
				const body = (await res.json()) as { data?: Array<{ embedding: number[] }> };
				return body.data?.[0]?.embedding ?? null;
			} catch {
				return null;
			}
		}
		// Other providers (Voyage, Cohere) — wire here when needed.
		return null;
	}

	async searchNotes(_query: string, _opts: unknown): Promise<unknown[]> {
		// Markdown notes (memory/*.md) stay local in convex mode — they're
		// edited by hand and not part of the structured memory facts table.
		return [];
	}

	async readNote(_relPath: string, _opts: unknown): Promise<unknown> {
		return null;
	}

	async notesStatus(): Promise<unknown> {
		return { available: false, reason: "convex mode — markdown notes stay local" };
	}

	async getExtractCursor(sessionId: string): Promise<number> {
		const cursor = (await this.deps.client.query(api.memory.getExtractCursor, {
			workspaceId: this.deps.workspaceId,
			sessionId,
		})) as number;
		return cursor;
	}

	async setExtractCursor(sessionId: string, processedCount: number): Promise<void> {
		await this.deps.client.mutation(api.memory.setExtractCursor, {
			workspaceId: this.deps.workspaceId,
			sessionId,
			processedCount,
		});
	}

	async getConsolidateLastRunAt(): Promise<number | undefined> {
		const at = (await this.deps.client.query(api.memory.getConsolidateLastRunAt, {
			workspaceId: this.deps.workspaceId,
		})) as number | undefined | null;
		return at ?? undefined;
	}

	async markConsolidateRunAt(at: number): Promise<void> {
		await this.deps.client.mutation(api.memory.markConsolidateRunAt, {
			workspaceId: this.deps.workspaceId,
			lastRunAt: at,
		});
	}

	async decay(now?: number): Promise<{ archived: number; pruned: number }> {
		const result = (await this.deps.client.mutation(api.memory.decay, {
			workspaceId: this.deps.workspaceId,
			now: now ?? Date.now(),
		})) as { archived: number; pruned: number };
		return result;
	}

	subscribe(_scope: Scope, cb: (delta: MemoryDelta) => void): Unsub {
		const reactive = getReactiveConvexClient();
		// Reactive recall: subscribe to the active facts list so callers
		// learn about new / archived / pruned facts the moment they happen.
		// We emit a coarse delta carrying the count + most recent fact's
		// memoryId so consumers can decide whether to refetch a full list.
		const unsub = reactive.onUpdate(
			api.memory.listFacts,
			{ workspaceId: this.deps.workspaceId, lifecycle: "active" },
			(rows) => {
				const list = rows as Array<Record<string, unknown>>;
				try {
					cb({
						kind: "facts-changed",
						activeCount: list.length,
						mostRecentId: list[0]?.memoryId,
					} as unknown as MemoryDelta);
				} catch {
					// Subscriber threw — stay alive.
				}
			},
		);
		return () => {
			try {
				unsub();
			} catch {
				// Idempotent.
			}
		};
	}

	async listAllFactRecordsRaw(workspaceId: string): Promise<MemoryRecord[]> {
		// Page through ALL facts (boot hydration) until isDone — a single read
		// would exceed Convex's 16 MiB per-execution cap once memory is large.
		// Lossless: every page is concatenated.
		const rows: Array<Record<string, unknown>> = [];
		let cursor: string | null = null;
		for (;;) {
			const res = (await this.deps.client.query(api.memory.listAllFacts, {
				workspaceId,
				cursor,
			})) as { page: Array<Record<string, unknown>>; isDone: boolean; continueCursor: string };
			rows.push(...res.page);
			if (res.isDone) break;
			cursor = res.continueCursor;
		}
		return rows.map(rowToRecordOrNull).filter((r): r is MemoryRecord => r !== null);
	}

	async upsertFactRecordRaw(workspaceId: string, record: MemoryRecord): Promise<void> {
		await this.deps.client.mutation(
			api.memory.upsertFactRecord,
			recordToRowArgs(workspaceId, record) as never,
		);
	}

	async deleteFactRecordRaw(workspaceId: string, memoryId: string): Promise<void> {
		await this.deps.client.mutation(api.memory.deleteFactRecord, {
			workspaceId,
			memoryId,
		});
	}
}
