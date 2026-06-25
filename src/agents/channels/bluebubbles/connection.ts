/**
 * BlueBubbles transport connection — webhook-in + REST-out.
 *
 * Unlike a polling channel there is no socket to open: inbound arrives via the
 * gateway webhook route, which calls `feedWebhookEvent(eventType, payload)` on
 * the started adapter (bridged through `account-registry.ts` on the multi-account
 * path). This module owns BOTH directions:
 *
 *   INBOUND  `feedWebhookEvent` → normalize (defensive) → dedupe (claim-once) →
 *            tapback-drop → defer media download → `onMessage`.
 *   OUTBOUND `sendText` (bubble-split into N text POSTs), `sendMedia` (multipart
 *            upload + caption as a SEPARATE bubble after), plus `react`/`edit`/
 *            `unsend` for `handleAction`.
 *
 * `fetch` is INJECTABLE end-to-end (threaded into every REST call), so the whole
 * connection is exercised in tests with no live server. Private-API status is
 * cached from the last probe and gates the rich actions.
 */

import path from "node:path";

import {
	createDedupeCache,
	ensureDir,
	resolveOsCacheDir,
	type DedupeCache,
	type InboundMediaAttachment,
	type OutboundMedia,
	type OutboundSendOptions,
} from "../sdk.js";
import type { ResolvedBlueBubblesAccount } from "./account-config.js";
import { BLUEBUBBLES_DEDUPE_MAX_ENTRIES, BLUEBUBBLES_DEDUPE_TTL_MS, resolveBlueBubblesDedupeKey } from "./dedupe.js";
import { resolveOutboundAttachment } from "../imessage/media.js";
import { markdownToIMessageText, resolveDeliveredText } from "../imessage/format.js";
import { downloadInboundAttachments } from "./media.js";
import { normalizeBlueBubblesWebhook, type NormalizedBlueBubblesMessage } from "./normalize.js";
import {
	bubbleSplit,
	editBlueBubblesMessage,
	reactBlueBubbles,
	resolveChatGuid,
	sendBlueBubblesAttachment,
	sendBlueBubblesText,
	unsendBlueBubblesMessage,
	type BlueBubblesRestBase,
} from "./send.js";
import type { FetchLike } from "./types.js";

/** The inbound message handed to the adapter (carries the deferred-media thunk). */
export interface BlueBubblesInboundMessage extends NormalizedBlueBubblesMessage {
	resolveMedia?: () => Promise<InboundMediaAttachment[]>;
}

/** Optional note emitted when an inbound tapback is observed (surfaced as a system line). */
export interface BlueBubblesTapbackNote {
	emoji: string;
	action: "added" | "removed";
	chatGuid: string;
	conversationId: string;
	from: string;
	isGroup: boolean;
	targetGuid?: string;
}

export interface ConnectBlueBubblesArgs {
	account: ResolvedBlueBubblesAccount;
	log: (msg: string, meta?: Record<string, unknown>) => void;
	/** Dispatched inbound (post normalize + dedupe). */
	onMessage: (msg: BlueBubblesInboundMessage) => void;
	/** Optional inbound tapback observation (when `actions.reactions` is on). */
	onTapback?: (note: BlueBubblesTapbackNote) => void;
	/** Private-API status from the last probe (gates rich actions). null = unknown. */
	privateApi?: boolean | null;
	/** TEST SEAM — inject a mock fetch for every REST call. */
	fetchImpl?: FetchLike;
}

/** The live connection handle the adapter drives. */
export interface BlueBubblesConnection {
	feedWebhookEvent(eventType: string | undefined, payload: unknown): void;
	sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string }>;
	sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string }>;
	react(params: { conversationId: string; messageId: string; reaction: string }): Promise<void>;
	edit(params: { messageId: string; text: string }): Promise<void>;
	unsend(params: { messageId: string }): Promise<void>;
	setPrivateApi(status: boolean | null): void;
	connectedAt(): number | null;
	close(): void;
}

/**
 * Build a BlueBubbles connection. Synchronous — there is nothing to connect to
 * (inbound is push); the returned handle wires inbound + outbound.
 */
