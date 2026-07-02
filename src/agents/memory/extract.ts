/**
 * Post-turn memory extraction — distillation algorithm run OFF the hot path.
 *
 * Design rationale (scalable / enterprise): the per-turn path stays at one
 * model call; the expensive distillation happens in a debounced background
 * sweep (driven by the long-lived gateway) that reads the NEW transcript
 * turns since a cursor, distills them in ONE extraction call (many turns →
 * one call), stores the resulting structured facts, and advances the
 * cursor. We deliberately avoid the alternative of running an extraction
 * LLM call after EVERY turn (≈2× model calls/turn, cost grows with
 * volume).
 *
 * This module is the engine + cursor. The LLM call is INJECTED
 * (`ExtractionLlm`) so the distillation logic is unit-testable without a
 * provider; production builds the injectable via `makeExtractionLlm` (an
 * isolated, tool-less, throwaway-transcript subagent). The gateway wires the
 * debounced trigger (see server.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import JSON5 from "json5";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { pickInitialThinkingLevel } from "../../core/model-caps.js";
import { awaitFactsFlush, factsFlushErrorCount, workspaceIdFromDir } from "../../storage/facts-cache.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { applyPersonaOverrideToSession } from "../../system-prompt/pi-injection.js";
import { wrapStreamFnWithPayloadMutations } from "../payload-mutators.js";
import { FactStore, MEMORY_SEGMENTS, type MemoryRecordOrigin, type MemorySegment, type MemorySourceType } from "./records.js";
import { confineUntrustedSegment } from "./write-gate.js";
import { balancedObjects } from "./json-scan.js";
import { stripReasoningTags } from "../../shared/reasoning-tags.js";
import {
	buildCandidateBlock,
	DEFAULT_CANDIDATE_K,
	fetchRelationshipCandidates,
	mapNewFactIds,
	pairToLinkArg,
	parseRelationshipRefs,
	RELATIONSHIP_PROMPT_FRAGMENT,
	resolveRelationshipPairs,
} from "./relationship-extract.js";

const log = createSubsystemLogger("memory/extract");

/* ───────────────────────── pre-compaction extraction hook ───────────────────────── */

/** Args for the pre-compaction hook — the turns about to be replaced by a summary. */
export interface PreCompactionExtractionArgs {
	agentId: string;
	sessionId: string;
	/** Snapshot of the session messages about to be compacted away. */
	messages: unknown[];
	/** The turn's memory origin (owner vs channel) — preserves Tideline isolation. */
	origin: MemoryRecordOrigin;
}

let preCompactionHook: ((args: PreCompactionExtractionArgs) => Promise<void>) | undefined;

/**
 * Register (or clear, with `undefined`) the hook that distils the about-to-be-
 * compacted history. The gateway wires this at boot to a bounded extraction over
 * the passed messages; unset elsewhere (tests, sub-agents) → a no-op. This closes
 * the window where a fact lives ONLY in turns the compactor is about to swap for a
 * summary — post-turn extraction + the reactive compaction guard catch the rest.
 */
export function setPreCompactionExtractionHook(
	fn: ((args: PreCompactionExtractionArgs) => Promise<void>) | undefined,
): void {
	preCompactionHook = fn;
}

/**
 * Fire the pre-compaction hook (if registered) over the caller's message SNAPSHOT —
 * FIRE-AND-FORGET so compaction proceeds without turn latency and without racing
 * the history replace (the snapshot is the hook's own immutable copy). Best-effort.
 */
export function runPreCompactionExtraction(args: PreCompactionExtractionArgs): void {
	const fn = preCompactionHook;
	if (!fn) return;
	void Promise.resolve(fn(args)).catch(() => {});
}

/** Cursor store — tracks how many transcript messages we've already distilled. */
const CURSOR_RELATIVE_PATH = path.join("memory", ".dreams", "extract-cursor.json");

