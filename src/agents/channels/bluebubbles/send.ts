/**
 * BlueBubbles REST outbound.
 *
 * Every outbound action is a REST call to the BlueBubbles server, authenticated
 * by the password in the query string (see `types.ts`). `fetch` is INJECTABLE on
 * every function (the test seam) so the whole surface is exercised with no live
 * server.
 *
 * Surface:
 *   - `sendBlueBubblesText`       POST message/text (Private API adds reply-thread + effect)
 *   - `sendBlueBubblesAttachment` POST message/attachment (multipart; caption is a SEPARATE bubble after)
 *   - `reactBlueBubbles`          POST message/react (Private API)
 *   - `editBlueBubblesMessage`    POST message/{guid}/edit (Private API)
 *   - `unsendBlueBubblesMessage`  POST message/{guid}/unsend (Private API)
 *   - `createBlueBubblesChat`     POST chat/new (start a DM to a fresh handle)
 *   - `resolveChatGuid`           map a target (handle / chat_id / chat_identifier) → chatGuid
 *
 * iMessage has NO native media caption, so an attachment send with a caption is
 * delivered as the media bubble FOLLOWED BY a separate text bubble (the
 * connection layer orchestrates the second send).
 *
 * `bubbleSplit` splits outbound text on BLANK LINES so multi-paragraph replies
 * land as separate iMessage bubbles (each chunk = a separate text POST).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveEffectId } from "./effects.js";
import { normalizeBlueBubblesReaction } from "./reactions.js";
import { parseIMessageTarget } from "../imessage/targets.js";
import {
	blueBubblesFetchWithTimeout,
	buildBlueBubblesApiUrl,
	readBlueBubblesJson,
	type FetchLike,
} from "./types.js";

/** Shared REST args every send helper takes. */
export interface BlueBubblesRestBase {
	serverUrl: string;
	password: string;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
	/** When false, Private-API-only params (reply-thread, effect, react, edit…) are skipped/refused. */
	privateApiEnabled?: boolean;
	/** Allow private/LAN/loopback hosts through the SSRF guard (default TRUE for BlueBubbles). */
	allowPrivateNetwork?: boolean;
}

/**
 * Shared fetch-option assembly so every helper threads timeout + fetchImpl +
 * the SSRF private-network knob identically. `allowPrivateNetwork` defaults TRUE
 * (a BlueBubbles server is normally on the operator's LAN); only forwarded as
 * `false` when the operator tightened the knob.
 */
function fetchOpts(base: BlueBubblesRestBase): {
	timeoutMs?: number;
	fetchImpl?: FetchLike;
	allowPrivateNetwork?: boolean;
} {
	return {
		...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}),
		...(base.fetchImpl ? { fetchImpl: base.fetchImpl } : {}),
		...(base.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	};
}

/**
 * Split outbound text into iMessage bubbles on BLANK lines. A run of text with
 * no blank line stays one bubble; an empty result (whitespace only) yields []. A
 * source with no blank line yields a single-element array (one bubble).
 */
export function bubbleSplit(text: string): string[] {
	const src = (text ?? "").replace(/\r\n/g, "\n");
	if (!src.trim()) return [];
	return src
		.split(/\n\s*\n/)
		.map((b) => b.trim())
		.filter((b) => b.length > 0);
}

/** Result of an outbound send — the BlueBubbles message GUID when known. */
export interface BlueBubblesSendResult {
	messageId?: string;
}

/** Dig a message GUID out of a BlueBubbles send response (shape varies by version). */
function extractMessageGuid(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const rec = data as Record<string, unknown>;
	const direct = rec.guid ?? rec.messageGuid ?? rec.tempGuid;
	if (typeof direct === "string" && direct) return direct;
	return undefined;
}

/** Dig a chat GUID out of a chat/new (or chat/query) response. */
function extractChatGuid(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const rec = data as Record<string, unknown>;
	const direct = rec.chatGuid ?? rec.guid;
	if (typeof direct === "string" && direct) return direct;
	const chats = rec.chats;
	if (Array.isArray(chats) && chats[0] && typeof chats[0] === "object") {
		const g = (chats[0] as Record<string, unknown>).guid;
		if (typeof g === "string" && g) return g;
	}
	return undefined;
}

