/**
 * Client-side attachment plumbing for the TUI.
 *
 * Four ways a file gets attached to a turn, all converging on one
 * `StagedAttachment[]` that rides the `prompt` RPC as `PromptAttachment[]`:
 *
 *   1. `@path` — pi-tui's `CombinedAutocompleteProvider` ALREADY does fuzzy
 *      `@`-prefixed file completion (it calls the feature "file attachment
 *      completion" in its own source) and connect.ts already installs it. All
 *      that was ever missing is the SEMANTICS — reading the `@token` back out of
 *      the submitted line and treating it as a file. `extractAttachmentPaths`
 *      is that missing half.
 *   2. Drag-and-drop — every mainstream terminal (Windows Terminal, iTerm2,
 *      VS Code, GNOME Terminal) responds to a dropped file by pasting its path
 *      into stdin. We parse the shapes they paste (quoted, backslash-escaped,
 *      `file://` URI, bare) out of the submitted line.
 *   3. Clipboard image — a screenshot has NO path; it lives on the clipboard as
 *      raw bitmap data. We pull the bytes out per-OS and spool them to a temp
 *      PNG, which collapses the case back into "a path" (see `readClipboardImage`).
 *   4. `/attach <path>` — the explicit backbone.
 *
 * ── The disambiguation rule ───────────────────────────────────────────────
 * Silently attaching a file the operator merely MENTIONED, or rewriting a
 * sentence they didn't mean as a path, are the two worst things this module can
 * do. Existence on disk is necessary but NOT sufficient — `check /etc/hosts for
 * me` names a file that really is there on every Linux box. So intent is graded:
 *
 *   at        `@token` from the file completer → any file, any extension.
 *   pureDrop  the line is nothing but a path   → any file, but ABSOLUTE only
 *                                                (a terminal drop always pastes
 *                                                an absolute path; a bare
 *                                                relative word is a message).
 *   inferred  a path loose in a sentence       → absolute AND a media/document
 *                                                extension. Source, config, log
 *                                                and data files are excluded:
 *                                                in prose those are cited, not
 *                                                enclosed.
 *
 * A candidate that fails its tier is left in the text EXACTLY as typed. And when
 * nothing matches at all, the original line is returned byte-for-byte — this
 * function runs on every submitted message, so anything it normalises it
 * normalises for the whole product (it once collapsed the indentation of every
 * pasted code block).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	clipboardSpoolDir,
	startClipboardService,
	type ClipboardService,
	type ClipboardWatcher,
} from "./clipboard.js";
import type { PromptAttachment } from "../protocol.js";

export type { ClipboardWatcher } from "./clipboard.js";

/** A file staged for the next turn, plus the display facts the chip tray needs. */
export interface StagedAttachment {
	kind: PromptAttachment["kind"];
	path: string;
	mimeType: string;
	fileName: string;
	bytes: number;
}

/* ───────────────────────────── kind + mime ───────────────────────────── */

/**
 * Images we may safely send INLINE as a native `ImageContent` block.
 *
 * Deliberately only the four formats every major vision provider accepts
 * (Anthropic: jpeg/png/gif/webp; OpenAI: png/jpeg/webp/gif). This list is a
 * SAFETY list, not a completeness list. Inlining an `image/svg+xml` or
 * `image/tiff` block is not a graceful degradation — the provider rejects the
 * whole request, so a single attached SVG would 400 the entire turn instead of
 * just being read by a tool.
 */
const INLINE_IMAGE_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/**
 * Images the model CANNOT take inline, but `analyze_media` can still read (it
 * routes bmp/heic/heif through the media-understanding subsystem).
 *
 * These are classified as `document` rather than `image` precisely so that
 * `buildInboundImageBlocks` does not try to inline them. The kind name reads a
 * little oddly in the media note ("[attached document (logo.bmp) → …]") and that
 * is a deliberate trade: a slightly-off noun beats a hard provider 400.
 */
