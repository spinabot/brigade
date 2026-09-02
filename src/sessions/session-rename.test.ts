import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
	MAX_SESSION_NAME_LENGTH,
	readSessionStore,
	renameSessionEntry,
	sanitizeSessionName,
	upsertSessionEntry,
} from "./session-store.js";

function withTempState(fn: () => void): void {
	const dir = mkdtempSync(path.join(tmpdir(), "brigade-rename-"));
	const prev = process.env.BRIGADE_STATE_DIR;
	process.env.BRIGADE_STATE_DIR = dir;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("sanitizeSessionName: trims, collapses whitespace, caps length", () => {
	assert.equal(sanitizeSessionName("  my   thread  "), "my thread");
	assert.equal(sanitizeSessionName("x".repeat(500))?.length, MAX_SESSION_NAME_LENGTH);
});

test("sanitizeSessionName: strips control characters rather than rejecting", () => {
	// These names are printed into a TUI — a stray \r or escape would corrupt the
	// rendering of every row around it.
	// The escape becomes a SPACE, not nothing — dropping it would fuse the
	// words either side and silently change what the operator typed.
	assert.equal(sanitizeSessionName("a\u001b[31mb"), "a [31mb");
	assert.equal(sanitizeSessionName("line\r\nbreak"), "line break");
});

test("sanitizeSessionName: empty / whitespace-only / non-string clears the name", () => {
	for (const input of ["", "   ", "\n\t", undefined, null, 42, {}]) {
		assert.equal(sanitizeSessionName(input), undefined, `expected clear for ${JSON.stringify(input)}`);
	}
});

test("renameSessionEntry: sets, then clears, the name", () => {
	withTempState(() => {
		upsertSessionEntry("main", "agent:main:main", {});
		assert.equal(renameSessionEntry("main", "agent:main:main", "Release prep")?.name, "Release prep");
		const cleared = renameSessionEntry("main", "agent:main:main", "");
		assert.equal(cleared?.name, undefined);
		assert.ok(!("name" in (readSessionStore("main").sessions["agent:main:main"] ?? {})));
	});
});

test("renameSessionEntry: does NOT bump lastUsedAt", () => {
	withTempState(() => {
		const before = upsertSessionEntry("main", "agent:main:main", {}).lastUsedAt;
		const after = renameSessionEntry("main", "agent:main:main", "Named")?.lastUsedAt;
		// Naming is metadata, not activity. Bumping recency here would jump the row
		// to the top of a recency-sorted history under the operator's cursor.
		assert.equal(after, before);
	});
});

test("renameSessionEntry: unknown session is a clean miss, not a create", () => {
	withTempState(() => {
		assert.equal(renameSessionEntry("main", "agent:main:ghost", "Nope"), null);
		// Must not conjure the entry the way upsert would.
		assert.equal(readSessionStore("main").sessions["agent:main:ghost"], undefined);
	});
});

test("renameSessionEntry: preserves the rest of the entry", () => {
	withTempState(() => {
		upsertSessionEntry("main", "agent:main:main", { provider: "claude-cli", modelId: "claude-opus-5" });
		const renamed = renameSessionEntry("main", "agent:main:main", "Kept");
		assert.equal(renamed?.provider, "claude-cli");
		assert.equal(renamed?.modelId, "claude-opus-5");
	});
});

test("sanitizeSessionName: strips C1 controls and bidi overrides", () => {
	// C1 still carries escape semantics in some terminals, and a bidi override can
	// visually reverse a name so it reads as something else entirely in a list.
	assert.equal(sanitizeSessionName("a\u0085b"), "a b");
	assert.equal(sanitizeSessionName("safe\u202ereversed"), "safe reversed");
	assert.equal(sanitizeSessionName("x\u2066y\u2069z"), "x y z");
});

test("sanitizeSessionName: strips zero-width and invisible marks", () => {
	// None of these are matched by \\s, so without an explicit class an entirely
	// invisible name was stored as non-empty and rendered as nothing.
	for (const invisible of ["\u200b", "\u061c", "\u200e", "\u202e", "\u200c\u200d"]) {
		assert.equal(sanitizeSessionName(invisible), undefined, `stored an invisible name: ${escape(invisible)}`);
	}
});

test("sanitizeSessionName: caps by code point, never splitting a surrogate pair", () => {
	const name = "a".repeat(MAX_SESSION_NAME_LENGTH - 1) + "\u{1F600}";
	const out = sanitizeSessionName(name);
	assert.equal([...(out ?? "")].length, MAX_SESSION_NAME_LENGTH);
	// A UTF-16 slice would leave a lone high surrogate that becomes U+FFFD on any
	// UTF-8 round-trip — sessions.json, or the sealed convex `extra` blob.
	assert.equal(out, Buffer.from(out ?? "", "utf8").toString("utf8"));
	assert.ok(!/[\uD800-\uDBFF]$/.test(out ?? ""), "trailing lone high surrogate");
});

test("renameSessionEntry: prototype-chain keys never mint a phantom entry", () => {
	withTempState(() => {
		upsertSessionEntry("main", "agent:main:main", {});
		for (const key of ["constructor", "toString", "__proto__", "valueOf"]) {
			assert.equal(renameSessionEntry("main", key, "PWNED"), null, `minted an entry for ${key}`);
		}
		const keys = Object.keys(readSessionStore("main").sessions);
		assert.deepEqual(keys, ["agent:main:main"], `phantom entries persisted: ${keys.join(",")}`);
	});
});

test("sanitizeSessionName: ZWJ and ZWNJ are text, not formatting", () => {
	// Stripping them tore "family" into three separate people, split the pride
	// flag into two glyphs, and broke Devanagari conjuncts. Emptiness is decided
	// by visible content instead, so these must round-trip byte-for-byte.
	for (const name of ["\u{1F468}\u200d\u{1F469}\u200d\u{1F467} family", "\u{1F3F3}\uFE0F\u200d\u{1F308} pride", "\u0915\u094d\u200d\u0937 conjunct"]) {
		assert.equal(sanitizeSessionName(name), name, `mangled: ${JSON.stringify(name)}`);
	}
});
