/**
 * Memory consolidation — the LEAN, off-hot-path semantic cleanup that handles
 * what write-time lexical dedup can't: CONTRADICTED facts (e.g. "user is on
 * Windows" lingering next to a later "user is on macOS now" correction the
 * model never wired with `supersedes`) and semantic (non-lexical) duplicates.
 *
 * Design (scalable): a SINGLE LLM call — given the active fact set, return
 * the ids to archive. (A 3-LLM debate Proposer/Adversary/Judge every 24h is
 * the heavier alternative; we explicitly avoid it.) It runs inside the
 * gateway's existing background sweep (off the hot path), THROTTLED
 * (default once / 30 min) and only when there are enough facts to be
 * worth it — so per-turn cost is unaffected and the extra call is rare.
 * Archive (not delete) keeps an audit trail; decay GC handles pure age-out
 * separately.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { tryGetRuntimeContext } from "../../storage/runtime-context.js";
import { makeIsolatedLlm, type MakeExtractionLlmArgs } from "./extract.js";
import { FactStore, originBucketKey, type MemoryRecord } from "./records.js";

const log = createSubsystemLogger("memory/consolidate");

const CONSOLIDATE_STATE_PATH = path.join("memory", ".dreams", "consolidate-state.json");
/** Skip consolidation below this many active facts (nothing to merge). */
const MIN_FACTS_TO_CONSOLIDATE = 6;
/** Throttle: at most one consolidation call per this window. */
export const DEFAULT_CONSOLIDATE_INTERVAL_MS = 30 * 60 * 1000;

export const CONSOLIDATION_PROMPT = `You are a memory-consolidation subagent for a personal AI assistant.
Below are the user's currently-remembered facts, each prefixed with an id.
Identify facts to ARCHIVE because they are EITHER:
- Contradicted or superseded by a newer / more-specific fact in the same list (keep the current one, archive the stale or now-wrong one), OR
- Redundant duplicates of another fact (keep the best, archive the rest).

Be CONSERVATIVE. Do NOT archive a fact merely for being old, low-importance, or narrowly specific. Only archive facts that are genuinely contradicted or duplicated by another fact present in the list. When in doubt, keep it. Never archive every copy of a fact — always keep one.

The user message contains the fact list (one per line: [id] (segment, importance) content).
Return STRICT JSON only, no prose, no fences:
{"archive":["<id>", ...]}
Use an empty array if nothing should be archived.`;

/** Parse the consolidation reply into the list of ids to archive. Never throws. */
export function parseConsolidationArchive(text: string): string[] {
	if (!text) return [];
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return [];
	try {
		const parsed = JSON.parse(match[0]) as { archive?: unknown };
		if (!Array.isArray(parsed.archive)) return [];
		return parsed.archive.filter((x): x is string => typeof x === "string" && x.length > 0);
	} catch {
		return [];
	}
}

export type ConsolidationLlm = (factsBlock: string) => Promise<string>;

export interface ConsolidationResult {
	ran: boolean;
	archived: number;
	considered: number;
}
// Origin-isolation bucket key is the CANONICAL one from records.ts (injective +
// accountId-aware) — a local copy previously drifted (unescaped ':' join could
// collide two distinct channel origins into one consolidation bucket).

/**
 * Run one consolidation pass: read active facts, ask the LLM which to archive,
 * validate the ids (only archive ones that actually exist + are active, and
 * never let it archive ALL of them via a runaway response), apply. LLM injected
 * for testability. No-op below `minFacts`.
 *
 * ORIGIN ISOLATION: facts are bucketed by origin and consolidated SEPARATELY —
 * the owner and each channel peer get their own LLM call. A single cross-origin
 * prompt would (a) expose one peer's private content to another's consolidation
 * and (b) let one origin's facts drive another's archival — both break the
 * `MemoryRecordOrigin` isolation invariant. One call per origin with >= minFacts.
 */
