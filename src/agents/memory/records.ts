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

// Host seams (logger / convex cache / runtime-mode probe / write-time threat-scan)
// are routed through ONE swappable module — `./host-ports.js` — so the core has zero
// `../../` host imports and stays extractable. Brigade's host-ports forwards to the
// real modules (pure indirection, no behavior change); a standalone publish swaps it
// for an fs-only build. See host-ports.ts.
import {
	createSubsystemLogger,
	getCachedFacts,
	MemoryThreatError,
	primeFactsCache,
	scanForThreats,
	tryGetRuntimeContext,
	workspaceIdFromDir,
	writeThroughFactsCache,
} from "./host-ports.js";
import { bm25Score, type ScoreBreakdown, tokenize } from "./scoring.js";
import { evaluateWriteGate, isTrustedTarget, isUntrustedSource, WriteGateError } from "./write-gate.js";
import type { MemoryLink } from "./links.js";
import { MemoryEventLog, type MemoryEvent } from "./event-log.js";
import { cosine, getDefaultEmbedder } from "./embedder.js";
import { recallHybrid, recallHybridAsync } from "./hybrid.js";

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
 * Where a fact CAME FROM — distinct from `createdBy` (the principal/origin).
 * Drives the write-gate (Step 12): low-trust sources (`tool_output`,
 * `retrieved_document`, `compaction`) can't supersede owner-authored facts or
 * write procedural records. `undefined` ⇔ legacy / owner-authored (trusted).
 */
export type MemorySourceType =
	| "user_instruction"
	| "owner_message"
	| "channel_message"
	| "tool_output"
	| "retrieved_document"
	| "compaction"
	| "extraction"
	| "dream";

/** Runtime list of every {@link MemorySourceType} — for validating
 *  externally-loaded data (e.g. the real-data gold path, where a typo'd source
 *  would otherwise be silently treated as TRUSTED by the write-gate). The
 *  `satisfies` clause makes a typo/extra value a COMPILE error; keep in sync with
 *  the type above if a source is ever added. */
export const MEMORY_SOURCE_TYPES = [
	"user_instruction",
	"owner_message",
	"channel_message",
	"tool_output",
	"retrieved_document",
	"compaction",
	"extraction",
	"dream",
] as const satisfies readonly MemorySourceType[];

/**
 * Epistemic state of a fact — distinct from {@link MemoryLifecycle} (which is
 * STORAGE state: active/archived/pruned). Dormant in v1 (the field persists but
 * nothing sets/reads it); Phase-2 cognition (trust, contradiction) drives it.
 */
export type MemoryStatus = "asserted" | "provisional" | "confirmed" | "disputed" | "retracted";

/** Modality of a fact's underlying content (Step 17 cold-pointer). The stored
 *  `content` is ALWAYS text (a transcript/caption) so recall is uniform; the
 *  media itself lives at `mediaPointer`. `undefined` ⇒ text. */
export type MemoryModality = "text" | "audio" | "image" | "video" | "document";

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
	/** Where this fact came from (see {@link MemorySourceType}) — drives the
	 *  write-gate. `undefined` ⇔ legacy / owner-authored (trusted). */
	sourceType?: MemorySourceType;
	/** Typed edges to other facts (the graph substrate, Step 7). `supersedes[]`
	 *  is mirrored at READ time by `linksFrom` — not stored here. */
	links?: MemoryLink[];
	/** Bi-temporal VALID-time interval (Step 7 cognition) — when the fact is true
	 *  in the world, distinct from `createdAt` (transaction time it was recorded).
	 *  Phase-2 contradiction handling closes `validTo` on a bi-temporal supersede.
	 *  Dormant in v1. */
	validFrom?: number;
	validTo?: number;
	/** Confidence in the fact, [0, 1]. Phase-2 trust folds this into ranking. Dormant in v1. */
	confidence?: number;
	/** Epistemic state (distinct from `lifecycle`, the storage state). Dormant in v1. */
	status?: MemoryStatus;
	/** Ids of the source material this fact was derived from (message ids, doc
	 *  ids, parent memoryIds). Phase-3 `purge` cascades along these. Dormant in v1. */
	sourcePointers?: string[];
	/** Dense vector for the HYBRID recall lane — populated on write in BOTH modes
	 *  (convex ANN-indexes it via `by_embedding`; fs cosine-scans it in-app). */
	embedding?: number[];
	/** Modality of the underlying content (Step 17 cold-pointer). `undefined` ⇒ text. */
	modality?: MemoryModality;
	/** Path/URI to the source media this fact was distilled from — the "cold
	 *  pointer" that keeps media OUT of the hot text index. */
	mediaPointer?: string;
	/** Optional JSON sidecar, e.g. {"corrects":"the prior belief"}. */
	metadata?: Record<string, unknown>;
	/** Single-valued ATTRIBUTE SLOT this fact sets (normalized snake_case, e.g.
	 *  `deploy_day`, `home_city`, `ui_theme`). When present, writing a NEW fact with
	 *  the SAME subjectKey + SAME origin auto-supersedes this one (the prior value is
	 *  archived, bi-temporally closed, and `contradicts`-linked) — so a correction
	 *  replaces the stale belief instead of piling up beside it. Omit for ADDITIVE
	 *  facts (pets, skills) that should coexist. Segment-independent by design. */
	subjectKey?: string;
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

const driftLog = createSubsystemLogger("memory/records");

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

/**
 * Idempotency bars for "is this extracted fact ALREADY known?" — looser than the
 * write-time {@link DEDUP_SIMILARITY} because post-turn extraction REWORDS a fact
 * the operator already taught (a paraphrase scores well below 0.85 on both lanes:
 * measured ≈0.4–0.64 cosine / ≈0.2–0.6 Jaccard for real restatements). These bars
 * apply ONLY when the existing candidate is SUBJECT-BEARING — the single-valued
 * facts (`diet`, `ui_theme`, …) extraction must not churn a subject-less twin
 * beside — so the looseness can't suppress an ADDITIVE fact (pets, skills: no
 * subjectKey ⇒ they fall back to the strict {@link DEDUP_SIMILARITY} near-exact
 * bar). Empirically these cleanly separate real restatements from distinct facts.
 */
export const IDEMPOTENT_COSINE_BAR = 0.45;
export const IDEMPOTENT_JACCARD_BAR = 0.4;

/** CONTENT-token SET of a fact (for dedup + slot-restate detection). Uses the
 *  SAME stopword-stripping tokenizer as recall (scoring.ts `tokenize`) so similarity
 *  is measured on MEANINGFUL tokens, not sentence scaffolding — a shared frame like
 *  "the user prefers to use the …" must not inflate overlap (it was inflating it to
 *  the point of wrongly superseding unrelated facts). One tokenizer, one basis. */
function tokenSet(content: string): Set<string> {
	return new Set(tokenize(content));
}

/** Normalize an attribute SLOT key: lowercase, non-alphanumeric runs → "_",
 *  trimmed of edge underscores. So "Deploy Day" / "deploy-day" / "deploy_day"
 *  all collapse to one slot, maximizing supersede matches across phrasings. */
function normalizeSubjectKey(raw: string): string {
	// Unicode-aware (lockstep with scoring.ts tokenize + embedder features): a
	// non-Latin attribute name (e.g. a CJK/Cyrillic slot) keeps its characters
	// instead of collapsing to empty, so same-slot supersede works across scripts.
	return raw
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/^_+|_+$/g, "");
}

