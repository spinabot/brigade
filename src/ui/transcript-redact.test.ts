/**
 * Redaction is a precondition for having an export at all.
 *
 * An exported transcript is a file one person sends another — attached to a
 * bug report, pasted into a ticket. It is built from tool output: `env`, a
 * `.env` someone read, a curl with an Authorization header, a stack trace
 * carrying a connection string. None of it looked dangerous sitting in a
 * terminal on one machine.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeRedactions, redactForExport } from "./transcript-redact.js";

const red = (s: string, home?: string) =>
	redactForExport(s, home === undefined ? {} : { homeDir: home });

test("provider keys are masked but stay distinguishable", () => {
	// A uniform [REDACTED] makes the export less useful without making it safer:
	// someone debugging "which key did it use" must still tell two keys apart.
	const out = red("using sk-ant-api03-AbCdEfGhIjKlMnOpQrSt for the call").text;
	assert.equal(out.includes("AbCdEfGhIjKlMnOpQrSt"), false, "the secret is gone");
	assert.match(out, /sk-ant-/, "the prefix survives");
	assert.match(out, /redacted/);
});

test("a GitHub token, an AWS key id and a JWT are all caught", () => {
	const out = red(
		[
			"token=ghp_16CharactersMinimumHere",
			"aws AKIAIOSFODNN7EXAMPLE",
			"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
		].join("\n"),
	).text;
	assert.equal(out.includes("16CharactersMinimumHere"), false);
	assert.equal(out.includes("AKIAIOSFODNN7EXAMPLE"), false);
	assert.equal(out.includes("dozjgNryP4J3jVmNHl0w5N"), false);
});

test("an env dump is redacted by NAME, not by value shape", () => {
	// The `env` case: the value can be anything at all, so the only reliable
	// signal is the variable's name.
	const out = red(
		[
			"DATABASE_PASSWORD=hunter2",
			"PASSWORD=bare-form-must-match",
			"MY_SERVICE_TOKEN: abc123def",
			"AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG'",
			"HOME=/Users/someone",
		].join("\n"),
	).text;
	assert.equal(out.includes("hunter2"), false);
	assert.equal(out.includes("bare-form-must-match"), false, "a bare PASSWORD= is the common case");
	assert.equal(out.includes("abc123def"), false);
	assert.equal(out.includes("wJalrXUtnFEMI/K7MDENG"), false);
	// The NAMES stay — an export that hides which variables exist is less
	// useful and no safer.
	assert.match(out, /DATABASE_PASSWORD/);
	assert.match(out, /AWS_SECRET_ACCESS_KEY/);
	// A non-secret variable is untouched.
	assert.match(out, /HOME=/);
});

test("a private key block is removed whole", () => {
	// A partial private key is still a private key.
	const pem =
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nlinetwo\n-----END RSA PRIVATE KEY-----";
	const out = red(`here it is:\n${pem}\ndone`).text;
	assert.equal(out.includes("MIIEowIBAAKCAQEA"), false);
	assert.equal(out.includes("BEGIN RSA PRIVATE KEY"), false);
	assert.match(out, /redacted private key block/);
	assert.match(out, /done/, "surrounding text survives");
});

test("a connection string loses its password and keeps its shape", () => {
	const out = red("postgres://admin:s3cr3tpw@db.internal:5432/app").text;
	assert.equal(out.includes("s3cr3tpw"), false);
	assert.match(out, /postgres:\/\/admin:\[redacted\]@db\.internal:5432\/app/);
});

test("the home directory becomes ~ so a username is not published", () => {
	const out = red("read /Users/alice/dev/x.ts and /Users/alice/.env", "/Users/alice").text;
	assert.equal(out.includes("alice"), false);
	assert.match(out, /~\/dev\/x\.ts/);
});

test("ordinary prose is left completely alone", () => {
	// Over-redaction destroys the artifact's value. A transcript that reads as
	// nonsense is not a safer transcript, it is a useless one.
	const prose =
		"I ran the tests and 6423 passed. The error was in src/core/server.ts near the top.";
	const r = red(prose);
	assert.equal(r.text, prose);
	assert.equal(r.total, 0);
});

test("it reports what it did, so the operator can check behind it", () => {
	// These are pattern matchers; they will miss a secret that looks like prose.
	// Silence would invite trust the mechanism has not earned.
	const r = red("sk-ant-api03-AAAABBBBCCCCDDDD and PASSWORD=zzzz");
	assert.ok(r.total >= 2);
	assert.match(describeRedactions(r.counts), /×/);
	assert.equal(describeRedactions({}), "none matched");
});

test("redaction is idempotent — exporting twice cannot leak", () => {
	const once = red("sk-ant-api03-AAAABBBBCCCCDDDD").text;
	assert.equal(red(once).text, once);
});

test("empty and junk input do not throw", () => {
	assert.equal(red("").text, "");
	assert.equal(red("", "/Users/x").total, 0);
});

test("home-path hits are counted even when an earlier rule LENGTHENED the text", () => {
	// The count used to be inferred from `original.length - redacted.length > 0`.
	// `maskTail` appends "…[redacted N chars]", so a transcript containing both a
	// provider key and a home path came out LONGER — and the home-path hits were
	// silently dropped from the total the operator is shown.
	const r = redactForExport(
		"key sk-ant-api03-AAAABBBBCCCCDDDD and path /Users/alice/dev/x.ts",
		{ homeDir: "/Users/alice" },
	);
	assert.equal(r.counts["home-path"], 1, "the home path was rewritten, so it must be counted");
	assert.ok(r.total >= 2, "and it must reach the operator-facing total");
	assert.equal(r.text.includes("alice"), false);
});

test("multiple home-path occurrences are counted individually", () => {
	const r = redactForExport("/Users/bob/a.ts and /Users/bob/b.ts", { homeDir: "/Users/bob" });
	assert.equal(r.counts["home-path"], 2);
});
