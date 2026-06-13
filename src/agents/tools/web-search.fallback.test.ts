/**
 * `web_search` error-time fallback chain tests.
 *
 * Production incident (2026-06-13): the default provider 429'd on a weekly
 * quota and, with no fallback chain, EVERY search died — the agent went
 * blind mid-research and fell back to scraping directory sites. These tests
 * pin the chain walk: throw → next rung, rate-limit → cooldown, abort →
 * re-raise (never advance), all-fail → one typed envelope with the
 * browser-SERP playbook, explicit override → no chain.
 *
 * Pure-logic: stub providers, no network. Each test uses a UNIQUE query —
 * the module-level result cache keys on (provider, query, count) and would
 * otherwise leak hits across cases; cooldowns are cleared per test.
 */

import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { clearWebSearchRateLimitCooldownsForTests, makeWebSearchTool } from "./web-search.js";
import type { WebSearchProvider } from "../extensions/types.js";

function stubProvider(
	id: string,
	execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>,
): WebSearchProvider {
	return {
		id,
		label: id,
		hint: "",
		envVars: [],
		requiresCredential: false,
		autoDetectOrder: 50,
		isConfigured: () => true,
		createTool: () => ({
			description: id,
			parameters: { type: "object", properties: {} },
			execute,
		}),
	};
}

function parsePayload(content: unknown): {
	provider: string;
	results: unknown[];
	error?: string;
	message?: string;
} {
	const arr = content as Array<{ type: string; text?: string }>;
	return JSON.parse(arr[0]?.text ?? "{}");
}

beforeEach(() => {
	clearWebSearchRateLimitCooldownsForTests();
});

describe("web_search — error-time fallback chain", () => {
	it("falls through to the next configured provider when the first throws", async () => {
		const first = stubProvider("flaky-1", async () => {
			throw new Error("HTTP 429 — weekly usage reached");
		});
		const second = stubProvider("steady-1", async () => ({
			results: [{ title: "Hit", url: "https://example.com" }],
		}));
		const tool = makeWebSearchTool({
			provider: first,
			providerCtx: {} as never,
			// Chain dedupes the active provider by id, so listing it again is harmless.
			fallbackProviders: () => [first, second],
		});
		assert.ok(tool);
		const out = parsePayload((await tool!.execute("c1", { query: "fallback-case-one" })).content);
		assert.equal(out.provider, "steady-1");
		assert.equal(out.results.length, 1);
		assert.match(out.message ?? "", /"flaky-1" failed/);
	});

	it("a rate-limited provider sits out the cooldown on the NEXT call (no repeat round-trip)", async () => {
		let firstCalls = 0;
		const first = stubProvider("capped-2", async () => {
			firstCalls += 1;
			throw new Error("HTTP 429 — quota exceeded");
		});
		const second = stubProvider("steady-2", async () => ({
			results: [{ title: "T", url: "https://e.com" }],
		}));
		const tool = makeWebSearchTool({
			provider: first,
			providerCtx: {} as never,
			fallbackProviders: () => [second],
		});
		assert.ok(tool);
		await tool!.execute("c2a", { query: "cooldown-case-a" });
		assert.equal(firstCalls, 1);
		const out = parsePayload((await tool!.execute("c2b", { query: "cooldown-case-b" })).content);
		assert.equal(firstCalls, 1, "capped rung skipped without a round-trip while cooling down");
		assert.equal(out.provider, "steady-2");
	});

	it("a genuine caller abort re-raises immediately — never advances the chain", async () => {
		const ac = new AbortController();
		const first = stubProvider("abort-3", async () => {
			ac.abort();
			throw new Error("aborted mid-flight");
		});
		let secondCalled = false;
		const second = stubProvider("never-3", async () => {
			secondCalled = true;
			return { results: [] };
		});
		const tool = makeWebSearchTool({
			provider: first,
			providerCtx: {} as never,
			fallbackProviders: () => [second],
		});
		assert.ok(tool);
		await assert.rejects(tool!.execute("c3", { query: "abort-case" }, ac.signal));
		assert.equal(secondCalled, false, "abort must not be treated as a fallback-worthy failure");
	});

	it("ALL rungs failing returns ONE typed envelope with the browser-SERP playbook", async () => {
		const first = stubProvider("dead-4a", async () => {
			throw new Error("HTTP 500 upstream");
		});
		const second = stubProvider("dead-4b", async () => {
			throw new Error("network down");
		});
		const tool = makeWebSearchTool({
			provider: first,
			providerCtx: {} as never,
			fallbackProviders: () => [second],
		});
		assert.ok(tool);
		const out = parsePayload((await tool!.execute("c4", { query: "all-fail-case" })).content);
		assert.equal(out.error, "provider_error");
		assert.match(out.message ?? "", /dead-4a: HTTP 500 upstream/);
		assert.match(out.message ?? "", /dead-4b: network down/);
		assert.match(out.message ?? "", /all search providers failed/);
		assert.match(out.message ?? "", /browser tool/);
		assert.match(out.message ?? "", /bing\.com\/search/);
	});

	it("an explicit per-call override never falls back to other providers", async () => {
		const base = stubProvider("base-5", async () => {
			throw new Error("HTTP 503");
		});
		let fallbackConsulted = false;
		const tool = makeWebSearchTool({
			provider: base,
			providerCtx: {} as never,
			lookupProviderById: () => null, // override unknown → keep default + note
			fallbackProviders: () => {
				fallbackConsulted = true;
				return [];
			},
		});
		assert.ok(tool);
		const out = parsePayload(
			(await tool!.execute("c5", { query: "override-case", provider: "missing-key-provider" }))
				.content,
		);
		assert.equal(fallbackConsulted, false, "explicit override suppresses the chain");
		assert.equal(out.error, "provider_error");
	});
});
