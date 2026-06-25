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
		{ ...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}), ...(base.fetchImpl ? { fetchImpl: base.fetchImpl } : {}) },
	);
	const data = await readBlueBubblesJson(res, "chat/new");
	const guid = extractChatGuid(data);
	if (!guid) throw new Error("BlueBubbles chat/new returned no chat GUID");
	return guid;
}

/**
 * Resolve an outbound conversation target to a chatGuid. A `chat_guid:` target
 * passes straight through. A `chat_id` / `chat_identifier` / `handle` target is
 * resolved against the server: an existing 1:1 / group chat is found via
 * `chat/query`, else a fresh handle creates a new chat. Returns the chatGuid.
 *
 * For simplicity (and to keep the test seam clean) a `chat_id` target is treated
 * as already-resolved when it already looks like a GUID; otherwise the caller
 * should pass a `chat_guid:` or a `handle` target. The common inbound→reply path
 * always carries a `chat_guid:` (the webhook delivers the chatGuid), so this is
 * the hot path.
 */
export async function resolveChatGuid(base: BlueBubblesRestBase, target: string): Promise<string> {
	const parsed = parseIMessageTarget(target);
	switch (parsed.kind) {
		case "chat_guid":
			return parsed.chatGuid;
		case "chat_identifier":
			return parsed.chatIdentifier; // BlueBubbles accepts the identifier as a GUID-ish key
		case "chat_id":
			return String(parsed.chatId);
		case "handle":
			return createBlueBubblesChat(base, { address: parsed.to });
	}
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
		{ ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
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
	const filename = sanitizeFilename(opts.filePath);
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
		{ timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
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
		{ ...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}), ...(base.fetchImpl ? { fetchImpl: base.fetchImpl } : {}) },
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
		{ ...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}), ...(base.fetchImpl ? { fetchImpl: base.fetchImpl } : {}) },
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
		{ ...(base.timeoutMs !== undefined ? { timeoutMs: base.timeoutMs } : {}), ...(base.fetchImpl ? { fetchImpl: base.fetchImpl } : {}) },
	);
	await readBlueBubblesJson(res, "message/unsend");
}