/** Extraction prompt — distills a BATCH of recent turns into durable facts. */
export const EXTRACTION_PROMPT = `You are a memory-extraction subagent for a personal AI assistant.
You are given a slice of recent conversation (one or more USER/ASSISTANT turns).
Extract any DURABLE facts about the user or their world that are worth remembering long-term.

Return STRICT JSON only — no prose, no markdown fences:
{"facts":[{"content":"one clear self-contained sentence","segment":"identity|preference|correction|relationship|project|knowledge|context","importance":0.0,"corrects":"the prior belief, ONLY if segment=correction"}]}

Rules:
- Prefer few, high-quality facts over many trivial ones. Deduplicate within your output.
- Skip anything transient ("I'm tired right now"). Context facts describe ongoing state, not momentary feelings.
- Skip facts about YOU (the assistant) or the mechanics of the conversation.
- Segments: identity = who the user is; preference = how they like things done; correction = the user FIXED a prior belief (set "corrects"); relationship = people in their life; project = their work / conventions / goals; knowledge = durable facts they told you; context = ongoing situational state.
- Use "correction" (not preference/identity) when the user is fixing something rather than stating it fresh. "corrects" is ONLY for segment=correction.
- Importance defaults by segment: identity 0.85, correction 0.80, relationship 0.75, preference 0.70, project 0.65, knowledge 0.60, context 0.40. Trust the defaults unless something is unusually important or trivial.
- Return {"facts":[]} if nothing durable.
Respond with ONLY the JSON object.${RELATIONSHIP_PROMPT_FRAGMENT}`;

export interface ExtractedFact {
	content: string;
	segment: string;
	importance?: number;
	corrects?: string;
}

// `balancedObjects` lives in `./json-scan.js` (its own module) so `relationship-extract.ts`
// can reuse it WITHOUT importing this file — that would form a load-time cycle, since
// EXTRACTION_PROMPT above is built from relationship-extract.ts's prompt fragment at
// module top level. Re-exported here so existing importers (skill-review,
// skill-consolidate, consolidate) keep importing it from `extract.js` unchanged.
export { balancedObjects };

/**
 * Parse the extraction model's reply AND report whether the model returned a valid
 * reply ENVELOPE. Robust to prose-wrapped JSON, a trailing brace block, AND a
 * leading stray object: scans every top-level balanced `{...}` and uses the FIRST
 * that carries a `facts` array. Never throws.
 *
 * `parsedJson` is the load-bearing signal for cursor safety. It is TRUE only when
 * the model returned a recognizable ENVELOPE — an object with a `facts` array
 * (possibly empty), OR an empty object `{}` ("nothing to remember"). Both safely
 * advance the cursor. It is FALSE for: an empty / truncated / non-JSON reply, AND
 * for a MALFORMED-but-parseable reply that is NOT an envelope — a keyed object with
 * no `facts` array (`{foo: 1}`, or a bare fact object `{content, segment}` from a
 * model that dropped the envelope), or a top-level array `[{...}]` (whose inner
 * objects parse but carry no `facts` key). Those latter cases may carry real,
 * un-distilled content, so advancing past them would lose it forever — the caller
 * (`runExtractionSweep`) HOLDS the cursor when FALSE and the next sweep retries.
 */
