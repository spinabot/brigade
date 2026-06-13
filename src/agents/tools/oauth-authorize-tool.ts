/**
 * `oauth_authorize` tool — first-class OAuth 2.0 authorization-code flow with a
 * one-shot local loopback callback. Exists so an agent NEVER hand-rolls a
 * `node -e "http.createServer(...)"` listener again (production 2026-06-13: an
 * agent fought EADDRINUSE, taskkill, 127.0.0.1-vs-localhost, and a Web-client
 * redirect_uri_mismatch across six manual tries to wire Gmail OAuth).
 *
 * Design (mirrors the reference's `waitForLocalCallback`, hardened):
 *   - `listen(0)` on 127.0.0.1 → an OS-assigned free port, so EADDRINUSE is
 *     structurally impossible (no port juggling, no kill loops).
 *   - The loopback redirect needs NO console registration when the operator
 *     uses a DESKTOP-app OAuth client (a Web client requires an exact
 *     pre-registered redirect path — that mismatch was half the pain).
 *   - CSRF `state` (32 random bytes) is verified on the callback; PKCE S256 by
 *     default. One-shot: the first matching request wins, then the server
 *     closes. A TTL timer reaps an abandoned flow.
 *
 * Two phases so it works over a chat channel (the click URL must reach the user
 * before we block waiting for the redirect):
 *   - `start` → opens the listener, returns the click URL + redirect_uri.
 *   - `await` → long-polls until the browser hits the callback (re-callable);
 *     then, in the default `exchange-and-store` mode, exchanges the code for
 *     tokens and SEALS them into the agent's credential store (never returned,
 *     never logged). `code-only` mode hands the code back instead (opt-out).
 *   - `cancel` → tears a flow down early.
 *
 * Tokens, codes, the client secret, and the PKCE verifier NEVER appear in the
 * tool result (default mode) or the logs — only flowId / provider / status.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { Type, type Static } from "typebox";

import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { readProfiles, upsertOAuthProfile } from "../../auth/profiles.js";
import { createSubsystemLogger } from "../../logging/subsystem-logger.js";
import { enqueueSystemEvent } from "../session-inbox.js";
import { requestHeartbeatNow } from "../heartbeat-wake.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const log = createSubsystemLogger("brigade/oauth");

const CALLBACK_PATH = "/oauth/callback";
const DEFAULT_TTL_SECONDS = 600;
const MAX_PENDING_FLOWS = 4;

const OAuthAuthorizeParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("start"),
			Type.Literal("await"),
			Type.Literal("cancel"),
			Type.Literal("status"),
			Type.Literal("token"),
		],
		{
			description:
				"start = open the listener + get the click URL; await = wait for the redirect (then exchange+store); cancel = tear down; status = list connected OAuth accounts (no secrets); token = get a fresh access token for an account (auto-refreshes) to call its API.",
		},
	),
	// ── start ──
	provider: Type.Optional(
		Type.String({ maxLength: 64, description: "Credential-store profile name, e.g. \"google-gmail\" (start)." }),
	),
	authorizationEndpoint: Type.Optional(
		Type.String({ description: "OAuth authorize URL, e.g. https://accounts.google.com/o/oauth2/v2/auth (start)." }),
	),
	tokenEndpoint: Type.Optional(
		Type.String({ description: "Token URL, e.g. https://oauth2.googleapis.com/token (start; required for exchange-and-store)." }),
	),
	clientId: Type.Optional(Type.String({ description: "OAuth client id (start). Use a DESKTOP-app client for loopback." })),
	clientSecret: Type.Optional(
		Type.String({ maxLength: 512, description: "OAuth client secret (start). Held in memory for the token exchange only; never stored as plaintext or echoed." }),
	),
	scopes: Type.Optional(Type.Array(Type.String(), { description: "Scopes, e.g. [\"https://www.googleapis.com/auth/gmail.send\"] (start)." })),
	extraAuthParams: Type.Optional(
		Type.Record(Type.String(), Type.String(), { description: "Extra auth-URL params, e.g. {access_type:\"offline\", prompt:\"consent\"} for a Google refresh token (start)." }),
	),
	userInfoEndpoint: Type.Optional(
		Type.String({ description: "Optional: a userinfo URL fetched after exchange to capture the account email (needs an openid/email scope). e.g. https://www.googleapis.com/oauth2/v3/userinfo" }),
	),
	usePkce: Type.Optional(Type.Boolean({ description: "PKCE S256. Default true." })),
	mode: Type.Optional(
		Type.Union([Type.Literal("exchange-and-store"), Type.Literal("code-only")], {
			description: "exchange-and-store (default): swap the code for tokens and seal them in the credential store. code-only: hand the code back to you instead.",
		}),
	),
	ttlSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 900, description: "Flow lifetime before the listener reaps itself (start). Default 600." })),
	port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535, description: "ONLY for IdPs that demand an exact registered loopback port. Default: ephemeral (recommended)." })),
	agentId: Type.Optional(Type.String({ description: "Whose credential store the tokens land in. Default: the calling agent." })),
	// ── await / cancel ──
	flowId: Type.Optional(Type.String({ description: "The flow id returned by `start` (await / cancel)." })),
	waitSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 300, description: "How long this await blocks for the redirect. Default 240; re-callable." })),
});

type OAuthAuthorizeArgs = Static<typeof OAuthAuthorizeParams>;

type FlowStatus = "pending" | "complete" | "denied" | "expired" | "state_mismatch" | "cancelled";

interface PendingFlow {
	flowId: string;
	provider: string;
	agentId: string;
	tokenEndpoint?: string;
	clientId: string;
	clientSecret?: string;
	scopes: string[];
	redirectUri: string;
	state: string;
	codeVerifier?: string;
	userInfoEndpoint?: string;
	mode: "exchange-and-store" | "code-only";
	/** Session that started the flow — woken when the callback lands so the
	 *  agent finishes the exchange hands-free (no operator "done" needed). */
	requesterSessionKey?: string;
	server: http.Server;
	status: FlowStatus;
	code?: string;
	errorParam?: string;
	expiresAt: number;
	ttlTimer?: ReturnType<typeof setTimeout>;
	waiters: Array<() => void>;
}

