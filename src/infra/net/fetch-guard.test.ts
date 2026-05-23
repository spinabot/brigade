/**
 * Tests for the SSRF guard's hostname classifier. The full `guardedFetch`
 * path is tested via mocked `global.fetch` only when the URL passes the
 * sync gate (which doesn't need DNS). Pure-logic; no network.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { classifyHostnameSync, SsrfBlockedError, RedirectError } from "./fetch-guard.js";

describe("classifyHostnameSync — refusals", () => {
	it("refuses literal localhost + variants", () => {
		assert.ok(classifyHostnameSync("localhost"));
		assert.ok(classifyHostnameSync("LOCALHOST"));
		assert.ok(classifyHostnameSync("ip6-localhost"));
	});

	it("refuses cloud-metadata IPs", () => {
		assert.ok(classifyHostnameSync("169.254.169.254"));
		assert.ok(classifyHostnameSync("metadata.google.internal"));
		assert.ok(classifyHostnameSync("metadata.aws.amazon.com"));
	});

	it("refuses `.local` / `.internal` / `.localhost` suffixes", () => {
		assert.ok(classifyHostnameSync("server.local"));
		assert.ok(classifyHostnameSync("foo.internal"));
		assert.ok(classifyHostnameSync("api.localhost"));
	});

	it("refuses RFC1918 private IPv4", () => {
		assert.ok(classifyHostnameSync("10.0.0.1"));
		assert.ok(classifyHostnameSync("172.16.0.1"));
		assert.ok(classifyHostnameSync("172.31.255.255"));
		assert.ok(classifyHostnameSync("192.168.1.1"));
	});

	it("refuses 127.0.0.0/8 loopback", () => {
		assert.ok(classifyHostnameSync("127.0.0.1"));
		assert.ok(classifyHostnameSync("127.255.255.255"));
	});

	it("refuses link-local 169.254.0.0/16", () => {
		assert.ok(classifyHostnameSync("169.254.5.5"));
	});

	it("refuses CGNAT 100.64.0.0/10", () => {
		assert.ok(classifyHostnameSync("100.64.1.1"));
		assert.ok(classifyHostnameSync("100.127.255.255"));
		// 100.128.x is OUTSIDE CGNAT — should pass
		assert.equal(classifyHostnameSync("100.128.0.1"), null);
	});

	it("refuses multicast + reserved IPv4", () => {
		assert.ok(classifyHostnameSync("224.0.0.1"));
		assert.ok(classifyHostnameSync("240.0.0.1"));
	});

	it("refuses 0.0.0.0/8", () => {
		assert.ok(classifyHostnameSync("0.0.0.0"));
		assert.ok(classifyHostnameSync("0.255.255.255"));
	});

	it("refuses legacy IPv4 literals (octal/hex/decimal-int/short)", () => {
		// Decimal-int form of 127.0.0.1
		assert.ok(classifyHostnameSync("2130706433"));
		// Hex form
		assert.ok(classifyHostnameSync("0x7f.0.0.1"));
		// Octal form
		assert.ok(classifyHostnameSync("0177.0.0.1"));
		// 3-part short form (127.0.1 → 127.0.0.1 in inet_aton)
		assert.ok(classifyHostnameSync("127.0.1"));
	});

	it("refuses IPv6 site-local fec0::/10 (deprecated)", () => {
		assert.ok(classifyHostnameSync("fec0::1"));
		assert.ok(classifyHostnameSync("feff::1"));
	});

	it("strips IPv6 zone identifier before classifying", () => {
		// fe80::1%eth0 is link-local. Zone-suffix must not let it pass.
		assert.ok(classifyHostnameSync("fe80::1%eth0"));
	});

	it("refuses IPv6 loopback + ULA + link-local", () => {
		assert.ok(classifyHostnameSync("::1"));
		assert.ok(classifyHostnameSync("fc00::1"));
		assert.ok(classifyHostnameSync("fd12::1"));
		assert.ok(classifyHostnameSync("fe80::1"));
		assert.ok(classifyHostnameSync("::ffff:127.0.0.1")); // IPv4-mapped loopback
	});

	it("rejects empty / invalid IPv4 literals", () => {
		assert.ok(classifyHostnameSync(""));
		assert.ok(classifyHostnameSync("1.2.3"));
		assert.ok(classifyHostnameSync("999.999.999.999"));
	});
});

describe("classifyHostnameSync — allows", () => {
	it("public hostnames pass", () => {
		assert.equal(classifyHostnameSync("example.com"), null);
		assert.equal(classifyHostnameSync("www.google.com"), null);
		assert.equal(classifyHostnameSync("api.github.com"), null);
	});

	it("public IPv4 passes", () => {
		assert.equal(classifyHostnameSync("8.8.8.8"), null);
		assert.equal(classifyHostnameSync("1.1.1.1"), null);
	});

	it("public IPv6 passes", () => {
		assert.equal(classifyHostnameSync("2606:4700:4700::1111"), null);
	});
});

describe("error classes", () => {
	it("SsrfBlockedError carries url + reason", () => {
		const err = new SsrfBlockedError("http://10.0.0.1/", "RFC1918 private");
		assert.equal(err.name, "SsrfBlockedError");
		assert.equal(err.url, "http://10.0.0.1/");
		assert.match(err.message, /10\.0\.0\.1/);
		assert.match(err.message, /RFC1918/);
	});

	it("RedirectError carries url + reason", () => {
		const err = new RedirectError("http://example.com/", "cycle detected");
		assert.equal(err.name, "RedirectError");
		assert.equal(err.url, "http://example.com/");
		assert.match(err.message, /cycle detected/);
	});

	it("RedirectError for missing-Location 3xx mentions the reason", () => {
		const err = new RedirectError("https://example.com/", "3xx 302 without Location header");
		assert.match(err.message, /without Location/);
	});
});
