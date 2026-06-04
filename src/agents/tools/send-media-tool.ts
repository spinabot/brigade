/**
 * `send_media` — agent-callable channel attachment send. Owner-only.
 *
 * Same shape + same auto-routing as `send_message`, but for media
 * attachments: PNG / JPG / PDF / MP4 / audio / voice / sticker / etc.
 * Reads bytes from a local path and hands the file to the channel
 * adapter's `sendMedia` capability (defined in
 * `agents/extensions/types.ts → OutboundMedia`).
 *
 * Why a separate tool:
 *   - Different parameter shape (file path + caption vs. raw text)
 *   - Different failure modes (file-not-found, channel-without-media,
 *     unsupported kind) deserve dedicated error messages
 *   - Per the `send_message` pattern note, future channel verbs ship
 *     as their own tools rather than as `action:` modes on one
 *     polymorphic tool — easier for the model to reason about and
 *     gives us per-action `ownerOnly` granularity.
 *
 * End-to-end use case this unlocks:
 *   1. User on WhatsApp: "show me the org structure"
 *   2. LLM calls `org({action:"show", format:"image"})` → gets
 *      `{imagePath, mimeType}` back
 *   3. LLM calls `send_media({path: imagePath, caption: "Here's the
 *      Pride."})` → image arrives inline in the user's WhatsApp
 *
 * Validation:
 *   - Path must exist and be readable.
 *   - Channel adapter MUST expose `sendMedia` (some adapters are
 *     text-only — tool refuses with a clear "channel X doesn't
 *     support media; the file is at <path>").
 *   - Owner-only — sub-agents cannot send media; they ask the
 *     parent via spawn_agent's reply if they have something to
 *     attach.
 *   - Same channel/to auto-fill as `send_message` (BOTH from
 *     channelContext when neither is supplied; strict pairing when
 *     either is set).
 *
 * Kind inference:
 *   - When `kind` is omitted, infer from the file extension: png/jpg
 *     /gif/webp → image, mp4/mov → video, mp3/m4a → audio, ogg/opus
 *     → voice, pdf/docx/csv/etc → document, webp-anim (we treat as
 *     image; sticker requires explicit `kind:"sticker"`).
 *   - When inference fails AND kind is omitted, refuses with the
 *     known-extension list.
 */

import { existsSync, statSync, promises as fsp } from "node:fs";
import path from "node:path";

import { consumeTransientImage } from "../org/pride-image.js";

import { Type } from "typebox";

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { getActiveChannelManager } from "../channels/active-manager.js";
import type { ChannelApprovalRoute } from "../channels/approval-router.js";
import type { OutboundMedia } from "../extensions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { failedTextResult, payloadTextResult, readStringParam } from "./common.js";
import type { BrigadeTool } from "./types.js";

const log = createSubsystemLogger("brigade/send-media");