/**
 * Create a new chat to a fresh handle (DM). Returns the new chat GUID. Requires
 * the Private API for groups; a 1:1 chat may work without it on some servers.
 */
export async function createBlueBubblesChat(
	base: BlueBubblesRestBase,
	params: { address: string; message?: string },
): Promise<string> {
	const url = buildBlueBubblesApiUrl({ serverUrl: base.serverUrl, path: "chat/new", password: base.password });
	const res = await blueBubblesFetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				addresses: [params.address],
				message: params.message ?? "",
				tempGuid: `temp-${randomUUID()}`,
			}),
		},
		fetchOpts(base),
	);
	const data = await readBlueBubblesJson(res, "chat/new");
	const guid = extractChatGuid(data);
	if (!guid) throw new Error("BlueBubbles chat/new returned no chat GUID");
	return guid;
}

/** One chat record from a `chat/query` page (shape varies by server version). */
interface BlueBubblesChatRecord {
	guid?: string;
	chatGuid?: string;
	chatId?: number;
	id?: number;
	chat_id?: number;
	identifier?: string;
	chatIdentifier?: string;
	chat_identifier?: string;
	participants?: unknown[];
	handles?: unknown[];
	[key: string]: unknown;
}

/** Pull a chat GUID off a query record. */
function recordChatGuid(chat: BlueBubblesChatRecord): string | undefined {
	const g = chat.guid ?? chat.chatGuid;
	return typeof g === "string" && g ? g : undefined;
}

/** Pull the numeric chat id off a query record. */
function recordChatId(chat: BlueBubblesChatRecord): number | null {
	for (const c of [chat.chatId, chat.id, chat.chat_id]) {
		if (typeof c === "number" && Number.isFinite(c)) return c;
	}
	return null;
}

/** The third `;`-delimited component of a chat GUID is the chat identifier. */
function identifierFromChatGuid(chatGuid: string): string | null {
	const parts = chatGuid.split(";");
	if (parts.length < 3) return null;
	const id = (parts[2] ?? "").trim();
	return id || null;
}

/** Page through `chat/query` and return one page of chat records. */
async function queryBlueBubblesChats(
	base: BlueBubblesRestBase,
	params: { offset: number; limit: number },
): Promise<BlueBubblesChatRecord[]> {
	const url = buildBlueBubblesApiUrl({ serverUrl: base.serverUrl, path: "chat/query", password: base.password });
	const res = await blueBubblesFetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ limit: params.limit, offset: params.offset, with: ["participants"] }),
		},
		fetchOpts(base),
	);
	if (!res.ok) return [];
	const data = await readBlueBubblesJson<unknown>(res, "chat/query").catch(() => null);
	return Array.isArray(data) ? (data as BlueBubblesChatRecord[]) : [];
}

/**
 * Resolve an outbound conversation target to a real chatGuid.
 *
 *   - `chat_guid:` — passes straight through (the HOT inbound→reply path; the
 *     webhook always delivers the chatGuid).
 *   - `chat_id:` / `chat_identifier:` — looked up against the server via
 *     `chat/query` (paged), matching the numeric id or the GUID's identifier
 *     component. Passing these raw produced a silent 400 on a cold send.
 *   - `handle` — looked up by participant in existing DM chats; if none exists a
 *     fresh `chat/new` is created.
 *
 * Returns the resolved chatGuid. Throws when a `chat_id`/`chat_identifier`
 * target can't be resolved (the server has no such chat) rather than handing the
 * server a bad key.
 */