interface OAuthAuthorizeDetails {
	action: "start" | "await" | "cancel" | "status" | "token";
	ok: boolean;
	message: string;
	flowId?: string;
	authUrl?: string;
	redirectUri?: string;
	expiresAt?: number;
	status?: FlowStatus;
	profile?: {
		provider: string;
		agentId: string;
		scopesGranted?: string;
		expiresInSec?: number;
		obtainedRefreshToken: boolean;
		accountEmail?: string;
	};
	// code-only mode (explicit opt-out of storage)
	code?: string;
	codeVerifier?: string;
	returnedState?: string;
	// status — connected accounts (no secrets)
	accounts?: Array<{
		provider: string;
		email?: string;
		scopes?: string;
		expiresAt?: number;
		hasRefresh: boolean;
		expired: boolean;
	}>;
	// token — a fresh access token for ONE account (use it as a Bearer header)
	accessToken?: string;
	tokenExpiresAt?: number;
	error?: string;
}

const FLOWS = new Map<string, PendingFlow>();

/** Test seam — tear down every pending flow + close its listener. */
export function clearOAuthFlowsForTests(): void {
	for (const flow of FLOWS.values()) {
		if (flow.ttlTimer) clearTimeout(flow.ttlTimer);
		try {
			flow.server.close();
		} catch {
			/* ignore */
		}
	}
	FLOWS.clear();
}

function base64Url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function settle(flow: PendingFlow, status: FlowStatus): void {
	flow.status = status;
	if (flow.ttlTimer) {
		clearTimeout(flow.ttlTimer);
		flow.ttlTimer = undefined;
	}
	try {
		flow.server.close();
	} catch {
		/* ignore */
	}
	const waiters = flow.waiters.splice(0);
	for (const w of waiters) {
		try {
			w();
		} catch {
			/* ignore */
		}
	}
}

