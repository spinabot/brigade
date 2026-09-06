/**
 * Live-validation tests. Every request is stubbed — zero network.
 *
 * OpenCode is the reason this file exists: its gateway answers 401 for both a bad
 * key AND an unknown model, so the verdict comes from `error.type` in the body.
 * The existing providers are covered too, to pin that `interpretFailure` changed
 * nothing for them.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { getModel } from "@earendil-works/pi-ai";

import { validateApiKeyOnline } from "./validate-key.js";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

// Synthetic, shaped like an OpenCode key ("sk-" + 64 alnum).
const KEY = `sk-${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2"}`;

function headersToRecord(init: RequestInit["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!init) return out;
	new Headers(init).forEach((value, name) => {
		out[name.toLowerCase()] = value;
	});
	return out;
}

/** Install a stub that records every call and answers with `response`. */
function stubFetch(response: Response): Recorded[] {
	const calls: Recorded[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: headersToRecord(init?.headers),
			body: typeof init?.body === "string" ? init.body : "",
		});
		return response;
	}) as typeof fetch;
	return calls;
}

/** Install a stub that throws — the network-failure paths. */
function stubFetchThrowing(err: unknown): void {
	globalThis.fetch = (async () => {
		throw err;
	}) as typeof fetch;
}

// Real Response objects, so `.bodyUsed` is meaningful for the assertion below.
const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const openCodeError = (type: string, message: string, status = 401): Response =>
	json({ type: "error", error: { type, message } }, status);

describe("validate-key — OpenCode probe shape", () => {
	it("probes a completion, not the auth-optional listing route", async () => {
		const calls = stubFetch(json({ choices: [{ message: { content: "" } }] }));
		const res = await validateApiKeyOnline("opencode", KEY);

		assert.deepEqual(res, { ok: true });
		assert.equal(calls.length, 1);
		const call = calls[0]!;
		assert.equal(call.url, "https://opencode.ai/zen/v1/chat/completions");
		assert.equal(call.method, "POST");
		assert.equal(call.headers.authorization, `Bearer ${KEY}`);
		assert.equal(call.headers["content-type"], "application/json");
		// Pinned: big-pickle is free and max_tokens:1 keeps it that way even though
		// the typed-key loop re-probes on every retry.
		assert.deepEqual(JSON.parse(call.body), {
			model: "big-pickle",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
			stream: false,
		});
	});

	it("sends Go's probe to the Go base URL with a Go model", async () => {
		const calls = stubFetch(json({ choices: [] }));
		await validateApiKeyOnline("opencode-go", KEY);

		const call = calls[0]!;
		assert.equal(call.url, "https://opencode.ai/zen/go/v1/chat/completions");
		assert.equal(call.headers.authorization, `Bearer ${KEY}`);
		assert.equal(JSON.parse(call.body).model, "mimo-v2.5");
	});

	it("never puts the key in the URL", async () => {
		const calls = stubFetch(json({ choices: [] }));
		await validateApiKeyOnline("opencode", KEY);
		assert.ok(!calls[0]!.url.includes(KEY));
	});

	// The probe posts an OpenAI-shaped body to `<baseUrl>/chat/completions`, so a
	// probe model that Pi serves on a DIFFERENT API surface can never answer it.
	// `opencode-go/minimax-m3` is the trap: it is `anthropic-messages` on
	// `…/zen/go`, so naming it made the Go probe unanswerable — it either
	// soft-accepted every key via ModelError or hard-rejected a good one on a bare
	// 400. Asserted against Pi's own catalogue so a future model swap can't
	// silently reintroduce it.
	for (const providerId of ["opencode", "opencode-go"] as const) {
		it(`${providerId}'s probe model is served on the endpoint the probe posts to`, async () => {
			const calls = stubFetch(json({ choices: [] }));
			await validateApiKeyOnline(providerId, KEY);
			const call = calls[0]!;
			const probeModel = JSON.parse(call.body).model as string;

			const model = getModel(providerId, probeModel as never) as {
				api: string;
				baseUrl: string;
			};
			assert.equal(
				model.api,
				"openai-completions",
				`${providerId}/${probeModel} is served over ${model.api}, not chat-completions`,
			);
			assert.equal(call.url, `${model.baseUrl}/chat/completions`);
		});
	}
});

