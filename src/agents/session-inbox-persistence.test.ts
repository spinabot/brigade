/**
 * Wave O0.8 GAP 11 — session inbox persists across gateway restarts.
 *
 * Pre-O0.8 the session inbox lived only in an in-memory Map. A gateway
 * restart between child completion and parent next turn lost the
 * announce. This test enqueues an announce, simulates a gateway restart
 * (re-init the inbox module via the test-only reset), and asserts the
 * announce was restored from the JSONL backing file.
 *
 * Tempdir-isolated via BRIGADE_STATE_DIR so the real ~/.brigade is never
 * touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	drainSystemEvents,
	enqueueSystemEvent,
	forceHydrateFromDiskForTests,
	hasSystemEvents,
	resetSessionInboxForTest,
} from "./session-inbox.js";

function setupTempdir(testName: string): {
	dir: string;
	cleanup: () => void;
	prevStateDir: string | undefined;
	prevEnable: string | undefined;
	prevDisable: string | undefined;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `brigade-inbox-${testName}-`));
	const prevStateDir = process.env.BRIGADE_STATE_DIR;
	const prevEnable = process.env.BRIGADE_ENABLE_INBOX_PERSIST;
	const prevDisable = process.env.BRIGADE_DISABLE_INBOX_PERSIST;
	process.env.BRIGADE_STATE_DIR = dir;
	process.env.BRIGADE_ENABLE_INBOX_PERSIST = "1";
	delete process.env.BRIGADE_DISABLE_INBOX_PERSIST;
	return {
		dir,
		prevStateDir,
		prevEnable,
		prevDisable,
		cleanup: () => {
			if (prevStateDir === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prevStateDir;
			if (prevEnable === undefined) delete process.env.BRIGADE_ENABLE_INBOX_PERSIST;
			else process.env.BRIGADE_ENABLE_INBOX_PERSIST = prevEnable;
			if (prevDisable === undefined) delete process.env.BRIGADE_DISABLE_INBOX_PERSIST;
			else process.env.BRIGADE_DISABLE_INBOX_PERSIST = prevDisable;
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort cleanup */
			}
		},
	};
}

test("session inbox JSONL persistence survives a simulated gateway restart", () => {
	const env = setupTempdir("survive");
	try {
		resetSessionInboxForTest();

		const sessionKey = "agent:default:persist-1";
		const ok = enqueueSystemEvent("pre-restart announce: child #42 completed", {
			sessionKey,
			contextKey: "subagent:ended:run-42",
			trusted: true,
		});
		assert.equal(ok, true, "first enqueue accepted");

		// Sanity: file exists on disk.
		const sanitized = sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
		const filePath = path.join(env.dir, "agents", "default", "inbox", `${sanitized}.jsonl`);
		assert.ok(fs.existsSync(filePath), `JSONL file written at ${filePath}`);
		const fileText = fs.readFileSync(filePath, "utf8");
		assert.match(fileText, /pre-restart announce/);

		// Simulate gateway restart — wipe the in-memory Map without
		// touching the disk file.
		resetSessionInboxForTest();
		assert.equal(
			hasSystemEvents(sessionKey),
			true,
			"hasSystemEvents must hydrate from disk and report queue non-empty",
		);

		const drained = drainSystemEvents(sessionKey);
		assert.equal(drained.length, 1, "post-restart drain restores the announce");
		assert.match(drained[0]!, /pre-restart announce: child #42 completed/);

		// After drain, the disk file should be removed too.
		assert.equal(fs.existsSync(filePath), false, "drain truncates the persisted file");
	} finally {
		env.cleanup();
	}
});

test("session inbox cap (20) is honoured on disk and in memory", () => {
	const env = setupTempdir("cap");
	try {
		resetSessionInboxForTest();

		const sessionKey = "agent:default:cap-test";
		for (let i = 0; i < 25; i++) {
			enqueueSystemEvent(`event #${i}`, {
				sessionKey,
				contextKey: `tick:${i}`,
				trusted: true,
			});
		}
		// In-memory drain should yield at most 20 entries (oldest dropped).
		resetSessionInboxForTest();
		forceHydrateFromDiskForTests(sessionKey);
		const drained = drainSystemEvents(sessionKey);
		assert.equal(drained.length, 20, "20-entry cap enforced on disk too");
		// Oldest dropped — first survivor is event #5.
		assert.match(drained[0]!, /event #5/);
		assert.match(drained[19]!, /event #24/);
	} finally {
		env.cleanup();
	}
});

test("session inbox persistence is a no-op when BRIGADE_ENABLE_INBOX_PERSIST is unset", () => {
	const prevState = process.env.BRIGADE_STATE_DIR;
	const prevEnable = process.env.BRIGADE_ENABLE_INBOX_PERSIST;
	const prevDisable = process.env.BRIGADE_DISABLE_INBOX_PERSIST;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-inbox-noop-"));
	process.env.BRIGADE_STATE_DIR = dir;
	delete process.env.BRIGADE_ENABLE_INBOX_PERSIST;
	delete process.env.BRIGADE_DISABLE_INBOX_PERSIST;

	try {
		resetSessionInboxForTest();
		const sessionKey = "agent:default:noop-1";
		enqueueSystemEvent("transient", { sessionKey, trusted: true });
		const inboxDir = path.join(dir, "agents", "default", "inbox");
		assert.equal(
			fs.existsSync(inboxDir),
			false,
			"no JSONL file written when persistence is off",
		);
	} finally {
		if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prevState;
		if (prevEnable === undefined) delete process.env.BRIGADE_ENABLE_INBOX_PERSIST;
		else process.env.BRIGADE_ENABLE_INBOX_PERSIST = prevEnable;
		if (prevDisable === undefined) delete process.env.BRIGADE_DISABLE_INBOX_PERSIST;
		else process.env.BRIGADE_DISABLE_INBOX_PERSIST = prevDisable;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});
