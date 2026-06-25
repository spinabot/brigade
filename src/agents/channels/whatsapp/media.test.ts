/**
 * Tests for WhatsApp inbound media saving — specifically that an inbound
 * DOCUMENT is saved with a real, detectable file extension.
 *
 * WhatsApp document messages default their `mimetype` to
 * `application/octet-stream`, so deriving the on-disk extension from the MIME
 * alone saves a `report.csv` as `.octetstream` (and any unmapped type as
 * garbage), which then makes `analyze_media` fail to detect a readable file.
 * The save path must prefer the document's real `fileName` extension.
 */

import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import type { WAMessage } from "@whiskeysockets/baileys";

import {
	downloadInboundMedia,
	extFromFileName,
	extFromMime,
	savedExt,
} from "./media.js";

describe("whatsapp extFromMime", () => {
	it("maps office MIME types to friendly extensions", () => {
		assert.equal(
			extFromMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
			"xlsx",
		);
		assert.equal(extFromMime("image/jpeg"), "jpg");
	});

	it("falls back to bin for application/octet-stream", () => {
		// The generic document MIME has no useful subtype → this is exactly why we
		// must derive from the filename instead.
		assert.equal(extFromMime("application/octet-stream"), "octetstream");
		assert.equal(extFromMime(undefined), "bin");
	});
});

describe("whatsapp extFromFileName", () => {
	it("pulls a clean lowercase extension from a real filename", () => {
		assert.equal(extFromFileName("data.csv"), "csv");
		assert.equal(extFromFileName("Report.ODT"), "odt");
		assert.equal(extFromFileName("notebook.ipynb"), "ipynb");
	});

	it("returns empty when there is no usable extension", () => {
		assert.equal(extFromFileName("noextension"), "");
		assert.equal(extFromFileName("trailingdot."), "");
		assert.equal(extFromFileName(undefined), "");
		assert.equal(extFromFileName(""), "");
	});
});

describe("whatsapp savedExt", () => {
	it("prefers the filename extension over the MIME map", () => {
		// octet-stream + a real .csv filename → .csv (the keystone case).
		assert.equal(savedExt("application/octet-stream", "data.csv"), "csv");
		// .odt is unmapped by the MIME table, so the filename is the only signal.
		assert.equal(savedExt("application/octet-stream", "report.odt"), "odt");
	});

	it("keeps the MIME-derived extension when there is no filename", () => {
		assert.equal(savedExt("image/jpeg", undefined), "jpg");
		assert.equal(savedExt("audio/ogg", undefined), "ogg");
	});

	it("an xlsx document keeps .xlsx via the filename", () => {
		assert.equal(
			savedExt("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "q3.xlsx"),
			"xlsx",
		);
	});
});

/** Build a normalized WA message envelope carrying a document with `fileName`. */
function docMessage(fileName: string, mimetype = "application/octet-stream"): WAMessage["message"] {
	return {
		documentMessage: { mimetype, fileName, caption: "see attached" },
	} as unknown as WAMessage["message"];
}

describe("downloadInboundMedia — document saved extension", () => {
	const bytes = Buffer.from("a,b,c\n1,2,3\n");

	it("saves an octet-stream CSV with a .csv extension (so analyze_media detects it)", async () => {
		const out = await downloadInboundMedia({
			content: docMessage("data.csv"),
			msgId: "MSGCSV",
			downloadMediaMessage: async () => bytes,
			rawMessage: {} as WAMessage,
			log: () => {},
		});
		assert.equal(out.length, 1);
		const att = out[0]!;
		assert.equal(path.extname(att.path).toLowerCase(), ".csv");
		assert.equal(att.fileName, "data.csv");
		assert.equal(att.kind, "document");
	});

	it("saves report.odt with a .odt extension", async () => {
		const out = await downloadInboundMedia({
			content: docMessage("report.odt"),
			msgId: "MSGODT",
			downloadMediaMessage: async () => bytes,
			rawMessage: {} as WAMessage,
			log: () => {},
		});
		assert.equal(out.length, 1);
		assert.equal(path.extname(out[0]!.path).toLowerCase(), ".odt");
	});

	it("keeps a real xlsx MIME as .xlsx", async () => {
		const out = await downloadInboundMedia({
			content: docMessage(
				"q3.xlsx",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			),
			msgId: "MSGXLSX",
			downloadMediaMessage: async () => bytes,
			rawMessage: {} as WAMessage,
			log: () => {},
		});
		assert.equal(out.length, 1);
		assert.equal(path.extname(out[0]!.path).toLowerCase(), ".xlsx");
	});
});
