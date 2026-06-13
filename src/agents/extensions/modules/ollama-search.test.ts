/**
 * Tests for Ollama local web-search provider — keyless identity, env
 * base-URL resolution, optional Bearer auth.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	createOllamaSearchProvider,
	resolveOllamaApiKey,
	resolveOllamaBaseUrl,
} from "./ollama-search.js";

describe("createOllamaSearchProvider", () => {
	const p = createOllamaSearchProvider();
	it("keyless + identity", () => {
		assert.equal(p.id, "ollama");
		assert.equal(p.requiresCredential, false);
		assert.deepEqual(p.envVars, ["OLLAMA_HOST", "OLLAMA_API_KEY"]);
	});

	// CONTRACT CHANGE (2026-06-13, production incident): isConfigured used to
	// be `() => true`, which made the account-metered, weekly-capped ollama.com
	// cloud search the SILENT DEFAULT on every install (autoDetectOrder 90
	// beats DDG's 100). When the quota ran dry mid-research, search died
	// outright. The provider is now opt-in.
	it("NOT configured by default — must never silently win auto-detect again", () => {
		assert.equal(p.isConfigured({} as never, {} as never), false);
	});

	it("opt-in via config slot presence (even an empty object)", () => {
		const cfg = { tools: { web: { search: { providers: { ollama: {} } } } } };
		assert.equal(p.isConfigured(cfg as never, {} as never), true);
	});

	it("opt-in via OLLAMA_API_KEY (explicit Ollama Cloud setup)", () => {
		assert.equal(p.isConfigured({} as never, { OLLAMA_API_KEY: "ol-x" } as never), true);
	});

	it("OLLAMA_HOST alone is NOT opt-in (chat-runtime var, not search consent)", () => {
		assert.equal(p.isConfigured({} as never, { OLLAMA_HOST: "http://localhost:11434" } as never), false);
	});
});

describe("resolveOllamaBaseUrl", () => {
	it("defaults to localhost:11434", () => {
		assert.equal(resolveOllamaBaseUrl({}, {} as never), "http://localhost:11434");
	});
	it("config beats env", () => {
		assert.equal(
			resolveOllamaBaseUrl({ baseUrl: "http://cfg.example:11434" }, { OLLAMA_HOST: "http://env.example" } as never),
			"http://cfg.example:11434",
		);
	});
	it("strips trailing slash", () => {
		assert.equal(resolveOllamaBaseUrl({ baseUrl: "http://x/" }, {} as never), "http://x");
	});
});

describe("resolveOllamaApiKey", () => {
	it("returns env key when set", () => {
		assert.equal(resolveOllamaApiKey({}, { OLLAMA_API_KEY: "ol-test" } as never), "ol-test");
	});
	it("returns undefined when none", () => {
		assert.equal(resolveOllamaApiKey({}, {} as never), undefined);
	});
	it("strips CR/LF for header safety", () => {
		const r = resolveOllamaApiKey({}, { OLLAMA_API_KEY: "ol\r\nSmuggled: x" } as never);
		assert.ok(r);
		assert.ok(!r!.includes("\r"));
	});
});
