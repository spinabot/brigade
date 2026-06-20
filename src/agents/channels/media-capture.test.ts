import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BrigadeConfig } from "../../config/io.js";
import type { BrigadeExtensionRegistry } from "../extensions/registry.js";
import type { InboundMediaAttachment, TranscriptionProvider } from "../extensions/types.js";
import { buildMediaNote } from "./media-capture.js";

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

	it("falls back to the path stub when no provider is configured", async () => {
		const p = audioFile(dir);
		const note = await buildMediaNote([{ kind: "voice", path: p }], { registry: registryWith(), config: cfg });
		assert.equal(note, `[attached voice → ${p}]`);
	});

	it("never transcribes non-audio (an image stays a stub, provider untouched)", async () => {
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
		assert.equal(note, `[attached image → ${p}]`);
	});

	it("falls back to the stub if the provider throws (best-effort — ingest never breaks)", async () => {
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
		assert.equal(note, `[attached voice → ${p}]`);
	});

	it("no registry → stub (backward-compatible)", async () => {
		const p = audioFile(dir);
		const note = await buildMediaNote([{ kind: "voice", path: p }], { config: cfg });
		assert.equal(note, `[attached voice → ${p}]`);
	});
});
