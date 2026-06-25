/**
 * Tests for the image downscaler (TIER 1 #2 — downscale, never truncate).
 *
 * The grid/orientation LOGIC is exercised with a STUB image (no codec) so the
 * test is fast + deterministic; one end-to-end case drives REAL jimp over a
 * real generated JPEG to prove the bytes come back as a valid, decodable image
 * under the budget. The EXIF-orientation parser is tested against a hand-built
 * Exif APP1 segment.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	downscaleImageToBudget,
	isDownscalableImageMime,
	readJpegOrientation,
	type LoadedImage,
} from "./image-downscale.js";

/* ─────────────────────────── isDownscalableImageMime ─────────────────────────── */

describe("image-downscale — isDownscalableImageMime", () => {
	it("accepts raster formats jimp can decode", () => {
		assert.equal(isDownscalableImageMime("image/jpeg"), true);
		assert.equal(isDownscalableImageMime("image/png"), true);
		assert.equal(isDownscalableImageMime("image/bmp"), true);
		assert.equal(isDownscalableImageMime("image/gif"), true);
		assert.equal(isDownscalableImageMime("image/tiff"), true);
		assert.equal(isDownscalableImageMime("image/jpeg; charset=binary"), true);
	});
	it("rejects HEIC / SVG / unknown (no native-free decode)", () => {
		assert.equal(isDownscalableImageMime("image/heic"), false);
		assert.equal(isDownscalableImageMime("image/svg+xml"), false);
		assert.equal(isDownscalableImageMime(undefined), false);
		assert.equal(isDownscalableImageMime("application/pdf"), false);
	});
});

/* ─────────────────────────── grid logic (stub image) ─────────────────────────── */

/** A stub LoadedImage that records calls and encodes to a fixed-size buffer that
 * shrinks as the box shrinks — so the grid's "stop when it fits" can be asserted. */
function stubImage(startW: number, startH: number): {
	img: LoadedImage;
	calls: { scaleToFit: Array<[number, number]>; rotate: number[]; flips: number; resets: number; encodes: number[] };
} {
	let w = startW;
	let h = startH;
	const calls = { scaleToFit: [] as Array<[number, number]>, rotate: [] as number[], flips: 0, resets: 0, encodes: [] as number[] };
	const img: LoadedImage = {
		width: () => w,
		height: () => h,
		scaleToFit: (bw, bh) => {
			calls.scaleToFit.push([bw, bh]);
			// fit-inside: shrink preserving the larger dimension to the box.
			const scale = Math.min(bw / w, bh / h, 1);
			w = Math.max(1, Math.round(w * scale));
			h = Math.max(1, Math.round(h * scale));
		},
		rotate: (deg) => {
			calls.rotate.push(deg);
			if (deg === 90 || deg === 270) [w, h] = [h, w];
		},
		flip: () => {
			calls.flips += 1;
		},
		reset: async () => {
			calls.resets += 1;
			w = startW;
			h = startH;
		},
		// Encoded size scales with the pixel area at a coarse rate — so a smaller
		// box yields a smaller buffer, letting the grid converge.
		encodeJpeg: async (q) => {
			const bytes = Math.round((w * h) / 20) + q;
			calls.encodes.push(bytes);
			return Buffer.alloc(Math.max(1, bytes), 1);
		},
	};
	return { img, calls };
}

describe("image-downscale — grid logic", () => {
	it("returns original bytes untouched when already under budget + within dims", async () => {
		const original = Buffer.alloc(500, 7);
		let loaded = false;
		const r = await downscaleImageToBudget(
			original,
			{ maxBytes: 10_000, sourceMime: "image/png" },
			async () => {
				loaded = true;
				return stubImage(100, 100).img;
			},
		);
		// Decode still happens (to check dims), but the original bytes are returned.
		assert.equal(loaded, true);
		assert.equal(r.bytes, original, "same buffer reference — lossless");
		assert.equal(r.resized, false);
	});

	it("walks the grid and stops at the first step that fits the budget", async () => {
		const original = Buffer.alloc(5_000_000, 7); // far over budget
		const { img, calls } = stubImage(4000, 3000);
		const r = await downscaleImageToBudget(
			original,
			{ maxBytes: 50_000, sourceMime: "image/jpeg" },
			async () => img,
		);
		assert.equal(r.resized, true);
		assert.equal(r.mimeType, "image/jpeg", "always re-encodes to JPEG");
		assert.ok(r.bytes.length <= 50_000, "final bytes fit the budget");
		assert.ok(calls.scaleToFit.length >= 1, "at least one resize step ran");
		assert.ok(calls.resets >= 1, "reset between grid steps");
	});

	it("returns the smallest grid step even if nothing fits (valid image over corrupt)", async () => {
		const original = Buffer.alloc(9_000_000, 7);
		const { img } = stubImage(8000, 6000);
		// An impossibly tiny budget — even the smallest step won't fit.
		const r = await downscaleImageToBudget(original, { maxBytes: 5, sourceMime: "image/jpeg" }, async () => img);
		assert.equal(r.resized, true);
		// We still return a valid (re-encoded) buffer rather than a truncated one.
		assert.ok(r.bytes.length > 0);
	});

	it("applies EXIF orientation (rotate) before encoding", async () => {
		// A buffer whose orientation parser returns 6 (rotate 90). We stub the
		// parser by building a real Exif segment below; here we just confirm the
		// rotate path runs when a fake loader reports orientation via a real JPEG.
		const original = withExifOrientation(6);
		const { img, calls } = stubImage(200, 100);
		const r = await downscaleImageToBudget(
			original,
			{ maxBytes: 10, sourceMime: "image/jpeg" }, // force the grid (so rotate re-applies)
			async () => img,
		);
		assert.equal(r.rotated, true);
		assert.ok(calls.rotate.includes(90), "rotated 90° for orientation 6");
	});
});

