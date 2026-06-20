// convex/memory.ts — memoryFacts + memoryExtractCursors + memoryConsolidateState
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server.js";

const Segment = v.union(
	v.literal("identity"),
	v.literal("preference"),
	v.literal("correction"),
	v.literal("relationship"),
	v.literal("project"),
	v.literal("knowledge"),
	v.literal("context"),
);
const Tier = v.union(v.literal("short"), v.literal("long"), v.literal("permanent"));
const Lifecycle = v.union(v.literal("active"), v.literal("archived"), v.literal("pruned"));
const Origin = v.union(v.literal("owner"), v.literal("channel"));
const SourceType = v.union(
	v.literal("user_instruction"),
	v.literal("owner_message"),
	v.literal("channel_message"),
	v.literal("tool_output"),
	v.literal("retrieved_document"),
	v.literal("compaction"),
	v.literal("extraction"),
	v.literal("dream"),
);
const LinkKind = v.union(
	v.literal("supersedes"),
	v.literal("transition"), // Step 19 — must mirror MemoryLinkKind (links.ts) exactly
	v.literal("corrects"),
	v.literal("relates"),
	v.literal("derived_from"),
	v.literal("supports"),
	v.literal("contradicts"),
);
const Link = v.object({ kind: LinkKind, target: v.string() });
const Status = v.union(
	v.literal("asserted"),
	v.literal("provisional"),
	v.literal("confirmed"),
	v.literal("disputed"),
	v.literal("retracted"),
);
const Modality = v.union(
	v.literal("text"),
	v.literal("audio"),
	v.literal("image"),
	v.literal("video"),
	v.literal("document"),
);

export const listFacts = query({
	args: {
		workspaceId: v.string(),
		lifecycle: v.optional(Lifecycle),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const lifecycle = args.lifecycle ?? "active";
		const q = ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_lifecycle_createdAt", (q2) =>
				q2.eq("workspaceId", args.workspaceId).eq("lifecycle", lifecycle),
			)
			.order("desc");
		const limit = args.limit && args.limit > 0 ? args.limit : 200;
		return q.take(limit);
	},
});

export const writeFact = mutation({
	args: {
		workspaceId: v.string(),
		memoryId: v.string(),
		content: v.bytes(),
		segment: Segment,
		tier: Tier,
		importance: v.number(),
		decayRate: v.number(),
		sourceTurn: v.optional(v.string()),
		supersedes: v.optional(v.array(v.string())),
		createdByKind: v.optional(Origin),
		createdByChannelId: v.optional(v.string()),
		createdByConversationId: v.optional(v.string()),
		createdBySessionKey: v.optional(v.string()),
		createdByAccountId: v.optional(v.string()),
		sourceType: v.optional(SourceType),
		links: v.optional(v.array(Link)),
		validFrom: v.optional(v.number()),
		validTo: v.optional(v.number()),
		confidence: v.optional(v.number()),
		status: v.optional(Status),
		sourcePointers: v.optional(v.array(v.string())),
		modality: v.optional(Modality),
		mediaPointer: v.optional(v.string()),
		subjectKey: v.optional(v.string()),
		metadata: v.optional(v.any()),
		embedding: v.optional(v.array(v.number())),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const id = await ctx.db.insert("memoryFacts", {
			...args,
			accessCount: 0,
			lastAccessedAt: now,
			createdAt: now,
			lifecycle: "active" as const,
		});
		if (args.supersedes && args.supersedes.length > 0) {
			for (const supersededId of args.supersedes) {
				const dead = await ctx.db
					.query("memoryFacts")
					.withIndex("by_workspace_memoryId", (q) =>
						q.eq("workspaceId", args.workspaceId).eq("memoryId", supersededId),
					)
					.first();
				if (dead && dead.lifecycle === "active") {
					await ctx.db.patch(dead._id, { lifecycle: "archived" as const });
				}
			}
		}
		return await ctx.db.get(id);
	},
});

/** Every fact row for a workspace across all lifecycles — boot hydration of
 *  the in-process facts cache. */
export const listAllFacts = query({
	args: {
		workspaceId: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
		numItems: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// PAGINATED. Boot hydration reads EVERY fact for a workspace; a single
		// `.collect()` blows Convex's 16 MiB per-execution read cap once memory
		// grows (this runs on every boot). The client loops with `continueCursor`
		// until `isDone` and concatenates the pages — lossless at any fact count.
		const numItems = args.numItems && args.numItems > 0 ? Math.min(args.numItems, 512) : 256;
		return await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_memoryId", (q) => q.eq("workspaceId", args.workspaceId))
			.paginate({ numItems, cursor: args.cursor ?? null });
	},
});

