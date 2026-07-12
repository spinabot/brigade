/**
 * Gateway-side resolution of the files a client attached to a `prompt` turn.
 *
 * The TUI sends PATHS, not bytes (see `PromptAttachment` in `protocol.ts`).
 * This module turns that wire list into the `InboundMediaAttachment[]` the
 * channel inbound pipeline already speaks, so the turn can then run through the
 * SAME `buildMediaNote` + `buildInboundImageBlocks` pair a WhatsApp photo runs
 * through. Everything downstream — inline vision blocks on a vision-capable
 * model, STT transcription of a voice note, the `analyze_media` call-to-action
 * for a PDF — is inherited, not reimplemented.
 *
 * ── On trust ──────────────────────────────────────────────────────────────
 * The paths arrive over the wire, and we read bytes off them. That is NOT a new
 * privilege: `prompt` is already an operator-privileged RPC (it runs a turn as
 * the agent, and the agent holds `read`/`bash`), and it passes the same
 * `sessionsAccessCheck` gate as `sessions.send`. A caller who can invoke
 * `prompt` can already ask the agent to read any file it likes, in English.
 *
 * So the checks below are NOT an authorization boundary — they are a
 * FOOTGUN boundary. They exist to make a malformed attachment list fail loudly
 * and cheaply instead of wedging a turn: no directories (a stray `@src/`
 * completion), no device/FIFO files, no unbounded reads.
 *
 * Two limits on how much they can promise, stated plainly so nobody trusts them
 * further than they deserve:
 *
 *   • The regular-file check is a `stat` taken BEFORE the bytes are read (the
 *     reads happen later, inside the media helpers). Swapping the path for a
 *     FIFO in that window would still hang the read. Closing that race properly
 *     needs an open-then-fstat, which is not worth it for a surface the operator
 *     already has `bash` on — but the property is "rejects a FIFO you named",
 *     not "cannot be made to read a FIFO".
 *   • `rejected` is returned to the CALLER, which is not the same as reaching
 *     the operator's eyes. The `prompt` RPC's response carries no payload, so a
 *     partial rejection is logged gateway-side only. The TUI's defence is that
 *     it validates and count-caps files at STAGING time, before they ever get
 *     here — so a gateway rejection means something changed underneath (the file
 *     was deleted mid-turn), not that the operator over-attached.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
	buildInboundImageBlocks,
	buildMediaNote,
	type InboundImageBlock,
} from "../agents/channels/media-capture.js";
import type { BrigadeExtensionRegistry } from "../agents/extensions/registry.js";
import type { InboundMediaAttachment } from "../agents/extensions/types.js";
import type { BrigadeConfig } from "../config/io.js";
import type { PromptAttachment } from "../protocol.js";

/**
 * Max files on a single turn. Matches `INBOUND_IMAGE_DEBOUNCE_MAX` (8) in the
 * channel pipeline — the ceiling exists for the same reason (a turn payload has
 * to stay bounded), so the two surfaces agree on the number.
 */
export const PROMPT_ATTACHMENT_MAX_COUNT = 8;

/**
 * Outer sanity bound per file. Large on purpose: a video or a document never
 * rides the turn as BYTES — only its path does, and `analyze_media` performs its
 * own bounded read. So this is not a context-cost limit; it is the bound that
 * stops an operator from attaching a 40 GB disk image and wondering why the
 * gateway went quiet.
 */
