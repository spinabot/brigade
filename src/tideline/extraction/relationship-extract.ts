/**
 * Semantic relationship extraction — the LLM-judged TYPED edges that turn the
 * memory graph into a web linked by MEANING, not by the structural subjectKey/hub
 * taxonomy.
 *
 * The problem this solves: the vault renders Map → topic-hub(subjectKey) → fact.
 * Facts link UP to their hub but never to EACH OTHER by meaning, and the model-free
 * embedder rarely fires a synonymy bridge. The renderer ALREADY turns a record's
 * typed edges into `## Related` `[[wikilinks]]` — the missing piece was that nothing
 * was MINTING real edges between semantically-related facts. The model does it here.
 *
 * RESEARCH-BACKED DESIGN (GraphRAG / Mem0 / Graphiti-Zep / LangChain
 * LLMGraphTransformer / Neo4j; PKM: Zettelkasten, Matuschak, Nick Milo). The field's
 * consensus, applied here:
 *   • TYPED vocabulary (a CLOSED set: causes/part_of/co_constrains/uses/… — see
 *     EXTRACTOR_FACTUAL_KINDS in links.ts) beats a single generic `relates`.
 *   • Each edge carries a REASON (justification → precision) + a STRENGTH 1-5 (the
 *     post-filter axis). Reason is MANDATORY.
 *   • A hard GATE: link only on a DIRECT, STATED basis — never on a shared topic /
 *     keyword / category / same-person co-occurrence. Plus a MULTI-VALUED guard
 *     (different objects of the same relation are NOT a contradiction).
 *   • Thematic / same-domain pairs (dark-mode ~ Obsidian "both tooling") are an
 *     over-linking risk → kept in a SEPARATE, capped, low-strength `same_topic` lane
 *     (the vault renders these in their own "## Same area" section), never mingled
 *     with the strong factual edges.
 *   • A GLEANING pass (one extra turn: "did you miss any directly-supported links?")
 *     for recall, capped at one pass and used in the on-demand relink.
 *
 * TWO entry points, ONE judgement core:
 *   1. Post-turn (incremental) — `buildCandidateBlock` + `resolveRelationshipPairs`.
 *      The post-turn extraction sweep appends a BOUNDED candidate set (top-K most-
 *      related existing same-origin facts, via hybrid recall) to the SAME extraction
 *      prompt and parses a `relationships` array out of the SAME reply. No extra
 *      per-turn LLM round-trip — the relationships ride the one extraction call.
 *      (Gleaning is OPTIONAL here to keep the per-turn path cheap.)
 *   2. On-demand (`runRelinkPass`) — a one-shot owner-gated maintenance pass over an
 *      origin's ACTIVE facts: identify ALL genuine relationships and write the edges,
 *      so the operator can populate real edges on their CURRENT facts immediately.
 *      Cost-bounded (windowed batches + a hard fact cap), idempotent, and it runs the
 *      GLEANING follow-up per window.
 *
 * HARD INVARIANTS (enforced in `resolveRelationshipPairs`, the single chokepoint):
 *   • NO FABRICATION — a pair is emitted only when BOTH endpoints resolve to a
 *     memoryId that EXISTS in the considered set. A hallucinated id is dropped.
 *   • NO SELF-EDGES — a == b is dropped.
 *   • STRICT TYPE — an edge whose `type` is not in the taxonomy (the closed factual
 *     set ∪ `same_topic`) is dropped. Reason MANDATORY (an edge with no reason is
 *     dropped). STRENGTH filter: a factual edge below MIN_FACTUAL_STRENGTH is dropped;
 *     `same_topic` is forced to the thematic ceiling and CAPPED per fact.
 *   • ORIGIN-SCOPED — the considered set is pre-filtered to ONE origin by the caller,
 *     and `linkRelated` is same-origin by contract; an edge can never relate
 *     owner↔channel.
 *   • DEDUPED — duplicate/mirror pairs collapse; `linkRelated` is itself idempotent
 *     (it skips an edge already present), so re-running writes nothing new.
 */

