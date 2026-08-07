/**
 * GitHub Copilot transport routing.
 *
 * Regression cover for the "every turn returns 421 Misdirected Request on a
 * Copilot Business/Enterprise login" bug. Two independent causes, both fixed at
 * the same choke point:
 *
 *   1. ENDPOINT. An enterprise seat's `/models` list carries ids Pi's bundled
 *      catalog doesn't have yet (the `gpt-5.6-*` family). The never-miss
 *      resolver synthesized those by cloning the provider's FIRST catalogued
 *      model — `claude-fable-5`, an `openai-completions` entry — so a GPT-5
 *      request went to `/chat/completions`, which Copilot serves only on
 *      `/responses`. Result: 421 on every prompt, whatever the prompt was.
 *   2. HOST. The bundled catalog hardcodes `api.individual.githubcopilot.com`;
 *      a business/enterprise token must talk to its own host, which is encoded
 *      in the token's `proxy-ep` field.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	applyGitHubCopilotRouting,
	flipCopilotApi,
	githubCopilotApiForModelId,
	githubCopilotBaseUrlFromToken,
	isCopilotEndpointMismatch,
	resetLearnedGitHubCopilotApis,
	wrapStreamFnWithCopilotEndpointHeal,
} from "./github-copilot-transport.js";
import { pickTemplateForModelId, resolveModelNeverMiss } from "./model-resolution.js";

const INDIVIDUAL_HOST = "https://api.individual.githubcopilot.com";

/** The bundled Copilot catalog's shape + ORDER (claude-fable-5 is first). */
function copilotCatalog() {
	return [
		{ provider: "github-copilot", id: "claude-fable-5", api: "openai-completions", baseUrl: INDIVIDUAL_HOST, contextWindow: 1_000_000, input: ["text", "image"], compat: { supportsStore: false } },
		{ provider: "github-copilot", id: "claude-haiku-4.5", api: "anthropic-messages", baseUrl: INDIVIDUAL_HOST, contextWindow: 200_000, input: ["text", "image"] },
		{ provider: "github-copilot", id: "gpt-4.1", api: "openai-completions", baseUrl: INDIVIDUAL_HOST, contextWindow: 128_000, input: ["text"] },
		{ provider: "github-copilot", id: "gpt-5.2", api: "openai-responses", baseUrl: INDIVIDUAL_HOST, contextWindow: 400_000, input: ["text", "image"] },
		{ provider: "github-copilot", id: "gpt-5.4-mini", api: "openai-responses", baseUrl: INDIVIDUAL_HOST, contextWindow: 400_000, input: ["text", "image"] },
		{ provider: "github-copilot", id: "gpt-5.5", api: "openai-responses", baseUrl: INDIVIDUAL_HOST, contextWindow: 400_000, input: ["text", "image"], thinkingLevelMap: { off: null } },
	];
}

describe("githubCopilotApiForModelId", () => {
	it("routes GPT-5+/o-series/codex to the responses API", () => {
		for (const id of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5-mini", "gpt-6", "gpt-10.1", "o3-mini", "gpt-5.3-codex", "some-codex-preview"]) {
			assert.equal(githubCopilotApiForModelId(id), "openai-responses", id);
		}
	});

	it("keeps everything else on chat completions", () => {
		for (const id of ["gpt-4.1", "claude-opus-4.8", "claude-sonnet-5", "gemini-3.5-flash", "grok-code"]) {
			assert.equal(githubCopilotApiForModelId(id), "openai-completions", id);
		}
	});
});

describe("githubCopilotBaseUrlFromToken", () => {
	it("derives the account's API host from the token's proxy-ep", () => {
		assert.equal(
			githubCopilotBaseUrlFromToken("tid=abc;exp=123;proxy-ep=proxy.business.githubcopilot.com;st=dotcom"),
			"https://api.business.githubcopilot.com",
		);
		assert.equal(
			githubCopilotBaseUrlFromToken("tid=abc;proxy-ep=proxy.enterprise.githubcopilot.com;exp=1"),
			"https://api.enterprise.githubcopilot.com",
		);
	});

	it("handles the GitHub Enterprise (GHE) copilot-proxy host shape", () => {
		assert.equal(
			githubCopilotBaseUrlFromToken("tid=abc;proxy-ep=copilot-proxy.acme.ghe.com;exp=1"),
			"https://copilot-api.acme.ghe.com",
		);
	});

	it("returns undefined for a token with no proxy-ep, and rejects a junk host", () => {
		assert.equal(githubCopilotBaseUrlFromToken("tid=abc;exp=123"), undefined);
		assert.equal(githubCopilotBaseUrlFromToken(undefined), undefined);
		assert.equal(githubCopilotBaseUrlFromToken("proxy-ep=evil.com/path?x=1"), undefined);
	});
});