export async function resolveChatGuid(base: BlueBubblesRestBase, target: string): Promise<string> {
	const parsed = parseIMessageTarget(target);
	// Hot path — a chat GUID is already a server key.
	if (parsed.kind === "chat_guid") return parsed.chatGuid;

	const wantChatId = parsed.kind === "chat_id" ? parsed.chatId : null;
	const wantIdentifier = parsed.kind === "chat_identifier" ? parsed.chatIdentifier : null;
	const wantHandle = parsed.kind === "handle" ? parsed.to.trim() : "";

	const limit = 500;
	let participantMatch: string | null = null;
	for (let offset = 0; offset < 5000; offset += limit) {
		const chats = await queryBlueBubblesChats(base, { offset, limit });
		if (chats.length === 0) break;
		for (const chat of chats) {
			const guid = recordChatGuid(chat);
			if (wantChatId != null && recordChatId(chat) === wantChatId && guid) return guid;
			if (wantIdentifier) {
				if (guid && guid === wantIdentifier) return guid;
				if (guid && identifierFromChatGuid(guid) === wantIdentifier) return guid;
				const id =
					(typeof chat.identifier === "string" && chat.identifier) ||
					(typeof chat.chatIdentifier === "string" && chat.chatIdentifier) ||
					(typeof chat.chat_identifier === "string" && chat.chat_identifier) ||
					"";
				if (id && id === wantIdentifier && guid) return guid;
			}
			if (wantHandle && !participantMatch && guid && guid.includes(";-;")) {
				// Only DM chats (`;-;`) match a bare handle — never route a handle to a group.
				if (identifierFromChatGuid(guid) === wantHandle) participantMatch = guid;
			}
		}
	}

	if (wantHandle) {
		if (participantMatch) return participantMatch;
		// No existing chat for this handle — create a fresh DM.
		return createBlueBubblesChat(base, { address: wantHandle });
	}
	throw new Error(
		`BlueBubbles could not resolve a chat for target "${target}" (no matching chat on the server)`,
	);
}

/** Options for a text send. */
export interface SendTextOptions extends BlueBubblesRestBase {
	/** Native reply-thread target (Private API): the message GUID to reply to. */
	replyToMessageGuid?: string;
	/** Part index of the replied-to message (Private API). */
	replyToPartIndex?: number;
	/** A send effect name (balloons/confetti/slam/…) — Private API. */
	effect?: string;
}

/**
 * Send ONE text bubble to a chatGuid. Use `bubbleSplit` + a loop for
 * multi-bubble replies (the connection layer does this). Returns the message
 * GUID when the server reports one.
 */
export async function sendBlueBubblesText(
	chatGuid: string,
	message: string,
	opts: SendTextOptions,
): Promise<BlueBubblesSendResult> {
	const payload: Record<string, unknown> = {
		chatGuid,
		tempGuid: randomUUID(),
		message,
	};
	if (opts.privateApiEnabled) {
		payload.method = "private-api";
		if (opts.replyToMessageGuid) {
			payload.selectedMessageGuid = opts.replyToMessageGuid;
			payload.partIndex = opts.replyToPartIndex ?? 0;
		}
		const effectId = opts.effect ? resolveEffectId(opts.effect) : undefined;
		if (effectId) payload.effectId = effectId;
	}
	const url = buildBlueBubblesApiUrl({ serverUrl: opts.serverUrl, path: "message/text", password: opts.password });
	const res = await blueBubblesFetchWithTimeout(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
		fetchOpts(opts),
	);
	const data = await readBlueBubblesJson(res, "message/text");
	const guid = extractMessageGuid(data);
	return guid ? { messageId: guid } : {};
}

