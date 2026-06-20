/**
 * Tideline v1 recall scoring (build Step 8) — the SHARED lexical scorer.
 *
 * ONE pure scorer, run identically in BOTH modes — over the fs `FactStore`'s
 * records OR the convex hydrated cache — so recall ranking is **cross-mode
 * parity by construction** (the 0.2 lock). We use an IN-APP BM25 rather than
 * `node:sqlite` FTS5 deliberately: the SAME code must rank in both modes, and
 * sqlite-fs + in-app-convex would be two different rankers, breaking
 * by-construction parity. `node:sqlite` FTS5 stays a deferred fs-side SCALE
 * optimization — at single-user scale a full in-app pass is microseconds.
 *
 * `bm25Score` = Okapi BM25 (k1, b) over tokenized content, MODULATED by a
 * damped `effectiveScore` (`0.5 + 0.5 * effectiveScore`) so recency/importance
 * shape the ranking without overriding a >2× relevance gap. `linearScanScore`
 * is the OLD crude term-overlap, kept as the
 * explicit linear-floor BASELINE. Both take records the CALLER has already
 * filtered to active + origin-matching — origin isolation is enforced upstream
 * (records.ts / capabilities.ts), never bypassed here.
 */

import { effectiveScore } from "./decay.js";
import type { MemoryRecord } from "./records.js";

/** Okapi BM25 term-frequency saturation + length-normalisation params. */
const K1 = 1.2;
const B = 0.75;

/**
 * Conservative English stopword set — function words that carry no recall
 * signal but, unfiltered, make EVERY fact containing "I"/"the"/"is" match every
 * query (over-retrieval), and make abstention impossible. Deliberately NARROW:
 * articles, pronouns, to-be/have/do auxiliaries, prepositions, and question
 * scaffolding only — NO content words and NO negations ("no"/"not" kept, since
 * a bag-of-words scorer mis-handling negation is worse than keeping it).
 */
const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for",
	"from", "had", "has", "have", "how", "i", "in", "is", "it", "its", "me", "my",
	"of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where",
	"which", "who", "will", "with", "you", "your",
]);

/**
 * Lowercase Unicode word tokens (shared by docs + queries), minus stopwords.
 * Splits on any run of non-word characters via the Unicode letter/number
 * classes (`\p{L}\p{N}`) rather than an ASCII-only `[a-z0-9]` class, so
 * non-Latin scripts (CJK, Cyrillic, Greek, Arabic, Hebrew, …) tokenize instead
 * of being silently discarded — an ASCII-only delimiter class made non-Latin
 * facts unrecallable (empty token list → no BM25 match). The stopword set stays
 * intentionally ASCII-only (non-Latin tokens simply aren't members). Note: a
 * space-less script (e.g. CJK) yields one whole-run token, so it matches by
 * exact phrase rather than per-word — partial-substring matching would need a
 * dedicated n-gram path.
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Why a record scored what it did (recall transparency, build Step 11).
 * Populated only on demand (`bm25Score(..., { breakdown: true })` /
 * `FactStore.explainRecall`) so the hot recall path stays allocation-free and
 * cross-mode score parity is unaffected. Reconciles exactly:
 * `score === bm25 * modulator`; on the DEFAULT modulate path
 * `modulator === 0.5 + 0.5 * effective` (with `modulate: false` the modulator
 * is `1`, so `score === bm25`).
 */
export interface ScoreBreakdown {
	/** Raw Okapi BM25 relevance, before the decay/importance modulator. */
	bm25: number;
	/** Query terms (post-stopword) that actually matched this record. */
	matchedTerms: string[];
	/**
	 * `effectiveScore(record)` = decay × importance × recall-reinforcement,
	 * clamped to [0, 1]. The reinforcement factor lifts repeatedly-accessed
	 * facts (so recall reinforces what gets recalled).
	 */
	effective: number;
	/**
	 * The modulator applied to {@link bm25}. With `modulate: false` it is `1`
	 * (so `score === bm25`); on the DEFAULT path it is the damped
	 * `0.5 + 0.5 * effective`, in [0.5, 1].
	 */
	modulator: number;
	/** Final score (=== {@link ScoredRecord.score}). */
	score: number;
}

