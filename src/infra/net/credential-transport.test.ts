/**
 * Tests for the cleartext-credential gate. Pure logic; no network.
 *
 * The two halves that matter: local inference over `http://` must keep working
 * (Ollama / LM Studio / llama.cpp), and a hostname that merely LOOKS loopback
 * must not be mistaken for one.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { checkCredentialTransport, isLoopbackHostname } from "./credential-transport.js";

const LAN_ENV = "BRIGADE_ALLOW_INSECURE_LAN_ENDPOINTS";
afterEach(() => {
	delete process.env[LAN_ENV];
});

describe("isLoopbackHostname", () => {
	it("accepts the reserved name and the whole 127/8 block", () => {
		assert.equal(isLoopbackHostname("localhost"), true);
		assert.equal(isLoopbackHostname("LOCALHOST"), true);
		assert.equal(isLoopbackHostname("127.0.0.1"), true);
		assert.equal(isLoopbackHostname("127.0.0.2"), true);
		assert.equal(isLoopbackHostname("127.255.255.254"), true);
	});

	it("accepts IPv6 loopback in every spelling a URL can produce", () => {
		assert.equal(isLoopbackHostname("::1"), true);
		assert.equal(isLoopbackHostname("[::1]"), true); // URL.hostname keeps brackets
		assert.equal(isLoopbackHostname("::1%lo0"), true);
		assert.equal(isLoopbackHostname("::ffff:127.0.0.1"), true);
		assert.equal(isLoopbackHostname("[::ffff:7f00:1]"), true); // what new URL() rewrites the above to
	});

	it("accepts the unspecified addresses (the kernel connects them locally)", () => {
		assert.equal(isLoopbackHostname("0.0.0.0"), true);
		assert.equal(isLoopbackHostname("[::]"), true);
	});

	it("rejects names that merely start with a loopback label", () => {
		assert.equal(isLoopbackHostname("localhost.evil.tld"), false);
		assert.equal(isLoopbackHostname("127.0.0.1.evil.tld"), false);
		assert.equal(isLoopbackHostname("mylocalhost"), false);
		assert.equal(isLoopbackHostname("localhost.attacker.com"), false);
	});

	it("rejects public, LAN and near-miss addresses", () => {
		assert.equal(isLoopbackHostname("api.example.com"), false);
		assert.equal(isLoopbackHostname("192.168.1.50"), false);
		assert.equal(isLoopbackHostname("10.0.0.1"), false);
		assert.equal(isLoopbackHostname("128.0.0.1"), false);
		assert.equal(isLoopbackHostname("27.0.0.1"), false);
		assert.equal(isLoopbackHostname("::ffff:10.0.0.1"), false);
		assert.equal(isLoopbackHostname(""), false);
	});
});

describe("checkCredentialTransport — https anywhere, http only to this machine", () => {
	const ok = (url: string) => checkCredentialTransport(url).ok;

	it("allows https to a remote endpoint", () => {
		assert.equal(ok("https://api.example.com/v1"), true);
		assert.equal(ok("https://integrate.api.nvidia.com/v1"), true);
	});

	it("allows http to the local inference servers we support", () => {
		assert.equal(ok("http://localhost:11434/v1"), true); // Ollama default
		assert.equal(ok("http://127.0.0.1:1234/v1"), true); // LM Studio
		assert.equal(ok("http://127.0.0.2/v1"), true);
		assert.equal(ok("http://[::1]:8080/v1"), true);
		assert.equal(ok("http://127.1:8080/v1"), true); // URL normalises to 127.0.0.1
	});

	it("refuses http to a remote host, with an actionable line", () => {
		const res = checkCredentialTransport("http://remote.example.com/v1");
		assert.equal(res.ok, false);
		if (res.ok) return;
		// The refused host is structured data, so assert it exactly rather than
		// fishing it back out of the sentence — a caller wanting the host should
		// read the field, not parse the prose.
		assert.equal(res.host, "remote.example.com");
		// The line still has to be actionable, so pin it whole. Rewording the copy
		// should require updating this deliberately.
		assert.equal(
			res.reason,
			"Refusing to send your API key unencrypted to remote.example.com — over http:// anyone on the network can read it. " +
				"Use https:// for a remote endpoint, or point Brigade at a server on this machine (Ollama runs on http://localhost:11434).",
		);
	});

	it("refuses the loopback-lookalike hosts", () => {
		assert.equal(ok("http://localhost.evil.tld/v1"), false);
		assert.equal(ok("http://127.0.0.1.evil.tld/v1"), false);
	});

	it("refuses LAN endpoints by default — a LAN is not a confidentiality boundary", () => {
		assert.equal(ok("http://192.168.1.50:11434/v1"), false);
		assert.equal(ok("http://10.0.0.5:11434/v1"), false);
		assert.equal(ok("http://172.16.4.2:11434/v1"), false);
	});

	it("allows LAN endpoints only on the explicit opt-in, and says so", () => {
		process.env[LAN_ENV] = "1";
		const res = checkCredentialTransport("http://192.168.1.50:11434/v1");
		assert.equal(res.ok, true);
		const warning = (res as { warning?: string }).warning ?? "";
		assert.ok(warning.includes("192.168.1.50"), warning);
		assert.ok(warning.includes(LAN_ENV), warning);
		// A public host is still refused — the opt-in is about the LAN, not http.
		assert.equal(ok("http://remote.example.com/v1"), false);
		// And cloud metadata never counts as a LAN host.
		assert.equal(ok("http://169.254.169.254/v1"), false);
	});

	it("refuses non-http(s) schemes and unparseable input", () => {
		assert.equal(ok("ftp://example.com/v1"), false);
		assert.equal(ok("file:///etc/passwd"), false);
		assert.equal(ok("not a url"), false);
	});
});
