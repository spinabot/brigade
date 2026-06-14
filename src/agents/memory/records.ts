/**
 * Structured memory records — an append-only JSONL file
 * (`<workspace>/memory/facts.jsonl`). Single-user, so reads scan the whole
 * file and writes are read-modify-write — no concurrency budget to fight.
 *
 * A "memory" here is a structured fact, NOT a raw note: one declarative
 * sentence tagged with a `segment` (what kind of fact) and a `tier` +
 * `importance` + `decayRate` derived from that segment. This is what the
 * post-turn extraction subagent emits and what `write_memory` persists; the
 * lexical recall layer (storage.ts) searches these alongside MEMORY.md +
 * daily notes.
 *
 * Conflict resolution: `supersedes` archives older records, the
 * `correction` segment overturns a prior belief, and a decay GC ages out
 * neglected facts. (A heavier 3-LLM consolidation debate is intentionally
 * NOT done in v1 — supersede + decay cover the common cases.)
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	getCachedFacts,
	primeFactsCache,
	workspaceIdFromDir,
	writeThroughFactsCache,
} from "../../storage/facts-cache.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";

/** What kind of fact this is — drives tier/importance/decay defaults. */
export type MemorySegment =
	| "identity"
	| "preference"
	| "correction"
	| "relationship"
	| "project"
	| "knowledge"
	| "context";

/** How durable a record is. `permanent` is never decayed out. */
export type MemoryTier = "short" | "long" | "permanent";

/** Active = live, archived = superseded/decayed-but-kept, pruned = dead. */
export type MemoryLifecycle = "active" | "archived" | "pruned";

/**
 * Who wrote this memory record — used by the recall path to keep peer
 * memories isolated from the operator's view (and isolated per-session
 * from each other). Mirrors the `CronJobOrigin` shape from the cron tool
 * so the audit trail vocabulary stays consistent across primitives.
 *
 *   - `{ kind: "owner" }` — workspace owner (TUI / `connect` / CLI).
 *     Recallable by the owner across every owner session. NOT recalled
 *     by channel peers so the operator's private notes can't leak into
 *     an approved peer's chat.
 *   - `{ kind: "channel", channelId, conversationId, sessionKey }` —
 *     written from an approved channel peer's chat. Recallable ONLY
 *     when the calling turn matches all three (channel + conversation
 *     + session). Different chats from the same peer don't see each
 *     other; the operator never sees them in auto-recall.
 *
 * `accountId` is captured opportunistically for multi-account channels.
 *
 * Records persisted before this field existed have `createdBy: undefined`
 * — the recall path treats them as owner-origin for back-compat.
 */
export type MemoryRecordOrigin =
	| { kind: "owner" }
	| {
			kind: "channel";
			channelId: string;
			conversationId: string;
			sessionKey: string;
			accountId?: string;
	  };

export interface MemoryRecord {
	memoryId: string;
	/** One clear declarative sentence. */
	content: string;
	segment: MemorySegment;
	tier: MemoryTier;
	/** 0..1 — segment default unless the writer overrides. */
	importance: number;
	/** Per-segment decay multiplier (higher = forgets faster). */
	decayRate: number;
	/** Bumped each time recall surfaces this record (decay reinforcement). */
	accessCount: number;
	/** Epoch ms of the last recall hit (or creation). */
	lastAccessedAt: number;
	/** Epoch ms when first written. */
	createdAt: number;
	/** Run/turn id that produced this fact, when known. */
	sourceTurn?: string;
	/** memoryIds this record archives (corrections/updates). */
	supersedes?: string[];
	lifecycle: MemoryLifecycle;
	/**
	 * Origin of this record (see {@link MemoryRecordOrigin}). `undefined`
	 * ⇔ legacy record persisted before ownership tracking shipped —
	 * treated as `{ kind: "owner" }` by the recall path so existing
	 * facts keep their previous owner-visible behaviour.
	 */
	createdBy?: MemoryRecordOrigin;
	/** Optional JSON sidecar, e.g. {"corrects":"the prior belief"}. */
	metadata?: Record<string, unknown>;
}

/**
 * Per-segment defaults. `identity` is the most durable (permanent, slow
 * decay); `context` the most ephemeral (short tier, fast decay).
 */
export const SEGMENT_DEFAULTS: Record<
	MemorySegment,
	{ tier: MemoryTier; importance: number; decayRate: number }