import type { ExtractionLlm } from "./extraction-llm.js";
import { isExtractorFactualKind, type MemoryLink, type MemoryLinkKind } from "../graph/links.js";
import { FactStore, type MemoryRecord, type MemoryRecordOrigin, type RecordOriginFilter } from "../store/records.js";
import { balancedObjects } from "./json-scan.js";

/* ───────────────────────── strength / cap policy ───────────────────────── */

/** Minimum strength (1-5) a FACTUAL edge must reach to be written. Below this the
 *  edge is dropped (the post-filter that turns the model's strength judgement into
 *  precision). 3 = "moderately supported" — weaker claims are noise. */
export const MIN_FACTUAL_STRENGTH = 3;

/** Thematic ceiling: a `same_topic` edge is ALWAYS clamped to at most this strength
 *  (it is a same-domain hint, not a strong relation — its claimed strength is
 *  irrelevant). Low by design so the vault renders it as the weak thematic link it is. */
export const SAME_TOPIC_STRENGTH = 2;

/** Max `same_topic` (thematic) edges kept PER fact in one resolution — few per fact,
 *  so a same-domain pair can appear honestly without webbing everything together. */
export const MAX_SAME_TOPIC_PER_FACT = 2;

/* ───────────────────────── shared prompt fragment + parsing ───────────────────────── */

/** The GATE — the precision instruction, shared by the per-turn fragment and the
 *  relink prompt. Kept verbatim-ish per the design so both paths judge identically. */
const RELATIONSHIP_GATE = [
	"Create an edge ONLY if there is a DIRECT, STATED basis AND surfacing one fact would",
	"genuinely help when looking at the other. Do NOT link two facts merely because they",
	"share a topic, category, keyword, or are about the same person — mere co-occurrence is",
	"NOT a relationship. (Example to REJECT: vegetarian + lives-in-Bangalore — no direct",
	"basis. Example to KEEP: vegetarian + peanut-allergy — both are dietary constraints that",
	"co-apply.) MULTI-VALUED GUARD: two facts that are DIFFERENT OBJECTS of the same relation",
	'(e.g. "owns a dog" and "owns a cat") are NOT a contradiction — do not mark them contrasts_with.',
].join("\n");

/** The TYPED taxonomy lines (closed set, one-line definitions) shared by both prompts. */
const RELATIONSHIP_TAXONOMY = [
	"Each edge MUST have a TYPE from this CLOSED set (use the most specific that fits):",
	"  • causes / caused_by — one fact is the reason for / a consequence of the other.",
	"  • part_of — one fact is a component or member of the other.",
	"  • precedes / follows — one happens before / after the other (sequence or schedule).",
	"  • enables / blocks — one makes the other possible / prevents it.",
	"  • co_constrains — two CONSTRAINTS that co-apply (e.g. two dietary rules, two limits).",
	"  • located_at — one fact is situated at/in the other (place or region).",
	"  • uses / works_on — one fact uses/depends on, or concerns work on, the other.",
	"  • contrasts_with — a genuine tension/contradiction between the two (flagged for review).",
	"  • relates_to — DISCOURAGED generic fallback; use ONLY with an especially strong reason.",
	"  • same_topic — THEMATIC / same-domain only (e.g. two unrelated tooling preferences). Use",
	"    this — NOT a factual type — whenever the only link is a shared area/category.",
].join("\n");

/**
 * The relationship half of the extraction output schema, appended to the
 * EXTRACTION_PROMPT so the model returns relationships in the SAME reply as the
 * facts (no second call). The model references NEW facts by their 0-based index in
 * the `facts` array it is emitting (`"new:0"`) and EXISTING candidate facts by the
 * `id` shown in the candidate block (`"mem_…"`).
 */