export function parseExtractionReply(text: string): { facts: ExtractedFact[]; parsedJson: boolean } {
	if (!text) return { facts: [], parsedJson: false };
	// Local reasoning models (Ollama qwen3/deepseek-r1/ornith/…) emit their
	// chain-of-thought INLINE as <think>…</think> text around the JSON. Strip it
	// first so the balanced-brace scan finds the real envelope instead of braces
	// buried in the reasoning. No-op for frontier models (their reasoning is a
	// typed block, already excluded upstream — the text is clean JSON).
	const cleaned = stripReasoningTags(text);
	let sawEnvelope = false; // a structured "nothing to extract" — an empty object {}
	for (const block of balancedObjects(cleaned)) {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(block) as Record<string, unknown>;
		} catch {
			// Tolerant fallback: weak models slip on trailing commas, single quotes,
			// unquoted keys, // comments — all of which JSON5 accepts. Only reached
			// when strict JSON.parse already failed, so it never changes valid JSON.
			try {
				parsed = JSON5.parse(block) as Record<string, unknown>;
			} catch {
				continue;
			}
		}
		if (Array.isArray((parsed as { facts?: unknown }).facts)) {
			const out: ExtractedFact[] = [];
			for (const raw of (parsed as { facts: unknown[] }).facts) {
				if (!raw || typeof raw !== "object") continue;
				const f = raw as Record<string, unknown>;
				if (typeof f.content !== "string" || f.content.trim().length === 0) continue;
				if (typeof f.segment !== "string") continue;
				out.push({
					content: f.content.trim(),
					segment: f.segment,
					importance: typeof f.importance === "number" ? f.importance : undefined,
					corrects: typeof f.corrects === "string" ? f.corrects : undefined,
				});
			}
			return { facts: out, parsedJson: true };
		}
		// An EMPTY object {} is a structured "nothing to extract" — safe to advance.
		// A NON-empty object lacking a `facts` array (e.g. `{foo:1}`, or a bare fact
		// object the model emitted without the envelope, or the inner object of a
		// top-level `[{...}]` array) is MALFORMED and may carry un-distilled content,
		// so it is NOT an envelope: leave `sawEnvelope` false ⇒ the caller HOLDS.
		if (parsed !== null && typeof parsed === "object" && Object.keys(parsed).length === 0) sawEnvelope = true;
	}
	return { facts: [], parsedJson: sawEnvelope };
}

/** Parse the extraction model's reply into facts (back-compat thin wrapper —
 *  drops the `parsedJson` signal; use {@link parseExtractionReply} when the
 *  malformed-reply-vs-genuinely-empty distinction matters). Never throws. */
export function parseExtractedFacts(text: string): ExtractedFact[] {
	return parseExtractionReply(text).facts;
}

/**
 * Persist parsed facts to the FactStore. Skips unknown segments (rather than
 * crashing), clamps importance via the store, and stamps `corrects` into
 * metadata. Returns the number actually stored.
 */
export function storeExtractedFacts(
	workspaceDir: string,
	facts: ExtractedFact[],
	sourceTurn?: string,
	opts: { origin?: MemoryRecordOrigin; sourceType?: MemorySourceType } = {},
): number {
	if (facts.length === 0) return 0;
	const store = new FactStore(workspaceDir);
	// Auto-extraction is NEVER a direct owner statement — it is a distiller LLM's
	// reading of an attacker-influenceable transcript. Tag it `extraction` (the
	// write-gate's CONFINED tier) by default so a laundered "the user prefers X"
	// can't become an authoritative owner fact or supersede one. The ORIGIN
	// (owner vs channel) carries recall ISOLATION independently. An explicit
	// caller-supplied sourceType still wins (e.g. a future trusted distiller).
	const sourceType: MemorySourceType = opts.sourceType ?? "extraction";
	const origin = opts.origin;
	let stored = 0;
	for (const f of facts) {
		if (!MEMORY_SEGMENTS.includes(f.segment as MemorySegment)) continue;
		// IDEMPOTENCY (Fix 1): the distiller re-reads the SAME transcript turns the
		// operator may have already taught via `write_memory`, and a reworded copy
		// (segment `knowledge`, NO subjectKey) slips past write-time dedup's strict
		// near-exact bar — piling a subject-less churn twin beside the rich original,
		// which consolidation can then archive in place of the real one. So before
		// creating anything, check whether an equivalent active same-origin fact
		// already exists; if it does, REINFORCE it (more durable) and SKIP the new
		// row — re-seeing a known fact is a no-op, not a duplicate. (`supersedes`/
		// `corrects` distillations are NOT idempotency-skipped: those intend to
		// replace a prior belief, handled by the write path.)
		if (!f.corrects) {
			const known = store.findEquivalentActive(f.content, origin);
			if (known) {
				store.reinforce(known.memoryId, { minConfidence: known.confidence });
				continue;
			}
		}
		// Confine rather than drop: an untrusted distillation proposing a
		// protected segment (preference/identity/correction) lands as a descriptive
		// `knowledge` evidence fact (kept, but down-weighted at recall and unable to
		// pose as the operator's self-model). The write-gate is the hard backstop.
		const segment = confineUntrustedSegment(sourceType, f.segment as MemorySegment);
		try {
			store.write({
				content: f.content,
				segment,
				...(f.importance !== undefined ? { importance: f.importance } : {}),
				...(sourceTurn ? { sourceTurn } : {}),
				// ORIGIN — the isolation stamp. Peer-derived extraction MUST carry the
				// turn's CHANNEL origin (isolated by the origin filter) so it can't
				// surface as the operator's own ground truth; owner-turn extraction
				// passes the owner origin. Left undefined, a write resolves to OWNER.
				...(opts.origin ? { createdBy: opts.origin } : {}),
				sourceType,
				// `corrects` only belongs on a correction that SURVIVED confinement
				// (a trusted source's correction); a confined→knowledge fact drops it.
				...(f.corrects && segment === "correction" ? { metadata: { corrects: f.corrects } } : {}),
			});
			stored += 1;
		} catch (err) {
			// A BLOCKED write — the provenance write-gate (WriteGateError) or the
			// content threat-scan (MemoryThreatError) rejected this distilled fact.
			// Drop only THIS fact; the rest of the batch is independent and proceeds
			// (aborting the loop would lose the clean facts too). Anything else is an
			// unexpected fault — re-throw so it isn't silently swallowed.
			const name = err instanceof Error ? err.name : "";
			if (name === "MemoryThreatError" || name === "WriteGateError") continue;
			throw err;
		}
	}
	return stored;
}

