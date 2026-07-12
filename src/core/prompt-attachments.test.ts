/**
 * These checks are a FOOTGUN boundary, not an authorization boundary (see the
 * module header): `prompt` is already operator-privileged. What they buy is that
 * a malformed attachment list fails loudly and cheaply instead of wedging a turn
 * — and, critically, that a rejected file is REPORTED rather than silently
 * dropped, because an attachment that vanished without explanation is the worst
 * possible outcome for the operator.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
	PROMPT_ATTACHMENT_MAX_COUNT,
	composeAttachmentTurn,
	resolvePromptAttachments,
} from "./prompt-attachments.js";
import type { PromptAttachment } from "../protocol.js";
import type { BrigadeConfig } from "../config/io.js";

let dir: string;
let png: string;

before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-pa-test-"));
	png = path.join(dir, "shot.png");
	fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

after(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const att = (over: Partial<PromptAttachment>): PromptAttachment => ({
	kind: "image",
	path: png,
	mimeType: "image/png",
	fileName: "shot.png",
	...over,
});

describe("resolvePromptAttachments", () => {
	it("is a no-op for the historical caller — undefined attachments", async () => {
		const r = await resolvePromptAttachments(undefined);
		assert.deepEqual(r.media, []);
		assert.deepEqual(r.rejected, []);
	});

	it("resolves a real file into the channel media shape", async () => {
		const r = await resolvePromptAttachments([att({})]);
		assert.deepEqual(r.rejected, []);
		assert.equal(r.media.length, 1);
		assert.equal(r.media[0]?.kind, "image");
		assert.equal(r.media[0]?.path, png);
		assert.equal(r.media[0]?.mimeType, "image/png");
		assert.equal(r.media[0]?.fileName, "shot.png");
	});

	it("backfills fileName from the path when the client omits it", async () => {
		const r = await resolvePromptAttachments([att({ fileName: undefined })]);
		assert.equal(r.media[0]?.fileName, "shot.png");
	});

	it("refuses a relative path — it would resolve against the GATEWAY's cwd, not the client's", async () => {
		const r = await resolvePromptAttachments([att({ path: "shot.png" })]);
		assert.equal(r.media.length, 0);
		assert.match(r.rejected[0]?.reason ?? "", /absolute/);
	});

	it("refuses a directory — a stray `@src/` completion must not wedge the turn", async () => {
		const r = await resolvePromptAttachments([att({ path: dir })]);
		assert.equal(r.media.length, 0);
		assert.match(r.rejected[0]?.reason ?? "", /directory/);
	});

	it("refuses a missing file, and says so", async () => {
		const gone = path.join(dir, "gone.png");
		const r = await resolvePromptAttachments([att({ path: gone })]);
		assert.equal(r.media.length, 0);
		assert.equal(r.rejected[0]?.path, gone);
		assert.match(r.rejected[0]?.reason ?? "", /not found/);
	});

	it("refuses an empty file", async () => {
		const empty = path.join(dir, "empty.png");
		fs.writeFileSync(empty, "");
		const r = await resolvePromptAttachments([att({ path: empty })]);
		assert.equal(r.media.length, 0);
		assert.match(r.rejected[0]?.reason ?? "", /empty/);
	});

	it("caps the count, and reports the overflow instead of dropping it silently", async () => {
		const many = Array.from({ length: PROMPT_ATTACHMENT_MAX_COUNT + 3 }, () => att({}));
		const r = await resolvePromptAttachments(many);
		assert.equal(r.media.length, PROMPT_ATTACHMENT_MAX_COUNT);
		assert.equal(r.rejected.length, 3);
		assert.match(r.rejected[0]?.reason ?? "", /limit/);
	});

	it("coerces an unrecognised kind rather than trusting it — kind selects which eager reader runs", async () => {
		const r = await resolvePromptAttachments([
			att({ kind: "totally-bogus" as PromptAttachment["kind"] }),
		]);
		assert.equal(r.media[0]?.kind, "document");
	});

	it("DEMOTES an oversized image to `document` instead of refusing it", async () => {
		// buildInboundImageBlocks reads an image FULLY and only then compares it to its
		// 8 MiB inline cap — so a 500 MB PNG is a 500 MB allocation that gets thrown
		// away. Demoting to `document` means the eager reader skips it and
		// analyze_media (a bounded read) handles it. The file is still attached: you
		// get a tool-mediated answer instead of an inline one, not a rejection.
		const big = path.join(dir, "huge.png");
		fs.writeFileSync(big, Buffer.alloc(33 * 1024 * 1024, 1));
		const r = await resolvePromptAttachments([att({ path: big, fileName: "huge.png" })]);
		assert.equal(r.rejected.length, 0, "must NOT be rejected — it is still attachable");
		assert.equal(r.media[0]?.kind, "document");
	});

	it("DEMOTES an oversized audio file so it is never slurped at an STT provider", async () => {
		// buildMediaNote reads audio with NO size check at all and posts it to the STT
		// provider, whose limit is ~25 MB. A 300 MB WAV would be a 300 MB read plus a
		// doomed upload, with the operator's prompt RPC blocked on it.
		const big = path.join(dir, "long.wav");
		fs.writeFileSync(big, Buffer.alloc(26 * 1024 * 1024, 1));
		const r = await resolvePromptAttachments([
			att({ kind: "audio", path: big, mimeType: "audio/wav", fileName: "long.wav" }),
		]);
		assert.equal(r.rejected.length, 0);
		assert.equal(r.media[0]?.kind, "document");
	});

	it("leaves a normal-sized image and audio file at their true kind", async () => {
		const r = await resolvePromptAttachments([att({})]);
		assert.equal(r.media[0]?.kind, "image");
	});

	it("keeps the good files when one in the batch is bad — a bad drop must not kill the turn", async () => {
		const r = await resolvePromptAttachments([
			att({ path: path.join(dir, "ghost.png") }),
			att({}),
		]);
		assert.equal(r.media.length, 1);
		assert.equal(r.media[0]?.path, png);
		assert.equal(r.rejected.length, 1);
	});
});

/**
 * `composeAttachmentTurn` is the single chokepoint BOTH the `prompt` RPC and the
 * mid-turn model-switch REPLAY go through, so a regression here silently changes
 * how every attached file reaches the model.
 */
