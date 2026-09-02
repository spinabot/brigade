/**
 * Snapshot fields that can only be read from a LIVE Pi session, cached
 * PER SESSION.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS KEYED
 * ─────────────────────────────────────────────────────────────────────────
 * Context usage, message count and thinking capability can only be read off a
 * loaded session, so between turns the gateway serves the last known values.
 * They used to live in single module-level variables — one set for the whole
 * gateway — written by `refreshCachesFromSession` on EVERY Pi event of EVERY
 * turn of every agent and session, and then stamped into a snapshot that is
 * otherwise carefully per-binding.
 *
 * The result was cross-session contamination on the one surface an operator
 * watches constantly. With a TUI bound to a thread at 8k/200k, a WhatsApp
 * message arriving on a different session at 182k/200k rewrote the globals,
 * and the operator's own footer turned amber at 91%, `/context` drew a
 * near-full bar, and `/usage` reported 182k — for a thread using 4%. The
 * natural response is to compact or abandon a thread that needed neither.
 *
 * `contextWindow` made it worse: it was copied from whichever model last
 * streamed, so a session pinned to a 1M-window model displayed `/200k`.
 *
 * The same bug hit `messageCount` — which also gates the first-run bootstrap
 * flow, so a cron or channel turn on any session could suppress onboarding for
 * a genuinely fresh agent — and the thinking capabilities, so a turn on an
 * agent running a non-reasoning model made another agent's header claim its
 * model could not reason and emptied `/thinking`'s level list.
 *
 * This is the same defect class the usage ledger already fixed for spend ("an
 * idle agent's header showed another agent's spend"). Keying these the same way
 * finishes that job for the other half of the header.
 */

/** What one session's live-derived cache holds. `null` means known-unknown. */
export interface SessionCacheEntry {
	contextPercent: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	messageCount: number;
	supportsThinking?: boolean;
	thinkingLevels?: string[];
	updatedAt: number;
}

/**
 * Bounded per-session cache.
 *
 * The bound matters for the same reason the ledger's does: keys are
 * machine-generated (one per channel peer, per cron fire, per `/new`), so an
 * unbounded map is a slow leak on a long-lived gateway. Eviction is
 * least-recently-touched, and a READ touches as well as a write — the thread an
 * operator has open all day is read constantly and written rarely, and evicting
 * it because it is quiet is precisely backwards.
 */
export class SessionCaches {
	private readonly entries = new Map<string, SessionCacheEntry>();

	constructor(private readonly maxSessions = 2048) {}

	private key(agentId: string, sessionKey: string): string {
		// `\u0000` as the separator, written as an ESCAPE rather than a raw NUL
		// byte — a literal NUL makes the file BINARY to git, `grep` and most text
		// tooling, so changes ship unreviewed and searches skip the file silently.
		// The usage ledger documents the same trap; this file tripped it, and the
		// guard test caught it.
		return `${agentId}\u0000${sessionKey}`;
	}

	private touchKey(k: string): SessionCacheEntry | undefined {
		const e = this.entries.get(k);
		if (!e) return undefined;
		// Re-insert so iteration order is least-recently-USED. `Map.set` on an
		// existing key does not reorder it.
		this.entries.delete(k);
		this.entries.set(k, e);
		return e;
	}

	/** Read one session's cache, or undefined when nothing is known about it. */
	get(agentId: string, sessionKey: string): SessionCacheEntry | undefined {
		return this.touchKey(this.key(agentId, sessionKey));
	}

	/** Merge fields into one session's cache. */
	set(agentId: string, sessionKey: string, patch: Partial<SessionCacheEntry>): void {
		const k = this.key(agentId, sessionKey);
		const prev = this.touchKey(k);
		const next: SessionCacheEntry = {
			contextPercent: prev?.contextPercent ?? null,
			contextTokens: prev?.contextTokens ?? null,
			contextWindow: prev?.contextWindow ?? null,
			messageCount: prev?.messageCount ?? 0,
			...(prev?.supportsThinking !== undefined ? { supportsThinking: prev.supportsThinking } : {}),
			...(prev?.thinkingLevels !== undefined ? { thinkingLevels: prev.thinkingLevels } : {}),
			...patch,
			updatedAt: Date.now(),
		};
		this.entries.delete(k);
		this.entries.set(k, next);
		while (this.entries.size > this.maxSessions) {
			const oldest = this.entries.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	/** Drop one session's cache — used when a session is deleted. */
	forget(agentId: string, sessionKey: string): void {
		this.entries.delete(this.key(agentId, sessionKey));
	}

	/** Visible for tests. */
	size(): number {
		return this.entries.size;
	}
}
