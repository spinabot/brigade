/**
 * Shared helpers for the document AUTHORING tools (`make_document` +
 * `edit_document`) — the WRITE siblings of `analyze_media`'s read side.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE
 * ─────────────────────────────────────────────────────────────────────────
 * `make_document` (CREATE) and `edit_document` (EDIT) share three concerns:
 *
 *   1. PATH SCOPING. Both tools READ an output path (and, for edit, a source
 *      path) and WRITE bytes to disk. They reuse the EXACT same posture as
 *      `analyze_media`'s local-file acquisition: the media-path guard
 *      (`validateOutboundMediaPath`, refuses secrets / system files /
 *      credential dirs) PLUS an allowed-root scoping (workspace / cwd / OS
 *      cache / temp / state subtree). Writing OUTSIDE those roots is refused —
 *      a prompt-injected "save the doc to ~/.ssh/authorized_keys" can never
 *      land. The output dir is created on demand inside an allowed root.
 *
 *   2. IMAGE EMBEDDING. docx/pptx/pdf can embed an image from a local path or
 *      a URL. Images are acquired with the SAME guard (local) / SSRF guard
 *      (URL) as `analyze_media`, then normalized + resized to a sane embed
 *      budget via jimp (pure-JS, zero native deps — preserves Brigade's
 *      no-native-build streak). The libraries (`docx`/`pdf-lib`/`pptxgenjs`)
 *      only accept a known raster format, so HEIC/SVG/unknown are re-encoded
 *      to PNG/JPEG by jimp first.
 *
 *   3. CLEAN ERRORS. A malformed input must surface as a
 *      `BrigadeToolInputError` (the model sees `.message` + self-corrects),
 *      never a raw library throw.
 *
 * The output-path roots intentionally MATCH `analyze_media`'s read roots so a
 * file the agent just produced is immediately analyzable by the read tool, and
 * vice-versa.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { guardedFetch, SsrfBlockedError } from "../../infra/net/fetch-guard.js";
import { validateOutboundMediaPath } from "../../security/media-path-guard.js";
import {
	resolveCacheDir,
	resolveOsCacheDir,
	resolveStateDir,
} from "../../config/paths.js";
import { BrigadeToolInputError } from "./common.js";

/** Supported authoring formats — the four office/portable document kinds. */
export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf";

/** Canonical file extension for a format. */
export function extForFormat(format: DocFormat): string {
	return format; // docx/xlsx/pptx/pdf all match their extension
}

/** Lowercase extension (no dot) of a path. */
export function docExtensionOf(p: string): string {
	return path.extname(p).toLowerCase().replace(/^\./, "");
}

/** Map a file extension to a doc format (for edit-source detection). */
export function formatFromExtension(p: string): DocFormat | undefined {
	const ext = docExtensionOf(p);
	if (ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "pdf") return ext;
	return undefined;
}

/* ─────────────────────────── allowed-root scoping ─────────────────────────── */

/**
 * Roots a document path (input OR output) is allowed to live under. Mirrors
 * `analyze_media`'s `allowedLocalRoots` so the two tools agree on where files
 * may be read from and written to: workspace, process cwd, OS cache + temp,
 * and the Brigade state media subtree (channels / cache / captures / workspace
 * in both filesystem AND convex mode).
 */
export function allowedDocRoots(opts: { workspaceDir?: string; cwd?: string }): string[] {
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
	try {
		add(path.join(resolveStateDir(), "channels"));
		add(path.join(resolveStateDir(), "cache"));
		add(path.join(resolveStateDir(), "captures"));
		add(path.join(resolveStateDir(), "workspace"));
	} catch {
		/* ignore */
	}
	try {
		const osCache = resolveOsCacheDir();
		add(osCache);
		add(path.join(osCache, "channels"));
		add(path.join(osCache, "bluebubbles"));
	} catch {
		/* ignore */
	}
	return [...roots].filter((r) => r.length > 0);
}

