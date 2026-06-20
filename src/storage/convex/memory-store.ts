// src/storage/convex/memory-store.ts
import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";

import { open as openSealed, sealString } from "../encryption.js";

import { getReactiveConvexClient } from "./client.js";

import {
	type MemoryRecordOrigin,
	recordMatchesOriginFilter,
} from "../../agents/memory/records.js";

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

/** AAD binds a sealed fact's content to its ROW identity — workspace +
 *  memoryId + origin-kind. A sealed blob copied into a different row,
 *  workspace, or origin fails to decrypt even with the correct key
 *  (GCM-native), so at-rest isolation can't be defeated by row-shuffling at
 *  the convex layer. Stronger than auth-store's per-column binding; same
 *  open-with-fallback so pre-AAD rows keep working (organic re-seal on write). */
function factAad(workspaceId: string, memoryId: string, originKind: string): string {
	return `memoryFacts|${workspaceId}|${memoryId}|${originKind}`;
}

/** Per-ORIGIN HKDF subkey context (Tideline step 18) — content is encrypted with
 *  a subkey DERIVED from the origin, so each origin (owner vs each channel
 *  conversation) is crypto-separated, not just AAD-bound. Multi-tenant-ready: a
 *  per-tenant master/root makes this isolation hold ACROSS tenants. Coarser than
 *  the per-row AAD by design — all of one origin's facts share a subkey. */
function originKeyContext(
	workspaceId: string,
	kind: string,
	channelId?: string,
	conversationId?: string,
	sessionKey?: string,
): string {
	// Escape the delimiter so the join is INJECTIVE: a field containing a literal
	// "|" can't shift the boundaries and collide with another origin's context (the
	// at-rest isolation boundary must not depend on "channelId never contains |").
	// Identity for normal fields (JIDs/session keys carry no "|"/"\") ⇒ no re-seal.
	const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
	return kind === "channel"
		? `mem|${esc(workspaceId)}|channel|${esc(channelId ?? "")}|${esc(conversationId ?? "")}|${esc(sessionKey ?? "")}`
		: `mem|${esc(workspaceId)}|owner`;
}

function bytesToString(b: ArrayBuffer | null | undefined, aad?: string, keyContext?: string): string {
	if (!b) return "";
	if (aad === undefined) return openSealed(b, undefined, keyContext).toString("utf8");
	try {
		return openSealed(b, aad, keyContext).toString("utf8");
	} catch {
		// Legacy rows (sealed before AAD/HKDF hardening) carry no bound context +
		// no subkey — fall back to the raw master once so older facts stay
		// readable (they re-seal WITH aad + the origin subkey on their next write
		// — organic migration). An AAD/subkey-bound blob in the wrong context
		// fails BOTH the try AND this fallback, so isolation is never weakened.
		return openSealed(b).toString("utf8");
	}
}
function stringToBytes(s: string, aad?: string, keyContext?: string): ArrayBuffer {
	return sealString(s, aad, keyContext);
}

/** Seal the metadata sidecar before it leaves the process. metadata can carry
 *  verbatim user text (a correction's prior-belief string), so in convex mode it
 *  must NOT ship plaintext next to the sealed `content`. Sealed with the SAME
 *  per-origin subkey as content but a field-distinct AAD suffix (`|meta`) so a
 *  content blob can't be read back as metadata or vice versa. Stored as a
 *  base64 marker object inside the existing `v.any()` column — no schema-type
 *  change (so existing rows keep validating) and no bytes-in-`v.any()`
 *  ambiguity. */
function sealMetadata(meta: unknown, aad: string, keyContext: string): { __enc: string } {
	const sealed = stringToBytes(JSON.stringify(meta ?? null), aad, keyContext);
	return { __enc: Buffer.from(new Uint8Array(sealed)).toString("base64") };
}
/** Reverse of `sealMetadata`. A legacy row's plaintext metadata object (no
 *  `__enc`) passes through unchanged — organic: it re-seals on its next write. */