describe("validate-key — OpenCode reads error.type, not the status", () => {
	// Every case below is HTTP 401 — identical status, different verdicts.
	it("AuthError is the one definitive rejection", async () => {
		stubFetch(openCodeError("AuthError", "Invalid API key."));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, false);
		assert.match(res.ok === false ? res.reason : "", /OpenCode Zen didn't accept this key/);
	});

	it("ModelError soft-accepts — a retired probe model must not condemn the key", async () => {
		stubFetch(openCodeError("ModelError", "Model no-such-model-xyz is not supported"));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /no longer serves the model we test with/);
	});

	it("CreditsError soft-accepts and says the account is out of credits", async () => {
		stubFetch(openCodeError("CreditsError", "Out of credits."));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /out of credits/);
	});

	it("RateLimitError at 401 beats the generic ladder's 401 rejection", async () => {
		stubFetch(openCodeError("RateLimitError", "Slow down."));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /rate-limiting/);
	});

	it("RegionError soft-accepts — the key authenticated to produce it", async () => {
		stubFetch(openCodeError("RegionError", "Region unsupported."));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /region/);
	});

	it("an unknown error type soft-accepts and names the type", async () => {
		stubFetch(openCodeError("WeirdNewError", "something odd happened"));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /"WeirdNewError"/);
	});

	it("an unknown type carrying an auth-shaped message still rejects", async () => {
		stubFetch(openCodeError("TokenError", "Invalid API key."));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, false);
	});

	it("a non-JSON 401 body falls through to the generic ladder", async () => {
		stubFetch(new Response("<html>401</html>", { status: 401 }));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, false);
		assert.match(res.ok === false ? res.reason : "", /didn't accept this key/);
	});

	it("a Go allowance failure names Go and does NOT tell them to subscribe", async () => {
		// GoUsageLimitError means they already HAVE a Go plan and exhausted it, so a
		// "subscribe to Go" hint would contradict the sentence before it.
		stubFetch(openCodeError("GoUsageLimitError", "Go plan limit reached."));
		const res = await validateApiKeyOnline("opencode-go", KEY);
		assert.equal(res.ok, true);
		const warning = res.ok === true ? (res.warning ?? "") : "";
		assert.match(warning, /OpenCode Go accepted the key/);
		assert.match(warning, /allowance is used up/);
		assert.doesNotMatch(warning, /subscription/i);
	});

	it("a prototype-chain type name can't leak a function into the warning", async () => {
		stubFetch(openCodeError("constructor", "weird"));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		const warning = res.ok === true ? (res.warning ?? "") : "";
		assert.match(warning, /answered "constructor"/);
		assert.doesNotMatch(warning, /function|Object\(\)/);
	});

	it("a bare 4xx blames the probe, not the key", async () => {
		// No envelope + 400/404/405 means our own request was malformed or misrouted.
		for (const status of [400, 404, 405]) {
			stubFetch(new Response("Bad Request", { status }));
			const res = await validateApiKeyOnline("opencode", KEY);
			assert.equal(res.ok, true, `HTTP ${status} must not reject the key`);
			assert.match(res.ok === true ? (res.warning ?? "") : "", /rejected the test request \(HTTP/);
		}
	});

	it("a 5xx with no OpenCode envelope still soft-accepts as an outage", async () => {
		stubFetch(new Response("upstream exploded", { status: 503 }));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /temporary issue/);
	});
});