export const PROMPT_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * ── The read-heavy kinds need their OWN, much tighter bounds ───────────────
 *
 * Two of the helpers we reuse read the file's bytes EAGERLY, and neither was
 * written to defend itself — because in the channel pipeline they only ever saw
 * bytes an adapter had already downloaded and bounded. Handing them arbitrary
 * operator-chosen paths is a new situation:
 *
 *   • `buildInboundImageBlocks` reads an image FULLY and only THEN compares it
 *     against its 8 MiB inline cap. A 500 MB PNG is a 500 MB allocation that is
 *     immediately thrown away.
 *   • `buildMediaNote` reads an audio/voice file FULLY with no size check at all
 *     and posts it to the STT provider — whose own limit is ~25 MB. A 300 MB WAV
 *     is a 300 MB read followed by a doomed 300 MB upload, with the operator's
 *     `prompt` RPC blocked on it (the TUI sends `timeoutMs: 0`).
 *
 * The fix deliberately RECLASSIFIES rather than rejects. An oversized image or
 * recording is still attached — it just travels as a `document`, which means the
 * eager readers skip it and `analyze_media` (which does a bounded read and can
 * decline politely) handles it instead. You can still attach a 400 MB video or a
 * 60 MB photo; you simply get a tool-mediated answer rather than an inline one.
 */
const INLINE_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const TRANSCRIBE_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

/** The kinds a client is allowed to declare. An unknown string is coerced, not trusted. */
const VALID_KINDS: ReadonlySet<string> = new Set([
	"image",
	"video",
	"audio",
	"voice",
	"document",
	"sticker",
]);

/** An attachment we refused, and why — surfaced to the operator verbatim. */
export interface RejectedAttachment {
	path: string;
	reason: string;
}

export interface ResolvedPromptAttachments {
	/** Accepted files, in the shape the channel media helpers consume. */
	media: InboundMediaAttachment[];
	/** Refused files + human-readable reasons. Never silently dropped. */
	rejected: RejectedAttachment[];
}

/**
 * Validate + normalize the wire attachments for one turn.
 *
 * Never throws: a bad attachment is a `rejected` entry, not a failed turn. The
 * operator's TEXT still deserves to reach the model even if the file they
 * dragged in was a directory.
 */
export async function resolvePromptAttachments(
	raw: ReadonlyArray<PromptAttachment> | undefined,
): Promise<ResolvedPromptAttachments> {
	const media: InboundMediaAttachment[] = [];
	const rejected: RejectedAttachment[] = [];
	if (!raw || raw.length === 0) return { media, rejected };

	for (const a of raw) {
		const p = typeof a?.path === "string" ? a.path.trim() : "";
		if (!p) {
			rejected.push({ path: String(a?.path ?? ""), reason: "empty path" });
			continue;
		}

		if (media.length >= PROMPT_ATTACHMENT_MAX_COUNT) {
			rejected.push({
				path: p,
				reason: `over the ${PROMPT_ATTACHMENT_MAX_COUNT}-attachment limit for one turn`,
			});
			continue;
		}

		// Absolute only. A relative path would resolve against the GATEWAY's cwd,
		// which is not the client's cwd — it would silently read the wrong file (or
		// nothing) on a remote gateway. Better to refuse than to guess.
		if (!path.isAbsolute(p)) {
			rejected.push({ path: p, reason: "path must be absolute" });
			continue;
		}

		// `stat`, not `lstat`: a symlink to a real file is a legitimate attachment
		// (macOS aliases, linked media libraries). We care what it POINTS AT, and
		// the `isFile()` check below is what actually protects us.
		let st: Awaited<ReturnType<typeof fsp.stat>>;
		try {
			st = await fsp.stat(p);
		} catch {
			rejected.push({ path: p, reason: "not found or unreadable" });
			continue;
		}

		// Directories and device/FIFO/socket files. A FIFO is the dangerous one: a
		// read on it can block forever and wedge the turn behind it.
		if (st.isDirectory()) {
			rejected.push({ path: p, reason: "is a directory, not a file" });
			continue;
		}
		if (!st.isFile()) {
			rejected.push({ path: p, reason: "not a regular file" });
			continue;
		}
		if (st.size === 0) {
			rejected.push({ path: p, reason: "file is empty" });
			continue;
		}
		if (st.size > PROMPT_ATTACHMENT_MAX_BYTES) {
			rejected.push({
				path: p,
				reason: `file is ${formatBytes(st.size)} — over the ${formatBytes(PROMPT_ATTACHMENT_MAX_BYTES)} limit`,
			});
			continue;
		}

		// Never trust the client's `kind` blindly — it selects which eager reader
		// runs. An unrecognised string would flow straight into
		// `InboundMediaAttachment.kind` and confuse the switch downstream.
		let kind: InboundMediaAttachment["kind"] = VALID_KINDS.has(a.kind)
			? a.kind
			: "document";

		// Demote media that is too big for the reader that would otherwise slurp it.
		// It stays attached — it just goes via `analyze_media` (a bounded read) rather
		// than being inlined or transcribed. See the constants' comment.
		if (kind === "image" && st.size > INLINE_IMAGE_MAX_BYTES) kind = "document";
		if ((kind === "audio" || kind === "voice") && st.size > TRANSCRIBE_AUDIO_MAX_BYTES) {
			kind = "document";
		}

		media.push({
			kind,
			path: p,
			...(a.mimeType ? { mimeType: a.mimeType } : {}),
			fileName: a.fileName?.trim() || path.basename(p),
		});
	}

	return { media, rejected };
}