export async function runConsolidation(args: {
	workspaceDir: string;
	llm: ConsolidationLlm;
	minFacts?: number;
}): Promise<ConsolidationResult> {
	const store = new FactStore(args.workspaceDir);
	const active = store.list(); // active-only
	const min = args.minFacts ?? MIN_FACTS_TO_CONSOLIDATE;

	const buckets = new Map<string, MemoryRecord[]>();
	for (const f of active) {
		const key = originBucketKey(f);
		const arr = buckets.get(key);
		if (arr) arr.push(f);
		else buckets.set(key, [f]);
	}

	let ran = false;
	let archived = 0;
	for (const bucket of buckets.values()) {
		if (bucket.length < min) continue; // too few in this origin to be worth a call
		const block = bucket
			.map((f) => `[${f.memoryId}] (${f.segment}, importance ${f.importance.toFixed(2)}) ${f.content}`)
			.join("\n");
		let reply = "";
		try {
			reply = await args.llm(block);
		} catch (err) {
			log.warn("consolidation llm failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		ran = true;
		const requested = parseConsolidationArchive(reply);
		const bucketIds = new Set(bucket.map((f) => f.memoryId));
		let toArchive = requested.filter((id) => bucketIds.has(id));
		// Safety: never archive EVERYTHING in an origin (a runaway model emptying it).
		if (toArchive.length >= bucket.length) {
			log.warn("consolidation tried to archive all facts in an origin — refusing", {
				requested: toArchive.length,
				active: bucket.length,
			});
			toArchive = [];
		}
		if (toArchive.length > 0) store.setLifecycle(toArchive, "archived");
		archived += toArchive.length;
		log.info("consolidation sweep (origin)", { considered: bucket.length, archived: toArchive.length });
	}
	return { ran, archived, considered: active.length };
}

/* ───────────────────────── throttle ───────────────────────── */

function statePath(workspaceDir: string): string {
	return path.join(workspaceDir, CONSOLIDATE_STATE_PATH);
}

// Convex-mode throttle cache. A miss reads "eligible" once; the stamp lands
// both here and in the backend so subsequent ticks throttle normally.
// KNOWN LIMITATION (convex multi-agent, tracked): this stamp AND the backend SPI
// (getConsolidateLastRunAt / markConsolidateRunAt) are NOT keyed per workspace, so with
// ≥2 convex agents one agent's run throttles the others (non-primary agents under-
// consolidate). The complete fix threads a workspaceId through the SPI (mirroring the
// per-session extract cursor) + the convex schema. Filesystem mode is already
// per-workspace (the state file is under activeWorkspaceDir), so this only bites
// convex + multi-agent — deferred over a deep SPI/schema change at low blast radius.
let convexLastRunAt: number | undefined;

/** Test-only. */
export function __resetConsolidateCacheForTests(): void {
	convexLastRunAt = undefined;
}

/** True when consolidation hasn't run within `intervalMs` (and records nothing). */
export function shouldRunConsolidation(
	workspaceDir: string,
	intervalMs: number = DEFAULT_CONSOLIDATE_INTERVAL_MS,
	now: number = Date.now(),
): boolean {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		if (convexLastRunAt === undefined) {
			// Async backfill for the next tick; this tick reads "eligible" —
			// at worst consolidation runs once more than strictly needed,
			// which is harmless (it's idempotent over the same facts).
			void rctx.store.memory
				.getConsolidateLastRunAt()
				.then((at) => {
					if (convexLastRunAt === undefined && typeof at === "number") {
						convexLastRunAt = at;
					}
				})
				.catch(() => {});
			return true;
		}
		return now - convexLastRunAt >= intervalMs;
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(statePath(workspaceDir), "utf8")) as {
			lastRunAt?: number;
		};
		const last = typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : 0;
		return now - last >= intervalMs;
	} catch {
		return true; // no state yet → eligible
	}
}

/** Stamp the last-run time so the throttle window starts now. */
export function markConsolidationRun(workspaceDir: string, now: number = Date.now()): void {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode === "convex") {
		convexLastRunAt = now;
		void rctx.store.memory.markConsolidateRunAt(now).catch((err) => {
			console.error(
				`brigade: consolidate stamp to convex failed — ${(err as Error).message}`,
			);
		});
		return;
	}

	const p = statePath(workspaceDir);
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify({ lastRunAt: now }), "utf8");
		fs.renameSync(tmp, p);
	} catch {
		/* best-effort — a missed stamp just means consolidation may run again sooner */
	}
}

/** The consolidation distiller — `makeIsolatedLlm` with CONSOLIDATION_PROMPT pinned. */
export function makeConsolidationLlm(args: MakeExtractionLlmArgs): ConsolidationLlm {
	return makeIsolatedLlm(CONSOLIDATION_PROMPT, args);
}
