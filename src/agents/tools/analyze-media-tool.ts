/**
 * `analyze_media` tool — comprehensive media + document understanding.
 *
 * The model hands this tool a local file PATH or a URL (+ an optional
 * `question`) and the tool RESOLVES the input into content the CURRENT turn's
 * model can reason about against that question. It auto-detects the kind by
 * extension / MIME and dispatches per-format.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS DESIGN (STEP-0 investigation findings — read before changing)
 * ─────────────────────────────────────────────────────────────────────────
 * 1. TOOL-RESULT CONTENT SHAPE. Pi types a tool's `AgentToolResult.content`
 *    as `(TextContent | ImageContent)[]` — TEXT or IMAGE only. There is NO
 *    `document` / `pdf` / `video` content-block type anywhere in the Pi SDK,
 *    and `Model.input` is `("text" | "image")[]` — the whole SDK content model
 *    is text + image. `ImageContent` is `{ type:"image"; data:<base64>;
 *    mimeType }`. So an IMAGE can flow to the model as a real multimodal block
 *    (the same shape `payload-mutators.ts` prunes from history, proving image
 *    blocks reach the provider); a PDF/DOCX/PPTX/XLSX/HTML/VIDEO can NOT be
 *    returned as a native non-text block. They must become TEXT.
 *
 * 2. NO AUX-MODEL RUNTIME. Brigade has no simple-completion helper — there is
 *    no path to run a one-off completion against a different model from inside
 *    a tool (confirmed: multiple in-tree comments say "Brigade has no
 *    simple-completion helper"). So the tool can only RETURN content for the
 *    CURRENT turn's model to analyze; it never calls a model itself.
 *
 * 3. REUSE. HTML → markdown reuses the existing readability/linkedom extractor
 *    (`web-fetch-utils.ts`); URL fetches route through the SSRF guard
 *    (`guardedFetch`, `infra/net/fetch-guard.ts`) with size + content-type
 *    caps; local paths reuse the outbound media-path guard
 *    (`security/media-path-guard.ts`) PLUS a workspace/cwd/cache root scoping
 *    so secrets/system files outside allowed roots are refused (the same
 *    posture the `read`/path-write guards enforce). Untrusted bytes are
 *    wrapped in the external-content envelope (`security/external-content.ts`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PER-FORMAT BEHAVIOUR
 * ─────────────────────────────────────────────────────────────────────────
 *   • image (png/jpg/jpeg/webp/gif/bmp/heic/heif): returned as an IMAGE block
 *     so a vision model sees it. HEIC/HEIF cannot be transcoded without a
 *     native dep, so they are passed through with their declared mime — most
 *     providers reject HEIC, so the tool warns. Capped by `maxBytes`. When the
 *     current model is known to be text-only, the tool says so instead of
 *     silently shipping a block the model can't consume.
 *   • pdf: text extracted per-page (`unpdf`, zero native deps) honoring a
 *     `pages` range, returned as TEXT. (Native-PDF document blocks are NOT
 *     reachable through Pi — see finding #1 — so every provider gets text.)
 *   • docx: unzip (`fflate`) → concatenate `word/document.xml` text runs.
 *   • pptx: unzip → per-slide text (`ppt/slides/slideN.xml`), slide-numbered,
 *     honoring `pages` as a slide range.
 *   • xlsx: unzip → `xl/sharedStrings.xml` + each `xl/worksheets/sheetN.xml`
 *     → CSV-ish per-sheet text.
 *   • html (or a URL returning HTML): readability/linkedom → markdown.
 *   • video (mp4/webm/mov/…): Pi has no video modality, so the tool is honest:
 *     it returns a clear "video understanding needs a video-capable model that
 *     Brigade cannot drive through the current tool-result content channel"
 *     message. (No transcription is attempted here — the inbound media note
 *     path already transcribes audio when an STT provider is configured; this
 *     tool does not duplicate that plumbing.)
 *
 * The user's `question` is ALWAYS echoed back as a leading text block so the
 * model knows what to do with the resolved content.
 *
 * SECURITY POSTURE: read capability — NOT owner-only — but it MUST honour the
 * path guard (local) + SSRF guard (URL). Registered for every sender; no
 * mutation, no spend.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type, type Static } from "typebox";

import { guardedFetch, SsrfBlockedError } from "../../infra/net/fetch-guard.js";
import { validateOutboundMediaPath } from "../../security/media-path-guard.js";
import { wrapWebContent } from "../../security/external-content.js";
import { resolveCacheDir, resolveStateDir } from "../../config/paths.js";
import {
	composeFetchBody,
	extractBasicHtmlContent,
	extractReadableContent,
} from "./web-fetch-utils.js";
import { truncateText } from "./web-shared.js";
import { BrigadeToolInputError, jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/* ─────────────────────────── tunables ─────────────────────────── */