export const RELATIONSHIP_PROMPT_FRAGMENT = [
	"",
	"ALSO identify GENUINE, DIRECTLY-SUPPORTED relationships between facts — relate facts you",
	"are emitting now to EACH OTHER and to any EXISTING facts listed under EXISTING FACTS below.",
	"",
	RELATIONSHIP_GATE,
	"",
	RELATIONSHIP_TAXONOMY,
	"",
	'Each edge is {"a":<ref>,"b":<ref>,"type":<one of the types above>,"reason":<short why, MANDATORY>,"strength":<1-5>}.',
	"  • Reference a fact you are emitting now as \"new:<index>\" (0-based index into your facts array).",
	"  • Reference an EXISTING fact by the id shown in EXISTING FACTS (e.g. \"mem_ab12\"). NEVER invent an id.",
	"  • strength 1-5 = how direct/important the link is. Reserve 4-5 for strongly-stated links.",
	"  • No self-pairs. Prefer FEW high-quality edges over many. A `same_topic` edge is always weak.",
	"",
	"Extend the SAME JSON object with a \"relationships\" array:",
	'{"facts":[…],"relationships":[{"a":"new:0","b":"mem_ab12","type":"co_constrains","reason":"both are dietary constraints","strength":4}]}',
	'Omit "relationships" or use [] if there are no genuine relationships.',
].join("\n");

/**
 * The full prompt for the ON-DEMAND relink pass (no new facts — only existing ones).
 * The model is given the numbered fact set and returns typed relationship edges
 * referencing the printed ids ONLY. Tool-less; one call per batch window.
 */
export const RELINK_PROMPT = [
	"You are a memory-graph linker for a personal AI assistant.",
	"You are given a numbered list of the user's stored facts (each with an id and content).",
	"Identify GENUINE, DIRECTLY-SUPPORTED relationships between PAIRS of these facts.",
	"",
	RELATIONSHIP_GATE,
	"",
	RELATIONSHIP_TAXONOMY,
	"",
	"Return STRICT JSON only — no prose, no markdown fences:",
	'{"relationships":[{"a":"<id>","b":"<id>","type":"<type>","reason":"short why","strength":1-5}]}',
	"",
	"Rules:",
	"  • Use ONLY the ids printed in the list. NEVER invent an id. No self-pairs. Deduplicate.",
	"  • Every edge needs a TYPE from the closed set above and a MANDATORY reason. Prefer FEW high-quality edges.",
	'  • Return {"relationships":[]} if nothing is genuinely related.',
	"Respond with ONLY the JSON object.",
].join("\n");

/** The GLEANING follow-up — one extra turn asking the model to add any DIRECTLY-
 *  supported edges it missed, in the SAME format. Capped at one pass (the caller does
 *  not recurse). Recall booster; the gate still applies. */
export const GLEANING_PROMPT = [
	"Did you miss any DIRECTLY-SUPPORTED connections between the SAME facts (same ids)?",
	"Apply the same gate: a direct, stated basis — never a mere shared topic/keyword/person.",
	'Add ONLY new edges in the SAME JSON format ({"relationships":[{"a","b","type","reason","strength"}]}).',
	'If there are none, reply exactly {"relationships":[]}.',
].join("\n");

/** A single relationship as the model returns it (endpoints are unresolved refs). */
export interface RelationshipRef {
	a: string;
	b: string;
	/** Edge type — validated against the closed taxonomy in {@link resolveRelationshipPairs}. */
	type?: string;
	reason?: string;
	strength?: number;
}

/** A coerced strength in 1..5, or undefined when absent/garbage. */
function coerceStrength(v: unknown): number | undefined {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	const n = Math.round(v);
	return Math.max(1, Math.min(5, n));
}

/**
 * Parse a `relationships` array out of a model reply. Robust to prose/fences and a
 * leading stray object (same scan as {@link balancedObjects}): uses the FIRST top-
 * level balanced object that carries a `relationships` array. Never throws; returns
 * [] when absent. Drops malformed entries (missing/empty `a` or `b`). The `type`,
 * `reason`, and `strength` fields are carried through verbatim — strict TYPE
 * validation + the reason/strength gate live in {@link resolveRelationshipPairs}
 * (the single chokepoint), so this stays a pure parser.
 */
export function parseRelationshipRefs(text: string): RelationshipRef[] {
	if (!text) return [];
	for (const block of balancedObjects(text)) {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(block) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (Array.isArray((parsed as { relationships?: unknown }).relationships)) {
			const out: RelationshipRef[] = [];
			for (const raw of (parsed as { relationships: unknown[] }).relationships) {
				if (!raw || typeof raw !== "object") continue;
				const r = raw as Record<string, unknown>;
				if (typeof r.a !== "string" || typeof r.b !== "string") continue;
				const a = r.a.trim();
				const b = r.b.trim();
				if (!a || !b) continue;
				const strength = coerceStrength(r.strength);
				out.push({
					a,
					b,
					...(typeof r.type === "string" ? { type: r.type.trim() } : {}),
					...(typeof r.reason === "string" ? { reason: r.reason } : {}),
					...(strength !== undefined ? { strength } : {}),
				});
			}
			return out;
		}
	}
	return [];
}

