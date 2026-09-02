/**
 * Durable session spend.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT REBUILD FROM THE TRANSCRIPT
 * ─────────────────────────────────────────────────────────────────────────
 * `UsageLedger` is in-memory, so a gateway restart zeroes every session's
 * spend and a reconnecting client showed `0 billed` until its first turn. The
 * obvious repair — fold the transcript's per-message `usage` on resume — was
 * tried and rejected under review, because it creates a SECOND definition of
 * one number, and the two disagree:
 *
 *   • Pi's `getSessionStats()` (what the turn-attach seed uses) counts only
 *     messages after the last compaction's `firstKeptEntryId`; a fold over the
 *     file counts everything. Measured on a real transcript: $18.16 vs $22.28,
 *     22.7% apart, with WHICHEVER SEEDS FIRST winning — so the same thread
 *     reported a different total depending on whether a client resumed or a
 *     channel message arrived first after a restart.
 *   • Rewind is non-destructive, so the file also holds abandoned branches.
 *   • In Convex mode `readTranscript` defaults to the OLDEST 1000 records, so
 *     the "uncapped" read silently truncated long threads — and because seeding
 *     is idempotent, that undercount could never be corrected.
 *   • It cost a second full read of a transcript that can reach 137 MB, ~480 ms
 *     of synchronous parsing on the gateway's shared event loop.
 *
 * None of that is fixable by patching the fold, because the disagreement is
 * about what the number MEANS. So the ledger's own answer is persisted instead:
 * what is written is exactly what was displayed, including out-of-band spend
 * (sub-agents, compaction, memory sweeps) that no transcript fold can recover,
 * and the `costComplete` flag that says whether the total is exact or a floor.
 *
 * The store already exists and is already written per session — this rides
 * alongside `leafEntryId` rather than introducing a file to keep in sync.
 *
 * A session last written by an older build has no record; it seeds nothing and
 * becomes correct after its next turn. That is a one-turn migration, and it is
 * strictly better than seeding a number known to be wrong.
 */

import { readSessionStore, updateSessionEntry } from "../../sessions/session-store.js";

/** The persisted shape. Deliberately flat and boring — it is read by a future build. */
export interface PersistedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	/** False when ANY contribution had an unknown cost, so the UI can say `≥`. */
	costComplete: boolean;
	/** Provider round-trips, for the turn counter. */
	turns: number;
	/** Epoch ms, so a stale record is recognisable. */
	at: number;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Persist a session's current totals.
 *
 * Best-effort by contract: bookkeeping must never fail a turn, so every error
 * is swallowed. The in-memory ledger remains authoritative for this process.
 */
export function persistSessionUsage(
	agentId: string,
	sessionKey: string,
	totals: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		costUsd: number;
		costComplete?: boolean;
	},
	turns: number,
): void {
	try {
		const rec: PersistedUsage = {
			input: num(totals.input),
			output: num(totals.output),
			cacheRead: num(totals.cacheRead),
			cacheWrite: num(totals.cacheWrite),
			costUsd: num(totals.costUsd),
			costComplete: totals.costComplete === true,
			turns: num(turns),
			at: Date.now(),
		};
		updateSessionEntry(agentId, sessionKey, { usageTotals: rec });
	} catch {
		/* a store write must never fail a turn */
	}
}

/**
 * Read back a session's persisted totals, or undefined when there are none.
 *
 * Returns undefined rather than zeros for a missing record, so a caller can
 * tell "never written" from "genuinely zero" — seeding the ledger with zeros
 * would mark it seeded and suppress the live seed that has the real history.
 */
export function readPersistedSessionUsage(
	agentId: string,
	sessionKey: string,
): PersistedUsage | undefined {
	try {
		const raw = readSessionStore(agentId).sessions?.[sessionKey]?.usageTotals;
		if (!raw || typeof raw !== "object") return undefined;
		const r = raw as Record<string, unknown>;
		// A record with nothing in it is not evidence of spend. Treat it as absent
		// so the turn-attach seed still gets its chance.
		const rec: PersistedUsage = {
			input: num(r.input),
			output: num(r.output),
			cacheRead: num(r.cacheRead),
			cacheWrite: num(r.cacheWrite),
			costUsd: num(r.costUsd),
			costComplete: r.costComplete === true,
			turns: num(r.turns),
			at: num(r.at),
		};
		const anyTokens = rec.input + rec.output + rec.cacheRead + rec.cacheWrite;
		if (anyTokens === 0 && rec.costUsd === 0) return undefined;
		return rec;
	} catch {
		return undefined;
	}
}
