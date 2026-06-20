/**
 * Tideline gold set — the cases the eval harness scores (build Step 2).
 *
 * A gold set is a corpus of FACTS plus CASES (a query + which facts should
 * surface). Facts are addressed by a stable logical `key` so a case can name
 * its relevant facts BEFORE their `memoryId`s exist; `seedGold` writes the
 * facts into a `FactStore`, captures key→memoryId, applies supersedes (so
 * knowledge-update / transition cases archive the stale fact), and resolves
 * each case's `relevantKeys` into the `relevantIds` the harness compares
 * against. EMPTY `relevantKeys` ⇒ an abstention case.
 *
 * Two sources, per the plan: the SYNTHETIC hard cases in the sibling
 * gold-synthetic / gold-hard / gold-rich files (self-contained, runnable
 * today) and — exported + decrypted + human-approved — the operator's REAL
 * Convex facts (`loadGoldSpec` reads that JSON; built jointly). This file is
 * infrastructure only: types, `seedGold`, `loadGoldSpec`, and `GOLD_CATEGORIES`.
 */

import * as fs from "node:fs";

import {
	FactStore,
	MEMORY_SEGMENTS,
	MEMORY_SOURCE_TYPES,
	type MemoryRecordOrigin,
	type MemorySegment,
	type MemorySourceType,
	type NewFact,
} from "../records.js";
import type { EvalCase } from "./harness.js";

/** A fact in a gold corpus, addressed by a stable logical `key`. */
export interface GoldFact {
	key: string;
	content: string;
	segment: MemorySegment;
	importance?: number;
	createdBy?: MemoryRecordOrigin;
	/** Provenance — drives trust modulation + the write-gate. Omit ⇒ owner/trusted.
	 *  `tool_output`/`retrieved_document`/`compaction` = untrusted (the poison
	 *  lane the hybrid is meant to down-weight). Untrusted facts may only occupy
	 *  DESCRIPTIVE segments (knowledge/context/project/relationship) — the gate
	 *  blocks them from identity/preference/correction. */
	sourceType?: MemorySourceType;
	/** keys this fact supersedes (knowledge-update / transition) — those facts
	 *  must already be listed EARLIER in `facts` (they're written first). */
	supersedesKeys?: string[];
}

/** A gold case referencing relevant facts by their logical key. */
export interface GoldCase {
	id: string;
	query: string;
	/** logical keys of facts that SHOULD surface. EMPTY ⇒ abstention. */
	relevantKeys: string[];
	category: string;
}

export interface GoldSpec {
	facts: GoldFact[];
	cases: GoldCase[];
	/** Real-data path ONLY (`loadGoldSpec`): an exported scaffold is `false`; the
	 *  operator MUST review + rewrite the trivial auto-queries into real paraphrases
	 *  and flip this to `true` before it can be scored. `loadGoldSpec` REFUSES a spec
	 *  that isn't explicitly `true` (an un-reviewed scaffold self-matches ⇒ inflated
	 *  recall). Committed hand-authored sets bypass `loadGoldSpec`, so they ignore it. */
	approved?: boolean;
}

/** The full, deliberately-unique sentinel an export scaffold emits for a query it
 *  could not auto-derive. `loadGoldSpec` rejects any spec whose queries still
 *  contain it — a left-in placeholder means the operator hasn't finished the
 *  human-approval rewrite. (The whole phrase, not the bare "TODO: rewrite" token,
 *  so a legitimate query mentioning "TODO" or "rewrite" is never falsely rejected.) */
export const GOLD_REVIEW_PLACEHOLDER = "TODO: rewrite (auto-extraction empty)";

/**
 * Seed `store` with the spec's facts (in order, so supersede targets exist)
 * and resolve its cases into `EvalCase`s. Returns the cases ready for
 * `runRecallEval`. Throws on a case referencing an unknown fact key — a typo
 * in a gold set should fail loud, not silently score zero.
 */
