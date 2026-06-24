/**
 * Slack workspace directory — operator-facing peer + channel listing for
 * routing-config (who/what can the bot be pointed at).
 *
 * Brigade's existing `user-directory.ts` is a per-message `id → display-name`
 * cache wired into the inbound hot path; it answers "what's THIS user's name"
 * one id at a time. This module answers the OTHER question an operator asks when
 * wiring routing: "list / search the people + channels in this workspace". It
 * pages `users.list` (people) and `conversations.list` (public + private
 * channels), filters by an optional case-insensitive query, and returns a flat
 * `{ id, name, handle }` shape suitable for an allow-list / routing picker.
 *
 * Token: the OPTIONAL user token (`xoxp-…`) is preferred when set, falling back
 * to the bot token. `users.list` / `conversations.list` read broadly; a
 * user-scoped token sees what the operator sees, while the bot token sees what
 * the app was granted. (Wave-4 audit flagged `userToken` as resolved-but-unused;
 * this is its consumer.)
 *
 * NO CLEAN SDK SLOT: the channel plugin contract reserves a `directory?: unknown`
 * field (types.plugin.ts) but nothing CONSUMES it — there is no live directory
 * wired into the send / routing path today (only the single-name
 * `messaging.targetResolver`). Rather than force a half-baked integration into a
 * dead slot, these are exported STANDALONE functions (see index.ts). When a real
 * directory slot lands, wire these into it.
 *
 * Network is injected (the `webFactory` seam) so this unit-tests with a fake and
 * never imports `@slack/web-api` unless actually called in production.
 */

import type { BrigadeConfig } from "../../../config/io.js";
import { resolveSlackBotToken, resolveSlackUserToken } from "./account-config.js";

/** A directory entry — a person or a channel the bot can be pointed at. */
export interface SlackDirectoryEntry {
	/** Slack id (`U…`/`W…` for a user, `C…`/`G…` for a channel). */
	id: string;
	/** Human display name (a user's display/real name, or a channel's name). */
	name: string;
	/** Addressable handle (`@alex` for a user, `#general` for a channel). Optional. */
	handle?: string;
}

/** One `users.list` member object (the subset we read). */
interface SlackListMember {
	id?: string;
	name?: string;
	real_name?: string;
	deleted?: boolean;
	is_bot?: boolean;
	profile?: { display_name?: string; real_name?: string };
}

/** One `conversations.list` channel object (the subset we read). */
interface SlackListChannel {
	id?: string;
	name?: string;
	is_archived?: boolean;
}

/** A paginated `users.list` response (the subset we read). */
interface SlackUsersListResponse {
	ok?: boolean;
	error?: string;
	members?: SlackListMember[];
	response_metadata?: { next_cursor?: string };
}

/** A paginated `conversations.list` response (the subset we read). */
interface SlackChannelsListResponse {
	ok?: boolean;
	error?: string;
	channels?: SlackListChannel[];
	response_metadata?: { next_cursor?: string };
}

/**
 * The minimal `@slack/web-api` slice the directory drives. Declared as an
 * interface so tests inject a fake with zero network; the real `WebClient`
 * structurally satisfies it.
 */
export interface SlackDirectoryWebClientLike {
	users: {
		list(args: { limit?: number; cursor?: string }): Promise<SlackUsersListResponse>;
	};
	conversations: {
		list(args: {
			types?: string;
			exclude_archived?: boolean;
			limit?: number;
			cursor?: string;
		}): Promise<SlackChannelsListResponse>;
	};
}

/** Page size + a hard page cap so a pathologically large workspace can't loop forever. */
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

/** Common options for both directory queries. */
export interface SlackDirectoryQuery {
	cfg: BrigadeConfig;
	/** Account (workspace) scope; defaults to the single-account "default". */
	accountId?: string;
	/** Case-insensitive substring filter over name/handle. Empty → no filter. */
	query?: string;
	/** Cap the number of returned rows. Omitted/≤0 → all matched rows. */
	limit?: number;
	/** Env for token resolution (defaults to process.env). */
	env?: NodeJS.ProcessEnv;
	/**
	 * TEST SEAM: build the WebClient from a token. Production omits this and the
	 * real `@slack/web-api` `WebClient` is lazy-imported. Receives the resolved
	 * read token so a fake can assert which token was used.
	 */
	webFactory?: (token: string) => SlackDirectoryWebClientLike;
}

