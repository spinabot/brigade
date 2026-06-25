/**
 * Image downscaling for `analyze_media` — keeps an oversize image a VALID,
 * decodable image instead of byte-truncating it (which corrupts the stream and
 * makes every vision model reject the payload).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY (read before changing)
 * ─────────────────────────────────────────────────────────────────────────
 * The acquisition layer caps bytes by `buf.subarray(0, maxBytes)`. For a
 * document that is a best-effort prefix; for an IMAGE it is fatal — a JPEG/PNG
 * cut mid-stream has no end marker, so `jpeg-js` / the provider decoder throws
 * "marker was not found" and the model sees nothing. The correct response to
 * "this image is too big" is to RESIZE it (fit-inside, down a quality grid)
 * until the ENCODED bytes fit the budget — the model still sees the whole
 * picture, just at lower resolution.
 *
 * Pure-JS only: uses `jimp` (zero native bindings — preserves Brigade's
 * no-native-dep streak; `sharp` would pull a platform binary). EXIF orientation
 * is applied here too (jimp 1.x does not auto-rotate on decode), so a phone
 * photo taken sideways is uprighted before the model reads it.
 *
 * The jimp import is LAZY (inside `downscaleImageToBudget`) so the cost stays
 * off the cold-start path and only an actual oversize-image analysis pays it.
 */

/** Hard cap on either pixel dimension before we force a resize (very large
 * images blow token budgets even when their byte size is modest, e.g. PNG
 * screenshots). Fit-inside this box on the first downscale step. */
export const MAX_IMAGE_DIMENSION = 4096;

/**
 * Descending (maxDimension, jpegQuality) grid tried in order until the encoded
 * JPEG fits the byte budget. Starts gentle (large + high quality) and ends
 * aggressive (small + low quality) so a barely-oversize image keeps most of its
 * fidelity while a giant one still lands under the cap.
 */
const QUALITY_GRID: Array<{ dim: number; quality: number }> = [
	{ dim: 4096, quality: 82 },
	{ dim: 3072, quality: 78 },
	{ dim: 2048, quality: 72 },
	{ dim: 1568, quality: 68 },
	{ dim: 1024, quality: 60 },
	{ dim: 768, quality: 55 },
	{ dim: 512, quality: 45 },
];

/** Result of a downscale attempt. */
export interface DownscaleResult {
	/** The re-encoded image bytes (always a valid, decodable image). */
	bytes: Buffer;
	/** MIME of the returned bytes (we always re-encode to JPEG). */
	mimeType: string;
	/** Final pixel dimensions. */
	width: number;
	height: number;
	/** True when the image was actually resized/re-encoded (vs returned as-is). */
	resized: boolean;
	/** True when EXIF orientation was applied. */
	rotated: boolean;
}

/**
 * MIME types jimp 1.x can DECODE. HEIC/HEIF + SVG are not decodable without a
 * native dep, so we never try to downscale them — they pass through untouched
 * (the tool already warns HEIC may be rejected by the model).
 */
export function isDownscalableImageMime(mime: string | undefined): boolean {
	if (!mime) return false;
	const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		m === "image/jpeg" ||
		m === "image/png" ||
		m === "image/bmp" ||
		m === "image/gif" ||
		m === "image/tiff" ||
		m === "image/x-ms-bmp"
	);
}

/**
 * Read the EXIF orientation tag (0x0112) from raw JPEG bytes. Returns 1..8 (the
 * EXIF orientation value) or `undefined` when there is no Exif APP1 segment /
 * orientation tag. A minimal, dependency-free TIFF/Exif walker — only enough to
 * find the one tag we act on. Never throws (returns undefined on malformed
 * input).
 */
export function readJpegOrientation(bytes: Buffer): number | undefined {
	try {
		// JPEG starts with SOI 0xFFD8.
		if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
		let offset = 2;
		while (offset + 4 <= bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = bytes[offset + 1] ?? 0;
			// APP1 (0xE1) carries Exif.
			const segLen = bytes.readUInt16BE(offset + 2);
			if (marker === 0xe1) {
				const segStart = offset + 4;
				// "Exif\0\0" header.
				if (
					bytes.length >= segStart + 6 &&
					bytes.toString("ascii", segStart, segStart + 4) === "Exif"
				) {
					return readOrientationFromTiff(bytes, segStart + 6);
				}
			}
			// SOS (0xDA) = start of scan; no more metadata after this.
			if (marker === 0xda || marker === 0xd9) return undefined;
			if (segLen < 2) return undefined;
			offset += 2 + segLen;
		}
	} catch {
		/* malformed — no orientation */
	}
	return undefined;
}

/** Parse a TIFF header at `tiffStart` and return the orientation tag value. */
function readOrientationFromTiff(bytes: Buffer, tiffStart: number): number | undefined {
	if (tiffStart + 8 > bytes.length) return undefined;
	const byteOrder = bytes.toString("ascii", tiffStart, tiffStart + 2);
	const little = byteOrder === "II";
	const big = byteOrder === "MM";
	if (!little && !big) return undefined;
	const u16 = (o: number) => (little ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
	const u32 = (o: number) => (little ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
	const ifdOffset = u32(tiffStart + 4);
	const ifd = tiffStart + ifdOffset;
	if (ifd + 2 > bytes.length) return undefined;
	const count = u16(ifd);
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > bytes.length) break;
		const tag = u16(entry);
		if (tag === 0x0112) {
			// Orientation is a SHORT stored in the value field.
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : undefined;
		}
	}
	return undefined;
}