/* ───────────────────────── cursor ───────────────────────── */

interface CursorFile {
	version: 1;
	/** sessionId → number of messages already distilled. */
	cursors: Record<string, number>;
}

function cursorPath(workspaceDir: string): string {
	return path.join(workspaceDir, CURSOR_RELATIVE_PATH);
}

// Convex-mode cursor cache — keyed `${workspaceDir}|${sessionId}` and primed
// lazily on first read (cursor misses default to 0, which is safe: the sweep
// simply re-distils from the start and write-time dedup absorbs repeats).
const convexCursorCache = new Map<string, number>();
let cursorFlushChain: Promise<void> = Promise.resolve();

/** Resolves when every cursor write enqueued so far reached the backend. */
export function awaitCursorFlush(): Promise<void> {
	return cursorFlushChain;
}

/** Test-only. */
export function __resetCursorCacheForTests(): void {
	convexCursorCache.clear();
	cursorFlushChain = Promise.resolve();
}

function readCursors(workspaceDir: string): CursorFile {
	try {
		const parsed = JSON.parse(fs.readFileSync(cursorPath(workspaceDir), "utf8")) as CursorFile;
		if (parsed && typeof parsed === "object" && parsed.cursors) return parsed;
	} catch {
		/* missing / corrupt → fresh */
	}
	return { version: 1, cursors: {} };
}

function writeCursor(workspaceDir: string, sessionId: string, processedCount: number): void {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		convexCursorCache.set(`${workspaceDir}|${sessionId}`, processedCount);
		const store = rctx.store;
		cursorFlushChain = cursorFlushChain
			.then(() => store.memory.setExtractCursor(sessionId, processedCount))
			.catch((err) => {
				console.error(
					`brigade: extract-cursor write to convex failed — ${(err as Error).message}`,
				);
			});
		return;
	}

	const file = readCursors(workspaceDir);
	file.cursors[sessionId] = processedCount;
	const p = cursorPath(workspaceDir);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
		fs.renameSync(tmp, p);
	} catch (err) {
		// Best-effort cleanup of the orphan tmp on any error before the
		// rename — leaving stale `.tmp-…` files under .dreams/ would be
		// visible noise on subsequent `ls` / git status. Re-throw after
		// cleanup so the caller's existing best-effort logging still fires.
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best-effort orphan-tmp cleanup
		}
		throw err;
	}
}