export function seedGold(store: FactStore, spec: GoldSpec): EvalCase[] {
	const keyToId = new Map<string, string>();
	const seenIds = new Set<string>();
	const explicitlySuperseded = new Set<string>();
	for (const f of spec.facts) {
		// Keys must be unique — a duplicate would silently overwrite in keyToId
		// and a case could then resolve to the wrong fact.
		if (keyToId.has(f.key)) {
			throw new Error(`gold fact "${f.key}": duplicate fact key — keys must be unique`);
		}
		const supersedes = f.supersedesKeys?.map((k) => {
			const id = keyToId.get(k);
			if (!id) {
				throw new Error(`gold fact "${f.key}": supersedesKey "${k}" must be listed earlier in facts`);
			}
			return id;
		});
		for (const id of supersedes ?? []) explicitlySuperseded.add(id);
		const nf: NewFact = {
			content: f.content,
			segment: f.segment,
			...(f.importance !== undefined ? { importance: f.importance } : {}),
			...(f.createdBy !== undefined ? { createdBy: f.createdBy } : {}),
			...(f.sourceType !== undefined ? { sourceType: f.sourceType } : {}),
			...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
		};
		const rec = store.write(nf);
		// Fail loud on a write-time dedup collision: FactStore.write merges a
		// near-identical same-origin fact into an existing record and returns THAT
		// id, so two distinct gold keys could silently map to one memoryId —
		// corrupting relevance labels. Gold facts must stay distinct.
		if (seenIds.has(rec.memoryId)) {
			throw new Error(
				`gold fact "${f.key}": write-time dedup merged it into an earlier fact (id ${rec.memoryId}). ` +
					`Make its content less similar to a sibling, or give it a distinct supersedesKey.`,
			);
		}
		seenIds.add(rec.memoryId);
		keyToId.set(f.key, rec.memoryId);
	}
	// CORPUS CONSERVATION: every written fact must remain ACTIVE unless it was an
	// EXPLICIT supersedesKey target. A silent shrink — an auto-supersede (a
	// content/slot collision) archiving an UNREFERENCED distractor — would quietly
	// weaken the competition a case relies on (the corpus is smaller / easier than
	// authored) without tripping the per-case guard below. Fail loud so the gold
	// author makes the distractor distinct or supersedes it explicitly.
	const active = store.list();
	const expectedActive = spec.facts.length - explicitlySuperseded.size;
	if (active.length !== expectedActive) {
		const activeSet = new Set(active.map((r) => r.memoryId));
		const silentlyArchived = [...seenIds].filter((id) => !activeSet.has(id) && !explicitlySuperseded.has(id)).length;
		throw new Error(
			`gold seeding shrank the corpus: ${active.length} active vs ${expectedActive} expected ` +
				`(${spec.facts.length} written − ${explicitlySuperseded.size} explicitly superseded); ` +
				`${silentlyArchived} fact(s) auto-archived by a content/slot collision — make them distinct or supersede explicitly.`,
		);
	}
	// Fail loud if a later correction/slot-supersede write ARCHIVED a fact a case
	// still references: store.list() is active-only, so its label would silently
	// score zero. (Extends the dedup-collision fail-loud above to the content/slot
	// auto-supersede path.)
	const activeIds = new Set(active.map((r) => r.memoryId));
	return spec.cases.map((c) => ({
		id: c.id,
		query: c.query,
		relevantIds: c.relevantKeys.map((k) => {
			const id = keyToId.get(k);
			if (!id) throw new Error(`gold case "${c.id}": unknown fact key "${k}"`);
			if (!activeIds.has(id)) {
				throw new Error(
					`gold case "${c.id}": fact key "${k}" resolved to a record archived by a later ` +
						`supersede/correction write — its relevance label would silently score zero.`,
				);
			}
			return id;
		}),
		category: c.category,
	}));
}

/** The taxonomy buckets a gold set should cover (the harness groups by these). */
export const GOLD_CATEGORIES = [
	"single-session",
	"multi-session",
	"temporal",
	"knowledge-update",
	"preference",
	"abstention",
	"model-switch",
	"transition",
] as const;

/** Load a gold spec from a JSON file (the real-data path: export + decrypt the
 *  operator's Convex facts → human-approved cases → this JSON). Validates shape. */
export function loadGoldSpec(jsonPath: string): GoldSpec {
	const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as GoldSpec;
	if (!Array.isArray(raw.facts) || !Array.isArray(raw.cases)) {
		throw new Error(`gold spec at ${jsonPath} must have { facts: [], cases: [] }`);
	}
	raw.facts.forEach((f, i) => {
		if (typeof f?.key !== "string" || typeof f?.content !== "string" || typeof f?.segment !== "string") {
			throw new Error(`gold spec at ${jsonPath}: facts[${i}] needs string key, content, and segment`);
		}
		// Validate segment against the known set — an unknown/typo'd segment would
		// silently degrade to `context` defaults (skewing tier/importance/decay).
		if (!(MEMORY_SEGMENTS as readonly string[]).includes(f.segment)) {
			throw new Error(`gold spec at ${jsonPath}: facts[${i}] has unknown segment "${f.segment}"`);
		}
		// Validate sourceType the SAME way (when present) — anything outside the known
		// set is treated as TRUSTED by the write-gate (isUntrustedSource → false), so a
		// typo'd "tool-output" would silently turn a poison distractor into a trusted
		// answer. Mirror the segment guard; fail loud rather than mislabel the trust lane.
		if (f.sourceType !== undefined && !(MEMORY_SOURCE_TYPES as readonly string[]).includes(f.sourceType as string)) {
			throw new Error(`gold spec at ${jsonPath}: facts[${i}] has unknown sourceType "${f.sourceType}"`);
		}
	});
	raw.cases.forEach((c, i) => {
		if (typeof c?.id !== "string" || typeof c?.query !== "string") {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] needs string id and query`);
		}
		if (!Array.isArray(c.relevantKeys)) {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] (${c.id}) needs an array relevantKeys`);
		}
		if (!c.relevantKeys.every((k) => typeof k === "string")) {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] (${c.id}) relevantKeys must all be strings`);
		}
		if (typeof c.category !== "string") {
			throw new Error(`gold spec at ${jsonPath}: cases[${i}] (${c.id}) needs a string category`);
		}
	});
	// APPROVAL GATE — an exported scaffold's queries are lifted straight from its
	// facts (trivially self-matching ⇒ inflated recall). It is NOT a measurement
	// until the operator rewrites those queries into real paraphrases and marks the
	// spec reviewed. Refuse to load anything not explicitly approved, and refuse a
	// spec that still carries an auto-extraction placeholder (an un-rewritten case).
	if (raw.approved !== true) {
		throw new Error(
			`gold spec at ${jsonPath} is an un-approved scaffold (approved !== true). Its auto-generated ` +
				`queries self-match their own facts and would inflate recall. Review each case — rewrite the ` +
				`query into a realistic paraphrase, set the GOLD_CATEGORIES taxonomy label, drop noise/mark ` +
				`abstentions — then set "approved": true to score it.`,
		);
	}
	const placeheld = raw.cases.find((c) => c.query.includes(GOLD_REVIEW_PLACEHOLDER));
	if (placeheld) {
		throw new Error(
			`gold spec at ${jsonPath}: case "${placeheld.id}" still carries the "${GOLD_REVIEW_PLACEHOLDER}" ` +
				`placeholder — finish the human-approval rewrite before scoring (a left-in placeholder is an un-reviewed case).`,
		);
	}
	return raw;
}