/** True when `resolved` is inside one of `roots` (containment, no `..` escape). */
export function isInsideAnyRoot(resolved: string, roots: string[]): boolean {
	for (const root of roots) {
		const rel = path.relative(root, resolved);
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

/**
 * Resolve + validate an OUTPUT path for a document write.
 *
 *   1. media-path guard (refuse secrets / system files / credential dirs) —
 *      applied to the resolved absolute path so a benign basename can't smuggle
 *      a sensitive target.
 *   2. allowed-root scoping — the FILE must land inside workspace / cwd / cache
 *      / temp / state subtree. We check the realpath of the nearest existing
 *      ANCESTOR (the file itself doesn't exist yet on a create), so symlinked
 *      parent dirs can't redirect the write outside the roots.
 *
 * Returns the absolute path to write to (NOT yet created). Throws
 * `BrigadeToolInputError` when refused.
 */
export function resolveOutputPath(
	rawPath: string,
	opts: { workspaceDir?: string; cwd?: string },
): string {
	if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
		throw new BrigadeToolInputError("output path required");
	}
	const base = (opts.cwd && opts.cwd.trim()) || (opts.workspaceDir && opts.workspaceDir.trim()) || process.cwd();
	const abs = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(base, rawPath);

	// Secret / system-file denylist (resolves symlinks of an existing target).
	const verdict = validateOutboundMediaPath(abs);
	if (!verdict.ok) {
		throw new BrigadeToolInputError(verdict.reason ?? "refusing to write that path");
	}

	// Scope the realpath of the nearest existing ancestor so a symlinked parent
	// can't redirect the write outside the allowed roots.
	const roots = allowedDocRoots(opts);
	const anchor = nearestExistingAncestorReal(abs);
	if (!isInsideAnyRoot(anchor, roots)) {
		throw new BrigadeToolInputError(
			"refusing to write a path outside the allowed roots (workspace / current dir / cache / temp). " +
				"Write into the workspace (omit `outputPath` for an auto-named file there).",
		);
	}
	return abs;
}

/** Realpath of the deepest existing ancestor of `abs` (so non-existent leaves resolve safely). */
function nearestExistingAncestorReal(abs: string): string {
	let cur = abs;
	for (let i = 0; i < 64; i++) {
		try {
			return fs.realpathSync(cur);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return cur; // reached the root
			cur = parent;
		}
	}
	return cur;
}

/**
 * Resolve + validate a SOURCE path for an edit, then read its bytes. Same
 * posture as `analyze_media`'s `acquireLocalBytes`: media-path guard +
 * allowed-root scoping over the realpath of the file itself (which must exist).
 */
export async function acquireSourceBytes(
	rawPath: string,
	opts: { workspaceDir?: string; cwd?: string; maxBytes: number },
): Promise<Buffer> {
	if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
		throw new BrigadeToolInputError("source path required");
	}
	const verdict = validateOutboundMediaPath(rawPath);
	if (!verdict.ok) {
		throw new BrigadeToolInputError(verdict.reason ?? "refusing to read that path");
	}
	let resolved: string;
	try {
		resolved = fs.realpathSync(path.resolve(rawPath));
	} catch {
		resolved = path.resolve(rawPath);
	}
	const roots = allowedDocRoots(opts);
	if (!isInsideAnyRoot(resolved, roots)) {
		throw new BrigadeToolInputError(
			"refusing to read a source outside the allowed roots (workspace / current dir / cache / temp). " +
				"Move the file into the workspace first.",
		);
	}
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(resolved);
	} catch {
		throw new BrigadeToolInputError(`source file not found: ${rawPath}`);
	}
	if (!stat.isFile()) throw new BrigadeToolInputError(`not a file: ${rawPath}`);
	if (stat.size === 0) throw new BrigadeToolInputError(`source file is empty: ${rawPath}`);
	if (stat.size > opts.maxBytes) {
		throw new BrigadeToolInputError(
			`source file is too large (${stat.size} bytes > ${opts.maxBytes} cap).`,
		);
	}
	return fsp.readFile(resolved);
}

/** Create the parent dir for a resolved output path, then write the bytes. */
export async function writeDocFile(absPath: string, bytes: Buffer | Uint8Array): Promise<number> {
	await fsp.mkdir(path.dirname(absPath), { recursive: true });
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	await fsp.writeFile(absPath, buf);
	return buf.length;
}

/* ─────────────────────────── image acquisition + normalization ─────────────────────────── */

