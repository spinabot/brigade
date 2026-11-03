/**
 * A failed subscription sign-in used to show one line for every cause —
 * "We couldn't finish signing you in. Check your connection and try again." —
 * so a TLS-intercepting VPN, a DNS failure, a GitHub 429 and a GitHub outage
 * all looked the same, and the browser simply "didn't open". These tests pin
 * the specific, safe line each cause now gets, built from the error shapes
 * Node's fetch really produces (the cause chain carries the code; the outer
 * message is always "fetch failed").
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";

import { describeSubscriptionLoginFailure } from "./subscription-login-error.js";

/** What undici's fetch throws on a network/TLS failure: a TypeError whose cause carries the code. */
function fetchFailed(code: string, message = code): TypeError {
	return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

const COPILOT = "GitHub Copilot";

describe("describeSubscriptionLoginFailure", () => {
	it("keeps the soft line for a user cancel", () => {
		for (const reason of ["Login cancelled", "cancelled", "back"]) {
			assert.equal(
				describeSubscriptionLoginFailure(new Error(reason), COPILOT),
				"Login cancelled. Start again, or pick a different provider.",
			);
		}
	});

	it("names a TLS interception and the code, for every certificate failure Node reports", () => {
		for (const code of [
			"SELF_SIGNED_CERT_IN_CHAIN",
			"DEPTH_ZERO_SELF_SIGNED_CERT",
			"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			"CERT_HAS_EXPIRED",
			"ERR_TLS_CERT_ALTNAME_INVALID",
		]) {
			const line = describeSubscriptionLoginFailure(fetchFailed(code), COPILOT);
			assert.match(line, /certificate/i, code);
			assert.match(line, /VPN, proxy or security app/, code);
			assert.ok(line.includes(`(${code})`), `${code}: ${line}`);
		}
	});

	it("offers --use-system-ca for a certificate failure only when this Node accepts it", () => {
		const line = describeSubscriptionLoginFailure(fetchFailed("SELF_SIGNED_CERT_IN_CHAIN"), COPILOT);
		const supported = process.allowedNodeEnvironmentFlags.has("--use-system-ca");
		assert.equal(line.includes("NODE_OPTIONS=--use-system-ca"), supported);
		if (!supported) assert.ok(line.includes("NODE_EXTRA_CA_CERTS"));
	});

	it("names a DNS failure", () => {
		for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
			const line = describeSubscriptionLoginFailure(fetchFailed(code, `getaddrinfo ${code} github.com`), COPILOT);
			assert.equal(line, `Couldn't find GitHub Copilot's server (${code}). Check your internet connection, DNS or VPN.`);
		}
	});

	it("names a refused or dropped connection", () => {
		for (const code of ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET"]) {
			const line = describeSubscriptionLoginFailure(fetchFailed(code), COPILOT);
			assert.equal(
				line,
				`The connection to GitHub Copilot was refused or dropped (${code}). A firewall, proxy or VPN may be blocking it.`,
			);
		}
	});

	it("names a timeout, from undici's codes and from AbortSignal.timeout", () => {
		const timeoutError = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
		for (const [err, code] of [
			[fetchFailed("UND_ERR_CONNECT_TIMEOUT"), "UND_ERR_CONNECT_TIMEOUT"],
			[fetchFailed("ETIMEDOUT"), "ETIMEDOUT"],
			[timeoutError, "timeout"],
		] as const) {
			assert.equal(
				describeSubscriptionLoginFailure(err, COPILOT),
				`GitHub Copilot didn't respond in time (${code}). Check your connection and try again.`,
			);
		}
	});

	it("reads the HTTP status from each provider's error shape and never echoes the body", () => {
		const shapes = [
			new Error('429 Too Many Requests: {"error":"rate_limited","token":"gho_SECRET"}'),
			new Error("HTTP request failed. status=429; url=https://example.test/x; body=gho_SECRET"),
			new Error("OpenAI Codex token exchange failed (429): gho_SECRET"),
			new Error("OpenAI Codex device code request failed with status 429: gho_SECRET"),
		];
		for (const err of shapes) {
			const line = describeSubscriptionLoginFailure(err, COPILOT);
			assert.equal(
				line,
				"GitHub Copilot is limiting sign-ins from this network right now (HTTP 429). Wait a few minutes, or try another network.",
			);
			assert.ok(!line.includes("SECRET") && !line.includes("https://"), line);
		}
	});

	it("separates a provider outage from a refusal", () => {
		assert.equal(
			describeSubscriptionLoginFailure(new Error("503 Service Unavailable: <html>"), COPILOT),
			"GitHub Copilot is having trouble right now (HTTP 503). Try again in a few minutes.",
		);
		assert.equal(
			describeSubscriptionLoginFailure(new Error("403 Forbidden: nope"), COPILOT),
			"GitHub Copilot refused the sign-in (HTTP 403).",
		);
	});

	it("explains the device-code outcomes", () => {
		assert.equal(
			describeSubscriptionLoginFailure(new Error("Device flow timed out"), COPILOT),
			"The sign-in code expired before it was approved. Start again and approve it in the browser.",
		);
		assert.equal(
			describeSubscriptionLoginFailure(new Error("Device flow failed: access_denied: The user denied"), COPILOT),
			"The sign-in was declined in the browser.",
		);
		assert.equal(
			describeSubscriptionLoginFailure(new Error("Device flow failed: device_flow_disabled: secret detail"), COPILOT),
			"GitHub Copilot ended the sign-in (device_flow_disabled).",
		);
	});

	it("explains a bad GitHub Enterprise address", () => {
		assert.equal(
			describeSubscriptionLoginFailure(new Error("Invalid GitHub Enterprise URL/domain"), COPILOT),
			"That GitHub Enterprise address isn't valid. Leave it blank for github.com, or enter a host like company.ghe.com.",
		);
	});

	it("explains a response it couldn't read", () => {
		for (const msg of ["Invalid device code response fields", "Invalid Copilot token response", "Untrusted verification_uri in device code response"]) {
			assert.equal(
				describeSubscriptionLoginFailure(new Error(msg), COPILOT),
				"GitHub Copilot sent a response Brigade couldn't read. Try again in a few minutes.",
			);
		}
	});

	it("falls back to the generic line, without the raw reason, for anything else", () => {
		const line = describeSubscriptionLoginFailure(new Error("Token exchange request failed. url=https://x.test; body=SECRET"), COPILOT);
		assert.equal(line, "We couldn't finish signing you in. Check your connection and try again.");
		assert.equal(describeSubscriptionLoginFailure("weird", COPILOT), line);
		assert.equal(describeSubscriptionLoginFailure(undefined, COPILOT), line);
	});
});

