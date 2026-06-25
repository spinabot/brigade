/**
 * BlueBubbles media helpers — inbound download + cache, outbound resolution.
 *
 * Unlike the native `imessage` channel (where the `imsg` bridge has already
 * saved inbound bytes to local disk), BlueBubbles serves attachments over HTTP:
 * `GET /api/v1/attachment/{guid}/download`. So this module DOWNLOADS each inbound
 * attachment to a per-account cache dir under the OS cache (outside `~/.brigade`),
 * applying a small extension-normalisation map (HEIC→jpg, caf→mp3) so the agent's
 * `read` tool + downstream tools see a friendlier extension.
 *
 * OUTBOUND resolution reuses the iMessage exfil guard + kind classifiers so a
 * prompt-injected "send ~/.ssh/id_rsa" can't attach a secret.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { kindFromExt, kindFromMime, resolveOutboundAttachment, inferOutboundMediaKind } from "../imessage/media.js";
import {
	blueBubblesFetchWithTimeout,
	buildBlueBubblesApiUrl,
	type FetchLike,
} from "./types.js";
import type { InboundMediaAttachment } from "../sdk.js";

// Re-export the shared classifiers so callers import them from one place.
export { kindFromExt, kindFromMime, resolveOutboundAttachment, inferOutboundMediaKind };

/**
 * Inbound extension-normalisation map. iMessage delivers Apple-native container
 * formats that most tools can't open; map them to a friendlier extension on
 * download. The bytes are NOT transcoded — only the on-disk extension is changed
 * (a HEIC renamed `.jpg` is still HEIC bytes, but the friendlier extension keeps
 * downstream readers from choking on the `.heic` suffix).
 */
const EXTENSION_MAP: Record<string, string> = {
	heic: "jpg",
	heif: "jpg",
	caf: "mp3",
};

/** Apply the inbound extension map to a filename (`photo.heic` → `photo.jpg`). */
export function mapInboundExtension(fileName: string): string {
	const ext = path.extname(fileName).toLowerCase().replace(/^\./, "");
	const mapped = EXTENSION_MAP[ext];
	if (!mapped) return fileName;
	const stem = fileName.slice(0, fileName.length - (ext.length + 1));
	return `${stem || "attachment"}.${mapped}`;
}

/** One raw inbound attachment as the BlueBubbles webhook reports it. */
export interface RawBlueBubblesAttachment {
	guid?: string;
	transferName?: string;
	mimeType?: string;
	totalBytes?: number;
}

/** Args for downloading + caching inbound attachments. */
export interface DownloadInboundArgs {
	serverUrl: string;
	password: string;
	/** Per-account cache dir the bytes are written under. */
	cacheDir: string;
	/** Max bytes to accept per attachment (skips oversize ones). */
	maxBytes: number;
	timeoutMs?: number;
	/** TEST SEAM — inject a mock fetch. */
	fetchImpl?: FetchLike;
}

/**
 * Download + cache a single inbound attachment by GUID, returning the saved
 * `InboundMediaAttachment` (or null when it has no GUID / is oversize / fails).
 * The saved filename runs through `mapInboundExtension`.
 */
export async function downloadBlueBubblesAttachment(
	att: RawBlueBubblesAttachment,
	args: DownloadInboundArgs,
): Promise<InboundMediaAttachment | null> {
	const guid = (att.guid ?? "").trim();
	if (!guid) return null;
	if (args.maxBytes > 0 && typeof att.totalBytes === "number" && att.totalBytes > args.maxBytes) return null;
	const url = buildBlueBubblesApiUrl({
		serverUrl: args.serverUrl,
		path: `attachment/${encodeURIComponent(guid)}/download`,
		password: args.password,
	});
	let bytes: Uint8Array;
	let contentType: string | undefined;
	try {
		const res = await blueBubblesFetchWithTimeout(
			url,
			{ method: "GET" },
			{ timeoutMs: args.timeoutMs ?? 30_000, ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) },
		);
		if (!res.ok) return null;
		const buf = await res.arrayBuffer();
		bytes = new Uint8Array(buf);
		if (args.maxBytes > 0 && bytes.byteLength > args.maxBytes) return null;
		const ct = res.headers.get("content-type");
		contentType = ct ? ct.split(";")[0]?.trim() || undefined : undefined;
	} catch {
		return null;
	}
	const rawName = (att.transferName ?? "").trim() || `${guid}`;
	const fileName = mapInboundExtension(rawName);
	const dest = path.join(args.cacheDir, `${guid}-${fileName}`);
	try {
		await mkdir(args.cacheDir, { recursive: true });
		await writeFile(dest, bytes);
	} catch {
		return null;
	}
	const mimeType = (att.mimeType ?? contentType ?? "").trim() || undefined;
	return {
		kind: mimeType ? kindFromMime(mimeType) : kindFromExt(fileName),
		path: dest,
		...(mimeType ? { mimeType } : {}),
		fileName,
	};
}

/**
 * Download all inbound attachments for a message, dropping any that fail / are
 * oversize. Returns [] when none resolve.
 */
export async function downloadInboundAttachments(
	raw: RawBlueBubblesAttachment[] | null | undefined,
	args: DownloadInboundArgs,
): Promise<InboundMediaAttachment[]> {
	if (!Array.isArray(raw) || raw.length === 0) return [];
	const out: InboundMediaAttachment[] = [];
	for (const att of raw) {
		const resolved = await downloadBlueBubblesAttachment(att, args);
		if (resolved) out.push(resolved);
	}
	return out;
}