/** Authoritative single-record upsert — every field caller-supplied
 *  (accessCount, lifecycle, timestamps included). The FactStore dispatch
 *  realises its whole-file diffs through this. */
export const upsertFactRecord = mutation({
	args: {
		workspaceId: v.string(),
		memoryId: v.string(),
		content: v.bytes(),
		segment: Segment,
		tier: Tier,
		importance: v.number(),
		decayRate: v.number(),
		accessCount: v.number(),
		lastAccessedAt: v.number(),
		createdAt: v.number(),
		lifecycle: Lifecycle,
		sourceTurn: v.optional(v.string()),
		supersedes: v.optional(v.array(v.string())),
		createdByKind: v.optional(Origin),
		createdByChannelId: v.optional(v.string()),
		createdByConversationId: v.optional(v.string()),
		createdBySessionKey: v.optional(v.string()),
		createdByAccountId: v.optional(v.string()),
		sourceType: v.optional(SourceType),
		links: v.optional(v.array(Link)),
		validFrom: v.optional(v.number()),
		validTo: v.optional(v.number()),
		confidence: v.optional(v.number()),
		status: v.optional(Status),
		sourcePointers: v.optional(v.array(v.string())),
		modality: v.optional(Modality),
		mediaPointer: v.optional(v.string()),
		subjectKey: v.optional(v.string()),
		metadata: v.optional(v.any()),
		embedding: v.optional(v.array(v.number())),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_memoryId", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("memoryId", args.memoryId),
			)
			.first();
		if (existing) {
			await ctx.db.replace(existing._id, args);
			return;
		}
		await ctx.db.insert("memoryFacts", args);
	},
});

export const deleteFactRecord = mutation({
	args: { workspaceId: v.string(), memoryId: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_memoryId", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("memoryId", args.memoryId),
			)
			.first();
		if (existing) await ctx.db.delete(existing._id);
	},
});

// ── memory AUDIT EVENTS (the convex provenance trail; fs mode uses events.jsonl) ──
export const appendMemoryEvent = mutation({
	args: {
		workspaceId: v.string(),
		at: v.number(),
		kind: v.string(),
		data: v.string(),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert("memoryEvents", args);
	},
});

/** The audit trail, oldest-first. Bounded to the most-recent `limit` (default 1000,
 *  max 5000) to stay under Convex's 16 MiB per-execution read cap. */
export const listMemoryEvents = query({
	args: { workspaceId: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 5000) : 1000;
		const rows = await ctx.db
			.query("memoryEvents")
			.withIndex("by_workspace_at", (q) => q.eq("workspaceId", args.workspaceId))
			.order("desc")
			.take(limit);
		return rows.reverse().map((r) => r.data);
	},
});

export const markAccessed = mutation({
	args: { workspaceId: v.string(), memoryIds: v.array(v.string()) },
	handler: async (ctx, args) => {
		const now = Date.now();
		for (const memoryId of args.memoryIds) {
			const row = await ctx.db
				.query("memoryFacts")
				.withIndex("by_workspace_memoryId", (q) =>
					q.eq("workspaceId", args.workspaceId).eq("memoryId", memoryId),
				)
				.first();
			if (row) {
				await ctx.db.patch(row._id, {
					accessCount: (row.accessCount ?? 0) + 1,
					lastAccessedAt: now,
				});
			}
		}
	},
});