/**
 * Resolve the READ token for directory calls: the user token (`xoxp-…`) when
 * set, else the bot token (`xoxb-…`). Empty string when neither resolves.
 */
function resolveReadToken(q: SlackDirectoryQuery): string {
	const env = q.env ?? process.env;
	const user = resolveSlackUserToken(q.cfg, q.accountId ?? null, env);
	if (user) return user;
	return resolveSlackBotToken(q.cfg, q.accountId ?? null, env);
}

/** Lazy-build a real `WebClient` (production) unless a test seam was supplied. */
async function buildClient(q: SlackDirectoryQuery, token: string): Promise<SlackDirectoryWebClientLike> {
	if (q.webFactory) return q.webFactory(token);
	const { WebClient } = await import("@slack/web-api");
	return new WebClient(token) as unknown as SlackDirectoryWebClientLike;
}

/** Case-insensitive substring match; an empty query matches everything. */
function matchesQuery(query: string, ...candidates: Array<string | undefined>): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	return candidates.some((c) => typeof c === "string" && c.toLowerCase().includes(q));
}

/**
 * List (and optionally filter) the PEOPLE in the workspace via `users.list`.
 * Deleted users are skipped. Returns `{ id, name, handle }` rows; `handle` is
 * the `@username` when present. Best-effort: an unauthorized / failed read
 * returns whatever was collected before the failure (often `[]`).
 */
export async function listSlackDirectoryPeers(q: SlackDirectoryQuery): Promise<SlackDirectoryEntry[]> {
	const token = resolveReadToken(q);
	if (!token) return [];
	const client = await buildClient(q, token);
	const query = (q.query ?? "").trim();
	const out: SlackDirectoryEntry[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		let res: SlackUsersListResponse;
		try {
			res = await client.users.list(cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE });
		} catch {
			break; // best-effort — return what we have
		}
		if (res?.ok === false) break;
		for (const m of res?.members ?? []) {
			const id = typeof m.id === "string" ? m.id.trim() : "";
			if (!id || m.deleted) continue;
			const handle = typeof m.name === "string" && m.name ? m.name : undefined;
			const name =
				m.profile?.display_name?.trim() ||
				m.profile?.real_name?.trim() ||
				m.real_name?.trim() ||
				handle ||
				id;
			if (!matchesQuery(query, name, handle, id)) continue;
			out.push({ id, name, ...(handle ? { handle: `@${handle}` } : {}) });
		}
		const next = res?.response_metadata?.next_cursor?.trim();
		cursor = next ? next : undefined;
		pages += 1;
	} while (cursor && pages < MAX_PAGES);
	return typeof q.limit === "number" && q.limit > 0 ? out.slice(0, q.limit) : out;
}

/**
 * List (and optionally filter) the CHANNELS in the workspace via
 * `conversations.list` (public + private). Archived channels are skipped.
 * Returns `{ id, name, handle }` rows with the `#name` handle. Best-effort like
 * {@link listSlackDirectoryPeers}.
 */
export async function listSlackDirectoryGroups(q: SlackDirectoryQuery): Promise<SlackDirectoryEntry[]> {
	const token = resolveReadToken(q);
	if (!token) return [];
	const client = await buildClient(q, token);
	const query = (q.query ?? "").trim();
	const out: SlackDirectoryEntry[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		let res: SlackChannelsListResponse;
		try {
			res = await client.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: PAGE_SIZE,
				...(cursor ? { cursor } : {}),
			});
		} catch {
			break; // best-effort
		}
		if (res?.ok === false) break;
		for (const c of res?.channels ?? []) {
			const id = typeof c.id === "string" ? c.id.trim() : "";
			const name = typeof c.name === "string" ? c.name.trim() : "";
			if (!id || !name || c.is_archived) continue;
			if (!matchesQuery(query, name, id)) continue;
			out.push({ id, name, handle: `#${name}` });
		}
		const next = res?.response_metadata?.next_cursor?.trim();
		cursor = next ? next : undefined;
		pages += 1;
	} while (cursor && pages < MAX_PAGES);
	return typeof q.limit === "number" && q.limit > 0 ? out.slice(0, q.limit) : out;
}