const NON_INLINE_IMAGE_EXT: Record<string, string> = {
	bmp: "image/bmp",
	heic: "image/heic",
	heif: "image/heif",
	tif: "image/tiff",
	tiff: "image/tiff",
	svg: "image/svg+xml",
	avif: "image/avif",
};

// Kept in step with `analyze_media`'s own EXT_KIND table (analyze-media-tool.ts)
// — that tool is the universal reader every non-inline attachment reaches, so a
// format it can read should be a format you can attach.
const VIDEO_EXT: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	m4v: "video/x-m4v",
	mpeg: "video/mpeg",
	mpg: "video/mpeg",
};
const AUDIO_EXT: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/opus",
};

/** Office, OpenDocument, e-book, and rich-document formats `analyze_media` parses. */
const RICH_DOC_EXT: Record<string, string> = {
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	epub: "application/epub+zip",
	rtf: "application/rtf",
	ipynb: "application/x-ipynb+json",
};

/** Text/markup/data formats. Attachable, but never auto-attached from prose. */
const TEXT_EXT: Record<string, string> = {
	html: "text/html",
	htm: "text/html",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	md: "text/markdown",
	markdown: "text/markdown",
	txt: "text/plain",
	text: "text/plain",
	log: "text/plain",
	json: "application/json",
	jsonl: "application/x-ndjson",
	ndjson: "application/x-ndjson",
	xml: "application/xml",
	yaml: "application/yaml",
	yml: "application/yaml",
	toml: "application/toml",
	ini: "text/plain",
	cfg: "text/plain",
	conf: "text/plain",
	env: "text/plain",
};

/**
 * Map a file to the `kind` the downstream media helpers switch on.
 *
 * `kind` is load-bearing, not cosmetic: ONLY `image` rides the turn inline as a
 * native `ImageContent` block. Everything else arrives as an `analyze_media`
 * call-to-action carrying its path — that tool is the universal reader (PDF,
 * DOCX, XLSX, PPTX, ODF, EPUB, video, audio, text, source), and it is the ONLY
 * way in for a non-image, because Pi's content model is text + image and there
 * is no `document` or `video` content block to put an MP4 in.
 *
 * Anything unrecognised falls back to `document`, which always has a tool path
 * available — so an attachment is never simply refused for being unusual.
 */
export function inferAttachmentKind(filePath: string): PromptAttachment["kind"] {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (ext in INLINE_IMAGE_EXT) return "image";
	if (ext in VIDEO_EXT) return "video";
	if (ext in AUDIO_EXT) return "audio";
	// NON_INLINE_IMAGE_EXT deliberately lands here — see its comment.
	return "document";
}

/** Best-effort MIME from the extension. Unknown → octet-stream, still attachable. */
export function inferMimeType(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	return (
		INLINE_IMAGE_EXT[ext] ??
		NON_INLINE_IMAGE_EXT[ext] ??
		VIDEO_EXT[ext] ??
		AUDIO_EXT[ext] ??
		RICH_DOC_EXT[ext] ??
		TEXT_EXT[ext] ??
		"application/octet-stream"
	);
}

/**
 * Would a person plausibly have meant to ATTACH this, having merely written its
 * path in the middle of a sentence?
 *
 * ⚠ This gate governs ONE narrow case: a path we INFERRED from prose. It is not
 * a list of what you're allowed to attach — `@token`, `/attach`, and a bare drop
 * all bypass it entirely and take ANY file: a `.ts`, a `.log`, an extensionless
 * binary, a 400 MB `.mkv`, anything.
 *
 * It exists because "the file EXISTS on disk" is not a sufficient rule on POSIX.
 * `check /etc/hosts for me` names a file that really is there on every Linux and
 * macOS box; an existence-only rule attaches it and rewrites the sentence to
 * `check hosts for me`. Likewise `the bug is in /srv/app/index.js`.
 *
 * So prose-inferred paths must look like something a human ATTACHES — a picture,
 * a recording, a video, a document — rather than something they merely CITE. That
 * is why source, config, log, and data extensions are excluded here even though
 * they are perfectly attachable by an explicit gesture: in a sentence, a path to
 * `index.js` or `config.yaml` is overwhelmingly a reference, not an enclosure.
 */
