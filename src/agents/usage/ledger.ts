/**
 * Per-(agent, session) usage ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * Usage accounting used to be three process-global scalars incremented from one
 * `turn_end` handler. That had four consequences, all of them wrong:
 *
 *   1. NOT PER-SESSION. Brigade runs many agents, each with many sessions. One
 *      counter meant an idle agent's header showed another agent's spend, and
 *      `/usage`'s "for this session" was a process-wide figure.
 *   2. NOT LIVE. Totals moved only at `turn_end`, so a 90-second turn showed
 *      the PREVIOUS turn's number for 89 of those seconds, then jumped.
 *   3. NOT DURABLE. A restart zeroed them, and resume then overwrote a client's
 *      correct numbers with zeros.
 *   4. BLIND TO MOST SPEND. Only the top-level turn was metered. Sub-agents,
 *      compaction summaries, and background memory sweeps — three headline
 *      features — contributed nothing, because accounting was a side effect of
 *      one event subscription rather than a thing the system owned.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE BUCKETS
 * ─────────────────────────────────────────────────────────────────────────
 * A session's displayed total is `committed + inFlight + outOfBand`:
 *
 *   - `committed`  completed turns of this session's own Pi loop. Seeded ONCE
 *                  from `getSessionStats()`, which derives from the loaded
 *                  transcript — so a restart recovers real history instead of
 *                  starting at zero.
 *   - `inFlight`   the assistant message currently streaming. Pi's provider
 *                  mutates `usage` in place as tokens arrive, so this is exact
 *                  rather than estimated. Cleared when the turn commits, which
 *                  is what keeps it from double-counting.
 *   - `outOfBand`  work this session CAUSED that ran outside its own Pi loop:
 *                  sub-agent runs, compaction summarization, memory extraction.
 *                  Billed to the operator, so it belongs on the operator's
 *                  meter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COST HONESTY
 * ─────────────────────────────────────────────────────────────────────────
 * Contributions arrive from providers with different billing modes, and some
 * carry no cost signal at all. Summing them into one number would silently
 * present a partial figure as a complete one, so the ledger tracks
 * `costComplete`: false as soon as ANY contribution had an unknown cost. A
 * renderer must then show the total as a floor ("≥ $0.42"), never as the truth.
 * This is the same discipline as `BillingMode.unknown` — an unmeasured turn
 * must never read as a free one.
 */

/** Token + cost totals for one bucket. */
export interface UsageTotals {
	/** Fresh (uncached) prompt tokens. */
	input: number;
	/** Generated tokens. */
	output: number;
	/** Prompt tokens served from cache — billed at a fraction of `input`. */
	cacheRead: number;
	/** Prompt tokens written to cache — billed at a premium over `input`. */
	cacheWrite: number;
	/** input + output + cacheRead + cacheWrite. */
	totalTokens: number;
	/** Spend in USD. A floor when `costComplete` is false. */
	costUsd: number;
	/** False once any contribution arrived without a cost signal. */
	costComplete: boolean;
}

/** Where an out-of-band contribution came from. Lets a UI explain a total. */
/**
 * Categories of spend the main usage stream cannot see.
 *
 * `skills` is separate from `memory` because the two sweeps have different
 * cadences and different owners — collapsing them would make it impossible to
 * answer "what is skill distillation costing me" without re-deriving it.
 */
export type OutOfBandKind = "subagent" | "compaction" | "memory" | "skills" | "other";

/** One session's ledger. */
export interface SessionUsage {
	agentId: string;
	sessionKey: string;
	committed: UsageTotals;
	inFlight: UsageTotals | null;
	outOfBand: UsageTotals;
	/** Per-source breakdown of `outOfBand`, so a UI can say WHERE the spend went. */
	outOfBandByKind: Partial<Record<OutOfBandKind, UsageTotals>>;
	/** Completed turns of this session's own loop. */
	turns: number;
	/** True once seeded from the transcript, so seeding happens exactly once. */
	seeded: boolean;
	updatedAt: number;
}

/** A usage contribution, in the shape Pi's `Usage` already provides. */
export interface UsageContribution {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number } | undefined;
	/**
	 * Whether the cost figure is real. Transports that genuinely cannot price a
	 * turn set this false; omitting it is treated as "known" only when a
	 * non-zero cost is present, so a silent zero never masquerades as measured.
	 */
	costKnown?: boolean;
}

export function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, costComplete: true };
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Normalize a raw contribution into totals.
 *
 * `totalTokens` is recomputed from the legs rather than trusted, because
 * different transports populate it with different conventions and a ledger that
 * inherited those would be unauditable.
 */
