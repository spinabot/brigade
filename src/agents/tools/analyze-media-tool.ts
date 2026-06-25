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
 * 2. DIRECT-PROVIDER UNDERSTANDING (the gap-closer). For modalities Pi can't
 *    carry — VIDEO, native/scanned PDF, and images on a text-only current
 *    model — the tool calls a provider REST API DIRECTLY via the
 *    media-understanding subsystem (`agents/media-understanding/`): it ships
 *    the media bytes + the question to Gemini (video → Files API; image/pdf →
 *    inline) or Anthropic (pdf → native `document` block with OCR; image →
 *    image block) and gets back TEXT, which it returns for the current model.
 *    Keys are resolved through Brigade's existing credential store
 *    (`readBrigadeCredentials`), never invented here. This bypasses Pi's
 *    text+image content cap WITHOUT needing a Pi aux-model runtime.
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
 *   • image (png/jpg/jpeg/webp/gif/bmp/heic/heif): when the CURRENT model is
 *     vision-capable, returned as an IMAGE block so the model sees it (cheap —
 *     no extra call). When the current model is text-only, the tool routes the
 *     image to a vision-capable provider and returns the resulting TEXT — via
 *     the Pi SDK against ANY keyed provider with an image-capable model
 *     (OpenAI / OpenRouter / Groq / xAI / Mistral / Ollama / …), or the bespoke
 *     google/anthropic REST adapters — so vision works on any model + any
 *     configured provider. HEIC/HEIF cannot be transcoded without a native dep,
 *     so they are passed through with their declared mime — most providers
 *     reject HEIC, so the tool warns. Capped by `maxBytes`.
 *   • audio (mp3/wav/m4a/ogg/oga/flac/aac/opus): routed to the media-
 *     understanding subsystem (Gemini inline — audio is GEMINI-ONLY because Pi's
 *     content model is text + image, so no Pi-drivable provider can ingest an
 *     audio block) and the TEXT transcription / summary is returned, so voice
 *     notes work. Needs a Google/Gemini key; with none the tool returns a clear
 *     "configure a Gemini key" message (NOT a provider 400).
 *   • pdf: when an understanding provider key is configured, the PDF is sent
 *     NATIVELY (Anthropic `document` block — OCRs scanned pages + reads layout;
 *     or Gemini inline) and the provider's TEXT answer is returned, so scanned
 *     / no-text-layer PDFs now work. With no key (or `mode:"text"`) it falls
 *     back to per-page text extraction (`unpdf`, zero native deps) honoring a
 *     `pages` range. `mode:"provider"` forces the provider path.
 *   • docx: unzip (`fflate`) → concatenate `word/document.xml` text runs.
 *   • pptx: unzip → per-slide text (`ppt/slides/slideN.xml`), slide-numbered,
 *     honoring `pages` as a slide range.
 *   • xlsx: unzip → `xl/sharedStrings.xml` + each `xl/worksheets/sheetN.xml`
 *     → CSV-ish per-sheet text.
 *   • html (or a URL returning HTML): readability/linkedom → markdown.
 *   • video (mp4/webm/mov/…): always routed to the media-understanding
 *     subsystem (Gemini via the Files API: upload → poll ACTIVE →
 *     generateContent with a fileData part), and the model's TEXT description
 *     is returned. Needs a Google/Gemini key; with none the tool returns a
 *     clear "configure a Gemini key" message.
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
import {
	downscaleImageToBudget,
	isDownscalableImageMime,
	type DownscaleResult,
} from "./image-downscale.js";
import {
	extractOoxmlImages,
	resolveSlideOrder,
	type ExtractedOoxmlImage,
} from "./ooxml-images.js";
import {
	mediaCacheKey,
	readMediaCache,
	writeMediaCache,
	type MediaCacheValue,
} from "./media-cache.js";
import {
	resolveCacheDir,
	resolveOsCacheDir,
	resolveStateDir,
	DEFAULT_AGENT_ID,
} from "../../config/paths.js";
import {
	runMediaUnderstanding as defaultRunMediaUnderstanding,
	resolvePiModel,
	MediaUnderstandingUnavailableError,
	type MediaUnderstandingConfig,
	type MediaUnderstandingKind,
	type RunMediaUnderstandingRequest,
	type RunMediaUnderstandingResult,
} from "../media-understanding/index.js";
import { buildMediaUnderstandingConfig } from "../media-understanding/config.js";
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
/** Max images accepted in one batch (`sources[]`). Matches the field cap. */
const MAX_BATCH_IMAGES = 20;
/** Max non-image (document/text) sources accepted in one batch. */
const MAX_BATCH_DOCS = 10;
/**
 * Max EMBEDDED images surfaced from a single OOXML document when
 * `includeImages` is set. A real deck can carry many pictures (the failure case
 * had 35); cap the count (reusing the batch cap) so the turn stays bounded, and
 * report "showing N of M" when truncated. Per-image + total byte budgets reuse
 * the existing image downscale path.
 */
const MAX_EMBEDDED_IMAGES = MAX_BATCH_IMAGES;
/**
 * Total byte budget across ALL embedded image blocks from one document, so a
 * deck with many large pictures can't blow the turn even under the count cap.
 * Each image is downscaled to the per-image budget first; once the running total
 * would exceed this ceiling, remaining images are dropped (and reported).
 */
const EMBEDDED_IMAGES_TOTAL_BYTES = 24 * 1024 * 1024; // 24 MiB

/**
 * Image MIME types that the understanding providers reliably accept on an image
 * block. Anthropic's Messages API accepts ONLY jpeg / png / gif / webp and
 * returns a 400 for anything else (e.g. image/bmp, image/tiff); Gemini + the
 * Pi-driven providers are similarly conservative. So before routing an image to
 * a provider we re-encode any other (decodable) raster format to JPEG via the
 * downscale path. `image/heic`/`image/heif` are intentionally NOT here — they
 * are not decodable without a native dep (they pass through with their declared
 * mime + a warning).
 */
const PROVIDER_SAFE_IMAGE_MIME = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/* ─────────────────────────── kind detection ─────────────────────────── */

export type MediaKind =
	| "image"
	| "pdf"
	| "docx"
	| "pptx"
	| "xlsx"
	| "html"
	| "video"
	| "audio"
	| "text"
	// extra document formats (broader than either rival tool)
	| "odt" // OpenDocument text
	| "ods" // OpenDocument spreadsheet
	| "odp" // OpenDocument presentation
	| "epub" // EPUB e-book (zip of XHTML)
	| "rtf" // Rich Text Format
	| "ipynb"; // Jupyter notebook (JSON)

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
	// OpenDocument + e-book + rich-text + notebook (broader than either rival)
	odt: "odt",
	ods: "ods",
	odp: "odp",
	epub: "epub",
	rtf: "rtf",
	ipynb: "ipynb",
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
	// audio (voice notes + clips). `.webm`/`.ogg` are ambiguous (audio OR video);
	// they map to video above — the model can pass an explicit `kind:"audio"`, or
	// a URL's `audio/*` MIME re-routes to audio via `kindFromMime`.
	mp3: "audio",
	wav: "audio",
	m4a: "audio",
	oga: "audio",
	ogg: "audio",
	flac: "audio",
	aac: "audio",
	opus: "audio",
	// plain / structured text + common source-code files. Read as UTF-8, wrapped
	// in the untrusted-content envelope, returned as text. (Both rival tools
	// accept these; Brigade used to reject them outright.)
	txt: "text",
	text: "text",
	log: "text",
	csv: "text",
	tsv: "text",
	json: "text",
	jsonl: "text",
	ndjson: "text",
	json5: "text",
	xml: "text",
	yaml: "text",
	yml: "text",
	toml: "text",
	ini: "text",
	cfg: "text",
	conf: "text",
	env: "text",
	properties: "text",
	md: "text",
	markdown: "text",
	mdx: "text",
	rst: "text",
	tex: "text",
	srt: "text",
	vtt: "text",
	// source code
	js: "text",
	mjs: "text",
	cjs: "text",
	jsx: "text",
	ts: "text",
	tsx: "text",
	mts: "text",
	cts: "text",
	py: "text",
	rb: "text",
	go: "text",
	rs: "text",
	java: "text",
	kt: "text",
	kts: "text",
	c: "text",
	h: "text",
	cc: "text",
	cpp: "text",
	cxx: "text",
	hpp: "text",
	cs: "text",
	php: "text",
	swift: "text",
	scala: "text",
	sh: "text",
	bash: "text",
	zsh: "text",
	fish: "text",
	ps1: "text",
	bat: "text",
	sql: "text",
	r: "text",
	lua: "text",
	pl: "text",
	dart: "text",
	ex: "text",
	exs: "text",
	clj: "text",
	hs: "text",
	css: "text",
	scss: "text",
	sass: "text",
	less: "text",
	svg: "text",
};

/** MIME prefix/exact → kind, consulted when the extension is ambiguous (URLs). */
function kindFromMime(mime: string | undefined): MediaKind | undefined {
	if (!mime) return undefined;
	const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("video/")) return "video";
	if (m.startsWith("audio/")) return "audio";
	if (m === "application/pdf") return "pdf";
	if (m === "text/html" || m === "application/xhtml+xml") return "html";
	// Structured-text content types — JSON / XML / YAML / CSV / source. Checked
	// AFTER html so an HTML page still routes to the readability extractor.
	if (
		m.startsWith("text/") ||
		m === "application/json" ||
		m === "application/ld+json" ||
		m === "application/xml" ||
		m === "application/x-ndjson" ||
		m === "application/x-yaml" ||
		m === "application/yaml" ||
		m === "application/toml" ||
		m === "application/x-sh" ||
		m === "image/svg+xml" ||
		/\+json$/.test(m) ||
		/\+xml$/.test(m)
	) {
		return "text";
	}
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
	if (m === "application/vnd.oasis.opendocument.text") return "odt";
	if (m === "application/vnd.oasis.opendocument.spreadsheet") return "ods";
	if (m === "application/vnd.oasis.opendocument.presentation") return "odp";
	if (m === "application/epub+zip") return "epub";
	if (m === "application/rtf" || m === "text/rtf") return "rtf";
	if (m === "application/x-ipynb+json") return "ipynb";
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

