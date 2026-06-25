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
import { isUnderAllowedRoot, resolveOutboundAttachment } from "../imessage/media.js";
import { markdownToIMessageText, resolveDeliveredText, sanitizeOutboundIMessageText } from "../imessage/format.js";
import { downloadInboundAttachments, fetchBlueBubblesMessageAttachments, resolveOutboundVoiceAttachment } from "./media.js";
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
import { markBlueBubblesChatRead, sendBlueBubblesTyping } from "./chat.js";
import { peekBlueBubblesContactName, warmBlueBubblesContactDirectory } from "./contact-names.js";
import { runBlueBubblesCatchup, type BlueBubblesCatchupConfig, type BlueBubblesCatchupSummary } from "./catchup.js";
import type { BlueBubblesCursorStore } from "./catchup-cursor.js";
import { createBlueBubblesInboundDebouncer, type BlueBubblesInboundDebouncer } from "./debounce.js";
import { fetchBlueBubblesHistory, renderBlueBubblesHistoryBlock } from "./history.js";
import { isMacOSEditUnsupported } from "./probe.js";
import type { FetchLike } from "./types.js";

/** Delay before the single late-index attachment re-fetch (BB indexes media ~2s after the webhook). */
const BLUEBUBBLES_ATTACHMENT_REFETCH_DELAY_MS = 2_000;

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
	/** macOS MAJOR version of the BlueBubbles host from the last probe (gates `edit` on ≥ 26). null = unknown. */
	macOSMajor?: number | null;
	/** TEST SEAM — inject a mock fetch for every REST call. */
	fetchImpl?: FetchLike;
	/** TEST SEAM — override the late-index attachment re-fetch delay (ms). Default 2000. */
	attachmentRefetchDelayMs?: number;
	/** TEST SEAM — inject the catch-up cursor store (default: filesystem under the channel state dir). */
	catchupCursorStore?: BlueBubblesCursorStore;
}

/** The live connection handle the adapter drives. */
export interface BlueBubblesConnection {
	feedWebhookEvent(eventType: string | undefined, payload: unknown): void;
	sendText(conversationId: string, text: string, opts?: OutboundSendOptions): Promise<{ messageId?: string }>;
	sendMedia(conversationId: string, media: OutboundMedia): Promise<{ messageId?: string }>;
	react(params: { conversationId: string; messageId: string; reaction: string }): Promise<void>;
	edit(params: { messageId: string; text: string }): Promise<void>;
	unsend(params: { messageId: string }): Promise<void>;
	/** Signal "typing…" (or stop) in a conversation. Cosmetic; no-ops when the Private API is off. */
	setTyping(conversationId: string, typing: boolean): Promise<void>;
	/** Mark a conversation read (read receipt). Cosmetic; no-ops when the Private API is off. */
	markRead(conversationId: string): Promise<void>;
	/** Run a bounded backfill of recently-missed messages through the live inbound path. */
	runCatchup(): Promise<BlueBubblesCatchupSummary>;
	setPrivateApi(status: boolean | null): void;
	/** Update the probed macOS major version (gates `edit` on ≥ 26). */
	setMacOSMajor(major: number | null): void;
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
	let macOSMajor: number | null = args.macOSMajor ?? null;
	const connectedAtMs = Date.now();
	const dedupe: DedupeCache = createDedupeCache({
		maxEntries: BLUEBUBBLES_DEDUPE_MAX_ENTRIES,
		ttlMs: BLUEBUBBLES_DEDUPE_TTL_MS,
	});
	const cacheDir = path.join(resolveOsCacheDir(), "bluebubbles", account.accountId, "inbound-media");

	// Optional inbound coalescing: when `inboundDebounceMs > 0`, a text + its
	// link-preview balloon (or a text + a split-out attachment) arriving as TWO
	// `new-message` webhooks are merged into ONE turn. Default 0 = disabled =
	// the historical synchronous dispatch path (unchanged behaviour).
	const debounceMs = account.inboundDebounceMs ?? 0;
	const debouncer: BlueBubblesInboundDebouncer | null =
		debounceMs > 0
			? createBlueBubblesInboundDebouncer({
					accountId: account.accountId,
					debounceMs,
					dispatch: (msg) => args.onMessage(msg),
					...(account.verbose ? { log: (m) => args.log(m) } : {}),
				})
			: null;