describe("composeAttachmentTurn", () => {
	const cfg = {} as BrigadeConfig;

	it("passes a plain text turn through untouched — the historical path must not move", async () => {
		const r = await composeAttachmentTurn("hello", undefined, { config: cfg });
		assert.equal(r.text, "hello");
		assert.equal(r.images, undefined);
		assert.deepEqual(r.rejected, []);
	});

	it("treats an empty attachment array as no attachments", async () => {
		const r = await composeAttachmentTurn("hello", [], { config: cfg });
		assert.equal(r.text, "hello");
		assert.equal(r.images, undefined);
	});

	it("puts the media note FIRST and the operator's text second — the channel pipeline's order", async () => {
		const r = await composeAttachmentTurn("what is wrong here?", [att({})], { config: cfg });
		const lines = r.text.split("\n");
		assert.match(lines[0] ?? "", /^\[attached image/);
		assert.ok((lines[0] ?? "").includes(png), "the note carries the full path for analyze_media");
		assert.equal(lines[1], "what is wrong here?");
	});

	it("inlines the image bytes so a vision model SEES it, rather than only naming the path", async () => {
		const r = await composeAttachmentTurn("look", [att({})], { config: cfg });
		assert.equal(r.images?.length, 1);
		assert.equal(r.images?.[0]?.mimeType, "image/png");
		// Raw base64, no `data:` prefix — the shape Pi's ImageContent wants.
		assert.equal(r.images?.[0]?.data, fs.readFileSync(png).toString("base64"));
	});

	it("does NOT inline a document — Pi's content model is text + image, so a PDF can only come in via a tool", async () => {
		const pdf = path.join(dir, "spec.pdf");
		fs.writeFileSync(pdf, "%PDF-1.4");
		const r = await composeAttachmentTurn("summarize", [att({ kind: "document", path: pdf, mimeType: "application/pdf", fileName: "spec.pdf" })], { config: cfg });
		assert.equal(r.images, undefined);
		// …and the note must TELL the agent to reach for the tool, not just stub the path.
		assert.match(r.text, /analyze_media/);
	});

	it("still sends the text when an attachment is rejected — a bad file must not eat the message", async () => {
		const r = await composeAttachmentTurn("still ask this", [att({ path: path.join(dir, "ghost.png") })], { config: cfg });
		assert.equal(r.text, "still ask this");
		assert.equal(r.rejected.length, 1);
	});

	it("throws when the turn was CARRIED by attachments and every one was refused", async () => {
		// A drop-and-Enter with no words, where the file vanished between staging and
		// send. Prompting the model with an empty string would be worse than an error.
		await assert.rejects(
			() => composeAttachmentTurn("", [att({ path: path.join(dir, "ghost.png") })], { config: cfg }),
			/nothing to send/,
		);
	});

	it("composes a wordless drop into a note-only turn — a valid prompt on its own", async () => {
		const r = await composeAttachmentTurn("", [att({})], { config: cfg });
		assert.match(r.text, /^\[attached image/);
		assert.equal(r.images?.length, 1);
	});
});