/* ───────────────────────── bounded candidate retrieval ───────────────────────── */

/** Default cap on how many existing facts seed the per-turn relationship judgement.
 *  Small + high-signal: the model relates NEW facts to the most-related existing ones,
 *  NOT to the whole store (which would blow the prompt + cost on a large vault). */
export const DEFAULT_CANDIDATE_K = 10;

/**
 * Fetch a BOUNDED candidate set of existing ACTIVE same-origin facts most related to
 * the new facts, by reusing the existing hybrid recall (BM25 ⊕ vector) — NEVER the
 * whole store. We query with the concatenated new-fact text and take the top-K. The
 * candidate set is origin-filtered (peer facts never seed an owner turn's judgement).
 * Returns at most `k` records; passive (markAccessed:false — seeding the graph must
 * not reinforce decay on the candidates).
 */
export function fetchRelationshipCandidates(
	store: FactStore,
	newFactContents: readonly string[],
	origin: RecordOriginFilter,
	k: number = DEFAULT_CANDIDATE_K,
): MemoryRecord[] {
	const query = newFactContents.join("\n").trim();
	if (!query) return [];
	const limit = k > 0 ? k : DEFAULT_CANDIDATE_K;
	return store
		.recall(query, { limit, markAccessed: false, ...(origin !== undefined ? { origin } : {}) })
		.map(({ score: _score, ...rec }) => rec as MemoryRecord);
}

/**
 * Render the candidate set as the EXISTING FACTS block appended to the extraction
 * prompt. Each line is `[<id>] <content>` so the model can reference an existing fact
 * by its real memoryId. Returns "" when there are no candidates (the prompt then just
 * relates new facts to each other). Content is truncated defensively for prompt size.
 */
export function buildCandidateBlock(candidates: readonly MemoryRecord[]): string {
	if (candidates.length === 0) return "";
	const lines = candidates.map((r) => `[${r.memoryId}] ${r.content.slice(0, 200)}`);
	return ["", "EXISTING FACTS (relate the new facts to these where genuinely related):", ...lines].join("\n");
}

/* ───────────────────────── pair resolution + validation (the chokepoint) ───────────────────────── */

/**
 * A resolved, validated TYPED edge between two REAL memoryIds in the considered set.
 * The `kind` is a member of the closed taxonomy (factual ∪ `same_topic`); `reason` is
 * always present (the gate drops reason-less edges); `strength` is set (factual ≥
 * {@link MIN_FACTUAL_STRENGTH}; `same_topic` clamped to {@link SAME_TOPIC_STRENGTH}).
 */
export interface ResolvedPair {
	a: string;
	b: string;
	kind: MemoryLinkKind;
	reason: string;
	strength: number;
}

/**
 * Resolve model-returned relationship refs into validated, TYPED `{a,b,kind,reason,
 * strength}` edges — THE single place every guard lives.
 *
 *   • `newFactIds[i]` maps `"new:<i>"` → the memoryId of the i-th NEW fact actually
 *     written this turn (undefined entries — a fact that deduped/was-blocked and has
 *     no row — make that ref unresolvable, so it's dropped). For the on-demand relink
 *     pass there are no new facts; pass `[]`.
 *   • `existingIds` is the set of memoryIds the model was allowed to reference (the
 *     candidate set for the per-turn path; the batch window for relink). An `"mem_…"`
 *     ref is accepted ONLY if it is in this set — a hallucinated id is dropped.
 *
 * The guards, in order:
 *   1. NO FABRICATION / NO SELF-EDGE — both endpoints resolve to a real, DISTINCT id.
 *   2. STRICT TYPE — `type` must be a strong factual kind OR `same_topic`; anything
 *      else (absent, unknown, or a store-minted lifecycle kind the model must not
 *      mint) is dropped.
 *   3. REASON MANDATORY — an edge with no non-empty reason is dropped.
 *   4. STRENGTH FILTER — a FACTUAL edge below {@link MIN_FACTUAL_STRENGTH} is dropped
 *      (default strength {@link MIN_FACTUAL_STRENGTH} when the model omitted it, so a
 *      typed+reasoned edge isn't lost on a missing score); a `same_topic` edge is
 *      forced to {@link SAME_TOPIC_STRENGTH} regardless of the claimed value.
 *   5. SAME_TOPIC QUARANTINE CAP — at most {@link MAX_SAME_TOPIC_PER_FACT} thematic
 *      edges may touch any one fact (highest-strength-then-stable first).
 *   6. DEDUPE — order-independent on the unordered (a,b) pair; the FIRST surviving
 *      edge for a pair wins (a factual edge beats a later same_topic on the same pair,
 *      since the model is told to prefer the specific type).
 *
 * Origin isolation is the caller's job (the considered set is pre-filtered to one
 * origin) and is additionally guaranteed by `linkRelated` being same-origin by contract.
 */