export function isAttachableExtension(filePath: string): boolean {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	if (!ext) return false;
	return (
		ext in INLINE_IMAGE_EXT ||
		ext in NON_INLINE_IMAGE_EXT ||
		ext in VIDEO_EXT ||
		ext in AUDIO_EXT ||
		ext in RICH_DOC_EXT
	);
}

/**
 * Stat a path and build the staged record. Returns null when the path isn't a
 * readable regular file — the caller reports that to the operator rather than
 * staging something that will only fail later on the gateway.
 */
export function stageAttachment(rawPath: string): StagedAttachment | null {
	const resolved = path.resolve(expandHome(rawPath));
	let st: fs.Stats;
	try {
		st = fs.statSync(resolved);
	} catch {
		return null;
	}
	if (!st.isFile() || st.size === 0) return null;
	return {
		kind: inferAttachmentKind(resolved),
		path: resolved,
		mimeType: inferMimeType(resolved),
		fileName: path.basename(resolved),
		bytes: st.size,
	};
}

/** `~/x` → `<home>/x`. Terminals paste `~`-relative paths on macOS/Linux. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/* ─────────────────────── path extraction from a line ─────────────────── */

/**
 * The token shapes a terminal actually produces when you drop a file on it, plus
 * pi-tui's `@` completion output. Ordered longest-match-first so a quoted path
 * wins over the bare prefix inside it.
 *
 *   @"C:\a b\x.png"   @-prefixed, quoted (pi-tui, path with spaces)
 *   "C:\a b\x.png"    quoted (Windows Terminal drag-drop, spaces)
 *   'C:\a b\x.png'    single-quoted (some shells)
 *   file:///a/x.png   URI (GNOME/Wayland drag-drop)
 *   /Users/a/my\ x.png  backslash-escaped spaces (macOS/iTerm drag-drop)
 *   @src/foo.ts       @-prefixed bare (pi-tui completion)
 *   C:\a\x.png        bare absolute
 */
