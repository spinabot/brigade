/**
 * Telegram media helpers — inbound download + outbound InputFile construction.
 *
 * INBOUND: Telegram doesn't push file bytes; it pushes a `file_id`. To get the
 * bytes we call `getFile(file_id)` (returns a short-lived `file_path`) then
 * download `https://api.telegram.org/file/bot<token>/<file_path>`. Bytes are
 * saved under `~/.brigade/channels/telegram/media/<YYYY-MM-DD>/<fileUid>.<ext>`
 * so the agent can `read` the attachment by path. In convex mode the cache
 * relocates to the OS cache dir (never under ~/.brigade, to respect the
 * strict-zero guard).
 *
 * OUTBOUND: `buildTelegramInputFile` wraps a local path / Buffer in grammY's
 * `InputFile`, after running it through Brigade's outbound media-path guard so
 * a prompt-injected "send ~/.ssh/id_rsa" can't exfiltrate a secret.
 *
 * grammY is lazy-imported (only `InputFile` is needed, and only on the outbound
 * path) so a non-Telegram boot never pays for the dependency.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveChannelStateDir, resolveOsCacheDir } from "../../../config/paths.js";
import { tryGetRuntimeContext } from "../../../storage/runtime-context.js";
// Channel SDK barrel — the outbound-media exfil guard + the OutboundMedia type
// All contract types come from the channel SDK barrel so the channel is built
// entirely on `../sdk.js`.
import {
	validateOutboundMediaPath,
	type InboundMediaAttachment,
	type OutboundMedia,
} from "../sdk.js";

const CHANNEL_ID = "telegram";

/**
 * Telegram Bot API download cap is 20 MB; keep a defensive ceiling slightly
 * under it. Anything larger is skipped (the message still reaches the agent
 * without the attachment).
 */
const MAX_BYTES = 20 * 1024 * 1024;

/** Public Telegram Bot API base (file downloads hang off `/file/bot<token>/…`). */
const TELEGRAM_API_BASE = "https://api.telegram.org";

/** The grammY surface the downloader needs — kept minimal + injectable for tests. */
export interface TelegramBotFileApi {
	/** Resolve a file_id to a downloadable `file_path` (grammY `bot.api.getFile`). */
	getFile(fileId: string): Promise<{ file_path?: string; file_unique_id?: string; file_size?: number }>;
}

/** YYYY-MM-DD (UTC) bucket — stable filename grouping for grep / review. */
function dayBucket(): string {
	const d = new Date();
	const pad = (x: number) => String(x).padStart(2, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Derive a file extension from a Telegram `file_path` (it usually has one). */
function extFromFilePath(filePath: string | undefined, kind: InboundMediaAttachment["kind"]): string {
	if (filePath) {
		const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
		if (ext && /^[a-z0-9]+$/.test(ext)) return ext;
	}
	// Sensible default by kind when the path carried none.
	switch (kind) {
		case "image":
			return "jpg";
		case "video":
			return "mp4";
		case "voice":
			return "ogg";
		case "audio":
			return "mp3";
		case "sticker":
			return "webp";
		default:
			return "bin";
	}
}

/** Where downloaded media lands — OS cache in convex mode, channel-state dir otherwise. */
function mediaBaseDir(): string {
	return tryGetRuntimeContext()?.mode === "convex"
		? path.join(resolveOsCacheDir(), "channels", CHANNEL_ID)
		: resolveChannelStateDir(CHANNEL_ID);
}

export interface DownloadTelegramMediaArgs {
	/** The grammY file API (`bot.api`). */
	bot: TelegramBotFileApi;
	/** The attachment's `file_id` (from `resolveInboundMediaFileId`). */
	fileId: string;
	/** Brigade media kind — drives the default extension + the returned `kind`. */
	kind: InboundMediaAttachment["kind"];
	/** The Bot API token — needed to build the file download URL. NEVER logged. */
	token: string;
	/** Optional caption to carry through to the attachment. */
	caption?: string;
	/** Optional original filename (documents). */
	fileName?: string;
	/** Injectable fetch (defaults to global fetch) — lets tests stub the download. */
	fetchImpl?: typeof fetch;
	/** Logger so a failed download logs without crashing the inbound flow. */
	log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Download one inbound attachment to disk and return its normalized descriptor,
 * or `null` when the file couldn't be fetched (too big / network error / no
 * path). Never throws — a download glitch must not break message delivery.
 */
export async function downloadTelegramMedia(args: DownloadTelegramMediaArgs): Promise<InboundMediaAttachment | null> {
	const { bot, fileId, kind, token, log } = args;
	const doFetch = args.fetchImpl ?? fetch;
	try {
		const file = await bot.getFile(fileId);
		const filePath = file?.file_path;
		if (!filePath) {
			log?.("telegram media skipped — getFile returned no file_path", { kind });
			return null;
		}
		if (typeof file.file_size === "number" && file.file_size > MAX_BYTES) {
			log?.("telegram media skipped — exceeds size cap", { kind, bytes: file.file_size, cap: MAX_BYTES });
			return null;
		}
		const url = `${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`;
		const res = await doFetch(url);
		if (!res.ok) {
			log?.("telegram media download failed", { kind, status: res.status });
			return null;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0) return null;
		if (buf.length > MAX_BYTES) {
			log?.("telegram media skipped — exceeds size cap", { kind, bytes: buf.length, cap: MAX_BYTES });
			return null;
		}
		const dir = path.join(mediaBaseDir(), "media", dayBucket());
		mkdirSync(dir, { recursive: true });
		// file_unique_id is stable across re-deliveries; use it as the filename so
		// the same media resolves idempotently. Fall back to file_id.
		const baseName = (file.file_unique_id || fileId).replace(/[^A-Za-z0-9_-]/g, "_");
		const dest = path.join(dir, `${baseName}.${extFromFilePath(filePath, kind)}`);
		writeFileSync(dest, buf, { mode: 0o600 });
		return {
			kind,
			path: dest,
			fileName: args.fileName,
			caption: args.caption,
		};
	} catch (err) {
		log?.("telegram media download failed", {
			kind,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Wrap a local file path (or Buffer) in grammY's `InputFile` for an outbound
 * send, after running the path through Brigade's outbound media-path guard.
 * Throws a clear operator-facing error when the guard refuses the path (the
 * `send_media` tool surfaces it). grammY is lazy-imported so this file never
 * forces the dependency at module load.
 */
export async function buildTelegramInputFile(media: OutboundMedia): Promise<unknown> {
	const verdict = validateOutboundMediaPath(media.path);
	if (!verdict.ok) {
		throw new Error(`Telegram: ${verdict.reason ?? "refusing to attach this file"}`);
	}
	const { InputFile } = await import("grammy");
	// A local filesystem path — grammY streams it from disk. A filename override
	// (documents) is honoured when provided.
	return new InputFile(media.path, media.fileName);
}

export { MAX_BYTES as TELEGRAM_MEDIA_MAX_BYTES };