// ⚠️ DEAD / superseded by Tideline 0.6. This DISCRETE per-tier decay
// (short→archived@7d / archived→pruned@30d / long→archived@90d) is NOT the
// live decay path: the gateway sweep runs `runDecayGc` (continuous
// `effectiveScore`, src/agents/memory/decay.ts) in BOTH modes, and nothing
// calls `ConvexMemoryStore.decay`. Kept only to avoid redeploy churn; DELETE
// on the next convex deploy. Calling it would re-diverge cognition from fs.
export const decay = mutation({
	args: {
		workspaceId: v.string(),
		now: v.number(),
		// Per-tier idle thresholds (ms). Defaults match the filesystem-mode
		// agent-loop sweep: short→archived at 7d, archived→pruned at 30d,
		// long→archived at 90d. `permanent` never decays.
		shortIdleMs: v.optional(v.number()),
		archivedIdleMs: v.optional(v.number()),
		longIdleMs: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const shortIdle = args.shortIdleMs ?? 7 * 24 * 60 * 60 * 1000;
		const archivedIdle = args.archivedIdleMs ?? 30 * 24 * 60 * 60 * 1000;
		const longIdle = args.longIdleMs ?? 90 * 24 * 60 * 60 * 1000;

		let archived = 0;
		let pruned = 0;

		// Active short → archived after `shortIdle`
		const activeRows = await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_lifecycle_createdAt", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("lifecycle", "active" as const),
			)
			// SAFETY BOUND (this is the DEAD path; live decay is runDecayGc): cap reads+patches
			// under Convex's per-mutation 16 MiB-read / 8192-write budget so an accidental call
			// can't bomb. Delete this whole mutation on the next deploy (see header).
			.take(2000);
		for (const row of activeRows) {
			if (row.tier === "permanent") continue;
			const idle = args.now - row.lastAccessedAt;
			const threshold = row.tier === "short" ? shortIdle : longIdle;
			if (idle > threshold) {
				await ctx.db.patch(row._id, { lifecycle: "archived" as const });
				archived += 1;
			}
		}

		// Archived → pruned after `archivedIdle`
		const archivedRows = await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_lifecycle_createdAt", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("lifecycle", "archived" as const),
			)
			.take(2000); // SAFETY BOUND (dead path) — see the active-rows note above
		for (const row of archivedRows) {
			if (row.tier === "permanent") continue;
			if (args.now - row.lastAccessedAt > archivedIdle) {
				await ctx.db.patch(row._id, { lifecycle: "pruned" as const });
				pruned += 1;
			}
		}

		return { archived, pruned };
	},
});

export const setLifecycle = mutation({
	args: { workspaceId: v.string(), memoryIds: v.array(v.string()), lifecycle: Lifecycle },
	handler: async (ctx, args) => {
		for (const memoryId of args.memoryIds) {
			const row = await ctx.db
				.query("memoryFacts")
				.withIndex("by_workspace_memoryId", (q) =>
					q.eq("workspaceId", args.workspaceId).eq("memoryId", memoryId),
				)
				.first();
			if (row && row.lifecycle !== args.lifecycle) {
				await ctx.db.patch(row._id, { lifecycle: args.lifecycle });
			}
		}
	},
});

export const countActiveFacts = query({
	args: {
		workspaceId: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		// PAGINATED count. A single `.collect()` of all active facts blows the
		// 16 MiB read cap at scale. The client loops summing `count` until
		// `isDone`. Returns only the page size (+cursor) — never the rows.
		const res = await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_lifecycle_createdAt", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("lifecycle", "active"),
			)
			.paginate({ numItems: 512, cursor: args.cursor ?? null });
		return { count: res.page.length, isDone: res.isDone, continueCursor: res.continueCursor };
	},
});

export const getExtractCursor = query({
	args: { workspaceId: v.string(), sessionId: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("memoryExtractCursors")
			.withIndex("by_workspace_session", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("sessionId", args.sessionId),
			)
			.first();
		return row?.processedCount ?? 0;
	},
});

export const setExtractCursor = mutation({
	args: { workspaceId: v.string(), sessionId: v.string(), processedCount: v.number() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("memoryExtractCursors")
			.withIndex("by_workspace_session", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("sessionId", args.sessionId),
			)
			.first();
		// `updatedAt` is stored for audit / introspection but is not read back by
		// the client — only `processedCount` is queried (getExtractCursor). It is
		// stamped here because the schema field is non-optional (see schema.ts).
		const payload = { ...args, updatedAt: Date.now() };
		if (existing) await ctx.db.replace(existing._id, payload);
		else await ctx.db.insert("memoryExtractCursors", payload);
	},
});

export const getConsolidateLastRunAt = query({
	args: { workspaceId: v.string() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("memoryConsolidateState")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
			.first();
		return row?.lastRunAt;
	},
});

export const markConsolidateRunAt = mutation({
	args: { workspaceId: v.string(), lastRunAt: v.number() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("memoryConsolidateState")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
			.first();
		if (existing) await ctx.db.replace(existing._id, args);
		else await ctx.db.insert("memoryConsolidateState", args);
	},
});

