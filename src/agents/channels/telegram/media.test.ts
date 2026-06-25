import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { downloadTelegramMedia, withMediaRetry } from "./media.js";

/** A stubbed grammY file API returning a fixed `file_path` / `file_unique_id`. */
function botStub(filePath: string | undefined, uid = "uid1") {
	return {
		getFile: async () => ({ file_path: filePath, file_unique_id: uid }),
	};
}

/** A fetch stub that returns `bytes` for any url (the file-download leg). */
function fetchStub(bytes: Buffer): typeof fetch {
	return (async () =>
		new Response(bytes, { status: 200 })) as unknown as typeof fetch;
}

describe("withMediaRetry", () => {
	it("returns the first successful result without retrying", async () => {
		let calls = 0;
		const out = await withMediaRetry(async () => {
			calls += 1;
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 1);
	});

	it("retries a transient failure and then succeeds", async () => {
		let calls = 0;
		const out = await withMediaRetry(async () => {
			calls += 1;
			if (calls < 3) throw new Error("transient");
			return "ok";
		});
		assert.equal(out, "ok");
		assert.equal(calls, 3);
	});

	it("throws the last error after exhausting attempts (default 3)", async () => {
		let calls = 0;
		await assert.rejects(
			withMediaRetry(async () => {
				calls += 1;
				throw new Error(`fail-${calls}`);
			}),
			/fail-3/,
		);
		assert.equal(calls, 3);
	});

	it("honors a custom attempt count", async () => {
		let calls = 0;
		await assert.rejects(
			withMediaRetry(async () => {
				calls += 1;
				throw new Error("nope");
			}, 1),
		);
		assert.equal(calls, 1);
	});
});

describe("downloadTelegramMedia — saved extension keeps the document type", () => {
	const bytes = Buffer.from("col1,col2\n1,2\n");

	it("uses the Telegram file_path extension when present", async () => {
		const att = await downloadTelegramMedia({
			bot: botStub("documents/file_42.csv"),
			fileId: "f1",
			kind: "document",
			token: "T",
			fileName: "data.csv",
			fetchImpl: fetchStub(bytes),
		});
		assert.ok(att, "attachment resolved");
		assert.equal(path.extname(att!.path).toLowerCase(), ".csv");
		assert.deepEqual(readFileSync(att!.path), bytes);
	});

	it("falls back to the original fileName extension when file_path is extensionless", async () => {
		// A document whose Telegram file_path carries NO extension — the real
		// fileName (.csv) must drive the saved extension instead of the `.bin` default.
		const att = await downloadTelegramMedia({
			bot: botStub("documents/file_42"),
			fileId: "f2",
			kind: "document",
			token: "T",
			fileName: "quarterly.csv",
			fetchImpl: fetchStub(bytes),
		});
		assert.ok(att, "attachment resolved");
		assert.equal(path.extname(att!.path).toLowerCase(), ".csv");
	});

	it("keeps an xlsx document as .xlsx via the file_path", async () => {
		const att = await downloadTelegramMedia({
			bot: botStub("documents/file_7.xlsx"),
			fileId: "f3",
			kind: "document",
			token: "T",
			fileName: "q3.xlsx",
			fetchImpl: fetchStub(bytes),
		});
		assert.ok(att);
		assert.equal(path.extname(att!.path).toLowerCase(), ".xlsx");
	});
});
