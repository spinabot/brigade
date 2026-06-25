import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import type { BrigadeExtensionRegistry } from "../extensions/registry.js";
import type { InboundMediaAttachment, TranscriptionProvider } from "../extensions/types.js";
import {
	buildInboundImageBlocks,
	buildMediaNote,
	INBOUND_IMAGE_MAX_BYTES,
} from "./media-capture.js";

const cfg = {} as BrigadeConfig;

function audioFile(dir: string): string {
	const p = path.join(dir, "voice.ogg");
	fs.writeFileSync(p, "fake-audio-bytes");
	return p;
}

function registryWith(provider?: TranscriptionProvider): BrigadeExtensionRegistry {
	return { transcriptionProviders: provider ? [provider] : [] } as unknown as BrigadeExtensionRegistry;
}

describe("buildMediaNote — inbound transcription folding", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mc-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("folds the transcript into the note for a voice attachment when a provider is configured", async () => {
		const p = audioFile(dir);
		const provider: TranscriptionProvider = {
			id: "mock",
			label: "Mock",
			isConfigured: () => true,
			transcribe: async () => ({ text: "  buy milk on the way home  " }),
		};
		const note = await buildMediaNote([{ kind: "voice", path: p, mimeType: "audio/ogg" }], {
			registry: registryWith(provider),
			config: cfg,
		});
		assert.match(note, /transcript.*buy milk on the way home/);
		assert.ok(!note.includes(p), "the raw path stub is replaced by the transcript");
	});

	it("falls back to the analyze_media call-to-action when no provider is configured", async () => {
		const p = audioFile(dir);
		const note = await buildMediaNote([{ kind: "voice", path: p }], { registry: registryWith(), config: cfg });
		// Audio with no transcript can only be read via the tool — the note must
		// name analyze_media + the path so the agent reaches for it (A1).
		assert.match(note, /attached voice/);
		assert.match(note, /call analyze_media with source="/);
		assert.ok(note.includes(p), "the path is preserved for the tool call");
	});

	it("never transcribes non-audio (an IMAGE stays a bare stub, provider untouched)", async () => {
		const p = path.join(dir, "pic.jpg");
		fs.writeFileSync(p, "img");
		const provider: TranscriptionProvider = {
			id: "mock",
			label: "Mock",
			isConfigured: () => true,
			transcribe: async () => {
				throw new Error("transcribe must not be called for an image");
			},
		};
		const note = await buildMediaNote([{ kind: "image", path: p }], { registry: registryWith(provider), config: cfg });
		// Images flow inline to the model (A3) — note stays a bare path stub, NO
		// analyze_media call-to-action (that's only for non-inlinable kinds).
		assert.equal(note, `[attached image → ${p}]`);
		assert.doesNotMatch(note, /call analyze_media/);
	});

	it("a PDF/document attachment carries the analyze_media call-to-action (A1)", async () => {
		const p = path.join(dir, "invoice.pdf");
		fs.writeFileSync(p, "%PDF-1.4 fake");
		const note = await buildMediaNote([{ kind: "document", path: p, fileName: "invoice.pdf" }], { config: cfg });
		assert.match(note, /attached document \(invoice\.pdf\)/);
		assert.match(note, /not inlined; call analyze_media with source="/);
		assert.ok(note.includes(p), "the path is in the call-to-action");
	});

	it("a VIDEO attachment carries the analyze_media call-to-action (A1)", async () => {
		const p = path.join(dir, "clip.mp4");
		fs.writeFileSync(p, "fake-video");
		const note = await buildMediaNote([{ kind: "video", path: p }], { config: cfg });
		assert.match(note, /attached video/);
		assert.match(note, /call analyze_media with source="/);
	});

	it("an AUDIO attachment with STT configured STILL folds the transcript (A1 untouched)", async () => {
		const p = audioFile(dir);
		const provider: TranscriptionProvider = {
			id: "mock",
			label: "Mock",
			isConfigured: () => true,
			transcribe: async () => ({ text: "the meeting is at noon" }),
		};
		const note = await buildMediaNote([{ kind: "audio", path: p, mimeType: "audio/ogg" }], {
			registry: registryWith(provider),
			config: cfg,
		});
		// Transcript path wins over the call-to-action when STT produced text.
		assert.match(note, /transcript.*the meeting is at noon/);
		assert.doesNotMatch(note, /call analyze_media/);
	});

	it("falls back to the call-to-action if the provider throws (best-effort — ingest never breaks)", async () => {
		const p = audioFile(dir);
		const provider: TranscriptionProvider = {
			id: "mock",
			label: "Mock",
			isConfigured: () => true,
			transcribe: async () => {
				throw new Error("STT down");
			},
		};
		const note = await buildMediaNote([{ kind: "voice", path: p }], { registry: registryWith(provider), config: cfg });
		// A failed transcription degrades to the tool call-to-action, not a dead stub.
		assert.match(note, /attached voice/);
		assert.match(note, /call analyze_media with source="/);
	});

	it("no registry → audio falls back to the analyze_media call-to-action (backward-compatible)", async () => {
		const p = audioFile(dir);
		const note = await buildMediaNote([{ kind: "voice", path: p }], { config: cfg });
		assert.match(note, /attached voice/);
		assert.match(note, /call analyze_media with source="/);
	});
});

describe("buildInboundImageBlocks — inline inbound images (A3)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-img-"));
	});
	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	function imageFile(name: string, bytes: Buffer | string): string {
		const p = path.join(dir, name);
		fs.writeFileSync(p, bytes);
		return p;
	}

	it("decodes an inbound image into a base64 block with a derived mime", async () => {
		const raw = Buffer.from("PNGDATA-bytes");
		const p = imageFile("photo.png", raw);
		const blocks = await buildInboundImageBlocks([{ kind: "image", path: p }]);
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]?.mimeType, "image/png");
		assert.equal(blocks[0]?.data, raw.toString("base64"));
		// Round-trips back to the original bytes (raw base64, no data: prefix).
		assert.equal(Buffer.from(blocks[0]!.data, "base64").toString(), "PNGDATA-bytes");
	});

	it("prefers the declared image/* mimeType over the extension", async () => {
		const p = imageFile("photo.bin", "jpgbytes");
		const blocks = await buildInboundImageBlocks([
			{ kind: "image", path: p, mimeType: "image/jpeg" },
		]);
		assert.equal(blocks[0]?.mimeType, "image/jpeg");
	});

	it("falls back to extension when no (or a non-image) mime is declared", async () => {
		const webp = imageFile("a.webp", "w");
		const gif = imageFile("b.gif", "g");
		const blocks = await buildInboundImageBlocks([
			{ kind: "image", path: webp, mimeType: "application/octet-stream" },
			{ kind: "image", path: gif },
		]);
		assert.equal(blocks[0]?.mimeType, "image/webp");
		assert.equal(blocks[1]?.mimeType, "image/gif");
	});

	it("IGNORES non-image kinds (documents/video/audio go through analyze_media, not inline)", async () => {
		const pdf = imageFile("x.pdf", "%PDF");
		const vid = imageFile("x.mp4", "vid");
		const aud = imageFile("x.ogg", "aud");
		const blocks = await buildInboundImageBlocks([
			{ kind: "document", path: pdf },
			{ kind: "video", path: vid },
			{ kind: "audio", path: aud },
		]);
		assert.equal(blocks.length, 0);
	});

	it("skips an unreadable image path (best-effort — the note still carries it)", async () => {
		const ok = imageFile("ok.png", "ok");
		const missing = path.join(dir, "does-not-exist.png");
		const blocks = await buildInboundImageBlocks([
			{ kind: "image", path: missing },
			{ kind: "image", path: ok },
		]);
		// Only the readable one is decoded; the missing one is silently skipped.
		assert.equal(blocks.length, 1);
		assert.equal(Buffer.from(blocks[0]!.data, "base64").toString(), "ok");
	});

	it("drops an image over the per-image byte cap (falls back to the path note)", async () => {
		const small = imageFile("small.png", "tiny");
		const big = imageFile("big.png", Buffer.alloc(64, 0x41));
		const blocks = await buildInboundImageBlocks([{ kind: "image", path: small }, { kind: "image", path: big }], {
			perImageMaxBytes: 16, // both are tested against this tiny cap
		});
		// `big` (64 bytes) exceeds the 16-byte cap → dropped; `small` (4 bytes) kept.
		assert.equal(blocks.length, 1);
		assert.equal(Buffer.from(blocks[0]!.data, "base64").toString(), "tiny");
	});

	it("enforces the TOTAL byte budget across multiple images", async () => {
		const a = imageFile("a.png", Buffer.alloc(10, 0x41));
		const b = imageFile("b.png", Buffer.alloc(10, 0x42));
		const c = imageFile("c.png", Buffer.alloc(10, 0x43));
		// Total cap 25 → a (10) + b (10) = 20 fit; c would push to 30 → skipped.
		const blocks = await buildInboundImageBlocks(
			[
				{ kind: "image", path: a },
				{ kind: "image", path: b },
				{ kind: "image", path: c },
			],
			{ totalMaxBytes: 25 },
		);
		assert.equal(blocks.length, 2);
	});

	it("drops a zero-byte image (nothing useful to show the model)", async () => {
		const empty = imageFile("empty.png", Buffer.alloc(0));
		const blocks = await buildInboundImageBlocks([{ kind: "image", path: empty }]);
		assert.equal(blocks.length, 0);
	});

	it("returns [] for an empty media list", async () => {
		assert.deepEqual(await buildInboundImageBlocks([]), []);
	});

	it("exposes a sane default per-image cap", () => {
		// 8 MiB — matches analyze_media's DEFAULT_IMAGE_MAX_BYTES.
		assert.equal(INBOUND_IMAGE_MAX_BYTES, 8 * 1024 * 1024);
	});
});
