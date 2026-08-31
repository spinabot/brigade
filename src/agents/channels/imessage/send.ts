/**
 * iMessage outbound send — assemble + dispatch a `send` RPC.
 *
 * `sendMessageIMessage` parses the target (handle / chat_id / chat_guid /
 * chat_identifier), converts markdown tables to plain text, resolves an optional
 * media attachment to a local path (through the exfil guard), sanitizes a
 * reply-to id, and writes the `send` JSON-RPC call. When the message has media
 * but no text it delivers a `<media:kind>` placeholder so the echo cache + the
 * transcript have a body.
 *
 * The RPC client is INJECTABLE (`opts.client`) — that is the test seam: a unit
 * test passes a fake {@link IMessageRpcLike} and exercises every target kind +
 * media + reply with NO real `imsg` binary. A client WE created here is stopped
 * in the `finally`; an injected one is left for the caller to own.
 */

import {
	createIMessageRpcClient,
	type IMessageRpcLike,
} from "./client.js";
import {
	markdownToIMessageText,
	resolveDeliveredText,
	sanitizeOutboundIMessageText,
	sanitizeReplyToId,
	type IMessageMediaKind,
} from "./format.js";
import { resolveOutboundAttachment } from "./media.js";
import { formatIMessageChatTarget, parseIMessageTarget } from "./targets.js";
import type { IMessageService } from "./account-config.js";

/** Options for {@link sendMessageIMessage}. */
export interface IMessageSendOpts {
	/** `imsg` binary path (only used when constructing a client ourselves). */
	cliPath?: string;
	/** Optional chat.db override. */
	dbPath?: string;
	/** Default send service when the target doesn't pin one (`auto`). */
	service?: IMessageService;
	/** Phone-number region for E.164 normalisation (default `US`). */
	region?: string;
	/** Native reply-to message id (sanitized before send). */
	replyToId?: string;
	/** Local media path to attach (validated through the exfil guard). */
	mediaPath?: string;
	/** Pre-inferred media kind for the `<media:kind>` placeholder (else inferred). */
	mediaKind?: IMessageMediaKind;
	/** Outbound media size cap (bytes). */
	maxBytes?: number;
	/** RPC timeout (ms). */
	timeoutMs?: number;
	/** Force a numeric chat-id target (wins over `to`). */
	chatId?: number;
	/** Inject a live RPC client (the test seam). When set, it is NOT stopped here. */
	client?: IMessageRpcLike;
	/** Inject a client factory (production default constructs the real one). */
	createClient?: (args: { cliPath?: string; dbPath?: string }) => Promise<IMessageRpcLike>;
}

/** Result of a successful send. */
export interface IMessageSendResult {
	/** Resolved message id from the bridge, or a coarse fallback (`ok` / `unknown`). */
	messageId: string;
	/** The text actually delivered (post markdown-table conversion + placeholder). */
	sentText: string;
}

/** Extract a message id from the bridge's `send` result, trying common keys. */
function resolveMessageId(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const r = result as Record<string, unknown>;
	for (const key of ["messageId", "message_id", "id", "guid"]) {
		const v = r[key];
		if (typeof v === "string" && v.trim()) return v.trim();
		if (typeof v === "number" && Number.isFinite(v)) return String(v);
	}
	return null;
}

/**
 * Send an iMessage. `to` is the target string; `opts.chatId` (when set) wins and
 * forces a `chat_id:` target. Resolves the message id (or a coarse fallback).
 */
/**
 * Does this error mean the transport cannot thread replies, as opposed to the
 * send being refused for a real reason?
 *
 * Matched on the bridge's own wording. Deliberately narrow: a broad match here
 * would retry sends that genuinely failed, and re-sending a message the bridge
 * already refused is worse than not sending it.
 */
export function isThreadingUnsupported(err: unknown): boolean {
	const m = err instanceof Error ? err.message : String(err);
	// Pattern widened to match OpenClaw's `isThreadedReplyUnsupportedError`,
	// which drives the same fallback against the same `imsg` binary and has
	// therefore already met the error shapes this one had not. The narrower
	// first version required the literal `reply_to`, so a bridge that said only
	// "threaded replies are unavailable" would have been treated as a real
	// failure and lost the message — the exact bug being fixed.
	return /reply_to requires bridge transport|cannot send threaded repl|threaded repl(?:y|ies)\b.*(?:unsupported|not supported|requires|unavailable)|requires bridge transport/iu.test(
		m,
	);
}

