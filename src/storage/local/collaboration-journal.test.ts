import { strict as assert } from "node:assert";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	LocalCollaborationJournal,
} from "./collaboration-journal.js";

const roots: string[] = [];

async function makeJournal(): Promise<{
	root: string;
	journal: LocalCollaborationJournal<{ value: number }>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-collaboration-journal-"));
	roots.push(root);
	const journal = new LocalCollaborationJournal<{ value: number }>(root);
	await journal.init();
	return { root, journal };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("LocalCollaborationJournal", () => {
	it("persists a hash-chained history across instances", async () => {
		const { root, journal } = await makeJournal();
		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		await journal.transact(() => ({ payload: { value: 2 }, result: undefined }));
		await journal.close();

		const reopened = new LocalCollaborationJournal<{ value: number }>(root);
		await reopened.init();
		const entries = await reopened.readAll();
		assert.deepEqual(entries.map((entry) => entry.payload.value), [1, 2]);
		assert.deepEqual(entries.map((entry) => entry.seq), [1, 2]);
		assert.equal(entries[1]?.prevHash, entries[0]?.hash);
		await reopened.close();
	});

	it("serializes concurrent writers from separate adapter instances", async () => {
		const { root, journal: left } = await makeJournal();
		const right = new LocalCollaborationJournal<{ value: number }>(root);
		await right.init();

		await Promise.all(
			Array.from({ length: 20 }, (_, value) =>
				(value % 2 === 0 ? left : right).transact(() => ({
					payload: { value },
					result: undefined,
				})),
			),
		);
		const entries = await left.readAll();
		assert.equal(entries.length, 20);
		assert.deepEqual(entries.map((entry) => entry.seq), Array.from({ length: 20 }, (_, i) => i + 1));
		assert.equal(new Set(entries.map((entry) => entry.payload.value)).size, 20);
		await left.close();
		await right.close();
	});

	it("serializes concurrent stale-lock recovery before admitting writers", async () => {
		const { root, journal: first } = await makeJournal();
		const journals = [first];
		for (let index = 0; index < 7; index += 1) {
			const journal = new LocalCollaborationJournal<{ value: number }>(root);
			await journal.init();
			journals.push(journal);
		}
		await fs.writeFile(
			first.lockPath,
			JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, acquiredAt: 0, nonce: "dead" }),
			{ mode: 0o600 },
		);

		await Promise.all(
			journals.map((journal, value) =>
				journal.transact(() => ({ payload: { value }, result: undefined })),
			),
		);
		const entries = await first.readAll();
		assert.equal(entries.length, journals.length);
		assert.deepEqual(
			entries.map((entry) => entry.seq),
			Array.from({ length: journals.length }, (_, index) => index + 1),
		);
		await assert.rejects(() => fs.stat(`${first.lockPath}.reaper`), { code: "ENOENT" });
		await Promise.all(journals.map((journal) => journal.close()));
	});

	it("recovers a stale journal lock even when its prior reaper also crashed", async () => {
		const { journal } = await makeJournal();
		await fs.writeFile(
			journal.lockPath,
			JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, acquiredAt: 0, nonce: "dead-lock" }),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			`${journal.lockPath}.reaper`,
			JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, acquiredAt: 0, nonce: "dead-reaper" }),
			{ mode: 0o600 },
		);

		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		assert.deepEqual((await journal.readAll()).map((entry) => entry.payload.value), [1]);
		await assert.rejects(() => fs.stat(journal.lockPath), { code: "ENOENT" });
		await assert.rejects(() => fs.stat(`${journal.lockPath}.reaper`), { code: "ENOENT" });
		await journal.close();
	});

	it("repairs only an unterminated final record and preserves it for forensics", async () => {
		const { journal } = await makeJournal();
		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		await fs.appendFile(journal.journalPath, '{"version":1,"seq":2');

		const entries = await journal.readAll();
		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.payload.value, 1);
		assert.match(await fs.readFile(journal.journalPath, "utf8"), /\n$/);
		const forensic = (await fs.readdir(journal.rootDir)).filter((name) => name.startsWith("journal.torn-"));
		assert.equal(forensic.length, 1);
		assert.equal(
			await fs.readFile(path.join(journal.rootDir, forensic[0] as string), "utf8"),
			'{"version":1,"seq":2',
		);
		await journal.close();
	});

	it("leaves the journal usable after a torn-tail repair, and repairs it once", async () => {
		const { journal } = await makeJournal();
		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		await fs.appendFile(journal.journalPath, '{"version":1,"seq":2');

		assert.deepEqual((await journal.readAll()).map((entry) => entry.payload.value), [1]);

		// A repair has to leave an APPENDABLE journal, not merely a truncated file.
		// A repair step that throws or re-runs would either fail the read outright or
		// drop another forensic copy on every subsequent read; both are invisible to
		// a test that only looks at the entries that came back.
		const forensic = async () =>
			(await fs.readdir(journal.rootDir)).filter((name) => name.startsWith("journal.torn-"));
		assert.equal((await forensic()).length, 1, "one forensic copy of the torn tail");
		await journal.readAll();
		assert.equal((await forensic()).length, 1, "a second read is not a second repair");

		// …and the next committed write continues the chain from the repaired tail.
		await journal.transact(() => ({ payload: { value: 3 }, result: undefined }));
		assert.deepEqual((await journal.readAll()).map((entry) => entry.payload.value), [1, 3]);
		await journal.close();
	});

	it("fails closed for a malformed committed final record", async () => {
		const { journal } = await makeJournal();
		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		await fs.appendFile(journal.journalPath, "{bad json}\n");

		await assert.rejects(
			() => journal.readAll(),
			/collaboration journal contains invalid committed JSON at line 2/,
		);
		assert.match(await fs.readFile(journal.journalPath, "utf8"), /\{bad json\}\n$/);
		await assert.doesNotReject(() => journal.close());
	});

	it("fails closed when a committed payload no longer matches its checksum", async () => {
		const { journal } = await makeJournal();
		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		const body = await fs.readFile(journal.journalPath, "utf8");
		await fs.writeFile(journal.journalPath, body.replace('"value":1', '"value":9'));

		await assert.rejects(
			() => journal.readAll(),
			/collaboration journal checksum mismatch at line 1/,
		);
		await assert.doesNotReject(() => journal.close());
	});

	it("rejects lossy non-JSON values before writing a transaction", async () => {
		const { journal } = await makeJournal();
		await assert.rejects(
			() => journal.transact(() => ({ payload: { value: Number.NaN }, result: undefined })),
			/collaboration journal values must contain finite numbers/,
		);
		assert.deepEqual(await journal.readAll(), []);
		await journal.close();
	});

	it("uses owner-only filesystem permissions", async () => {
		const { journal } = await makeJournal();
		await journal.transact(() => ({ payload: { value: 1 }, result: undefined }));
		if (process.platform !== "win32") {
			assert.equal(fsSync.statSync(journal.rootDir).mode & 0o777, 0o700);
			assert.equal(fsSync.statSync(journal.journalPath).mode & 0o777, 0o600);
		}
		await journal.close();
	});
});