/** The turn input a client's text + attachments compose into. */
export interface ComposedTurnInput {
	/** Media note first, then the operator's text — the channel pipeline's order. */
	text: string;
	/** Inline image blocks, or undefined when there are none to inline. */
	images?: InboundImageBlock[];
	/** Attachments we refused, for the caller to surface. */
	rejected: RejectedAttachment[];
}

/**
 * Compose one turn's text + inline images from a client's attachments.
 *
 * The whole point of this function is that it does NOT reimplement anything: it
 * runs the client's files through the SAME `buildMediaNote` +
 * `buildInboundImageBlocks` pair the channel inbound pipeline runs a WhatsApp
 * photo through, and composes the text in the SAME order
 * (`[note, userText].filter(Boolean).join("\n").trim()` — see
 * `inbound-pipeline.ts`). That's what guarantees a pasted screenshot and a
 * WhatsApp photo behave identically: inline on a vision model, `analyze_media`
 * on a text-only one, transcribed if it's a voice note.
 *
 * Shared by the `prompt` RPC and the mid-turn model-switch REPLAY, because a
 * replay that dropped the attachments would defeat the most common reason to
 * switch models at all (moving to a model that can actually see the image).
 *
 * Throws when the turn had NOTHING but attachments and every one was refused —
 * the caller has a human waiting, and prompting the model with an empty string
 * is worse than an error. (The channel pipeline expresses the same rule as a
 * silent `if (!text) return`, which is right for an inbound message and wrong
 * for an operator staring at a prompt.)
 */
export async function composeAttachmentTurn(
	rawText: string,
	attachments: ReadonlyArray<PromptAttachment> | undefined,
	deps: { registry?: BrigadeExtensionRegistry; config: BrigadeConfig },
): Promise<ComposedTurnInput> {
	// The `prompt` RPC's params are a bare cast at the dispatch site — there is no
	// runtime schema check — so a client that omits `text` entirely would otherwise
	// blow up on `.trim()` inside the handler with an opaque TypeError.
	const text = typeof rawText === "string" ? rawText : "";
	if (!attachments || attachments.length === 0) return { text, rejected: [] };

	const { media, rejected } = await resolvePromptAttachments(attachments);
	if (media.length === 0) {
		if (!text.trim()) {
			const why = rejected.map((r) => `${r.path}: ${r.reason}`).join("; ");
			throw new Error(`nothing to send — every attachment was rejected${why ? ` (${why})` : ""}`);
		}
		return { text, rejected };
	}

	const note = await buildMediaNote(media, {
		...(deps.registry ? { registry: deps.registry } : {}),
		config: deps.config,
	});
	const composed = [note, text.trim()].filter(Boolean).join("\n").trim();
	const images = await buildInboundImageBlocks(media);
	return {
		text: composed,
		...(images.length > 0 ? { images } : {}),
		rejected,
	};
}

/** `1.2 MB` — for operator-facing reject reasons, not for logs. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
