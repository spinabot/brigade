import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { getApiProvider, resetApiProviders } from "@earendil-works/pi-ai";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import type { AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

import {
	ANTIGRAVITY_API,
	ANTIGRAVITY_OAUTH_ID,
	antigravityOAuthProvider,
	CLOUD_CODE_ASSIST_BASE,
	createAntigravityStreamFn,
	ensureAntigravityRegistered,
	generatePkce,
	parseAuthCode,
	toGeminiContents,
} from "./transport.js";

/** Build a Response whose body streams the given SSE chunks (verbatim bytes). */
function sseResponse(chunks: string[], status = 200): Response {
	const enc = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			for (const s of chunks) c.enqueue(enc.encode(s));
			c.close();
		},
	});
	return new Response(body, { status });
}

/** Run the transport once against a mocked fetch; return the emitted events + the request the transport sent. */
async function runStream(
	model: Model<string>,
	context: unknown,
	options: Record<string, unknown>,
	fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ events: AssistantMessageEvent[]; sent: { url: string; body: string } | null }> {
	const orig = globalThis.fetch;
	let sent: { url: string; body: string } | null = null;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		sent = { url: String(url), body: String(init?.body ?? "") };
		return fetchImpl(String(url), init ?? {});
	}) as typeof fetch;
	try {
		const streamFn = createAntigravityStreamFn() as unknown as (
			m: Model<string>,
			c: unknown,
			o: Record<string, unknown>,
		) => AsyncIterable<AssistantMessageEvent>;
		const stream = streamFn(model, context, options);
		const events: AssistantMessageEvent[] = [];
		for await (const ev of stream) events.push(ev);
		return { events, sent };
	} finally {
		globalThis.fetch = orig;
	}
}

const AG_MODEL = { api: ANTIGRAVITY_API, provider: "antigravity", id: "antigravity/gemini-3-pro", project: "proj-123" } as unknown as Model<string>;

describe("ensureAntigravityRegistered", () => {
	it("registers both the api:\"antigravity\" transport and the OAuth provider, idempotently", () => {
		ensureAntigravityRegistered();

		const api = getApiProvider(ANTIGRAVITY_API) as { stream?: unknown; streamSimple?: unknown } | undefined;
		assert.ok(api, "getApiProvider(\"antigravity\") resolves");
		assert.equal(typeof api?.stream, "function");
		assert.equal(typeof api?.streamSimple, "function");

		const oauth = getOAuthProvider(ANTIGRAVITY_OAUTH_ID);
		assert.ok(oauth, "getOAuthProvider(\"antigravity\") resolves");
		assert.equal(oauth?.id, ANTIGRAVITY_OAUTH_ID);

		// Second call must not throw and must leave both registries live.
		ensureAntigravityRegistered();
		assert.ok(getApiProvider(ANTIGRAVITY_API), "api still live after a second call");
		assert.ok(getOAuthProvider(ANTIGRAVITY_OAUTH_ID), "oauth still live after a second call");
	});

	it("self-heals after resetApiProviders() wipes the transport (guards on the LIVE registry)", () => {
		ensureAntigravityRegistered();
		assert.ok(getApiProvider(ANTIGRAVITY_API), "registered before the wipe");

		resetApiProviders(); // simulates ModelRegistry.refresh()
		assert.equal(getApiProvider(ANTIGRAVITY_API), undefined, "wiped by resetApiProviders()");

		ensureAntigravityRegistered();
		assert.ok(getApiProvider(ANTIGRAVITY_API), "the transport is live again");
	});

	it("self-heals after resetOAuthProviders() wipes the OAuth provider", () => {
		ensureAntigravityRegistered();
		assert.ok(getOAuthProvider(ANTIGRAVITY_OAUTH_ID), "registered before the wipe");

		resetOAuthProviders(); // simulates a provider-registry reset
		assert.equal(getOAuthProvider(ANTIGRAVITY_OAUTH_ID), undefined, "wiped by resetOAuthProviders()");

		ensureAntigravityRegistered();
		assert.ok(getOAuthProvider(ANTIGRAVITY_OAUTH_ID), "the OAuth provider is live again");
	});
});

describe("antigravityOAuthProvider", () => {
	it("getApiKey returns the access token (Cloud Code Assist uses a Bearer access token)", () => {
		const creds: OAuthCredentials = { access: "ya29.test-access", refresh: "1//test-refresh", expires: 0 };
		assert.equal(antigravityOAuthProvider.getApiKey(creds), "ya29.test-access");
	});

	it("modifyModels stamps api + baseUrl + the discovered project, and leaves others untouched", () => {
		// Credentials carry the project discovered at login — modifyModels is the ONLY
		// channel to get it onto the model (Pi's streamFn options don't carry it).
		const creds = { access: "a", refresh: "r", expires: 0, project: "proj-123" } as OAuthCredentials;
		const models = [
			{ id: "antigravity/gemini-3-pro", provider: "antigravity", api: "openai-completions" },
			{ id: "gpt-4o", provider: "openai", api: "openai-completions" },
		] as unknown as Model<string>[];

		const out = antigravityOAuthProvider.modifyModels!(models, creds);

		const ag = out.find((m) => m.provider === "antigravity")!;
		assert.equal(ag.api, ANTIGRAVITY_API, "antigravity model gets api:\"antigravity\"");
		assert.equal((ag as { baseUrl?: string }).baseUrl, CLOUD_CODE_ASSIST_BASE, "antigravity model gets the CCA base url");
		assert.equal((ag as { project?: string }).project, "proj-123", "the discovered project is stamped onto the model");

		const other = out.find((m) => m.provider === "openai")!;
		assert.equal(other.api, "openai-completions", "non-antigravity model is untouched");
		assert.equal((other as { project?: string }).project, undefined, "non-antigravity model gets no project");
	});

	it("modifyModels omits project when credentials have none", () => {
		const creds = { access: "a", refresh: "r", expires: 0 } as OAuthCredentials;
		const out = antigravityOAuthProvider.modifyModels!(
			[{ id: "antigravity/x", provider: "antigravity", api: "x" }] as unknown as Model<string>[],
			creds,
		);
		assert.equal((out[0] as { project?: string }).project, undefined, "no project key when none discovered");
	});
});

