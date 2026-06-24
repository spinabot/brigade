/**
 * Slack user-name directory — a small cached `id → display-name` resolver.
 *
 * Slack message events carry only the sender's user id (`U…` / `W…`); the human
 * name needs a `users.info` call. Doing that synchronously on the inbound hot
 * path would add a network round-trip per message, so this directory resolves
 * names in the BACKGROUND:
 *
 *   - `prime(id)` fires a memoized, non-blocking `users.info` and caches the
 *     resolved name.
 *   - `resolveNameSync(id)` reads whatever is currently cached (no network).
 *
 * So the FIRST message from a never-seen user surfaces the raw id; every message
 * after the prime settles surfaces the name. In a real workspace the bot sees
 * the same people repeatedly, so names appear almost immediately. Names are
 * cached with a TTL; failed / empty lookups are negative-cached briefly so a bad
 * id never hammers the API, and a concurrent burst for one id fires a single
 * request (in-flight de-dupe).
 *
 * Built over the injected `users.info` slice so it unit-tests with a fake — no
 * live workspace, no globals.
 */

/** The minimal `users.info` slice the directory drives (a `WebClient` satisfies it). */
export interface SlackUsersInfoApi {
	users?: {
		info?(args: { user: string }): Promise<{ ok?: boolean; error?: string; user?: SlackUserInfoUser }>;
	};
}

/** The subset of a Slack user object the directory reads for a display name. */
export interface SlackUserInfoUser {
	id?: string;
	name?: string;
	real_name?: string;
	profile?: { display_name?: string; real_name?: string };
}

export interface SlackUserDirectory {
	/** Read the cached display name for a user id (no network). Undefined when not cached yet. */
	resolveNameSync(id: string | undefined): string | undefined;
	/**
	 * Fire a memoized background `users.info` so the name is cached for next time.
	 * No-op when the id is empty, isn't a user id, is already fresh in the cache,
	 * or has a request in flight. Never throws, never blocks.
	 */
	prime(id: string | undefined): void;
}

/** Positive cache lifetime — a resolved name is reused for an hour. */
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
/** Negative cache lifetime — a failed / empty lookup is not retried for a minute. */
const NEGATIVE_TTL_MS = 60 * 1_000;

/**
 * A Slack human USER id is `U…` or `W…` (Enterprise Grid). Bot ids (`B…`),
 * channel ids (`C…`/`D…`/`G…`), and empties have no `users.info`, so we never
 * call for them.
 */
export function isSlackUserId(id: string): boolean {
	return /^[UW][A-Z0-9]+$/.test(id);
}

export function createSlackUserDirectory(args: {
	web: SlackUsersInfoApi | null;
	ttlMs?: number;
	negativeTtlMs?: number;
	/** Injectable clock for deterministic TTL tests (defaults to `Date.now`). */
	nowImpl?: () => number;
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}): SlackUserDirectory {
	const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
	const negativeTtlMs = args.negativeTtlMs ?? NEGATIVE_TTL_MS;
	const now = args.nowImpl ?? (() => Date.now());
	const cache = new Map<string, { name?: string; expiresAt: number }>();
	const inflight = new Set<string>();

	// Capture a `this`-bound `users.info` caller ONCE (null when the injected web
	// has no such slice — e.g. a test fake), so `prime` stays a safe no-op and the
	// call preserves the WebClient facet as its receiver.
	const usersApi = args.web?.users;
	const fetchUser =
		usersApi && usersApi.info ? (id: string) => usersApi.info!.call(usersApi, { user: id }) : null;

	const nameFromUser = (u: SlackUserInfoUser | undefined): string | undefined => {
		if (!u) return undefined;
		const candidate = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name;
		const trimmed = typeof candidate === "string" ? candidate.trim() : "";
		return trimmed || undefined;
	};

	const isFresh = (id: string): boolean => {
		const hit = cache.get(id);
		return hit !== undefined && hit.expiresAt > now();
	};

	const resolveNameSync = (id: string | undefined): string | undefined => {
		if (!id) return undefined;
		const hit = cache.get(id);
		if (hit && hit.expiresAt > now()) return hit.name;
		return undefined;
	};

	const prime = (id: string | undefined): void => {
		if (!id || !fetchUser) return;
		if (!isSlackUserId(id)) return;
		if (inflight.has(id) || isFresh(id)) return;
		inflight.add(id);
		void (async () => {
			try {
				const res = await fetchUser(id);
				const name = res && res.ok === false ? undefined : nameFromUser(res?.user);
				cache.set(id, { ...(name ? { name } : {}), expiresAt: now() + (name ? ttlMs : negativeTtlMs) });
			} catch (err) {
				// Negative-cache the failure so a transient/bad id isn't retried in a loop.
				cache.set(id, { expiresAt: now() + negativeTtlMs });
				args.log?.("slack users.info failed", {
					user: id,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				inflight.delete(id);
			}
		})();
	};

	return { resolveNameSync, prime };
}
