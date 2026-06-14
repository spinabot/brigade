/**
 * Download inbound WhatsApp media to disk so the agent can `read` it via path.
 *
 * Saves under `~/.brigade/channels/whatsapp/media/<YYYY-MM-DD>/<msgId>.<ext>`
 * keyed by Baileys message id (so the same media on reconnect re-resolves to
 * the same path, idempotent). Returns the path + MIME + kind + optional
 * caption normalized for the manager's `InboundMessage.media` slot.
 *
 * Failures are caught and logged — a download glitch never breaks the inbound
 * flow; the agent just doesn't get that attachment.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { WAMessage } from "@whiskeysockets/baileys";

import { resolveChannelStateDir, resolveOsCacheDir } from "../../../config/paths.js";
import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";
import type { InboundMediaAttachment } from "../../extensions/types.js";

/* ───────────────────── convex-mode background mirror ─────────────────────
 * Latency posture (operator decision 2026-06-10): the LOCAL file is the
 * hot path — Baileys streams from disk with zero added latency, downstream
 * consumers (send_media, the agent's read tool) get a real path
 * immediately. The Convex copy is a fire-and-forget background upload for
 * durability/cross-machine history; a failed mirror logs and never blocks
 * or fails the message flow. */

let mediaMirrorChain: Promise<void> = Promise.resolve();

