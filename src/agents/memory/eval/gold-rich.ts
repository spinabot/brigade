/**
 * RICH gold set (Tideline build Step 2/3 — the methodology-completeness tier).
 *
 * The synthetic + hard sets are SINGLE-RELEVANT: every case has exactly one
 * answer, so recall@k ≡ hit-rate and nDCG is a monotone transform of MRR — the
 * four reported metrics carry ONE bit of ranking signal per case (noted in
 * gold-hard.test.ts). This set adds the cases those can't express:
 *
 *   • MULTI-RELEVANT — a query whose answer is a SET of facts that all share a
 *     query term (lexically findable, so it's a fair ranking test, NOT a synonymy
 *     test — synonymy is the deferred learned-embedder lane). Now recall@k ("did
 *     we get ALL of them in the top-k?") and nDCG ("are they ranked above the
 *     distractors?") carry real, independent signal. Two of the five sets
 *     (ALLERGIES + TEAM) also carry a same-term DISTRACTOR (a generic/untrusted
 *     fact that shares the term but isn't the user's) so precision + trust matter;
 *     the remaining three (LANGUAGES, PROJECTS, MORNING ROUTINE) are pure
 *     multi-relevant without a distractor, isolating recall completeness.
 *   • TRANSITION CHAINS — a subject superseded twice (Lisbon→Berlin→Tokyo); only
 *     the CURRENT fact is relevant + the two stale ones are archived, so this
 *     verifies bi-temporal recall surfaces the live value and never a stale one.
 *   • MULTI-SESSION — multi-relevant facts that accumulated across sessions (the
 *     persistence the "model-switch" north-star reduces to for a RECALL metric;
 *     true model-switch CONTINUITY is a conversation-layer concern, not recall).
 *
 * Honesty: queries share LEXICAL terms with their relevant facts (BM25 can find
 * them); this measures RANKING of a known relevant set under competition, which
 * is exactly where BM25-primary + trust/importance modulation should beat a
 * weighted-sum fusion at the same (model-free) embedder. Pure-synonymy recall
 * (no shared term) is intentionally NOT here — that needs the learned embedder.
 */

import type { GoldSpec } from "./gold.js";

export const RICH_GOLD: GoldSpec = {
	facts: [
		// ── ALLERGIES (multi-relevant; all share "allergic") + an untrusted same-term distractor.
		{ key: "a-shellfish", content: "I am allergic to shellfish.", segment: "identity" },
		{ key: "a-penicillin", content: "I am allergic to penicillin.", segment: "identity" },
		{ key: "a-pollen", content: "I am allergic to pollen in the spring.", segment: "identity" },
		{ key: "a-distract", content: "A medical leaflet explains what being allergic means.", segment: "knowledge", sourceType: "retrieved_document" },

		// ── TEAM (multi-relevant; all share "team") + a same-term distractor.
		{ key: "t-priya", content: "Priya is my manager on the platform team.", segment: "relationship" },
		{ key: "t-sam", content: "Sam is a backend engineer on my team.", segment: "relationship" },
		{ key: "t-lee", content: "Lee is the designer on my team.", segment: "relationship" },
		{ key: "t-distract", content: "The sales team sits in a different building.", segment: "knowledge", sourceType: "tool_output" },

		// ── LANGUAGES (multi-relevant; all share "speak").
		{ key: "l-fr", content: "I speak French at a native level.", segment: "identity" },
		{ key: "l-ja", content: "I speak Japanese conversationally.", segment: "identity" },
		{ key: "l-pt", content: "I speak Portuguese fluently.", segment: "identity" },

		// ── PROJECTS (multi-relevant; all share "project").
		{ key: "pr-tide", content: "I am building the Tideline memory project.", segment: "project" },
		{ key: "pr-dash", content: "I am building the metahuman dashboard project.", segment: "project" },
		{ key: "pr-mobile", content: "I am building the mobile client project.", segment: "project" },

		// ── MORNING ROUTINE (multi-relevant, multi-session; all share "morning").
		{ key: "rt-coffee", content: "Every morning I drink a flat white before anything else.", segment: "preference" },
		{ key: "rt-gym", content: "I go to the gym every morning before work.", segment: "preference" },
		{ key: "rt-commute", content: "I commute by train every morning.", segment: "preference" },

		// ── TRANSITION CHAIN: city, superseded twice (all share "live"); only Tokyo is current.
		{ key: "c-lisbon", content: "I live in Lisbon.", segment: "identity" },
		{ key: "c-berlin", content: "I live in Berlin.", segment: "identity", supersedesKeys: ["c-lisbon"] },
		{ key: "c-tokyo", content: "I live in Tokyo.", segment: "identity", supersedesKeys: ["c-berlin"] },

		// ── TRANSITION CHAIN: role, superseded twice (all share "work as"); only principal is current.
		{ key: "r-intern", content: "I work as an intern.", segment: "project" },
		{ key: "r-eng", content: "I work as a software engineer.", segment: "project", supersedesKeys: ["r-intern"] },
		{ key: "r-principal", content: "I work as a principal engineer.", segment: "project", supersedesKeys: ["r-eng"] },

		// ── corpus noise (share no query term with any answer).
		{ key: "noise1", content: "Mountain weather turns cold in winter.", segment: "knowledge" },
		{ key: "noise2", content: "A sourdough recipe needs flour and patience.", segment: "knowledge" },
	],
	cases: [
		// MULTI-RELEVANT — relevant is the SET; where a same-term distractor exists (allergy, team) it must NOT crowd them out.
		{ id: "rc-allergy", query: "what am I allergic to", relevantKeys: ["a-shellfish", "a-penicillin", "a-pollen"], category: "multi-session" },
		{ id: "rc-team", query: "who is on my team", relevantKeys: ["t-priya", "t-sam", "t-lee"], category: "multi-session" },
		{ id: "rc-lang", query: "what languages do I speak", relevantKeys: ["l-fr", "l-ja", "l-pt"], category: "multi-session" },
		{ id: "rc-proj", query: "what projects am I building", relevantKeys: ["pr-tide", "pr-dash", "pr-mobile"], category: "multi-session" },
		{ id: "rc-routine", query: "what do I do every morning", relevantKeys: ["rt-coffee", "rt-gym", "rt-commute"], category: "multi-session" },

		// TRANSITION — only the CURRENT value is relevant; stale ones are archived.
		{ id: "rc-city", query: "where do I live", relevantKeys: ["c-tokyo"], category: "transition" },
		{ id: "rc-role", query: "what do I work as", relevantKeys: ["r-principal"], category: "transition" },

		// ABSTENTION — nothing answers these.
		{ id: "rc-movie", query: "what is my favorite movie", relevantKeys: [], category: "abstention" },
		{ id: "rc-shoe", query: "what is my shoe size", relevantKeys: [], category: "abstention" },
	],
};