/** Default hard cap on bytes read for ANY source (image bytes, doc bytes, fetched body). */
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB
/** Absolute ceiling — even an explicit `maxBytes` is clamped to this. */
const MAX_BYTES_CEILING = 48 * 1024 * 1024; // 48 MiB
/** Image blocks are the most token-expensive — cap them tighter by default. */
const DEFAULT_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
/** Max characters of extracted text returned to the model (keeps the turn bounded). */
const DEFAULT_MAX_CHARS = 60_000;
/** Per-request HTTP timeout for URL sources. */
const FETCH_TIMEOUT_MS = 45_000;

/* ─────────────────────────── kind detection ─────────────────────────── */

export type MediaKind = "image" | "pdf" | "docx" | "pptx" | "xlsx" | "html" | "video";

/** Extension → kind. Lowercase, no leading dot. */
const EXT_KIND: Record<string, MediaKind> = {
	// images
	png: "image",
	jpg: "image",
	jpeg: "image",
	webp: "image",
	gif: "image",
	bmp: "image",
	heic: "image",
	heif: "image",
	// documents
	pdf: "pdf",
	docx: "docx",
	pptx: "pptx",
	xlsx: "xlsx",
	// markup
	html: "html",
	htm: "html",
	// video
	mp4: "video",
	webm: "video",
	mov: "video",
	m4v: "video",
	mkv: "video",
	avi: "video",
	mpeg: "video",
	mpg: "video",
};

/** MIME prefix/exact → kind, consulted when the extension is ambiguous (URLs). */
function kindFromMime(mime: string | undefined): MediaKind | undefined {
	if (!mime) return undefined;
	const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	if (m === "application/pdf") return "pdf";
	if (m === "text/html" || m === "application/xhtml+xml") return "html";
	if (
		m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	)
		return "docx";
	if (
		m === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	)
		return "pptx";
	if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
		return "xlsx";
	return undefined;
}

/** Pull a lowercase extension (no dot) from a path or URL pathname. */
export function extensionOf(source: string): string {
	let p = source;
	try {
		if (/^https?:\/\//i.test(source)) p = new URL(source).pathname;
	} catch {
		/* not a URL — treat as a path */
	}
	const ext = path.extname(p).toLowerCase().replace(/^\./, "");
	return ext;
}

/** Image mime from extension (no `data:` prefix — Pi's ImageContent wants raw base64 + mimeType). */
function imageMimeFromExt(ext: string): string {
	switch (ext) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "bmp":
			return "image/bmp";
		case "heic":
			return "image/heic";
		case "heif":
			return "image/heif";
		default:
			return "image/png";
	}
}

/**
 * Resolve the kind. Explicit `kind` override wins; else extension; else MIME
 * (URL responses). Returns undefined when nothing matches (unsupported).
 */
export function detectKind(args: {
	source: string;
	override?: string;
	mime?: string;
}): MediaKind | undefined {
	if (args.override) {
		const k = args.override.toLowerCase();
		if (
			k === "image" ||
			k === "pdf" ||
			k === "docx" ||
			k === "pptx" ||
			k === "xlsx" ||
			k === "html" ||
			k === "video"
		) {
			return k;
		}
	}
	const ext = extensionOf(args.source);
	if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
	return kindFromMime(args.mime);
}

/* ─────────────────────────── params ─────────────────────────── */

const AnalyzeMediaParams = Type.Object({
	source: Type.String({
		description:
			"Local file PATH or http(s) URL to analyze. Images, PDF, DOCX, PPTX, XLSX, HTML, and video are auto-detected by extension/MIME.",
	}),
	question: Type.Optional(
		Type.String({
			description:
				"What to analyze / extract / answer about the media. Optional but strongly encouraged — it is echoed to the model alongside the resolved content.",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "Alias for `question`. Use one or the other.",
		}),
	),
	pages: Type.Optional(
		Type.String({
			description:
				'Page (PDF) or slide (PPTX) range to limit extraction, e.g. "1-5", "3", or "2-". 1-indexed. Ignored for other kinds.',
		}),
	),
	maxBytes: Type.Optional(
		Type.Integer({
			description: `Optional cap on bytes read from the source (default ${DEFAULT_MAX_BYTES}, ceiling ${MAX_BYTES_CEILING}).`,
			minimum: 1024,
		}),
	),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("image"),
				Type.Literal("pdf"),
				Type.Literal("docx"),
				Type.Literal("pptx"),
				Type.Literal("xlsx"),
				Type.Literal("html"),
				Type.Literal("video"),
			],
			{
				description:
					"Optional override of the auto-detected kind (use when the extension/MIME is wrong or missing).",
			},
		),
	),
});

export interface AnalyzeMediaDetails {
	ok: boolean;
	source: string;
	sourceType: "url" | "path";
	kind?: MediaKind;
	mimeType?: string;
	bytes?: number;
	/** What block type was returned to the model. */
	returned: "image" | "text" | "none";
	pages?: string;
	truncated?: boolean;
	warning?: string;
	message?: string;
}