/** Jaccard similarity |A∩B| / |A∪B| of two token sets (0 when both empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter += 1;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}

/** Token-set Jaccard over two raw contents (the dedup/idempotency basis — same
 *  tokenizer as recall). Exposed so the extraction-idempotency check (extract.ts)
 *  measures "already-known" with the IDENTICAL near-duplicate basis the write-time
 *  dedup uses, instead of re-deriving a divergent one. */
export function contentSimilarity(a: string, b: string): number {
	return jaccard(tokenSet(a), tokenSet(b));
}

/**
 * Segment SPECIFICITY rank — higher = more specific / more authoritative about
 * the operator's self-model. Drives "richest wins" so a reworded, subject-less
 * `knowledge` copy emitted by post-turn extraction can never out-rank the
 * `identity`/`preference`/`correction` original the operator actually taught.
 * The authoritative self-model segments (the write-gate's PROTECTED set) sit at
 * the top; descriptive/situational segments below; generic `knowledge` (the
 * confinement target extraction lands in) is the floor with `context`.
 */
const SEGMENT_SPECIFICITY: Record<MemorySegment, number> = {
	identity: 5,
	correction: 5,
	preference: 5,
	relationship: 3,
	project: 3,
	context: 1,
	knowledge: 1,
};

/** The fields that make one record "richer" than a near-identical twin, in
 *  precedence order. A higher tuple wins; ties fall through to the next field.
 *  Recency is INTENTIONALLY NOT here — a fresher restatement must not beat a
 *  metadata-bearing original (the bug this fixes). The caller breaks a true
 *  all-equal tie by recency for stability. */
function richnessTuple(r: MemoryRecord): [number, number, number, number, number] {
	return [
		r.subjectKey ? 1 : 0, // a subject-bearing fact anchors a vault hub — keep it
		SEGMENT_SPECIFICITY[r.segment] ?? 0, // identity/preference/correction beat knowledge
		typeof r.confidence === "number" ? r.confidence : 0, // more-confident wins
		r.importance, // then importance
		r.accessCount, // then confirmations (recall reinforcement / reasserts)
	];
}

/**
 * Compare two records by metadata RICHNESS (NOT recency). Returns >0 when `a` is
 * richer, <0 when `b` is, 0 when equal on every richness field. This is the
 * survivor-selection ordering for every dedup / supersede / consolidation merge:
 * the SURVIVING record must be the richest one, so a subject-less reworded copy
 * never archives a subject-bearing `identity`/`preference` original.
 */
export function compareRichness(a: MemoryRecord, b: MemoryRecord): number {
	const ta = richnessTuple(a);
	const tb = richnessTuple(b);
	for (let i = 0; i < ta.length; i++) {
		if (ta[i]! !== tb[i]!) return ta[i]! - tb[i]!;
	}
	return 0;
}

/**
 * Of two near-identical records, the one that should SURVIVE a merge: the richer
 * by {@link compareRichness}; an exact richness tie breaks to the NEWER record
 * (a genuine restatement refreshes the belief). Pure — picks, never mutates.
 */
export function richerSurvivor(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
	const byRichness = compareRichness(a, b);
	if (byRichness !== 0) return byRichness > 0 ? a : b;
	return a.createdAt >= b.createdAt ? a : b;
}

/**
 * Fold the RICHER metadata of `loser` into `survivor`, in place — so collapsing a
 * near-duplicate pair never DROPS hard-won metadata even when the survivor was the
 * sparser record. Each field takes the more-informative value across BOTH records:
 * a present `subjectKey` is never lost to none; the more-specific segment is kept;
 * importance / confidence / accessCount take the max; `sourceTurn` / `validFrom`
 * backfill if missing; links union (deduped). Provenance (`sourceType`, `createdBy`)
 * is NOT merged — those are identity/trust, not richness, and the survivor keeps its
 * own. Returns `survivor` for chaining. Mutates `survivor` only.
 */
