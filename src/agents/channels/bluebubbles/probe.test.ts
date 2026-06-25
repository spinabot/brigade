import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	clearBlueBubblesProbeCache,
	isMacOSEditUnsupported,
	parseMacOSMajorVersion,
	probeBlueBubbles,
	probeBlueBubblesCached,
} from "./probe.js";

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "probe", "pw"].join("-");

/** Build a fake fetch returning a canned server/info JSON body. */
function fakeFetch(opts: { status?: number; data?: unknown; throwErr?: Error }): typeof fetch {
	return (async () => {
		if (opts.throwErr) throw opts.throwErr;
		const status = opts.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify({ status: 200, data: opts.data ?? {} }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("probeBlueBubbles", () => {
	it("returns ok + privateApi:true when the server reports it enabled", async () => {
		const res = await probeBlueBubbles({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: fakeFetch({ data: { private_api: true, server_version: "1.9.0", os_version: "14.4" } }),
		});
		assert.equal(res.ok, true);
		assert.equal(res.privateApi, true);
		assert.equal(res.serverInfo?.server_version, "1.9.0");
		assert.equal(res.macOSMajor, 14, "macOS major parsed from os_version");
	});

	it("surfaces the macOS major version for a macOS 26 host", async () => {
		const res = await probeBlueBubbles({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: fakeFetch({ data: { private_api: true, os_version: "26.0" } }),
		});
		assert.equal(res.macOSMajor, 26);
	});

	it("returns ok + privateApi:false when disabled", async () => {
		const res = await probeBlueBubbles({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: fakeFetch({ data: { private_api: false } }),
		});
		assert.equal(res.ok, true);
		assert.equal(res.privateApi, false);
	});

	it("returns ok + privateApi:null (unknown) when server/info omits the field", async () => {
		const res = await probeBlueBubbles({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: fakeFetch({ data: { server_version: "1.9.0" } }),
		});
		assert.equal(res.ok, true);
		assert.equal(res.privateApi, null);
	});

	it("flags a 401 as a fatal auth error", async () => {
		const res = await probeBlueBubbles({ serverUrl: SERVER, password: "bad", fetchImpl: fakeFetch({ status: 401 }) });
		assert.equal(res.ok, false);
		assert.equal(res.fatal, true);
		assert.match(res.error ?? "", /password/);
	});

	it("never throws on a network error (non-fatal)", async () => {
		const res = await probeBlueBubbles({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: fakeFetch({ throwErr: new Error("ECONNREFUSED") }),
		});
		assert.equal(res.ok, false);
		assert.equal(res.fatal, false);
	});

	it("is fatal when no serverUrl is configured", async () => {
		const res = await probeBlueBubbles({ serverUrl: "", password: PASSWORD });
		assert.equal(res.ok, false);
		assert.equal(res.fatal, true);
	});
});

describe("parseMacOSMajorVersion", () => {
	it("parses the major version", () => {
		assert.equal(parseMacOSMajorVersion("26.1"), 26);
		assert.equal(parseMacOSMajorVersion("14.4.1"), 14);
	});
	it("returns null on garbage", () => {
		assert.equal(parseMacOSMajorVersion("unknown"), null);
		assert.equal(parseMacOSMajorVersion(undefined), null);
	});
});

describe("probeBlueBubblesCached", () => {
	/** A fetch that counts how many times it was called. */
	function countingFetch(count: { n: number }, data: unknown = { private_api: true, os_version: "14.4" }): typeof fetch {
		return (async () => {
			count.n++;
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ status: 200, data }),
				headers: new Map<string, string>() as unknown as Headers,
			} as unknown as Response;
		}) as unknown as typeof fetch;
	}

	it("serves a second probe within the TTL from cache (no extra round-trip)", async () => {
		clearBlueBubblesProbeCache();
		const count = { n: 0 };
		const f = countingFetch(count);
		const args = { accountId: "cache-test", serverUrl: SERVER, password: PASSWORD, fetchImpl: f, now: () => 1_000 };
		const a = await probeBlueBubblesCached(args);
		const b = await probeBlueBubblesCached(args);
		assert.equal(a.privateApi, true);
		assert.equal(b.privateApi, true);
		assert.equal(count.n, 1, "second call hit the cache, not the network");
	});

	it("re-probes after the TTL expires", async () => {
		clearBlueBubblesProbeCache();
		const count = { n: 0 };
		const f = countingFetch(count);
		await probeBlueBubblesCached({ accountId: "ttl-test", serverUrl: SERVER, password: PASSWORD, fetchImpl: f, cacheTtlMs: 100, now: () => 1_000 });
		await probeBlueBubblesCached({ accountId: "ttl-test", serverUrl: SERVER, password: PASSWORD, fetchImpl: f, cacheTtlMs: 100, now: () => 2_000 });
		assert.equal(count.n, 2, "expired cache → re-probe");
	});

	it("does NOT cache a failed probe", async () => {
		clearBlueBubblesProbeCache();
		const count = { n: 0 };
		const f = (async () => {
			count.n++;
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		await probeBlueBubblesCached({ accountId: "fail-test", serverUrl: SERVER, password: PASSWORD, fetchImpl: f, now: () => 1_000 });
		await probeBlueBubblesCached({ accountId: "fail-test", serverUrl: SERVER, password: PASSWORD, fetchImpl: f, now: () => 1_001 });
		assert.equal(count.n, 2, "a failed probe is not cached → retried");
	});
});

describe("isMacOSEditUnsupported", () => {
	it("is true on macOS 26+ and false below / unknown", () => {
		assert.equal(isMacOSEditUnsupported(26), true);
		assert.equal(isMacOSEditUnsupported(27), true);
		assert.equal(isMacOSEditUnsupported(15), false);
		assert.equal(isMacOSEditUnsupported(null), false);
		assert.equal(isMacOSEditUnsupported(undefined), false);
	});
});
