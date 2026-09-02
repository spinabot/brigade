import assert from "node:assert/strict";
import { test } from "node:test";

import { notifyTurnComplete, NOTIFY_MIN_TURN_MS } from "./notify.js";

const sink = () => {
	const out: string[] = [];
	return { out, write: (s: string) => out.push(s) };
};

test("a long turn rings and raises a desktop notification", () => {
	const { out, write } = sink();
	const written = notifyTurnComplete({ durationMs: 90_000, write });
	assert.equal(out.length, 1);
	assert.ok(written.startsWith("\x07"), "BEL first — universal fallback");
	assert.match(written, /\x1b\]9;Brigade — turn finished\x07$/, "well-formed, terminated OSC 9");
});

test("a short turn stays silent — you were still watching", () => {
	const { out } = sink();
	assert.equal(notifyTurnComplete({ durationMs: 2_000, write: sink().write }), "");
	assert.equal(out.length, 0);
});

test("the threshold is the documented default", () => {
	assert.equal(notifyTurnComplete({ durationMs: NOTIFY_MIN_TURN_MS - 1 }, ), "");
});

test("disabled means disabled", () => {
	assert.equal(notifyTurnComplete({ durationMs: 600_000, enabled: false }), "");
});

test("a non-tty gets nothing — escape codes must not land in a pipe or CI log", () => {
	assert.equal(notifyTurnComplete({ durationMs: 600_000, isTty: false }), "");
});

test("a model-authored summary cannot inject or terminate the sequence", () => {
	// The summary can carry model text; a stray BEL or ESC would close the OSC
	// early and dump the remainder onto the screen.
	const written = notifyTurnComplete({
		durationMs: 60_000,
		summary: "done\x07\x1b]0;pwned\x07 and\nmore",
		write: () => {},
	});
	assert.equal(written.indexOf("\x07"), 0, "the only BEL before the terminator is the leading bell");
	assert.equal(written.lastIndexOf("\x07"), written.length - 1, "and the terminator");
	assert.equal(written.includes("\x1b]0;"), false, "no injected sequence survives");
});

test("a very long summary is truncated", () => {
	const written = notifyTurnComplete({ durationMs: 60_000, summary: "x".repeat(500), write: () => {} });
	assert.ok(written.length < 200);
});

test("a broken tty cannot take down the turn", () => {
	assert.doesNotThrow(() =>
		notifyTurnComplete({
			durationMs: 60_000,
			write: () => {
				throw new Error("EPIPE");
			},
		}),
	);
});

test("a non-finite duration is not a notification", () => {
	assert.equal(notifyTurnComplete({ durationMs: Number.NaN, write: () => {} }), "");
});
