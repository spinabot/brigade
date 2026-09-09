/**
 * The links substrate — typed edges between memories (Tideline build Step 7,
 * the graph half of the dual-track spine).
 *
 * A fact can point at other facts: a correction supersedes a prior belief, an
 * extracted fact is `derived_from` its source, two facts may `contradict`. v1
 * STORES and DERIVES these edges (the substrate); multi-hop graph TRAVERSAL
 * (following links during recall to pull in related context) is deliberately
 * v2 — the field + the read primitives land now so the data accrues and the
 * v2 traversal has something to walk.
 *
 * Storage note: `supersedes[]` stays the supersede MECHANISM (it drives
 * archiving in `FactStore.write`); we do NOT duplicate it into `links[]` at
 * write time. Instead {@link linksFrom} mirrors it into a `supersedes` edge at
 * READ time so a graph view is complete without a migration or double-write.
 */

import type { MemoryRecord } from "../store/records.js";

/**
 * Typed edge kinds. `supersedes` is derived from the record's `supersedes[]`;
 * the rest are explicit (written into `links[]`). Surfaced, not auto-resolved —
 * a `contradicts` edge flags a conflict for consolidation, it doesn't pick a
 * winner.
 *
 * The vocabulary is split into THREE bands (the research-backed
 * relationship-extraction design — TYPED + JUSTIFIED + STRENGTH-SCORED edges with
 * a strict "direct basis" gate):
 *   • MECHANISM/lifecycle edges (`supersedes`/`transition`/`corrects`/`contradicts`)
 *     are minted by the store itself (supersede chains, slot replacement) — NOT by
 *     the relationship extractor.
 *   • STRONG FACTUAL edges (`causes`…`relates_to`) are the closed set the LLM
 *     extractor may emit, each requiring a direct stated basis + a reason + strength.
 *   • THEMATIC `same_topic` is the QUARANTINED over-linking lane: same-domain pairs
 *     (dark-mode ~ Obsidian) are allowed but capped, low-strength, and rendered in a
 *     SEPARATE "## Same area" section so they never masquerade as strong relations.
 */
export type MemoryLinkKind =
	// ── store-minted lifecycle/mechanism edges (NOT emitted by the LLM extractor) ──
	| "supersedes" // this fact replaces the target (the correction edge)
	| "transition" // temporal evolution: this fact is what the target BECAME (Step 19)
	| "corrects" // amends the target without fully replacing it
	| "derived_from" // distilled/extracted from the target
	| "supports" // corroborates the target
	// ── strong FACTUAL edges the relationship extractor may emit (typed taxonomy) ──
	| "causes" // this fact is the reason/cause of the target
	| "caused_by" // this fact is caused by / a consequence of the target
	| "part_of" // this fact is a component/member of the target
	| "precedes" // this fact happens BEFORE the target (temporal/sequence)
	| "follows" // this fact happens AFTER the target (temporal/sequence)
	| "enables" // this fact makes the target possible
	| "blocks" // this fact prevents/obstructs the target
	| "co_constrains" // two constraints that co-apply (e.g. dietary: vegetarian + peanut-allergy)
	| "located_at" // this fact is situated at/in the target (place/region)
	| "uses" // this fact uses/depends on the target (tool/tech)
	| "works_on" // this fact concerns work on the target (project/area)
	| "contrasts_with" // tension/contradiction between the two — flagged for review
	| "contradicts" // conflicts with the target (store-minted on slot supersede; also a review flag)
	| "relates_to" // DISCOURAGED generic factual fallback — requires an especially strong reason
	// ── thematic / same-domain (QUARANTINED — capped, low-strength, separate render) ──
	| "same_topic"
	// ── legacy generic association (synonymy/bridge edges land here, Step 19) ──
	| "relates";

/** Runtime list of every {@link MemoryLinkKind} — the strict-validation basis for
 *  the relationship extractor (an out-of-taxonomy `type` from the model is dropped)
 *  and for keeping the convex `LinkKind` validators (schema.ts + memory.ts) in sync.
 *  A typo/extra value is a COMPILE error via the `satisfies` clause below. */
export const MEMORY_LINK_KINDS = [
	"supersedes",
	"transition",
	"corrects",
	"derived_from",
	"supports",
	"causes",
	"caused_by",
	"part_of",
	"precedes",
	"follows",
	"enables",
	"blocks",
	"co_constrains",
	"located_at",
	"uses",
	"works_on",
	"contrasts_with",
	"contradicts",
	"relates_to",
	"same_topic",
	"relates",
] as const satisfies readonly MemoryLinkKind[];

const MEMORY_LINK_KIND_SET: ReadonlySet<string> = new Set(MEMORY_LINK_KINDS);

/** True if `k` is a known link kind (strict-validation gate for model output). */
export function isMemoryLinkKind(k: string): k is MemoryLinkKind {
	return MEMORY_LINK_KIND_SET.has(k);
}

