/**
 * The clipboard backend is the one place in the product that shells out to an OS
 * tool on a hot path, so its CONTRACT matters more than its implementation:
 *
 *   • it must never throw — a locked clipboard or a missing tool is a lost
 *     convenience, never a lost turn;
 *   • `hasImage()` must be a CHEAP probe, distinct from `saveImage()` — asking
 *     "is there an image?" must not decode a 4K bitmap to find out there isn't;
 *   • `watch()` must return null rather than fake a watch with an expensive poll,
 *     because a silently-expensive feature is worse than an absent one;
 *   • and a watcher must never keep the process alive (it hung the suite once).
 *
 * The per-OS mechanics are exercised live against the real clipboard in
 * development; what is pinned here is the contract every backend must honour.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { clipboardBackend, clipboardSpoolDir } from "./clipboard.js";

// The spool dir is this PROCESS's own (mkdtemp'd on first use), so the suite must
// take it with it — nothing else sweeps it for another 24 hours.
after(() => {
	fs.rmSync(clipboardSpoolDir(), { recursive: true, force: true });
});

describe("clipboardBackend — contract", () => {
	it("returns a backend on every platform, never null", () => {
		const b = clipboardBackend();
		assert.ok(b, "an unsupported OS must still get a backend that politely says no");
		for (const m of ["hasImage", "saveImage", "readFiles", "readText", "describe", "watch"]) {
			assert.equal(typeof (b as unknown as Record<string, unknown>)[m], "function", m);
		}
	});

	it("hasImage() resolves to a boolean and never throws, whatever is on the clipboard", async () => {
		const v = await clipboardBackend().hasImage();
		assert.equal(typeof v, "boolean");
	});

	it("readText() resolves to a string and never throws", async () => {
		assert.equal(typeof (await clipboardBackend().readText()), "string");
	});

	it("readFiles() resolves to an array and never throws", async () => {
		assert.ok(Array.isArray(await clipboardBackend().readFiles()));
	});

	it("describe() always produces something an operator can act on", async () => {
		// "nothing to attach" states the outcome and hides the cause. Whatever the
		// clipboard holds, this must come back non-empty.
		const d = await clipboardBackend().describe();
		assert.equal(typeof d, "string");
		assert.ok(d.length > 0);
	});

	it("saveImage() to an unwritable path returns false rather than throwing", async () => {
		const impossible = path.join(clipboardSpoolDir(), "no-such-dir", "x.png");
		const ok = await clipboardBackend().saveImage(impossible);
		assert.equal(ok, false);
	});
});

describe("clipboardSpoolDir", () => {
	it("creates the dir and sits under the OS temp — never ~/.brigade", () => {
		// Convex mode's strict-zero guard requires ~/.brigade to stay clean, so a
		// clipboard bitmap must never be materialised there.
		const dir = clipboardSpoolDir();
		assert.ok(fs.existsSync(dir));
		assert.ok(
			!dir.includes(".brigade"),
			"spooling into ~/.brigade would trip the convex strict-zero guard",
		);
	});

	it("is a private, unguessable dir — a screenshot is not for the rest of the box", () => {
		const dir = clipboardSpoolDir();
		assert.notEqual(path.basename(dir), "brigade-attachments", "a fixed name can be pre-claimed");
		// Windows has no POSIX mode bits to assert on.
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		}
	});

	it("hands back the same dir every call — a spooled path must stay valid", () => {
		assert.equal(clipboardSpoolDir(), clipboardSpoolDir());
	});

	it("sweeps files older than the TTL, so pasted screenshots don't accumulate forever", () => {
		const dir = clipboardSpoolDir();
		// Unique per run: the suite may run several processes at once, and a shared
		// name would have them sweeping each other's probe.
		const stale = path.join(dir, `clipboard-stale-${randomUUID()}.png`);
		try {
			fs.writeFileSync(stale, "x");
			// Backdate it two days.
			const old = Date.now() - 48 * 60 * 60 * 1000;
			fs.utimesSync(stale, new Date(old), new Date(old));
			clipboardSpoolDir(); // sweeps on the way in
			assert.equal(fs.existsSync(stale), false, "a stale spool file must be swept");
		} finally {
			fs.rmSync(stale, { force: true });
		}
	});

	it("leaves a FRESH spool file alone — the one we just wrote must survive", () => {
		const dir = clipboardSpoolDir();
		const fresh = path.join(dir, `clipboard-fresh-${randomUUID()}.png`);
		try {
			fs.writeFileSync(fresh, "x");
			clipboardSpoolDir();
			assert.equal(fs.existsSync(fresh), true);
		} finally {
			fs.rmSync(fresh, { force: true });
		}
	});
});