describe("validate-key — the interpretFailure hook changed nothing for other providers", () => {
	it("only a provider WITH an interpreter has its failure body read", async () => {
		const withoutInterpreter = json({ error: "nope" }, 401);
		stubFetch(withoutInterpreter);
		await validateApiKeyOnline("openai", KEY);
		assert.equal(withoutInterpreter.bodyUsed, false, "openai's failure body must never be read");

		const withInterpreter = json({ error: "nope" }, 401);
		stubFetch(withInterpreter);
		await validateApiKeyOnline("opencode", KEY);
		assert.equal(withInterpreter.bodyUsed, true, "opencode must read the body to classify");
	});

	it("anthropic console keys use x-api-key; oauth tokens use Bearer + the beta gate", async () => {
		const consoleCalls = stubFetch(json({ data: [{}] }));
		await validateApiKeyOnline("anthropic", "sk-ant-api03-abc");
		const consoleCall = consoleCalls[0]!;
		assert.equal(consoleCall.url, "https://api.anthropic.com/v1/models?limit=1");
		assert.equal(consoleCall.headers["x-api-key"], "sk-ant-api03-abc");
		assert.equal(consoleCall.headers.authorization, undefined);
		assert.equal(consoleCall.headers["anthropic-version"], "2023-06-01");

		const oauthCalls = stubFetch(json({ data: [{}] }));
		await validateApiKeyOnline("anthropic", "sk-ant-oat01-abc");
		const oauthCall = oauthCalls[0]!;
		assert.equal(oauthCall.headers.authorization, "Bearer sk-ant-oat01-abc");
		assert.equal(oauthCall.headers["x-api-key"], undefined);
		assert.equal(oauthCall.headers["anthropic-beta"], "oauth-2025-04-20");
	});

	it("google puts the key in the query string with no auth header", async () => {
		const calls = stubFetch(json({ models: [{}] }));
		await validateApiKeyOnline("google", "AIzaTestKey");
		const call = calls[0]!;
		// Exact origin, not a substring regex: an unanchored host pattern matches
		// anywhere in the URL, so `evil.com/?x=generativelanguage.googleapis.com`
		// would satisfy it (CodeQL js/incomplete-url-substring-sanitization).
		const url = new URL(call.url);
		assert.equal(url.origin, "https://generativelanguage.googleapis.com");
		assert.equal(url.searchParams.get("key"), "AIzaTestKey");
		assert.equal(call.headers.authorization, undefined);
	});

	it("cerebras is a Bearer GET against /v1/models", async () => {
		const calls = stubFetch(json({ data: [] }));
		await validateApiKeyOnline("cerebras", KEY);
		const call = calls[0]!;
		assert.equal(call.url, "https://api.cerebras.ai/v1/models");
		assert.equal(call.method, "GET");
		assert.equal(call.headers.authorization, `Bearer ${KEY}`);
	});

	it("counts models from a list body, and reports none for an object body", async () => {
		stubFetch(json({ data: [{}, {}, {}] }));
		assert.deepEqual(await validateApiKeyOnline("openai", KEY), { ok: true, modelCount: 3 });

		// OpenRouter's /auth/key answers with an object under `data` — no count.
		stubFetch(json({ data: { label: "my key" } }));
		assert.deepEqual(await validateApiKeyOnline("openrouter", KEY), { ok: true });
	});

	it("401 rejects, 429 and 5xx soft-accept with a warning", async () => {
		stubFetch(json({}, 401));
		const unauthorized = await validateApiKeyOnline("openai", KEY);
		assert.equal(unauthorized.ok, false);
		assert.match(unauthorized.ok === false ? unauthorized.reason : "", /OpenAI didn't accept this key/);

		stubFetch(json({}, 429));
		const busy = await validateApiKeyOnline("groq", KEY);
		assert.equal(busy.ok, true);
		assert.match(busy.ok === true ? (busy.warning ?? "") : "", /Groq is busy right now/);

		stubFetch(json({}, 503));
		const down = await validateApiKeyOnline("mistral", KEY);
		assert.equal(down.ok, true);
		assert.match(down.ok === true ? (down.warning ?? "") : "", /temporary issue/);
	});

	it("an unexpected status refuses and names the provider", async () => {
		stubFetch(json({}, 404));
		const res = await validateApiKeyOnline("xai", KEY);
		assert.equal(res.ok, false);
		assert.match(res.ok === false ? res.reason : "", /xAI couldn't be reached/);
	});
});

describe("validate-key — shared control flow", () => {
	it("ollama reachable but empty hard-fails with the next step", async () => {
		stubFetch(json({ models: [] }));
		const res = await validateApiKeyOnline("ollama", "");
		assert.equal(res.ok, false);
		assert.match(res.ok === false ? res.reason : "", /no models are installed yet/);
	});

	it("ollama with models reports the count", async () => {
		stubFetch(json({ models: [{}, {}] }));
		assert.deepEqual(await validateApiKeyOnline("ollama", ""), { ok: true, modelCount: 2 });
	});

	it("a provider with no configured endpoint never fetches", async () => {
		// The stub throws, so reaching it would fail the test.
		globalThis.fetch = (async () => {
			throw new Error("must not fetch for an unknown provider");
		}) as typeof fetch;
		const res = await validateApiKeyOnline("totally-made-up", KEY);
		assert.equal(res.ok, true);
		assert.match(res.ok === true ? (res.warning ?? "") : "", /No validation endpoint configured/);
	});

	it("a network error reports the provider and the cause", async () => {
		stubFetchThrowing(new Error("boom"));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.equal(res.ok, false);
		assert.match(res.ok === false ? res.reason : "", /Couldn't reach OpenCode Zen: boom/);
	});

	it("an abort reports the timeout", async () => {
		stubFetchThrowing(Object.assign(new Error("aborted"), { name: "AbortError" }));
		const res = await validateApiKeyOnline("opencode", KEY);
		assert.match(res.ok === false ? res.reason : "", /within 8 seconds/);
	});
});