export function resolveRelationshipPairs(
	refs: readonly RelationshipRef[],
	newFactIds: ReadonlyArray<string | undefined>,
	existingIds: ReadonlySet<string>,
): ResolvedPair[] {
	const resolve = (ref: string): string | undefined => {
		if (ref.startsWith("new:")) {
			const idx = Number.parseInt(ref.slice(4), 10);
			if (!Number.isInteger(idx) || idx < 0 || idx >= newFactIds.length) return undefined;
			return newFactIds[idx]; // may be undefined (a fact with no written row) → dropped
		}
		// An EXISTING-fact reference: accept ONLY an id actually in the considered set.
		return existingIds.has(ref) ? ref : undefined;
	};
	// Order-independent pair key WITHOUT a NUL byte (a raw NUL has bitten this codebase
	// twice). A `mem_…` id is `[a-z0-9_]` only, so a literal "|" is a printable separator
	// that can never occur INSIDE an id — two distinct ids can't collide on it.
	const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

	const seen = new Set<string>();
	const sameTopicDeg = new Map<string, number>();
	const deg = (id: string): number => sameTopicDeg.get(id) ?? 0;
	const out: ResolvedPair[] = [];

	for (const ref of refs) {
		const a = resolve(ref.a);
		const b = resolve(ref.b);
		if (!a || !b || a === b) continue; // (1) no fabrication, no self-edge

		// (2) STRICT TYPE — must be a strong factual kind OR the thematic same_topic.
		const type = ref.type ?? "";
		const isSameTopic = type === "same_topic";
		const isFactual = isExtractorFactualKind(type);
		if (!isSameTopic && !isFactual) continue; // absent / unknown / store-minted-only → drop

		// (3) REASON MANDATORY.
		const reason = (ref.reason ?? "").trim();
		if (!reason) continue;

		// (4) STRENGTH FILTER / clamp.
		let strength: number;
		if (isSameTopic) {
			strength = SAME_TOPIC_STRENGTH; // thematic edges are weak by definition
		} else {
			// A typed+reasoned factual edge with NO score defaults to the floor (kept),
			// but an explicit score below the floor is dropped (the precision filter).
			strength = ref.strength ?? MIN_FACTUAL_STRENGTH;
			if (strength < MIN_FACTUAL_STRENGTH) continue;
		}

		const key = pairKey(a, b);
		if (seen.has(key)) continue; // (6) dedupe (order-independent); first survivor wins

		// (5) SAME_TOPIC QUARANTINE CAP — cap thematic degree per endpoint.
		if (isSameTopic && (deg(a) >= MAX_SAME_TOPIC_PER_FACT || deg(b) >= MAX_SAME_TOPIC_PER_FACT)) continue;

		seen.add(key);
		if (isSameTopic) {
			sameTopicDeg.set(a, deg(a) + 1);
			sameTopicDeg.set(b, deg(b) + 1);
		}
		out.push({ a, b, kind: type as MemoryLinkKind, reason, strength });
	}
	return out;
}

/** Map a {@link ResolvedPair} to the `linkRelated` edge-arg shape (kept tiny so both
 *  entry points write edges identically). */