/** Open the one-shot loopback listener; resolves with the bound port. */
function startListener(flow: PendingFlow, requestedPort: number | undefined): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = flow.server;
		server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
			let parsed: URL;
			try {
				parsed = new URL(req.url ?? "/", "http://127.0.0.1");
			} catch {
				res.writeHead(400).end("bad request");
				return;
			}
			if (parsed.pathname !== CALLBACK_PATH) {
				res.writeHead(404).end("not found");
				return;
			}
			const err = parsed.searchParams.get("error");
			if (err) {
				flow.errorParam = err;
				res.writeHead(200, { "content-type": "text/html" }).end(
					htmlPage("Authorization was declined. You can close this tab and return to Brigade."),
				);
				settle(flow, "denied");
				return;
			}
			const code = parsed.searchParams.get("code");
			const returnedState = parsed.searchParams.get("state");
			if (!code) {
				res.writeHead(200).end("waiting for authorization…");
				return;
			}
			if (returnedState !== flow.state) {
				// CSRF mismatch — burn the flow. Never accept the code.
				res.writeHead(400, { "content-type": "text/html" }).end(
					htmlPage("State mismatch — the authorization could not be verified. Start over."),
				);
				settle(flow, "state_mismatch");
				return;
			}
			flow.code = code;
			res.writeHead(200, { "content-type": "text/html" }).end(
				htmlPage("Authorization received — you can close this tab and return to Brigade."),
			);
			// If an `await` is already blocking on this flow, let IT finish the
			// exchange (settle resolves it). Otherwise the agent ended its turn
			// after handing over the link — wake it so it finishes hands-free,
			// no operator "done" needed.
			const hadWaiter = flow.waiters.length > 0;
			settle(flow, "complete");
			if (!hadWaiter) fireOAuthWake(flow);
		});
		server.on("error", (e) => reject(e));
		server.listen(requestedPort ?? 0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo | null;
			if (!addr) {
				reject(new Error("listener bound but no address"));
				return;
			}
			resolve(addr.port);
		});
	});
}

function htmlPage(message: string): string {
	const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
	return `<!doctype html><meta charset="utf-8"><title>Brigade</title><body style="font-family:system-ui;padding:3rem;color:#1a7f37"><h2>${safe}</h2></body>`;
}

/**
 * Auto-wake: the operator clicked and the callback landed, but the agent ended
 * its turn after handing over the link. Nudge it — enqueue a system event into
 * the requester's session + fire a heartbeat wake (the same inbox+wake spine
 * cron + A2A use), so the woken turn calls `await` and finishes the exchange
 * with no operator "done". Best-effort: if the wake plumbing isn't available
 * (e.g. unit tests), the manual `await` path still works.
 */
function fireOAuthWake(flow: PendingFlow): void {
	const sessionKey = flow.requesterSessionKey;
	if (!sessionKey) return;
	try {
		enqueueSystemEvent(
			`[oauth] The Google authorization you started for "${flow.provider}" just completed. ` +
				`Call oauth_authorize({action:"await", flowId:"${flow.flowId}"}) now to exchange the code and ` +
				`store the tokens, then tell the user the account is connected. The click already happened — ` +
				`do NOT ask them to confirm.`,
			{ sessionKey, contextKey: `oauth:done:${flow.flowId}`, trusted: true },
		);
		requestHeartbeatNow({
			reason: "oauth-callback",
			...(flow.agentId ? { agentId: flow.agentId } : {}),
			sessionKey,
		});
	} catch {
		/* best-effort — `await` still completes the flow manually */
	}
}