// Probe: does this backend expose the native `ctx.vectorSearch` over the
// `by_embedding` vectorIndex? (Older in-memory backends didn't — `findSimilar`
// falls back to a manual cosine scan.) Returns the ANN hits' ids + scores.
// ⚠️ LATENT / v2-only / origin-UNSAFE: this filters by workspaceId ONLY —
// it does NOT apply the per-origin (createdBy*) recall filter the isolation
// model requires, so it must NOT be wired into recall until it origin-filters
// server-side (extend the `ctx.vectorSearch` filter to constrain the
// createdBy* fields). Not on the recall path today.
export const vectorProbe = action({
	args: { workspaceId: v.string(), embedding: v.array(v.number()), k: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const results = await ctx.vectorSearch("memoryFacts", "by_embedding", {
			vector: args.embedding,
			limit: args.k && args.k > 0 ? args.k : 5,
			filter: (q) => q.eq("workspaceId", args.workspaceId),
		});
		return results.map((r) => ({ id: r._id, score: r._score }));
	},
});

// ⚠️ LATENT / v2-only. This runs BM25 full-text matching over the sealed
// `content` column, which stores CIPHERTEXT (v.bytes()), so it yields dead
// results while content is sealed at rest. It must NOT be wired into recall —
// live recall ranks BM25 in-app over decrypted content. Repurpose only if/when
// content stops being sealed, or this is reworked to scan decrypted rows.
export const searchContent = query({
	args: { workspaceId: v.string(), query: v.string(), limit: v.optional(v.number()) },
	handler: async (ctx, args) => {
		const limit = args.limit && args.limit > 0 ? args.limit : 8;
		const hits = await ctx.db
			.query("memoryFacts")
			.withSearchIndex("search_content", (q) =>
				q
					.search("content", args.query)
					.eq("workspaceId", args.workspaceId)
					.eq("lifecycle", "active" as const),
			)
			.take(limit);
		return hits;
	},
});

// Bound on the manual candidate scan below — a single `.collect()` over every
// active fact would hit the 16 MiB per-query read cap once memory grows (each row
// carries a 256-float embedding + encrypted content), so we scan at most the
// newest N. The cap-safe, index-served path is `vectorProbe` (an ACTION using the
// native `ctx.vectorSearch`); this query is the in-memory-backend fallback.
const VECTOR_SCAN_CAP = 2000;

// PR19 — Vector recall against the `memoryFacts.embedding` vectorIndex.
// ⚠️ LATENT / v2-only / origin-UNSAFE: this filters by workspaceId + lifecycle
// ONLY — it does NOT apply the per-origin (createdBy*) recall filter the isolation
// model requires, so it must NOT be wired into recall until it (or its native
// `vectorProbe`/`ctx.vectorSearch` replacement) origin-filters server-side.
// No live caller today (v1 recall runs BM25 in-app over the decrypted cache).
// Convex query handlers can't issue HTTP calls (queries are deterministic),
// so embedding generation happens at the CALLER (the adapter's `findSimilar`
// passes pre-computed embeddings). This query just does the ANN search
// against the index.
export const findSimilar = query({
	args: {
		workspaceId: v.string(),
		embedding: v.array(v.number()),
		k: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const k = args.k && args.k > 0 ? args.k : 5;
		const hits = await ctx.db
			.query("memoryFacts")
			.withIndex("by_workspace_lifecycle_createdAt", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("lifecycle", "active" as const),
			)
			.order("desc") // NEWEST-first: the index is createdAt-ordered and Convex defaults to ascending, so without this .take() would scan the OLDEST N (matches listFacts + the cap comment above)
			.take(VECTOR_SCAN_CAP);
		// Compute cosine similarity client-side against the (capped) candidate set.
		// (The schema declares a vectorIndex but Convex query helpers don't
		// expose .vectorSearch on the in-memory backend yet; this fallback
		// keeps the contract intact while emitting accurate scores. The native
		// `vectorProbe` action is the index-served, cap-safe path.)
		const queryVec = args.embedding;
		const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
		const queryNorm = norm(queryVec);
		const scored: Array<{ row: typeof hits[number]; score: number }> = [];
		for (const row of hits) {
			const emb = row.embedding;
			if (!emb || emb.length !== queryVec.length) continue;
			let dot = 0;
			for (let i = 0; i < emb.length; i++) {
				dot += (emb[i] ?? 0) * (queryVec[i] ?? 0);
			}
			const rowNorm = norm(emb);
			const score = queryNorm > 0 && rowNorm > 0 ? dot / (queryNorm * rowNorm) : 0;
			scored.push({ row, score });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, k).map(({ row, score }) => ({ ...row, score }));
	},
});