describe("toGeminiContents", () => {
	it("maps assistant→model and everything else→user, extracting text", () => {
		const out = toGeminiContents([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		]) as Array<{ role: string; parts: Array<{ text: string }> }>;

		assert.equal(out.length, 2);
		assert.equal(out[0]!.role, "user");
		assert.equal(out[0]!.parts[0]!.text, "hi");
		assert.equal(out[1]!.role, "model", "assistant maps to the Gemini \"model\" role");
		assert.equal(out[1]!.parts[0]!.text, "hello");
	});

	it("flattens array content, keeping only text parts", () => {
		const out = toGeminiContents([
			{
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "image", url: "ignored" },
					{ type: "text", text: "b" },
				],
			},
		]) as Array<{ parts: Array<{ text: string }> }>;

		assert.equal(out[0]!.parts[0]!.text, "ab", "text parts concatenated, non-text dropped");
	});
});

describe("browser OAuth helpers", () => {
	it("generatePkce produces a url-safe verifier + S256 challenge", () => {
		const { verifier, challenge } = generatePkce();
		assert.match(verifier, /^[A-Za-z0-9_-]+$/, "verifier is base64url (no +/= padding)");
		assert.match(challenge, /^[A-Za-z0-9_-]+$/, "challenge is base64url");
		assert.ok(verifier.length >= 43, "verifier meets the PKCE minimum length");
		const { verifier: v2 } = generatePkce();
		assert.notEqual(verifier, v2, "each call is unique");
	});

	it("parseAuthCode reads a bare code, a full redirect URL, and enforces state", () => {
		assert.equal(parseAuthCode("abc123", "st"), "abc123", "bare code passes through");
		assert.equal(
			parseAuthCode("http://127.0.0.1:5000/oauth2callback?code=xyz&state=st", "st"),
			"xyz",
			"extracts code from a redirect URL with matching state",
		);
		assert.throws(
			() => parseAuthCode("http://127.0.0.1:5000/oauth2callback?code=xyz&state=OTHER", "st"),
			/different sign-in/,
			"rejects a state mismatch",
		);
		assert.equal(parseAuthCode("   ", "st"), undefined, "blank input → undefined");
	});
});

describe("createAntigravityStreamFn", () => {
	afterEach(() => {
		// Each test restores fetch in its own finally; this is belt-and-suspenders.
	});

	it("sends the stamped project + stripped model id in the /v1internal envelope and streams text", async () => {
		const { events, sent } = await runStream(
			AG_MODEL,
			{ systemPrompt: "be brief", messages: [{ role: "user", content: "hi" }] },
			{ apiKey: "ya29.tok" },
			async () =>
				sseResponse([
					`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "Hel" }] } }] } })}\n\n`,
					// Second chunk deliberately has NO trailing newline — exercises the flush.
					`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "lo" }] } }] } })}`,
				]),
		);

		assert.ok(sent, "fetch was called");
		assert.match(sent!.url, /v1internal:streamGenerateContent/, "hits the Cloud Code Assist stream endpoint");
		const body = JSON.parse(sent!.body) as { model: string; project: string; request: { contents: unknown[] } };
		assert.equal(body.project, "proj-123", "the stamped project reaches the envelope (fix #1)");
		assert.equal(body.model, "gemini-3-pro", "the antigravity/ prefix is stripped from the model id");

		const types = events.map((e) => e.type);
		assert.equal(types[0], "start", "stream opens with start");
		assert.ok(types.includes("text_delta"), "emits text deltas");
		assert.equal(types.at(-1), "done", "stream closes with done");

		const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		const text = done.message.content.map((c) => ("text" in c ? c.text : "")).join("");
		assert.equal(text, "Hello", "the trailing newline-less chunk is flushed (fix #3)");
	});

	it("emits start BEFORE error when the request fails before the stream started (fix #2)", async () => {
		const { events } = await runStream(
			AG_MODEL,
			{ messages: [{ role: "user", content: "hi" }] },
			{ apiKey: "ya29.tok" },
			async () => new Response("forbidden", { status: 403 }),
		);

		const types = events.map((e) => e.type);
		assert.equal(types[0], "start", "a start is synthesized even though the fetch !ok threw before start");
		assert.equal(types.at(-1), "error", "terminal event is error");
		const err = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
		assert.match(err.error.errorMessage ?? "", /403/, "surfaces the upstream status");
	});
});