describe("pickTemplateForModelId", () => {
	it("picks the newest same-family template, not the first-listed model", () => {
		const picked = pickTemplateForModelId(copilotCatalog(), "gpt-5.6-sol");
		assert.equal(picked?.id, "gpt-5.5");
	});

	it("matches the claude family for a claude id", () => {
		const picked = pickTemplateForModelId(copilotCatalog(), "claude-haiku-5");
		assert.equal(picked?.id, "claude-haiku-4.5");
	});

	it("falls back to the first candidate when nothing shares a family", () => {
		const picked = pickTemplateForModelId(copilotCatalog(), "zzz-brand-new");
		assert.equal(picked?.id, "claude-fable-5");
	});
});

describe("applyGitHubCopilotRouting", () => {
	const token = "tid=abc;exp=1;proxy-ep=proxy.business.githubcopilot.com;st=dotcom";

	it("re-points a chat-completions clone of a GPT-5 model at the responses API", () => {
		const wrong = { provider: "github-copilot", id: "gpt-5.6-sol", api: "openai-completions", baseUrl: INDIVIDUAL_HOST, compat: { supportsStore: false }, thinkingLevelMap: { off: null } };
		const fixed = applyGitHubCopilotRouting(wrong, "gpt-5.6-sol", token) as Record<string, unknown>;
		assert.equal(fixed.api, "openai-responses");
		assert.equal(fixed.baseUrl, "https://api.business.githubcopilot.com");
		// The template's endpoint-specific quirks must NOT ride along to the other API.
		assert.equal(fixed.compat, undefined);
		assert.equal(fixed.thinkingLevelMap, undefined);
	});

	it("re-points the bundled individual host at the seat's own host", () => {
		const catalogued = { provider: "github-copilot", id: "gpt-5.5", api: "openai-responses", baseUrl: INDIVIDUAL_HOST };
		const fixed = applyGitHubCopilotRouting(catalogued, "gpt-5.5", token) as Record<string, unknown>;
		assert.equal(fixed.baseUrl, "https://api.business.githubcopilot.com");
		assert.equal(fixed.api, "openai-responses", "already correct — unchanged");
	});

	it("always carries Copilot's required editor headers", () => {
		const bare = { provider: "github-copilot", id: "gpt-5.6-sol", api: "openai-completions" };
		const fixed = applyGitHubCopilotRouting(bare, "gpt-5.6-sol", token) as { headers: Record<string, string> };
		assert.equal(fixed.headers["Copilot-Integration-Id"], "vscode-chat");
		assert.equal(fixed.headers["Editor-Version"], "vscode/1.107.0");
		assert.equal(fixed.headers["Editor-Plugin-Version"], "copilot-chat/0.35.0");
	});

	it("leaves a deliberately-configured non-Copilot baseUrl alone", () => {
		const custom = { provider: "github-copilot", id: "gpt-5.5", api: "openai-responses", baseUrl: "https://copilot-gateway.internal.acme.dev" };
		const fixed = applyGitHubCopilotRouting(custom, "gpt-5.5", token) as Record<string, unknown>;
		assert.equal(fixed.baseUrl, "https://copilot-gateway.internal.acme.dev");
	});

	it("is a no-op for other providers", () => {
		const other = { provider: "openai", id: "gpt-5.6-sol", api: "openai-completions" };
		assert.equal(applyGitHubCopilotRouting(other, "gpt-5.6-sol", token), other);
	});
});

describe("resolveModelNeverMiss — enterprise Copilot model not in the bundled catalog", () => {
	it("synthesizes gpt-5.6-sol onto /responses instead of cloning the first Claude entry", async () => {
		const registry = {
			find: () => undefined,
			getAvailable: () => copilotCatalog(),
			refresh: () => {},
		};
		const model = (await resolveModelNeverMiss({
			modelRegistry: registry,
			provider: "github-copilot",
			modelId: "gpt-5.6-sol",
			modelsFile: "/does/not/exist.json",
			authStorage: {
				getApiKey: () => "tid=abc;exp=1;proxy-ep=proxy.enterprise.githubcopilot.com",
			},
		})) as Record<string, unknown>;

		assert.ok(model, "expected a synthesized model");
		assert.equal(model.id, "gpt-5.6-sol");
		assert.equal(model.api, "openai-responses", "the 421 root cause: must not inherit chat-completions");
		assert.equal(model.baseUrl, "https://api.enterprise.githubcopilot.com", "must not stay on the individual host");
	});
});

describe("isCopilotEndpointMismatch", () => {
	it("recognises both shapes Copilot uses to reject an endpoint", () => {
		assert.equal(isCopilotEndpointMismatch(new Error("421 Misdirected Request")), true);
		assert.equal(isCopilotEndpointMismatch(Object.assign(new Error("nope"), { status: 421 })), true);
		assert.equal(
			isCopilotEndpointMismatch(new Error('model "gpt-5.6-luna" is not accessible via the /chat/completions endpoint')),
			true,
		);
		// Wrapped one layer deep (Pi surfaces provider errors as a cause chain).
		assert.equal(isCopilotEndpointMismatch(new Error("stream failed", { cause: new Error("421 Misdirected Request") })), true);
	});

	it("does not fire on unrelated failures", () => {
		assert.equal(isCopilotEndpointMismatch(new Error("429 Too Many Requests")), false);
		assert.equal(isCopilotEndpointMismatch(new Error("socket hang up")), false);
		assert.equal(isCopilotEndpointMismatch(undefined), false);
	});
});

