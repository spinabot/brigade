/**
 * Tests for the webhook + RPC guards.
 *
 * We exercise the three exported helpers against synthetic IncomingMessage /
 * ServerResponse streams. Real `http.createServer()` is overkill here — the
 * helpers only touch the events listed in the IncomingMessage contract, so a
 * minimal EventEmitter + a mock response that captures status+body is enough.
 */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";

import {
	computeHmacSha256,
	DEFAULT_MAX_BODY_BYTES,
	DEFAULT_TIMEOUT_MS,
	readBodyWithLimit,
	safeEqualHmac,
	verifyTimestampFresh,
	verifyWebhookSignature,
	WebhookReplayGuard,
} from "./webhook-guards.js";

// Sanity: defaults match the documented values so an accidental edit downstream
// shows up in CI rather than silently changing the contract.
describe("webhook-guards defaults", () => {
	it("DEFAULT_MAX_BODY_BYTES is 1 MiB", () => {
		assert.equal(DEFAULT_MAX_BODY_BYTES, 1_048_576);
	});
	it("DEFAULT_TIMEOUT_MS is 30s", () => {
		assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
	});
});

/* ────────────────── mock req / res helpers ────────────────── */

interface MockResponseState {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	ended: boolean;
	headersSent: boolean;
	writableEnded: boolean;
}

/**
 * Build an EventEmitter that quacks like an IncomingMessage well enough for
 * `readBodyWithLimit` to drive. Tests push chunks + end / error / aborted
 * through the returned `push()` / `end()` / `error()` / `abort()` controls.
 */
function makeMockReq(): {
	req: IncomingMessage;
	push: (chunk: Buffer | string) => void;
	end: () => void;
	error: (err: Error) => void;
	abort: () => void;
} {
	const emitter = new EventEmitter();
	(emitter as unknown as { pause: () => void }).pause = () => {};
	return {
		req: emitter as unknown as IncomingMessage,
		push: (chunk) => emitter.emit("data", chunk),
		end: () => emitter.emit("end"),
		error: (err) => emitter.emit("error", err),
		abort: () => emitter.emit("aborted"),
	};
}

/** Capture status / headers / body off a fake ServerResponse. */
function makeMockRes(): { res: ServerResponse; state: MockResponseState } {
	const state: MockResponseState = {
		statusCode: 200,
		headers: {},
		body: "",
		ended: false,
		headersSent: false,
		writableEnded: false,
	};
	const fake = {
		get statusCode(): number {
			return state.statusCode;
		},
		set statusCode(v: number) {
			state.statusCode = v;
		},
		get headersSent(): boolean {
			return state.headersSent;
		},
		get writableEnded(): boolean {
			return state.writableEnded;
		},
		setHeader(name: string, value: string): void {
			state.headers[name.toLowerCase()] = value;
		},
		end(payload?: string | Buffer): void {
			if (payload !== undefined) {
				state.body += typeof payload === "string" ? payload : payload.toString("utf-8");
			}
			state.headersSent = true;
			state.writableEnded = true;
			state.ended = true;
		},
	};
	return { res: fake as unknown as ServerResponse, state };
}

/* ────────────────── readBodyWithLimit ────────────────── */

describe("readBodyWithLimit", () => {
	it("returns the Buffer when the body fits the cap", async () => {
		const { req, push, end } = makeMockReq();
		const { res, state } = makeMockRes();
		const payload = Buffer.alloc(200, "x");
		const p = readBodyWithLimit(req, res, { maxBytes: 1024, timeoutMs: 1000 });
		push(payload);
		end();
		const out = await p;
		assert.ok(out, "expected a Buffer");
		assert.equal(out!.length, 200);
		assert.equal(out!.toString("utf-8"), "x".repeat(200));
		// No status was written — the body fit, so the handler is in charge.
		assert.equal(state.ended, false);
	});

	it("returns null + writes 413 when the body exceeds the cap", async () => {
		const { req, push } = makeMockReq();
		const { res, state } = makeMockRes();
		const p = readBodyWithLimit(req, res, { maxBytes: 1024, timeoutMs: 1000 });
		// Push 2 KB in one chunk — the running total trips the cap immediately.
		push(Buffer.alloc(2048, "y"));
		const out = await p;
		assert.equal(out, null);
		assert.equal(state.statusCode, 413);
		assert.equal(state.headers["content-type"], "application/json; charset=utf-8");
		assert.match(state.body, /Payload too large/);
		assert.match(state.body, /1024/);
	});

	it("returns null + writes 408 when the read exceeds the timeout", async () => {
		const { req } = makeMockReq();
		const { res, state } = makeMockRes();
		// Tight timeout; no chunks pushed → fires the timer.
		const p = readBodyWithLimit(req, res, { maxBytes: 1024, timeoutMs: 50 });
		const out = await p;
		assert.equal(out, null);
		assert.equal(state.statusCode, 408);
		assert.match(state.body, /Request timeout/);
		assert.match(state.body, /50ms/);
	});

	it("returns null + writes 400 when the request emits an error", async () => {
		const { req, error } = makeMockReq();
		const { res, state } = makeMockRes();
		const p = readBodyWithLimit(req, res, { maxBytes: 1024, timeoutMs: 1000 });
		error(new Error("socket reset"));
		const out = await p;
		assert.equal(out, null);
		assert.equal(state.statusCode, 400);
		assert.match(state.body, /Bad request body/);
	});

	it("returns null without responding when the client aborts the request", async () => {
		const { req, abort } = makeMockReq();
		const { res, state } = makeMockRes();
		const p = readBodyWithLimit(req, res, { maxBytes: 1024, timeoutMs: 1000 });
		abort();
		const out = await p;
		assert.equal(out, null);
		// Client hung up — we don't write a status, nothing to send it to.
		assert.equal(state.ended, false);
	});

	it("uses the documented defaults when opts is omitted", async () => {
		const { req, push, end } = makeMockReq();
		const { res, state } = makeMockRes();
		const p = readBodyWithLimit(req, res);
		push(Buffer.from("ok"));
		end();
		const out = await p;
		assert.ok(out);
		assert.equal(out!.toString("utf-8"), "ok");
		assert.equal(state.ended, false);
	});

	it("concatenates multi-chunk bodies in order", async () => {
		const { req, push, end } = makeMockReq();
		const { res } = makeMockRes();
		const p = readBodyWithLimit(req, res, { maxBytes: 1024, timeoutMs: 1000 });
		push(Buffer.from("hello "));
		push(Buffer.from("world"));
		end();
		const out = await p;
		assert.equal(out!.toString("utf-8"), "hello world");
	});
});

