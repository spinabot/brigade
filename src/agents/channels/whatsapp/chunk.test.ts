import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { chunkText } from "./chunk.js";

describe("chunkText", () => {
	it("returns a single chunk when under the limit", () => {
		assert.deepEqual(chunkText("hello"), ["hello"]);
	});

	it("respects a custom limit", () => {
		const out = chunkText("abcdefghij", { limit: 4 });
		// 10 chars, limit 4 → multiple chunks, each ≤4
		assert.ok(out.length >= 2);
		for (const c of out) assert.ok(c.length <= 4, `chunk too big: ${JSON.stringify(c)}`);
		assert.equal(out.join(""), "abcdefghij");
	});

	it("splits on paragraph boundaries when possible", () => {
		const p1 = "a".repeat(100);
		const p2 = "b".repeat(100);
		const p3 = "c".repeat(100);
		const text = `${p1}\n\n${p2}\n\n${p3}`;
		const chunks = chunkText(text, { limit: 110 });
		// Each chunk holds exactly ONE paragraph (100 chars each); 3 chunks total.
		assert.equal(chunks.length, 3);
		assert.ok(chunks[0]?.includes(p1));
		assert.ok(chunks[1]?.includes(p2));
		assert.ok(chunks[2]?.includes(p3));
	});

	it("packs multiple small paragraphs into one chunk when they fit", () => {
		const text = ["p1", "p2", "p3", "p4"].join("\n\n");
		const chunks = chunkText(text, { limit: 1000 });
		assert.equal(chunks.length, 1);
		assert.ok(chunks[0]?.includes("p1") && chunks[0]?.includes("p4"));
	});

	it("falls back to line-level split when a paragraph is too long", () => {
		const oversizedParagraph = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n"); // ~400 chars
		const chunks = chunkText(oversizedParagraph, { limit: 100 });
		assert.ok(chunks.length > 1);
		for (const c of chunks) assert.ok(c.length <= 100);
	});

	it("hard-splits at word boundary when one line is still too long", () => {
		const longLine = "x".repeat(50) + " " + "y".repeat(50);
		const chunks = chunkText(longLine, { limit: 30 });
		assert.ok(chunks.length >= 3);
		for (const c of chunks) assert.ok(c.length <= 30);
	});

	it("closes an open ``` code fence at the chunk boundary so markdown parses", () => {
		// A 1000-char code block packed against the limit so it has to split.
		const text = "intro\n\n```js\n" + "a".repeat(500) + "\n```";
		const chunks = chunkText(text, { limit: 100 });
		assert.ok(chunks.length > 1);
		// Any chunk that opens a fence but doesn't close it should be repaired
		// with a trailing ```.
		for (const c of chunks) {
			const fenceCount = (c.match(/(^|\n)```/g) ?? []).length;
			assert.equal(fenceCount % 2, 0, `unbalanced fences in: ${JSON.stringify(c)}`);
		}
	});

	it("does not leak whitespace at chunk start after a hard split", () => {
		const text = "x".repeat(50) + "   " + "y".repeat(50);
		const chunks = chunkText(text, { limit: 30 });
		// The hard-split consumes trailing whitespace; no chunk should start with " ".
		for (const c of chunks.slice(1)) assert.notEqual(c[0], " ", `chunk leads with space: ${JSON.stringify(c)}`);
	});
});