export async function sendMessageIMessage(
	to: string,
	text: string,
	opts: IMessageSendOpts = {},
): Promise<IMessageSendResult> {
	const cliPath = opts.cliPath?.trim() || "imsg";
	const dbPath = opts.dbPath?.trim() || undefined;

	// Target — an explicit chatId wins, else parse the `to` string.
	const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);

	// Service — the target's own prefix, then the account default, then `auto`.
	//
	// THE ORDER USED TO BE BACKWARDS AND THAT MADE THE PREFIX DEAD. This read
	// `opts.service ?? target.service`, and `opts.service` is the ACCOUNT DEFAULT,
	// which `coerceIMessageService` always resolves to a real value — so the left
	// side never fell through and the right side was unreachable. Every documented
	// `sms:+1555…` / `imessage:…` prefix parsed correctly and was then discarded,
	// sending over whatever the account was configured for.
	//
	// `serviceExplicit` rather than `service !== "auto"`, because a deliberate
	// `auto:` on an account pinned to `sms` is a real instruction too.
	const targetService: IMessageService | undefined =
		target.kind === "handle" && target.serviceExplicit ? target.service : undefined;
	const service: IMessageService = targetService ?? opts.service ?? "auto";
	const region = opts.region?.trim() || "US";
	const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : 16 * 1024 * 1024;

	let message = text ?? "";
	let filePath: string | undefined;
	let mediaKind: IMessageMediaKind | undefined = opts.mediaKind;

	// Media resolution — validate the local path, infer the kind.
	if (opts.mediaPath?.trim()) {
		const resolved = resolveOutboundAttachment(opts.mediaPath.trim(), maxBytes);
		filePath = resolved.path;
		mediaKind = mediaKind ?? resolved.kind;
		message = resolveDeliveredText(message, mediaKind);
	}

	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");

	// Plain-text-ify markdown tables when there is text.
	if (message.trim()) message = markdownToIMessageText(message);

	// Last gate before the wire — strip any internal directive tags / role
	// scaffolding / reasoning residue (the outbound twin of the reflection guard).
	if (message.trim()) message = sanitizeOutboundIMessageText(message);

	if (!message.trim() && !filePath) throw new Error("iMessage send requires text or media");

	const replyTo = sanitizeReplyToId(opts.replyToId);

	// Assemble the wire params.
	const params: Record<string, unknown> = {
		text: message,
		service: service || "auto",
		region,
	};
	if (replyTo) params.reply_to = replyTo;
	if (filePath) params.file = filePath;
	if (target.kind === "chat_id") params.chat_id = target.chatId;
	else if (target.kind === "chat_guid") params.chat_guid = target.chatGuid;
	else if (target.kind === "chat_identifier") params.chat_identifier = target.chatIdentifier;
	else params.to = target.to;

	// Client lifecycle — an injected client is owned by the caller.
	const client: IMessageRpcLike =
		opts.client ??
		(opts.createClient
			? await opts.createClient({ cliPath, dbPath })
			: await createIMessageRpcClient({ cliPath, dbPath }));
	const shouldClose = !opts.client;
	try {
		const requestOpts = {
			...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
		};
		let result: ({ ok?: string } & Record<string, unknown>) | undefined;
		try {
			result = await client.request<{ ok?: string } & Record<string, unknown>>(
				"send",
				params,
				requestOpts,
			);
		} catch (err) {
			// A REPLY THAT CANNOT BE THREADED IS STILL A REPLY.
			//
			// `reply_to` needs the bridge transport; the AppleScript fallback
			// rejects it outright:
			//
			//   "reply_to requires bridge transport; AppleScript fallback cannot
			//    send threaded replies"
			//
			// That killed the whole send. Threading is a nicety — being ANSWERED
			// is not — and the message this cost most often is the pairing
			// challenge, which is the one that tells a new sender how to get
			// authorised. Losing it leaves them messaging into silence with no
			// way to discover why, which is exactly what it looks like from the
			// other end: a bot that is simply ignoring you.
			//
			// So: drop the threading and send it flat. Only for this specific
			// refusal — any other failure is still a failure.
			if (!replyTo || !isThreadingUnsupported(err)) throw err;
			delete params.reply_to;
			result = await client.request<{ ok?: string } & Record<string, unknown>>(
				"send",
				params,
				requestOpts,
			);
		}
		const resolvedId = resolveMessageId(result);
		// A SEND IS NOT SUCCESSFUL BECAUSE IT RETURNED.
		//
		// The transport rejects on a JSON-RPC `error` member, so this code only
		// ever sees a 200-shaped answer — but the bridge reports a refused send
		// INSIDE the result: `{ok:false, error:"no such handle"}`. That fell
		// through to `messageId:"unknown"`, which every caller reads as success,
		// so an undeliverable message was reported delivered. The operator is
		// then told their reply went out and it never did.
		//
		// Absence of evidence is treated as failure here rather than success:
		// no id and no positive acknowledgement means nothing confirmed the send,
		// and claiming delivery on that basis is the failure mode this whole
		// codebase keeps finding.
		const record = (result ?? {}) as Record<string, unknown>;
		const explicitFailure =
			record.ok === false ||
			(typeof record.error === "string" && record.error.trim() !== "") ||
			(typeof record.ok === "string" && record.ok.trim().toLowerCase() === "false");
		if (explicitFailure) {
			const detail =
				typeof record.error === "string" && record.error.trim() !== ""
					? record.error.trim()
					: "the bridge refused the send without saying why";
			throw new Error(`iMessage send failed: ${detail}`);
		}
		const acknowledged =
			record.ok === true ||
			(typeof record.ok === "string" && record.ok.trim() !== "" && record.ok.trim().toLowerCase() !== "false");
		if (!resolvedId && !acknowledged) {
			throw new Error(
				"iMessage send was not confirmed — the bridge returned no message id and no acknowledgement",
			);
		}
		return {
			messageId: resolvedId ?? "ok",
			sentText: message,
		};
	} finally {
		if (shouldClose) await client.stop();
	}
}