/* ─────────────────────────── EXIF orientation parser ─────────────────────────── */

/**
 * Build a minimal JPEG (SOI + an Exif APP1 segment carrying orientation + EOI)
 * — enough for `readJpegOrientation` to parse, not a decodable image.
 */
function withExifOrientation(orientation: number): Buffer {
	// TIFF (big-endian "MM") with one IFD entry: tag 0x0112 (orientation),
	// type 3 (SHORT), count 1, value = orientation in the high 2 bytes.
	const tiff = Buffer.alloc(2 + 2 + 4 + 2 + 12 + 4);
	let o = 0;
	tiff.write("MM", o);
	o += 2;
	tiff.writeUInt16BE(42, o);
	o += 2; // magic
	tiff.writeUInt32BE(8, o);
	o += 4; // IFD offset
	tiff.writeUInt16BE(1, o);
	o += 2; // entry count
	tiff.writeUInt16BE(0x0112, o);
	o += 2; // tag
	tiff.writeUInt16BE(3, o);
	o += 2; // type SHORT
	tiff.writeUInt32BE(1, o);
	o += 4; // count
	tiff.writeUInt16BE(orientation, o);
	o += 2; // value (high bytes)
	tiff.writeUInt16BE(0, o);
	o += 2; // pad
	tiff.writeUInt32BE(0, o); // next IFD = 0

	const exifHeader = Buffer.from("Exif\0\0", "ascii");
	const payload = Buffer.concat([exifHeader, tiff]);
	const app1 = Buffer.alloc(4 + payload.length);
	app1[0] = 0xff;
	app1[1] = 0xe1;
	app1.writeUInt16BE(payload.length + 2, 2);
	payload.copy(app1, 4);

	const soi = Buffer.from([0xff, 0xd8]);
	const eoi = Buffer.from([0xff, 0xd9]);
	return Buffer.concat([soi, app1, eoi]);
}

describe("image-downscale — readJpegOrientation", () => {
	it("reads the orientation tag from a real Exif APP1 segment", () => {
		for (const orient of [1, 3, 6, 8]) {
			assert.equal(readJpegOrientation(withExifOrientation(orient)), orient, `orientation ${orient}`);
		}
	});
	it("returns undefined for a non-JPEG / no-Exif buffer", () => {
		assert.equal(readJpegOrientation(Buffer.from([0x89, 0x50, 0x4e, 0x47])), undefined); // PNG
		assert.equal(readJpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), undefined); // bare JPEG
		assert.equal(readJpegOrientation(Buffer.alloc(0)), undefined);
	});
});

/* ─────────────────────────── real jimp end-to-end ─────────────────────────── */

describe("image-downscale — real jimp (end-to-end)", () => {
	it("downscales a real oversize JPEG to a VALID decodable image under the budget", async () => {
		const { Jimp, JimpMime } = await import("jimp");
		// A 2400×1600 noisy image so the JPEG doesn't compress to nothing.
		const src = new Jimp({ width: 2400, height: 1600, color: 0x224466ff });
		for (let i = 0; i < src.bitmap.data.length; i += 17) src.bitmap.data[i] = (i * 13) & 0xff;
		const srcBuf = await src.getBuffer(JimpMime.jpeg, { quality: 95 });
		assert.ok(Buffer.isBuffer(srcBuf));

		const budget = 80_000;
		const r = await downscaleImageToBudget(Buffer.from(srcBuf), { maxBytes: budget, sourceMime: "image/jpeg" });
		assert.equal(r.resized, true);
		assert.ok(r.bytes.length <= budget, `result ${r.bytes.length} <= ${budget}`);
		// The crucial property: the output is a VALID image (truncation would throw).
		const back = await Jimp.read(r.bytes);
		assert.ok(back.bitmap.width > 0 && back.bitmap.height > 0, "decodes back to a real image");
		assert.ok(back.bitmap.width <= 4096 && back.bitmap.height <= 4096);
	});

	it("throws on undecodable bytes (caller falls back to pass-through)", async () => {
		await assert.rejects(() =>
			downscaleImageToBudget(Buffer.from("not an image at all"), { maxBytes: 1000, sourceMime: "image/png" }),
		);
	});
});