export function toTotals(u: UsageContribution | undefined): UsageTotals {
	if (!u) return emptyTotals();
	const input = num(u.input);
	const output = num(u.output);
	const cacheRead = num(u.cacheRead);
	const cacheWrite = num(u.cacheWrite);
	const costUsd = num(u.cost?.total);
	// A zero cost is only "known" when the transport says so. Otherwise a
	// provider that simply never priced the turn would read as free.
	// An EXPLICIT `costKnown: false` always wins, even when a cost is present:
	// a transport that says "this figure is partial" must not be overruled by
	// the figure being non-zero. Only when the flag is absent do we infer
	// completeness from a cost actually being reported.
	const costComplete = u.costKnown === undefined ? costUsd > 0 : u.costKnown === true;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		costUsd,
		costComplete,
	};
}

/** Sum two buckets. `costComplete` is conjunctive — one unknown taints the sum. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		costUsd: a.costUsd + b.costUsd,
		costComplete: a.costComplete && b.costComplete,
	};
}

function newEntry(agentId: string, sessionKey: string): SessionUsage {
	return {
		agentId,
		sessionKey,
		committed: emptyTotals(),
		inFlight: null,
		outOfBand: emptyTotals(),
		outOfBandByKind: {},
		turns: 0,
		seeded: false,
		updatedAt: Date.now(),
	};
}

/**
 * The ledger. A class rather than module state so the gateway owns one
 * instance and tests get a fresh one — module-global counters are exactly the
 * shape of the bug this replaces.
 */
export class UsageLedger {
	private readonly entries = new Map<string, SessionUsage>();

	/** Bound on distinct sessions retained, oldest-touched evicted first. */
	constructor(private readonly maxSessions = 2048) {}

	private key(agentId: string, sessionKey: string): string {
		// `\u0000` as the separator, written as an ESCAPE rather than a raw NUL byte.
		// A literal NUL in the source makes the file binary to `file`, `grep` and
		// most text tooling — this very line was invisible to an audit grep until
		// someone noticed the file reported as "data". The runtime value is
		// identical, and NUL remains the right separator: it cannot occur in an
		// agentId or a sessionKey, so the composite key stays unambiguous.
		return `${agentId}\u0000${sessionKey}`;
	}

	private touch(agentId: string, sessionKey: string): SessionUsage {
		const k = this.key(agentId, sessionKey);
		let e = this.entries.get(k);
		if (!e) {
			e = newEntry(agentId, sessionKey);
			this.entries.set(k, e);
		} else {
			// Re-insert so iteration order is least-recently-USED, not creation
			// order. A Map.set on an existing key does NOT reorder it, and relying
			// on that is precisely how the gateway's seq counters ended up evicting
			// the busiest session first.
			this.entries.delete(k);
			this.entries.set(k, e);
		}
		e.updatedAt = Date.now();
		this.evict();
		return e;
	}

	private evict(): void {
		while (this.entries.size > this.maxSessions) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	/**
	 * Seed a session's committed bucket from its transcript-derived stats.
	 * Idempotent: only the FIRST seed applies, so re-attaching a live session
	 * cannot double its history.
	 */
	/**
	 * Whether this session's history has already been folded in.
	 *
	 * Exposed so a caller can skip the READ that produces the stats, not just
	 * the seed. Rebuilding totals means walking a whole transcript, and on a
	 * busy gateway `resume` is called often enough that doing it per reconnect
	 * would be a real cost for an answer that cannot change.
	 */
	hasSeeded(agentId: string, sessionKey: string): boolean {
		return this.entries.get(this.key(agentId, sessionKey))?.seeded === true;
	}

	/**
	 * Seed from the ledger's OWN previously-persisted totals.
	 *
	 * Distinct from `seedFromStats` in one way that matters: this restores
	 * `costComplete` as recorded rather than inferring it from `cost > 0`.
	 * Inferring it turns a session that honestly rendered `≥$22.27` — because
	 * most of its turns came back unpriced — into a confident `$22.27`, which is
	 * precisely the "unmeasured reads as measured" failure this module exists to
	 * refuse. Measured on a real transcript: 169 of 207 assistant turns unpriced.
	 *
	 * Idempotent for the same reason `seedFromStats` is: whichever seed lands
	 * first wins, and a later one must not reset a bucket that live turns have
	 * since moved on from.
	 */
	seedFromPersisted(
		agentId: string,
		sessionKey: string,
		rec: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			costUsd: number;
			costComplete: boolean;
			turns: number;
		},
	): void {
		const e = this.touch(agentId, sessionKey);
		if (e.seeded) return;
		e.seeded = true;
		e.committed = {
			input: num(rec.input),
			output: num(rec.output),
			cacheRead: num(rec.cacheRead),
			cacheWrite: num(rec.cacheWrite),
			totalTokens:
				num(rec.input) + num(rec.output) + num(rec.cacheRead) + num(rec.cacheWrite),
			costUsd: num(rec.costUsd),
			costComplete: rec.costComplete === true,
		};
		e.turns = num(rec.turns);
	}

	/** Turn count, for persisting alongside the totals. */
	turnsFor(agentId: string, sessionKey: string): number {
		return this.peek(agentId, sessionKey)?.turns ?? 0;
	}

