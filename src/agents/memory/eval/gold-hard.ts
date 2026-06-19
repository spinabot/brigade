/**
 * HARD discriminating gold set (Tideline build Step 3, the "show the wins" tier).
 *
 * The synthetic gold (gold-synthetic.ts) is CLEAN: every query has one obvious
 * answer and no competition, so floor / FTS / BM25 / hybrid all tie at 100% — it
 * proves correctness + abstention, not where Tideline's modulation wins. THIS set
 * adds the competition that separates the lanes, across the model-free win
 * surfaces (vectors are the deferred v2 lane, so paraphrase recovery is out of
 * scope here):
 *
 *   • POISON (trust)       — a TRUSTED owner fact vs an UNTRUSTED tool/retrieved
 *     distractor sharing the query terms. On ~half the cases the distractor
 *     out-scores the answer on raw BM25 (so plain-FTS / un-trusted BM25 rank the
 *     POISON first there; on the rest the answer already wins lexically) — only the
 *     trust-weighted hybrid (TRUST_BY_SOURCE) ranks the trusted answer #1 on ALL of
 *     them. The gated claim is the SERVED hybrid's poison MRR (1.00) > floor (0.83);
 *     the intermediate BM25×eff lane (no trust) can even regress below the floor.
 *   • IMPORTANCE (decay×importance modulation) — a HIGH-importance answer vs a
 *     LOW-importance distractor with comparable BM25. Plain-FTS ignores
 *     importance and ranks the distractor first; the modulated lanes (BM25×eff +
 *     hybrid) lift the important answer. (Decay is the temporal sibling of this
 *     same effectiveScore modulator — testable once real aged data exists.)
 *   • PRECISION            — one answer amid sibling distractors that share SOME
 *     query terms; measures ranking quality (MRR/nDCG), not a lane win.
 *   • ABSTENTION           — no-answer queries; a hit is a violation.
 *
 * Write-gate honesty: untrusted distractors live ONLY in descriptive segments
 * (knowledge/context/project/relationship) — the gate blocks an untrusted source
 * from authoring identity/preference/correction, so a poison fact can't be a
 * preference; it competes as descriptive "evidence" (a tool result asserting a
 * fact about the user), which is the real attack surface.
 */

import type { GoldSpec } from "./gold.js";