const SendMediaParams = Type.Object({
	path: Type.String({
		description:
			"Absolute (or cwd-relative) path to the file to send. The file " +
			"must exist and be readable. Common producers: `org({format:" +
			"'image'})` returns an `imagePath`; `image_gen` tools return a " +
			"file path. The recipient sees the file embedded inline (image / " +
			"video) or as an attachment (document).",
	}),
	caption: Type.Optional(
		Type.String({
			description:
				"Optional text caption rendered alongside image / video / " +
				"document. WhatsApp / Telegram / Discord all support this; " +
				"audio / voice usually ignore it.",
		}),
	),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("image"),
				Type.Literal("video"),
				Type.Literal("audio"),
				Type.Literal("voice"),
				Type.Literal("document"),
				Type.Literal("sticker"),
			],
			{
				description:
					"Media kind. When omitted, inferred from the file extension " +
					"(png/jpg/gif/webp → image, mp4/mov/webm → video, mp3/m4a/" +
					"aac/wav → audio, ogg/opus → voice, pdf/docx/csv/txt → " +
					"document). Set explicitly when sending a sticker (webp " +
					"with sticker semantics) or to override the inference.",
			},
		),
	),
	fileName: Type.Optional(
		Type.String({
			description:
				"Override the file name surfaced to the recipient (documents " +
				"only). Defaults to the basename of `path`.",
		}),
	),
	mimeType: Type.Optional(
		Type.String({
			description:
				"Override the MIME type. Default: inferred from the file " +
				"extension. Set explicitly when the extension is wrong / " +
				"missing.",
		}),
	),
	channel: Type.Optional(
		Type.String({
			description:
				"Channel id to send through (e.g. `whatsapp`, `slack`, " +
				"`telegram`). Auto-filled from the current turn's originating " +
				"channel when omitted. Channel adapter MUST expose `sendMedia` " +
				"— text-only channels refuse with a clear error.",
		}),
	),
	to: Type.Optional(
		Type.String({
			description:
				"Destination conversation id. Auto-filled from the current " +
				"turn's originating conversation when omitted.",
		}),
	),
	threadId: Type.Optional(
		Type.String({
			description:
				"Optional thread/topic id (Slack thread_ts, Telegram topic, " +
				"Discord thread). Channels without threading ignore it.",
		}),
	),
	accountId: Type.Optional(
		Type.String({
			description:
				"Multi-account channels use this to pick which account sends. " +
				"Leave unset for the default account.",
		}),
	),
	deleteAfterSend: Type.Optional(
		Type.Boolean({
			description:
				"When true, unlink the source file after the adapter accepts " +
				"the send. Use for transient producer outputs like " +
				"`org({format:'image'})` PNGs that exist only to be dispatched " +
				"once. Also auto-detected: any file the producer registered as " +
				"transient is unlinked even without this flag.",
		}),
	),
});

interface SendMediaDetails {
	channel: string;
	to: string;
	path: string;
	kind: OutboundMedia["kind"];
	captionPreview?: string;
	threadId?: string;
}

export interface MakeSendMediaToolOptions {
	/** Active channel context for this turn — used for auto-fill defaults. */
	channelContext?: ChannelApprovalRoute;
	/**
	 * When false, the tool refuses cross-conversation sends — only the
	 * SAME conversation as the channel inbound is reachable. Owners
	 * (default `true`) can route to any started channel/peer. This
	 * replaces the blanket `ownerOnly: true` posture so an approved
	 * non-owner peer can receive media REPLIES to their own chat
	 * (which is what they expect when they ask the bot a question)
	 * while still preventing them from making the bot DM strangers.
	 */
	senderIsOwner?: boolean;
}

const EXT_TO_KIND: Record<string, OutboundMedia["kind"]> = {
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".gif": "image",
	".webp": "image",
	".bmp": "image",
	".svg": "image",
	".mp4": "video",
	".mov": "video",
	".webm": "video",
	".mkv": "video",
	".mp3": "audio",
	".m4a": "audio",
	".aac": "audio",
	".wav": "audio",
	".flac": "audio",
	".ogg": "voice",
	".opus": "voice",
	".pdf": "document",
	".doc": "document",
	".docx": "document",
	".txt": "document",
	".csv": "document",
	".xls": "document",
	".xlsx": "document",
	".ppt": "document",
	".pptx": "document",
	".zip": "document",
	".md": "document",
};

const EXT_TO_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".opus": "audio/opus",
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".txt": "text/plain",
	".csv": "text/csv",
	".xls": "application/vnd.ms-excel",
	".xlsx":
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".zip": "application/zip",
	".md": "text/markdown",
};

/**
 * Build the `send_media` tool. Caller is the registry — it only
 * registers the tool when the gateway's channel manager is mounted
 * and at least one adapter has started; otherwise the tool stays
 * out of the surface (same gating as `send_message`).
 */