/** Default embed budget — images larger than this are downscaled before embedding. */
const DEFAULT_IMAGE_EMBED_BYTES = 4 * 1024 * 1024; // 4 MiB
/** Max pixel dimension for an embedded image (keeps file size + render time sane). */
const DEFAULT_IMAGE_EMBED_DIM = 2000;
/** Hard cap on bytes fetched for an image source (URL or local). */
const IMAGE_ACQUIRE_CEILING = 24 * 1024 * 1024; // 24 MiB
/** Per-request HTTP timeout for a URL image source. */
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

/** A normalized image ready to embed: raster bytes + the format the libs accept. */
export interface NormalizedImage {
	bytes: Buffer;
	/** "png" | "jpeg" — what `data` is encoded as (libraries key embeds off this). */
	format: "png" | "jpeg";
	mimeType: string;
	width: number;
	height: number;
}

/**
 * Acquire an image from a local path (guarded) or http(s) URL (SSRF-guarded),
 * decode it with jimp, fit-inside the embed dimension, and re-encode to a
 * library-friendly raster (PNG for sources with alpha, JPEG otherwise — but we
 * keep it simple and decode→PNG, falling back to JPEG when PNG would be larger
 * than the budget). Throws `BrigadeToolInputError` on any failure so the caller
 * never leaks a raw jimp/fetch throw to the model.
 *
 * `loadImage` is a test seam (defaults to the lazy jimp loader) so embedding can
 * be exercised without bundling a real codec.
 */
export async function acquireImageForEmbed(
	source: { path?: string; url?: string },
	opts: {
		workspaceDir?: string;
		cwd?: string;
		maxBytes?: number;
		maxDimension?: number;
		signal?: AbortSignal;
		loadImage?: ImageLoader;
	},
): Promise<NormalizedImage> {
	const ref = (source.url ?? source.path ?? "").trim();
	if (!ref) throw new BrigadeToolInputError("image requires a `path` or `url`");
	const isUrl = /^https?:\/\//i.test(ref) || Boolean(source.url);
	const maxBytes = clampImageBytes(opts.maxBytes);
	const maxDim = opts.maxDimension && opts.maxDimension > 0 ? opts.maxDimension : DEFAULT_IMAGE_EMBED_DIM;

	let raw: Buffer;
	if (isUrl) {
		raw = await fetchImageBytes(ref, { signal: opts.signal });
	} else {
		raw = await acquireSourceBytes(ref, {
			...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
			...(opts.cwd ? { cwd: opts.cwd } : {}),
			maxBytes: IMAGE_ACQUIRE_CEILING,
		});
	}

	const load = opts.loadImage ?? defaultImageLoader;
	let img: LoadedDocImage;
	try {
		img = await load(raw);
	} catch {
		throw new BrigadeToolInputError(
			"could not decode the image (unsupported or corrupt format). Use a PNG / JPEG / GIF / BMP source.",
		);
	}
	try {
		if (img.width() > maxDim || img.height() > maxDim) {
			img.scaleToFit(maxDim, maxDim);
		}
		// Encode PNG first (lossless, broadly accepted). If it blows the budget,
		// fall back to JPEG which compresses photos far better.
		let bytes = await img.encodePng();
		let format: "png" | "jpeg" = "png";
		let mimeType = "image/png";
		if (bytes.length > maxBytes) {
			const jpg = await img.encodeJpeg(80);
			if (jpg.length < bytes.length) {
				bytes = jpg;
				format = "jpeg";
				mimeType = "image/jpeg";
			}
		}
		return { bytes, format, mimeType, width: img.width(), height: img.height() };
	} catch {
		throw new BrigadeToolInputError("failed to process the image for embedding.");
	}
}

function clampImageBytes(requested: number | undefined): number {
	if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_IMAGE_EMBED_BYTES;
	return Math.max(64 * 1024, Math.min(IMAGE_ACQUIRE_CEILING, Math.floor(requested)));
}