// Two subtleties, both learned the hard way on Windows:
//
//   1. The escaped-space branch `\\ ` MUST come first in each alternation. Try
//      `[^\s"']` first and it happily eats the lone backslash of `my\ report.pdf`,
//      then chokes on the space — truncating the path to `…/my\`.
//   2. The `@bare` branch has to ALLOW backslashes, or `@C:\shots\bug.png` never
//      matches as an `@`-token; the bare-absolute branch below then swallows the
//      path on its own and leaves an orphaned `@` in the text.
const TOKEN_PATTERNS: RegExp[] = [
	/@"([^"]+)"/g, // @-quoted
	/@'([^']+)'/g,
	/"([^"]+)"/g, // quoted
	/'([^']+)'/g,
	/\bfile:\/\/(\/[^\s"']+)/g, // file:// URI
	// @bare. The `(?<=^|\s)` lookbehind is what stops an EMAIL from feeding this:
	// without it, `ping bob@corp.com` offers `corp.com` as a candidate, which is
	// then resolved against the cwd — and silently attaches if a file of that name
	// happens to be sitting there. pi-tui's completion only ever inserts `@` at a
	// token boundary anyway, so nothing legitimate is lost.
	/(?<=^|\s)@((?:\\ |[^\s@"'])+)/g,
	/((?:[A-Za-z]:[\\/]|\/|~[\\/])(?:\\ |[^\s"'])+)/g, // bare absolute / ~-relative
];

/**
 * Trailing characters that belong to the SENTENCE, not to the filename.
 *
 * `did you read C:\docs\report.pdf?` — the `?` is punctuation, but the token
 * matcher swallows it, the stat fails, and the file silently does not attach.
 * The `@` case is the cruellest: the path came from a file picker, so the
 * operator has every reason to believe it worked. Same for a trailing full stop,
 * comma, or a closing paren from `(see C:\shots\bug.png)`.
 *
 * So a candidate that doesn't resolve gets its trailing punctuation peeled off,
 * one character at a time, and is retried. The peeled characters are put back
 * into the text — the sentence keeps its punctuation, the file gets attached.
 */
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

export interface ExtractedAttachments {
	/** The line with each matched path token replaced by the file's basename. */
	text: string;
	/** Files that exist on disk, in the order they appeared. Deduped by path. */
	staged: StagedAttachment[];
}

/**
 * Pull attachment paths out of a submitted line.
 *
 * Each matched token is replaced in the text by the file's BASENAME rather than
 * being deleted. That keeps the sentence readable — "look at @C:\shots\bug.png
 * and tell me" becomes "look at bug.png and tell me" — while the full path still
 * reaches the model, because the gateway prepends an `[attached image → <path>]`
 * note built from the attachment list. Deleting the token instead would leave
 * "look at  and tell me", stranding the referent.
 *
 * ── What may be attached, and when ────────────────────────────────────────
 * Silently attaching a file the operator merely MENTIONED is the worst failure
 * this module can have, so intent is graded in three tiers:
 *
 *   EXPLICIT (`@token`)         — you named it deliberately, using a picker that
 *                                 only completes real files. Any file, any
 *                                 extension, relative paths resolved against cwd.
 *   PURE DROP (line is nothing  — you dropped a file and pressed Enter with no
 *   but paths)                    other words. Unambiguous. Any file.
 *   INFERRED (a path sitting in  — could easily be a mention rather than an
 *   the middle of a sentence)     attachment. Must be ABSOLUTE *and* carry a
 *                                 recognised media/document extension.
 *
 * That last tier is what stops `check /etc/hosts for me` from attaching
 * /etc/hosts on Linux (it exists! an existence-only rule attaches it) and stops
 * `edit "package.json"` from attaching a cwd-relative file out of a quoted word.
 */
/**
 * The longest line the LIVE (per-keystroke) parser will look at.
 *
 * A dropped or copied path is short — even a deep Windows path is a few hundred
 * characters. A pasted log, diff, or JSON blob is not, and running the full
 * six-pattern parse over it on EVERY keystroke costs 200-400 ms per key (measured
 * on a 1 MB paste). That is the entire "the clipboard feels slow" complaint, and
 * it isn't the clipboard at all — it's the editor re-scanning a megabyte per
 * keypress. The submit-time parse still runs on the whole thing exactly once; only
 * the live path is capped.
 */
const MAX_LIVE_PARSE_CHARS = 4096;

export function extractAttachmentPaths(
	line: string,
	opts?: {
		/**
		 * Render each captured path as a `[plant-cell.png]` PILL rather than a bare
		 * basename. Used when rewriting the editor line at drop-time, where the pill's
		 * brackets are what make it read as an attachment chip instead of as a word
		 * the operator typed. Pills are stripped again before the turn is sent.
		 */
		pill?: boolean;
		/**
		 * LIVE mode — this runs on every editor keystroke, so it must be cheap and
		 * must never rewrite text the operator is still typing. It does ONLY the one
		 * thing a drop needs: recognise a whole-line ABSOLUTE path. It does not run the
		 * six-pattern tokeniser, does not resolve `@`-tokens against the cwd (a typed
		 * `@name` mention that happens to match a cwd file must not be silently
		 * attached — the module's own worst-case), and does not scan prose. The full
		 * parse still runs once at submit; this is just the instant-feedback path for a
		 * dropped file.
		 */
		live?: boolean;
	},
): ExtractedAttachments {
	const staged: StagedAttachment[] = [];
	const seen = new Set<string>();
	const label = (name: string): string => (opts?.pill ? `[${name}]` : name);
	let text = line;

	if (opts?.live) {
		// Too long to be a path → it's a paste; leave it entirely alone and pay
		// nothing. This is the guard that removes the per-keystroke stall.
		if (line.length > MAX_LIVE_PARSE_CHARS) return { text: line, staged: [] };
		// A drop arrives as a whole-line absolute path (optionally quoted). That is the
		// ONLY thing the live path stages — nothing relative, nothing from prose.
		const whole = line.trim().replace(/^["'](.*)["']$/, "$1");
		if (whole && path.isAbsolute(expandHome(whole))) {
			const att = stageAttachment(whole);
			if (att) return { text: label(att.fileName), staged: [att] };
		}
		return { text: line, staged: [] };
	}

	// WHOLE-LINE PATH — checked before any tokenising, because tokenising is exactly
	// what breaks here.
	//
	// A real filename: `ChatGPT Image Jul 11, 2026, 11_45_54 AM (1).png`. Spaces,
	// commas, parentheses. Terminals paste a dropped/copied path like that WITHOUT
	// quotes, and every token pattern below stops at the first space — so the
	// candidate becomes `…\Downloads\ChatGPT`, which is not a file, and the whole
	// thing silently falls through as prose. No pill, no attachment, no explanation.
	//
	// When the entire line IS the path there is nothing to tokenise and nothing to
	// disambiguate: take it verbatim. Absolute-only, so a one-word message can never
	// resolve against the cwd and attach something the operator merely typed.
	const whole = line.trim().replace(/^["'](.*)["']$/, "$1");
	if (whole && path.isAbsolute(expandHome(whole))) {
		const att = stageAttachment(whole);
		if (att) return { text: label(att.fileName), staged: [att] };
	}

	// Is this line nothing but paths? Strip every candidate token and see whether
	// any words survive. A bare drop ("C:\shots\bug.png" + Enter) leaves nothing,
	// which is unambiguous intent and lifts the extension gate below — so you can
	// drop a `.ts` file or an extensionless binary and still have it attach.
	let residue = line;
	for (const pattern of TOKEN_PATTERNS) {
		residue = residue.replace(new RegExp(pattern.source, pattern.flags), " ");
	}
	const isPureDrop = residue.trim() === "";

	for (const pattern of TOKEN_PATTERNS) {
		// Fresh regex per pass — these are module-level /g literals and would carry
		// `lastIndex` state across calls otherwise.
		const re = new RegExp(pattern.source, pattern.flags);
		// `@`-tokens are EXPLICIT: the operator picked the file from a completer. The
		// `(?<=…)` lookbehind means the source no longer starts with a literal `@`, so
		// test for it rather than for the first character.
		const isAtToken = pattern.source.includes("@");
		const tier: Tier = isAtToken ? "at" : isPureDrop ? "pureDrop" : "inferred";
		text = text.replace(re, (whole, captured: string) => {
			// Try the token as captured; if it doesn't resolve, peel trailing sentence
			// punctuation and try again, restoring the punctuation to the text.
			let candidate = decodeCandidate(captured);
			let trailer = "";
			let att = tryStage(candidate, tier);
			if (!att) {
				const peeled = candidate.replace(TRAILING_PUNCT, "");
				if (peeled !== candidate && peeled !== "") {
					trailer = candidate.slice(peeled.length);
					candidate = peeled;
					att = tryStage(candidate, tier);
				}
			}

			// Not a real file (or refused by the tier rules) → leave the ORIGINAL token
			// exactly as the operator typed it. Prose is never rewritten.
			if (!att) return whole;
			if (seen.has(att.path)) return label(att.fileName) + trailer;
			seen.add(att.path);
			staged.push(att);
			return label(att.fileName) + trailer;
		});
	}

	// NOTHING matched → hand back the ORIGINAL line, byte for byte.
	//
	// This early return is load-bearing and the reason it exists is worth stating:
	// this function runs on EVERY submitted line, so any normalisation it does
	// (collapsing runs of spaces, trimming) happens to every message the operator
	// ever sends — including a pasted Python snippet, a YAML block, a diff, or an
	// ASCII table, whose leading indentation would be silently destroyed. An
	// attachment parser has no business rewriting prose it found no paths in.
	if (staged.length === 0) return { text: line, staged: [] };

	// Something DID match, so `text` now carries basenames in place of paths. Even
	// here we only trim the ends — we never collapse interior whitespace, because a
	// message can perfectly well attach a screenshot AND paste indented code.
	return { text: text.trim(), staged };
}

/** Which tier of intent produced this candidate. See `extractAttachmentPaths`. */
type Tier = "at" | "pureDrop" | "inferred";

/**
 * Apply the tier rules to one candidate, then stage it if it's a real file.
 */
function tryStage(candidate: string, tier: Tier): StagedAttachment | null {
	// `at`: the operator picked this from a file completer. Deliberate by
	// construction — any file, any extension, relative paths resolved against cwd.
	if (tier === "at") return stageAttachment(candidate);

	const absolute = path.isAbsolute(expandHome(candidate));

	// `pureDrop`: the line was nothing BUT this token. Unambiguous for a dropped
	// file — but a terminal drop always pastes an ABSOLUTE path, whereas a bare
	// relative word is just as likely to be a one-word message. `"package.json"`
	// alone would otherwise resolve against the cwd and silently attach a file the
	// operator was merely naming.
	if (tier === "pureDrop") return absolute ? stageAttachment(candidate) : null;

	// `inferred`: a path found loose in a sentence. Must be absolute AND look like
	// attachable media — see `isAttachableExtension` for why existence alone is not
	// a safe rule on POSIX.
	if (!absolute || !isAttachableExtension(candidate)) return null;
	return stageAttachment(candidate);
}

/** Undo the escaping a terminal applies when it pastes a dropped path. */
function decodeCandidate(raw: string): string {
	let s = raw.trim();
	s = s.replace(/\\ /g, " "); // macOS/iTerm escape spaces
	if (s.startsWith("file://")) s = s.slice("file://".length);
	// A file:// URI is percent-encoded; a plain Windows path is not, and decoding
	// one is harmless (no % in a normal path). Guard anyway — a malformed escape
	// sequence would otherwise throw and kill the submit.
	try {
		if (/%[0-9A-Fa-f]{2}/.test(s)) s = decodeURIComponent(s);
	} catch {
		/* leave as-is */
	}
	// `/C:/x` — what a Windows file:// URI decodes to.
	if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
	return s;
}

/**
 * Max files on one turn. Mirrors the gateway's `PROMPT_ATTACHMENT_MAX_COUNT`.
 *
 * Enforced HERE, at staging, and not only on the gateway — because the gateway's
 * copy can only REJECT, and a `prompt` response carries no payload, so an over-cap
 * file would be dropped with nothing but a server-side log line, after the operator
 * had already watched it appear as a chip. Refusing at the moment of staging is the
 * only point at which we can actually tell them.
 */
export const MAX_STAGED_ATTACHMENTS = 8;

/* ──────────────────────────── clipboard ──────────────────────────────── */
//
// All the per-OS shelling out (PowerShell / osascript / wl-paste / xclip) lives in
// `./clipboard.ts` behind one `ClipboardBackend`. This file only knows the three
// MECHANISMS a clipboard can hand us something by — never which binary answers.

/** Spool a clipboard bitmap to a temp PNG, collapsing "an image with no file" into a path. */
function spoolPath(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(clipboardSpoolDir(), `clipboard-${stamp}.png`);
}

/**
 * The ONE clipboard service for the TUI's lifetime.
 *
 * Lazily started, because a CLI that never opens a TUI has no business holding a
 * PowerShell process open. Once started it stays: that is the whole point — the
 * cost of the clipboard used to be a process spawn PER READ (200–500 ms each,
 * and `/paste` did four of them in series), and now it is one round-trip on a
 * pipe that is already open.
 */
let service: ClipboardService | undefined;
let serviceOnImage: ((att: StagedAttachment) => void) | undefined;

function clipboard(): ClipboardService {
	if (!service) {
		service = startClipboardService((imagePath) => {
			const att = stageAttachment(imagePath);
			if (att) serviceOnImage?.(att);
		});
	}
	return service;
}

/**
 * Read the WHOLE clipboard once, and return whatever it can be attached from.
 *
 * One call, one answer. The shape this replaces asked four separate questions —
 * files, then image, then text, then formats — down four separate PowerShell
 * spawns, in series, which is exactly why a paste felt like it hung.
 *
 * The order of preference is not arbitrary: copying a file in Explorer ALSO puts
 * a thumbnail bitmap on the clipboard, and the operator meant the file, not its
 * thumbnail.
 */
export async function readClipboardAttachments(): Promise<{
	staged: StagedAttachment[];
	/** What the clipboard holds, when nothing could be attached from it. */
	reason?: string;
}> {
	const snap = await clipboard().read(spoolPath());

	// 1. FILES copied in the file manager — a reference, not bytes, which is why
	//    copy-pasting a 400 MB video is free.
	const files = stageAll(snap.files.map((f) => decodeCandidate(f)));
	if (files.length > 0) return { staged: files };

	// 2. An IMAGE — the one mechanism that cannot arrive through the terminal.
	if (snap.imagePath) {
		const att = stageAttachment(snap.imagePath);
		if (att) return { staged: [att] };
	}

	// 3. TEXT that is a PATH — "Copy as path", a path out of a log, or a terminal's
	//    own Ctrl+V of a copied file. The mechanism most Windows operators hit.
	const text = snap.text.trim().replace(/^["'](.*)["']$/, "$1");
	if (text) {
		const candidate = decodeCandidate(text);
		if (path.isAbsolute(expandHome(candidate))) {
			const att = stageAttachment(candidate);
			if (att) return { staged: [att] };
		}
	}

	// Nothing attachable. Say what IS there — "nothing to attach" states the outcome,
	// hides the cause, and is indistinguishable from a bug in Brigade.
	const formats = snap.formats.filter(Boolean);
	const reason =
		formats.length > 0
			? `the clipboard holds ${formats.slice(0, 4).join(", ")} — no image and no file.`
			: "the clipboard appears to be empty.";
	return { staged: [], reason };
}

/**
 * AUTO-ATTACH: hand back every image that lands on the clipboard from now on.
 *
 * This is the answer to "I should just be able to paste, without a command", and
 * it exists because Ctrl+V CANNOT be made to work. Windows Terminal's own
 * settings.json binds `ctrl+v` to `Terminal.PasteFromClipboard`; the terminal
 * consumes the key, and its paste inserts the clipboard's TEXT — which a
 * screenshot does not have. Nothing is sent, so there is no keystroke to hook.
 *
 * The worker pushes the SAVED path, so an auto-attach costs Node nothing at all:
 * no spawn, no poll, no clipboard read on our side.
 */
export function watchClipboardImages(
	onImage: (att: StagedAttachment) => void,
): ClipboardWatcher {
	// No terminal, no watcher. This is a convenience for a human sitting in front of
	// a TUI; there is nobody to convenience in a test, a pipe or a cron run — and a
	// never-exiting child process in those contexts is how you hang a suite (it did)
	// or leak a process nobody knows to kill.
	if (!process.stdout.isTTY) return { stop: () => {} };
	serviceOnImage = onImage;
	clipboard(); // starts the worker + its push channel
	return {
		stop: () => {
			service?.stop();
			service = undefined;
			serviceOnImage = undefined;
		},
	};
}

function stageAll(lines: string[]): StagedAttachment[] {
	const out: StagedAttachment[] = [];
	const seen = new Set<string>();
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const att = stageAttachment(decodeCandidate(line));
		if (att && !seen.has(att.path)) {
			seen.add(att.path);
			out.push(att);
		}
	}
	return out;
}

/* ─────────────────────────────── display ─────────────────────────────── */

const KIND_ICON: Record<PromptAttachment["kind"], string> = {
	image: "🖼",
	video: "🎬",
	audio: "🎵",
	voice: "🎙",
	document: "📄",
	sticker: "🏷",
};

export function attachmentIcon(kind: PromptAttachment["kind"]): string {
	return KIND_ICON[kind] ?? "📎";
}

/** `1.2 MB` — operator-facing sizes in the chip tray. */
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

/** The wire shape — drops the client-only display fields. */
export function toPromptAttachments(staged: readonly StagedAttachment[]): PromptAttachment[] {
	return staged.map((s) => ({
		kind: s.kind,
		path: s.path,
		mimeType: s.mimeType,
		fileName: s.fileName,
	}));
}