export function getCursor(workspaceDir: string, sessionId: string): number {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		// Lazy: a miss reads as 0 and the async backfill primes the cache for
		// the NEXT sweep. Re-distilling from 0 once is safe — write-time
		// dedup absorbs repeated facts.
		const key = `${workspaceDir}|${sessionId}`;
		const cached = convexCursorCache.get(key);
		if (cached !== undefined) return cached;
		void rctx.store.memory
			.getExtractCursor(sessionId)
			.then((n) => {
				if (!convexCursorCache.has(key)) convexCursorCache.set(key, n);
			})
			.catch(() => {});
		return 0;
	}
	return readCursors(workspaceDir).cursors[sessionId] ?? 0;
}

/* ───────────────────────── sweep ───────────────────────── */

/** Injectable distiller: given flattened conversation text, return the raw model reply. */
export type ExtractionLlm = (conversationText: string) => Promise<string>;

export interface SweepArgs {
	workspaceDir: string;
	sessionId: string;
	/** The full session message array (Pi `session.messages`). */
	messages: unknown[];
	/** The distiller (production: makeExtractionLlm; tests: a stub). */
	llm: ExtractionLlm;
	/** Minimum NEW messages since the cursor before a sweep runs. Default 2. */
	minNewMessages?: number;
	/**
	 * Origin to stamp on every extracted fact (`createdBy`). Owner-turn ⇒ owner
	 * scope; channel-turn ⇒ the peer's channel origin, so peer-derived facts are
	 * ISOLATED and can't poison the operator's recall. Omitted ⇒ owner-default
	 * (test-only convenience). The gateway always threads it from the turn.
	 */
	origin?: MemoryRecordOrigin;
	/** Provenance sourceType (e.g. "channel_message" for peer-derived facts). */
	sourceType?: MemorySourceType;
}

export interface SweepResult {
	ran: boolean;
	stored: number;
	processedTo: number;
}

// Bounded retry for UN-parseable extraction replies. When a model reliably
// returns non-JSON (some weak local models), the cursor is held and the SAME
// turns get re-distilled — a wasted LLM call — every sweep, FOREVER. After this
// many consecutive parse failures for a session we advance the cursor past the
// slice (accepting the lost distillation for those turns) so the loop can never
// run unbounded. Resets on any successful parse. In-memory by design: a gateway
// restart is a natural reset point and this only needs to bound a live run.
const MAX_EXTRACTION_PARSE_FAILURES = 3;
const extractionParseFailures = new Map<string, number>();

/**
 * Distill the NEW transcript messages since this session's cursor into facts.
 * Batches everything new into one LLM call, stores the result, advances the
 * cursor. No-op (without an LLM call) when there's too little new content.
 */