export function pairToLinkArg(p: ResolvedPair): {
	a: string;
	b: string;
	kind: MemoryLink["kind"];
	reason: string;
	strength: number;
} {
	return { a: p.a, b: p.b, kind: p.kind, reason: p.reason, strength: p.strength };
}

/**
 * Map the facts JUST written this turn back to their stored memoryIds, in the SAME
 * order as the `facts` array the model emitted — so `"new:<i>"` resolves to the right
 * record. We look each content up via the store's idempotency probe
 * ({@link FactStore.findEquivalentActive}), which finds the active same-origin record a
 * content corresponds to (the row write/dedup/reinforce landed on). A content with no
 * active row (blocked by the write-gate, or confined+dropped) maps to `undefined` →
 * its `"new:<i>"` refs are dropped downstream.
 */
export function mapNewFactIds(
	store: FactStore,
	contents: readonly string[],
	origin: MemoryRecordOrigin | undefined,
): Array<string | undefined> {
	return contents.map((c) => store.findEquivalentActive(c, origin)?.memoryId);
}

/* ───────────────────────── on-demand relink pass ───────────────────────── */

/** Default window size for the relink pass — how many facts go into ONE LLM call.
 *  Keeps a single prompt bounded; large active sets are processed in successive
 *  windows so cost grows linearly (and capped by {@link RELINK_MAX_FACTS}). */
export const RELINK_WINDOW = 40;

/** Hard cap on how many active facts a single relink invocation considers, so the
 *  cost of one operator click is bounded even on a very large vault. The most recent
 *  facts are kept (most likely to be the ones the operator cares to link now). */
export const RELINK_MAX_FACTS = 200;

/** The relink reviewer seam — runs {@link RELINK_PROMPT} over a numbered fact block →
 *  the raw model reply. Production = a tool-less isolated LLM; tests inject a stub.
 *  A second call with the {@link GLEANING_PROMPT} runs the optional recall booster. */
export type RelinkLlm = ExtractionLlm;

/**
 * Late-bound factory that builds the relink LLM for an agent's workspace. The
 * gateway registers this at boot (it has the agent's resolved model + auth +
 * registry to build a `makeIsolatedLlm(RELINK_PROMPT, …)` runner); the library and
 * tests leave it unset. `manage_memory`'s `relink` action consults it when no LLM is
 * injected directly — so the live tool can run relink WITHOUT plumbing model context
 * through the (pure, model-free) tool-assembly seam. Mirrors the
 * `setPreCompactionExtractionHook` boot-wiring pattern. Keyed by `agentId` (which the
 * tool registry already knows) so the gateway resolves the agent's auth/model/dir
 * directly — no fragile workspaceDir→agent reverse lookup. Returns `undefined` when
 * the agent can't be resolved (then the action honestly reports relink is unavailable).
 */
export type RelinkLlmFactory = (agentId: string) => RelinkLlm | undefined;

let relinkLlmFactory: RelinkLlmFactory | undefined;

/** Register (or clear, with `undefined`) the boot-wired relink-LLM factory. */
export function setRelinkLlmFactory(fn: RelinkLlmFactory | undefined): void {
	relinkLlmFactory = fn;
}

/** Resolve the relink LLM for an agent via the boot-wired factory (if any). */
export function resolveRelinkLlm(agentId: string): RelinkLlm | undefined {
	try {
		return relinkLlmFactory?.(agentId);
	} catch {
		return undefined;
	}
}

export interface RelinkResult {
	/** New typed link entries written across all windows. */
	edgesWritten: number;
	/** How many active facts were considered (after the cap). */
	considered: number;
	/** How many windows (LLM calls counted ONCE per window, gleaning excluded) were run. */
	windows: number;
}

/**
 * Render a window of facts as the numbered block the relink prompt consumes — each
 * line `[<id>] <content>`. Same `[id] content` shape as the per-turn candidate block,
 * so the model references facts by real memoryId.
 */
function renderRelinkBlock(records: readonly MemoryRecord[]): string {
	return records.map((r) => `[${r.memoryId}] ${r.content.slice(0, 200)}`).join("\n");
}