describe("flipCopilotApi", () => {
	it("swaps between the two Copilot surfaces", () => {
		assert.equal(flipCopilotApi("openai-completions"), "openai-responses");
		assert.equal(flipCopilotApi("openai-responses"), "openai-completions");
		assert.equal(flipCopilotApi(undefined), "openai-responses");
	});
});

describe("wrapStreamFnWithCopilotEndpointHeal", () => {
	/** Minimal stand-in for Pi's EventStream: iterator + result(). */
	function eventStream(events: unknown[], result: unknown = "ok") {
		return {
			[Symbol.asyncIterator]: async function* () {
				for (const e of events) yield e;
			},
			result: async () => result,
		};
	}

	function failingStream(err: Error) {
		return {
			[Symbol.asyncIterator]: async function* () {
				throw err;
			},
			result: async () => {
				throw err;
			},
		};
	}

	it("re-issues on the other endpoint when the first one is rejected, and learns it", async () => {
		resetLearnedGitHubCopilotApis();
		const calls: string[] = [];
		const healed: string[] = [];
		const wrapped = wrapStreamFnWithCopilotEndpointHeal(
			(model: unknown) => {
				const api = String((model as { api?: string }).api);
				calls.push(api);
				return api === "openai-completions"
					? failingStream(new Error("421 Misdirected Request"))
					: eventStream(["event-1"], "final");
			},
			(info) => healed.push(`${info.from}→${info.to}`),
		);

		const model = { provider: "github-copilot", id: "gpt-9-brand-new", api: "openai-completions" };
		const stream = (await wrapped(model, {}, {})) as {
			[Symbol.asyncIterator](): AsyncIterator<unknown>;
			result(): Promise<unknown>;
		};
		const seen: unknown[] = [];
		for await (const ev of { [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator]() }) seen.push(ev);

		assert.deepEqual(seen, ["event-1"], "the healed stream's events reach the caller");
		assert.equal(await stream.result(), "final", "result() delegates to the healed stream");
		assert.deepEqual(calls, ["openai-completions", "openai-responses"]);
		assert.deepEqual(healed, ["openai-completions→openai-responses"]);

		// Learned for every later turn: the same id now resolves to the endpoint
		// that worked, with no second failure.
		const routed = applyGitHubCopilotRouting(
			{ provider: "github-copilot", id: "gpt-9-brand-new", api: "openai-completions" },
			"gpt-9-brand-new",
		) as { api?: string };
		assert.equal(routed.api, "openai-responses");
		resetLearnedGitHubCopilotApis();
	});

	it("rethrows a non-endpoint failure untouched (no second request)", async () => {
		resetLearnedGitHubCopilotApis();
		let calls = 0;
		const wrapped = wrapStreamFnWithCopilotEndpointHeal(() => {
			calls++;
			return failingStream(new Error("429 Too Many Requests"));
		});
		const stream = (await wrapped({ provider: "github-copilot", id: "gpt-5.5", api: "openai-responses" }, {}, {})) as {
			result(): Promise<unknown>;
		};
		await assert.rejects(() => stream.result(), /429/);
		assert.equal(calls, 1, "no endpoint flip for an unrelated error");
	});

	it("never replays a stream that already produced events", async () => {
		resetLearnedGitHubCopilotApis();
		let calls = 0;
		const wrapped = wrapStreamFnWithCopilotEndpointHeal(() => {
			calls++;
			return {
				[Symbol.asyncIterator]: async function* () {
					yield "partial";
					throw new Error("421 Misdirected Request");
				},
				result: async () => "unused",
			};
		});
		const stream = (await wrapped({ provider: "github-copilot", id: "gpt-5.5", api: "openai-responses" }, {}, {})) as {
			[Symbol.asyncIterator](): AsyncIterator<unknown>;
		};
		const iterator = stream[Symbol.asyncIterator]();
		assert.deepEqual(await iterator.next(), { value: "partial", done: false });
		await assert.rejects(() => iterator.next() as Promise<unknown>, /421/);
		assert.equal(calls, 1, "partial output must never be re-issued");
	});

	it("passes non-Copilot models straight through", async () => {
		let calls = 0;
		const wrapped = wrapStreamFnWithCopilotEndpointHeal(() => {
			calls++;
			return eventStream([]);
		});
		await wrapped({ provider: "openai", id: "gpt-5.5", api: "openai-responses" }, {}, {});
		assert.equal(calls, 1);
	});
});
