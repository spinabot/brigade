/**
 * Generic inbound-message dedupe cache for channel adapters.
 *
 * Baileys (and most messaging providers) can re-deliver the same message after
 * a reconnect — same `msg.key.id`, same conversation, same text. Without
 * dedupe, the agent runs the LLM a second time, replies twice, and double-bills
 * the operator. This cache claims an id at first-sight and refuses it
 * thereafter; entries age out via LRU eviction (size cap) and TTL.
 *
 * Pure / process-lifetime / dependency-free. Adapters call `claim(id)` BEFORE
 * forwarding the message to the manager; a `false` return means "already seen,
 * drop it."
 */

export interface DedupeCache {
	/** True if this id has not been seen before (and is now claimed). */
	claim(id: string): boolean;
	/** Record an id without checking. Used to remember outbound message ids so
	 *  the inbound `fromMe` echo can be distinguished from a real self-chat. */
	remember(id: string): void;
	/** True if this id was recorded (claimed or remembered) and is still within
	 *  the TTL window. Non-mutating — does not refresh LRU position. */
	peek(id: string): boolean;
	/** Clear the cache (tests + shutdown). */
	clear(): void;
	/** Current size; mostly for tests + diagnostics. */
	readonly size: number;
}

export interface DedupeOptions {
	/** Maximum entries held; oldest are evicted when exceeded. */
	maxEntries?: number;
	/** Entries older than this are treated as never-seen. Defaults to 1h. */
	ttlMs?: number;
}

/** Build a fresh dedupe cache. Each adapter owns its own (per-channel). */
export function createDedupeCache(opts: DedupeOptions = {}): DedupeCache {
	const maxEntries = opts.maxEntries ?? 5_000;
	const ttlMs = opts.ttlMs ?? 60 * 60 * 1_000;
	// JS Maps iterate in insertion order, so re-inserting on hit makes it a
	// proper LRU: the oldest key is `map.keys().next().value`.
	const seen = new Map<string, number>(); // id → claimedAt epoch ms

	const evictExpiredAndOverflow = () => {
		const cutoff = Date.now() - ttlMs;
		// Drain old entries from the FRONT until none are expired.
		for (const [id, ts] of seen) {
			if (ts >= cutoff) break;
			seen.delete(id);
		}
		while (seen.size > maxEntries) {
			const oldest = seen.keys().next().value;
			if (oldest === undefined) break;
			seen.delete(oldest);
		}
	};

	return {
		claim(id: string): boolean {
			if (!id) return true; // can't dedupe a missing id — let it through
			// Drain expired entries first so we treat them as fresh, then check.
			evictExpiredAndOverflow();
			const existing = seen.get(id);
			if (existing !== undefined && Date.now() - existing < ttlMs) return false;
			seen.delete(id); // refresh LRU position
			seen.set(id, Date.now());
			// Cap the size AFTER the insert, otherwise inserting into a full
			// cache leaves it at maxEntries + 1.
			evictExpiredAndOverflow();
			return true;
		},
		remember(id: string): void {
			if (!id) return;
			seen.delete(id); // refresh LRU position so a re-remembered id is "new"
			seen.set(id, Date.now());
			evictExpiredAndOverflow();
		},
		peek(id: string): boolean {
			if (!id) return false;
			const existing = seen.get(id);
			if (existing === undefined) return false;
			return Date.now() - existing < ttlMs;
		},
		clear() {
			seen.clear();
		},
		get size() {
			return seen.size;
		},
	};
}