async function doStart(
	args: OAuthAuthorizeArgs,
	agentId: string,
	requesterSessionKey?: string,
): Promise<OAuthAuthorizeDetails> {
	const provider = (args.provider ?? "").trim();
	const authorizationEndpoint = (args.authorizationEndpoint ?? "").trim();
	const clientId = (args.clientId ?? "").trim();
	const missing: string[] = [];
	if (!provider) missing.push("provider");
	if (!authorizationEndpoint) missing.push("authorizationEndpoint");
	if (!clientId) missing.push("clientId");
	if (missing.length > 0) {
		return { action: "start", ok: false, message: `start requires: ${missing.join(", ")}.`, error: "missing_params" };
	}
	if (FLOWS.size >= MAX_PENDING_FLOWS) {
		// Reap the oldest to make room rather than refuse outright.
		const oldest = [...FLOWS.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
		if (oldest) {
			settle(oldest, "cancelled");
			FLOWS.delete(oldest.flowId);
		}
	}

	const usePkce = args.usePkce !== false;
	const state = crypto.randomBytes(32).toString("hex");
	const codeVerifier = usePkce ? base64Url(crypto.randomBytes(32)) : undefined;
	const codeChallenge = codeVerifier
		? base64Url(crypto.createHash("sha256").update(codeVerifier).digest())
		: undefined;
	const flowId = crypto.randomUUID();
	const ttlSeconds = args.ttlSeconds ?? DEFAULT_TTL_SECONDS;
	const server = http.createServer();
	const flow: PendingFlow = {
		flowId,
		provider,
		agentId,
		tokenEndpoint: (args.tokenEndpoint ?? "").trim() || undefined,
		clientId,
		clientSecret: (args.clientSecret ?? "").trim() || undefined,
		scopes: Array.isArray(args.scopes) ? args.scopes.filter((s) => typeof s === "string" && s.trim()) : [],
		redirectUri: "",
		state,
		codeVerifier,
		userInfoEndpoint: (args.userInfoEndpoint ?? "").trim() || undefined,
		mode: args.mode === "code-only" ? "code-only" : "exchange-and-store",
		...(requesterSessionKey?.trim() ? { requesterSessionKey: requesterSessionKey.trim() } : {}),
		server,
		status: "pending",
		expiresAt: Date.now() + ttlSeconds * 1000,
		waiters: [],
	};

	let port: number;
	try {
		port = await startListener(flow, args.port);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			action: "start",
			ok: false,
			message:
				args.port !== undefined
					? `Could not bind port ${args.port} (${msg}). Omit \`port\` to use an ephemeral free port.`
					: `Could not open the local callback listener: ${msg}`,
			error: "listen_failed",
		};
	}
	flow.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
	flow.ttlTimer = setTimeout(() => {
		if (flow.status === "pending") settle(flow, "expired");
	}, ttlSeconds * 1000);
	if (typeof (flow.ttlTimer as { unref?: () => void }).unref === "function") {
		(flow.ttlTimer as { unref?: () => void }).unref?.();
	}
	FLOWS.set(flowId, flow);

	const authUrl = new URL(authorizationEndpoint);
	authUrl.searchParams.set("client_id", clientId);
	authUrl.searchParams.set("redirect_uri", flow.redirectUri);
	authUrl.searchParams.set("response_type", "code");
	if (flow.scopes.length > 0) authUrl.searchParams.set("scope", flow.scopes.join(" "));
	authUrl.searchParams.set("state", state);
	if (codeChallenge) {
		authUrl.searchParams.set("code_challenge", codeChallenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
	}
	for (const [k, v] of Object.entries(args.extraAuthParams ?? {})) {
		if (typeof v === "string") authUrl.searchParams.set(k, v);
	}

	log.info("oauth flow started", { flowId, provider, port, mode: flow.mode, scopes: flow.scopes.length });
	return {
		action: "start",
		ok: true,
		message:
			`Authorization listener is live on ${flow.redirectUri}. Send the operator this link to click, then call ` +
			`oauth_authorize({action:"await", flowId:"${flowId}"}). Tip: the OAuth client must be a DESKTOP-app client ` +
			`(a Web client needs this exact redirect URI pre-registered).`,
		flowId,
		authUrl: authUrl.toString(),
		redirectUri: flow.redirectUri,
		expiresAt: flow.expiresAt,
		status: "pending",
	};
}

async function exchangeAndStore(flow: PendingFlow): Promise<OAuthAuthorizeDetails> {
	if (!flow.tokenEndpoint) {
		return { action: "await", ok: false, status: "complete", message: "Code captured, but no tokenEndpoint was provided to exchange it. Re-run start with a tokenEndpoint, or use mode:\"code-only\".", error: "no_token_endpoint" };
	}
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: flow.code ?? "",
		redirect_uri: flow.redirectUri,
		client_id: flow.clientId,
	});
	if (flow.clientSecret) body.set("client_secret", flow.clientSecret);
	if (flow.codeVerifier) body.set("code_verifier", flow.codeVerifier);

	let tokenJson: Record<string, unknown>;
	try {
		const resp = await fetch(flow.tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: body.toString(),
		});
		const text = await resp.text();
		tokenJson = JSON.parse(text) as Record<string, unknown>;
		if (!resp.ok || typeof tokenJson.error === "string") {
			const desc = typeof tokenJson.error_description === "string" ? tokenJson.error_description : `HTTP ${resp.status}`;
			log.warn("oauth token exchange failed", { flowId: flow.flowId, provider: flow.provider, status: resp.status });
			return { action: "await", ok: false, status: "complete", message: `Token exchange failed: ${desc}`, error: "exchange_failed" };
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { action: "await", ok: false, status: "complete", message: `Token exchange request failed: ${msg}`, error: "exchange_failed" };
	}

	const access = typeof tokenJson.access_token === "string" ? tokenJson.access_token : undefined;
	const refresh = typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : undefined;
	const expiresInSec = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : undefined;
	const scopeGranted = typeof tokenJson.scope === "string" ? tokenJson.scope : flow.scopes.join(" ");

	// Optional: fetch the account email so the agent doesn't have to ask.
	let accountEmail: string | undefined;
	if (flow.userInfoEndpoint && access) {
		try {
			const ui = await fetch(flow.userInfoEndpoint, { headers: { authorization: `Bearer ${access}` } });
			if (ui.ok) {
				const uj = (await ui.json()) as { email?: unknown };
				if (typeof uj.email === "string") accountEmail = uj.email;
			}
		} catch {
			/* email is best-effort */
		}
	}

	upsertOAuthProfile(flow.agentId, {
		provider: flow.provider,
		...(access ? { access } : {}),
		...(refresh ? { refresh } : {}),
		...(expiresInSec !== undefined ? { expires: Date.now() + expiresInSec * 1000 } : {}),
		// Sealed client secret + the token endpoint (in metadata) let the `token`
		// action mint a fresh access token from the refresh token when this one
		// expires — without a re-auth and without the secret ever touching plaintext.
		...(flow.clientSecret ? { clientSecret: flow.clientSecret } : {}),
		metadata: {
			clientId: flow.clientId,
			...(flow.tokenEndpoint ? { tokenEndpoint: flow.tokenEndpoint } : {}),
			...(scopeGranted ? { scopes: scopeGranted } : {}),
			...(accountEmail ? { email: accountEmail } : {}),
		},
	});
	log.info("oauth tokens stored", { flowId: flow.flowId, provider: flow.provider, agentId: flow.agentId, refresh: Boolean(refresh) });

	return {
		action: "await",
		ok: true,
		status: "complete",
		message:
			`Authorized${accountEmail ? ` as ${accountEmail}` : ""} and sealed the tokens into ${flow.agentId}'s "${flow.provider}" credential profile.` +
			(refresh ? "" : " NOTE: no refresh_token was returned — for Google add access_type=offline & prompt=consent to extraAuthParams so re-auth isn't needed."),
		profile: {
			provider: flow.provider,
			agentId: flow.agentId,
			...(scopeGranted ? { scopesGranted: scopeGranted } : {}),
			...(expiresInSec !== undefined ? { expiresInSec } : {}),
			obtainedRefreshToken: Boolean(refresh),
			...(accountEmail ? { accountEmail } : {}),
		},
	};
}