/* ─────────────────────────── model capability seam ─────────────────────────── */

/**
 * Minimal model context the tool uses to decide whether returning an IMAGE
 * block is meaningful. Threaded from the agent loop (provider + modelId of the
 * resolved turn model). All fields optional — when absent the tool assumes the
 * model CAN see images (the common case) but still annotates uncertainty for
 * the operator.
 */
export interface AnalyzeMediaModelContext {
	provider?: string;
	modelId?: string;
	/** Explicit override of image capability when the caller already resolved `model.input`. */
	imageInput?: boolean;
}

/**
 * Decide whether the current model can consume an IMAGE block. When
 * `imageInput` is set explicitly we trust it. Otherwise we infer from the
 * provider/model id with a conservative, self-contained heuristic (no heavy
 * model-resolution on the hot path): the major multimodal families return
 * true; a small set of known text-only model-id markers return false; unknown
 * → undefined ("assume yes, note it").
 */
export function modelLikelySeesImages(
	ctx: AnalyzeMediaModelContext | undefined,
): boolean | undefined {
	if (!ctx) return undefined;
	if (typeof ctx.imageInput === "boolean") return ctx.imageInput;
	const id = (ctx.modelId ?? "").toLowerCase();
	if (!id) return undefined;
	// Known text-only / no-vision markers — be explicit, return false.
	if (/\b(text-only|no-?vision)\b/.test(id)) return false;
	if (/(^|[/-])(o1-mini|o3-mini)([-/]|$)/.test(id)) return false;
	if (/(^|[/-])gpt-3\.5/.test(id)) return false;
	// Major multimodal families — vision-capable.
	if (/(claude|gpt-4|gpt-5|gemini|llava|pixtral|qwen.*vl|grok-(?:2|3|4)|gpt-4o)/.test(id)) {
		return true;
	}
	// Unknown — caller decides; we report uncertainty.
	return undefined;
}

/* ─────────────────────────── source acquisition ─────────────────────────── */

interface AcquiredBytes {
	bytes: Buffer;
	mime?: string;
	truncated: boolean;
}

/** Roots a local source path is allowed to live under (workspace, cwd, OS cache/temp, state dir). */
function allowedLocalRoots(opts: { workspaceDir?: string; cwd?: string }): string[] {
	const roots = new Set<string>();
	const add = (p?: string) => {
		if (!p) return;
		try {
			roots.add(path.resolve(p));
		} catch {
			/* ignore */
		}
	};
	add(opts.workspaceDir);
	add(opts.cwd);
	add(resolveCacheDir());
	add(process.env.TMPDIR || process.env.TEMP || process.env.TMP || "");
	try {
		add(os.tmpdir());
	} catch {
		/* ignore */
	}
	// The state dir's media/cache subtree is where inbound attachments + generated
	// media land; allow it so the model can analyze a file it just received.
	try {
		add(path.join(resolveStateDir(), "channels"));
		add(path.join(resolveStateDir(), "cache"));
		add(path.join(resolveStateDir(), "captures"));
		add(path.join(resolveStateDir(), "workspace"));
	} catch {
		/* ignore */
	}
	return [...roots].filter((r) => r.length > 0);
}