/* ────────────────── computeHmacSha256 ────────────────── */

describe("computeHmacSha256", () => {
	// RFC 4231 test vector #1: key="key", data="The quick brown fox jumps over
	// the lazy dog" → known hex digest. Used as a stable cross-implementation
	// check so a Node crypto regression would show up here.
	it("matches the known SHA-256 test vector", () => {
		const got = computeHmacSha256(
			Buffer.from("The quick brown fox jumps over the lazy dog"),
			"key",
		);
		assert.equal(got, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
	});

	it("accepts a string body and matches the buffer path", () => {
		const text = "hello";
		const fromString = computeHmacSha256(text, "secret");
		const fromBuffer = computeHmacSha256(Buffer.from(text), "secret");
		assert.equal(fromString, fromBuffer);
	});

	it("returns hex (lowercase, 64 chars for SHA-256)", () => {
		const got = computeHmacSha256("payload", "s");
		assert.match(got, /^[0-9a-f]{64}$/);
	});
});

/* ────────────────── safeEqualHmac ────────────────── */

describe("safeEqualHmac", () => {
	it("returns true for equal strings", () => {
		assert.equal(safeEqualHmac("abc", "abc"), true);
		assert.equal(safeEqualHmac("", ""), true);
		const sig = computeHmacSha256("body", "key");
		assert.equal(safeEqualHmac(sig, sig), true);
	});

	it("returns false for unequal same-length strings", () => {
		assert.equal(safeEqualHmac("abc", "abd"), false);
		assert.equal(
			safeEqualHmac(
				"0".repeat(64),
				`${"0".repeat(63)}1`,
			),
			false,
		);
	});

	it("returns false for different-length strings WITHOUT throwing", () => {
		// Naive timingSafeEqual throws on length mismatch; safeEqualHmac must not.
		assert.equal(safeEqualHmac("abc", "abcd"), false);
		assert.equal(safeEqualHmac("", "x"), false);
	});

	it("agrees with computeHmacSha256 for the canonical webhook flow", () => {
		const body = Buffer.from('{"event":"ping"}');
		const secret = "shared-secret";
		const expected = computeHmacSha256(body, secret);
		// Provider sends the same digest in a header — must match.
		assert.equal(safeEqualHmac(expected, expected), true);
		// One bit flipped — must NOT match.
		const tampered = `${expected.slice(0, -1)}${expected.endsWith("0") ? "1" : "0"}`;
		assert.equal(safeEqualHmac(expected, tampered), false);
	});
});

/* ────────────────── verifyTimestampFresh ────────────────── */

describe("verifyTimestampFresh", () => {
	const now = 1_700_000_000_000;
	it("accepts a timestamp within the window (past or small future skew)", () => {
		assert.equal(verifyTimestampFresh(now - 60_000, { nowMs: now }), true);
		assert.equal(verifyTimestampFresh(now + 60_000, { nowMs: now }), true);
	});
	it("rejects a stale timestamp outside the window", () => {
		assert.equal(verifyTimestampFresh(now - 600_000, { nowMs: now }), false);
	});
	it("rejects a non-finite timestamp", () => {
		assert.equal(verifyTimestampFresh(Number.NaN, { nowMs: now }), false);
	});
	it("honors a custom window", () => {
		assert.equal(verifyTimestampFresh(now - 90_000, { nowMs: now, windowMs: 120_000 }), true);
		assert.equal(verifyTimestampFresh(now - 90_000, { nowMs: now, windowMs: 30_000 }), false);
	});
});

/* ────────────────── WebhookReplayGuard ────────────────── */

describe("WebhookReplayGuard", () => {
	it("treats first sight as fresh and a repeat as a replay", () => {
		const g = new WebhookReplayGuard();
		assert.equal(g.check("delivery-1", 1000), false);
		assert.equal(g.check("delivery-1", 2000), true);
		assert.equal(g.check("delivery-2", 2000), false);
	});
	it("re-accepts an id once its TTL has elapsed", () => {
		const g = new WebhookReplayGuard({ ttlMs: 10_000 });
		assert.equal(g.check("d", 0), false);
		assert.equal(g.check("d", 5_000), true); // within TTL
		assert.equal(g.check("d", 20_000), false); // TTL elapsed
	});
	it("never treats an empty id as a replay (caller falls back to timestamp)", () => {
		const g = new WebhookReplayGuard();
		assert.equal(g.check("", 1000), false);
		assert.equal(g.check("", 2000), false);
	});
	it("bounds memory with oldest-first eviction", () => {
		const g = new WebhookReplayGuard({ maxEntries: 3 });
		for (let i = 0; i < 10; i++) g.check(`id-${i}`, i);
		assert.ok(g.size <= 3, `size capped (got ${g.size})`);
		assert.equal(g.check("id-0", 100), false); // oldest was evicted → fresh again
	});
});

/* ────────────────── verifyWebhookSignature ────────────────── */

describe("verifyWebhookSignature", () => {
	const secret = "shhh-very-secret";
	const rawBody = Buffer.from(JSON.stringify({ event: "push", n: 1 }));

	it("github: accepts a valid sha256= signature, rejects a tampered body", () => {
		const sig = `sha256=${computeHmacSha256(rawBody, secret)}`;
		assert.equal(verifyWebhookSignature("github", { headers: { "x-hub-signature-256": sig }, rawBody, secret }).ok, true);
		const tampered = Buffer.from(JSON.stringify({ event: "push", n: 999 }));
		assert.equal(
			verifyWebhookSignature("github", { headers: { "x-hub-signature-256": sig }, rawBody: tampered, secret }).ok,
			false,
		);
	});
	it("github: fails closed on missing header or blank secret", () => {
		assert.equal(verifyWebhookSignature("github", { headers: {}, rawBody, secret }).ok, false);
		const sig = `sha256=${computeHmacSha256(rawBody, secret)}`;
		assert.equal(verifyWebhookSignature("github", { headers: { "x-hub-signature-256": sig }, rawBody, secret: "" }).ok, false);
	});
	it("header lookup is case-insensitive", () => {
		const sig = `sha256=${computeHmacSha256(rawBody, secret)}`;
		assert.equal(verifyWebhookSignature("github", { headers: { "X-Hub-Signature-256": sig }, rawBody, secret }).ok, true);
	});
	it("gitlab: matches the shared token, rejects a wrong one", () => {
		assert.equal(verifyWebhookSignature("gitlab", { headers: { "x-gitlab-token": secret }, rawBody, secret }).ok, true);
		assert.equal(verifyWebhookSignature("gitlab", { headers: { "x-gitlab-token": "wrong" }, rawBody, secret }).ok, false);
	});
	it("slack: verifies v0 over v0:ts:body AND enforces timestamp freshness", () => {
		const now = 1_700_000_000_000;
		const ts = String(Math.floor(now / 1000));
		const body = rawBody.toString("utf8");
		const sig = `v0=${computeHmacSha256(`v0:${ts}:${body}`, secret)}`;
		assert.equal(
			verifyWebhookSignature("slack", { headers: { "x-slack-signature": sig, "x-slack-request-timestamp": ts }, rawBody, secret, nowMs: now }).ok,
			true,
		);
		const staleTs = String(Math.floor((now - 600_000) / 1000));
		const staleSig = `v0=${computeHmacSha256(`v0:${staleTs}:${body}`, secret)}`;
		assert.equal(
			verifyWebhookSignature("slack", { headers: { "x-slack-signature": staleSig, "x-slack-request-timestamp": staleTs }, rawBody, secret, nowMs: now }).ok,
			false,
		);
	});
	it("hmac-sha256: accepts bare hex and sha256=-prefixed forms", () => {
		const hex = computeHmacSha256(rawBody, secret);
		assert.equal(verifyWebhookSignature("hmac-sha256", { headers: { "x-webhook-signature": hex }, rawBody, secret }).ok, true);
		assert.equal(verifyWebhookSignature("hmac-sha256", { headers: { "x-webhook-signature": `sha256=${hex}` }, rawBody, secret }).ok, true);
	});
});
