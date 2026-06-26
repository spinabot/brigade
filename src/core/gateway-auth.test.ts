import assert from "node:assert/strict";
import { test } from "node:test";

import {
	TOKEN_HEADER,
	extractToken,
	generateGatewayToken,
	maskToken,
	matchesAnyToken,
	resolveGatewayAuth,
	resolveGatewayTokens,
	tokenMatches,
} from "./gateway-auth.js";

test("tokenMatches: exact match, mismatch, length-mismatch, missing", () => {
	assert.equal(tokenMatches("abc123", "abc123"), true);
	assert.equal(tokenMatches("abc123", "abc124"), false);
	assert.equal(tokenMatches("abc123", "abc1234"), false); // different length never throws
	assert.equal(tokenMatches("abc123", undefined), false);
	assert.equal(tokenMatches("abc123", ""), false);
});

test("matchesAnyToken: any token in the list authenticates", () => {
	const tokens = ["alpha", "bravo", "charlie"];
	assert.equal(matchesAnyToken(tokens, "alpha"), true);
	assert.equal(matchesAnyToken(tokens, "charlie"), true); // last entry still matches (no early break)
	assert.equal(matchesAnyToken(tokens, "delta"), false);
	assert.equal(matchesAnyToken([], "alpha"), false);
	assert.equal(matchesAnyToken(tokens, undefined), false);
});

test("extractToken: Authorization Bearer takes precedence, case-insensitive", () => {
	assert.equal(extractToken(undefined, { authorization: "Bearer tok-A" }), "tok-A");
	assert.equal(extractToken(undefined, { authorization: "bearer tok-B" }), "tok-B");
	assert.equal(extractToken("/?token=q", { authorization: "Bearer tok-A" }), "tok-A"); // header wins over query
});

test("extractToken: x-brigade-token header (string + array forms)", () => {
	assert.equal(extractToken(undefined, { [TOKEN_HEADER]: "tok-C" }), "tok-C");
	assert.equal(extractToken(undefined, { [TOKEN_HEADER]: ["tok-D"] }), "tok-D");
});

test("extractToken: ?token= query string", () => {
	assert.equal(extractToken("/?token=tok-E", {}), "tok-E");
	assert.equal(extractToken("/path?foo=1&token=tok-F", {}), "tok-F");
});

test("extractToken: none present → undefined", () => {
	assert.equal(extractToken("/path", {}), undefined);
	assert.equal(extractToken(undefined, {}), undefined);
	assert.equal(extractToken(undefined, { authorization: "Basic xxx" }), undefined);
});

test("resolveGatewayTokens: merges single token + array + env, dedupes, drops blanks", () => {
	assert.deepEqual(resolveGatewayTokens({ token: "one" }, {}), ["one"]);
	assert.deepEqual(resolveGatewayTokens({ tokens: ["a", "b"] }, {}), ["a", "b"]);
	assert.deepEqual(resolveGatewayTokens({ token: "one", tokens: ["two", "one"] }, {}), ["one", "two"]); // dedupe
	assert.deepEqual(resolveGatewayTokens({ tokens: [" ", "x", ""] }, {}), ["x"]); // blanks dropped
	assert.deepEqual(
		resolveGatewayTokens({ tokens: ["c"] }, { BRIGADE_GATEWAY_TOKENS: "d, e f" }),
		["c", "d", "e", "f"],
	); // env split on comma + whitespace
	assert.deepEqual(resolveGatewayTokens(undefined, {}), []);
});

test("resolveGatewayAuth: OPTIONAL — no tokens → unauthenticated (required:false)", () => {
	// THE core invariant the operator asked us to guarantee: with nothing
	// configured, the gateway stays open exactly as before — never a regression.
	assert.deepEqual(resolveGatewayAuth(undefined, {}), { required: false, tokens: [] });
	assert.deepEqual(resolveGatewayAuth({}, {}), { required: false, tokens: [] });
	assert.deepEqual(resolveGatewayAuth({ mode: "token" }, {}), { required: false, tokens: [] }); // mode set, but no tokens → still open
});

test("resolveGatewayAuth: tokens present → enforced", () => {
	const r = resolveGatewayAuth({ tokens: ["x"] }, {});
	assert.equal(r.required, true);
	assert.deepEqual(r.tokens, ["x"]);
});

test("resolveGatewayAuth: mode:none is an explicit off-switch even with tokens", () => {
	const r = resolveGatewayAuth({ mode: "none", tokens: ["x"] }, {});
	assert.equal(r.required, false);
	assert.deepEqual(r.tokens, ["x"]); // resolved, just not enforced
});

test("resolveGatewayAuth: env-only tokens still enforce", () => {
	const r = resolveGatewayAuth(undefined, { BRIGADE_GATEWAY_TOKENS: "envtok" });
	assert.equal(r.required, true);
	assert.deepEqual(r.tokens, ["envtok"]);
});

test("generateGatewayToken: url-safe, unique, non-trivial entropy", () => {
	const a = generateGatewayToken();
	const b = generateGatewayToken();
	assert.notEqual(a, b);
	assert.ok(a.length >= 30);
	assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url, no padding
});

test("maskToken: short → stars, long → first4…last4", () => {
	assert.equal(maskToken("abcdefghijklmnop"), "abcd…mnop");
	assert.match(maskToken("short"), /^\*+$/);
	assert.equal(maskToken(""), "*");
});