/** Video mime from extension — used when a local video has no declared MIME. */
function videoMimeFromExt(ext: string): string {
	switch (ext) {
		case "webm":
			return "video/webm";
		case "mov":
			return "video/quicktime";
		case "m4v":
			return "video/x-m4v";
		case "mkv":
			return "video/x-matroska";
		case "avi":
			return "video/x-msvideo";
		case "mpeg":
		case "mpg":
			return "video/mpeg";
		default:
			return "video/mp4";
	}
}

/** Audio mime from extension — used when a local audio file has no declared MIME. */
function audioMimeFromExt(ext: string): string {
	switch (ext) {
		case "wav":
			return "audio/wav";
		case "m4a":
			return "audio/mp4";
		case "aac":
			return "audio/aac";
		case "flac":
			return "audio/flac";
		case "oga":
		case "ogg":
			return "audio/ogg";
		case "opus":
			return "audio/opus";
		default:
			return "audio/mpeg";
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
			k === "video" ||
			k === "audio" ||
			k === "text" ||
			k === "odt" ||
			k === "ods" ||
			k === "odp" ||
			k === "epub" ||
			k === "rtf" ||
			k === "ipynb"
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
	source: Type.Optional(
		Type.String({
			description:
				"Local file PATH or http(s) URL to analyze. Images, PDF, DOCX, PPTX, XLSX, HTML, plain/structured text, audio (voice notes), and video are auto-detected by extension/MIME. For a single file. Use `sources` to analyze several at once.",
		}),
	),
	sources: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Several local PATHs / http(s) URLs to analyze together in ONE call (e.g. compare photos, or read many files). Images are shown as multiple image blocks; documents/text are concatenated under per-file labels. Caps: 20 images / 10 documents per call. When set, takes precedence over `source`.",
		}),
	),
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
	includeImages: Type.Optional(
		Type.Boolean({
			description:
				"For an Office document (PPTX/DOCX/XLSX): whether to ALSO extract the embedded images (wireframes / screenshots / diagrams / charts inside the file) and show them to the model alongside the text — so you SEE the visuals, not just read titles. DEFAULT TRUE: analyzing an Office doc on a vision model returns its embedded images automatically, no flag needed. For a PPTX, `pages` scopes which slides' images come back (e.g. pages:\"8-13\"). Images are labeled by slide where known and capped (≈20); use `pages` to scope a big deck. Set `false` to skip images (text only, cheaper). NEVER unzip the file with bash/python to get its images — this tool already does it.",
		}),
	),
	language: Type.Optional(
		Type.String({
			description:
				'Optional spoken-language hint for AUDIO transcription (e.g. "es", "Spanish", "en-US"). Improves accuracy for non-English voice notes; ignored for non-audio kinds.',
		}),
	),
	provider: Type.Optional(
		Type.Union([Type.Literal("google"), Type.Literal("anthropic")], {
			description:
				"Optional provider override for understanding video / native-PDF / text-only-model images (else auto-selected from configured keys). google = Gemini.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Optional provider model id override for the understanding call (e.g. gemini-2.5-pro, claude-sonnet-4-5). Ignored for the local text-extraction path.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("provider"), Type.Literal("text")], {
			description:
				'PDF handling: "auto" (default — provider when a key is configured, else local text extraction), "provider" (force the native provider path), or "text" (force local unpdf text extraction).',
		}),
	),
	maxBytes: Type.Optional(
		Type.Integer({
			description: `Optional cap on bytes read from the source (default ${DEFAULT_MAX_BYTES}, ceiling ${MAX_BYTES_CEILING}).`,
			minimum: 1024,
		}),
	),
	maxTokens: Type.Optional(
		Type.Integer({
			description:
				"Optional cap on the provider answer length (output tokens) for the understanding call (image-via-provider / PDF / audio / video). Default ~4096; clamped to a sane window. Ignored for the local text-extraction path.",
			minimum: 64,
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
				Type.Literal("audio"),
				Type.Literal("text"),
				// OpenDocument + e-book + rich-text + notebook — `detectKind` already
				// routes these, so the override must accept them too (lets the model
				// force e.g. kind:"epub" to rescue a mis-detected / extension-less file).
				Type.Literal("odt"),
				Type.Literal("ods"),
				Type.Literal("odp"),
				Type.Literal("epub"),
				Type.Literal("rtf"),
				Type.Literal("ipynb"),
			],
			{
				description:
					"Optional override of the auto-detected kind (use when the extension/MIME is wrong or missing). Use \"audio\" for a voice note whose extension is ambiguous (e.g. .ogg/.webm); \"text\" to force plain/structured-text reading; odt/ods/odp/epub/rtf/ipynb to force an OpenDocument / e-book / rich-text / notebook read.",
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
	/** When the result came from a direct provider call: which provider + model produced it. */
	provider?: string;
	providerModel?: string;
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
function allowedLocalRoots(opts: { workspaceDir?: string; cwd?: string; ownerLocalAccess?: boolean }): string[] {
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
	// media land in FILESYSTEM mode; allow it so the model can analyze a file it
	// just received.
	try {
		add(path.join(resolveStateDir(), "channels"));
		add(path.join(resolveStateDir(), "cache"));
		add(path.join(resolveStateDir(), "captures"));
		add(path.join(resolveStateDir(), "workspace"));
	} catch {
		/* ignore */
	}
	// In CONVEX mode inbound channel media relocates OUT of ~/.brigade to the OS
	// cache dir (the channel media resolvers write to
	// `resolveOsCacheDir()/channels/<id>/...` — see channels/whatsapp/media.ts;
	// other channels mirror this). BlueBubbles writes inbound media to
	// `resolveOsCacheDir()/bluebubbles/<acct>/inbound-media` in BOTH modes
	// (connection.ts). Without these roots, a perfectly valid "analyze the photo
	// I just sent" fails in convex mode. `resolveCacheDir()` already returns the
	// OS cache root in convex mode, but adding `resolveOsCacheDir()` (+ the two
	// channel subtrees) explicitly covers filesystem-mode BlueBubbles and any
	// pre-context window where the mode peek hasn't settled. The media-path guard
	// (`validateOutboundMediaPath`) still independently refuses secrets / system
	// files / credential dirs, so widening to the machine-local cache is safe.
	try {
		const osCache = resolveOsCacheDir();
		add(osCache);
		add(path.join(osCache, "channels"));
		add(path.join(osCache, "bluebubbles"));
	} catch {
		/* ignore */
	}
	// macOS Messages Attachments root. The NATIVE iMessage adapter surfaces the
	// bridge's on-disk attachment path AS-IS (it does NOT copy bytes into a cache
	// dir the way BlueBubbles does — see channels/imessage/media.ts
	// resolveInboundAttachments), so an inbound iMessage PDF/doc lives under
	// `~/Library/Messages/Attachments/...`. Without this root, "analyze the PDF I
	// just iMessaged" throws "outside the allowed roots" (images still auto-see via
	// inline base64). The iMessage adapter already constrains inbound paths to its
	// own attachmentRoots allow-list, and `validateOutboundMediaPath` still refuses
	// secrets/system files independently, so admitting this read-only Apple data
	// dir is safe. (A REMOTE iMessage bridge SCP-copies bytes into an OS temp dir,
	// already covered above.) Only meaningful on macOS; harmless elsewhere (the
	// path simply never exists).
	try {
		add(path.join(os.homedir(), "Library", "Messages", "Attachments"));
	} catch {
		/* ignore */
	}
	// OWNER local turns only (TUI / desktop / the operator's own channel messages):
	// the operator routinely references a file by an absolute path that lives in a
	// personal directory — Downloads / Desktop / Documents — NOT under the workspace
	// or cwd. Without this an "analyze C:\Users\me\Downloads\report.pdf" from the
	// owner is refused as "outside the allowed roots", which is the wrong default
	// for the trusted operator on their own machine. We widen to the operator's home
	// dir (covers Downloads/Desktop/Documents and anything they point at). This is
	// gated on `ownerLocalAccess` so an UNTRUSTED remote channel sender can NEVER
	// make Brigade read the operator's home — a remote turn threads senderIsOwner:
	// false → this stays off. `validateOutboundMediaPath` still independently refuses
	// secrets / credential dirs / system files even for the owner, so the home dir's
	// ~/.ssh, ~/.aws, .env, brigade.json, etc. remain denied.
	if (opts.ownerLocalAccess) {
		try {
			add(os.homedir());
		} catch {
			/* ignore */
		}
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
	opts: { workspaceDir?: string; cwd?: string; maxBytes: number; ownerLocalAccess?: boolean },
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

/* ── extra document formats (ODF / EPUB / RTF / IPYNB) — broader than rivals ── */

/**
 * Pull text from OpenDocument XML (`content.xml`). ODF uses `<text:p>` /
 * `<text:h>` paragraphs, `<text:span>` runs, and `<text:line-break/>` /
 * `<text:tab/>`; spreadsheets use `<table:table-cell>` / `<table:table-row>`.
 * Strategy mirrors `ooxmlRunsToText`: insert newlines at block boundaries, then
 * strip remaining tags and decode entities.
 */
function odfXmlToText(xml: string): string {
	const withBreaks = xml
		.replace(/<text:line-break\s*\/?>/g, "\n")
		.replace(/<text:tab\s*\/?>/g, "\t")
		.replace(/<\/text:p>/g, "\n")
		.replace(/<\/text:h>/g, "\n")
		.replace(/<\/table:table-row>/g, "\n")
		.replace(/<\/table:table-cell>/g, "\t");
	// Drop every remaining tag, then decode the 5 predefined XML entities.
	const stripped = withBreaks.replace(/<[^>]+>/g, "");
	return decodeXmlEntities(stripped)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** OpenDocument (odt/ods/odp) → text from `content.xml`. */
async function extractOpenDocument(bytes: Buffer, kind: "odt" | "ods" | "odp"): Promise<string> {
	const entries = await unzipEntries(bytes);
	const content = await entryText(entries, "content.xml");
	if (!content)
		throw new BrigadeToolInputError(
			`not a valid .${kind} (missing content.xml — corrupt or not an OpenDocument file)`,
		);
	const text = odfXmlToText(content);
	if (!text) throw new BrigadeToolInputError(`no extractable text in the .${kind}`);
	return text;
}

/**
 * EPUB → concatenated readable text. An EPUB is a zip of XHTML "chapters"; we
 * read them in spine order (from the OPF manifest) when resolvable, else fall
 * back to every `.x?html` entry sorted by name. Each chapter's markup is run
 * through the basic HTML extractor so only the readable text survives.
 */
async function extractEpub(bytes: Buffer): Promise<string> {
	const entries = await unzipEntries(bytes);
	const names = Object.keys(entries);
	// Resolve spine order via the OPF (content.opf) when present.
	const opfName = names.find((n) => /\.opf$/i.test(n));
	let ordered: string[] = [];
	if (opfName) {
		const opf = (await entryText(entries, opfName)) ?? "";
		const opfDir = opfName.includes("/") ? opfName.slice(0, opfName.lastIndexOf("/") + 1) : "";
		// manifest: id → href
		const idToHref = new Map<string, string>();
		const itemRe = /<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*\/?>/g;
		let im: RegExpExecArray | null;
		while ((im = itemRe.exec(opf)) !== null) {
			idToHref.set(im[1] as string, im[2] as string);
		}
		// also handle href-before-id ordering
		const itemRe2 = /<item\b[^>]*\bhref="([^"]+)"[^>]*\bid="([^"]+)"[^>]*\/?>/g;
		while ((im = itemRe2.exec(opf)) !== null) {
			if (!idToHref.has(im[2] as string)) idToHref.set(im[2] as string, im[1] as string);
		}
		const spineRe = /<itemref\b[^>]*\bidref="([^"]+)"/g;
		let sm: RegExpExecArray | null;
		while ((sm = spineRe.exec(opf)) !== null) {
			const href = idToHref.get(sm[1] as string);
			if (href) {
				const full = decodeURIComponent(opfDir + href).replace(/^\.\//, "");
				if (entries[full]) ordered.push(full);
			}
		}
	}
	if (ordered.length === 0) {
		ordered = names.filter((n) => /\.x?html?$/i.test(n)).sort();
	}
	const parts: string[] = [];
	for (const name of ordered) {
		const html = (await entryText(entries, name)) ?? "";
		if (!html.trim()) continue;
		const extracted = extractBasicHtmlContent(html);
		const { text } = composeFetchBody(extracted, { extractMode: "markdown", maxChars: DEFAULT_MAX_CHARS });
		if (text.trim()) parts.push(text.trim());
		if (parts.join("\n\n").length > DEFAULT_MAX_CHARS) break; // bound the work
	}
	const joined = parts.join("\n\n").trim();
	if (!joined) throw new BrigadeToolInputError("no extractable text in the .epub");
	return joined;
}

/**
 * RTF → plain text. A small control-word stripper: drops `{\\*\\...}` groups
 * (fonts/colour tables/pictures), decodes `\\'hh` hex + `\\uN` unicode escapes,
 * maps `\\par`/`\\line`/`\\tab` to whitespace, and removes the remaining
 * `\\control` words and group braces. Best-effort — fidelity is text, not layout.
 */
function extractRtf(bytes: Buffer): string {
	let rtf = bytes.toString("latin1");
	if (!/^\s*{\\rtf/i.test(rtf)) {
		throw new BrigadeToolInputError("not a valid .rtf (missing the {\\rtf header)");
	}
	// Remove destination groups that carry no body text (font/colour/info/pict…).
	rtf = rtf.replace(
		/\{\\\*?\\(?:fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|latentstyles|datastore|generator)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/gi,
		" ",
	);
	// Line / paragraph / tab control words → whitespace.
	rtf = rtf.replace(/\\par[d]?\b/g, "\n").replace(/\\line\b/g, "\n").replace(/\\tab\b/g, "\t");
	// Hex escapes \'hh → the byte (latin1).
	rtf = rtf.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h: string) => {
		const code = parseInt(h, 16);
		return Number.isFinite(code) ? String.fromCharCode(code) : "";
	});
	// Unicode escapes \uNNNN (followed by a fallback char we drop).
	rtf = rtf.replace(/\\u(-?\d+)\??/g, (_m, n: string) => {
		let code = parseInt(n, 10);
		if (code < 0) code += 65536; // RTF emits negative for >32767
		return Number.isFinite(code) ? String.fromCodePoint(code) : "";
	});
	// Escaped literals.
	rtf = rtf.replace(/\\([{}\\])/g, "$1");
	// Remaining control words / symbols.
	rtf = rtf.replace(/\\[a-zA-Z]+-?\d* ?/g, "").replace(/\\[^a-zA-Z]/g, "");
	// Group braces.
	rtf = rtf.replace(/[{}]/g, "");
	return rtf.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Jupyter notebook (.ipynb) → text. Walks `cells[]`, joining each cell's
 * `source` (string or string[]) under a per-cell label, prefixing code cells so
 * the model knows code from prose. Cell OUTPUTS are skipped (often huge / binary
 * image data) — only the authored source is returned.
 */
function extractIpynb(bytes: Buffer): string {
	let nb: { cells?: Array<{ cell_type?: string; source?: unknown }> };
	try {
		nb = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new BrigadeToolInputError("not a valid .ipynb (could not parse the notebook JSON)");
	}
	const cells = Array.isArray(nb.cells) ? nb.cells : [];
	if (cells.length === 0) throw new BrigadeToolInputError("the notebook has no cells");
	const parts: string[] = [];
	let n = 0;
	for (const cell of cells) {
		n += 1;
		const type = typeof cell.cell_type === "string" ? cell.cell_type : "code";
		const src = Array.isArray(cell.source)
			? cell.source.join("")
			: typeof cell.source === "string"
				? cell.source
				: "";
		if (!src.trim()) continue;
		if (type === "markdown" || type === "raw") {
			parts.push(`--- Cell ${n} (${type}) ---\n${src.trim()}`);
		} else {
			parts.push(`--- Cell ${n} (code) ---\n\`\`\`\n${src.trim()}\n\`\`\``);
		}
	}
	const joined = parts.join("\n\n").trim();
	if (!joined) throw new BrigadeToolInputError("no source text found in the notebook cells");
	return joined;
}

/* ─────────────────────────── tool factory ─────────────────────────── */

export interface MakeAnalyzeMediaToolOptions {
	/** Workspace dir — an allowed root for local-path reads. */
	workspaceDir?: string;
	/** Process cwd — an allowed root for local-path reads. */
	cwd?: string;
	/**
	 * OWNER local turn (TUI / desktop / the operator's own channel messages):
	 * widen the allowed local-read roots to the operator's HOME dir so a
	 * user-typed absolute path into Downloads / Desktop / Documents resolves
	 * (the common "analyze C:\Users\me\Downloads\report.pdf" case). MUST stay
	 * false/undefined for an untrusted remote channel sender so they can't make
	 * Brigade read the operator's home. The media-path guard still refuses
	 * secrets / system files even when this is on.
	 */
	ownerLocalAccess?: boolean;
	/** Caller's agent id — selects which auth profiles back the provider keys. */
	agentId?: string;
	/** Resolved turn model context — drives whether an IMAGE block is meaningful. */
	modelContext?: AnalyzeMediaModelContext;
	/** Test seam: replace the URL fetch acquisition. */
	acquireUrl?: typeof acquireUrlBytes;
	/** Test seam: replace the local-file acquisition. */
	acquireLocal?: typeof acquireLocalBytes;
	/**
	 * Media-understanding config (key resolution + per-kind defaults). Lazily
	 * built from Brigade's credential store via `buildMediaUnderstandingConfig`
	 * when omitted; tests inject one with a stub `resolveKey`.
	 */
	mediaUnderstandingConfig?: MediaUnderstandingConfig;
	/** Test seam: replace the media-understanding entry point (mocks provider HTTP). */
	runMediaUnderstanding?: (req: RunMediaUnderstandingRequest) => Promise<RunMediaUnderstandingResult>;
	/**
	 * Test seam: replace the oversize-image downscaler (defaults to the real
	 * jimp-backed `downscaleImageToBudget`). Lets tests assert the resize/branch
	 * without bundling a real codec.
	 */
	downscaleImage?: typeof downscaleImageToBudget;
	/**
	 * Cache provider (Gemini/Anthropic) understanding RESULTS keyed by
	 * `sha256(bytes)+question+provider+model+maxTokens` so re-analyzing the same
	 * media doesn't pay for the call twice. Default ON (disk-backed LRU under
	 * `resolveCacheDir()`). Set `false` to disable. Tests pass injected
	 * `readCache`/`writeCache` to avoid disk I/O.
	 */
	resultCache?: boolean;
	/** Test seam: replace the cache READ (defaults to the disk cache). */
	readCache?: typeof readMediaCache;
	/** Test seam: replace the cache WRITE (defaults to the disk cache). */
	writeCache?: typeof writeMediaCache;
}

export function makeAnalyzeMediaTool(
	opts: MakeAnalyzeMediaToolOptions = {},
): BrigadeTool<typeof AnalyzeMediaParams, AnalyzeMediaDetails> {
	const acquireUrl = opts.acquireUrl ?? acquireUrlBytes;
	const acquireLocal = opts.acquireLocal ?? acquireLocalBytes;
	const runUnderstanding = opts.runMediaUnderstanding ?? defaultRunMediaUnderstanding;
	const downscaleImage = opts.downscaleImage ?? downscaleImageToBudget;
	// Result cache: ON by default. A test-injected read/write seam overrides the
	// disk implementation; `resultCache:false` disables it entirely.
	const cacheEnabled = opts.resultCache !== false;
	const readCache = opts.readCache ?? readMediaCache;
	const writeCache = opts.writeCache ?? writeMediaCache;
	const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
	// Lazily resolve the media-understanding config (key resolution + per-kind
	// defaults) from Brigade's credential store the first time it is needed, so
	// constructing the tool never touches the auth store. A test-injected config
	// short-circuits this.
	let muConfig: MediaUnderstandingConfig | undefined = opts.mediaUnderstandingConfig;
	const getMuConfig = (): MediaUnderstandingConfig => {
		if (!muConfig) muConfig = buildMediaUnderstandingConfig(agentId);
		return muConfig;
	};
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
			"Understand a local file or URL: images, PDF, DOCX, PPTX, XLSX, ODT/ODS/ODP, EPUB, RTF, Jupyter (.ipynb), HTML, plain/structured text (txt/csv/json/xml/yaml/md/log/source code), audio (voice notes), and video (auto-detected by extension/MIME).",
			"Pass `source` (a single local path or http(s) URL) — or `sources` (an array) to analyze several at once — and a `question` describing what to analyze.",
			"Images are shown to a vision model (or, on a text-only model, understood via any configured provider with an image-capable model) and oversize images are DOWNSCALED to fit (never truncated); PDF is read natively when a provider key is configured (scanned PDFs work) else extracted to text; office/e-book/notebook/text files are extracted to text; AUDIO is transcribed/summarized via a Google/Gemini key (with an optional `language` hint); VIDEO is understood via a Google/Gemini key.",
			"Use `pages` to limit a PDF/PPTX range (e.g. \"1-5\"). Use this instead of bash/curl — it applies the SSRF guard for URLs and the path guard for local files.",
		].join(" "),
		parameters: AnalyzeMediaParams,
		execute: async (
			_toolCallId,
			args: Static<typeof AnalyzeMediaParams>,
			signal,
		): Promise<AgentToolResult<AnalyzeMediaDetails>> => {
			// Resolve the source LIST. `sources[]` (new, batch) wins; else the single
			// `source` (back-compat) becomes a one-element list. De-dupe blanks.
			const list = (
				Array.isArray(args.sources) && args.sources.length > 0
					? args.sources
					: args.source
						? [args.source]
						: []
			)
				.map((s) => (s ?? "").trim())
				.filter((s) => s.length > 0);
			if (list.length === 0) throw new BrigadeToolInputError("source required");
			// Single source → the exact existing behaviour (one result, image block
			// or text). Multiple → the batch merge.
			if (list.length === 1) return analyzeOne(list[0] as string, args, signal);
			return analyzeBatch(list, args, signal);
		},
	};

	/* ── single-source pipeline (the original per-source path) ── */

	/** Analyze ONE source end-to-end → a complete tool result (image or text). */
	async function analyzeOne(
		source: string,
		args: Static<typeof AnalyzeMediaParams>,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		{
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
			// The byte BUDGET an image must fit into (downscaled if larger).
			const imageBudget = clampBytes(args.maxBytes, true);
			const maxBytes = clampBytes(args.maxBytes, looksImage);
			// For an image we want the WHOLE file (up to the absolute ceiling) so it
			// can be DOWNSCALED to a valid image — truncating it mid-stream corrupts
			// the only copy. So read images at the ceiling and let the image handler
			// resize to `imageBudget`. Non-image sources keep the existing cap
			// (a byte prefix is fine for text/doc bytes).
			const readCap = looksImage ? MAX_BYTES_CEILING : maxBytes;

			// Acquire bytes (with the right guard for the source type).
			let acquired: AcquiredBytes;
			try {
				acquired = isUrl
					? await acquireUrl(source, {
							maxBytes: readCap,
							...(signal ? { signal } : {}),
						})
					: await acquireLocal(source, {
							...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
							...(opts.cwd ? { cwd: opts.cwd } : {}),
							...(opts.ownerLocalAccess ? { ownerLocalAccess: true } : {}),
							maxBytes: readCap,
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
				// Last-resort: an unknown extension/MIME whose bytes decode as UTF-8
				// text is handled as the `text` kind (structured text / source code /
				// logs), so a `.toml`/unknown-but-textual file is read rather than
				// rejected. Binary that is not a known kind stays unsupported.
				if (looksLikeUtf8Text(acquired.bytes)) {
					return handleTextPlain({
						source,
						sourceType,
						bytes: acquired.bytes,
						truncated: acquired.truncated,
						...(acquired.mime ? { mime: acquired.mime } : {}),
						question,
					});
				}
				return failure({
					source,
					sourceType,
					...(acquired.mime ? { mimeType: acquired.mime } : {}),
					bytes: acquired.bytes.length,
					message:
						"Unsupported or undetectable media type. Supported: image (png/jpg/jpeg/webp/gif/bmp/heic), pdf, docx, pptx, xlsx, html, text (txt/csv/json/xml/md/yaml/log/source), audio, video. " +
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
						imageBudget,
						modelContext: opts.modelContext,
						...(args.provider ? { provider: args.provider } : {}),
						...(args.model ? { model: args.model } : {}),
						...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
						...(signal ? { signal } : {}),
					});
				case "video":
					return handleVideo({
						source,
						sourceType,
						bytes: acquired.bytes,
						mime: acquired.mime,
						question,
						...(args.provider ? { provider: args.provider } : {}),
						...(args.model ? { model: args.model } : {}),
						...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
						...(signal ? { signal } : {}),
					});
				case "audio":
					return handleAudio({
						source,
						sourceType,
						bytes: acquired.bytes,
						mime: acquired.mime,
						question,
						...(args.language ? { language: args.language } : {}),
						...(args.provider ? { provider: args.provider } : {}),
						...(args.model ? { model: args.model } : {}),
						...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
						...(signal ? { signal } : {}),
					});
				case "pdf":
					return handlePdf({
						source,
						sourceType,
						bytes: acquired.bytes,
						truncated: acquired.truncated,
						mime: acquired.mime,
						question,
						pages: args.pages,
						mode: args.mode ?? "auto",
						...(args.provider ? { provider: args.provider } : {}),
						...(args.model ? { model: args.model } : {}),
						...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
						...(signal ? { signal } : {}),
					});
				case "text":
					return handleTextPlain({
						source,
						sourceType,
						bytes: acquired.bytes,
						truncated: acquired.truncated,
						...(acquired.mime ? { mime: acquired.mime } : {}),
						question,
					});
				case "docx":
				case "pptx":
				case "xlsx":
				case "html":
				case "odt":
				case "ods":
				case "odp":
				case "epub":
				case "rtf":
				case "ipynb":
					return handleTextExtract({
						kind,
						source,
						sourceType,
						bytes: acquired.bytes,
						truncated: acquired.truncated,
						mime: acquired.mime,
						question,
						pages: args.pages,
						// Embedded-image surfacing (OOXML only). DEFAULT-ON: when the
						// caller didn't say otherwise, an Office doc on a vision model
						// also returns its embedded pictures. `includeImages:false`
						// opts out (text-only, cheap).
						includeImages: args.includeImages !== false,
						modelContext: opts.modelContext,
						imageBudget,
						...(args.provider ? { provider: args.provider } : {}),
						...(args.model ? { model: args.model } : {}),
						...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
						...(signal ? { signal } : {}),
					});
			}
		}
	}

	/* ── batch (multi-source) pipeline ── */

	/**
	 * Analyze MULTIPLE sources in one call. Images are pushed as N image blocks
	 * into a single tool result (Pi tool-result content is an array of blocks);
	 * non-image sources are reduced to their TEXT and concatenated under per-file
	 * labels. Caps: {@link MAX_BATCH_IMAGES} images / {@link MAX_BATCH_DOCS}
	 * non-image sources. The image byte budget is applied PER image (so N images
	 * each get the per-image budget; downscaling keeps each one valid + bounded).
	 * A per-source failure is reported inline (labeled) and never aborts the batch.
	 */
	async function analyzeBatch(
		sources: string[],
		args: Static<typeof AnalyzeMediaParams>,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		const question = (args.question ?? args.prompt ?? "").trim();
		// Partition by the cheap up-front signal (explicit kind / extension / —).
		// MIME-only images in a batch are treated as docs/text here (we don't pre-
		// fetch to classify); that's an acceptable edge for the batch path.
		const imageSources: string[] = [];
		const otherSources: string[] = [];
		for (const s of sources) {
			const k = args.kind ?? EXT_KIND[extensionOf(s)];
			if (k === "image") imageSources.push(s);
			else otherSources.push(s);
		}
		const cappedImages = imageSources.slice(0, MAX_BATCH_IMAGES);
		const cappedOthers = otherSources.slice(0, MAX_BATCH_DOCS);
		const overflow: string[] = [];
		if (imageSources.length > MAX_BATCH_IMAGES)
			overflow.push(`${imageSources.length - MAX_BATCH_IMAGES} image(s)`);
		if (otherSources.length > MAX_BATCH_DOCS)
			overflow.push(`${otherSources.length - MAX_BATCH_DOCS} document(s)`);

		const content: AgentToolResult<AnalyzeMediaDetails>["content"] = [];
		const labelParts: string[] = [];
		let anyOk = false;
		let imageCount = 0;
		let textCount = 0;

		const lead = question
			? `Analyze the ${sources.length} attached sources and answer this:\n${question}`
			: `Analyze the ${sources.length} attached sources and describe / summarize what they contain.`;
		content.push({ type: "text", text: lead });

		// Images first → each becomes its own labeled text + image block.
		for (let i = 0; i < cappedImages.length; i++) {
			const src = cappedImages[i] as string;
			const label = `--- Image ${i + 1}: ${basenameOf(src)} ---`;
			const one = await analyzeOne(src, args, signal);
			const img = one.content.find((b) => b.type === "image") as
				| { type: "image"; data: string; mimeType: string }
				| undefined;
			if (img) {
				content.push({ type: "text", text: label });
				content.push(img);
				imageCount += 1;
				anyOk = anyOk || one.details.ok;
			} else {
				// Text-only model / no key / failure → carry the explanatory text.
				content.push({ type: "text", text: `${label}\n${firstText(one)}` });
			}
		}

		// Non-image sources → concatenated labeled text extractions.
		for (let i = 0; i < cappedOthers.length; i++) {
			const src = cappedOthers[i] as string;
			const label = `--- File ${i + 1}: ${basenameOf(src)} ---`;
			const one = await analyzeOne(src, args, signal);
			content.push({ type: "text", text: `${label}\n${firstText(one)}` });
			textCount += 1;
			anyOk = anyOk || one.details.ok;
		}

		if (overflow.length > 0) {
			content.push({
				type: "text",
				text: `(Note: ${overflow.join(" and ")} beyond the per-call cap of ${MAX_BATCH_IMAGES} images / ${MAX_BATCH_DOCS} documents were skipped. Split into multiple calls.)`,
			});
		}
		void labelParts;
		return {
			content,
			details: {
				ok: anyOk,
				source: sources.join(", "),
				sourceType: sources.every((s) => /^https?:\/\//i.test(s)) ? "url" : "path",
				returned: imageCount > 0 ? "image" : textCount > 0 ? "text" : "none",
				bytes: 0,
				message: `Batch of ${sources.length} sources: ${imageCount} image block(s), ${textCount} text extraction(s).`,
			},
		};
	}

	/* ── media-understanding helpers (shared by image/video/pdf provider paths) ── */

	/**
	 * Run the media-understanding subsystem for `kind` and shape its TEXT into a
	 * tool result. Returns `undefined` when no provider/key is available (so the
	 * caller can fall back), and surfaces provider HTTP failures as a clean
	 * failure result (never a raw throw to the model).
	 */
	async function understandViaProvider(p: {
		kind: MediaUnderstandingKind;
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		mimeType: string;
		question: string;
		/** Max output tokens for the provider answer (clamped by the adapter). */
		maxTokens?: number;
		provider?: "google" | "anthropic";
		model?: string;
		signal?: AbortSignal;
		/** Extra leading note prepended to the returned text (e.g. why provider was used). */
		note?: string;
		/**
		 * Extra actionable guidance appended to a provider HTTP-FAILURE message
		 * (NOT the unavailable/no-key case). Lets a caller turn a bare transport
		 * error into a "do this next" hint specific to the modality + situation.
		 */
		failureGuidance?: string;
	}): Promise<
		| { ok: true; result: AgentToolResult<AnalyzeMediaDetails> }
		| { ok: false; unavailable: true; message: string }
		| { ok: false; unavailable: false; result: AgentToolResult<AnalyzeMediaDetails> }
	> {
		const cfg = getMuConfig();
		// Shape a successful provider TEXT into the tool result. Shared by the
		// cache-HIT and fresh-call paths so they return identically.
		const buildOk = (
			text: string,
			resolvedProvider: string,
			resolvedModel: string,
			fromCache: boolean,
		): { ok: true; result: AgentToolResult<AnalyzeMediaDetails> } => {
			const promptText = buildPromptText(p.question, p.kind);
			// The provider's answer is derived from operator-pointed media but can
			// still echo injected instructions (a hostile document/video caption),
			// so wrap it in the untrusted-content envelope like extracted text.
			const wrapped = wrapWebContent(text, "web_fetch", { includeWarning: true });
			const notes = [p.note, fromCache ? "cached result" : undefined].filter(Boolean);
			const lead = notes.length > 0 ? `${promptText}\n\n(${notes.join("; ")})` : promptText;
			return {
				ok: true,
				result: {
					content: [{ type: "text", text: `${lead}\n\n${wrapped}` }],
					details: {
						ok: true,
						source: p.source,
						sourceType: p.sourceType,
						kind: p.kind as MediaKind,
						mimeType: p.mimeType,
						bytes: p.bytes.length,
						returned: "text",
						provider: resolvedProvider,
						providerModel: resolvedModel,
					},
				},
			};
		};

		// Cache key = content hash + the identity that determines the answer. Use
		// the REQUEST identity (override provider/model/maxTokens) so a repeat of
		// the same request hits; the RESOLVED provider/model live in the value.
		const cacheKey =
			cacheEnabled
				? mediaCacheKey({
						bytes: p.bytes,
						question: p.question,
						provider: p.provider ?? "auto",
						kind: p.kind,
						...(p.model ? { model: p.model } : {}),
						...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
					})
				: "";
		if (cacheEnabled) {
			const hit = await readCache(cacheKey).catch(() => undefined);
			if (hit) return buildOk(hit.text, hit.provider, hit.model, true);
		}

		try {
			const res = await runUnderstanding({
				kind: p.kind,
				bytes: p.bytes,
				mimeType: p.mimeType,
				cfg,
				...(p.question ? { prompt: p.question } : {}),
				...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
				...(p.provider ? { provider: p.provider } : {}),
				...(p.model ? { model: p.model } : {}),
				...(p.signal ? { signal: p.signal } : {}),
			});
			// Persist for next time (best-effort; never blocks the result).
			if (cacheEnabled) {
				const value: MediaCacheValue = { text: res.text, provider: res.provider, model: res.model };
				void writeCache(cacheKey, value).catch(() => {});
			}
			return buildOk(res.text, res.provider, res.model, false);
		} catch (err) {
			if (err instanceof MediaUnderstandingUnavailableError) {
				return { ok: false, unavailable: true, message: err.message };
			}
			// Provider HTTP / processing failure — clean failure result.
			const msg = err instanceof Error ? err.message : String(err);
			const guidance = p.failureGuidance ? ` ${p.failureGuidance}` : "";
			return {
				ok: false,
				unavailable: false,
				result: failure({
					source: p.source,
					sourceType: p.sourceType,
					kind: p.kind as MediaKind,
					mimeType: p.mimeType,
					bytes: p.bytes.length,
					message: `Provider media-understanding call failed: ${msg}.${guidance}`,
				}),
			};
		}
	}

	/* ── handlers (closures so they share `opts`) ── */

	async function handleImage(p: {
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		truncated: boolean;
		mime?: string;
		question: string;
		/** Byte budget the image block must fit into (downscaled if larger). */
		imageBudget: number;
		modelContext?: AnalyzeMediaModelContext;
		provider?: "google" | "anthropic";
		model?: string;
		maxTokens?: number;
		signal?: AbortSignal;
	}): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		const ext = extensionOf(p.source);
		let mimeType = (p.mime?.split(";")[0]?.trim() || imageMimeFromExt(ext)).toLowerCase();
		const isHeic = /heic|heif/.test(mimeType) || ext === "heic" || ext === "heif";
		const sees = modelLikelySeesImages(p.modelContext);

		const promptText = buildPromptText(p.question, "image");
		const warnings: string[] = [];

		// DOWNSCALE (not truncate) an oversize image. Truncating an image
		// mid-stream produces a broken payload every vision model rejects; instead
		// we resize it (fit-inside, down a quality grid) + EXIF auto-rotate, so the
		// model still sees a VALID image under the budget. HEIC/SVG aren't decodable
		// without a native dep, so they skip this (pass-through + the HEIC warning).
		let bytes = p.bytes;
		let imageTruncated = p.truncated;
		if (!isHeic && isDownscalableImageMime(mimeType)) {
			const overBudget = bytes.length > p.imageBudget;
			// Only pay the decode/encode when the image is actually over budget (or
			// arrived truncated and must be re-validated). A small image is shipped
			// untouched (lossless).
			if (overBudget || imageTruncated) {
				try {
					const ds: DownscaleResult = await downscaleImage(bytes, {
						maxBytes: p.imageBudget,
						sourceMime: mimeType,
					});
					bytes = ds.bytes;
					mimeType = ds.mimeType;
					// A successful downscale yields a valid image → clear the truncation
					// flag (we no longer ship a corrupt prefix).
					imageTruncated = false;
					if (ds.resized) {
						warnings.push(
							`The image exceeded the byte budget, so it was downscaled to ${ds.width}×${ds.height} (re-encoded as JPEG) to fit — detail may be reduced. Raise \`maxBytes\` for a higher-resolution pass.`,
						);
					}
				} catch {
					// Could not decode (corrupt / unsupported encoding). Keep the
					// original bytes; the truncation warning below still applies.
				}
			}
		}

		if (isHeic) {
			warnings.push(
				"This is a HEIC/HEIF image. Brigade cannot transcode it without a native dependency, so it is passed through as-is — many models reject HEIC. If the model cannot read it, ask the operator to convert it to JPEG/PNG.",
			);
		}
		if (sees === false) {
			// The current model is text-only. Rather than ship a block it will
			// reject, route the image through a provider that CAN see it (when a
			// key is configured) and return the resulting text — so vision works
			// on any model. With no key, fall back to the honest "switch model"
			// message.
			//
			// FIX: a provider-bound image whose MIME the providers DON'T accept
			// (image/bmp, image/tiff — even when small + under budget, so the
			// downscale step above didn't fire) would make Anthropic return a 400.
			// Re-encode it to JPEG first (the downscale grid always emits JPEG and
			// jimp decodes bmp/tiff). HEIC/SVG aren't decodable → left as-is (the
			// HEIC warning already covers them).
			if (!isHeic && !PROVIDER_SAFE_IMAGE_MIME.has(mimeType) && isDownscalableImageMime(mimeType)) {
				try {
					const ds: DownscaleResult = await downscaleImage(bytes, {
						maxBytes: p.imageBudget,
						sourceMime: mimeType,
					});
					bytes = ds.bytes;
					mimeType = ds.mimeType; // image/jpeg
					imageTruncated = false;
				} catch {
					// Undecodable — fall through with the original bytes/mime; the
					// provider may still sniff it, and a 400 surfaces as a clean failure.
				}
			}
			const viaProvider = await understandViaProvider({
				kind: "image",
				source: p.source,
				sourceType: p.sourceType,
				bytes,
				mimeType,
				question: p.question,
				...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
				...(p.provider ? { provider: p.provider } : {}),
				...(p.model ? { model: p.model } : {}),
				...(p.signal ? { signal: p.signal } : {}),
				note: "The current model is text-only, so the image was understood by a vision-capable provider and the description is below.",
				// BUG-1: when the current model is text-only AND a provider key exists
				// BUT the provider HTTP call fails, a bare transport error leaves the
				// model with no next step. Tell it exactly what unblocks the image.
				failureGuidance:
					"To read this image, the turn needs either a vision-capable model (e.g. a Claude / GPT-4o / Gemini model) or a working media-understanding provider key — check the configured key/quota and retry, or switch models.",
			});
			if (viaProvider.ok) return viaProvider.result;
			if (!viaProvider.unavailable) return viaProvider.result; // provider HTTP failure
			// Unavailable (no key) — be honest.
			warnings.push(
				"The current model does not appear to accept images, so the image is NOT being attached. Switch to a vision-capable model (e.g. a Claude / GPT-4o / Gemini model), or configure a Google/Anthropic key so Brigade can understand images on any model.",
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
		if (imageTruncated) {
			// Reached only when the image could NOT be downscaled (undecodable) yet
			// arrived truncated — the block may be corrupt.
			warnings.push(
				"The image was truncated at the byte cap and could not be re-encoded, so it may be corrupt — raise `maxBytes` if it does not render.",
			);
		}
		const text = warnings.length > 0 ? `${promptText}\n\n${warnings.join("\n\n")}` : promptText;
		return {
			// Image block carries raw base64 (NO data: prefix) — Pi's ImageContent
			// shape. This is the SAME block inbound/history images use, so a
			// vision model sees it as part of the turn.
			content: [
				{ type: "text", text },
				{ type: "image", data: bytes.toString("base64"), mimeType },
			],
			details: {
				ok: true,
				source: p.source,
				sourceType: p.sourceType,
				kind: "image",
				mimeType,
				bytes: bytes.length,
				returned: "image",
				...(imageTruncated ? { truncated: true } : {}),
				...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
			},
		};
	}

	async function handleVideo(p: {
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		mime?: string;
		question: string;
		provider?: "google" | "anthropic";
		model?: string;
		maxTokens?: number;
		signal?: AbortSignal;
	}): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		// Pi's content channel can't carry video, so we call a video-capable
		// provider DIRECTLY (Gemini via the Files API) and return its TEXT.
		const mimeType = p.mime?.split(";")[0]?.trim().toLowerCase() || videoMimeFromExt(extensionOf(p.source));
		// Minor (4a): an explicit `provider:"anthropic"` override can't do video —
		// Anthropic has no video ingestion. Say so crisply instead of letting the
		// generic "needs a Gemini key" / capable-check message stand in for it.
		if (p.provider === "anthropic") {
			const promptText = buildPromptText(p.question, "video");
			const message =
				"Anthropic cannot analyze video — it has no video ingestion. Video understanding needs a Google/Gemini key. " +
				"Drop the `provider` override (or set it to \"google\") and configure a Gemini key.";
			return {
				content: [{ type: "text", text: `${promptText}\n\n${message}` }],
				details: {
					ok: false,
					source: p.source,
					sourceType: p.sourceType,
					kind: "video",
					mimeType,
					bytes: p.bytes.length,
					returned: "none",
					message,
				},
			};
		}
		const viaProvider = await understandViaProvider({
			kind: "video",
			source: p.source,
			sourceType: p.sourceType,
			bytes: p.bytes,
			mimeType,
			question: p.question,
			...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
			...(p.provider ? { provider: p.provider } : {}),
			...(p.model ? { model: p.model } : {}),
			...(p.signal ? { signal: p.signal } : {}),
		});
		if (viaProvider.ok) return viaProvider.result;
		if (!viaProvider.unavailable) return viaProvider.result; // provider HTTP failure
		// No key configured — clear, actionable message.
		const promptText = buildPromptText(p.question, "video");
		return {
			content: [{ type: "text", text: `${promptText}\n\n${viaProvider.message}` }],
			details: {
				ok: false,
				source: p.source,
				sourceType: p.sourceType,
				kind: "video",
				mimeType,
				bytes: p.bytes.length,
				returned: "none",
				message: viaProvider.message,
			},
		};
	}

	/**
	 * Audio handler (voice notes + clips). Pi's content channel can't carry
	 * audio (text + image only), so audio understanding is GEMINI-ONLY: we route
	 * to the media-understanding subsystem (Gemini inline audio) and return its
	 * TEXT transcription / summary. With no Google/Gemini key, a clear "configure
	 * a Gemini key" message — never a provider 400 from packing audio into an
	 * image block.
	 */
	async function handleAudio(p: {
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		mime?: string;
		question: string;
		/** Spoken-language hint (e.g. "es", "Spanish") folded into the provider prompt. */
		language?: string;
		provider?: "google" | "anthropic";
		model?: string;
		maxTokens?: number;
		signal?: AbortSignal;
	}): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		const mimeType =
			p.mime?.split(";")[0]?.trim().toLowerCase() || audioMimeFromExt(extensionOf(p.source));
		// Fold the language hint (and the question/context) into the provider
		// prompt — the Gemini generateContent API has no dedicated language field,
		// so the spoken-language hint rides in the instruction text.
		const audioPrompt = buildAudioPrompt(p.question, p.language);
		const viaProvider = await understandViaProvider({
			kind: "audio",
			source: p.source,
			sourceType: p.sourceType,
			bytes: p.bytes,
			mimeType,
			question: audioPrompt,
			...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
			...(p.provider ? { provider: p.provider } : {}),
			...(p.model ? { model: p.model } : {}),
			...(p.signal ? { signal: p.signal } : {}),
		});
		if (viaProvider.ok) return viaProvider.result;
		if (!viaProvider.unavailable) return viaProvider.result; // provider HTTP failure
		// No capable key — clear, actionable message.
		const promptText = buildPromptText(p.question, "audio");
		return {
			content: [{ type: "text", text: `${promptText}\n\n${viaProvider.message}` }],
			details: {
				ok: false,
				source: p.source,
				sourceType: p.sourceType,
				kind: "audio",
				mimeType,
				bytes: p.bytes.length,
				returned: "none",
				message: viaProvider.message,
			},
		};
	}

	/**
	 * PDF handler. With an understanding-provider key configured (and `mode` not
	 * forced to "text"), the PDF is sent NATIVELY to the provider (Anthropic
	 * document block — OCRs scanned pages + reads layout; or Gemini inline) and
	 * the provider's TEXT answer is returned. Otherwise — or when `mode:"text"`,
	 * or when the provider call comes back empty/unavailable — it falls back to
	 * the local `unpdf` per-page text extraction (honoring `pages`).
	 */
	async function handlePdf(p: {
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		truncated: boolean;
		mime?: string;
		question: string;
		pages?: string;
		mode: "auto" | "provider" | "text";
		provider?: "google" | "anthropic";
		model?: string;
		maxTokens?: number;
		signal?: AbortSignal;
	}): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		// Local text extraction is the fallback (and the forced path for mode:"text").
		const extractLocally = () =>
			handleTextExtract({
				kind: "pdf",
				source: p.source,
				sourceType: p.sourceType,
				bytes: p.bytes,
				truncated: p.truncated,
				...(p.mime ? { mime: p.mime } : {}),
				question: p.question,
				...(p.pages ? { pages: p.pages } : {}),
			});

		if (p.mode === "text") return extractLocally();

		const cfg = getMuConfig();
		// Does any capable provider have a key? (Pure read — no HTTP.)
		const providerAvailable = p.provider
			? Boolean(safeResolveKey(cfg, p.provider))
			: Boolean(safeResolveKey(cfg, "anthropic")) || Boolean(safeResolveKey(cfg, "google"));

		if (p.mode === "provider" || providerAvailable) {
			const viaProvider = await understandViaProvider({
				kind: "pdf",
				source: p.source,
				sourceType: p.sourceType,
				bytes: p.bytes,
				mimeType: "application/pdf",
				question: p.question,
				...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
				...(p.provider ? { provider: p.provider } : {}),
				...(p.model ? { model: p.model } : {}),
				...(p.signal ? { signal: p.signal } : {}),
				note:
					"This PDF was read natively by a provider (handles scanned pages + layout)." +
					(p.pages ? " The `pages` range is not applied on the native path." : ""),
			});
			if (viaProvider.ok) return viaProvider.result;
			// mode:"provider" forces provider — surface the failure/unavailable
			// rather than silently extracting (the operator asked for native).
			if (p.mode === "provider") {
				if (viaProvider.unavailable) {
					return failure({
						source: p.source,
						sourceType: p.sourceType,
						kind: "pdf",
						...(p.mime ? { mimeType: p.mime } : {}),
						bytes: p.bytes.length,
						message: viaProvider.message,
					});
				}
				return viaProvider.result;
			}
			// auto + provider HTTP failure → fall back to local text extraction.
		}
		return extractLocally();
	}

	/**
	 * Plain / structured-text handler (txt / csv / tsv / json / xml / yaml / log /
	 * markdown / source code / unknown-but-UTF-8). Decodes the bytes as UTF-8,
	 * wraps them in the untrusted-content envelope (the file is operator-pointed
	 * but can still carry injected instructions), and returns them as text capped
	 * to the char budget. No provider call — this is a pure read, the cheapest
	 * path. Both rival tools accept these formats; Brigade used to reject them.
	 */
	async function handleTextPlain(p: {
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		truncated: boolean;
		mime?: string;
		question: string;
	}): Promise<AgentToolResult<AnalyzeMediaDetails>> {
		// Strip a UTF-8 BOM if present, then decode. `Buffer.toString("utf8")`
		// replaces invalid sequences with U+FFFD rather than throwing, so even
		// near-text binary degrades gracefully instead of erroring.
		let raw = p.bytes.toString("utf8");
		if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
		const rawText = raw.trim();
		if (!rawText) {
			return failure({
				source: p.source,
				sourceType: p.sourceType,
				kind: "text",
				...(p.mime ? { mimeType: p.mime } : {}),
				bytes: p.bytes.length,
				message: "The file is empty or contains no readable text.",
			});
		}
		const { text: clamped, truncated: textTruncated } = truncateText(raw, DEFAULT_MAX_CHARS);
		const wrapped = wrapWebContent(clamped, "web_fetch", { includeWarning: true });
		const promptText = buildPromptText(p.question, "text");
		const truncated = p.truncated || textTruncated;
		const note = truncated
			? "\n\n(Content was truncated to fit the turn — raise `maxBytes` for more.)"
			: "";
		return {
			content: [{ type: "text", text: `${promptText}${note}\n\n${wrapped}` }],
			details: {
				ok: true,
				source: p.source,
				sourceType: p.sourceType,
				kind: "text",
				...(p.mime ? { mimeType: p.mime } : {}),
				bytes: p.bytes.length,
				returned: "text",
				...(truncated ? { truncated: true } : {}),
			},
		};
	}

	async function handleTextExtract(p: {
		kind:
			| "pdf"
			| "docx"
			| "pptx"
			| "xlsx"
			| "html"
			| "odt"
			| "ods"
			| "odp"
			| "epub"
			| "rtf"
			| "ipynb";
		source: string;
		sourceType: "url" | "path";
		bytes: Buffer;
		truncated: boolean;
		mime?: string;
		question: string;
		pages?: string;
		/**
		 * Surface the doc's EMBEDDED images (OOXML only) alongside the text.
		 * DEFAULT-ON from the dispatcher; ignored for non-OOXML kinds (pdf/html/
		 * odf/epub/rtf/ipynb have no `<prefix>/media/*` raster store we map).
		 */
		includeImages?: boolean;
		/** Turn-model context — drives whether embedded images go as blocks or via a provider. */
		modelContext?: AnalyzeMediaModelContext;
		/** Per-embedded-image byte budget (downscaled to fit). Reuses the image budget. */
		imageBudget?: number;
		provider?: "google" | "anthropic";
		model?: string;
		maxTokens?: number;
		signal?: AbortSignal;
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
				case "odt":
				case "ods":
				case "odp":
					rawText = await extractOpenDocument(p.bytes, p.kind);
					break;
				case "epub":
					rawText = await extractEpub(p.bytes);
					break;
				case "rtf":
					rawText = extractRtf(p.bytes);
					break;
				case "ipynb":
					rawText = extractIpynb(p.bytes);
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

		// ── Embedded images (OOXML only) ──────────────────────────────────────
		// For a pptx/docx/xlsx, the substance is often in the PICTURES (wireframes,
		// screenshots, charts). DEFAULT-ON: also surface the embedded images so the
		// model SEES them — on a vision model as image blocks alongside the text; on
		// a text-only model, routed through the understanding provider (or, with no
		// key, a short note). The agent never needs bash. Honors `pages` (PPTX slide
		// scope), the count cap + total-byte budget, and skips undecodable embeds.
		const isOoxml = p.kind === "docx" || p.kind === "pptx" || p.kind === "xlsx";
		const embedResult =
			isOoxml && p.includeImages
				? await attachEmbeddedImages({
						kind: p.kind as "docx" | "pptx" | "xlsx",
						bytes: p.bytes,
						pages: p.pages,
						imageBudget: p.imageBudget ?? DEFAULT_IMAGE_MAX_BYTES,
						...(p.modelContext ? { modelContext: p.modelContext } : {}),
						question: p.question,
						source: p.source,
						sourceType: p.sourceType,
						...(p.provider ? { provider: p.provider } : {}),
						...(p.model ? { model: p.model } : {}),
						...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
						...(p.signal ? { signal: p.signal } : {}),
					})
				: undefined;

		const content: AgentToolResult<AnalyzeMediaDetails>["content"] = [
			{ type: "text", text: `${promptText}${noteBlock}\n\n${wrapped}` },
		];
		if (embedResult) content.push(...embedResult.content);

		return {
			content,
			details: {
				ok: true,
				source: p.source,
				sourceType: p.sourceType,
				kind: p.kind,
				...(p.mime ? { mimeType: p.mime } : {}),
				bytes: p.bytes.length,
				returned: embedResult && embedResult.imageCount > 0 ? "image" : "text",
				...(p.pages ? { pages: p.pages } : {}),
				...(truncated ? { truncated: true } : {}),
			},
		};
	}

	/**
	 * Surface a doc's EMBEDDED images. Unzips the OOXML buffer, maps images to
	 * slides (PPTX) / collects them (DOCX/XLSX) via `extractOoxmlImages`, honoring
	 * `pages` over the PPTX slide order and the per-call count cap. Each selected
	 * image is DOWNSCALED to the per-image budget (small is fine — these are
	 * context), and a running TOTAL-byte budget drops any image that would blow the
	 * turn (reported, not thrown). Then:
	 *   • vision model  → emits the image blocks (each preceded by a label).
	 *   • text-only     → routes EACH embed through the understanding provider and
	 *     emits the resulting TEXT; with NO provider key, a single "images present,
	 *     switch to a vision model" note (NEVER a raw block, NEVER a throw).
	 * Undecodable embeds (`.wdp`/`.emf`/`.wmf`/…) and over-cap images are reported
	 * as short notes. Returns the extra content blocks + how many image blocks were
	 * emitted (so the caller can set `returned`). On ANY failure (corrupt zip,
	 * decode error) it returns `undefined` — the text result already stands; the
	 * embedded images are a best-effort add-on that must never break the text path.
	 */
	async function attachEmbeddedImages(e: {
		kind: "docx" | "pptx" | "xlsx";
		bytes: Buffer;
		pages?: string;
		imageBudget: number;
		modelContext?: AnalyzeMediaModelContext;
		question: string;
		source: string;
		sourceType: "url" | "path";
		provider?: "google" | "anthropic";
		model?: string;
		maxTokens?: number;
		signal?: AbortSignal;
	}): Promise<{ content: AgentToolResult<AnalyzeMediaDetails>["content"]; imageCount: number } | undefined> {
		let entries: Record<string, Uint8Array>;
		try {
			entries = await unzipEntries(e.bytes);
		} catch {
			// Corrupt/locked zip — the text path already reported the real failure
			// (or succeeded); embedded images are best-effort, so just skip them.
			return undefined;
		}

		// For PPTX, scope the embedded images by the same `pages` slide range the
		// text honored. DOCX/XLSX have no page→image map, so `inRange` is omitted
		// (all images, capped). The slide TOTAL drives the range clamp; resolve it
		// from the presentation order when available, else the slide-file count.
		let inRange: ((slideNum: number) => boolean) | undefined;
		if (e.kind === "pptx" && e.pages) {
			const slideTotal = countPptxSlides(entries);
			inRange = parsePageRange(e.pages, slideTotal);
		}

		let extraction: ReturnType<typeof extractOoxmlImages>;
		try {
			extraction = extractOoxmlImages(entries, e.kind, {
				cap: MAX_EMBEDDED_IMAGES,
				...(inRange ? { inRange } : {}),
			});
		} catch {
			return undefined;
		}
		if (extraction.images.length === 0 && extraction.skipped === 0) return undefined;

		const content: AgentToolResult<AnalyzeMediaDetails>["content"] = [];
		const sees = modelLikelySeesImages(e.modelContext);

		// Downscale each selected image to the per-image budget AND enforce the
		// running total-byte ceiling so a deck full of big pictures can't blow the
		// turn even under the count cap. Images dropped by the total budget are
		// reported (like the over-cap ones).
		const prepared: ExtractedOoxmlImage[] = [];
		let runningBytes = 0;
		let droppedForBytes = 0;
		for (const img of extraction.images) {
			let bytes = img.bytes;
			let mime = img.mime;
			if (isDownscalableImageMime(mime)) {
				try {
					const ds = await downscaleImage(bytes, {
						maxBytes: e.imageBudget,
						sourceMime: mime,
					});
					bytes = ds.bytes;
					mime = ds.mimeType;
				} catch {
					// Undecodable raster (rare for these types) — keep the original bytes;
					// a vision block may still render and a provider may still sniff it.
				}
			}
			if (runningBytes + bytes.length > EMBEDDED_IMAGES_TOTAL_BYTES && prepared.length > 0) {
				droppedForBytes += 1;
				continue;
			}
			runningBytes += bytes.length;
			prepared.push({ ...img, bytes, mime });
		}

		// Header note: count, "N of M", skipped, and dropped-for-budget.
		const emitted = prepared.length;
		const headerBits: string[] = [];
		if (emitted > 0) {
			headerBits.push(
				`${emitted} embedded image${emitted === 1 ? "" : "s"} from this ${e.kind}`,
			);
		}
		if (extraction.matched > emitted + droppedForBytes) {
			headerBits.push(
				`showing ${emitted} of ${extraction.matched} embedded images — pass \`pages=\` to scope` +
					(e.kind === "pptx" ? " to specific slides" : ""),
			);
		}
		if (droppedForBytes > 0) {
			headerBits.push(`${droppedForBytes} omitted to stay within the size budget`);
		}
		if (extraction.skipped > 0) {
			headerBits.push(`${extraction.skipped} skipped (unsupported format)`);
		}

		if (emitted === 0) {
			// Nothing decodable to show (e.g. every embed was a .wdp). Report the
			// skip as a note; do NOT throw.
			if (headerBits.length > 0) {
				content.push({ type: "text", text: `(Embedded images: ${headerBits.join("; ")}.)` });
			}
			return { content, imageCount: 0 };
		}

		if (sees === false) {
			// TEXT-ONLY current model. Don't ship raw blocks it will reject — route
			// each embed through the understanding provider and emit the TEXT. With
			// no key, a single honest note (the text extraction already stands).
			const cfg = getMuConfig();
			const providerAvailable = e.provider
				? Boolean(safeResolveKey(cfg, e.provider))
				: Boolean(safeResolveKey(cfg, "anthropic")) ||
					Boolean(safeResolveKey(cfg, "google")) ||
					Boolean(safeResolvePiImageModel(cfg));
			if (!providerAvailable) {
				content.push({
					type: "text",
					text:
						`(This ${e.kind} has ${headerBits.join("; ")}, but the current model is text-only so they are not attached. ` +
						"Switch to a vision-capable model to SEE them, or configure a Google/Anthropic key so Brigade can describe embedded images on any model.)",
				});
				return { content, imageCount: 0 };
			}
			content.push({
				type: "text",
				text:
					`(The current model is text-only, so the ${headerBits.join("; ")} were understood by a vision-capable provider; descriptions follow.)`,
			});
			for (const img of prepared) {
				// Re-encode a non-provider-safe raster (bmp/tiff) to JPEG so the
				// provider accepts it (Anthropic 400s on image/bmp).
				let bytes = img.bytes;
				let mime = img.mime;
				if (!PROVIDER_SAFE_IMAGE_MIME.has(mime) && isDownscalableImageMime(mime)) {
					try {
						const ds = await downscaleImage(bytes, { maxBytes: e.imageBudget, sourceMime: mime });
						bytes = ds.bytes;
						mime = ds.mimeType;
					} catch {
						/* leave as-is; a 400 surfaces as the note below */
					}
				}
				const viaProvider = await understandViaProvider({
					kind: "image",
					source: `${e.source}#${img.label.replace(/\s+/g, "-")}`,
					sourceType: e.sourceType,
					bytes,
					mimeType: mime,
					question: e.question,
					...(e.maxTokens !== undefined ? { maxTokens: e.maxTokens } : {}),
					...(e.provider ? { provider: e.provider } : {}),
					...(e.model ? { model: e.model } : {}),
					...(e.signal ? { signal: e.signal } : {}),
				});
				if (viaProvider.ok) {
					content.push({ type: "text", text: `--- ${img.label} ---\n${firstText(viaProvider.result)}` });
				} else {
					content.push({
						type: "text",
						text: `--- ${img.label} ---\n(Could not understand this embedded image: ${viaProvider.unavailable ? viaProvider.message : firstText(viaProvider.result)})`,
					});
				}
			}
			return { content, imageCount: 0 };
		}

		// VISION model (or unknown — assume yes, the common case). Emit each image
		// as a labeled block. `sees === undefined` adds one short uncertainty note.
		const lead =
			`(Embedded images from this ${e.kind}: ${headerBits.join("; ")}.` +
			(sees === undefined
				? " Note: Brigade could not confirm this model is vision-capable; if you cannot see them, switch models.)"
				: ")");
		content.push({ type: "text", text: lead });
		for (const img of prepared) {
			content.push({ type: "text", text: `--- ${img.label} ---` });
			content.push({ type: "image", data: img.bytes.toString("base64"), mimeType: img.mime });
		}
		return { content, imageCount: emitted };
	}
}

/* ─────────────────────────── small helpers ─────────────────────────── */

/** Resolve a provider key from the mu-config without throwing (pure probe). */
function safeResolveKey(
	cfg: MediaUnderstandingConfig,
	provider: "google" | "anthropic",
): string {
	try {
		return cfg.resolveKey(provider) || "";
	} catch {
		return "";
	}
}

/**
 * True when the Pi image path can resolve an image-capable model for SOME keyed
 * provider (OpenAI / Groq / Mistral / OpenRouter / xAI / Ollama / …) — so embedded
 * images from an OOXML doc can be understood on a text-only current model even
 * when neither google nor anthropic is keyed. Pure probe, never throws.
 */
function safeResolvePiImageModel(cfg: MediaUnderstandingConfig): boolean {
	try {
		return Boolean(resolvePiModel("image", cfg));
	} catch {
		return false;
	}
}

/**
 * Count slides in an already-unzipped PPTX for clamping a `pages` range over the
 * embedded-image path. Prefers the PRESENTATION order (so the count matches what
 * the text extractor + the image mapper see); falls back to the slide-file count
 * when the presentation graph is unreadable. Never throws.
 */
function countPptxSlides(entries: Record<string, Uint8Array>): number {
	try {
		const ordered = resolveSlideOrder(entries);
		if (ordered.length > 0) return ordered.length;
	} catch {
		/* fall through to the filename count */
	}
	return Object.keys(entries).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}

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
				: kind === "audio"
					? "the audio referenced below"
					: kind === "text"
						? "the text content below"
						: `the extracted ${kind} content below`;
	if (question) return `Analyze ${what} and answer this:\n${question}`;
	return `Analyze ${what} and describe / summarize what it contains.`;
}

/**
 * Build the provider prompt for an AUDIO call, folding in an optional spoken-
 * language hint and the caller's question/context. Gemini's generateContent has
 * no language field, so the hint is expressed in the instruction text. When the
 * caller gives no question, default to transcribe-then-summarize.
 */
export function buildAudioPrompt(question: string, language?: string): string {
	const lang = (language ?? "").trim();
	const langClause = lang
		? ` The spoken language is ${lang} — transcribe in ${lang} and preserve it.`
		: "";
	const base = question.trim()
		? question.trim()
		: "Transcribe this audio, then briefly summarize what is said.";
	return `${base}${langClause}`;
}

/**
 * Heuristic: do these bytes look like UTF-8 text (so an unknown extension/MIME
 * can be read as the `text` kind rather than rejected)? Rejects anything with a
 * NUL byte or a high ratio of C0 control bytes (binary), and validates that a
 * leading sample decodes as UTF-8 without replacement characters. Conservative
 * — a false negative just yields the old "unsupported" message.
 */
export function looksLikeUtf8Text(bytes: Buffer): boolean {
	if (bytes.length === 0) return false;
	const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
	let control = 0;
	for (const b of sample) {
		if (b === 0) return false; // NUL → binary
		// Allow tab(9), LF(10), CR(13), FF(12); count other C0 controls.
		if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12) control += 1;
	}
	if (control / sample.length > 0.05) return false;
	// Validate UTF-8: a strict decode shouldn't introduce replacement chars in a
	// sample that didn't already contain them.
	const decoded = sample.toString("utf8");
	const replacements = (decoded.match(/�/g) ?? []).length;
	if (replacements > 0 && replacements / decoded.length > 0.01) return false;
	return true;
}

function failure(d: Omit<AnalyzeMediaDetails, "ok" | "returned"> & { message: string }): AgentToolResult<AnalyzeMediaDetails> {
	return jsonResult({ ok: false, returned: "none", ...d }) as AgentToolResult<AnalyzeMediaDetails>;
}

/** Short display name for a source (file basename, or the URL pathname tail). */
function basenameOf(source: string): string {
	try {
		if (/^https?:\/\//i.test(source)) {
			const u = new URL(source);
			const last = u.pathname.split("/").filter(Boolean).pop();
			return last || u.hostname;
		}
	} catch {
		/* fall through to path basename */
	}
	const norm = source.replace(/[\\/]+$/, "");
	const tail = norm.split(/[\\/]/).pop();
	return tail || source;
}

/** Concatenate all TEXT blocks of a single-source result (for batch labeling). */
function firstText(r: AgentToolResult<AnalyzeMediaDetails>): string {
	return r.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

// Image byte cap is applied where the image handler runs; export the constant
// so callers/tests can reference the tighter image default.
export { DEFAULT_IMAGE_MAX_BYTES, DEFAULT_MAX_BYTES, DEFAULT_MAX_CHARS };