/** Sanitise a filename for a multipart header (CWE-93 / header injection guard). */
function sanitizeFilename(name: string): string {
	const base = path.basename(name || "attachment").replace(/[\r\n"\\]/g, "_").trim();
	return base || "attachment";
}

/** Options for an attachment send. */
export interface SendAttachmentOptions extends BlueBubblesRestBase {
	/** Local file path to upload. */
	filePath: string;
	/** Override the multipart filename (e.g. an extension coerced by the voice pre-flight). Defaults to the basename of `filePath`. */
	fileName?: string;
	/** MIME content type, when known. */
	contentType?: string;
	/** Send as a voice memo (BlueBubbles converts mp3→caf when set). */
	asVoice?: boolean;
	/** Native reply-thread target (Private API). */
	replyToMessageGuid?: string;
	replyToPartIndex?: number;
	/** Pre-read bytes (TEST SEAM — bypass disk read). */
	bytes?: Uint8Array;
}

/**
 * Send a media attachment via multipart. iMessage has NO native caption, so the
 * caller sends any caption as a SEPARATE text bubble AFTER this (handled by the
 * connection layer). Returns the message GUID when reported.
 */
export async function sendBlueBubblesAttachment(
	chatGuid: string,
	opts: SendAttachmentOptions,
): Promise<BlueBubblesSendResult> {
	const bytes = opts.bytes ?? new Uint8Array(await readFile(opts.filePath));
	const filename = sanitizeFilename(opts.fileName ?? opts.filePath);
	const form = new FormData();
	// Copy into a fresh ArrayBuffer so the Blob ctor accepts it across lib targets.
	const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const blob = new Blob([ab], opts.contentType ? { type: opts.contentType } : {});
	form.append("attachment", blob, filename);
	form.append("chatGuid", chatGuid);
	form.append("name", filename);
	form.append("tempGuid", `temp-${Date.now()}-${randomUUID().slice(0, 8)}`);
	if (opts.privateApiEnabled) form.append("method", "private-api");
	if (opts.asVoice) form.append("isAudioMessage", "true");
	if (opts.privateApiEnabled && opts.replyToMessageGuid) {
		form.append("selectedMessageGuid", opts.replyToMessageGuid);
		form.append("partIndex", String(opts.replyToPartIndex ?? 0));
	}
	const url = buildBlueBubblesApiUrl({ serverUrl: opts.serverUrl, path: "message/attachment", password: opts.password });
	const res = await blueBubblesFetchWithTimeout(
		url,
		{ method: "POST", body: form },
		// Attachments can be large — give a generous default upload timeout.
		{ ...fetchOpts(opts), timeoutMs: opts.timeoutMs ?? 60_000 },
	);
	const data = await readBlueBubblesJson(res, "message/attachment");
	const guid = extractMessageGuid(data);
	return guid ? { messageId: guid } : {};
}

/**
 * Add or remove a tapback reaction on a message (Private API). `reaction` is any
 * input `normalizeBlueBubblesReaction` accepts (`"love"`, `"👍"`, `"-love"` to
 * remove). Throws when the Private API isn't available or the reaction is unknown.
 */
export async function reactBlueBubbles(
	base: BlueBubblesRestBase,
	params: { chatGuid: string; messageGuid: string; reaction: string; partIndex?: number },
): Promise<void> {
	if (base.privateApiEnabled === false) {
		throw new Error("BlueBubbles reactions require the Private API to be enabled on the server");
	}
	const reaction = normalizeBlueBubblesReaction(params.reaction);
	if (!reaction) throw new Error(`Unknown iMessage reaction: ${params.reaction}`);
	const url = buildBlueBubblesApiUrl({ serverUrl: base.serverUrl, path: "message/react", password: base.password });
	const res = await blueBubblesFetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chatGuid: params.chatGuid,
				selectedMessageGuid: params.messageGuid,
				reaction,
				partIndex: params.partIndex ?? 0,
			}),
		},
		fetchOpts(base),
	);
	await readBlueBubblesJson(res, "message/react");
}

/** Edit a previously-sent message (Private API, macOS 13+ / iMessage edit window). */
export async function editBlueBubblesMessage(
	base: BlueBubblesRestBase,
	params: { messageGuid: string; editedMessage: string; partIndex?: number; backwardsCompatMessage?: string },
): Promise<void> {
	if (base.privateApiEnabled === false) {
		throw new Error("BlueBubbles message edit requires the Private API to be enabled on the server");
	}
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `message/${encodeURIComponent(params.messageGuid)}/edit`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				editedMessage: params.editedMessage,
				backwardsCompatibilityMessage: params.backwardsCompatMessage ?? `Edited to: ${params.editedMessage}`,
				partIndex: params.partIndex ?? 0,
			}),
		},
		fetchOpts(base),
	);
	await readBlueBubblesJson(res, "message/edit");
}

/** Unsend (retract) a previously-sent message (Private API, iMessage unsend window). */
export async function unsendBlueBubblesMessage(
	base: BlueBubblesRestBase,
	params: { messageGuid: string; partIndex?: number },
): Promise<void> {
	if (base.privateApiEnabled === false) {
		throw new Error("BlueBubbles message unsend requires the Private API to be enabled on the server");
	}
	const url = buildBlueBubblesApiUrl({
		serverUrl: base.serverUrl,
		path: `message/${encodeURIComponent(params.messageGuid)}/unsend`,
		password: base.password,
	});
	const res = await blueBubblesFetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ partIndex: params.partIndex ?? 0 }),
		},
		fetchOpts(base),
	);
	await readBlueBubblesJson(res, "message/unsend");
}