function unsealMetadata(raw: unknown, aad: string, keyContext: string): unknown {
	if (raw && typeof raw === "object" && typeof (raw as { __enc?: unknown }).__enc === "string") {
		const buf = Buffer.from((raw as { __enc: string }).__enc, "base64");
		const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		try {
			return JSON.parse(bytesToString(ab, aad, keyContext));
		} catch {
			return undefined;
		}
	}
	return raw;
}

export function rowToRecord(row: Record<string, unknown>): MemoryRecord {
	const rowAad = factAad(
		String(row.workspaceId ?? ""),
		String(row.memoryId ?? ""),
		String(row.createdByKind ?? "owner"),
	);
	const rowKeyCtx = originKeyContext(
		String(row.workspaceId ?? ""),
		String(row.createdByKind ?? "owner"),
		row.createdByChannelId as string | undefined,
		row.createdByConversationId as string | undefined,
		row.createdBySessionKey as string | undefined,
	);
	const content = bytesToString(row.content as ArrayBuffer, rowAad, rowKeyCtx);
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
		metadata: _rawMeta,
		...rest
	} = row as Record<string, unknown> & { content?: unknown };
	void _id;
	void _creationTime;
	void workspaceId;
	void _rawContent;
	// Unseal the metadata sidecar with the field-distinct AAD it was sealed
	// under; a legacy plaintext metadata object passes through unchanged.
	const metadata =
		_rawMeta !== undefined ? unsealMetadata(_rawMeta, `${rowAad}|meta`, rowKeyCtx) : undefined;
	const record = {
		...rest,
		content,
		...(metadata !== undefined ? { metadata } : {}),
	} as unknown as MemoryRecord;
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
export function recordToRowArgs(workspaceId: string, r: MemoryRecord): Record<string, unknown> {
	const rec = r as MemoryRecord & {
		createdBy?: {
			kind?: string;
			channelId?: string;
			conversationId?: string;
			sessionKey?: string;
			accountId?: string;
		};
		sourceType?: string;
		links?: { kind: string; target: string }[];
		validFrom?: number;
		validTo?: number;
		confidence?: number;
		status?: string;
		sourcePointers?: string[];
		modality?: string;
		mediaPointer?: string;
		subjectKey?: string;
		metadata?: unknown;
		embedding?: number[];
	};
	// Bind content AND metadata to the same row identity (AAD) + per-origin
	// subkey (keyContext), computed once.
	const memId = String(rec.memoryId ?? "");
	const originKind = rec.createdBy?.kind ?? "owner";
	const aad = factAad(workspaceId, memId, originKind);
	const keyCtx = originKeyContext(
		workspaceId,
		originKind,
		rec.createdBy?.channelId,
		rec.createdBy?.conversationId,
		rec.createdBy?.sessionKey,
	);
	return {
		workspaceId,
		memoryId: rec.memoryId,
		content: stringToBytes(String(rec.content ?? ""), aad, keyCtx),
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
		...(rec.sourceType !== undefined ? { sourceType: rec.sourceType } : {}),
		...(rec.links !== undefined ? { links: rec.links } : {}),
		...(rec.validFrom !== undefined ? { validFrom: rec.validFrom } : {}),
		...(rec.validTo !== undefined ? { validTo: rec.validTo } : {}),
		...(rec.confidence !== undefined ? { confidence: rec.confidence } : {}),
		...(rec.status !== undefined ? { status: rec.status } : {}),
		...(rec.sourcePointers !== undefined ? { sourcePointers: rec.sourcePointers } : {}),
		...(rec.modality !== undefined ? { modality: rec.modality } : {}),
		...(rec.mediaPointer !== undefined ? { mediaPointer: rec.mediaPointer } : {}),
		...(rec.subjectKey !== undefined ? { subjectKey: rec.subjectKey } : {}),
		...(rec.metadata !== undefined ? { metadata: sealMetadata(rec.metadata, `${aad}|meta`, keyCtx) } : {}),
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

/** Max memoryIds per markAccessed/setLifecycle mutation. Each id costs 1 query + 1 patch,
 *  so 1000 stays well under Convex's 8192-write / 16 MiB-read per-mutation budget — a large
 *  recall hit-set or decay sweep is split across several mutations instead of one bomb. */
const CONVEX_MUTATION_ID_CHUNK = 1000;

export class ConvexMemoryStore implements MemoryStore {
	constructor(private readonly deps: Deps) {}

	async listFacts(filter: ListFilter): Promise<MemoryRecord[]> {
		// The server applies `limit` (default-capped at 200) BEFORE the client-side
		// segment/origin filter below — so a SELECTIVE filter with NO explicit limit would
		// silently truncate once a lifecycle holds >200 facts, diverging from the filesystem
		// FactStore.list (which reads ALL, then filters). In that case page the full store so
		// the two modes match exactly; otherwise the fast default-capped query is correct.
		const lifecycle = filter.lifecycle ?? "active";
		const needsCompleteSet =
			filter.limit === undefined && (filter.segment !== undefined || filter.origin !== undefined);
		let recs: MemoryRecord[];
		if (needsCompleteSet) {
			recs = (await this.listAllFactRecordsRaw(this.deps.workspaceId)).filter(
				(r) => r.lifecycle === lifecycle,
			);
		} else {
			const rows = (await this.deps.client.query(api.memory.listFacts, {
				workspaceId: this.deps.workspaceId,
				...(filter.lifecycle !== undefined ? { lifecycle: filter.lifecycle } : {}),
				...(filter.limit !== undefined ? { limit: filter.limit } : {}),
			})) as Array<Record<string, unknown>>;
			recs = rows.map(rowToRecordOrNull).filter((r): r is MemoryRecord => r !== null);
		}
		// `tier` is intentionally NOT filtered: FactStore.list ignores it too, so honouring it
		// in convex alone would DIVERGE — add it to BOTH modes at once if ever wanted.
		if (filter.segment) recs = recs.filter((r) => r.segment === filter.segment);
		if (filter.origin !== undefined) {
			// `ListFilter.origin` (store.ts) and `MemoryRecordOrigin` (records.ts) are
			// structurally compatible; bridge across the two type universes. The record's
			// `createdBy` is rebuilt by `rowToRecord`, so it carries the origin at runtime.
			const originFilter = filter.origin as MemoryRecordOrigin;
			recs = recs.filter((r) =>
				recordMatchesOriginFilter(r as { createdBy?: MemoryRecordOrigin }, originFilter),
			);
		}
		return recs;
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
			sourceType?: "user_instruction" | "owner_message" | "channel_message" | "tool_output" | "retrieved_document" | "compaction" | "extraction" | "dream";
			links?: { kind: "supersedes" | "corrects" | "relates" | "derived_from" | "supports" | "contradicts"; target: string }[];
			validFrom?: number;
			validTo?: number;
			confidence?: number;
			status?: "asserted" | "provisional" | "confirmed" | "disputed" | "retracted";
			sourcePointers?: string[];
			modality?: "text" | "audio" | "image" | "video" | "document";
			mediaPointer?: string;
			subjectKey?: string;
			metadata?: Record<string, unknown>;
			embedding?: number[];
		};
		const memoryId = f.memoryId ?? crypto.randomUUID();
		const row = (await this.deps.client.mutation(api.memory.writeFact, {
			workspaceId: this.deps.workspaceId,
			memoryId,
			content: stringToBytes(
				f.content ?? "",
				factAad(this.deps.workspaceId, memoryId, f.createdBy?.kind ?? "owner"),
				originKeyContext(
					this.deps.workspaceId,
					f.createdBy?.kind ?? "owner",
					f.createdBy?.channelId,
					f.createdBy?.conversationId,
					f.createdBy?.sessionKey,
				),
			),
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
			...(f.sourceType !== undefined ? { sourceType: f.sourceType } : {}),
			...(f.links !== undefined ? { links: f.links } : {}),
			...(f.validFrom !== undefined ? { validFrom: f.validFrom } : {}),
			...(f.validTo !== undefined ? { validTo: f.validTo } : {}),
			...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
			...(f.status !== undefined ? { status: f.status } : {}),
			...(f.sourcePointers !== undefined ? { sourcePointers: f.sourcePointers } : {}),
			...(f.modality !== undefined ? { modality: f.modality } : {}),
			...(f.mediaPointer !== undefined ? { mediaPointer: f.mediaPointer } : {}),
			...(f.subjectKey !== undefined ? { subjectKey: f.subjectKey } : {}),
			...(f.metadata !== undefined ? { metadata: f.metadata } : {}),
			...(f.embedding !== undefined ? { embedding: f.embedding } : {}),
		})) as Record<string, unknown>;
		return rowToRecord(row);
	}

	async searchFacts(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter },
	): Promise<Array<MemoryRecord & { score: number }>> {
		// ⚠️ LATENT / v2-only / origin-UNSAFE. This routes through `searchContent`,
		// which (a) FTS-searches the SEALED `content` column (ciphertext → dead
		// results) and (b) drops `opts.origin` entirely (no isolation). It is
		// reachable ONLY via `findSimilar`'s no-embedding fallback (the vector path
		// = Tideline v2) and is NOT on the v1 recall path: live recall routes through
		// `FactStore.search` over the hydrated cache, which applies the origin filter
		// (proven by src/agents/memory/origin-isolation.test.ts). When v2 wires
		// vectors, rewrite this as a decrypt-scan + MANDATORY origin filter (the
		// deferred half of gate 0.4). Do NOT wire this into recall before then.
		//
		// DRIFT NOTE: the filesystem-side `searchFacts` now routes through
		// `recall()` (hybrid scoring + origin filter), so it is no longer a
		// like-for-like sibling of this lexical-ciphertext path. The two are NOT
		// expected to match output today — that divergence is intentional and is
		// closed only when the v2 rewrite above lands (decrypt-scan + origin
		// filter), at which point both sides go through origin-filtered recall.
		const hits = (await this.deps.client.query(api.memory.searchContent, {
			workspaceId: this.deps.workspaceId,
			query,
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
		})) as Array<Record<string, unknown>>;
		// Map through the nullable decoder + filter nulls (consistent with
		// listFacts): ONE undecryptable row (foreign tenant / rotated-away key)
		// must not throw the whole recall query.
		const records = hits
			.map((r) => {
				const rec = rowToRecordOrNull(r);
				return rec === null ? null : { ...rec, score: 1 };
			})
			.filter((r): r is MemoryRecord & { score: number } => r !== null);
		if (opts.markAccessed !== false && records.length > 0) {
			await this.markFactsAccessed(records.map((r) => (r as { memoryId: string }).memoryId));
		}
		return records as unknown as Array<MemoryRecord & { score: number }>;
	}

	async markFactsAccessed(memoryIds: string[]): Promise<void> {
		if (memoryIds.length === 0) return;
		// Chunk: the mutation does 1 query + 1 patch per id, so an unbounded array would blow
		// Convex's per-mutation 8192-write / 16 MiB-read budget on a large recall/decay sweep.
		for (let i = 0; i < memoryIds.length; i += CONVEX_MUTATION_ID_CHUNK) {
			await this.deps.client.mutation(api.memory.markAccessed, {
				workspaceId: this.deps.workspaceId,
				memoryIds: memoryIds.slice(i, i + CONVEX_MUTATION_ID_CHUNK),
			});
		}
	}

	async setFactsLifecycle(memoryIds: string[], lifecycle: MemoryLifecycle): Promise<void> {
		if (memoryIds.length === 0) return;
		for (let i = 0; i < memoryIds.length; i += CONVEX_MUTATION_ID_CHUNK) {
			await this.deps.client.mutation(api.memory.setLifecycle, {
				workspaceId: this.deps.workspaceId,
				memoryIds: memoryIds.slice(i, i + CONVEX_MUTATION_ID_CHUNK),
				lifecycle,
			});
		}
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
		// ⚠️ LATENT / v2-only / origin-UNSAFE — DO NOT wire into recall yet.
		// `_scope` is accepted but NOT forwarded: the underlying `api.memory.findSimilar`
		// filters by workspaceId + lifecycle ONLY (the `by_embedding` vectorIndex has no
		// origin filterFields), so this returns top-k ACROSS origins. AAD-bound decryption
		// means foreign content won't decrypt, but candidate scores/ids still cross origins.
		// Mirror the `searchFacts` banner: not on any live recall path (v1 recall is
		// `FactStore.recall` over the origin-filtered cache). Before use, thread `_scope`
		// through and origin-filter server-side (extend the vectorIndex filterFields).
		//
		// PR19 — embedding-driven recall. The caller provides text; we ask
		// a configured embedding provider for a vector and run the vectorIndex
		// query against memoryFacts.embedding.
		//
		// Provider resolution: optional `BRIGADE_EMBEDDING_PROVIDER` env var
		// (defaults to "openai"). The provider's API key is the same one
		// already wired by the auth store. If no embedding provider is
		// configured, fall back to the lexical `searchFacts` path so callers
		// don't lose recall entirely.
		// The `by_embedding` vectorIndex is fixed at 256 dims (the bundled
		// embedder's size). A query vector of any other length (e.g. an external
		// 1536-dim model wired via BRIGADE_EMBEDDING_PROVIDER) silently returns
		// zero hits, so treat a dim mismatch like "no embedding" and fall back to
		// lexical rather than run a doomed vector query.
		const EMBED_DIM = 256;
		const embedding = await this._embed(text);
		if (!embedding || embedding.length !== EMBED_DIM) {
			// Graceful fallback — lexical search still works without (or with a
			// dimension-mismatched) embedding.
			return this.searchFacts(text, { ...(k !== undefined ? { limit: k } : {}) });
		}
		const hits = (await this.deps.client.query(api.memory.findSimilar, {
			workspaceId: this.deps.workspaceId,
			embedding,
			...(k !== undefined ? { k } : {}),
		})) as Array<Record<string, unknown>>;
		// Map through the nullable decoder + filter nulls (consistent with
		// listFacts): ONE undecryptable candidate must not throw the whole query.
		return hits
			.map((r) => {
				const rec = rowToRecordOrNull(r);
				return rec === null ? null : { ...rec, score: (r.score as number) ?? 0 };
			})
			.filter((r): r is MemoryRecord & { score: number } => r !== null);
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
		// ⚠️ DEAD / superseded by Tideline 0.6 — NO live caller. The gateway
		// background sweep runs `runDecayGc` directly (server.ts:1034), which
		// drives decay from the CONTINUOUS `effectiveScore` (decay.ts) in BOTH
		// modes via FactStore. This method calls the convex DISCRETE per-tier
		// `decay` mutation (7d/30d/90d idle steps) — a different function that
		// would re-diverge cognition from fs mode. Do NOT wire it in; delete the
		// convex `decay` mutation on the next convex deploy.
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
				const mostRecentId = list[0]?.memoryId;
				// `list` is a listFacts page capped at the server default, so
				// `list.length` saturates and diverges from the filesystem true
				// count. Emit the change signal with the UNCAPPED count instead
				// (mostRecentId from the newest row is correct regardless of cap).
				const emit = (delta: MemoryDelta): void => {
					try {
						cb(delta);
					} catch {
						// Subscriber threw — stay alive.
					}
				};
				void this.countActiveFacts().then(
					(activeCount) =>
						emit({ kind: "facts-changed", activeCount, mostRecentId } as unknown as MemoryDelta),
					() => emit({ kind: "facts-changed", mostRecentId } as unknown as MemoryDelta),
				);
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

	async appendMemoryEvent(workspaceId: string, event: Record<string, unknown>): Promise<void> {
		await this.deps.client.mutation(api.memory.appendMemoryEvent, {
			workspaceId,
			at: typeof event.at === "number" ? event.at : Date.now(),
			kind: typeof event.kind === "string" ? event.kind : "unknown",
			data: JSON.stringify(event),
		});
	}

	async listMemoryEvents(workspaceId: string): Promise<Array<Record<string, unknown>>> {
		const rows = (await this.deps.client.query(api.memory.listMemoryEvents, { workspaceId })) as string[];
		// Mirror the filesystem MemoryEventLog guard (event-log.ts): skip a corrupt/unparseable
		// row and any event missing memoryId+kind, rather than inject a null-field event into
		// every audit-trail consumer (the self-improve proposer, transparency).
		const out: Array<Record<string, unknown>> = [];
		for (const s of rows) {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(s) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (typeof parsed.memoryId === "string" && typeof parsed.kind === "string") out.push(parsed);
		}
		return out;
	}
}