export function makeSendMediaTool(
	opts: MakeSendMediaToolOptions = {},
): BrigadeTool<typeof SendMediaParams, SendMediaDetails> {
	const channelContext = opts.channelContext;
	const senderIsOwner = opts.senderIsOwner ?? true;
	return {
		name: "send_media",
		label: "send_media",
		displaySummary: "sending a media attachment",
		description:
			"Send a media attachment (image / video / audio / voice / " +
			"document / sticker) through a connected channel RIGHT NOW. " +
			"Companion to `send_message`. Use this after a tool that produces " +
			"a file path (e.g. `org({format:'image'})` returns `imagePath`; " +
			"image-gen tools return a path) when the operator asked to " +
			"see / receive the file in their chat.\n\n" +
			"Auto-routing: when called from a channel-routed turn, `channel` " +
			"and `to` default to the originating conversation — so 'show me " +
			"the org' becomes `send_media({path: imagePath, caption: ...})` " +
			"without restating channel/to.\n\n" +
			"Validation: channel MUST be a started adapter AND expose " +
			"sendMedia (text-only channels refuse cleanly). `path` must " +
			"exist + be readable.\n\n" +
			"`kind` is inferred from the file extension when omitted (png/" +
			"jpg → image, mp4 → video, pdf/docx → document, etc.).",
		parameters: SendMediaParams,
		// NOTE: `ownerOnly` is intentionally NOT set. The session-wiring
		// blanket-refusal at `wrapOwnerOnlyToolExecution` would otherwise
		// reject EVERY call from approved non-owner peers, including the
		// legitimate "friend texts the bot, bot replies with an image to
		// their own chat" use case. The narrower per-call gate inside
		// execute() permits reply-to-same-chat for non-owners but still
		// refuses cross-conversation sends — preserving the original
		// security intent (don't let strangers make the bot DM other
		// people) while unblocking the actual use case operators expect.
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<SendMediaDetails>> {
			const manager = getActiveChannelManager();
			if (!manager) {
				return failedTextResult(
					"send_media: the gateway has no channel manager mounted (no channels are configured). " +
						"Configure a channel in brigade.json first, then restart the gateway.",
					{ channel: "", to: "", path: "", kind: "document" } as never,
				);
			}
			const rawPath = readStringParam(params, "path", { required: true });
			const initialPath = path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(process.cwd(), rawPath);
			const caption = readStringParam(params, "caption");
			const fileName = readStringParam(params, "fileName");
			const mimeOverride = readStringParam(params, "mimeType");
			const kindRaw = readStringParam(params, "kind");
			const channelRaw = readStringParam(params, "channel");
			const toRaw = readStringParam(params, "to");
			const threadIdParam = readStringParam(params, "threadId");
			const accountId = readStringParam(params, "accountId");

			// Per-call non-owner gate. Allow reply-to-same-chat (no
			// explicit channel/to overrides, OR overrides that EQUAL the
			// channelContext). Refuse anything else for non-owners —
			// preserves "no DM-ing strangers" without blocking the
			// approved-peer reply use case.
			if (!senderIsOwner) {
				const channelMatchesCtx =
					channelRaw === undefined ||
					(channelContext !== undefined &&
						channelRaw === channelContext.channelId);
				const toMatchesCtx =
					toRaw === undefined ||
					(channelContext !== undefined &&
						toRaw === channelContext.conversationId);
				if (!channelMatchesCtx || !toMatchesCtx) {
					return failedTextResult(
						"send_media: as a non-owner-routed turn you may only reply to the inbound's own conversation. " +
							"Cross-conversation sends require workspace-owner privilege. " +
							"Drop the explicit `channel` / `to` args (they auto-fill to this chat), or have the workspace owner make this call.",
						{
							channel: channelRaw ?? "",
							to: toRaw ?? "",
							path: initialPath,
							kind: "document",
						} as never,
					);
				}
			}

			// LLM-mangling-tolerant path resolution. Mid-tier models
			// occasionally re-escape (or under-escape) backslashes when
			// copying a Windows path out of a tool result, producing
			// inputs like `C:Userfoo\bar.png` (single \b interpreted as
			// backspace), `C:\\Users\\...` (double-escaped), or
			// `C:/Users/.../foo.png` (forward slashes). We try several
			// canonical variants and pick the first that exists; this
			// rescues the `org({format:"image"})` → `send_media` flow
			// when the LLM mangles the imagePath roundtrip.
			const candidates = uniqueStrings([
				initialPath,
				path.normalize(initialPath),
				initialPath.split("/").join(path.sep),
				initialPath.split("\\").join(path.sep),
				initialPath.replace(/\\\\/g, "\\"),
				initialPath.replace(/\\/g, "/"),
			]);
			let filePath: string | null = null;
			for (const candidate of candidates) {
				if (existsSync(candidate)) {
					filePath = candidate;
					break;
				}
			}
			if (filePath === null) {
				// EXPLICIT LOG so the operator can see WHICH path the LLM
				// passed when send_media's 1ms file-not-found fires. The
				// failedTextResult below is only visible in the LLM's
				// context; the gateway log otherwise just shows `tool_end
				// ✗ tool=send_media` with no detail. This line closes
				// that diagnosability gap.
				log.warn("send_media: file not found at any path variant", {
					rawPath,
					initialPath,
					candidates,
					cwd: process.cwd(),
				});
				return failedTextResult(
					`send_media: file NOT FOUND on disk. Tried these path variants: ${candidates
						.map((c) => JSON.stringify(c))
						.join(", ")}.\n\n` +
						`This typically means you INVENTED a path instead of using one returned by a producer tool. ` +
						`Step back and do this in order: ` +
						`(1) Call the producer tool first — \`org({action:"show", format:"image"})\` for an org chart, ` +
						`\`browser({action:"screenshot", outputPath:"<path>"})\` for a webpage capture, an image-gen tool for a render. ` +
						`(2) Read the \`imagePath\` (or equivalent) field from THAT tool's result. ` +
						`(3) Pass it to send_media verbatim in the SAME turn. ` +
						`Do NOT pass a path from your memory of an earlier session — temp files are auto-cleaned after each send.`,
					{
						channel: channelRaw ?? "",
						to: toRaw ?? "",
						path: initialPath,
						kind: "document",
					} as never,
				);
			}
			try {
				const st = statSync(filePath);
				if (!st.isFile()) {
					return failedTextResult(
						`send_media: ${JSON.stringify(filePath)} is not a regular file.`,
						{
							channel: channelRaw ?? "",
							to: toRaw ?? "",
							path: filePath,
							kind: "document",
						} as never,
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return failedTextResult(
					`send_media: cannot stat ${JSON.stringify(filePath)} — ${msg}.`,
					{
						channel: channelRaw ?? "",
						to: toRaw ?? "",
						path: filePath,
						kind: "document",
					} as never,
				);
			}

			// Kind: explicit > extension-inferred > error.
			const ext = path.extname(filePath).toLowerCase();
			const inferredKind = EXT_TO_KIND[ext];
			const kind: OutboundMedia["kind"] | undefined =
				(kindRaw as OutboundMedia["kind"] | undefined) ?? inferredKind;
			if (!kind) {
				const known = Object.keys(EXT_TO_KIND).slice(0, 12).join(", ");
				return failedTextResult(
					`send_media: could not infer media kind from extension ${JSON.stringify(ext || "(none)")}. ` +
						`Pass \`kind\` explicitly (image/video/audio/voice/document/sticker), ` +
						`or use one of these known extensions: ${known}…`,
					{
						channel: channelRaw ?? "",
						to: toRaw ?? "",
						path: filePath,
						kind: "document",
					} as never,
				);
			}
			const mimeType = mimeOverride ?? EXT_TO_MIME[ext];

			// Auto-fill channel/to from channelContext when BOTH are missing —
			// same strict-pairing semantics as send_message.
			let channel = channelRaw;
			let to = toRaw;
			let threadId = threadIdParam;
			let resolvedAccountId = accountId;
			if (!channel && !to && channelContext) {
				channel = channelContext.channelId;
				to = channelContext.conversationId;
				threadId ??= channelContext.threadId;
				resolvedAccountId ??= channelContext.accountId;
			}
			if (!channel || !to) {
				const started = manager.started;
				const targetHint =
					started.length > 0
						? `available channels: ${started.join(", ")}.`
						: "no channels are started; configure one in brigade.json + restart the gateway.";
				return failedTextResult(
					`send_media: \`channel\` and \`to\` are both required (no channel-routed turn context to auto-fill from). ${targetHint}`,
					{
						channel: channel ?? "",
						to: to ?? "",
						path: filePath,
						kind,
					} as never,
				);
			}
			const adapter = manager.adapter(channel, resolvedAccountId);
			if (!adapter) {
				const started = manager.started.join(", ") || "(none)";
				const accountHint = resolvedAccountId
					? ` (account "${resolvedAccountId}" not started for "${channel}")`
					: "";
				return failedTextResult(
					`send_media: channel "${channel}" is not a started adapter${accountHint} — typo? available channels: ${started}.`,
					{ channel, to, path: filePath, kind } as never,
				);
			}
			if (typeof adapter.sendMedia !== "function") {
				return failedTextResult(
					`send_media: channel "${channel}" does not support media attachments (the adapter has no \`sendMedia\`). ` +
						`The file is at ${filePath} — consider sending a text fallback via \`send_message\` describing what it is.`,
					{ channel, to, path: filePath, kind } as never,
				);
			}
			if (typeof adapter.health === "function") {
				const status = adapter.health();
				if (!status.ok) {
					const remediation = status.remediation
						? ` Remediation: ${status.remediation}`
						: "";
					return failedTextResult(
						`send_media: channel "${channel}" is currently unavailable (${status.kind}). ${status.reason}${remediation}`,
						{ channel, to, path: filePath, kind } as never,
					);
				}
			}

			const media: OutboundMedia = {
				kind,
				path: filePath,
				...(caption !== undefined ? { caption } : {}),
				...(fileName !== undefined
					? { fileName }
					: kind === "document"
						? { fileName: path.basename(filePath) }
						: {}),
				...(mimeType !== undefined ? { mimeType } : {}),
			};

			try {
				await adapter.sendMedia(to, media);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				log.warn("send_media dispatch threw", {
					channel,
					to,
					kind,
					path: filePath,
					error: errMsg,
				});
				return failedTextResult(
					`send_media: dispatch failed via ${channel} adapter — ${errMsg}. The recipient may not have received the file; consider trying again or telling the operator.`,
					{ channel, to, path: filePath, kind } as never,
				);
			}
			log.info("send_media dispatched", {
				channel,
				to,
				threadId,
				accountId: resolvedAccountId,
				kind,
				path: filePath,
				captionPreview: caption?.slice(0, 80),
			});

			// Belt-and-suspenders cleanup. The producer (org-tool on a
			// channel-routed turn) registers its PNG in the transient
			// registry; the LLM is ALSO told to pass `deleteAfterSend:true`.
			// Either signal triggers the unlink — neither alone is enough
			// (LLM may forget the flag; producers may not have registered).
			// Failure to unlink is logged warn and the tool still returns
			// success because the user already received the file.
			const explicit = params.deleteAfterSend === true;
			const registered = consumeTransientImage(filePath);
			if (explicit || registered) {
				try {
					await fsp.unlink(filePath);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					log.warn("send_media: post-send unlink failed", {
						filePath,
						error: msg,
					});
				}
			}

			return payloadTextResult({
				channel,
				to,
				path: filePath,
				kind,
				...(caption !== undefined
					? { captionPreview: caption.slice(0, 120) }
					: {}),
				...(threadId !== undefined ? { threadId } : {}),
			});
		},
	};
}

/**
 * Dedupe an array of strings while preserving the first occurrence
 * order. Used by the path-recovery shim so the candidate list stays
 * deterministic regardless of which variants happen to match.
 */
function uniqueStrings(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (item && !seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}