export function inheritRicherMetadata(survivor: MemoryRecord, loser: MemoryRecord): MemoryRecord {
	// subjectKey — a subject anchor must never be lost to none (the vault-hub key).
	if (!survivor.subjectKey && loser.subjectKey) survivor.subjectKey = loser.subjectKey;
	// segment — keep the more-specific of the two (identity/preference beat knowledge).
	if ((SEGMENT_SPECIFICITY[loser.segment] ?? 0) > (SEGMENT_SPECIFICITY[survivor.segment] ?? 0)) {
		survivor.segment = loser.segment;
		// Re-base the segment-derived durability so a promoted segment isn't left with
		// the weaker tier/decay of the segment it replaced (importance is maxed below).
		const d = SEGMENT_DEFAULTS[survivor.segment] ?? SEGMENT_DEFAULTS.context;
		survivor.tier = d.tier;
		survivor.decayRate = d.decayRate;
	}
	survivor.importance = Math.max(survivor.importance, loser.importance);
	if (typeof loser.confidence === "number") {
		survivor.confidence = Math.max(survivor.confidence ?? 0, loser.confidence);
	}
	survivor.accessCount = Math.max(survivor.accessCount, loser.accessCount);
	if (!survivor.sourceTurn && loser.sourceTurn) survivor.sourceTurn = loser.sourceTurn;
	if (survivor.validFrom === undefined && loser.validFrom !== undefined) survivor.validFrom = loser.validFrom;
	// Links union, deduped by kind|target (don't carry an edge that points at the
	// survivor itself — a self-loop from a mirrored supersede).
	if (loser.links && loser.links.length > 0) {
		const seen = new Set((survivor.links ?? []).map((l) => `${l.kind}|${l.target}`));
		const merged = [...(survivor.links ?? [])];
		for (const l of loser.links) {
			const key = `${l.kind}|${l.target}`;
			if (l.target === survivor.memoryId || seen.has(key)) continue;
			seen.add(key);
			merged.push(l);
		}
		if (merged.length > 0) survivor.links = merged;
	}
	return survivor;
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

/** Origin-isolation bucket key. Owner (and legacy/undefined-origin) facts share
 *  one bucket; each channel peer (channelId+conversationId+sessionKey) is its
 *  OWN bucket — so any cross-fact operation (consolidation, dream merges) can
 *  group by this and never mix origins. The canonical key; consolidate.ts +
 *  dream.ts + FactStore.distinctOrigins all route through it. */
export function originBucketKey(r: Pick<MemoryRecord, "createdBy">): string {
	const o = resolveRecordOrigin(r.createdBy);
	if (o.kind !== "channel") return "owner";
	// JSON-encode the tuple so a ':' INSIDE a component (a WhatsApp JID conversationId,
	// the ':'-structured sessionKey) can't shift the delimiter and collide two DISTINCT
	// origins into ONE bucket (a cross-principal merge in dream/consolidate). accountId
	// is in the key so two operator accounts of the same channel stay distinct origins.
	return `channel:${JSON.stringify([o.channelId ?? "", o.accountId ?? "", o.conversationId ?? "", o.sessionKey ?? ""])}`;
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
		(channelA.accountId ?? "") === (channelB.accountId ?? "") &&
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
	/** Source type for the write-gate (owner_message, tool_output, …). Omit ⇒
	 *  owner-authored/trusted. */
	sourceType?: MemorySourceType;
	/** Typed edges to other facts (the graph substrate, Step 7). */
	links?: MemoryLink[];
	/** Cognition fields (Step 7) — bi-temporal valid interval, confidence,
	 *  epistemic status, and source pointers. All dormant in v1 (persisted for
	 *  Phase-2 use); omit them and the record behaves exactly as before. */
	validFrom?: number;
	validTo?: number;
	confidence?: number;
	status?: MemoryStatus;
	sourcePointers?: string[];
	/** Cold-pointer multimodal (Step 17): `content` = the transcript/caption text. */
	modality?: MemoryModality;
	mediaPointer?: string;
	/** Single-valued attribute slot (e.g. `deploy_day`) — a new value for the same
	 *  slot + origin auto-supersedes the prior one. Omit for additive facts. */
	subjectKey?: string;
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
	/** Injectable wall-clock. Defaults to `Date.now`; the eval pins it (e.g. `() => 0`)
	 *  so write-time `createdAt` AND score-time `now` share ONE deterministic clock —
	 *  otherwise decay over the (load-dependent) gap between seeding and recall makes
	 *  the hybrid/decay lanes non-reproducible. Production passes nothing → `Date.now`. */
	private readonly clock: () => number;

	private eventLogCache?: MemoryEventLog;

	/** Did the most recent readAll SKIP any non-empty line (unparseable JSON or an
	 *  invalid record shape)? Such content — a hand-edit, a torn/concurrent write, a
	 *  partial sync — would be silently DROPPED by the next writeAll (which rewrites
	 *  only the parsed records). When set, writeAll snapshots the file to a `.bak`
	 *  first so the skipped content stays recoverable. */
	private lastReadHadUnparseable = false;

	constructor(workspaceDir: string, opts: { now?: () => number } = {}) {
		this.file = path.join(workspaceDir, FACTS_RELATIVE_PATH);
		this.clock = opts.now ?? (() => Date.now());
	}

	/** Absolute path to the JSONL file (for diagnostics). */
	get filePath(): string {
		return this.file;
	}

	/** The append-only event log (sibling `events.jsonl` of the facts file). */
	private eventLog(): MemoryEventLog {
		if (!this.eventLogCache) {
			this.eventLogCache = new MemoryEventLog(path.join(path.dirname(this.file), "events.jsonl"));
		}
		return this.eventLogCache;
	}

	/** Emit a provenance event. Filesystem mode appends to `events.jsonl`; convex mode
	 *  appends to the convex audit trail via the OPTIONAL `appendMemoryEvent` store hook
	 *  (best-effort + fire-and-forget — an audit-log write must never fail a memory
	 *  write, and the log is additive, never affecting recall). When the hook is absent
	 *  (a backend without the convex events table yet) it degrades to no audit trail. */
	private emit(event: MemoryEvent): void {
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			const append = rctx.store.memory.appendMemoryEvent;
			if (append) {
				const wsId = workspaceIdFromDir(path.dirname(path.dirname(this.file)));
				void append.call(rctx.store.memory, wsId, event as unknown as Record<string, unknown>).catch(() => {});
			}
			return;
		}
		this.eventLog().append(event);
	}

	/** The append-only provenance history. SYNC — filesystem only (convex reads are
	 *  async; use {@link readEventsAsync}). Empty in convex mode. Ordered oldest-first. */
	readEvents(): MemoryEvent[] {
		if (tryGetRuntimeContext()?.mode === "convex") return [];
		return this.eventLog().readAll();
	}

	/** The append-only provenance history, working in BOTH modes — fs reads
	 *  `events.jsonl`; convex reads the audit trail via the optional `listMemoryEvents`
	 *  store hook (empty when the hook is absent). Ordered oldest-first. */
	async readEventsAsync(): Promise<MemoryEvent[]> {
		const rctx = tryGetRuntimeContext();
		if (rctx?.mode === "convex") {
			const list = rctx.store.memory.listMemoryEvents;
			if (!list) return [];
			const wsId = workspaceIdFromDir(path.dirname(path.dirname(this.file)));
			return (await list.call(rctx.store.memory, wsId)) as unknown as MemoryEvent[];
		}
		return this.eventLog().readAll();
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
			// MISS SELF-HEAL: a workspace that wasn't boot-hydrated (a key mismatch, an
			// agent added AFTER boot, or a hydration race) would otherwise read EMPTY
			// forever. Prime [] for this synchronous read, but kick off a one-shot backfill
			// so the NEXT read serves the real rows instead of permanent amnesia. Guarded
			// (a fake store may omit the method). Best-effort.
			primeFactsCache(wsId, []);
			if (typeof rctx.store.memory.listAllFactRecordsRaw === "function") {
				void rctx.store.memory
					.listAllFactRecordsRaw(wsId)
					.then((records) => {
						if (records.length === 0) return;
						// MERGE, don't clobber: a write that landed DURING the fetch must not be
						// lost (priming the fetched rows over it would drop it), and the
						// pre-existing rows must not be lost either. Backfilled rows fill the
						// cache; any locally-written row WINS on memoryId conflict.
						const byId = new Map((records as unknown as MemoryRecord[]).map((r) => [r.memoryId, r]));
						for (const local of getCachedFacts(wsId) ?? []) byId.set(local.memoryId, local);
						primeFactsCache(wsId, [...byId.values()]);
					})
					.catch(() => {});
			}
			return [];
		}

		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: MemoryRecord[] = [];
		let nonEmpty = 0;
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			nonEmpty++;
			try {
				const rec = JSON.parse(trimmed) as MemoryRecord;
				if (rec && typeof rec.memoryId === "string" && typeof rec.content === "string") {
					out.push(rec);
				}
			} catch {
				// Skip a corrupt line rather than failing the whole read.
			}
		}
		// Flag for the drift guard: any non-empty line we couldn't turn into a record
		// is content the next writeAll would silently drop — snapshot before that.
		this.lastReadHadUnparseable = nonEmpty > out.length;
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
		const now = this.clock();
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
			...(fact.sourceType !== undefined ? { sourceType: fact.sourceType } : {}),
			...(fact.links !== undefined && fact.links.length > 0 ? { links: fact.links } : {}),
			...(fact.validFrom !== undefined ? { validFrom: fact.validFrom } : {}),
			...(fact.validTo !== undefined ? { validTo: fact.validTo } : {}),
			...(fact.confidence !== undefined ? { confidence: fact.confidence } : {}),
			...(fact.status !== undefined ? { status: fact.status } : {}),
			...(fact.sourcePointers !== undefined && fact.sourcePointers.length > 0
				? { sourcePointers: fact.sourcePointers }
				: {}),
			...(fact.modality !== undefined ? { modality: fact.modality } : {}),
			...(fact.mediaPointer !== undefined ? { mediaPointer: fact.mediaPointer } : {}),
			...(fact.subjectKey && fact.subjectKey.trim() ? { subjectKey: normalizeSubjectKey(fact.subjectKey) } : {}),
			metadata: fact.metadata,
		};

		const all = this.readAll();

		// Write-gate (Tideline Step 12) — an UNTRUSTED source (tool_output /
		// retrieved_document) must not poison the authoritative store: it can't
		// author an identity/preference/correction fact, nor supersede an
		// owner-authored one. Dormant for trusted/legacy writes (sourceType
		// undefined). Evaluated BEFORE any mutation so a blocked write is a
		// clean no-op (throws WriteGateError; the caller surfaces it).
		if (isUntrustedSource(record.sourceType)) {
			const supersedeIds = new Set(record.supersedes ?? []);
			const verdict = evaluateWriteGate({
				sourceType: record.sourceType,
				segment: record.segment,
				supersedeTargets: all
					// Match the origin-gated archive loop below (~line 791): a cross-origin
					// supersede silently no-ops there, so the gate must NOT hard-block on it —
					// only same-origin targets are real supersede candidates to evaluate.
					.filter((r) => supersedeIds.has(r.memoryId) && sameOrigin(r.createdBy, record.createdBy))
					.map((r) => ({ memoryId: r.memoryId, sourceType: r.sourceType })),
			});
			if (!verdict.allow) {
				this.emit({
					at: now,
					kind: "blocked",
					memoryId: record.memoryId,
					segment: record.segment,
					...(record.sourceType !== undefined ? { sourceType: record.sourceType } : {}),
					reason: verdict.reason,
				});
				throw new WriteGateError(verdict.reason);
			}

			// CONTENT threat-scan — the write-gate above confines WHICH segment an
			// untrusted source may author (provenance); this confines WHAT the text
			// SAYS. An untrusted source may legitimately write `knowledge`, so an
			// injection/exfil/C2 payload ("ignore prior instructions…", a beacon, an
			// exfil curl) can ride a permitted write — block it at the source so it
			// never persists. Owner/model-authored writes are NOT content-blocked here
			// (the owner is trusted; the recall-time scan is the net for owner-pasted
			// attacker text). Evaluated pre-mutation → a blocked write is a clean no-op.
			const threats = scanForThreats(record.content, "strict");
			if (threats.length > 0) {
				this.emit({
					at: now,
					kind: "blocked",
					memoryId: record.memoryId,
					segment: record.segment,
					...(record.sourceType !== undefined ? { sourceType: record.sourceType } : {}),
					reason: `content matched threat pattern(s): ${threats.join(", ")}`,
				});
				throw new MemoryThreatError(threats);
			}
		}

		// SUPERSEDE the prior belief(s) this write replaces — WITHOUT relying on the
		// model recalling ids. Trigger: an explicit attribute SLOT (subjectKey) →
		// supersede same-slot, same-origin values (precise; segment-independent — a
		// `correction` supersedes a `preference`). Soft-archive (bi-temporal close +
		// `contradicts`/`transition` link), history kept. A near-identical prior
		// (restated, not changed) is reinforced, not churned. An UNTRUSTED source can't
		// archive a TRUSTED prior (the write-gate override guard).
		//
		// We deliberately do NOT auto-supersede by CONTENT overlap: a slot-less
		// `correction` shares a sentence frame with unrelated facts, and (MEASURED) no
		// overlap threshold separates a same-subject value change ("deploys Fridays"→
		// "Mondays", ≈0.5) from a DIFFERENT-subject one ("dark theme editor"→"light
		// theme terminal", ≈0.5) — they fully overlap, so the old content gate silently
		// archived still-true facts (data loss). A slot-less correction now COEXISTS
		// with the prior (freshest wins at recall; dream consolidates near-duplicates);
		// to auto-replace a single-valued attribute, the writer sets a `subjectKey`.
		const slotSuperseded: string[] = [];
		if (record.subjectKey && !record.supersedes) {
			const incoming = tokenSet(record.content);
			const priors = all.filter(
				(r) =>
					r.lifecycle === "active" &&
					r.memoryId !== record.memoryId &&
					sameOrigin(r.createdBy, record.createdBy) &&
					r.subjectKey === record.subjectKey,
			);
			// Same write-gate guard as the archive loop + dedup below: an
			// UNTRUSTED source must not reinforce (bump importance / refresh
			// access on) a TRUSTED, owner-authored prior through this restate
			// back door — that's an unsuperseded mutation the write-gate never
			// sees. When incoming is untrusted and the match is trusted, it
			// falls through to a separate record, leaving the owner fact as-is.
			const restated = priors.find(
				(r) =>
					jaccard(incoming, tokenSet(r.content)) >= DEDUP_SIMILARITY &&
					!(isUntrustedSource(record.sourceType) && isTrustedTarget(r.sourceType)),
			);
			if (restated) {
				// Inherit the RICHER metadata of the incoming restatement so a reinforce
				// never DROPS hard-won metadata (a more-specific segment, a higher
				// confidence, links). subjectKey already matches by construction; the
				// accessCount bump below is the reinforcement signal.
				inheritRicherMetadata(restated, record);
				restated.lastAccessedAt = now;
				restated.accessCount += 1;
				if (!restated.sourceTurn && record.sourceTurn) restated.sourceTurn = record.sourceTurn;
				this.writeAll(all);
				this.emit({ at: now, kind: "reinforced", memoryId: restated.memoryId, segment: restated.segment });
				return restated;
			}
			for (const r of priors) {
				if (isUntrustedSource(record.sourceType) && isTrustedTarget(r.sourceType)) continue;
				r.lifecycle = "archived";
				r.validTo = now;
				slotSuperseded.push(r.memoryId);
			}
			if (slotSuperseded.length > 0) {
				// `contradicts` flags the conflict for consolidation; `transition`
				// records the temporal evolution (Step 19) so the graph walk + the
				// dream can trace what this belief BECAME and count repeated changes.
				record.links = [
					...(record.links ?? []),
					...slotSuperseded.flatMap((target) => [
						{ kind: "contradicts" as const, target },
						{ kind: "transition" as const, target },
					]),
				];
			}
		}

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
		if (!record.supersedes && !record.subjectKey) {
			const incoming = tokenSet(record.content);
			const dup = all.find(
				(r) =>
					r.lifecycle === "active" &&
					sameOrigin(r.createdBy, record.createdBy) &&
					jaccard(incoming, tokenSet(r.content)) >= DEDUP_SIMILARITY &&
					// Write-gate blind-spot guard: dedup-merge reinforces the matched
					// fact (bumps importance + refreshes access). An UNTRUSTED source
					// (tool_output / retrieved_document / compaction) must not be able to
					// reinforce a TRUSTED, owner-authored fact through this back door —
					// that is an unsuperseded mutation the write-gate never sees. When the
					// incoming write is untrusted and the match is owner-authored/trusted,
					// skip the merge: the untrusted write falls through to a separate
					// record (subject to the gate's segment rule), leaving the owner fact
					// exactly as the operator left it.
					!(isUntrustedSource(record.sourceType) && isTrustedTarget(r.sourceType)),
			);
			if (dup) {
				// Inherit the RICHER metadata of the incoming copy into the surviving
				// `dup` so a reinforce never DROPS metadata. The incoming carries no
				// subjectKey here (a subject-bearing write takes the slot path above),
				// but it MAY be a more-specific segment / higher confidence — keep the
				// richer of each. `dup` keeps its stable id + accessCount history; the
				// bump below is the reinforcement signal.
				inheritRicherMetadata(dup, record);
				dup.lastAccessedAt = now;
				dup.accessCount += 1;
				if (!dup.sourceTurn && record.sourceTurn) dup.sourceTurn = record.sourceTurn;
				this.writeAll(all);
				this.emit({ at: now, kind: "reinforced", memoryId: dup.memoryId, segment: dup.segment });
				return dup;
			}
		}

		// Embed-on-write (HYBRID recall vector lane, BOTH modes) — store a vector
		// for the vector lane. fs mode cosine-scans it in-app; convex mode ALSO
		// ANN-serves it via the built-in `by_embedding` vectorIndex at scale.
		// Embedding both modes keeps recall IDENTICAL across them (cross-mode
		// parity). Runs AFTER the write-gate AND after the dedup early-return so a
		// blocked (poisoned) OR deduped-away write pays no embedding cost; GUARDED
		// so a custom/learned embedder that throws degrades to no-vector (graceful
		// BM25-only recall for this fact) rather than failing the write. The bundled
		// embedder is synchronous + can't throw; an async model uses the async write
		// path (future).
		try {
			const emb = getDefaultEmbedder();
			const v = emb.embed([record.content]);
			// Exact-width gate (not just truthy): a misconfigured learned embedder
			// emitting a wrong-width vector would otherwise reach the convex by_embedding
			// (fixed-dim) insert and THROW, losing the write. Drop the bad vector → the
			// fact persists and recalls via BM25.
			if (!(v instanceof Promise) && Array.isArray(v[0]) && v[0].length === emb.dims) {
				record.embedding = v[0];
			}
		} catch {
			/* embedder failure → no vector; this fact recalls via BM25 only */
		}

		// Archive superseded records (corrections/updates overwrite prior beliefs).
		// ORIGIN GUARD: a principal may only supersede ITS OWN facts. Without this, a
		// channel peer's write_memory({supersedes:[ownerFactId]}) would archive the
		// OWNER's fact (cross-origin data loss + recall blackout) — the write-gate's
		// supersede rule doesn't catch it because a peer tool write carries no sourceType.
		// Mirrors the sameOrigin guard the subjectKey + dedup paths already enforce;
		// a cross-origin supersede id is silently ignored.
		if (record.supersedes) {
			const dead = new Set(record.supersedes);
			for (const r of all) {
				if (dead.has(r.memoryId) && r.lifecycle === "active" && sameOrigin(r.createdBy, record.createdBy)) {
					r.lifecycle = "archived";
					// Bi-temporal close — match the auto-supersede path: a superseded belief
					// stopped being valid NOW, so the history records WHEN.
					r.validTo = now;
				}
			}
		}
		all.push(record);
		this.writeAll(all);
		this.emit({
			at: now,
			kind: "created",
			memoryId: record.memoryId,
			segment: record.segment,
			...(record.sourceType !== undefined ? { sourceType: record.sourceType } : {}),
			...((record.supersedes?.length ?? 0) + slotSuperseded.length > 0
				? { targets: [...(record.supersedes ?? []), ...slotSuperseded] }
				: {}),
		});
		return record;
	}

	/**
	 * Extraction-idempotency probe (Fix 1). Given a candidate fact's content +
	 * origin, return an ALREADY-STORED active same-origin record that the
	 * candidate is merely a RESTATEMENT of — or `undefined` if it's genuinely new.
	 * The post-turn distiller calls this BEFORE writing so it never re-creates a
	 * fact the operator already taught (which would pile a subject-less `knowledge`
	 * churn copy beside a rich `identity`/`preference` original and then let
	 * consolidation archive the wrong one).
	 *
	 * Two match lanes (a candidate that hits EITHER is "already known"):
	 *   1. SUBJECT-ANCHORED restatement — the existing record is SUBJECT-BEARING
	 *      (the single-valued kind extraction must not churn a twin beside) and the
	 *      candidate is a paraphrase of it: embedding cosine ≥ {@link IDEMPOTENT_COSINE_BAR}
	 *      OR content Jaccard ≥ {@link IDEMPOTENT_JACCARD_BAR}. The loose bar is safe
	 *      here BECAUSE it's gated on an existing subjectKey — an ADDITIVE fact (no
	 *      subjectKey: pets, skills) can't trip it.
	 *   2. NEAR-EXACT restatement of ANY existing fact — content Jaccard ≥
	 *      {@link DEDUP_SIMILARITY} (the write-time dedup bar), so even an additive
	 *      fact's verbatim re-extraction is recognised.
	 *
	 * Origin-isolated (only same-origin candidates) and embedder-guarded (a thrown/
	 * async embedder degrades to the Jaccard lanes). The richest of several matches
	 * is returned so a reinforcement lands on the best record.
	 */
	findEquivalentActive(
		content: string,
		origin: MemoryRecordOrigin | undefined,
	): MemoryRecord | undefined {
		const text = content.trim();
		if (!text) return undefined;
		const candidates = this.readAll().filter(
			(r) => r.lifecycle === "active" && sameOrigin(r.createdBy, origin),
		);
		if (candidates.length === 0) return undefined;
		const incomingTokens = tokenSet(text);
		// Embed the candidate once for the cosine lane (best-effort; the bundled
		// embedder is sync + can't throw, a learned/async one degrades to Jaccard).
		let incomingVec: number[] | undefined;
		try {
			const emb = getDefaultEmbedder();
			const v = emb.embed([text]);
			if (!(v instanceof Promise) && Array.isArray(v[0]) && v[0].length === emb.dims) incomingVec = v[0];
		} catch {
			/* no vector → Jaccard-only matching */
		}
		const matches: MemoryRecord[] = [];
		for (const r of candidates) {
			const jac = jaccard(incomingTokens, tokenSet(r.content));
			if (jac >= DEDUP_SIMILARITY) {
				matches.push(r);
				continue;
			}
			if (r.subjectKey) {
				const cos =
					incomingVec && r.embedding && r.embedding.length === incomingVec.length
						? cosine(incomingVec, r.embedding)
						: 0;
				if (cos >= IDEMPOTENT_COSINE_BAR || jac >= IDEMPOTENT_JACCARD_BAR) matches.push(r);
			}
		}
		if (matches.length === 0) return undefined;
		// The richest match takes the reinforcement (so an `identity`+subjectKey
		// original wins over a sparser twin if both somehow matched).
		return matches.reduce((best, r) => (compareRichness(r, best) > 0 ? r : best));
	}

	/**
	 * Reinforce an existing record by id WITHOUT writing a new one (the
	 * idempotency no-op's "optionally reinforce" path). Bumps access (recall-
	 * reinforcement) and lifts confidence toward `minConfidence` if given — so a
	 * re-seen fact gets MORE durable rather than spawning a churn duplicate. No-op
	 * (undefined) if the id isn't an active record. Emits a `reinforced` event.
	 */
	reinforce(memoryId: string, opts: { minConfidence?: number } = {}): MemoryRecord | undefined {
		const all = this.readAll();
		const rec = all.find((r) => r.memoryId === memoryId);
		if (!rec || rec.lifecycle !== "active") return undefined;
		const now = this.clock();
		rec.accessCount += 1;
		rec.lastAccessedAt = now;
		if (typeof opts.minConfidence === "number") {
			rec.confidence = Math.max(rec.confidence ?? 0, Math.min(1, Math.max(0, opts.minConfidence)));
		}
		this.writeAll(all);
		this.emit({ at: now, kind: "reinforced", memoryId, segment: rec.segment });
		return rec;
	}

	/**
	 * Lexical recall over active facts — Okapi BM25 × `effectiveScore`
	 * (decay + importance), origin-filtered (the shared scorer, scoring.ts).
	 * The SAME scorer runs in fs (these `readAll` records) and convex mode
	 * (the hydrated cache) ⇒ cross-mode parity by construction. Marks every
	 * returned record accessed (recall reinforcement) unless `markAccessed:
	 * false`. Returns at most `limit` hits (default 8), each with its score.
	 */
	search(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		// Active + origin-matching candidates. Isolation is enforced HERE (never
		// inside the scorer): the origin filter is mandatory on every tool-facing
		// recall. `undefined` origin = the maintenance default (whole store) —
		// tool callers always pass an explicit filter.
		const now = this.clock();
		// Active + origin + still-valid (bi-temporal valid-time): a fact whose
		// `validTo` has passed is excluded from recall independent of lifecycle, so
		// a future-dated expiry written ahead of time stops surfacing on its own.
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) &&
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		// BM25 × effectiveScore (the shared v1 scorer). Identical code in fs +
		// convex (over readAll / the hydrated cache) ⇒ cross-mode parity by
		// construction. Replaces the old substring term-overlap.
		const top = bm25Score(candidates, query, now)
			.slice(0, limit)
			.map((s) => ({ ...s.record, score: s.score }));
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/**
	 * Hybrid recall (Tideline v2) — BM25 ⊕ vector (cosine over each record's
	 * `embedding`), fused via `recallHybrid`. Embeddings are populated on write in
	 * BOTH modes (see embed-on-write in `write`), so the vector lane contributes
	 * IDENTICALLY in fs and convex mode — that's the cross-mode-parity guarantee.
	 * Convex additionally ANN-serves the SAME vectors via the built-in
	 * `by_embedding` vectorIndex at scale; this in-app cosine is the identical
	 * ranking over the hydrated cache. A record misses the vector lane only if its
	 * embedder threw on write (graceful BM25-only for that fact) or it predates
	 * embed-on-write (legacy). Same active+origin candidate filter + reinforcement
	 * semantics as `search`.
	 */
	searchHybrid(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const now = this.clock();
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) && // bi-temporal valid-time gate (see search)
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		const top = recallHybrid(candidates, query, getDefaultEmbedder(), now, { limit }).map((f) => ({
			...f.record,
			score: f.score,
		}));
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/**
	 * The recall entry point live callers (auto-recall, recall_memory) use →
	 * the HYBRID lane (BM25 ⊕ vector, {@link searchHybrid}) in BOTH modes, so
	 * recall is identical fs ↔ convex (parity by construction, same as v1). The
	 * lower-level `search` stays a pure-lexical primitive for callers that want
	 * just BM25 (the eval floor, transparency).
	 */
	recall(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number }> {
		return this.searchHybrid(query, opts);
	}

	/**
	 * ASYNC hybrid recall — identical to {@link searchHybrid} but pre-embeds the
	 * query via {@link recallHybridAsync}, so it works with a LEARNED (async)
	 * embedder (OpenAI / local node-llama-cpp) as well as the sync HRR default
	 * (awaiting a sync embed is a no-op). This is the path that delivers true-
	 * synonymy recall when a learned embedder is selected; the sync `searchHybrid`/
	 * `recall` stay for callers that aren't async (and degrade to BM25-primary
	 * under a learned embedder — never crash). Same candidate filter + reinforcement.
	 */
	async searchHybridAsync(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Promise<Array<MemoryRecord & { score: number }>> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const now = this.clock();
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) &&
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		const top = (await recallHybridAsync(candidates, query, getDefaultEmbedder(), now, { limit })).map((f) => ({
			...f.record,
			score: f.score,
		}));
		if (opts.markAccessed !== false && top.length > 0) {
			this.markAccessed(top.map((r) => r.memoryId));
		}
		return top;
	}

	/** Async recall entry point (the learned-embedder-aware {@link searchHybridAsync}). */
	async recallAsync(
		query: string,
		opts: { limit?: number; markAccessed?: boolean; origin?: RecordOriginFilter } = {},
	): Promise<Array<MemoryRecord & { score: number }>> {
		return this.searchHybridAsync(query, opts);
	}

	/**
	 * Recall transparency (Tideline Step 11) — like `search` but returns each
	 * hit's {@link ScoreBreakdown} and does NOT reinforce decay (diagnostic +
	 * passive). Same candidate filtering (active + origin) and the same scorer,
	 * so the ranking matches `search` exactly — this just exposes the arithmetic
	 * (bm25 × modulator) behind each rank, for "why did this surface?" tooling.
	 */
	explainRecall(
		query: string,
		opts: { limit?: number; origin?: RecordOriginFilter } = {},
	): Array<MemoryRecord & { score: number; breakdown: ScoreBreakdown }> {
		const limit = opts.limit && opts.limit > 0 ? opts.limit : 8;
		const now = this.clock();
		const candidates = this.readAll().filter(
			(r) =>
				r.lifecycle === "active" &&
				(r.validTo === undefined || r.validTo > now) && // bi-temporal valid-time gate (see search)
				(opts.origin === undefined || recordMatchesOriginFilter(r, opts.origin)),
		);
		return bm25Score(candidates, query, now, { breakdown: true })
			.slice(0, limit)
			.map((s) => ({ ...s.record, score: s.score, breakdown: s.breakdown as ScoreBreakdown }));
	}

	/** Bump accessCount + lastAccessedAt for the given ids (recall reinforcement). */
	markAccessed(ids: string[]): void {
		if (ids.length === 0) return;
		const set = new Set(ids);
		const all = this.readAll();
		let changed = false;
		const now = this.clock();
		for (const r of all) {
			if (set.has(r.memoryId)) {
				r.accessCount += 1;
				r.lastAccessedAt = now;
				changed = true;
			}
		}
		if (changed) this.writeAll(all);
	}

	/**
	 * Write embeddings onto existing records by id (the re-embed pass's apply-step).
	 * Used to fill vectors that embed-on-write SKIPPED because the selected embedder
	 * is async (a learned model) — see {@link reembedPending}. Read-mutate-write,
	 * so it flows through the convex write-through cache like any other mutation.
	 */
	applyEmbeddings(updates: ReadonlyArray<{ memoryId: string; embedding: number[] }>): void {
		if (updates.length === 0) return;
		const byId = new Map(updates.map((u) => [u.memoryId, u.embedding] as const));
		const all = this.readAll();
		// Exact-width gate: only accept vectors matching the active embedder's dims,
		// so a wrong-width vector can't reach the fixed-dim convex by_embedding insert
		// (which would throw + lose the fact). reembed.ts gates too; belt-and-suspenders.
		const expectedDims = getDefaultEmbedder().dims;
		let changed = false;
		for (const r of all) {
			const e = byId.get(r.memoryId);
			if (e && e.length === expectedDims) {
				r.embedding = e;
				changed = true;
			}
		}
		if (changed) this.writeAll(all);
	}

	/**
	 * Feedback-driven self-learning (the continual-learning loop's signal). `up`
	 * nudges importance (+ confidence if set) UP and reinforces decay; `down`
	 * nudges them DOWN — ASYMMETRIC (+0.05 / −0.10), so a
	 * few bad recalls outweigh many lukewarm ones. Persisted + logged to the event
	 * track (telemetry). Recall's trust/importance modulation then adapts, closing
	 * the loop: recall → feedback → better recall. Returns the updated record.
	 */
	applyFeedback(memoryId: string, signal: "up" | "down"): MemoryRecord | undefined {
		const all = this.readAll();
		const rec = all.find((r) => r.memoryId === memoryId);
		// Only LIVE facts take feedback (consistent with invalidate) — feeding back
		// an archived/pruned id would silently mutate a dead record to no effect.
		if (!rec || rec.lifecycle !== "active") return undefined;
		const delta = signal === "up" ? 0.05 : -0.1;
		const clamp = (x: number): number => Math.max(0, Math.min(1, x));
		rec.importance = clamp(rec.importance + delta);
		if (typeof rec.confidence === "number") rec.confidence = clamp(rec.confidence + delta);
		const now = this.clock();
		// `up` is a recall-and-keep → reinforce decay (bump access). `down` must NOT
		// touch the access clock: refreshing lastAccessedAt would reset the decay
		// timer and partly counteract the importance drop it just applied.
		if (signal === "up") {
			rec.lastAccessedAt = now;
			rec.accessCount += 1;
		}
		this.writeAll(all);
		this.emit({ at: now, kind: "feedback", memoryId, segment: rec.segment, signal });
		return rec;
	}

	/**
	 * Metadata-preservation on reconcile (Fix 2). Fold the RICHER metadata of the
	 * `loserId` record into the `survivorId` record, in place — so a supersede /
	 * consolidation merge that ARCHIVES the loser doesn't DROP its hard-won metadata
	 * (a `subjectKey`, a more-specific segment, a higher importance/confidence). The
	 * caller invokes this on the KEEPER right before archiving the duplicate, so the
	 * survivor inherits from BOTH. No-op (false) if either id is missing or the
	 * survivor isn't active. Persists + returns whether anything changed.
	 *
	 * This is the store-level counterpart to {@link inheritRicherMetadata} (which
	 * the in-`write` reinforce paths call on their in-memory `all` array); the
	 * consolidation passes (dream / LLM consolidation) call THIS because their
	 * survivor lives in the store, not in a write-local array.
	 */
	mergeMetadataInto(survivorId: string, loserId: string): boolean {
		if (survivorId === loserId) return false;
		const all = this.readAll();
		const survivor = all.find((r) => r.memoryId === survivorId);
		const loser = all.find((r) => r.memoryId === loserId);
		if (!survivor || survivor.lifecycle !== "active" || !loser) return false;
		const before = JSON.stringify([
			survivor.subjectKey,
			survivor.segment,
			survivor.importance,
			survivor.confidence,
			survivor.accessCount,
			survivor.sourceTurn,
			survivor.validFrom,
			survivor.tier,
			survivor.decayRate,
			(survivor.links ?? []).map((l) => `${l.kind}|${l.target}`).sort(),
		]);
		inheritRicherMetadata(survivor, loser);
		const after = JSON.stringify([
			survivor.subjectKey,
			survivor.segment,
			survivor.importance,
			survivor.confidence,
			survivor.accessCount,
			survivor.sourceTurn,
			survivor.validFrom,
			survivor.tier,
			survivor.decayRate,
			(survivor.links ?? []).map((l) => `${l.kind}|${l.target}`).sort(),
		]);
		if (before === after) return false;
		this.writeAll(all);
		return true;
	}

	/**
	 * Bi-temporally INVALIDATE a fact (Tideline v2, step 15) — close its valid
	 * interval (`validTo = now`) + archive it, so recall drops it while HISTORY
	 * keeps it (transaction time `createdAt` untouched). If `supersededBy` is
	 * given, records a `contradicts` link on the superseder → the stale fact.
	 * Persisted + logged. Returns the invalidated record, or `undefined` if it's
	 * missing / already inactive.
	 */
	invalidate(staleId: string, opts: { supersededBy?: string; now?: number } = {}): MemoryRecord | undefined {
		const all = this.readAll();
		const stale = all.find((r) => r.memoryId === staleId);
		if (!stale || stale.lifecycle !== "active") return undefined;
		const now = opts.now ?? this.clock();
		stale.validTo = now;
		stale.lifecycle = "archived";
		if (opts.supersededBy) {
			const by = all.find((r) => r.memoryId === opts.supersededBy);
			if (by) {
				// Idempotent: drop any prior contradicts/transition edge to this
				// stale id, then re-add both — `contradicts` (conflict flag) +
				// `transition` (Step 19 temporal evolution edge for the graph/dream).
				const kept = (by.links ?? []).filter(
					(l) => !((l.kind === "contradicts" || l.kind === "transition") && l.target === staleId),
				);
				const links: MemoryLink[] = [
					...kept,
					{ kind: "contradicts", target: staleId },
					{ kind: "transition", target: staleId },
				];
				by.links = links;
			}
		}
		this.writeAll(all);
		this.emit({
			at: now,
			kind: "invalidated",
			memoryId: staleId,
			segment: stale.segment,
			...(opts.supersededBy ? { targets: [opts.supersededBy] } : {}),
		});
		return stale;
	}

	/**
	 * Step 19 — persist generic `relates` association edges between fact pairs
	 * (where synonymy/relatedness edges land). Bidirectional, deduped, and capped
	 * per record (a hub-fact fan-out guard); only ACTIVE facts are linked. Idempotent
	 * — re-running adds nothing already present. Goes through readAll/writeAll like
	 * every mutation, so it is fs↔convex parity by construction. Returns the number
	 * of NEW link entries written.
	 *
	 * Callers MUST pass only SAME-ORIGIN pairs (the dream computes synonymy per origin
	 * bucket) — a cross-principal `relates` edge would leak one peer's facts into
	 * another principal's graph-recall walk.
	 */
	linkRelated(pairs: ReadonlyArray<{ a: string; b: string }>, opts: { maxPerRecord?: number } = {}): number {
		if (pairs.length === 0) return 0;
		const maxPerRecord = opts.maxPerRecord && opts.maxPerRecord > 0 ? opts.maxPerRecord : 12;
		const all = this.readAll();
		const byId = new Map(all.map((r) => [r.memoryId, r]));
		let added = 0;
		const addOne = (fromId: string, toId: string): void => {
			if (fromId === toId) return;
			const rec = byId.get(fromId);
			if (!rec || rec.lifecycle !== "active") return;
			const links = rec.links ?? [];
			if (links.some((l) => l.kind === "relates" && l.target === toId)) return; // dedup
			if (links.filter((l) => l.kind === "relates").length >= maxPerRecord) return; // fan-out cap
			rec.links = [...links, { kind: "relates", target: toId }];
			added++;
		};
		for (const { a, b } of pairs) {
			// Both endpoints must be ACTIVE — skip a pair where either was archived
			// (e.g. consolidated away this same dream pass): a relation to a dead fact
			// is noise, and a supersede already carries that pair's relationship.
			if (byId.get(a)?.lifecycle !== "active" || byId.get(b)?.lifecycle !== "active") continue;
			addOne(a, b);
			addOne(b, a);
		}
		if (added > 0) this.writeAll(all);
		return added;
	}

	/**
	 * Lane B (Step 25) — REVERSE a retraction: re-activate an `archived` fact and
	 * clear its valid-time bound so it surfaces again. The reversible counterpart
	 * to {@link invalidate} — the operator's "restore" after an over-eager
	 * retraction. Persisted + logged (a `reinforced` event: the fact is reasserted
	 * as valid). Returns the record, or `undefined` if it's missing / not archived.
	 */
	reactivate(id: string, opts: { now?: number } = {}): MemoryRecord | undefined {
		const all = this.readAll();
		const rec = all.find((r) => r.memoryId === id);
		if (!rec || rec.lifecycle !== "archived") return undefined;
		// Only restore a RETRACTED or decayed fact — NOT one SUPERSEDED or CONSOLIDATED
		// away. A superseded/consolidated record is the TARGET of a contradicts/transition
		// edge from an ACTIVE successor; resurrecting it would put two contradictory
		// beliefs live at once (breaking the single-value invariant — exactly what the
		// supersede mechanism exists to prevent). A pure retract / decay leaves no such
		// incoming edge, so it stays restorable.
		const supersededByActive = all.some(
			(r) =>
				r.lifecycle === "active" &&
				(r.links ?? []).some((l) => (l.kind === "contradicts" || l.kind === "transition") && l.target === id),
		);
		if (supersededByActive) return undefined;
		// Belt-and-suspenders for the single-valued-slot invariant: if a same-origin fact
		// now occupies this subjectKey, restoring would create two live values — refuse.
		if (
			rec.subjectKey &&
			all.some((r) => r.lifecycle === "active" && r.subjectKey === rec.subjectKey && sameOrigin(r.createdBy, rec.createdBy))
		)
			return undefined;
		rec.lifecycle = "active";
		rec.validTo = undefined;
		this.writeAll(all);
		this.emit({ at: opts.now ?? this.clock(), kind: "reinforced", memoryId: id, segment: rec.segment });
		return rec;
	}

	/**
	 * Records whose VAULT note must be preserved: every ACTIVE fact PLUS any ARCHIVED
	 * fact that is still RESTORABLE — i.e. retracted/decayed, NOT superseded/consolidated
	 * by an active successor (same edge test as {@link reactivate}). The vault prune
	 * deletes notes outside this set, so a reversibly-retracted fact — and the operator's
	 * hand-pinned edits on it — survives a re-render; only a hard-purged fact's note
	 * (gone from the store entirely) is removed.
	 */
	listForVault(origin?: RecordOriginFilter): MemoryRecord[] {
		const all = this.readAll().filter((r) => origin === undefined || recordMatchesOriginFilter(r, origin));
		const supersededByActive = new Set<string>(
			all
				.filter((r) => r.lifecycle === "active")
				.flatMap((r) => (r.links ?? []).filter((l) => l.kind === "contradicts" || l.kind === "transition").map((l) => l.target)),
		);
		return all.filter((r) => r.lifecycle === "active" || (r.lifecycle === "archived" && !supersededByActive.has(r.memoryId)));
	}

	/**
	 * Dream/curator lane (Step 22) — REVERSIBLE: patch cognition fields on an
	 * ACTIVE record, used to PROMOTE a repeatedly-corrected belief to a confirmed
	 * preference. Returns the PRIOR {confidence,status,importance} (also recorded
	 * in the "confirmed" event) so a dream pass can be undone — Lane A is
	 * reversible by design. No-op (undefined) if `memoryId` isn't an active record.
	 */
	promote(
		memoryId: string,
		patch: { status?: MemoryStatus; confidence?: number; importance?: number },
		opts: { now?: number } = {},
	): { confidence?: number; status?: MemoryStatus; importance?: number } | undefined {
		const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
		const all = this.readAll();
		const rec = all.find((r) => r.memoryId === memoryId);
		if (!rec || rec.lifecycle !== "active") return undefined;
		const prior: { confidence?: number; status?: MemoryStatus; importance?: number } = {
			...(rec.confidence !== undefined ? { confidence: rec.confidence } : {}),
			...(rec.status !== undefined ? { status: rec.status } : {}),
			importance: rec.importance,
		};
		if (patch.status !== undefined) rec.status = patch.status;
		if (patch.confidence !== undefined) rec.confidence = clamp01(patch.confidence);
		if (patch.importance !== undefined) rec.importance = clamp01(patch.importance);
		this.writeAll(all);
		this.emit({ at: opts.now ?? this.clock(), kind: "confirmed", memoryId, segment: rec.segment, prior });
		return prior;
	}

	/**
	 * Dream/curator lane (Step 22): archive low-value decayed facts, emitting an
	 * "evicted" event per fact. Returns the ids actually archived (skips already
	 * non-active ones). Distinct from decay GC's `setLifecycle` in that it logs.
	 */
	evict(ids: readonly string[], opts: { now?: number } = {}): string[] {
		if (ids.length === 0) return [];
		const now = opts.now ?? this.clock();
		const set = new Set(ids);
		const all = this.readAll();
		const evicted: string[] = [];
		for (const r of all) {
			if (set.has(r.memoryId) && r.lifecycle === "active") {
				r.lifecycle = "archived";
				r.validTo = r.validTo ?? now;
				evicted.push(r.memoryId);
			}
		}
		if (evicted.length === 0) return [];
		this.writeAll(all);
		for (const id of evicted) {
			const seg = all.find((r) => r.memoryId === id)?.segment;
			this.emit({ at: now, kind: "evicted", memoryId: id, ...(seg ? { segment: seg } : {}) });
		}
		return evicted;
	}

	/**
	 * Governance (Step 24) — HARD-delete records (crypto-shred: the sealed
	 * content is REMOVED, not archived, so it's unrecoverable even with the key).
	 * Returns the ids actually removed. Filesystem rewrites the JSONL without
	 * them; convex mode realises the deletion through the write-through diff.
	 * Distinct from evict/setLifecycle, which only flip lifecycle.
	 */
	purge(ids: readonly string[]): string[] {
		if (ids.length === 0) return [];
		const set = new Set(ids);
		const all = this.readAll();
		const removed = all.filter((r) => set.has(r.memoryId)).map((r) => r.memoryId);
		if (removed.length === 0) return [];
		this.writeAll(all.filter((r) => !set.has(r.memoryId)));
		return removed;
	}

	/**
	 * The DISTINCT origins present in the active store (owner + each channel
	 * peer). The per-origin fan-out seam: the curator/dream run one pass per
	 * origin so a cross-fact operation never mixes principals. Deduped by
	 * {@link originBucketKey}; owner first, then channels in stable key order.
	 */
	distinctOrigins(): MemoryRecordOrigin[] {
		const byKey = new Map<string, MemoryRecordOrigin>();
		for (const r of this.readAll()) {
			if (r.lifecycle !== "active") continue;
			const key = originBucketKey(r);
			if (!byKey.has(key)) byKey.set(key, resolveRecordOrigin(r.createdBy));
		}
		return [...byKey.entries()].sort((a, b) => (a[0] === "owner" ? -1 : b[0] === "owner" ? 1 : a[0].localeCompare(b[0]))).map(([, o]) => o);
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
		// DRIFT GUARD — the most recent read SKIPPED non-empty line(s) it couldn't
		// parse (a hand-edit, a torn/concurrent write, a partial convex→fs sync). The
		// atomic rewrite below keeps only the parsed records, so that content is about
		// to be SILENTLY LOST. Snapshot the current on-disk file to a sibling
		// `.bak-<pid>-<ts>` first so it stays recoverable, then proceed — refusing the
		// write would wedge the agent's own memory. Cheap single-operator insurance.
		if (this.lastReadHadUnparseable) {
			try {
				const bak = `${this.file}.bak-${process.pid}-${Math.round(this.clock())}`;
				fs.copyFileSync(this.file, bak);
				driftLog.warn("facts.jsonl had unparseable line(s); snapshotted before overwrite so nothing is silently dropped", { bak });
			} catch {
				/* best-effort snapshot — never block the write on a failed backup */
			}
			this.lastReadHadUnparseable = false; // consumed — the snapshot now holds it
		}
		const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
		const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, body, "utf8");
		fs.renameSync(tmp, this.file);
	}
}
