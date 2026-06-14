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

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { pickInitialThinkingLevel } from "../../core/model-caps.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { applyPersonaOverrideToSession } from "../../system-prompt/pi-injection.js";
import { wrapStreamFnWithPayloadMutations } from "../payload-mutators.js";
import { FactStore, MEMORY_SEGMENTS, type MemorySegment } from "./records.js";

const log = createSubsystemLogger("memory/extract");

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
Respond with ONLY the JSON object.`;

export interface ExtractedFact {
	content: string;
	segment: string;
	importance?: number;
	corrects?: string;
}

/**
 * Parse the extraction model's reply into facts. Robust to prose-wrapped
 * JSON (grabs the first `{...}` block via a permissive regex). Never throws.
 */
export function parseExtractedFacts(text: string): ExtractedFact[] {
	if (!text) return [];
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return [];
	let parsed: { facts?: unknown };
	try {
		parsed = JSON.parse(match[0]) as { facts?: unknown };
	} catch {
		return [];
	}
	if (!Array.isArray(parsed.facts)) return [];
	const out: ExtractedFact[] = [];
	for (const raw of parsed.facts) {
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
	return out;
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
): number {
	if (facts.length === 0) return 0;
	const store = new FactStore(workspaceDir);
	let stored = 0;
	for (const f of facts) {
		if (!MEMORY_SEGMENTS.includes(f.segment as MemorySegment)) continue;
		store.write({
			content: f.content,
			segment: f.segment as MemorySegment,
			...(f.importance !== undefined ? { importance: f.importance } : {}),
			...(sourceTurn ? { sourceTurn } : {}),
			// `corrects` only belongs on a correction; a misbehaving model
			// could attach it to any segment, so we drop it elsewhere.
			...(f.corrects && f.segment === "correction" ? { metadata: { corrects: f.corrects } } : {}),
		});
		stored += 1;
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
	const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(file), "utf8");
	fs.renameSync(tmp, p);
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
}

export interface SweepResult {
	ran: boolean;
	stored: number;
	processedTo: number;
}

/**
 * Distill the NEW transcript messages since this session's cursor into facts.
 * Batches everything new into one LLM call, stores the result, advances the
 * cursor. No-op (without an LLM call) when there's too little new content.
 */
export async function runExtractionSweep(args: SweepArgs): Promise<SweepResult> {
	const total = args.messages.length;
	const from = Math.min(getCursor(args.workspaceDir, args.sessionId), total);
	const fresh = args.messages.slice(from);
	const minNew = args.minNewMessages ?? 2;
	const conversation = flattenConversation(fresh);
	// Need at least one real exchange worth of text.
	if (fresh.length < minNew || conversation.trim().length === 0) {
		return { ran: false, stored: 0, processedTo: from };
	}
	let reply = "";
	try {
		reply = await args.llm(conversation);
	} catch (err) {
		log.warn("extraction llm failed; cursor not advanced", {
			sessionId: args.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return { ran: false, stored: 0, processedTo: from };
	}
	const facts = parseExtractedFacts(reply);
	const stored = storeExtractedFacts(args.workspaceDir, facts, args.sessionId);
	// Advance the cursor past everything we just considered (even if 0 stored —
	// re-distilling the same turns would only waste calls).
	writeCursor(args.workspaceDir, args.sessionId, total);
	log.info("extraction sweep", {
		sessionId: args.sessionId,
		newMessages: fresh.length,
		candidates: facts.length,
		stored,
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
		// Throwaway transcript — deleted right after the call in the old shape,
		// so writing it to disk at all was pure waste. `inMemory()` skips ALL
		// persistence (both modes); convex mode additionally needs this so the
		// isolated sweep writes nothing under ~/.brigade.
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