> = {
	identity: { tier: "permanent", importance: 0.85, decayRate: 0.01 },
	correction: { tier: "long", importance: 0.8, decayRate: 0.015 },
	relationship: { tier: "long", importance: 0.75, decayRate: 0.02 },
	preference: { tier: "long", importance: 0.7, decayRate: 0.02 },
	project: { tier: "long", importance: 0.65, decayRate: 0.025 },
	knowledge: { tier: "long", importance: 0.6, decayRate: 0.03 },
	context: { tier: "short", importance: 0.4, decayRate: 0.08 },
};

export const MEMORY_SEGMENTS = Object.keys(SEGMENT_DEFAULTS) as MemorySegment[];

/** Relative path of the structured fact store within a workspace. */
export const FACTS_RELATIVE_PATH = path.join("memory", "facts.jsonl");

/**
 * Hard cap on a single fact's content. A fact is meant to be one sentence;
 * this stops a misbehaving model (or pasted blob) from writing a megabyte
 * "fact" that then bloats the always-read JSONL AND every auto-recall
 * injection. Generous enough for any legitimate fact.
 */
export const MAX_FACT_CONTENT_CHARS = 1000;

/**
 * Jaccard-similarity threshold above which two facts are treated as the same
 * at write time (dedup). Deliberately HIGH (0.85) so only near-identical
 * restatements collapse — distinct facts that merely share words (e.g. two
 * different facts about the same topic) are kept separate.
 */
export const DEDUP_SIMILARITY = 0.85;

/** Lowercased alphanumeric token SET of a fact's content (for dedup). */
function tokenSet(content: string): Set<string> {
	return new Set(
		content
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 0),
	);
}