	/** Dispatch an inbound — through the debouncer when enabled, else straight to `onMessage`. */
	const dispatchInbound = (msg: BlueBubblesInboundMessage): void => {
		if (debouncer) debouncer.enqueue(msg);
		else args.onMessage(msg);
	};

	/** Shared args for a rolling-history fetch. */
	const historyArgs = () => ({
		serverUrl: account.serverUrl,
		password: account.password,
		...(account.probeTimeoutMs !== undefined ? { timeoutMs: account.probeTimeoutMs } : {}),
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		...(account.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	});

	/**
	 * Resolve the rolling-history limit that applies to THIS inbound. Group
	 * messages use `historyLimit`; DMs use `dmHistoryLimit`. History is attached
	 * only for an UNTAGGED message (no self-mention, not itself a reply) — a tagged
	 * or reply message already carries its own context. Returns 0 (skip) otherwise.
	 */
	const historyLimitFor = (msg: BlueBubblesInboundMessage): number => {
		if (msg.mentions && msg.mentions.length > 0) return 0;
		if (msg.replyToGuid) return 0;
		if (!msg.text || !msg.text.trim()) return 0;
		return msg.isGroup ? account.historyLimit : account.dmHistoryLimit;
	};

	/**
	 * Dispatch an inbound, first fetching + PREPENDING rolling-history context when
	 * it applies (untagged group/DM message, limit > 0). The history fetch is
	 * bounded + never throws; on any failure the message dispatches with no context.
	 * When history doesn't apply, dispatch is synchronous (unchanged behaviour).
	 */
	const dispatchWithHistory = (msg: BlueBubblesInboundMessage): void => {
		const limit = historyLimitFor(msg);
		if (limit <= 0) {
			dispatchInbound(msg);
			return;
		}
		void (async () => {
			try {
				const { entries } = await fetchBlueBubblesHistory(msg.chatGuid, limit, historyArgs());
				// Drop the current message from the tail if the listing already includes it.
				const prior = entries.filter((e) => !msg.messageGuid || e.messageId !== msg.messageGuid);
				const block = renderBlueBubblesHistoryBlock(prior);
				if (block) {
					msg.text = `${block}\n\n${msg.text}`;
				}
			} catch {
				/* best-effort — dispatch without context */
			}
			dispatchInbound(msg);
		})();
	};

	const restBase = (): BlueBubblesRestBase => ({
		serverUrl: account.serverUrl,
		password: account.password,
		timeoutMs: account.probeTimeoutMs,
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		privateApiEnabled: privateApi === true,
		...(account.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	});

	const contactArgs = () => ({
		serverUrl: account.serverUrl,
		password: account.password,
		accountId: account.accountId,
		...(account.probeTimeoutMs !== undefined ? { timeoutMs: account.probeTimeoutMs } : {}),
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		...(account.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	});

	/**
	 * Resolve an inbound sender handle → a human display name, SYNCHRONOUSLY, from
	 * the already-warm per-account contact directory (no network on the hot path,
	 * so dispatch stays synchronous). On a cache miss, kick a background warm so
	 * the NEXT message from this sender resolves. Mutates `fromName` in place when
	 * a cached name is found; the raw handle flows otherwise.
	 */
	const enrichFromNameSync = (inbound: BlueBubblesInboundMessage): void => {
		if (inbound.fromName && inbound.fromName.trim()) return;
		if (!inbound.from || !inbound.from.trim()) return;
		const cached = peekBlueBubblesContactName(inbound.from, account.accountId);
		if (cached) {
			inbound.fromName = cached;
			return;
		}
		// Cold cache — warm it in the background (best-effort, never throws).
		void warmBlueBubblesContactDirectory(contactArgs()).catch(() => {});
	};

	const downloadArgs = () => ({
		serverUrl: account.serverUrl,
		password: account.password,
		cacheDir,
		maxBytes: account.mediaMaxBytes,
		timeoutMs: account.probeTimeoutMs,
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		...(account.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	});

	const refetchArgs = () => ({
		serverUrl: account.serverUrl,
		password: account.password,
		...(account.probeTimeoutMs !== undefined ? { timeoutMs: account.probeTimeoutMs } : {}),
		...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
		...(account.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
	});

	/** Wait the late-index delay (skippable in tests). */
	const refetchDelay = async (): Promise<void> => {
		const delayMs = args.attachmentRefetchDelayMs ?? BLUEBUBBLES_ATTACHMENT_REFETCH_DELAY_MS;
		if (delayMs <= 0) return;
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, delayMs);
			if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
		});
	};

	const feedWebhookEvent = (eventType: string | undefined, payload: unknown): void => {
		const allowed = new Set(["new-message", "updated-message", undefined]);
		if (eventType && !allowed.has(eventType)) return;
		const result = normalizeBlueBubblesWebhook(payload, eventType, account.selfHandle);
		if (result.kind === "skip") {
			// An "empty message" with a guid MIGHT be a media message whose
			// attachments indexed late. Kick a SINGLE bounded background re-fetch; if
			// media turns up, dispatch a synthetic inbound (deferred-media thunk).
			// A genuinely empty message finds nothing and is never dispatched (no
			// agent spam). Dedupe still guards against a follow-up `updated-message`.
			if (result.mediaCandidate) {
				const cand = result.mediaCandidate;
				const key = resolveBlueBubblesDedupeKey(account.accountId, payload, eventType);
				if (key && !dedupe.claim(key)) {
					if (account.verbose) args.log("inbound dropped: duplicate");
					return;
				}
				void (async () => {
					try {
						await refetchDelay();
						const refetched = await fetchBlueBubblesMessageAttachments(cand.messageGuid, refetchArgs());
						if (refetched.length === 0) return;
						if (account.verbose) args.log(`attachment late-index re-fetch found ${refetched.length} for ${cand.messageGuid}`);
						const inbound: BlueBubblesInboundMessage = {
							conversationId: `chat_guid:${cand.chatGuid}`,
							chatGuid: cand.chatGuid,
							messageGuid: cand.messageGuid,
							from: cand.from,
							...(cand.fromName ? { fromName: cand.fromName } : {}),
							text: "",
							isGroup: cand.isGroup,
							...(cand.timestampMs !== undefined ? { timestampMs: cand.timestampMs } : {}),
							attachments: refetched,
							raw: payload,
							resolveMedia: async () => downloadInboundAttachments(refetched, downloadArgs()),
						};
						enrichFromNameSync(inbound);
						dispatchInbound(inbound);
					} catch (err) {
						if (account.verbose) args.log(`attachment re-fetch failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				})();
				return;
			}
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
			inbound.resolveMedia = async () => downloadInboundAttachments(message.attachments, downloadArgs());
		} else if (message.messageGuid && eventType === "updated-message") {
			// An `updated-message` follow-up with text but no attachments may carry
			// media that indexed late. Defer a SINGLE bounded re-fetch (short delay →
			// `message/{guid}` → download); resolves [] when there was truly none.
			inbound.resolveMedia = async () => {
				await refetchDelay();
				const refetched = await fetchBlueBubblesMessageAttachments(message.messageGuid, refetchArgs());
				if (refetched.length === 0) return [];
				if (account.verbose) args.log(`attachment late-index re-fetch found ${refetched.length} for ${message.messageGuid}`);
				return downloadInboundAttachments(refetched, downloadArgs());
			};
		}
		// Resolve a human display name for the sender from the warm cache (sync) and
		// dispatch — a cold cache warms in the background for next time. An untagged
		// group/DM message first picks up rolling-history context (when configured).
		enrichFromNameSync(inbound);
		dispatchWithHistory(inbound);
	};

	const sendText = async (
		conversationId: string,
		text: string,
		opts?: OutboundSendOptions,
	): Promise<{ messageId?: string }> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, conversationId);
		// Strip internal directive tags / role scaffolding / reasoning residue
		// (the outbound twin of the reflection guard) BEFORE bubble-splitting.
		const bubbles = bubbleSplit(sanitizeOutboundIMessageText(markdownToIMessageText(text)));
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
		// Validate + size-cap the local path (central exfil/denylist guard).
		const resolved = resolveOutboundAttachment(media.path, account.mediaMaxBytes);
		// Layer the per-account local-root ALLOW-LIST on top of the central denylist:
		// when configured, an attachment must resolve UNDER one of the allowed roots.
		if (account.mediaLocalRoots.length > 0 && !isUnderAllowedRoot(resolved.path, account.mediaLocalRoots)) {
			throw new Error(
				`BlueBubbles refused to attach "${media.path}": path is outside the allowed media roots (channels.bluebubbles.mediaLocalRoots).`,
			);
		}
		const asVoice = media.kind === "voice";
		// Voice pre-flight: a voice memo must be mp3/caf — validate + coerce the
		// extension / default the mime, failing fast with a clear error otherwise.
		const voice = asVoice ? resolveOutboundVoiceAttachment(resolved.path, resolved.mimeType) : undefined;
		const contentType = voice?.contentType ?? resolved.mimeType;
		const sent = await sendBlueBubblesAttachment(chatGuid, {
			...base,
			filePath: resolved.path,
			...(voice?.filename ? { fileName: voice.filename } : {}),
			...(contentType ? { contentType } : {}),
			...(asVoice ? { asVoice: true } : {}),
		});
		// iMessage has NO native caption — deliver any caption as a SEPARATE text
		// bubble AFTER the media.
		const caption = resolveDeliveredText(media.caption ?? "", media.kind);
		if (caption && caption.trim() && !caption.startsWith("<media:")) {
			await sendBlueBubblesText(chatGuid, sanitizeOutboundIMessageText(caption), base);
		}
		return sent.messageId ? { messageId: sent.messageId } : {};
	};

	const react = async (params: { conversationId: string; messageId: string; reaction: string }): Promise<void> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, params.conversationId);
		await reactBlueBubbles(base, { chatGuid, messageGuid: params.messageId, reaction: params.reaction });
	};

	const edit = async (params: { messageId: string; text: string }): Promise<void> => {
		// macOS 26+ removed iMessage message EDIT — refuse cleanly rather than firing
		// a request the server will reject.
		if (isMacOSEditUnsupported(macOSMajor)) {
			throw new Error("message edit isn't supported on macOS 26+");
		}
		await editBlueBubblesMessage(restBase(), { messageGuid: params.messageId, editedMessage: params.text });
	};

	const unsend = async (params: { messageId: string }): Promise<void> => {
		await unsendBlueBubblesMessage(restBase(), { messageGuid: params.messageId });
	};

	const setTyping = async (conversationId: string, typing: boolean): Promise<void> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, conversationId);
		await sendBlueBubblesTyping(base, { chatGuid, typing });
	};

	const markRead = async (conversationId: string): Promise<void> => {
		const base = restBase();
		const chatGuid = await resolveChatGuid(base, conversationId);
		await markBlueBubblesChatRead(base, { chatGuid });
	};

	const runCatchup = async (): Promise<BlueBubblesCatchupSummary> => {
		const catchupConfig: BlueBubblesCatchupConfig | undefined = account.catchup;
		return runBlueBubblesCatchup({
			serverUrl: account.serverUrl,
			password: account.password,
			// Enable the PERSISTED cursor (lastSeenMs + give-up retries) per account.
			accountId: account.accountId,
			...(args.catchupCursorStore ? { cursorStore: args.catchupCursorStore } : {}),
			...(catchupConfig ? { config: catchupConfig } : {}),
			...(account.probeTimeoutMs !== undefined ? { timeoutMs: account.probeTimeoutMs } : {}),
			...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
			...(account.allowPrivateNetwork === false ? { allowPrivateNetwork: false } : {}),
			// Re-feed each fetched record through the SAME normalize+dedupe path a
			// live webhook uses (as a `new-message` event), so dedupe drops anything
			// already delivered — no double-delivery.
			feedRecord: (record) => feedWebhookEvent("new-message", { type: "new-message", data: record }),
			log: (msg) => args.log(msg),
		});
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
		setTyping,
		markRead,
		runCatchup,
		setPrivateApi: (status) => {
			privateApi = status;
		},
		setMacOSMajor: (major) => {
			macOSMajor = major;
		},
		connectedAt: () => connectedAtMs,
		close: () => {
			// Flush any buffered (debounced) inbound so a pending coalesced turn isn't
			// silently dropped on teardown, then clear timers.
			debouncer?.flushAll();
			debouncer?.clear();
		},
	};
}