async function doAwait(args: OAuthAuthorizeArgs): Promise<OAuthAuthorizeDetails> {
	const flowId = (args.flowId ?? "").trim();
	const flow = flowId ? FLOWS.get(flowId) : undefined;
	if (!flow) {
		return { action: "await", ok: false, message: "Unknown or already-finished flowId. Call start first (flows are one-shot).", error: "unknown_flow" };
	}

	if (flow.status === "pending") {
		const waitSeconds = args.waitSeconds ?? 240;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, waitSeconds * 1000);
			if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref?: () => void }).unref?.();
			flow.waiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	switch (flow.status) {
		case "pending":
			return {
				action: "await",
				ok: true,
				status: "pending",
				flowId,
				message: "Still waiting for the operator to authorize. Tell them to click the link, then call await again.",
			};
		case "denied":
			FLOWS.delete(flowId);
			return { action: "await", ok: false, status: "denied", message: `The operator declined authorization (${flow.errorParam ?? "access_denied"}).`, error: flow.errorParam ?? "access_denied" };
		case "expired":
			FLOWS.delete(flowId);
			return { action: "await", ok: false, status: "expired", message: "The authorization window expired before the operator clicked. Start a new flow.", error: "expired" };
		case "state_mismatch":
			FLOWS.delete(flowId);
			return { action: "await", ok: false, status: "state_mismatch", message: "The callback failed CSRF verification (state mismatch). Start a new flow.", error: "state_mismatch" };
		case "cancelled":
			FLOWS.delete(flowId);
			return { action: "await", ok: false, status: "cancelled", message: "The flow was cancelled.", error: "cancelled" };
		case "complete": {
			if (flow.mode === "code-only") {
				FLOWS.delete(flowId);
				return {
					action: "await",
					ok: true,
					status: "complete",
					message: "Authorization code captured (code-only mode). Exchange it yourself; the code is single-use and short-lived.",
					code: flow.code,
					codeVerifier: flow.codeVerifier,
					returnedState: flow.state,
				};
			}
			const result = await exchangeAndStore(flow);
			FLOWS.delete(flowId);
			return result;
		}
	}
}

