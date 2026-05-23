import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runBackupCreate, runBackupRestore, runBackupVerify } from "./backup.js";

let stateDir: string;
let workDir: string;
let prevStateDir: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "brigade-bk-"));
	stateDir = join(workDir, "state");
	mkdirSync(stateDir, { recursive: true });
	prevStateDir = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = stateDir;
	// Seed some realistic files.
	writeFileSync(join(stateDir, "brigade.json"), JSON.stringify({ version: 2, secret: "abc" }));
	mkdirSync(join(stateDir, "channels", "whatsapp", "auth"), { recursive: true });
	writeFileSync(join(stateDir, "channels", "whatsapp", "auth", "creds.json"), JSON.stringify({ id: "self" }));
	// And one excluded file (should NOT appear in the archive).
	mkdirSync(join(stateDir, "logs"), { recursive: true });
	writeFileSync(join(stateDir, "logs", "today.log"), "noise");
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevStateDir;
	rmSync(workDir, { recursive: true, force: true });
});

describe("brigade backup", () => {
	it("create writes a non-empty .tar.gz, verify passes, restore reproduces files", async () => {
		const archive = join(workDir, "out.tar.gz");
		assert.equal(await runBackupCreate({ output: archive, force: true }, { json: true }), 0);
		assert.ok(existsSync(archive), "archive should exist");
		assert.equal(await runBackupVerify({ archive }, { json: true }), 0);

		// Restore to a fresh target and confirm the seeded files came back.
		const restoreTarget = join(workDir, "restored");
		assert.equal(await runBackupRestore({ archive, target: restoreTarget, force: true }, { json: true }), 0);
		assert.ok(existsSync(join(restoreTarget, "brigade.json")));
		const cfg = JSON.parse(readFileSync(join(restoreTarget, "brigade.json"), "utf8"));
		assert.equal(cfg.secret, "abc");
		assert.ok(existsSync(join(restoreTarget, "channels", "whatsapp", "auth", "creds.json")));
		// `logs/` should have been excluded.
		assert.equal(existsSync(join(restoreTarget, "logs")), false, "logs/ should NOT be in the backup");
	});

	it("verify exits non-zero if the archive was tampered with", async () => {
		const archive = join(workDir, "out.tar.gz");
		await runBackupCreate({ output: archive, force: true }, { json: true });
		// Corrupt the archive — flipping a single byte in the middle is enough.
		const buf = readFileSync(archive);
		const mid = Math.floor(buf.length / 2);
		buf[mid] = (buf[mid] ?? 0) ^ 0xff;
		writeFileSync(archive, buf);
		assert.equal(await runBackupVerify({ archive }, { json: true }), 1);
	});

	it("restore refuses to overwrite an existing target without --force", async () => {
		const archive = join(workDir, "out.tar.gz");
		await runBackupCreate({ output: archive, force: true }, { json: true });
		const t = join(workDir, "exists");
		mkdirSync(t, { recursive: true });
		assert.equal(await runBackupRestore({ archive, target: t }, { json: true }), 1);
	});
});