/** True when `resolved` is inside one of `roots` (path.relative containment, no `..`). */
function isInsideAnyRoot(resolved: string, roots: string[]): boolean {
	for (const root of roots) {
		const rel = path.relative(root, resolved);
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

/**
 * Read a LOCAL file with the same safety posture as `read` / outbound media:
 *   1. media-path guard (refuse secrets / system files / credential dirs).
 *   2. allowed-root scoping (must be under workspace / cwd / cache / temp /
 *      state media subtree) — refuses arbitrary absolute reads outside roots.
 * Symlinks are resolved first (the guards do this too) so a benign name can't
 * smuggle a denied target.
 */
async function acquireLocalBytes(
	source: string,
	opts: { workspaceDir?: string; cwd?: string; maxBytes: number },
): Promise<AcquiredBytes> {
	const verdict = validateOutboundMediaPath(source);
	if (!verdict.ok) {
		throw new BrigadeToolInputError(verdict.reason ?? "refusing to read that path");
	}
	let resolved: string;
	try {
		resolved = fs.realpathSync(path.resolve(source));
	} catch {
		resolved = path.resolve(source);
	}
	const roots = allowedLocalRoots(opts);
	if (!isInsideAnyRoot(resolved, roots)) {
		throw new BrigadeToolInputError(
			"refusing to read a path outside the allowed roots (workspace / current dir / cache / temp). " +
				"Move the file into the workspace, or pass a URL.",
		);
	}
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(resolved);
	} catch {
		throw new BrigadeToolInputError(`file not found: ${source}`);
	}
	if (!stat.isFile()) throw new BrigadeToolInputError(`not a file: ${source}`);
	if (stat.size === 0) throw new BrigadeToolInputError(`file is empty: ${source}`);
	const full = await fsp.readFile(resolved);
	const truncated = full.length > opts.maxBytes;
	const bytes = truncated ? full.subarray(0, opts.maxBytes) : full;
	return { bytes, truncated };
}

/**
 * Fetch a URL through the SSRF guard with size + timeout caps. Reads the body
 * in bounded chunks so a giant response can't blow memory.
 */
async function acquireUrlBytes(
	source: string,
	opts: { maxBytes: number; signal?: AbortSignal },
): Promise<AcquiredBytes> {
	const { response, finalUrl } = await guardedFetch(source, {
		method: "GET",
		headers: {
			accept: "*/*",
			"user-agent":
				"Mozilla/5.0 (compatible; Brigade/1.0; +https://brigade.spinabot.com)",
		},
		timeoutMs: FETCH_TIMEOUT_MS,
		...(opts.signal ? { signal: opts.signal } : {}),
	});
	void finalUrl;
	if (response.status >= 400) {
		throw new BrigadeToolInputError(`fetch failed: HTTP ${response.status} for ${source}`);
	}
	const mime = response.headers.get("content-type") ?? undefined;
	const bytes = await readBodyCapped(response, opts.maxBytes);
	return { bytes: bytes.buf, mime, truncated: bytes.truncated };
}

/** Stream a Response body into a Buffer, stopping at `maxBytes`. */
async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
	if (!response.body) {
		const ab = await response.arrayBuffer();
		const full = Buffer.from(ab);
		const truncated = full.length > maxBytes;
		return { buf: truncated ? full.subarray(0, maxBytes) : full, truncated };
	}
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		const chunk = Buffer.from(value);
		if (total + chunk.length > maxBytes) {
			chunks.push(chunk.subarray(0, maxBytes - total));
			truncated = true;
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			break;
		}
		chunks.push(chunk);
		total += chunk.length;
	}
	return { buf: Buffer.concat(chunks), truncated };
}

/* ─────────────────────────── page-range parsing ─────────────────────────── */

/**
 * Parse a 1-indexed page/slide range like "1-5", "3", "2-" into a predicate
 * over 1-indexed page numbers. Invalid input → accept all (best-effort, never
 * throws). Exported for tests.
 */
export function parsePageRange(
	spec: string | undefined,
	total: number,
): (pageNum1: number) => boolean {
	if (!spec || !spec.trim()) return () => true;
	const s = spec.trim();
	const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(s);
	if (m) {
		const lo = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
		const hi = m[2] ? Math.min(total, parseInt(m[2], 10)) : total;
		return (n) => n >= lo && n <= hi;
	}
	const single = /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
	if (Number.isFinite(single)) return (n) => n === single;
	return () => true;
}

/* ─────────────────────────── XML text helpers (docx/pptx/xlsx) ─────────────────────────── */

/** Decode the 5 predefined XML entities. */
function decodeXmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
		.replace(/&amp;/g, "&"); // amp LAST so we don't double-decode
}

function safeCodePoint(code: number): string {
	return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/**
 * Pull text from OOXML `<a:t>` / `<w:t>` / `<t>` run elements in document
 * order. Works for Word (`w:t`), PowerPoint (`a:t`), and Excel shared strings
 * (`t`). Paragraph/row boundaries (`</w:p>`, `</a:p>`, `</tr>`) become
 * newlines so the text stays readable.
 */
function ooxmlRunsToText(xml: string): string {
	// Insert newlines at paragraph / line-break / table-row boundaries first.
	const withBreaks = xml
		.replace(/<\/w:p>/g, "\n")
		.replace(/<\/a:p>/g, "\n")
		.replace(/<w:br\s*\/?>/g, "\n")
		.replace(/<a:br\s*\/?>/g, "\n");
	const out: string[] = [];
	// Match <prefix:t ...>text</prefix:t> and bare <t ...>text</t>.
	const re = /<(?:[a-zA-Z]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z]+:)?t>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(withBreaks)) !== null) {
		out.push(decodeXmlEntities(m[1] ?? ""));
	}
	return out.join("");
}

/** Lazy fflate import — keeps the unzip cost off the cold-start path. */
async function unzipEntries(bytes: Buffer): Promise<Record<string, Uint8Array>> {
	const { unzipSync } = await import("fflate");
	try {
		return unzipSync(new Uint8Array(bytes)) as unknown as Record<string, Uint8Array>;
	} catch {
		// fflate throws "invalid zip data" on a corrupt / non-OOXML file.
		// Convert to a clean tool-input error so the model sees a usable
		// message instead of a raw library throw.
		throw new BrigadeToolInputError(
			"could not read the file as an Office document (corrupt, password-protected, or not a real .docx/.pptx/.xlsx)",
		);
	}
}