/** Jaccard similarity |A∩B| / |A∪B| of two token sets (0 when both empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter += 1;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** `mem_<base36 time>_<rand>` — a time-sortable id shape. */
export function makeMemoryId(): string {
	return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Treat a missing origin as owner (back-compat with records persisted
 * before ownership tracking shipped). All recall + dedup logic should
 * route through this helper rather than reading `createdBy` directly so
 * the legacy default stays in one place.
 */
export function resolveRecordOrigin(
	origin: MemoryRecordOrigin | undefined,
): MemoryRecordOrigin {
	return origin ?? { kind: "owner" };
}

/** Two origins are the same when both fields-by-fields match. */
export function sameOrigin(
	a: MemoryRecordOrigin | undefined,
	b: MemoryRecordOrigin | undefined,
): boolean {
	const resolvedA = resolveRecordOrigin(a);
	const resolvedB = resolveRecordOrigin(b);
	if (resolvedA.kind !== resolvedB.kind) return false;
	if (resolvedA.kind === "owner") return true;
	const channelA = resolvedA;
	const channelB = resolvedB as Extract<MemoryRecordOrigin, { kind: "channel" }>;
	return (
		channelA.channelId === channelB.channelId &&
		channelA.conversationId === channelB.conversationId &&
		channelA.sessionKey === channelB.sessionKey
	);
}

/**
 * Recall-side filter. Per the design:
 *   - An owner caller's filter is `{ kind: "owner" }` — they recall ONLY
 *     owner-written records (and legacy `undefined`-origin records, which
 *     resolve to owner). The operator's view stays clean of peer-written
 *     state.
 *   - A channel-peer caller's filter is `{ kind: "channel", … }` matching
 *     their channelId + conversationId + sessionKey. They recall ONLY
 *     records whose origin matches exactly. Different sessions from the
 *     same peer don't see each other; the operator's records are
 *     invisible to them too.
 *
 * `undefined` filter = no filtering (used by maintenance paths like
 * decay GC, consolidation, doctor diagnostics — anything that legitimately
 * needs the whole store).
 */
export type RecordOriginFilter = MemoryRecordOrigin | undefined;

/** True if the record matches the filter. `undefined` filter matches every record. */
export function recordMatchesOriginFilter(
	record: { createdBy?: MemoryRecordOrigin },
	filter: RecordOriginFilter,
): boolean {
	if (filter === undefined) return true;
	return sameOrigin(record.createdBy, filter);
}

/** Clamp to [0,1], falling back to `fallback` when not a finite number. */
export function clampImportance(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

export interface NewFact {
	content: string;
	segment: MemorySegment;
	importance?: number;
	tier?: MemoryTier;
	sourceTurn?: string;
	supersedes?: string[];
	metadata?: Record<string, unknown>;
	/**
	 * Stamped by the `write_memory` per-call gate (owner default; channel
	 * peer = their session origin). The store persists it verbatim onto
	 * the resulting record so the recall path can filter by it.
	 */
	createdBy?: MemoryRecordOrigin;
}

export interface ListFilter {
	segment?: MemorySegment;
	lifecycle?: MemoryLifecycle;
	/** Cap the number returned (most-recent-first). */
	limit?: number;
	/**
	 * Restrict to records matching this origin. Omit to return EVERY
	 * record regardless of origin (the maintenance default — used by
	 * decay GC, consolidation, doctor diagnostics). Tool-facing callers
	 * (`read_memory` / `recall_memory` / auto-recall) MUST pass an
	 * explicit filter so peer + operator state stay isolated.
	 */
	origin?: RecordOriginFilter;
}

/**
 * Append-only-ish JSONL fact store. "Mutations" (markAccessed / supersede /
 * setLifecycle / decay) are read-modify-write of the whole file — fine at
 * single-user scale, and atomic via tmp+rename so a crash never leaves a
 * half-written store.
 */
export class FactStore {
	private readonly file: string;

	constructor(workspaceDir: string) {
		this.file = path.join(workspaceDir, FACTS_RELATIVE_PATH);
	}

	/** Absolute path to the JSONL file (for diagnostics). */
	get filePath(): string {
		return this.file;
	}

	/** Read every record. Malformed lines are skipped (never throws on a bad line). */
	readAll(): MemoryRecord[] {
		// Convex mode — serve from the boot-hydrated per-workspace cache. An
		// unprimed workspace genuinely has no facts (boot hydrates every
		// config agent's workspace + main); prime the empty shape so later
		// writes diff against it.
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			const wsId = workspaceIdFromDir(path.dirname(path.dirname(this.file)));
			const cached = getCachedFacts(wsId);
			if (cached) return structuredClone(cached);
			primeFactsCache(wsId, []);
			return [];
		}

		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: MemoryRecord[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const rec = JSON.parse(trimmed) as MemoryRecord;
				if (rec && typeof rec.memoryId === "string" && typeof rec.content === "string") {
					out.push(rec);
				}
			} catch {
				// Skip a corrupt line rather than failing the whole read.
			}
		}
		return out;
	}

	/** Active records, optionally filtered, most-recent-first, capped by `limit`. */
	list(filter: ListFilter = {}): MemoryRecord[] {
		const lifecycle = filter.lifecycle ?? "active";
		let recs = this.readAll().filter((r) => r.lifecycle === lifecycle);
		if (filter.segment) recs = recs.filter((r) => r.segment === filter.segment);
		if (filter.origin !== undefined) {
			recs = recs.filter((r) => recordMatchesOriginFilter(r, filter.origin));
		}
		recs.sort((a, b) => b.createdAt - a.createdAt);
		return filter.limit && filter.limit > 0 ? recs.slice(0, filter.limit) : recs;
	}

	/**
	 * Persist a new fact. Derives tier/importance/decay from the segment
	 * defaults (writer may override tier/importance). Archives any `supersedes`
	 * targets. Returns the stored record.
	 */
	write(fact: NewFact): MemoryRecord {
		const defaults = SEGMENT_DEFAULTS[fact.segment] ?? SEGMENT_DEFAULTS.context;
		const now = Date.now();
		const record: MemoryRecord = {
			memoryId: makeMemoryId(),
			content: fact.content.trim().slice(0, MAX_FACT_CONTENT_CHARS),
			segment: fact.segment,
			tier: fact.tier ?? defaults.tier,
			importance: clampImportance(fact.importance, defaults.importance),
			decayRate: defaults.decayRate,
			accessCount: 0,
			lastAccessedAt: now,
			createdAt: now,
			sourceTurn: fact.sourceTurn,
			supersedes: fact.supersedes && fact.supersedes.length > 0 ? fact.supersedes : undefined,
			lifecycle: "active",
			...(fact.createdBy !== undefined ? { createdBy: fact.createdBy } : {}),
			metadata: fact.metadata,
		};

		const all = this.readAll();

		// Write-time dedup (no LLM). A near-identical ACTIVE fact already exists
		// (e.g. the model called write_memory AND the post-turn extraction sweep
		// distilled the same fact) → don't add a parallel copy. Instead reinforce
		// the existing one: keep the higher importance, refresh access, inherit a
		// sourceTurn if it lacked one. Skipped for explicit corrections/updates
		// (they carry `supersedes` and intentionally replace prior beliefs). This
		// is the cheap layer; semantic contradictions are handled by consolidation.
		//
		// Origin guard: dedup ONLY merges with records of the same origin. A
		// peer's "I prefer dark mode" must not merge into an owner's identical
		// note (which would lift the peer's fact to owner-visible) or into
		// another peer's identical note (which would cross-pollinate
		// session-scoped state). Different-origin facts stay separate even if
		// the text matches.
		if (!record.supersedes) {
			const incoming = tokenSet(record.content);
			const dup = all.find(
				(r) =>
					r.lifecycle === "active" &&
					sameOrigin(r.createdBy, record.createdBy) &&
					jaccard(incoming, tokenSet(r.content)) >= DEDUP_SIMILARITY,
			);
			if (dup) {
				dup.importance = Math.max(dup.importance, record.importance);
				dup.lastAccessedAt = now;
				dup.accessCount += 1;
				if (!dup.sourceTurn && record.sourceTurn) dup.sourceTurn = record.sourceTurn;
				this.writeAll(all);
				return dup;
			}
		}

		// Archive superseded records (corrections/updates overwrite prior beliefs).
		if (record.supersedes) {
			const dead = new Set(record.supersedes);
			for (const r of all) {
				if (dead.has(r.memoryId) && r.lifecycle === "active") r.lifecycle = "archived";
			}
		}
		all.push(record);
		this.writeAll(all);
		return record;
	}

	/**
	 * Lexical search over active facts. Scores by how many query tokens
	 * appear in the content (substring), tie-broken by importance then
	 * recency — a substring-fallback ranking. Marks every returned record
	 * accessed (recall reinforcement) unless `markAccessed: false`. Returns
	 * at most `limit` hits (default 8), each with its score.
	 */
	search(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		const tokens = query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 1);
		if (tokens.length === 0) return [];
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const scored: Array<MemoryRecord & { score: number }> = [];
		for (const r of this.readAll()) {
			if (r.lifecycle !== "active") continue;
			// Origin filter: peer + operator state are isolated by default.
			// `undefined` filter is the maintenance default (whole store) —
			// tool callers always pass an explicit filter.
			if (opts.origin !== undefined && !recordMatchesOriginFilter(r, opts.origin)) {
				continue;
			}
			const hay = r.content.toLowerCase();
			const matched = tokens.filter((t) => hay.includes(t)).length;
			if (matched === 0) continue;
			scored.push({ ...r, score: matched / tokens.length });
		}
		scored.sort(
			(a, b) => b.score - a.score || b.importance - a.importance || b.createdAt - a.createdAt,
		);
		const top = scored.slice(0, limit);
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/** Bump accessCount + lastAccessedAt for the given ids (recall reinforcement). */
	markAccessed(ids: string[]): void {
		if (ids.length === 0) return;
		const set = new Set(ids);
		const all = this.readAll();
		let changed = false;
		const now = Date.now();
		for (const r of all) {
			if (set.has(r.memoryId)) {
				r.accessCount += 1;
				r.lastAccessedAt = now;
				changed = true;
			}
		}
		if (changed) this.writeAll(all);
	}

	/** Set the lifecycle of specific records (used by decay GC). */
	setLifecycle(ids: string[], lifecycle: MemoryLifecycle): void {
		if (ids.length === 0) return;
		const set = new Set(ids);
		const all = this.readAll();
		let changed = false;
		for (const r of all) {
			if (set.has(r.memoryId) && r.lifecycle !== lifecycle) {
				r.lifecycle = lifecycle;
				changed = true;
			}
		}
		if (changed) this.writeAll(all);
	}

	/** Atomic whole-file rewrite (tmp + rename) so a crash can't corrupt the store. */
	private writeAll(records: MemoryRecord[]): void {
		// Convex mode — prime the cache (next readAll sees this write) and
		// enqueue per-record mutations realising the diff. All FactStore
		// mutators (write/markAccessed/setLifecycle/dedup-reinforce) funnel
		// through here, so this one branch covers every memory write path.
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			const wsId = workspaceIdFromDir(path.dirname(path.dirname(this.file)));
			writeThroughFactsCache(rctx.store, wsId, records);
			return;
		}

		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
		const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, this.file);
	}
}