function enqueueMediaMirror(args: {
	messageId: string;
	index: number;
	mimeType: string;
	bytes: Buffer;
	log: (msg: string, meta?: Record<string, unknown>) => void;
}): void {
	const rctx = tryGetRuntimeContext();
	if (rctx?.mode !== "convex") return;
	const store = rctx.store;
	mediaMirrorChain = mediaMirrorChain
		.then(() =>
			store.channels.putInboundMedia({
				channelId: CHANNEL_ID,
				messageId: args.messageId,
				index: args.index,
				mimeType: args.mimeType,
				bytes: args.bytes,
			}),
		)
		.then(() => {})
		.catch((err) => {
			args.log("media mirror to convex failed (local copy unaffected)", {
				messageId: args.messageId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
}

/** Drained by the gateway on shutdown. */
export function awaitMediaMirrorFlush(): Promise<void> {
	return mediaMirrorChain;
}

const CHANNEL_ID = "whatsapp";
/** Cap a single attachment at 50 MB — past this it's almost certainly noise. */
const MAX_BYTES = 50 * 1024 * 1024;

function dayBucket(): string {
	// YYYY-MM-DD in UTC. Stable filename grouping for grep / log review.
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function extFromMime(mime: string | undefined): string {
	if (!mime) return "bin";
	const slash = mime.indexOf("/");
	if (slash === -1) return "bin";
	const right = mime.slice(slash + 1).split(";")[0] ?? "";
	// Common MIME → file extension shortcuts; everything else uses the subtype.
	const known: Record<string, string> = {
		jpeg: "jpg",
		"vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
		"vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
		"vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	};
	return known[right] ?? (right.replace(/[^\w]+/g, "") || "bin");
}

interface MediaDescriptor {
	kind: InboundMediaAttachment["kind"];
	field: keyof NonNullable<WAMessage["message"]>;
	mimeFromMessage?: (m: Record<string, unknown>) => string | undefined;
	captionFromMessage?: (m: Record<string, unknown>) => string | undefined;
	fileNameFromMessage?: (m: Record<string, unknown>) => string | undefined;
}

/** The Baileys message envelopes Brigade extracts inbound media from. */
const MEDIA_FIELDS: MediaDescriptor[] = [
	{
		kind: "image",
		field: "imageMessage",
		mimeFromMessage: (m) => (m.mimetype as string | undefined) ?? "image/jpeg",
		captionFromMessage: (m) => m.caption as string | undefined,
	},
	{
		kind: "video",
		field: "videoMessage",
		mimeFromMessage: (m) => (m.mimetype as string | undefined) ?? "video/mp4",
		captionFromMessage: (m) => m.caption as string | undefined,
	},
	{
		kind: "voice", // PTT (push-to-talk) — WhatsApp voice notes
		field: "audioMessage",
		mimeFromMessage: (m) =>
			(m.ptt as boolean | undefined) ? (m.mimetype as string | undefined) ?? "audio/ogg" : undefined,
	},
	{
		kind: "audio", // non-PTT audio
		field: "audioMessage",
		mimeFromMessage: (m) =>
			(m.ptt as boolean | undefined) ? undefined : (m.mimetype as string | undefined) ?? "audio/mpeg",
	},
	{
		kind: "document",
		field: "documentMessage",
		mimeFromMessage: (m) => (m.mimetype as string | undefined) ?? "application/octet-stream",
		captionFromMessage: (m) => m.caption as string | undefined,
		fileNameFromMessage: (m) => m.fileName as string | undefined,
	},
	{
		kind: "sticker",
		field: "stickerMessage",
		mimeFromMessage: (m) => (m.mimetype as string | undefined) ?? "image/webp",
	},
];

/**
 * Cheap presence probe — does this normalized message carry any downloadable
 * media envelope? Walks the same MEDIA_FIELDS table as the downloader but
 * never touches the network. Lets the socket layer defer the actual download
 * (bytes + seal + archive) until AFTER the access-control gate admits the
 * sender — without losing the "drop messages with no text AND no media"
 * fast-path.
 */
export function hasInboundMedia(content: WAMessage["message"]): boolean {
	const c = (content ?? {}) as Record<string, unknown>;
	for (const spec of MEDIA_FIELDS) {
		const env = c[spec.field as string] as Record<string, unknown> | undefined;
		if (!env) continue;
		if (spec.mimeFromMessage?.(env)) return true;
	}
	return false;
}

export interface DownloadInboundMediaArgs {
	/** The normalized message content (post `normalizeMessageContent`). */
	content: WAMessage["message"];
	/** Baileys message id — used as the on-disk filename. */
	msgId: string;
	/**
	 * The Baileys download primitive — passed in because importing the runtime
	 * at the top of this file would defeat the connection's lazy-import of
	 * Baileys. The caller supplies `baileys.downloadMediaMessage`.
	 */
	downloadMediaMessage: (m: WAMessage, type: "buffer" | "stream", opts: Record<string, unknown>) => Promise<Buffer>;
	/** The full raw message (Baileys download needs the original envelope). */
	rawMessage: WAMessage;
	/** Logger callback (so failures don't crash the upsert handler). */
	log: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Walk the normalized message and download every media envelope to disk.
 * Returns one `InboundMediaAttachment` per saved file. Empty array when there's
 * nothing to download (text-only message).
 */
export async function downloadInboundMedia(args: DownloadInboundMediaArgs): Promise<InboundMediaAttachment[]> {
	const content = (args.content ?? {}) as Record<string, unknown>;
	const out: InboundMediaAttachment[] = [];
	for (const [index, spec] of MEDIA_FIELDS.entries()) {
		const env = content[spec.field as string] as Record<string, unknown> | undefined;
		if (!env) continue;
		const mime = spec.mimeFromMessage?.(env);
		if (!mime) continue; // e.g. an audio envelope that's not actually a voice note
		try {
			const bytes = await args.downloadMediaMessage(args.rawMessage, "buffer", {});
			if (!bytes || bytes.length === 0) continue;
			if (bytes.length > MAX_BYTES) {
				args.log("inbound media skipped — exceeds size cap", {
					kind: spec.kind,
					bytes: bytes.length,
					cap: MAX_BYTES,
				});
				continue;
			}
			// Local cache is the hot path in BOTH modes; in convex mode it
			// relocates to the OS cache dir (never ~/.brigade) and the same
			// bytes mirror to Convex in the background.
			const baseDir =
				tryGetRuntimeContext()?.mode === "convex"
					? path.join(resolveOsCacheDir(), "channels", CHANNEL_ID)
					: resolveChannelStateDir(CHANNEL_ID);
			const dir = path.join(baseDir, "media", dayBucket());
			mkdirSync(dir, { recursive: true });
			const suffix = MEDIA_FIELDS.length > 1 ? `-${index}` : "";
			const filePath = path.join(dir, `${args.msgId}${suffix}.${extFromMime(mime)}`);
			writeFileSync(filePath, bytes, { mode: 0o600 });
			enqueueMediaMirror({
				messageId: args.msgId,
				index,
				mimeType: mime,
				bytes,
				log: args.log,
			});
			out.push({
				kind: spec.kind,
				path: filePath,
				mimeType: mime,
				fileName: spec.fileNameFromMessage?.(env),
				caption: spec.captionFromMessage?.(env),
			});
		} catch (err) {
			args.log("inbound media download failed", {
				kind: spec.kind,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}