	seedFromStats(
		agentId: string,
		sessionKey: string,
		stats: {
			tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
			cost?: number;
			assistantMessages?: number;
		} | undefined,
	): void {
		const e = this.touch(agentId, sessionKey);
		if (e.seeded) return;
		e.seeded = true;
		if (!stats) return;
		const cost = num(stats.cost);
		e.committed = {
			input: num(stats.tokens?.input),
			output: num(stats.tokens?.output),
			cacheRead: num(stats.tokens?.cacheRead),
			cacheWrite: num(stats.tokens?.cacheWrite),
			totalTokens:
				num(stats.tokens?.input) +
				num(stats.tokens?.output) +
				num(stats.tokens?.cacheRead) +
				num(stats.tokens?.cacheWrite),
			costUsd: cost,
			// Transcript history predates any cost signal we can verify. Claiming
			// completeness here would present a restored session as fully measured.
			costComplete: cost > 0,
		};
		e.turns = num(stats.assistantMessages);
	}

	/** Start a turn — clears any stale in-flight state from an aborted one. */
	beginTurn(agentId: string, sessionKey: string): void {
		this.touch(agentId, sessionKey).inFlight = null;
	}

	/**
	 * Record the streaming message's usage. ABSOLUTE for the current assistant
	 * message (Pi mutates it in place as tokens arrive), so this REPLACES rather
	 * than adds — adding would compound every delta into nonsense.
	 */
	observePartial(agentId: string, sessionKey: string, usage: UsageContribution | undefined): void {
		this.touch(agentId, sessionKey).inFlight = toTotals(usage);
	}

	/**
	 * Commit a completed assistant message into `committed` and clear in-flight.
	 *
	 * Pi emits `turn_end` once per provider roundtrip, so a tool-using turn
	 * commits several times. That is correct — each roundtrip is separately
	 * billed.
	 */
	commitTurn(agentId: string, sessionKey: string, usage: UsageContribution | undefined): void {
		const e = this.touch(agentId, sessionKey);
		e.committed = addTotals(e.committed, toTotals(usage));
		e.inFlight = null;
		e.turns += 1;
	}

	/**
	 * Attribute spend that ran OUTSIDE this session's own loop but on its behalf.
	 * Without this, sub-agent fan-out, compaction summarization, and background
	 * memory sweeps are free by construction.
	 */
	recordOutOfBand(
		agentId: string,
		sessionKey: string,
		kind: OutOfBandKind,
		usage: UsageContribution | undefined,
	): void {
		const e = this.touch(agentId, sessionKey);
		const totals = toTotals(usage);
		e.outOfBand = addTotals(e.outOfBand, totals);
		e.outOfBandByKind[kind] = addTotals(e.outOfBandByKind[kind] ?? emptyTotals(), totals);
	}

	/** Raw entry, or undefined when the session has no ledger yet. */
	peek(agentId: string, sessionKey: string): SessionUsage | undefined {
		return this.entries.get(this.key(agentId, sessionKey));
	}

	/**
	 * The number to display: committed + in-flight + out-of-band. Returns zeroed
	 * totals for an unknown session rather than undefined, so a caller never has
	 * to choose between rendering `0` and rendering nothing.
	 */
	displayTotals(agentId: string, sessionKey: string): UsageTotals {
		const e = this.peek(agentId, sessionKey);
		if (!e) return emptyTotals();
		return addTotals(addTotals(e.committed, e.inFlight ?? emptyTotals()), e.outOfBand);
	}

	/** Every session this agent has a ledger for. */
	forAgent(agentId: string): SessionUsage[] {
		return [...this.entries.values()].filter((e) => e.agentId === agentId);
	}

	/** Rolled-up totals across every session of one agent. */
	agentTotals(agentId: string): UsageTotals {
		return this.forAgent(agentId).reduce(
			(acc, e) => addTotals(acc, this.displayTotals(e.agentId, e.sessionKey)),
			emptyTotals(),
		);
	}

	/** Number of tracked sessions — for tests and diagnostics. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Drop a session's ledger (session deleted).
	 *
	 * NOT a leak fix — `evict()` already bounds this map LRU-style, so nothing
	 * grows without limit whether or not anyone calls this. It is a CORRECTNESS
	 * fix.
	 *
	 * The bug it closes: the ledger is keyed by `(agentId, sessionKey)`, and
	 * `/new` rolls a fresh sessionId under the SAME sessionKey. A deleted
	 * session's spend therefore survives the delete and is inherited by the next
	 * conversation created under that key — the operator's brand-new thread opens
	 * already showing someone else's cost total.
	 *
	 * Wired at the gateway: `handleSessionsDelete` calls
	 * `deps.forgetSessionState?.(agentId, sessionKey)`
	 * (server-methods/sessions.ts), and `server.ts`'s `sessions.delete`
	 * registration supplies that dep — dropping this session's ledger, its
	 * reasoning state, and its retained frames together, since all three are
	 * keyed the same way and would otherwise be inherited as a set.
	 */
	forget(agentId: string, sessionKey: string): void {
		this.entries.delete(this.key(agentId, sessionKey));
	}
}
