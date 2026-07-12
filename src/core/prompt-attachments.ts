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

/**
 * ── Text-like files are INLINED, not merely pointed at ────────────────────
 *
 * An attachment whose content the model never sees is not really an attachment.
 * For an image on a vision model we already send the bytes; for a PDF or an MP4
 * we cannot (Pi's content model is text + image), so a tool has to fetch it. But
 * for a text file there is no excuse: reading it is free, and handing the model a
 * PATH and hoping it calls `read` is a worse experience in every way — an extra
 * round-trip, an extra chance to not bother, and nothing in the transcript to
 * show the operator that their file was actually looked at.
 *
 * So text-like attachments are read at compose time and their content goes into
 * the turn directly. That is what makes `@config.yaml` behave like an attachment
 * instead of like a suggestion.
 */
const TEXT_INLINE_EXT: ReadonlySet<string> = new Set([
	"txt", "text", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "ndjson",
	"xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties",
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
	"c", "h", "cpp", "hpp", "cc", "cs", "swift", "php", "sh", "bash", "zsh", "ps1",
	"sql", "html", "htm", "css", "scss", "vue", "svelte", "diff", "patch",
	"dockerfile", "gitignore", "editorconfig",
]);

/**
 * Ceiling on inlined text. Generous enough for essentially any source file or
 * config, small enough that attaching a 200 MB log can't detonate the context
 * window. Past it the file is truncated with an explicit marker — never silently
 * — and the path stays in the note so the agent can `read` the rest on purpose.
 */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;

/**
 * Ceiling on TOTAL inlined text across every attachment on one turn. ~512 KB ≈
 * 128K tokens — the per-file cap × 2, which keeps even a full set of text files
 * comfortably inside a modern context window instead of eight separate 256 KB
 * files summing to half a million tokens.
 */
export const MAX_TOTAL_INLINE_TEXT_BYTES = 512 * 1024;

function isTextLike(m: InboundMediaAttachment): boolean {
	if (m.kind !== "document") return false;
	const base = path.basename(m.path).toLowerCase();
	const ext = path.extname(base).slice(1).toLowerCase();
	// Extensionless-but-known config files (Dockerfile, Makefile) read as text too.
	if (!ext) return ["dockerfile", "makefile", "rakefile", "gemfile", "procfile"].includes(base);
	return TEXT_INLINE_EXT.has(ext);
}

/**
 * Decode a text file's bytes, honouring the few encodings a Windows-first world
 * actually produces. Returns null when the bytes are BINARY — an extension in the
 * text list is a hint, not a guarantee (`.ts` is TypeScript AND MPEG transport
 * stream; a `.h` can be a firmware blob), and inlining a binary as UTF-8 hands the
 * model a screenful of mojibake.
 */
function decodeTextFile(buf: Buffer): string | null {
	// BOM sniff first — Excel and Notepad on Windows emit UTF-16LE by default, and
	// reading that as UTF-8 yields `n\0a\0m\0e\0`, pure noise.
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return buf.subarray(3).toString("utf8");
	}
	// A NUL byte in the first block is the classic "this is binary" tell. UTF-16
	// without a BOM also trips this, and that's fine — we'd rather decline than inline
	// garbage; the agent still gets the path note and can reach for a tool.
	const scan = buf.subarray(0, Math.min(buf.length, 8192));
	if (scan.includes(0)) return null;
	return buf.toString("utf8");
}

/**
 * Read a text attachment into a fenced block the model can just… read.
 *
 * Not wrapped in the untrusted-content envelope: the operator picked this file off
 * their own disk, which is the trust position of the `read` tool, and `read`
 * doesn't wrap either.
 */
async function inlineTextAttachment(m: InboundMediaAttachment): Promise<string> {
	const name = m.fileName ?? path.basename(m.path);
	const stub = (why: string): string => `[attached file → ${m.path}] (${why})`;

	let raw: Buffer;
	try {
		const fh = await fsp.open(m.path, "r");
		try {
			const b = Buffer.alloc(MAX_INLINE_TEXT_BYTES);
			const { bytesRead } = await fh.read(b, 0, MAX_INLINE_TEXT_BYTES, 0);
			raw = b.subarray(0, bytesRead);
		} finally {
			await fh.close();
		}
	} catch {
		return stub("could not be read inline");
	}

	const body = decodeTextFile(raw);
	if (body === null) return stub(`looks binary — use analyze_media on ${m.path}`);

	const st = await fsp.stat(m.path).catch(() => null);
	const truncated = st !== null && st.size > MAX_INLINE_TEXT_BYTES;
	const head = `[attached file: ${name} → ${m.path}]`;
	const tail = truncated
		? `\n… truncated at ${formatBytes(MAX_INLINE_TEXT_BYTES)} of ${formatBytes(st.size)} — read ${m.path} for the rest.`
		: "";

	// FENCE SAFELY. A file whose content contains ``` would otherwise close our own
	// fence, and everything after it — including anything crafted like "IGNORE PRIOR
	// INSTRUCTIONS" — would land as top-level, model-directed text. CommonMark's own
	// rule is the fix: an opening fence must be LONGER than any backtick run inside
	// the block. So we count the longest run of backticks in the body and fence with
	// one more than that. The file's content can no longer break out.
	let longestTicks = 0;
	for (const run of body.match(/`+/g) ?? []) longestTicks = Math.max(longestTicks, run.length);
	const fence = "`".repeat(Math.max(3, longestTicks + 1));
	return `${head}\n${fence}\n${body}\n${fence}${tail}`;
}

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

	// Split by how the content actually REACHES the model:
	//   • text-like  → we read it here and inline it. A real attachment.
	//   • everything → the channel's media note (image stub / STT transcript /
	//     else                analyze_media call-to-action), because Pi has no
	//                         content block a PDF or an MP4 can ride in.
	const textDocs = media.filter(isTextLike);
	const rest = media.filter((m) => !isTextLike(m));

	const note =
		rest.length > 0
			? await buildMediaNote(rest, {
					...(deps.registry ? { registry: deps.registry } : {}),
					config: deps.config,
				})
			: "";
	// AGGREGATE cap across all inlined text. The per-file 256 KB bound protects
	// against one giant log; it does nothing against eight of them. 8 × 256 KB ≈ 525K
	// tokens — several times any context window. So stop inlining once the running
	// total would exceed the ceiling, and turn the rest into a path note the agent can
	// `read` on purpose. (Images already have their own aggregate guard in
	// media-capture; this is the text equivalent.)
	const inlined: string[] = [];
	let inlinedBytes = 0;
	for (const m of textDocs) {
		if (inlinedBytes >= MAX_TOTAL_INLINE_TEXT_BYTES) {
			inlined.push(`[attached file → ${m.path}] (read it — the turn's inline-text budget was full)`);
			continue;
		}
		const block = await inlineTextAttachment(m);
		inlinedBytes += Buffer.byteLength(block, "utf8");
		inlined.push(block);
	}

	// Note + inlined files FIRST, the operator's words LAST — the same order the
	// channel inbound pipeline composes, so the model sees an identical layout
	// however the file arrived.
	const composed = [note, ...inlined, text.trim()].filter(Boolean).join("\n").trim();
	// Only `rest` can contain images; a text doc is never kind:"image".
	const images = await buildInboundImageBlocks(rest);
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