function doCancel(args: OAuthAuthorizeArgs): OAuthAuthorizeDetails {
	const flowId = (args.flowId ?? "").trim();
	const flow = flowId ? FLOWS.get(flowId) : undefined;
	if (!flow) return { action: "cancel", ok: true, message: "No such flow (already finished or never started)." };
	settle(flow, "cancelled");
	FLOWS.delete(flowId);
	return { action: "cancel", ok: true, status: "cancelled", message: "Flow cancelled and listener closed." };
}

/* ─────────────────────────── status + token (use the stored creds) ─────────────────────────── */

interface StoredOAuthProfile {
	provider: string;
	access?: string;
	refresh?: string;
	/** OAuth client secret, read back from the sealed `key` column. */
	clientSecret?: string;
	expires?: number;
	clientId?: string;
	tokenEndpoint?: string;
	scopes?: string;
	email?: string;
}

/** Read the agent's stored OAuth profiles (decrypted by the auth store on read). */
function readOAuthProfiles(agentId: string): StoredOAuthProfile[] {
	try {
		const parsed = readProfiles(agentId) as unknown as {
			profiles?: Record<
				string,
				{
					provider?: string;
					type?: string;
					key?: string;
					access?: string;
					refresh?: string;
					expires?: number;
					metadata?: { clientId?: unknown; tokenEndpoint?: unknown; scopes?: unknown; email?: unknown };
				}
			>;
		};
		const out: StoredOAuthProfile[] = [];
		for (const p of Object.values(parsed.profiles ?? {})) {
			if (p?.type !== "oauth") continue;
			const meta = p.metadata ?? {};
			out.push({
				provider: typeof p.provider === "string" ? p.provider : "",
				access: typeof p.access === "string" ? p.access : undefined,
				refresh: typeof p.refresh === "string" ? p.refresh : undefined,
				clientSecret: typeof p.key === "string" ? p.key : undefined,
				expires: typeof p.expires === "number" ? p.expires : undefined,
				clientId: typeof meta.clientId === "string" ? meta.clientId : undefined,
				tokenEndpoint: typeof meta.tokenEndpoint === "string" ? meta.tokenEndpoint : undefined,
				scopes: typeof meta.scopes === "string" ? meta.scopes : undefined,
				email: typeof meta.email === "string" ? meta.email : undefined,
			});
		}
		return out.filter((p) => p.provider.length > 0);
	} catch {
		return [];
	}
}