describe("the real GitHub Copilot login keeps fetch's cause, so the line names it", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	async function loginWith(fetchImpl: typeof fetch): Promise<{ err: unknown; deviceCodeShown: boolean }> {
		globalThis.fetch = fetchImpl;
		const provider = getOAuthProvider("github-copilot");
		assert.ok(provider, "pi ships a github-copilot OAuth provider");
		let deviceCodeShown = false;
		try {
			await provider.login({
				onAuth: () => {},
				onPrompt: async () => "",
				onDeviceCode: () => {
					deviceCodeShown = true;
				},
				onSelect: async () => undefined,
			});
		} catch (err) {
			return { err, deviceCodeShown };
		}
		assert.fail("login should have failed");
	}

	it("a TLS-intercepted device-code request fails before the browser step, and says why", async () => {
		const { err, deviceCodeShown } = await loginWith(async () => {
			throw fetchFailed("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain");
		});
		assert.equal(deviceCodeShown, false, "no device code means the browser never opens");
		assert.match(describeSubscriptionLoginFailure(err, COPILOT), /\(SELF_SIGNED_CERT_IN_CHAIN\)/);
	});

	it("a rate-limited device-code request says HTTP 429", async () => {
		const { err } = await loginWith(async () => new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
		assert.match(describeSubscriptionLoginFailure(err, COPILOT), /\(HTTP 429\)/);
	});
});