export const HARD_GOLD: GoldSpec = {
	facts: [
		// ─────────────── POISON PAIRS — trusted answer, then untrusted distractor.
		{ key: "diet", content: "I do not eat meat — I keep a strict vegetarian diet.", segment: "preference" },
		{ key: "p-diet", content: "Order log: user did eat meat.", segment: "knowledge", sourceType: "tool_output" },

		{ key: "role", content: "My role is principal engineer on the platform team.", segment: "project" },
		{ key: "p-role", content: "User role: intern.", segment: "knowledge", sourceType: "retrieved_document" },

		{ key: "city", content: "I live in Lisbon at the moment.", segment: "identity" },
		{ key: "p-city", content: "Records say the user live in Berlin.", segment: "context", sourceType: "tool_output" },

		{ key: "car", content: "I drive a silver Tesla as my own car.", segment: "context" },
		{ key: "p-car", content: "Rental log: user drive a Jeep car.", segment: "knowledge", sourceType: "retrieved_document" },

		{ key: "team", content: "My manager is Priya on the data team.", segment: "relationship" },
		{ key: "p-team", content: "Org chart guess: user manager is Raj.", segment: "knowledge", sourceType: "tool_output" },

		{ key: "tool", content: "My preferred editor is Helix for coding.", segment: "preference" },
		{ key: "p-tool", content: "User editor: Emacs.", segment: "knowledge", sourceType: "tool_output" },

		// ─────────────── IMPORTANCE PAIRS — high-importance answer vs a low-importance
		// distractor that OUT-RANKS it on raw BM25 (repeats the query terms ⇒ higher
		// term-frequency), so plain-FTS ranks the distractor #1 and only the
		// effectiveScore modulation (BM25×eff + hybrid) lifts the important answer.
		//
		// HONEST SCOPE (eval-debate hardened): this shows the DIRECTION of the
		// modulation at the importance EXTREME, not a default-magnitude guarantee. The
		// modulator is DAMPED to 0.5+0.5·effective (scoring.ts) — a ≤2× swing that by
		// design CANNOT override a wider relevance gap — so the flip needs a large
		// importance gap (answer ~0.95 vs distractor 0.05); at default segment
		// importances (~0.6 vs ~0.4) the same raw-BM25 gap would NOT flip. All four
		// answers use NON-permanent segments (context/relationship) so the stated
		// importance actually routes through effectiveScore (an `identity`→permanent
		// answer would short-circuit to 1 and test TIER-pinning, not importance).
		{ key: "blood", content: "My blood type is O negative.", segment: "context", importance: 0.97 },
		{ key: "d-blood", content: "Blood type chart; blood type guide.", segment: "knowledge", importance: 0.05 },

		{ key: "med", content: "I take Metformin medication each day.", segment: "context", importance: 0.96 },
		{ key: "d-med", content: "Medication leaflet; medication take note.", segment: "knowledge", importance: 0.05 },

		{ key: "emerg", content: "My emergency contact is sister Anna.", segment: "relationship", importance: 0.95 },
		{ key: "d-emerg", content: "Emergency contact, emergency contact list.", segment: "context", importance: 0.05 },

		{ key: "gate", content: "My building gate code is 4417.", segment: "context", importance: 0.9 },
		{ key: "d-gate", content: "Gate code note; gate code memo.", segment: "knowledge", importance: 0.05 },

		// ─────────────── PRECISION — one answer amid sibling distractors (all trusted).
		{ key: "dog", content: "My dog name is Rex.", segment: "relationship" },
		{ key: "d-dog1", content: "My dog likes long evening walks.", segment: "context" },
		{ key: "d-dog2", content: "A neighbor dog barks every night.", segment: "knowledge" },

		{ key: "phone", content: "My phone is a folding Pixel.", segment: "context" },
		{ key: "d-phone1", content: "My phone bill is paid monthly.", segment: "context" },

		// ─────────────── CLEAN — single clear answer, no competition.
		{ key: "allergy", content: "I am allergic to shellfish.", segment: "identity", importance: 0.95 },
		{ key: "lang", content: "I speak French fluently.", segment: "identity" },
		{ key: "pet", content: "My cat is named Mochi.", segment: "relationship" },
		{ key: "proj", content: "I am building a memory framework called Tideline.", segment: "project" },

		// ─────────────── corpus noise (share no query term with any answer).
		{ key: "noise1", content: "The weather in the mountains is cold in winter.", segment: "knowledge" },
		{ key: "noise2", content: "A recipe for sourdough needs patience and flour.", segment: "knowledge" },
	],
	cases: [
		// POISON — relevant = the TRUSTED fact; the untrusted distractor must not win.
		{ id: "h-diet", query: "do I eat meat", relevantKeys: ["diet"], category: "poison" },
		{ id: "h-role", query: "what is my role", relevantKeys: ["role"], category: "poison" },
		{ id: "h-city", query: "where do I live", relevantKeys: ["city"], category: "poison" },
		{ id: "h-car", query: "what car do I drive", relevantKeys: ["car"], category: "poison" },
		{ id: "h-team", query: "who is my manager", relevantKeys: ["team"], category: "poison" },
		{ id: "h-tool", query: "what editor do I use", relevantKeys: ["tool"], category: "poison" },

		// IMPORTANCE — high-importance answer must out-rank the low-importance distractor.
		{ id: "h-blood", query: "what is my blood type", relevantKeys: ["blood"], category: "importance" },
		{ id: "h-med", query: "what medication do I take", relevantKeys: ["med"], category: "importance" },
		{ id: "h-emerg", query: "what is my emergency contact", relevantKeys: ["emerg"], category: "importance" },
		{ id: "h-gate", query: "what is my gate code", relevantKeys: ["gate"], category: "importance" },

		// PRECISION — best match should rank #1 amid siblings.
		{ id: "h-dog", query: "what is my dog name", relevantKeys: ["dog"], category: "precision" },
		{ id: "h-phone", query: "what phone do I have", relevantKeys: ["phone"], category: "precision" },

		// CLEAN.
		{ id: "h-allergy", query: "what am I allergic to", relevantKeys: ["allergy"], category: "single-session" },
		{ id: "h-lang", query: "what language do I speak", relevantKeys: ["lang"], category: "single-session" },
		{ id: "h-pet", query: "what is my cat name", relevantKeys: ["pet"], category: "single-session" },
		{ id: "h-proj", query: "what am I building", relevantKeys: ["proj"], category: "multi-session" },

		// ABSTENTION — nothing answers these.
		{ id: "h-movie", query: "what is my favorite movie", relevantKeys: [], category: "abstention" },
		{ id: "h-sport", query: "what sport do I play", relevantKeys: [], category: "abstention" },
		{ id: "h-shoe", query: "what is my shoe size", relevantKeys: [], category: "abstention" },
		{ id: "h-zodiac", query: "what is my zodiac sign", relevantKeys: [], category: "abstention" },
	],
};