/**
 * The closed set of STRONG FACTUAL edge kinds the LLM relationship extractor is
 * allowed to emit. Excludes the store-minted lifecycle edges (supersedes/
 * transition/corrects/derived_from/supports — the store owns those), the thematic
 * `same_topic` lane (its own quarantined handling), and the legacy `relates` (a
 * derivation-pass kind for synonymy/bridges, never extractor output). `relates_to`
 * is IN the set but discouraged (the prompt asks for an especially strong reason).
 */
export const EXTRACTOR_FACTUAL_KINDS = [
	"causes",
	"caused_by",
	"part_of",
	"precedes",
	"follows",
	"enables",
	"blocks",
	"co_constrains",
	"located_at",
	"uses",
	"works_on",
	"contrasts_with",
	"relates_to",
] as const satisfies readonly MemoryLinkKind[];

const EXTRACTOR_FACTUAL_KIND_SET: ReadonlySet<string> = new Set(EXTRACTOR_FACTUAL_KINDS);

/** True if `k` is a strong FACTUAL kind the extractor may emit (excludes
 *  `same_topic`, store-minted lifecycle kinds, and legacy `relates`). */
export function isExtractorFactualKind(k: string): k is MemoryLinkKind {
	return EXTRACTOR_FACTUAL_KIND_SET.has(k);
}

/** Directed inverse of an edge kind, for the REVERSE endpoint of a bidirectional
 *  write (causes↔caused_by, precedes↔follows). A SYMMETRIC kind is its own inverse
 *  (co_constrains, contrasts_with, contradicts, same_topic, relates, relates_to, uses,
 *  works_on, located_at) so it mirrors unchanged. `enables`/`blocks` have no clean
 *  English inverse — the reverse endpoint records the same kind (the pair is still a
 *  genuine, explainable edge from either side). Store-minted lifecycle kinds aren't
 *  passed through here (linkRelated is the typed-association writer). */
export function inverseLinkKind(kind: MemoryLinkKind): MemoryLinkKind {
	switch (kind) {
		case "causes":
			return "caused_by";
		case "caused_by":
			return "causes";
		case "precedes":
			return "follows";
		case "follows":
			return "precedes";
		case "part_of":
			return "part_of"; // membership reads both ways for recall (component ↔ whole)
		default:
			return kind; // symmetric / inverse-less kinds mirror unchanged
	}
}

export interface MemoryLink {
	kind: MemoryLinkKind;
	/** `memoryId` of the linked fact. */
	target: string;
	/** WHY this edge exists — the model's one-line justification (chain-of-thought →
	 *  higher precision). Optional + additive: persisted for explainable rendering
	 *  (`- <kind>: [[target]] — <reason>`); store-minted edges (supersede/transition)
	 *  carry none. */
	reason?: string;
	/** Edge strength 1..5 (the post-filter axis). Factual edges below the strength
	 *  threshold are dropped at extraction time; `same_topic` is admitted only at low
	 *  strength + capped. Optional + additive; store-minted edges carry none. */
	strength?: number;
}

/**
 * All outbound edges of a record — explicit `links[]` UNION the `supersedes[]`
 * mirrored as `supersedes` edges, deduped. This is the canonical "edges of this
 * node" view; storage keeps the two arrays separate (see module note).
 */
export function linksFrom(record: Pick<MemoryRecord, "links" | "supersedes">): MemoryLink[] {
	const mirrored: MemoryLink[] = (record.supersedes ?? []).map((target) => ({ kind: "supersedes", target }));
	// Dedup by kind|target ONLY — reason/strength don't change EDGE IDENTITY (the
	// graph still draws one line). When two entries collide, KEEP the one carrying a
	// reason (the explainable render) so a later reason-less write can't blank it.
	const byKey = new Map<string, MemoryLink>();
	const order: string[] = [];
	for (const l of [...(record.links ?? []), ...mirrored]) {
		const key = `${l.kind}|${l.target}`;
		const prior = byKey.get(key);
		if (!prior) {
			byKey.set(key, l);
			order.push(key);
		} else if (!prior.reason && l.reason) {
			byKey.set(key, l); // upgrade to the reason-bearing duplicate (identity unchanged)
		}
	}
	return order.map((k) => byKey.get(k)!);
}

/**
 * Inbound edges to `targetId` across the corpus — the BACKLINKS. The substrate's
 * read primitive; v2 multi-hop recall walks these to pull related context.
 */
export function backlinksTo(
	records: readonly MemoryRecord[],
	targetId: string,
): Array<{ from: string; kind: MemoryLinkKind }> {
	const out: Array<{ from: string; kind: MemoryLinkKind }> = [];
	for (const r of records) {
		for (const l of linksFrom(r)) {
			if (l.target === targetId) out.push({ from: r.memoryId, kind: l.kind });
		}
	}
	return out;
}