async function entryText(
	entries: Record<string, Uint8Array>,
	name: string,
): Promise<string | undefined> {
	const u8 = entries[name];
	if (!u8) return undefined;
	const { strFromU8 } = await import("fflate");
	return strFromU8(u8);
}

/* ─────────────────────────── per-format extractors ─────────────────────────── */

async function extractDocx(bytes: Buffer): Promise<string> {
	const entries = await unzipEntries(bytes);
	const doc = await entryText(entries, "word/document.xml");
	if (!doc) throw new BrigadeToolInputError("not a valid .docx (missing word/document.xml)");
	const text = ooxmlRunsToText(doc).replace(/\n{3,}/g, "\n\n").trim();
	if (!text) throw new BrigadeToolInputError("no extractable text in the .docx");
	return text;
}

async function extractPptx(bytes: Buffer, pages: string | undefined): Promise<string> {
	const entries = await unzipEntries(bytes);
	// slide files are ppt/slides/slideN.xml — order by N.
	const slideNames = Object.keys(entries)
		.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
		.sort((a, b) => slideNum(a) - slideNum(b));
	if (slideNames.length === 0)
		throw new BrigadeToolInputError("not a valid .pptx (no slides found)");
	const inRange = parsePageRange(pages, slideNames.length);
	const parts: string[] = [];
	for (let i = 0; i < slideNames.length; i++) {
		const num = i + 1;
		if (!inRange(num)) continue;
		const xml = await entryText(entries, slideNames[i] as string);
		const text = xml ? ooxmlRunsToText(xml).replace(/\n{3,}/g, "\n\n").trim() : "";
		parts.push(`--- Slide ${num} ---\n${text}`);
	}
	const joined = parts.join("\n\n").trim();
	if (!joined) throw new BrigadeToolInputError("no extractable text in the .pptx");
	return joined;
}

function slideNum(name: string): number {
	const m = /slide(\d+)\.xml$/.exec(name);
	return m ? parseInt(m[1] as string, 10) : 0;
}

async function extractXlsx(bytes: Buffer): Promise<string> {
	const entries = await unzipEntries(bytes);
	// Shared strings table — cells reference into it by index.
	const sharedXml = await entryText(entries, "xl/sharedStrings.xml");
	const shared: string[] = [];
	if (sharedXml) {
		// Each <si> is one shared string; it may contain multiple <t> runs.
		const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
		let m: RegExpExecArray | null;
		while ((m = siRe.exec(sharedXml)) !== null) {
			shared.push(ooxmlRunsToText(m[1] ?? ""));
		}
	}
	const sheetNames = Object.keys(entries)
		.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
		.sort((a, b) => sheetNum(a) - sheetNum(b));
	if (sheetNames.length === 0)
		throw new BrigadeToolInputError("not a valid .xlsx (no worksheets found)");
	const out: string[] = [];
	for (let i = 0; i < sheetNames.length; i++) {
		const xml = await entryText(entries, sheetNames[i] as string);
		if (!xml) continue;
		out.push(`--- Sheet ${i + 1} ---`);
		out.push(sheetXmlToCsv(xml, shared));
	}
	const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	if (!joined) throw new BrigadeToolInputError("no extractable data in the .xlsx");
	return joined;
}

function sheetNum(name: string): number {
	const m = /sheet(\d+)\.xml$/.exec(name);
	return m ? parseInt(m[1] as string, 10) : 0;
}

/**
 * Turn a worksheet XML into CSV-ish rows. Each `<row>` becomes a line; each
 * `<c>` cell is resolved — `t="s"` cells index into the shared-string table,
 * inline / numeric cells use their `<v>` (or inline `<t>`). Best-effort: cells
 * are emitted in document order separated by commas (column gaps are not
 * reconstructed — text fidelity over grid fidelity, which is what the model
 * needs to reason about the content).
 */
