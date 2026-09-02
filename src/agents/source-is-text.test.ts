/**
 * No source file may contain a raw control byte.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * `tool-loop-detector.ts` contained a literal NUL (0x00) written into a
 * template string instead of the escape `\x00`. One byte, and it made the file
 * BINARY as far as git and grep are concerned:
 *
 *   • `git diff` renders "Binary files differ" — the file was invisible to
 *     code review, so any change to it shipped unread;
 *   • `grep` and `git grep` skip it silently, returning success and no matches.
 *
 * The second one is the dangerous half. Searching the whole repo for a string
 * that WAS in this file returned nothing, which is indistinguishable from the
 * string not existing — and led to the confident, wrong conclusion that a
 * message an operator was seeing "is not Brigade's code". A file that cannot
 * be searched cannot be reasoned about, and nothing announces it.
 *
 * Escapes are unaffected: `"\x00"` in source is three ASCII characters and
 * produces the same byte at runtime. There is never a reason to embed the raw
 * one.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../", import.meta.url));

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full);
			continue;
		}
		if (entry.endsWith(".ts") || entry.endsWith(".mjs") || entry.endsWith(".js")) yield full;
	}
}

test("no source file contains a raw control byte", () => {
	const offenders: string[] = [];
	for (const file of walk(SRC)) {
		const buf = readFileSync(file);
		for (let i = 0; i < buf.length; i += 1) {
			const b = buf[i]!;
			// Tab (0x09), LF (0x0a) and CR (0x0d) are legitimate; everything else
			// below 0x20 is not, and 0x00 is the one that flips git to binary.
			if (b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x20) continue;
			offenders.push(`${file.slice(SRC.length)} — byte 0x${b.toString(16).padStart(2, "0")} at offset ${i}`);
			break;
		}
	}

	assert.deepEqual(
		offenders,
		[],
		`These files contain raw control bytes:\n\n${offenders.map((o) => `  • ${o}`).join("\n")}\n\n` +
			`A raw control byte — 0x00 especially — makes git treat the file as BINARY.\n` +
			`\`git diff\` then shows "Binary files differ", so changes ship unreviewed, and\n` +
			`\`grep\`/\`git grep\` skip the file SILENTLY: searching for a string that is in it\n` +
			`returns nothing, which looks exactly like the string not existing.\n\n` +
			`Write the escape instead — "\\\\x00" is three ASCII characters and produces the\n` +
			`same byte at runtime.`,
	);
});