export interface ScoredRecord {
	record: MemoryRecord;
	score: number;
	/** Present only when scored with `{ breakdown: true }` — explains the rank. */
	breakdown?: ScoreBreakdown;
}

/**
 * OLD term-overlap (distinct matched query terms / query length) — the
 * explicit linear-scan FLOOR. Records must be pre-filtered (active + origin).
 * Ties broken by importance then recency, matching the pre-BM25 ordering.
 */
export function linearScanScore(records: readonly MemoryRecord[], query: string): ScoredRecord[] {
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0) return [];
	const out: ScoredRecord[] = [];
	for (const r of records) {
		const hay = r.content.toLowerCase();
		const matched = terms.filter((t) => hay.includes(t)).length;
		if (matched === 0) continue;
		out.push({ record: r, score: matched / terms.length });
	}
	out.sort(
		(a, b) =>
			b.score - a.score ||
			b.record.importance - a.record.importance ||
			b.record.createdAt - a.record.createdAt,
	);
	return out;
}

/**
 * Okapi BM25 over the records' content, MODULATED by a damped `effectiveScore`
 * (decay + importance) — relevance dominates, recency/importance shapes ties.
 * Records must be pre-filtered (active + origin). IDF is computed over the
 * given set; records matching no query term are dropped. Ranked descending.
 */
export function bm25Score(
	records: readonly MemoryRecord[],
	query: string,
	now: number = Date.now(),
	opts: { breakdown?: boolean; modulate?: boolean } = {},
): ScoredRecord[] {
	const qterms = [...new Set(tokenize(query))];
	if (qterms.length === 0 || records.length === 0) return [];

	const docs = records.map((r) => ({ record: r, tokens: tokenize(r.content) }));
	const N = docs.length;
	const avgLen = Math.max(1, docs.reduce((s, d) => s + d.tokens.length, 0) / N);

	// Document frequency + idf per query term (+1 form → never negative).
	const idf = new Map<string, number>();
	for (const t of qterms) {
		let n = 0;
		for (const d of docs) if (d.tokens.includes(t)) n += 1;
		idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
	}

	const out: ScoredRecord[] = [];
	for (const d of docs) {
		const len = d.tokens.length;
		const tf = new Map<string, number>();
		for (const tok of d.tokens) if (idf.has(tok)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
		let bm = 0;
		const matched: string[] = [];
		for (const t of qterms) {
			const f = tf.get(t) ?? 0;
			if (f === 0) continue;
			matched.push(t);
			const denom = f + K1 * (1 - B + (B * len) / avgLen);
			bm += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / denom);
		}
		if (bm <= 0) continue;
		// Relevance (BM25) dominates; effectiveScore (decay + importance) MODULATES
		// within ±50% — every record keeps at least half its raw BM25, so the
		// modulator can shift ranking by at most 2x (modulator ∈ [0.5, 1]) and CANNOT
		// override a relevance gap wider than 2x. (A
		// pure multiplier let importance override relevance and cost recall — the
		// eval harness caught it; damping is the relevance-first fix.)
		const effective = effectiveScore(d.record, now);
		// `modulate: false` = pure BM25 (the plain-lexical FTS baseline, Step 3);
		// the default folds in the damped decay/importance modulator.
		const modulator = opts.modulate === false ? 1 : 0.5 + 0.5 * effective;
		const score = bm * modulator;
		const scored: ScoredRecord = { record: d.record, score };
		if (opts.breakdown) {
			scored.breakdown = { bm25: bm, matchedTerms: matched, effective, modulator, score };
		}
		out.push(scored);
	}
	out.sort((a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt);
	return out;
}
