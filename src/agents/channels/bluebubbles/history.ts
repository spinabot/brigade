/**
 * BlueBubbles rolling-history context fetch.
 *
 * When an untagged GROUP message arrives, the agent has no idea what the group
 * was just talking about — iMessage delivers one webhook per message with no
 * thread context. This module fetches the last N messages for the chat and
 * returns them as compact `{ sender, body }` entries the connection prepends to
 * the inbound as a fenced context block, so the agent replies INTO the
 * conversation rather than at a single stray line.
 *
 * BlueBubbles' message-listing endpoint shape varies by server version, so this
 * tries several known paths in order and accepts the first that returns a
 * recognised response (array / `data[]` / `messages[]`). `fetch` is INJECTABLE
 * (the test seam); never throws — a failure returns `{ entries: [], resolved:false }`
 * and the caller simply attaches no context.
 */

import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl, type FetchLike } from "./types.js";

/** One compact history line. */
export interface BlueBubblesHistoryEntry {
	/** Display name / handle of the speaker (or "me" for the bot's own past messages). */
	sender: string;
	/** Message text (truncated). */
	body: string;
	/** When it was sent (epoch ms), when known. */
	timestamp?: number;
	/** The message GUID, when known. */
	messageId?: string;
}

/** The result of a history fetch. `resolved` is false when every path failed. */
export interface BlueBubblesHistoryFetchResult {
	entries: BlueBubblesHistoryEntry[];
	resolved: boolean;
}

/** Args for a history fetch. */
export interface FetchBlueBubblesHistoryArgs {
	serverUrl: string;
	password: string;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
}

/** Hard ceiling on a single history fetch. */
const MAX_HISTORY_FETCH_LIMIT = 100;
/** How many records to scan looking for `limit` text-bearing ones. */
const HISTORY_SCAN_MULTIPLIER = 8;
const MAX_HISTORY_SCAN_MESSAGES = 500;
/** Cap on a single history line's length (keeps the context block bounded). */
const MAX_HISTORY_BODY_CHARS = 2_000;

/** One BlueBubbles message record (only the fields history reads). */
interface RawHistoryMessage {
	guid?: string;
	text?: string;
	handle_id?: string;
	is_from_me?: boolean;
	isFromMe?: boolean;
	date_created?: number;
	dateCreated?: number;
	date_delivered?: number;
	sender?: { address?: string; display_name?: string; displayName?: string };
	handle?: { address?: string; display_name?: string; displayName?: string } | string;
	[key: string]: unknown;
}

/** Clamp the requested limit into `[0, MAX]`. */
function clampHistoryLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 0;
	const n = Math.floor(limit);
	if (n <= 0) return 0;
	return Math.min(n, MAX_HISTORY_FETCH_LIMIT);
}

/** Truncate a history line body, marking the cut. */
function truncateBody(text: string): string {
	if (text.length <= MAX_HISTORY_BODY_CHARS) return text;
	return `${text.slice(0, MAX_HISTORY_BODY_CHARS).trimEnd()}...`;
}

/** Resolve a display label for a message's sender. */
function resolveSender(msg: RawHistoryMessage): string {
	if (msg.is_from_me === true || msg.isFromMe === true) return "me";
	const handleObj = typeof msg.handle === "object" && msg.handle ? msg.handle : undefined;
	return (
		msg.sender?.display_name ||
		msg.sender?.displayName ||
		msg.sender?.address ||
		handleObj?.display_name ||
		handleObj?.displayName ||
		handleObj?.address ||
		(typeof msg.handle === "string" ? msg.handle : undefined) ||
		msg.handle_id ||
		"Unknown"
	);
}

/**
 * Fetch recent message history for a chat. Tries several known endpoint shapes;
 * the first recognised response wins. Returns entries oldest-first (so a reader
 * sees the conversation in order), capped to `limit`. Never throws.
 */
export async function fetchBlueBubblesHistory(
	chatIdentifier: string,
	limit: number,
	args: FetchBlueBubblesHistoryArgs,
): Promise<BlueBubblesHistoryFetchResult> {
	const effectiveLimit = clampHistoryLimit(limit);
	if (!chatIdentifier.trim() || effectiveLimit <= 0) return { entries: [], resolved: true };

	const fetchOpts = {
		...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		...(args.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	};
	const encoded = encodeURIComponent(chatIdentifier);

	// Known listing shapes, in order — the first that returns a recognised body wins.
	const paths: Array<{ path: string; query?: Record<string, string | number> }> = [
		{ path: `chat/${encoded}/message`, query: { limit: effectiveLimit, sort: "DESC" } },
		{ path: `chat/${encoded}/messages`, query: { limit: effectiveLimit } },
		{ path: "messages", query: { chatGuid: chatIdentifier, limit: effectiveLimit } },
	];

	for (const { path, query } of paths) {
		try {
			const url = buildBlueBubblesApiUrl({ serverUrl: args.serverUrl, path, password: args.password, ...(query ? { query } : {}) });
			const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, fetchOpts);
			if (!res.ok) continue;
			const text = await res.text();
			const body = text ? (JSON.parse(text) as unknown) : null;
			if (!body) continue;
			const messages = extractMessageArray(body);
			if (!messages) continue;

			const entries: BlueBubblesHistoryEntry[] = [];
			const maxScan = Math.min(Math.max(effectiveLimit * HISTORY_SCAN_MULTIPLIER, effectiveLimit), MAX_HISTORY_SCAN_MESSAGES);
			for (let i = 0; i < messages.length && i < maxScan; i++) {
				const msg = messages[i] as RawHistoryMessage;
				if (!msg || typeof msg !== "object") continue;
				const t = (msg.text ?? "").trim();
				if (!t) continue;
				const timestamp = msg.date_created ?? msg.dateCreated ?? msg.date_delivered;
				entries.push({
					sender: resolveSender(msg),
					body: truncateBody(t),
					...(typeof timestamp === "number" ? { timestamp } : {}),
					...(typeof msg.guid === "string" ? { messageId: msg.guid } : {}),
				});
			}
			// Oldest-first so the agent reads the conversation in order.
			entries.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
			return { entries: entries.slice(0, effectiveLimit), resolved: true };
		} catch {
			continue;
		}
	}
	return { entries: [], resolved: false };
}

/** Pull a message array out of the various response shapes (array / data[] / messages[]). */
function extractMessageArray(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (body && typeof body === "object") {
		const rec = body as Record<string, unknown>;
		if (Array.isArray(rec.data)) return rec.data;
		if (Array.isArray(rec.messages)) return rec.messages;
	}
	return null;
}

/**
 * Render history entries as a clearly-fenced context block to PREPEND to the
 * inbound body. Returns "" when there are no entries. The block is delimited so
 * the agent can tell prior context from the current message.
 */
export function renderBlueBubblesHistoryBlock(entries: BlueBubblesHistoryEntry[]): string {
	if (!entries || entries.length === 0) return "";
	const lines = entries.map((e) => `${e.sender}: ${e.body}`);
	return ["[recent conversation context]", ...lines, "[end context]"].join("\n");
}