export async function runExtractionSweep(args: SweepArgs): Promise<SweepResult> {
	const total = args.messages.length;
	const storedCursor = getCursor(args.workspaceDir, args.sessionId);
	// COMPACTION GUARD: the cursor is a raw index into `session.messages`, but Pi can
	// REPLACE the history with a shorter summary (pre-emptive compaction at ~85% context
	// — exactly the long, fact-rich sessions extraction matters most for). A stored
	// cursor BEYOND the current length means that happened: re-scan from 0 so the
	// post-compaction turns are still distilled (write-time dedup absorbs any repeats)
	// instead of clamping to `total`, producing an empty slice, and permanently skipping
	// every turn until the message count climbs back above the stale cursor.
	const compacted = storedCursor > total;
	const from = compacted ? 0 : storedCursor;
	const fresh = args.messages.slice(from);
	const minNew = args.minNewMessages ?? 2;
	const conversation = flattenConversation(fresh);
	// Need at least one real exchange worth of text.
	if (fresh.length < minNew || conversation.trim().length === 0) {
		// Correct a stale post-compaction cursor even when there's too little to distill,
		// so it stops pointing past the (shrunken) transcript end on every later sweep.
		if (compacted) writeCursor(args.workspaceDir, args.sessionId, total);
		return { ran: false, stored: 0, processedTo: compacted ? total : from };
	}
	// RELATIONSHIP EXTRACTION (no extra LLM call): append a BOUNDED candidate set of
	// existing same-origin facts to the SAME extraction prompt, so the one extraction
	// call ALSO returns `relationships` between {new facts ∪ candidates}. We fetch the
	// top-K most-related existing facts via the existing hybrid recall (never the whole
	// store) using the fresh transcript text as the query. Best-effort: a recall hiccup
	// just yields no candidates (the model still relates new facts to each other).
	let candidateBlock = "";
	let candidateIds: Set<string> = new Set();
	try {
		const candidates = fetchRelationshipCandidates(
			new FactStore(args.workspaceDir),
			[conversation],
			args.origin,
			DEFAULT_CANDIDATE_K,
		);
		candidateBlock = buildCandidateBlock(candidates);
		candidateIds = new Set(candidates.map((c) => c.memoryId));
	} catch {
		/* no candidates → relationships limited to new↔new (still valuable) */
	}
	let reply = "";
	try {
		reply = await args.llm(conversation + candidateBlock);
	} catch (err) {
		log.warn("extraction llm failed; cursor not advanced", {
			sessionId: args.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ran: false, stored: 0, processedTo: from };
	}
	const { facts, parsedJson } = parseExtractionReply(reply);
	// ZERO-FACT GUARD: an empty / truncated / non-JSON reply (a transient distiller
	// hiccup) is NOT the same as the model returning a structured "nothing to extract"
	// (`{}` or `{facts: []}`). Advancing the cursor on the former would skip these
	// turns FOREVER. Hold the cursor and let the next sweep retry (idempotent;
	// write-time dedup absorbs any repeat). A structured empty reply (parsedJson=true,
	// facts=[]) falls through and advances as before — re-distilling it wastes calls.
	if (!parsedJson) {
		const fails = (extractionParseFailures.get(args.sessionId) ?? 0) + 1;
		if (fails >= MAX_EXTRACTION_PARSE_FAILURES) {
			// Repeatedly un-parseable → stop re-burning calls. Advance past this
			// slice (write-time dedup absorbs anything a later sweep does parse).
			extractionParseFailures.delete(args.sessionId);
			writeCursor(args.workspaceDir, args.sessionId, total);
			log.warn("extraction reply unparseable after repeated attempts; advancing cursor to stop retrying", {
				sessionId: args.sessionId,
				attempts: fails,
				replyChars: reply.length,
			});
			return { ran: false, stored: 0, processedTo: total };
		}
		extractionParseFailures.set(args.sessionId, fails);
		log.warn("extraction reply was not parseable JSON; cursor NOT advanced (next sweep retries)", {
			sessionId: args.sessionId,
			replyChars: reply.length,
			attempt: fails,
		});
		return { ran: false, stored: 0, processedTo: from };
	}
	// Parsed OK — reset this session's consecutive-failure counter.
	extractionParseFailures.delete(args.sessionId);
	const wsId = workspaceIdFromDir(args.workspaceDir);
	const errorsBefore = factsFlushErrorCount(wsId);
	const stored = storeExtractedFacts(args.workspaceDir, facts, args.sessionId, {
		...(args.origin ? { origin: args.origin } : {}),
		...(args.sourceType ? { sourceType: args.sourceType } : {}),
	});
	// CURSOR DURABILITY: in convex mode the facts write is enqueued ASYNC (the flush
	// chain); advancing the cursor before it lands would SKIP those turns forever if the
	// flush fails. Await the flush and only advance if it didn't error — otherwise leave
	// the cursor put so the next sweep re-distils (idempotent; write-time dedup absorbs
	// the repeat). In fs mode the chain is empty, so this awaits nothing and never trips.
	await awaitFactsFlush();
	if (factsFlushErrorCount(wsId) > errorsBefore) {
		log.warn("extraction facts flush failed; cursor NOT advanced (next sweep retries)", { sessionId: args.sessionId });
		return { ran: false, stored: 0, processedTo: from };
	}
	// SEMANTIC RELATIONSHIP EDGES — write the TYPED edges the SAME extraction reply
	// proposed (no extra LLM call; gleaning is reserved for the on-demand relink to keep
	// the per-turn path cheap). Map the just-written facts back to their stored memoryIds
	// (in emission order, so `new:<i>` resolves correctly), then resolve+validate the
	// model's pairs through the single chokepoint: both endpoints must be a REAL id (a
	// written new fact OR a candidate that was in the prompt), no self-edges, strict type
	// (closed taxonomy ∪ same_topic), reason mandatory, the strength filter, the
	// same_topic quarantine cap, deduped. `linkRelated` is same-origin + idempotent, so
	// this is origin-isolated and re-running adds nothing. Best-effort — never fails the
	// sweep (the facts already landed; edges are additive connective tissue).
	let relatesWritten = 0;
	try {
		const refs = parseRelationshipRefs(reply);
		if (refs.length > 0) {
			const store = new FactStore(args.workspaceDir);
			const newFactIds = mapNewFactIds(store, facts.map((f) => f.content), args.origin);
			const pairs = resolveRelationshipPairs(refs, newFactIds, candidateIds);
			if (pairs.length > 0) relatesWritten = store.linkRelated(pairs.map(pairToLinkArg));
		}
	} catch {
		/* edges are additive — a failure here never undoes the stored facts */
	}
	// Advance the cursor past everything we just considered (even if 0 stored —
	// re-distilling the same turns would only waste calls).
	writeCursor(args.workspaceDir, args.sessionId, total);
	log.info("extraction sweep", {
		sessionId: args.sessionId,
		newMessages: fresh.length,
		candidates: facts.length,
		stored,
		relates: relatesWritten,
	});
	return { ran: true, stored, processedTo: total };
}

/** Flatten Pi messages into "USER: …\n\nASSISTANT: …" text for the distiller. */
export function flattenConversation(messages: unknown[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as { role?: string; content?: unknown };
		if (msg.role !== "user" && msg.role !== "assistant") continue;
		const text = flattenContent(msg.content).trim();
		if (!text) continue;
		lines.push(`${msg.role === "user" ? "USER" : "ASSISTANT"}: ${text}`);
	}
	return lines.join("\n\n");
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("");
}

/* ───────────────────────── production distiller ───────────────────────── */

export interface MakeExtractionLlmArgs {
	workspaceDir: string;
	agentDir: string;
	authStorage: unknown;
	modelRegistry: unknown;
	model: unknown;
}

/**
 * Default wall-clock cap on a single isolated-LLM call (extraction or
 * consolidation sweep). 60s is generous for distillation prompts that return
 * ≤ a few hundred tokens; without a cap, a stuck provider (a hung Anthropic
 * request, a wedged local-Ollama, an unresponsive OpenRouter route) would
 * leave the sweep flag set forever and silently kill all future extraction
 * for that agent. Tunable via env for slower hosted models / debug runs.
 */
const MEMORY_LLM_TIMEOUT_MS_DEFAULT = 60_000;
function getMemoryLlmTimeoutMs(): number {
	const raw = process.env.BRIGADE_MEMORY_LLM_TIMEOUT_MS;
	const parsed = raw ? Number(raw) : NaN;
	// 5s floor so a misconfigured "0" / "1" doesn't preemptively kill every call.
	return Number.isFinite(parsed) && parsed >= 5_000 ? parsed : MEMORY_LLM_TIMEOUT_MS_DEFAULT;
}

/** Marker thrown when a memory sweep LLM call exceeds its wall-clock cap. */
export class MemoryLlmTimeoutError extends Error {
	readonly code = "memory-llm:timeout" as const;
	constructor(timeoutMs: number) {
		super(`memory LLM call exceeded ${timeoutMs}ms timeout`);
		this.name = "MemoryLlmTimeoutError";
	}
}

/**
 * Build an ISOLATED, tool-less subagent runner: a one-shot LLM call with
 * `systemPrompt` pinned, run against a throwaway transcript (deleted after) so
 * it never pollutes the real session. Reuses the resolved model/auth (inherits
 * Pi's auth-aware streamFn — never replaced). Shared by the extraction sweep
 * and the consolidation sweep; both cost one extra call per SWEEP, not per turn.
 *
 * Each call is bounded by `BRIGADE_MEMORY_LLM_TIMEOUT_MS` (default 60s) — on
 * timeout the underlying session is aborted and `MemoryLlmTimeoutError` is
 * thrown so the caller's existing catch path (which leaves the cursor put)
 * surfaces a silent stall as a recoverable log line on the next sweep.
 */
export function makeIsolatedLlm(
	systemPrompt: string,
	args: MakeExtractionLlmArgs,
): (input: string) => Promise<string> {
	return async (input: string): Promise<string> => {
		// `inMemory()` skips ALL persistence (both modes) — the isolated sweep
		// never touches disk. Convex mode additionally needs this so the sweep
		// writes nothing under ~/.brigade.
		const sessionManager = SessionManager.inMemory(args.workspaceDir);
		try {
			const { session } = await createAgentSession({
				cwd: args.workspaceDir,
				agentDir: args.agentDir,
				authStorage: args.authStorage as never,
				modelRegistry: args.modelRegistry as never,
				model: args.model as never,
				// Reasoning-aware: some models (Gemini 2.5 Pro, o-series) reject
				// "off". Derive a safe level rather than hardcoding it.
				thinkingLevel: pickInitialThinkingLevel(args.model as never),
				tools: [],
				customTools: [],
				sessionManager,
				resourceLoader: new DefaultResourceLoader({ cwd: args.workspaceDir, agentDir: args.agentDir }),
			} as never);
			if (!session) return "";
			// Isolated sweeps create their OWN Pi session, so they miss the
			// streamFn wrap the main agent-loop installs — without this, the
			// extraction's OpenRouter call leaks Pi's default "pi" / pi.dev
			// attribution (and skips the payload mutators) instead of reporting
			// as Brigade. Wrap here too so EVERY OpenRouter request Brigade makes
			// is attributed to Brigade.
			wrapStreamFnWithPayloadMutations(session as AgentSession);
			applyPersonaOverrideToSession(session as AgentSession, systemPrompt);
			// Race the LLM call against a wall-clock timeout. On timeout we
			// call `session.abort()` (Pi cancels the in-flight stream) and
			// reject so the caller's existing catch path triggers (cursor
			// stays put, throttle stamp unchanged, next sweep retries).
			const timeoutMs = getMemoryLlmTimeoutMs();
			let timer: ReturnType<typeof setTimeout> | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					// Best-effort abort — Pi's abort() is documented to never
					// throw, but we defensively swallow so the rejection below
					// is what surfaces to the caller.
					void (session as AgentSession).abort?.().catch(() => {});
					reject(new MemoryLlmTimeoutError(timeoutMs));
				}, timeoutMs);
				timer.unref?.();
			});
			try {
				await Promise.race([(session as AgentSession).prompt(input), timeoutPromise]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			return lastAssistantText(session as AgentSession);
		} finally {
			// inMemory() session — nothing to clean up; entries die with the
			// manager reference.
		}
	};
}

/**
 * The extraction distiller — `makeIsolatedLlm` with the EXTRACTION_PROMPT pinned.
 */
export function makeExtractionLlm(args: MakeExtractionLlmArgs): ExtractionLlm {
	return makeIsolatedLlm(EXTRACTION_PROMPT, args);
}

function lastAssistantText(session: AgentSession): string {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m?.role === "assistant") return flattenContent(m.content);
	}
	return "";
}
