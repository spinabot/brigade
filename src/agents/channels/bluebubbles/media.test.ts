import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { downloadInboundAttachments, mapInboundExtension } from "./media.js";

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "media", "pw"].join("-");

/** A fake fetch returning canned bytes for an attachment download. */
function bytesFetch(bytes: Uint8Array, opts: { status?: number; contentType?: string } = {}): typeof fetch {
	return (async () => {
		const status = opts.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? opts.contentType ?? null : null) } as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("mapInboundExtension", () => {
	it("maps HEIC → jpg", () => {
		assert.equal(mapInboundExtension("photo.heic"), "photo.jpg");
		assert.equal(mapInboundExtension("IMG_0001.HEIC"), "IMG_0001.jpg");
	});
	it("maps caf → mp3", () => {
		assert.equal(mapInboundExtension("memo.caf"), "memo.mp3");
	});
	it("leaves other extensions untouched", () => {
		assert.equal(mapInboundExtension("clip.mp4"), "clip.mp4");
		assert.equal(mapInboundExtension("doc.pdf"), "doc.pdf");
	});
});

describe("downloadInboundAttachments", () => {
	it("downloads + caches an attachment, applying the extension map", async () => {
		const cacheDir = mkdtempSync(path.join(os.tmpdir(), "bb-media-"));
		const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
		const out = await downloadInboundAttachments(
			[{ guid: "ATT-1", transferName: "pic.heic", mimeType: "image/heic", totalBytes: 3 }],
			{ serverUrl: SERVER, password: PASSWORD, cacheDir, maxBytes: 1024, fetchImpl: bytesFetch(bytes) },
		);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.kind, "image");
		assert.match(out[0]!.fileName ?? "", /\.jpg$/);
		// The file was actually written.
		const written = readFileSync(out[0]!.path);
		assert.equal(written.length, 3);
	});

	it("skips an oversize attachment by reported totalBytes", async () => {
		const cacheDir = mkdtempSync(path.join(os.tmpdir(), "bb-media-"));
		const out = await downloadInboundAttachments(
			[{ guid: "BIG", transferName: "huge.mov", totalBytes: 9_999_999 }],
			{ serverUrl: SERVER, password: PASSWORD, cacheDir, maxBytes: 1024, fetchImpl: bytesFetch(new Uint8Array([1])) },
		);
		assert.equal(out.length, 0);
	});

	it("skips an attachment with no guid", async () => {
		const cacheDir = mkdtempSync(path.join(os.tmpdir(), "bb-media-"));
		const out = await downloadInboundAttachments([{ transferName: "x.png" }], {
			serverUrl: SERVER,
			password: PASSWORD,
			cacheDir,
			maxBytes: 1024,
			fetchImpl: bytesFetch(new Uint8Array([1])),
		});
		assert.equal(out.length, 0);
	});

	it("returns [] when a download fails (non-2xx)", async () => {
		const cacheDir = mkdtempSync(path.join(os.tmpdir(), "bb-media-"));
		const out = await downloadInboundAttachments([{ guid: "ATT-2", transferName: "p.png" }], {
			serverUrl: SERVER,
			password: PASSWORD,
			cacheDir,
			maxBytes: 1024,
			fetchImpl: bytesFetch(new Uint8Array([1]), { status: 404 }),
		});
		assert.equal(out.length, 0);
	});
});