function sheetXmlToCsv(xml: string, shared: string[]): string {
	const rows: string[] = [];
	const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
	let rm: RegExpExecArray | null;
	while ((rm = rowRe.exec(xml)) !== null) {
		const rowXml = rm[1] ?? "";
		const cells: string[] = [];
		const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
		let cm: RegExpExecArray | null;
		while ((cm = cellRe.exec(rowXml)) !== null) {
			const attrs = cm[1] ?? cm[3] ?? "";
			const inner = cm[2] ?? "";
			const isShared = /\bt="s"/.test(attrs);
			const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
			const inlineT = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
			let value = "";
			if (isShared && vMatch) {
				const idx = parseInt(vMatch[1] ?? "", 10);
				value = Number.isFinite(idx) ? shared[idx] ?? "" : "";
			} else if (inlineT) {
				value = decodeXmlEntities(inlineT[1] ?? "");
			} else if (vMatch) {
				value = decodeXmlEntities(vMatch[1] ?? "");
			}
			// CSV-escape: wrap in quotes when it contains a comma / quote / newline.
			if (/[",\n]/.test(value)) value = `"${value.replace(/"/g, '""')}"`;
			cells.push(value);
		}
		rows.push(cells.join(","));
	}
	return rows.join("\n");
}

/** PDF → per-page text via unpdf (zero native deps). Honors `pages`. */
async function extractPdf(
	bytes: Buffer,
	pages: string | undefined,
): Promise<{ text: string; totalPages: number }> {
	const { getDocumentProxy, extractText } = await import("unpdf");
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		pdf = await getDocumentProxy(new Uint8Array(bytes));
	} catch {
		throw new BrigadeToolInputError("could not parse the PDF (corrupt or password-protected?)");
	}
	const { totalPages, text } = await extractText(pdf, { mergePages: false });
	const perPage = Array.isArray(text) ? text : [String(text)];
	const inRange = parsePageRange(pages, totalPages);
	const parts: string[] = [];
	for (let i = 0; i < perPage.length; i++) {
		const num = i + 1;
		if (!inRange(num)) continue;
		const t = (perPage[i] ?? "").trim();
		parts.push(`--- Page ${num} ---\n${t}`);
	}
	const joined = parts.join("\n\n").trim();
	return { text: joined, totalPages };
}

/** HTML bytes → markdown via the shared readability extractor (with regex fallback). */
async function extractHtml(bytes: Buffer, baseUrl: string): Promise<string> {
	const html = bytes.toString("utf8");
	const readable = await extractReadableContent(html, baseUrl).catch(() => null);
	const extracted = readable ?? extractBasicHtmlContent(html);
	const { text } = composeFetchBody(extracted, {
		extractMode: "markdown",
		maxChars: DEFAULT_MAX_CHARS,
	});
	return text;
}

/* ─────────────────────────── tool factory ─────────────────────────── */

export interface MakeAnalyzeMediaToolOptions {
	/** Workspace dir — an allowed root for local-path reads. */
	workspaceDir?: string;
	/** Process cwd — an allowed root for local-path reads. */
	cwd?: string;
	/** Resolved turn model context — drives whether an IMAGE block is meaningful. */
	modelContext?: AnalyzeMediaModelContext;
	/** Test seam: replace the URL fetch acquisition. */
	acquireUrl?: typeof acquireUrlBytes;
	/** Test seam: replace the local-file acquisition. */
	acquireLocal?: typeof acquireLocalBytes;
}

export function makeAnalyzeMediaTool(
	opts: MakeAnalyzeMediaToolOptions = {},
): BrigadeTool<typeof AnalyzeMediaParams, AnalyzeMediaDetails> {
	const acquireUrl = opts.acquireUrl ?? acquireUrlBytes;
	const acquireLocal = opts.acquireLocal ?? acquireLocalBytes;
	return {
		name: "analyze_media",
		label: "Analyze Media",
		displaySummary: "analyzing media",
		// Read capability — NOT owner-only. It reads a file/URL the operator
		// pointed at and hands content to the model; it never mutates state or
		// spends. The path guard + SSRF guard are the real safety boundary, and
		// they run for EVERY sender regardless of owner status.
		ownerOnly: false,
		description: [
			"Understand a local file or URL: images, PDF, DOCX, PPTX, XLSX, HTML, and video (auto-detected by extension/MIME).",
			"Pass `source` (a local path or http(s) URL) and a `question` describing what to analyze.",
			"Images are handed to the model as a viewable image; PDF/DOCX/PPTX/XLSX/HTML are extracted to text/markdown; video is reported as unsupported (no video-capable channel exists).",
			"Use `pages` to limit a PDF/PPTX range (e.g. \"1-5\"). Use this instead of bash/curl — it applies the SSRF guard for URLs and the path guard for local files.",
		].join(" "),
		parameters: AnalyzeMediaParams,
		execute: async (
			_toolCallId,
			args: Static<typeof AnalyzeMediaParams>,
			signal,
		): Promise<AgentToolResult<AnalyzeMediaDetails>> => {
			const source = (args.source ?? "").trim();
			if (!source) throw new BrigadeToolInputError("source required");
			const question = (args.question ?? args.prompt ?? "").trim();
			const isUrl = /^https?:\/\//i.test(source);
			const sourceType: "url" | "path" = isUrl ? "url" : "path";
			// Image blocks are the most token-expensive to ship, so when the
			// source LOOKS like an image (by extension or explicit kind) apply
			// the tighter image budget unless the caller raised maxBytes
			// explicitly. Documents/HTML keep the larger default.
			const looksImage =
				(args.kind ? args.kind === "image" : false) ||
				EXT_KIND[extensionOf(source)] === "image";
			const maxBytes = clampBytes(args.maxBytes, looksImage);

			// Acquire bytes (with the right guard for the source type).
			let acquired: AcquiredBytes;
			try {
				acquired = isUrl
					? await acquireUrl(source, {
							maxBytes,
							...(signal ? { signal } : {}),
						})
					: await acquireLocal(source, {
							...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
							...(opts.cwd ? { cwd: opts.cwd } : {}),
							maxBytes,
						});
			} catch (err) {
				if (err instanceof SsrfBlockedError) {
					throw new BrigadeToolInputError(`refused to fetch the URL: ${err.reason}`);
				}
				throw err;
			}

			// Detect kind (override → ext → MIME).
			const kind = detectKind({
				source,
				...(args.kind ? { override: args.kind } : {}),
				...(acquired.mime ? { mime: acquired.mime } : {}),
			});
			if (!kind) {
				return failure({
					source,
					sourceType,
					...(acquired.mime ? { mimeType: acquired.mime } : {}),
					bytes: acquired.bytes.length,
					message:
						"Unsupported or undetectable media type. Supported: image (png/jpg/jpeg/webp/gif/bmp/heic), pdf, docx, pptx, xlsx, html, video. " +
						"Pass an explicit `kind` if the extension/MIME is missing.",
				});
			}

			// Dispatch per kind.
			switch (kind) {
				case "image":
					return handleImage({
						source,
						sourceType,
						bytes: acquired.bytes,
						truncated: acquired.truncated,
						mime: acquired.mime,
						question,
						modelContext: opts.modelContext,
					});
				case "video":
					return handleVideo({ source, sourceType, question, modelContext: opts.modelContext });
				case "pdf":
				case "docx":
				case "pptx":
				case "xlsx":
				case "html":
					return handleTextExtract({
						kind,
						source,
						sourceType,
						bytes: acquired.bytes,
						truncated: acquired.truncated,
						mime: acquired.mime,
						question,
						pages: args.pages,
					});
			}
		},
	};

	/* ── handlers (closures so they share `opts`) ── */

	function handleImage(p: {
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		truncated: boolean;
		mime?: string;
		question: string;
		modelContext?: AnalyzeMediaModelContext;
	}): AgentToolResult<AnalyzeMediaDetails> {
		const ext = extensionOf(p.source);
		const mimeType = (p.mime?.split(";")[0]?.trim() || imageMimeFromExt(ext)).toLowerCase();
		const isHeic = /heic|heif/.test(mimeType) || ext === "heic" || ext === "heif";
		const sees = modelLikelySeesImages(p.modelContext);

		const promptText = buildPromptText(p.question, "image");
		const warnings: string[] = [];
		if (isHeic) {
			warnings.push(
				"This is a HEIC/HEIF image. Brigade cannot transcode it without a native dependency, so it is passed through as-is — many models reject HEIC. If the model cannot read it, ask the operator to convert it to JPEG/PNG.",
			);
		}
		if (sees === false) {
			// The current model is text-only — be honest rather than ship a
			// block it will reject.
			warnings.push(
				"The current model does not appear to accept images, so the image is NOT being attached. Switch to a vision-capable model (e.g. a Claude / GPT-4o / Gemini model) and try again.",
			);
			return {
				content: [{ type: "text", text: `${promptText}\n\n${warnings.join("\n\n")}` }],
				details: {
					ok: false,
					source: p.source,
					sourceType: p.sourceType,
					kind: "image",
					mimeType,
					bytes: p.bytes.length,
					returned: "none",
					warning: warnings.join(" "),
				},
			};
		}
		if (sees === undefined) {
			warnings.push(
				"Note: Brigade could not confirm this model is vision-capable. If you cannot see the image, switch to a vision-capable model.",
			);
		}
		if (p.truncated) {
			warnings.push(
				"The image was truncated at the byte cap and may be corrupt — raise `maxBytes` if it does not render.",
			);
		}
		const text = warnings.length > 0 ? `${promptText}\n\n${warnings.join("\n\n")}` : promptText;
		return {
			// Image block carries raw base64 (NO data: prefix) — Pi's ImageContent
			// shape. This is the SAME block inbound/history images use, so a
			// vision model sees it as part of the turn.
			content: [
				{ type: "text", text },
				{ type: "image", data: p.bytes.toString("base64"), mimeType },
			],
			details: {
				ok: true,
				source: p.source,
				sourceType: p.sourceType,
				kind: "image",
				mimeType,
				bytes: p.bytes.length,
				returned: "image",
				...(p.truncated ? { truncated: true } : {}),
				...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
			},
		};
	}

	function handleVideo(p: {
		source: string;
		sourceType: "url" | "path";
		question: string;
		modelContext?: AnalyzeMediaModelContext;
	}): AgentToolResult<AnalyzeMediaDetails> {
		// Pi's content model is text + image only — there is no video content
		// block and no video modality, so even a video-capable model (e.g.
		// Gemini) cannot be fed the video through a tool result. Be honest.
		const promptText = buildPromptText(p.question, "video");
		const msg =
			"Video understanding is not available: Brigade's tool-result channel can carry only text and images, " +
			"so a video file cannot be handed to the model here — even a video-capable model (e.g. Gemini) would need " +
			"a video content block that this runtime does not support. " +
			"If the video has speech you need, extract the audio and send it through a channel with a configured " +
			"transcription provider (inbound audio is auto-transcribed), or summarize key frames as images and analyze those.";
		return {
			content: [{ type: "text", text: `${promptText}\n\n${msg}` }],
			details: {
				ok: false,
				source: p.source,
				sourceType: p.sourceType,
				kind: "video",
				returned: "none",
				message: msg,
			},
		};
	}

	async function handleTextExtract(p: {
		kind: Exclude<MediaKind, "image" | "video">;
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		truncated: boolean;
		mime?: string;
		question: string;
		pages?: string;
	}): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		let rawText = "";
		let totalPages: number | undefined;
		try {
			switch (p.kind) {
				case "pdf": {
					const r = await extractPdf(p.bytes, p.pages);
					rawText = r.text;
					totalPages = r.totalPages;
					break;
				}
				case "docx":
					rawText = await extractDocx(p.bytes);
					break;
				case "pptx":
					rawText = await extractPptx(p.bytes, p.pages);
					break;
				case "xlsx":
					rawText = await extractXlsx(p.bytes);
					break;
				case "html":
					rawText = await extractHtml(p.bytes, p.sourceType === "url" ? p.source : "about:blank");
					break;
			}
		} catch (err) {
			if (err instanceof BrigadeToolInputError) {
				return failure({
					source: p.source,
					sourceType: p.sourceType,
					kind: p.kind,
					...(p.mime ? { mimeType: p.mime } : {}),
					bytes: p.bytes.length,
					message: err.message,
				});
			}
			throw err;
		}

		if (!rawText.trim()) {
			return failure({
				source: p.source,
				sourceType: p.sourceType,
				kind: p.kind,
				...(p.mime ? { mimeType: p.mime } : {}),
				bytes: p.bytes.length,
				message:
					p.kind === "pdf"
						? "No selectable text found — the PDF may be a scanned image. Image-only PDFs need OCR, which this tool does not perform."
						: `No extractable text found in the ${p.kind}.`,
			});
		}

		const { text: clamped, truncated: textTruncated } = truncateText(rawText, DEFAULT_MAX_CHARS);
		// Document text is from a file the operator pointed at, but it can still
		// carry injected instructions (a hostile PDF/HTML). Wrap it in the
		// untrusted-content envelope so the model treats it as data, not as
		// instructions. `web_fetch` is the closest existing envelope source.
		const wrapped = wrapWebContent(clamped, "web_fetch", { includeWarning: true });
		const promptText = buildPromptText(p.question, p.kind);
		const truncated = p.truncated || textTruncated;
		const notes: string[] = [];
		if (totalPages !== undefined) notes.push(`PDF total pages: ${totalPages}.`);
		if (p.pages && (p.kind === "pdf" || p.kind === "pptx")) {
			notes.push(`Limited to ${p.kind === "pdf" ? "pages" : "slides"} "${p.pages}".`);
		}
		if (truncated) notes.push("Content was truncated to fit the turn — raise `maxBytes` / narrow `pages` for more.");
		const noteBlock = notes.length > 0 ? `\n\n(${notes.join(" ")})` : "";

		return {
			content: [{ type: "text", text: `${promptText}${noteBlock}\n\n${wrapped}` }],
			details: {
				ok: true,
				source: p.source,
				sourceType: p.sourceType,
				kind: p.kind,
				...(p.mime ? { mimeType: p.mime } : {}),
				bytes: p.bytes.length,
				returned: "text",
				...(p.pages ? { pages: p.pages } : {}),
				...(truncated ? { truncated: true } : {}),
			},
		};
	}
}

/* ─────────────────────────── small helpers ─────────────────────────── */

function clampBytes(requested: number | undefined, looksImage = false): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) {
		return looksImage ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_MAX_BYTES;
	}
	return Math.max(1024, Math.min(MAX_BYTES_CEILING, Math.floor(requested)));
}

/** Build the leading instruction text the model reads before the content. */
function buildPromptText(question: string, kind: MediaKind): string {
	const what =
		kind === "image"
			? "the image below"
			: kind === "video"
				? "the video referenced below"
				: `the extracted ${kind} content below`;
	if (question) return `Analyze ${what} and answer this:\n${question}`;
	return `Analyze ${what} and describe / summarize what it contains.`;
}

function failure(d: Omit<AnalyzeMediaDetails, "ok" | "returned"> & { message: string }): AgentToolResult<AnalyzeMediaDetails> {
	return jsonResult({ ok: false, returned: "none", ...d }) as AgentToolResult<AnalyzeMediaDetails>;
}

// Image byte cap is applied where the image handler runs; export the constant
// so callers/tests can reference the tighter image default.
export { DEFAULT_IMAGE_MAX_BYTES, DEFAULT_MAX_BYTES, DEFAULT_MAX_CHARS };