function selectOAuthProfile(
	profiles: StoredOAuthProfile[],
	requested: string | undefined,
): StoredOAuthProfile | { error: string } {
	const want = (requested ?? "").trim();
	if (want) {
		const hit = profiles.find((p) => p.provider === want);
		return hit ?? { error: `No connected OAuth account named "${want}". Use action:"status" to list them.` };
	}
	if (profiles.length === 0) return { error: 'No OAuth accounts are connected. Run action:"start" first.' };
	if (profiles.length === 1) return profiles[0]!;
	return {
		error: `Multiple OAuth accounts connected (${profiles.map((p) => p.provider).join(", ")}). Pass provider:"<id>" to pick one.`,
	};
}

/** Treat a token as expired this far before its real expiry (clock-skew margin). */
const ACCESS_SKEW_MS = 60_000;

function doStatus(args: OAuthAuthorizeArgs, agentId: string): OAuthAuthorizeDetails {
	const profiles = readOAuthProfiles(agentId);
	const now = Date.now();
	return {
		action: "status",
		ok: true,
		message:
			profiles.length === 0
				? "No OAuth accounts are connected for this agent. Run oauth_authorize({action:\"start\", …}) to connect one."
				: `${profiles.length} connected OAuth account(s). Use action:"token" to get a usable access token.`,
		accounts: profiles.map((p) => ({
			provider: p.provider,
			...(p.email ? { email: p.email } : {}),
			...(p.scopes ? { scopes: p.scopes } : {}),
			...(p.expires !== undefined ? { expiresAt: p.expires } : {}),
			hasRefresh: Boolean(p.refresh),
			expired: p.expires !== undefined ? p.expires <= now : false,
		})),
	};
}

async function doToken(args: OAuthAuthorizeArgs, agentId: string): Promise<OAuthAuthorizeDetails> {
	const selected = selectOAuthProfile(readOAuthProfiles(agentId), args.provider);
	if ("error" in selected) {
		return { action: "token", ok: false, message: selected.error, error: "not_connected" };
	}
	const p = selected;
	const now = Date.now();

	// Still valid → hand the access token back for an API call.
	if (p.access && p.expires !== undefined && p.expires > now + ACCESS_SKEW_MS) {
		return {
			action: "token",
			ok: true,
			message: `Fresh access token for "${p.provider}"${p.email ? ` (${p.email})` : ""} — use it as the Authorization: Bearer header. Expires in ~${Math.round((p.expires - now) / 60000)} min.`,
			accessToken: p.access,
			tokenExpiresAt: p.expires,
		};
	}

	// Expired / unknown-expiry → refresh if we can; otherwise be honest.
	if (!p.refresh || !p.clientSecret || !p.tokenEndpoint || !p.clientId) {
		if (p.access && p.expires === undefined) {
			return {
				action: "token",
				ok: true,
				message: `Access token for "${p.provider}" (expiry unknown — if the API rejects it as expired, reconnect with action:"start").`,
				accessToken: p.access,
			};
		}
		return {
			action: "token",
			ok: false,
			message: `The "${p.provider}" access token has expired and can't be auto-refreshed (missing refresh token or client secret). Reconnect with action:"start".`,
			error: "needs_reauth",
		};
	}

	try {
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: p.refresh,
			client_id: p.clientId,
			client_secret: p.clientSecret,
		});
		const resp = await fetch(p.tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: body.toString(),
		});
		const json = JSON.parse(await resp.text()) as Record<string, unknown>;
		if (!resp.ok || typeof json.error === "string") {
			const code = typeof json.error === "string" ? json.error : `http_${resp.status}`;
			const desc = typeof json.error_description === "string" ? json.error_description : "";
			log.warn("oauth refresh failed", { provider: p.provider, agentId, status: resp.status, error: code });
			return {
				action: "token",
				ok: false,
				message: `Token refresh failed [${code}${desc ? `: ${desc}` : ""}]. Reconnect with action:"start".`,
				error: code,
			};
		}
		const newAccess = typeof json.access_token === "string" ? json.access_token : undefined;
		const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : undefined;
		if (!newAccess) {
			return { action: "token", ok: false, message: `Refresh returned no access token for "${p.provider}".`, error: "refresh_no_token" };
		}
		const newExpires = expiresInSec !== undefined ? now + expiresInSec * 1000 : undefined;
		// Persist the new access token — preserve refresh, client secret, metadata.
		upsertOAuthProfile(agentId, {
			provider: p.provider,
			access: newAccess,
			...(p.refresh ? { refresh: p.refresh } : {}),
			...(newExpires !== undefined ? { expires: newExpires } : {}),
			...(p.clientSecret ? { clientSecret: p.clientSecret } : {}),
			metadata: {
				...(p.clientId ? { clientId: p.clientId } : {}),
				...(p.tokenEndpoint ? { tokenEndpoint: p.tokenEndpoint } : {}),
				...(p.scopes ? { scopes: p.scopes } : {}),
				...(p.email ? { email: p.email } : {}),
			},
		});
		log.info("oauth token refreshed", { provider: p.provider, agentId });
		return {
			action: "token",
			ok: true,
			message: `Refreshed the "${p.provider}" access token — use it as the Authorization: Bearer header.${newExpires ? ` Expires in ~${Math.round((newExpires - now) / 60000)} min.` : ""}`,
			accessToken: newAccess,
			...(newExpires !== undefined ? { tokenExpiresAt: newExpires } : {}),
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { action: "token", ok: false, message: `Token refresh request failed: ${msg}. Reconnect with action:"start".`, error: "refresh_failed" };
	}
}

