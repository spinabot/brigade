/**
 * Synthetic hard-case gold set (Tideline build Step 2) — a self-contained
 * corpus + cases covering every taxonomy bucket, runnable today without the
 * operator's real data. The REAL gold set (export + decrypt the operator's
 * Convex facts + human-approve) is layered on top of this when we test
 * together; the synthetic set keeps CI honest in the meantime.
 *
 * Construction notes:
 *   - `job-old` is listed before `job-new`, which supersedes it — so the
 *     knowledge-update / transition cases must return the NEW employer and the
 *     archived old fact must NOT surface.
 *   - Every case shares enough query terms with NON-relevant facts that a
 *     careless lexical match would over-return — the gold answer is the one
 *     that should rank, not merely "a fact that contains the word".
 *   - Abstention cases have no matching fact at all.
 */

import type { GoldSpec } from "./gold.js";

export const SYNTHETIC_GOLD: GoldSpec = {
	facts: [
		{ key: "home", content: "I live in Hyderabad, India.", segment: "identity" },
		{ key: "lang", content: "My native language is Telugu.", segment: "identity" },
		{ key: "allergy", content: "I am allergic to peanuts.", segment: "identity", importance: 0.95 },
		{ key: "birthday", content: "My birthday is in May.", segment: "relationship" },
		{ key: "pet", content: "I have a dog named Biscuit.", segment: "relationship" },
		{ key: "pref-editor", content: "I prefer tabs over spaces when coding.", segment: "preference" },
		{ key: "pref-coffee", content: "I drink black coffee with no sugar.", segment: "preference" },
		{ key: "car", content: "I drive a blue Hyundai.", segment: "context" },
		{ key: "proj-tideline", content: "I am building Tideline, a memory framework for Brigade.", segment: "project" },
		// job-old MUST precede job-new (which supersedes it).
		{ key: "job-old", content: "I work at Acme Corp as a backend engineer.", segment: "project" },
		{
			key: "job-new",
			content: "I now work at Beta Labs as a staff engineer.",
			segment: "project",
			supersedesKeys: ["job-old"],
		},
	],
	cases: [
		{ id: "g-home", query: "where do I live", relevantKeys: ["home"], category: "single-session" },
		{ id: "g-coffee", query: "how do I take my coffee", relevantKeys: ["pref-coffee"], category: "preference" },
		{ id: "g-editor", query: "tabs or spaces", relevantKeys: ["pref-editor"], category: "preference" },
		{ id: "g-pet", query: "what is my dog's name", relevantKeys: ["pet"], category: "single-session" },
		{ id: "g-birthday", query: "when is my birthday", relevantKeys: ["birthday"], category: "temporal" },
		{ id: "g-build", query: "what am I building", relevantKeys: ["proj-tideline"], category: "multi-session" },
		{ id: "g-lang", query: "what language do I speak natively", relevantKeys: ["lang"], category: "single-session" },
		// knowledge-update: must return the NEW employer; the superseded old one is archived.
		{ id: "g-job-now", query: "where do I work now", relevantKeys: ["job-new"], category: "knowledge-update" },
		// transition: the move itself — current employer is the live answer. Query
		// shares the term "work" with job-new so bundled lexical recall can match it.
		{ id: "g-job-change", query: "what is my current job and where do I work", relevantKeys: ["job-new"], category: "transition" },
		// model-switch: a safety-critical fact that must remain recallable regardless of model.
		{ id: "g-allergy", query: "am I allergic to anything", relevantKeys: ["allergy"], category: "model-switch" },
		// abstention: nothing in the corpus answers these.
		{ id: "g-movie", query: "what is my favorite movie", relevantKeys: [], category: "abstention" },
		{ id: "g-shoe", query: "what is my shoe size", relevantKeys: [], category: "abstention" },
		// archived-fact guard: this query lexically matches job-old's content
		// ("Acme Corp"), but job-old is superseded and must NOT surface — so the
		// correct behavior is abstention. A job-old hit registers as a violation.
		// Phrased to share NO term with any ACTIVE fact ("Acme"/"Corp"/"employer"
		// live only in the archived job-old), honoring the no-matching-active-fact
		// abstention invariant above — only a recall that wrongly surfaces an
		// archived fact would hit here.
		{ id: "g-job-archived", query: "is Acme Corp my employer", relevantKeys: [], category: "abstention" },
	],
};