/**
 * Apply an EXIF orientation (1..8) to a jimp image in place. Mirrors the EXIF
 * spec's 8 orientations (rotations + mirror flips). Orientation 1 is a no-op.
 */
function applyOrientation(
	img: { rotate: (deg: number) => unknown; flip: (opts: { horizontal?: boolean; vertical?: boolean }) => unknown },
	orientation: number,
): boolean {
	switch (orientation) {
		case 2:
			img.flip({ horizontal: true });
			return true;
		case 3:
			img.rotate(180);
			return true;
		case 4:
			img.flip({ vertical: true });
			return true;
		case 5:
			img.rotate(90);
			img.flip({ horizontal: true });
			return true;
		case 6:
			img.rotate(90);
			return true;
		case 7:
			img.rotate(270);
			img.flip({ horizontal: true });
			return true;
		case 8:
			img.rotate(270);
			return true;
		default:
			return false; // 1 or unknown → no transform
	}
}

/**
 * Downscale `bytes` (a decodable raster image) so the RE-ENCODED result fits
 * `maxBytes`, applying EXIF orientation. Returns a valid image every time. When
 * the source already fits the budget AND is within the dimension cap AND has no
 * orientation to apply, the ORIGINAL bytes are returned unchanged (no needless
 * re-encode). Throws when the bytes cannot be decoded (caller decides whether
 * to fall back to pass-through).
 *
 * `loadImpl` is a test seam (defaults to the lazy jimp loader) so the grid
 * logic can be exercised without bundling a real codec into the test.
 */
export async function downscaleImageToBudget(
	bytes: Buffer,
	opts: { maxBytes: number; maxDimension?: number; sourceMime?: string },
	loadImpl: LoadImage = defaultLoadImage,
): Promise<DownscaleResult> {
	const maxDim = opts.maxDimension ?? MAX_IMAGE_DIMENSION;
	const orientation = readJpegOrientation(bytes);
	const img = await loadImpl(bytes);
	let rotated = false;
	if (orientation && orientation !== 1) {
		rotated = applyOrientation(img, orientation);
	}
	const startW = img.width();
	const startH = img.height();
	const fitsBytes = bytes.length <= opts.maxBytes;
	const fitsDims = startW <= maxDim && startH <= maxDim;
	// Fast path: already small enough AND no transform was applied → return the
	// original bytes (cheapest, lossless).
	if (fitsBytes && fitsDims && !rotated) {
		return {
			bytes,
			mimeType: opts.sourceMime?.split(";")[0]?.trim().toLowerCase() || "image/jpeg",
			width: startW,
			height: startH,
			resized: false,
			rotated: false,
		};
	}

	// Walk the grid: shrink to each step's box (never upscale) + encode JPEG, and
	// stop at the first encode that fits the budget.
	let best: { buf: Buffer; w: number; h: number } | undefined;
	for (const step of QUALITY_GRID) {
		const box = Math.min(step.dim, maxDim);
		await img.reset();
		if (orientation && orientation !== 1) applyOrientation(img, orientation);
		// Only shrink — fit-inside the box without enlarging a smaller source.
		if (img.width() > box || img.height() > box) {
			img.scaleToFit(box, box);
		}
		const buf = await img.encodeJpeg(step.quality);
		best = { buf, w: img.width(), h: img.height() };
		if (buf.length <= opts.maxBytes) break;
	}
	// Even the smallest grid step is the best we can do — return it (a valid,
	// decodable image), preferring a slightly-over result over a corrupt one.
	const out = best ?? { buf: bytes, w: startW, h: startH };
	return {
		bytes: out.buf,
		mimeType: "image/jpeg",
		width: out.w,
		height: out.h,
		resized: true,
		rotated,
	};
}

/**
 * Minimal image handle the downscaler drives. Backed by jimp in production; a
 * stub in tests. `reset()` restores the original decoded pixels so each grid
 * step shrinks from full resolution (jimp mutates in place).
 */
export interface LoadedImage {
	width(): number;
	height(): number;
	scaleToFit(w: number, h: number): void;
	rotate(deg: number): void;
	flip(opts: { horizontal?: boolean; vertical?: boolean }): void;
	/** Re-decode the original bytes so the next grid step starts from full res. */
	reset(): Promise<void>;
	/** Encode the current pixels to a JPEG buffer at `quality` (1..100). */
	encodeJpeg(quality: number): Promise<Buffer>;
}

export type LoadImage = (bytes: Buffer) => Promise<LoadedImage>;

/**
 * Default loader — lazily imports jimp and adapts its image to {@link LoadedImage}.
 * jimp mutates in place, so `reset()` re-reads the ORIGINAL bytes into a fresh
 * image to give each grid step a clean full-resolution starting point.
 */
const defaultLoadImage: LoadImage = async (bytes: Buffer): Promise<LoadedImage> => {
	const { Jimp, JimpMime } = await import("jimp");
	let current = await Jimp.read(bytes);
	return {
		width: () => current.bitmap.width,
		height: () => current.bitmap.height,
		scaleToFit: (w, h) => {
			current.scaleToFit({ w, h });
		},
		rotate: (deg) => {
			current.rotate(deg);
		},
		flip: (opts) => {
			current.flip({ horizontal: Boolean(opts.horizontal), vertical: Boolean(opts.vertical) });
		},
		reset: async () => {
			current = await Jimp.read(bytes);
		},
		encodeJpeg: async (quality) => {
			const buf = await current.getBuffer(JimpMime.jpeg, { quality });
			return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as unknown as ArrayBuffer);
		},
	};
};