/** Fetch an image URL through the SSRF guard with a size + timeout cap. */
async function fetchImageBytes(url: string, opts: { signal?: AbortSignal }): Promise<Buffer> {
	let response: Response;
	try {
		const r = await guardedFetch(url, {
			method: "GET",
			headers: {
				accept: "image/*,*/*",
				"user-agent": "Mozilla/5.0 (compatible; Brigade/1.0; +https://brigade.spinabot.com)",
			},
			timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
			...(opts.signal ? { signal: opts.signal } : {}),
		});
		response = r.response;
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			throw new BrigadeToolInputError(`refused to fetch the image URL: ${err.reason}`);
		}
		throw new BrigadeToolInputError(
			`could not fetch the image URL: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (response.status >= 400) {
		throw new BrigadeToolInputError(`image fetch failed: HTTP ${response.status} for ${url}`);
	}
	const ab = await response.arrayBuffer();
	const buf = Buffer.from(ab);
	if (buf.length === 0) throw new BrigadeToolInputError("image URL returned an empty body");
	if (buf.length > IMAGE_ACQUIRE_CEILING) {
		throw new BrigadeToolInputError("image URL body exceeds the acquisition ceiling");
	}
	return buf;
}

/** Minimal image handle the embedders drive — jimp in prod, a stub in tests. */
export interface LoadedDocImage {
	width(): number;
	height(): number;
	scaleToFit(w: number, h: number): void;
	encodePng(): Promise<Buffer>;
	encodeJpeg(quality: number): Promise<Buffer>;
}

export type ImageLoader = (bytes: Buffer) => Promise<LoadedDocImage>;

/** Default loader — lazily imports jimp (keeps the cost off the cold-start path). */
const defaultImageLoader: ImageLoader = async (bytes: Buffer): Promise<LoadedDocImage> => {
	const { Jimp, JimpMime } = await import("jimp");
	const img = await Jimp.read(bytes);
	return {
		width: () => img.bitmap.width,
		height: () => img.bitmap.height,
		scaleToFit: (w, h) => {
			img.scaleToFit({ w, h });
		},
		encodePng: async () => {
			const buf = await img.getBuffer(JimpMime.png);
			return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as unknown as ArrayBuffer);
		},
		encodeJpeg: async (quality) => {
			const buf = await img.getBuffer(JimpMime.jpeg, { quality });
			return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as unknown as ArrayBuffer);
		},
	};
};

/* ─────────────────────────── xlsx cell values ─────────────────────────── */

/** A formula cell as accepted by the document tools. */
export interface FormulaCellInput {
	formula: string;
	numFmt?: string;
}

/** A raw cell value the tools accept: string, number, or a formula object. */
export type DocCellInput = string | number | FormulaCellInput | null | undefined;

/** True when `v` is a `{ formula }` object (and not null / an array). */
export function isFormulaCell(v: unknown): v is FormulaCellInput {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		typeof (v as { formula?: unknown }).formula === "string" &&
		(v as { formula: string }).formula.trim().length > 0
	);
}

/** What exceljs accepts as a `cell.value`: a primitive or a `{ formula }` object. */
export type ExcelCellValue = string | number | { formula: string };

/**
 * Coerce a tool cell value into the shape exceljs's `cell.value` expects:
 *   - `{ formula }`  → `{ formula }` (the leading "=" is stripped if present)
 *   - number         → number
 *   - everything else → String(value)
 */
export function toExcelCellValue(v: DocCellInput): ExcelCellValue {
	if (isFormulaCell(v)) {
		return { formula: v.formula.trim().replace(/^=+/, "") };
	}
	if (typeof v === "number") return v;
	return String(v ?? "");
}

/* ─────────────────────────── unicode PDF font ─────────────────────────── */

/**
 * A Unicode TrueType font (DejaVu Sans) embedded into a `@cantoo/pdf-lib`
 * document so created PDFs + stamps render Latin / Latin-supplement / Greek /
 * Cyrillic / accents instead of the WinAnsi-only standard fonts (which throw or
 * tofu on anything outside their set).
 *
 * The font asset ships gzipped at `assets/DejaVuSans.ttf.gz` (Bitstream Vera /
 * public-domain-equivalent license). It is decompressed once and cached as raw
 * TTF bytes for the process lifetime; `fontkit` is registered + the font is
 * embedded (with subsetting) PER document, since a pdf-lib `PDFFont` is bound to
 * the document it was embedded into.
 *
 * CJK / emoji are NOT covered by DejaVu Sans and still fall back to "?" via
 * {@link sanitizeForFont}; Latin/Greek/Cyrillic/accented text renders correctly.
 */

/** Lazily-decompressed DejaVu Sans TTF bytes (cached for the process). */
let cachedUnicodeFontBytes: Buffer | undefined;
/** In-flight decompression promise so concurrent callers share one gunzip. */
let unicodeFontBytesPromise: Promise<Buffer> | undefined;

/** Absolute path to the gzipped font asset (resolved relative to this module). */
function unicodeFontAssetPath(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "assets", "DejaVuSans.ttf.gz");
}

/**
 * Read + gunzip the bundled DejaVu Sans TTF (cached). Throws
 * `BrigadeToolInputError` if the asset is missing or unreadable so the caller
 * can fall back to a standard font instead of leaking a raw throw.
 */
export async function loadUnicodeFontBytes(): Promise<Buffer> {
	if (cachedUnicodeFontBytes) return cachedUnicodeFontBytes;
	if (!unicodeFontBytesPromise) {
		unicodeFontBytesPromise = (async () => {
			const { gunzipSync } = await import("fflate");
			let gz: Buffer;
			try {
				gz = await fsp.readFile(unicodeFontAssetPath());
			} catch {
				throw new BrigadeToolInputError("the bundled Unicode PDF font asset is missing.");
			}
			let ttf: Uint8Array;
			try {
				ttf = gunzipSync(new Uint8Array(gz));
			} catch {
				throw new BrigadeToolInputError("the bundled Unicode PDF font asset is corrupt.");
			}
			cachedUnicodeFontBytes = Buffer.from(ttf);
			return cachedUnicodeFontBytes;
		})();
	}
	try {
		return await unicodeFontBytesPromise;
	} catch (err) {
		// Reset the cache so a transient failure can be retried on the next call.
		unicodeFontBytesPromise = undefined;
		throw err;
	}
}

/** Minimal structural view of the pieces of `@cantoo/pdf-lib` we drive here. */
interface PdfDocLike {
	registerFontkit(fk: unknown): void;
	embedFont(bytes: Uint8Array, opts?: { subset?: boolean }): Promise<PdfFontLike>;
}

/** Minimal structural view of an embedded pdf-lib font. */
export interface PdfFontLike {
	widthOfTextAtSize(text: string, size: number): number;
	heightAtSize?(size: number): number;
}

/**
 * Register fontkit on `pdf` and embed the bundled DejaVu Sans (subset), returning
 * the embedded font. Embeds PER document (a pdf-lib font is document-bound).
 * `registerFontkit` is idempotent, so calling it once per document is safe.
 */
export async function embedUnicodeFont(pdf: PdfDocLike): Promise<PdfFontLike> {
	const ttf = await loadUnicodeFontBytes();
	const fk = await import("@pdf-lib/fontkit");
	const fontkit = (fk as { default?: unknown }).default ?? fk;
	pdf.registerFontkit(fontkit);
	return pdf.embedFont(new Uint8Array(ttf), { subset: true });
}

/**
 * Replace characters the embedded font cannot render (e.g. CJK ideographs,
 * emoji) with "?" so a stray glyph never turns a valid draw into a fontkit
 * encode throw. DejaVu Sans covers Latin / Latin-1 / Latin Extended / Greek /
 * Cyrillic + common punctuation, so those pass through untouched.
 *
 * `font` is the embedded fontkit-backed font; we ask it per character whether a
 * glyph exists. When the font handle can't answer (older fontkit), we keep the
 * character (the font is a broad Unicode face, so false-strips are worse than a
 * rare tofu).
 */
export function sanitizeForFont(text: string, font: PdfFontLike): string {
	const probe = (font as { widthOfTextAtSize?: (s: string, n: number) => number }).widthOfTextAtSize;
	if (typeof probe !== "function") return String(text ?? "");
	let out = "";
	for (const ch of String(text ?? "")) {
		// Always keep the whitespace/control chars the drawers handle themselves.
		if (ch === "\n" || ch === "\r" || ch === "\t" || ch === " ") {
			out += ch;
			continue;
		}
		let ok = false;
		try {
			// A glyph the font lacks measures as 0 width (no advance) in fontkit.
			ok = font.widthOfTextAtSize(ch, 1000) > 0;
		} catch {
			ok = false;
		}
		out += ok ? ch : "?";
	}
	return out;
}

/* ─────────────────────────── misc ─────────────────────────── */

/** A short random token for auto-naming a generated document. */
export function shortToken(): string {
	return Math.random().toString(36).slice(2, 8);
}

/** Default workspace-relative output name when the caller omits `outputPath`. */
export function defaultOutputName(format: DocFormat): string {
	return `document-${shortToken()}.${extForFormat(format)}`;
}
