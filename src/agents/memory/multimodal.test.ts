import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FactStore } from "./records.js";

/**
 * Multimodal cold-pointer (Tideline v2, step 17). Media → text (a transcript /
 * caption, produced by a Whisper/caption SEAM) is stored as `content` so recall
 * is uniform; the media stays OUT of the hot index at `mediaPointer`, tagged by
 * `modality`. Done-when: a voice-note is recallable by its content.
 */

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-mm-"));
});
afterEach(() => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("multimodal cold-pointer", () => {
	it("a voice-note (transcript content + audio pointer) is recallable by content + carries the pointer", () => {
		const store = new FactStore(dir);
		const rec = store.write({
			content: "remember to renew the domain before Friday",
			segment: "knowledge",
			modality: "audio",
			mediaPointer: "file:///voice/note-42.ogg",
		});
		assert.equal(rec.modality, "audio");
		assert.equal(rec.mediaPointer, "file:///voice/note-42.ogg");

		const hit = store.recall("renew domain", { markAccessed: false })[0];
		assert.ok(hit, "recall must return at least one hit");
		assert.equal(hit.content, "remember to renew the domain before Friday", "recallable by its exact transcript text");
		assert.equal(hit.modality, "audio", "modality travels with the hit");
		assert.equal(hit.mediaPointer, "file:///voice/note-42.ogg", "cold pointer travels with the hit");

		// Cold-pointer invariant: the media URI/pointer tokens are NOT in the hot
		// text index, so searching by them must not surface the fact.
		assert.equal(
			store.recall("note 42 ogg voice", { markAccessed: false }).length,
			0,
			"media pointer tokens are not indexed for recall",
		);
	});

	it("plain text facts have undefined modality/pointer (back-compat)", () => {
		const store = new FactStore(dir);
		const rec = store.write({ content: "plain text fact", segment: "knowledge" });
		assert.equal(rec.modality, undefined);
		assert.equal(rec.mediaPointer, undefined);

		// JSONL round-trip: re-read via list and confirm the absent fields stay
		// undefined (mirrors the populated-path back-compat assertion above).
		const reread = store.list({})[0];
		assert.equal(reread?.modality, undefined);
		assert.equal(reread?.mediaPointer, undefined);
	});
});