export function connectBlueBubbles(args: ConnectBlueBubblesArgs): BlueBubblesConnection {
	const { account } = args;
	let privateApi: boolean | null = args.privateApi ?? null;
	const connectedAtMs = Date.now();
	const dedupe: DedupeCache = createDedupeCache({
		maxEntries: BLUEBUBBLES_DEDUPE_MAX_ENTRIES,
		ttlMs: BLUEBUBBLES_DEDUPE_TTL_MS,
	});
	const cacheDir = path.join(resolveOsCacheDir(), "bluebubbles", account.accountId, "inbound-media");

	const restBase = (): BlueBubblesRestBase => ({
		serverUrl: account.serverUrl,
		password: account.password,
		timeoutMs: account.probeTimeoutMs,
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		privateApiEnabled: privateApi === true,
	});

	const feedWebhookEvent = (eventType: string | undefined, payload: unknown): void => {
		const allowed = new Set(["new-message", "updated-message", undefined]);
		if (eventType && !allowed.has(eventType)) return;
		const result = normalizeBlueBubblesWebhook(payload, eventType);
		if (result.kind === "skip") {
			if (account.verbose) args.log(`inbound dropped: ${result.reason}`);
			return;
		}
		if (result.kind === "tapback") {
			// Tapbacks are dropped as normal messages; optionally surface a note.
			if (account.actions.reactions && args.onTapback) {
				args.onTapback({
					emoji: result.tapback.emoji,
					action: result.tapback.action,
					chatGuid: result.chatGuid,
					conversationId: `chat_guid:${result.chatGuid}`,
					from: result.from,
					isGroup: result.isGroup,
					...(result.targetGuid ? { targetGuid: result.targetGuid } : {}),
				});
			}
			return;
		}
		// Dedupe (claim-once) — BlueBubbles replays its lookback window on restart.
		const key = resolveBlueBubblesDedupeKey(account.accountId, payload, eventType);
		if (key && !dedupe.claim(key)) {
			if (account.verbose) args.log("inbound dropped: duplicate");
			return;
		}
		const message = result.message;
		const inbound: BlueBubblesInboundMessage = { ...message };
		if (message.attachments.length > 0) {
			inbound.resolveMedia = async () =>
				downloadInboundAttachments(message.attachments, {
					serverUrl: account.serverUrl,
					password: account.password,
					cacheDir,
					maxBytes: account.mediaMaxBytes,
					timeoutMs: account.probeTimeoutMs,
					...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
				});
		}
		args.onMessage(inbound);
	};

	const sendText = async (
		conversationId: string,
		text: string,
		opts?: OutboundSendOptions,
	): Promise<{ messageId?: string }> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, conversationId);
		const bubbles = bubbleSplit(markdownToIMessageText(text));
		if (bubbles.length === 0) return {};
		let lastMessageId: string | undefined;
		let first = true;
		for (const bubble of bubbles) {
			const sent = await sendBlueBubblesText(chatGuid, bubble, {
				...base,
				// Native reply target applies to the FIRST bubble only.
				...(first && opts?.replyToId ? { replyToMessageGuid: opts.replyToId } : {}),
			});
			if (sent.messageId) lastMessageId = sent.messageId;
			first = false;
		}
		return lastMessageId ? { messageId: lastMessageId } : {};
	};

	const sendMedia = async (conversationId: string, media: OutboundMedia): Promise<{ messageId?: string }> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, conversationId);
		// Validate + size-cap the local path (exfil guard).
		const resolved = resolveOutboundAttachment(media.path, account.mediaMaxBytes);
		const asVoice = media.kind === "voice";
		const sent = await sendBlueBubblesAttachment(chatGuid, {
			...base,
			filePath: resolved.path,
			...(resolved.mimeType ? { contentType: resolved.mimeType } : {}),
			...(asVoice ? { asVoice: true } : {}),
		});
		// iMessage has NO native caption — deliver any caption as a SEPARATE text
		// bubble AFTER the media.
		const caption = resolveDeliveredText(media.caption ?? "", media.kind);
		if (caption && caption.trim() && !caption.startsWith("<media:")) {
			await sendBlueBubblesText(chatGuid, caption, base);
		}
		return sent.messageId ? { messageId: sent.messageId } : {};
	};

	const react = async (params: { conversationId: string; messageId: string; reaction: string }): Promise<void> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, params.conversationId);
		await reactBlueBubbles(base, { chatGuid, messageGuid: params.messageId, reaction: params.reaction });
	};

	const edit = async (params: { messageId: string; text: string }): Promise<void> => {
		await editBlueBubblesMessage(restBase(), { messageGuid: params.messageId, editedMessage: params.text });
	};

	const unsend = async (params: { messageId: string }): Promise<void> => {
		await unsendBlueBubblesMessage(restBase(), { messageGuid: params.messageId });
	};

	// Ensure the cache dir exists lazily (best-effort; download also mkdir's).
	try {
		ensureDir(cacheDir);
	} catch {
		/* best-effort */
	}

	return {
		feedWebhookEvent,
		sendText,
		sendMedia,
		react,
		edit,
		unsend,
		setPrivateApi: (status) => {
			privateApi = status;
		},
		connectedAt: () => connectedAtMs,
		close: () => {
			/* nothing to tear down — inbound is push, no socket held */
		},
	};
}
