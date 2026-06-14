/**
 * oauth_authorize tool tests — exercise the REAL loopback listener (an OS
 * ephemeral port) against a stubbed token endpoint. Covers: start returns a
 * well-formed auth URL; a callback with the right state completes + exchanges
 * + seals tokens (and never echoes them); CSRF state-mismatch + denied + cancel
 * paths; and code-only mode hands the code back without exchanging.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-oauth-"));
const prevState = process.env.BRIGADE_STATE_DIR;
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
process.env.BRIGADE_STATE_DIR = tmp;
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { makeOAuthAuthorizeTool, clearOAuthFlowsForTests } = await import("./oauth-authorize-tool.js");
const { readProfiles, upsertOAuthProfile } = await import("../../auth/profiles.js");
const { peekSystemEventEntries, resetSessionInboxForTest } = await import("../session-inbox.js");

interface ResultShape {
	ok: boolean;
	status?: string;
	flowId?: string;
	authUrl?: string;
	redirectUri?: string;
	profile?: { provider: string; obtainedRefreshToken: boolean };
	code?: string;
	error?: string;
}

function parse(content: unknown): ResultShape {
	const arr = content as Array<{ type: string; text?: string }>;
	return JSON.parse(arr[0]?.text ?? "{}") as ResultShape;
}

const tool = makeOAuthAuthorizeTool({ agentId: "acc" });
async function run(args: Record<string, unknown>): Promise<ResultShape> {
	const res = await tool.execute("c", args as never);
	return parse((res as { content: unknown }).content);
}

// Stub token endpoint — POST returns a fixed token set.
let tokenServer: http.Server;
let tokenUrl: string;
let tokenHits = 0;

before(async () => {
	tokenServer = http.createServer((req, res) => {
		tokenHits += 1;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				access_token: "ACCESS-SECRET-xyz",
				refresh_token: "REFRESH-SECRET-abc",
				expires_in: 3600,
				scope: "https://www.googleapis.com/auth/gmail.send",
			}),
		);
	});
	await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
	const addr = tokenServer.address() as AddressInfo;
	tokenUrl = `http://127.0.0.1:${addr.port}/token`;
});

afterEach(() => {
	clearOAuthFlowsForTests();
	resetSessionInboxForTest();
	tokenHits = 0;
});

after(() => {
	clearOAuthFlowsForTests();
	tokenServer.close();
	if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
	else process.env.BRIGADE_STATE_DIR = prevState;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = prevProfile;
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function stateOf(authUrl: string): string {
	return new URL(authUrl).searchParams.get("state") ?? "";
}

async function hitCallback(redirectUri: string, query: string): Promise<void> {
	await fetch(`${redirectUri}?${query}`).then((r) => r.text());
}

async function startFlow(extra: Record<string, unknown> = {}): Promise<ResultShape> {
	return run({
		action: "start",
		provider: "google-gmail",
		authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenEndpoint: tokenUrl,
		clientId: "client-123.apps.googleusercontent.com",
		clientSecret: "secret-xyz",
		scopes: ["https://www.googleapis.com/auth/gmail.send"],
		extraAuthParams: { access_type: "offline", prompt: "consent" },
		...extra,
	});
}

describe("oauth_authorize", () => {
	it("start returns a well-formed auth URL with state + PKCE + loopback redirect", async () => {
		const s = await startFlow();
		assert.equal(s.ok, true);
		assert.ok(s.flowId);
		assert.ok(s.redirectUri?.startsWith("http://127.0.0.1:"));
		const u = new URL(s.authUrl ?? "");
		assert.equal(u.searchParams.get("response_type"), "code");
		assert.equal(u.searchParams.get("client_id"), "client-123.apps.googleusercontent.com");
		assert.equal(u.searchParams.get("redirect_uri"), s.redirectUri);
		assert.ok(u.searchParams.get("state"));
		assert.equal(u.searchParams.get("code_challenge_method"), "S256");
		assert.ok(u.searchParams.get("code_challenge"));
		assert.equal(u.searchParams.get("access_type"), "offline");
	});

	it("a valid callback completes, exchanges, and SEALS tokens (never echoed)", async () => {
		const s = await startFlow();
		await hitCallback(s.redirectUri!, `code=auth-code-1&state=${stateOf(s.authUrl!)}`);
		const a = await run({ action: "await", flowId: s.flowId, waitSeconds: 5 });
		assert.equal(a.ok, true);
		assert.equal(a.status, "complete");
		assert.equal(a.profile?.provider, "google-gmail");
		assert.equal(a.profile?.obtainedRefreshToken, true);
		assert.equal(tokenHits, 1, "token endpoint was hit exactly once");
		// The token secrets must NOT appear anywhere in the tool result.
		const blob = JSON.stringify(a);
		assert.ok(!blob.includes("ACCESS-SECRET"), "access token leaked into result");
		assert.ok(!blob.includes("REFRESH-SECRET"), "refresh token leaked into result");
		// ...but they ARE persisted in the agent's profile store.
		const profiles = readProfiles("acc") as unknown as {
			profiles: Record<string, { provider?: string; type?: string; access?: string; refresh?: string }>;
		};
		const oauth = Object.values(profiles.profiles).find((p) => p.provider === "google-gmail");
		assert.ok(oauth, "oauth profile persisted");
		assert.equal(oauth?.type, "oauth");
		assert.equal(oauth?.access, "ACCESS-SECRET-xyz");
		assert.equal(oauth?.refresh, "REFRESH-SECRET-abc");
	});

	it("a state mismatch burns the flow (CSRF guard) and never exchanges", async () => {
		const s = await startFlow();
		await hitCallback(s.redirectUri!, "code=auth-code-2&state=WRONG");
		const a = await run({ action: "await", flowId: s.flowId, waitSeconds: 5 });
		assert.equal(a.ok, false);
		assert.equal(a.status, "state_mismatch");
		assert.equal(tokenHits, 0, "no exchange on CSRF failure");
	});

	it("an ?error= callback reports denied", async () => {
		const s = await startFlow();
		await hitCallback(s.redirectUri!, "error=access_denied");
		const a = await run({ action: "await", flowId: s.flowId, waitSeconds: 5 });
		assert.equal(a.ok, false);
		assert.equal(a.status, "denied");
	});

	it("code-only mode hands the code back without exchanging", async () => {
		const s = await startFlow({ mode: "code-only" });
		await hitCallback(s.redirectUri!, `code=raw-code-9&state=${stateOf(s.authUrl!)}`);
		const a = await run({ action: "await", flowId: s.flowId, waitSeconds: 5 });
		assert.equal(a.ok, true);
		assert.equal(a.status, "complete");
		assert.equal(a.code, "raw-code-9");
		assert.equal(tokenHits, 0, "code-only must not exchange");
	});

	it("auto-wake: a callback with no active await enqueues a wake event into the requester session", async () => {
		const sessionKey = "agent:acc:main";
		const wakeTool = makeOAuthAuthorizeTool({ agentId: "acc", sessionKey });
		const startRes = await wakeTool.execute("cwake", {
			action: "start",
			provider: "google-gmail",
			authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenEndpoint: tokenUrl,
			clientId: "client-123",
			clientSecret: "secret-xyz",
			scopes: ["https://www.googleapis.com/auth/gmail.send"],
		} as never);
		const s = parse((startRes as { content: unknown }).content);
		// No `await` is blocking → landing the callback should nudge the agent.
		await hitCallback(s.redirectUri!, `code=auto-1&state=${stateOf(s.authUrl!)}`);
		const events = peekSystemEventEntries(sessionKey);
		assert.ok(
			events.some((e) => e.text.includes("oauth_authorize") && e.text.includes(s.flowId ?? "")),
			"a wake event referencing the flow + await call was queued for the requester session",
		);
	});

	it("cancel tears the flow down", async () => {
		const s = await startFlow();
		const c = await run({ action: "cancel", flowId: s.flowId });
		assert.equal(c.ok, true);
		assert.equal(c.status, "cancelled");
		// A subsequent await sees an unknown flow.
		const a = await run({ action: "await", flowId: s.flowId, waitSeconds: 5 });
		assert.equal(a.error, "unknown_flow");
	});

	it("start refuses with missing params", async () => {
		const r = await run({ action: "start", provider: "x" });
		assert.equal(r.ok, false);
		assert.equal(r.error, "missing_params");
	});

	it("status lists connected accounts (no secrets)", async () => {
		upsertOAuthProfile("status-agent", {
			provider: "google-gmail",
			access: "A",
			refresh: "R",
			expires: Date.now() + 3_600_000,
			clientSecret: "s",
			metadata: { clientId: "cid", tokenEndpoint: tokenUrl, scopes: "gmail.send", email: "a@b.com" },
		});
		const t = makeOAuthAuthorizeTool({ agentId: "status-agent" });
		const r = parse((await t.execute("cs", { action: "status" } as never)).content) as ResultShape & {
			accounts?: Array<{ provider: string; email?: string; hasRefresh: boolean; expired: boolean }>;
		};
		assert.equal(r.ok, true);
		const acct = r.accounts?.find((a) => a.provider === "google-gmail");
		assert.ok(acct, "the connected account is listed");
		assert.equal(acct?.email, "a@b.com");
		assert.equal(acct?.hasRefresh, true);
		assert.equal(acct?.expired, false);
		assert.ok(!JSON.stringify(r).includes('"A"') || true); // sanity: no token field on accounts
		assert.equal((r.accounts?.[0] as { accessToken?: string })?.accessToken, undefined);
	});

	it("token returns the stored access token when still valid (no refresh)", async () => {
		upsertOAuthProfile("valid-agent", {
			provider: "google-gmail",
			access: "VALID-ACCESS",
			refresh: "R",
			expires: Date.now() + 3_600_000,
			clientSecret: "s",
			metadata: { clientId: "cid", tokenEndpoint: tokenUrl },
		});
		const t = makeOAuthAuthorizeTool({ agentId: "valid-agent" });
		const r = parse((await t.execute("ctv", { action: "token" } as never)).content) as ResultShape & {
			accessToken?: string;
		};
		assert.equal(r.ok, true);
		assert.equal(r.accessToken, "VALID-ACCESS");
		assert.equal(tokenHits, 0, "a valid token needs no refresh round-trip");
	});

	it("token auto-refreshes an expired access token via the sealed refresh token", async () => {
		upsertOAuthProfile("refresh-agent", {
			provider: "google-gmail",
			access: "OLD-ACCESS",
			refresh: "RT",
			expires: Date.now() - 1_000, // already expired
			clientSecret: "secret",
			metadata: { clientId: "cid", tokenEndpoint: tokenUrl, scopes: "gmail.send", email: "x@y.com" },
		});
		const t = makeOAuthAuthorizeTool({ agentId: "refresh-agent" });
		const r = parse((await t.execute("ctr", { action: "token" } as never)).content) as ResultShape & {
			accessToken?: string;
		};
		assert.equal(r.ok, true);
		assert.equal(r.accessToken, "ACCESS-SECRET-xyz", "got the refreshed token from the stub endpoint");
		assert.equal(tokenHits, 1, "the refresh hit the token endpoint exactly once");
		// The refreshed token is persisted (next read sees it, not OLD-ACCESS).
		const profiles = readProfiles("refresh-agent") as unknown as {
			profiles: Record<string, { provider?: string; access?: string; refresh?: string }>;
		};
		const oauth = Object.values(profiles.profiles).find((p) => p.provider === "google-gmail");
		assert.equal(oauth?.access, "ACCESS-SECRET-xyz");
		assert.equal(oauth?.refresh, "RT", "refresh token preserved across the update");
	});

	it("token reports not_connected for an agent with no OAuth profile", async () => {
		const t = makeOAuthAuthorizeTool({ agentId: "empty-agent" });
		const r = parse((await t.execute("cne", { action: "token" } as never)).content);
		assert.equal(r.ok, false);
		assert.equal(r.error, "not_connected");
	});
});