/**
 * One-shot LLM pass that identifies ALL genuine TYPED relationships among an origin's
 * ACTIVE facts and writes the edges. The operator's "populate real edges on my CURRENT
 * facts now" action.
 *
 * COST-BOUNDED: considers at most {@link RELINK_MAX_FACTS} active facts (most-recent
 * first), processed in {@link RELINK_WINDOW}-sized windows — one PRIMARY LLM call per
 * window (plus an optional GLEANING follow-up unless `glean:false`), so cost is linear
 * and capped. IDEMPOTENT: every edge goes through {@link FactStore.linkRelated}, which
 * dedupes against existing edges, so re-running adds nothing already present (and the
 * model's own dupes collapse in {@link resolveRelationshipPairs}).
 *
 * ORIGIN-SCOPED: operates on a single `origin` (the tool passes the owner origin);
 * the considered set is origin-filtered and `linkRelated` is same-origin by contract,
 * so no edge can ever relate owner↔channel.
 *
 * Best-effort per window: a window whose LLM call throws or returns garbage simply
 * contributes no edges (logged by the caller if desired) — the rest still run. The
 * gleaning follow-up is best-effort too (a throw there leaves the primary edges intact).
 */
export async function runRelinkPass(args: {
	store: FactStore;
	llm: RelinkLlm;
	origin: MemoryRecordOrigin;
	/** Test/override knobs. */
	windowSize?: number;
	maxFacts?: number;
	maxPerRecord?: number;
	/** Run the one gleaning follow-up per window (default true). */
	glean?: boolean;
}): Promise<RelinkResult> {
	const windowSize = args.windowSize && args.windowSize > 0 ? args.windowSize : RELINK_WINDOW;
	const maxFacts = args.maxFacts && args.maxFacts > 0 ? args.maxFacts : RELINK_MAX_FACTS;
	const glean = args.glean !== false;

	// Active, origin-scoped facts, most-recent first (FactStore.list already sorts
	// newest-first), capped. The cap keeps one operator click bounded on a huge vault.
	const active = args.store.list({ origin: args.origin }).slice(0, maxFacts);
	if (active.length < 2) return { edgesWritten: 0, considered: active.length, windows: 0 };

	let edgesWritten = 0;
	let windows = 0;
	for (let i = 0; i < active.length; i += windowSize) {
		const window = active.slice(i, i + windowSize);
		if (window.length < 2) break; // a lone trailing fact has nothing to pair
		const windowIds = new Set(window.map((r) => r.memoryId));
		windows += 1;
		const block = renderRelinkBlock(window);

		// PRIMARY pass.
		let reply = "";
		try {
			reply = await args.llm(block);
		} catch {
			continue; // best-effort: a wedged window contributes no edges
		}
		// No new facts in the relink pass → newFactIds is empty; every ref must resolve
		// to an id printed in THIS window (no fabrication, no cross-window leak).
		const pairs = resolveRelationshipPairs(parseRelationshipRefs(reply), [], windowIds);
		if (pairs.length > 0) {
			edgesWritten += args.store.linkRelated(
				pairs.map(pairToLinkArg),
				args.maxPerRecord !== undefined ? { maxPerRecord: args.maxPerRecord } : {},
			);
		}

		// GLEANING follow-up (one extra turn, capped at one) — recall booster. We pass the
		// block + the prior reply + the gleaning instruction so the model adds only MISSED
		// edges in the same format. Best-effort + idempotent (linkRelated dedupes), so it
		// can only ADD directly-supported edges, never undo or duplicate the primary ones.
		if (glean) {
			let gleanReply = "";
			try {
				gleanReply = await args.llm(`${block}\n\nYou previously replied:\n${reply}\n\n${GLEANING_PROMPT}`);
			} catch {
				gleanReply = ""; // a wedged gleaning turn leaves the primary edges intact
			}
			const gleanPairs = resolveRelationshipPairs(parseRelationshipRefs(gleanReply), [], windowIds);
			if (gleanPairs.length > 0) {
				edgesWritten += args.store.linkRelated(
					gleanPairs.map(pairToLinkArg),
					args.maxPerRecord !== undefined ? { maxPerRecord: args.maxPerRecord } : {},
				);
			}
		}
	}
	return { edgesWritten, considered: active.length, windows };
}