export interface MakeOAuthAuthorizeToolOptions {
	/** Caller's agent id — default target for the sealed credential profile. */
	agentId?: string;
	/** Per-turn session key — recorded on the flow so the auto-wake knows which
	 *  session to nudge when the callback lands. */
	sessionKey?: string;
}

export function makeOAuthAuthorizeTool(
	opts: MakeOAuthAuthorizeToolOptions = {},
): BrigadeTool<typeof OAuthAuthorizeParams, OAuthAuthorizeDetails> {
	const defaultAgentId = opts.agentId ?? DEFAULT_AGENT_ID;
	return {
		name: "oauth_authorize",
		label: "OAuth Authorize",
		displaySummary: "running an OAuth flow",
		// Owner-gated: this binds a real credential into the operator's store and
		// opens a localhost listener — only the operator (and their own DMs,
		// which run as owner) should drive it.
		ownerOnly: true,
		description: [
			"Run an OAuth 2.0 authorization-code flow with a one-shot local callback — use this INSTEAD of hand-rolling an http listener in bash.",
			'action="start": opens a loopback listener on an ephemeral port and returns `authUrl` (send it to the operator to click) + `redirectUri`. Pass provider, authorizationEndpoint, tokenEndpoint, clientId, clientSecret, scopes, and (for a Google refresh token) extraAuthParams {access_type:"offline", prompt:"consent"}.',
			'action="await": call with the `flowId` from start; it blocks until the operator authorizes, then exchanges the code and SEALS the tokens into the credential store (default). Re-callable if it returns status "pending".',
			'action="cancel": tear a flow down.',
			'action="status": list the OAuth accounts already connected for this agent (provider, email, scopes, expiry) — no secrets. Use it to check what is connected before reconnecting.',
			'action="token": get a usable access token for a connected account (pass provider:"<id>" if more than one) — it returns `accessToken` (auto-refreshing from the sealed refresh token when expired) so you can call the API, e.g. Gmail send: POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send with Authorization: Bearer <accessToken>. Get the token from THIS action; never dig in the credential store or files.',
			"Use a DESKTOP-app OAuth client (loopback redirects need no console registration; a Web client requires the exact redirect URI pre-registered). Gmail send scope is https://www.googleapis.com/auth/gmail.send. The refresh token + client secret stay sealed; only the short-lived access token is ever handed back (via action:\"token\").",
		].join(" "),
		parameters: OAuthAuthorizeParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<OAuthAuthorizeDetails>> => {
			const agentId = (args.agentId ?? "").trim() || defaultAgentId;
			let details: OAuthAuthorizeDetails;
			if (args.action === "start") details = await doStart(args, agentId, opts.sessionKey);
			else if (args.action === "await") details = await doAwait(args);
			else if (args.action === "status") details = doStatus(args, agentId);
			else if (args.action === "token") details = await doToken(args, agentId);
			else details = doCancel(args);
			return jsonResult(details) as AgentToolResult<OAuthAuthorizeDetails>;
		},
	};
}
