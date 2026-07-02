// Google Antigravity provider — OAuth login + a native transport for Google's
// Cloud Code Assist "/v1internal" API (the endpoint Antigravity/Gemini-CLI use).
//
// WHY a custom transport (not Pi's `google` provider): an Antigravity login does
// NOT grant the public Gemini API (generativelanguage.googleapis.com). Models are
// served only through the private Cloud Code Assist endpoint at
// `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`, which wraps
// Gemini `contents`/`parts` in a `{ project, model, request }` envelope and
// requires Antigravity's client headers. So we register a custom Pi OAuth provider
// (id "antigravity") + a custom Pi API provider (api "antigravity"), exactly like
// the Ollama-native pattern.
//
// ⚠ LIVE-VALIDATE: the `/v1internal` shape, headers, and the project-discovery
// handshake are reverse-engineered (Antigravity ships no public API). Everything
// tagged `LIVE-VALIDATE` below needs confirming against a real Antigravity account;
// the OAuth CLIENT_SECRET for the browser flow is the gemini-cli public value and
// must be filled in. The CLI-reuse path (~/.gemini/oauth_creds.json) needs neither.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
	createAssistantMessageEventStream,
	getApiProvider,
	registerApiProvider,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { getOAuthProvider, registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/* ─────────────────────────── constants ─────────────────────────── */

export const ANTIGRAVITY_API = "antigravity";
export const ANTIGRAVITY_PROVIDER = "antigravity";
export const ANTIGRAVITY_OAUTH_ID = "antigravity";

/** Cloud Code Assist base — models are served here, NOT the public Gemini API. */
export const CLOUD_CODE_ASSIST_BASE = "https://cloudcode-pa.googleapis.com";
const STREAM_URL = `${CLOUD_CODE_ASSIST_BASE}/v1internal:streamGenerateContent?alt=sse`;
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_BASE}/v1internal:loadCodeAssist`;

// OAuth client for Antigravity's Google sign-in — OPERATOR-SUPPLIED ONLY. Brigade
// ships NO client secret: GitHub push-protection AND our own safety guard block
// embedding it (obfuscated or not), and Google's Antigravity Terms prohibit
// third-party use with reports of account bans (see the catalog entry's warning).
// To enable browser sign-in, set BRIGADE_ANTIGRAVITY_CLIENT_ID + _SECRET (e.g. to
// the values a public Antigravity auth plugin uses, or your own Google OAuth
// client). Without them, browser login is unavailable and Brigade says so clearly.
const GOOGLE_CLIENT_ID = process.env.BRIGADE_ANTIGRAVITY_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.BRIGADE_ANTIGRAVITY_CLIENT_SECRET ?? "";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
// Scopes the Antigravity client requests — including the cclog +
// experimentsandconfigs scopes its backend expects (per the reverse-engineered spec).
const OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Client platform tag the backend expects, from the host OS. */
function clientPlatform(): string {
	return process.platform === "darwin" ? "MACOS" : process.platform === "win32" ? "WINDOWS" : "LINUX";
}

/** Headers every Cloud Code Assist call needs — the backend gates on ideType +
 *  client metadata. Mirrors the Antigravity client (per the reverse-engineered spec). */
function antigravityHeaders(accessToken: string): Record<string, string> {
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": `antigravity/1.15.8 ${os}/${arch}`,
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: clientPlatform(), pluginType: "GEMINI" }),
	};
}

/* ─────────────────────────── OAuth provider ─────────────────────────── */

interface AntigravityCreds extends OAuthCredentials {
	/** Discovered GCP project id (from loadCodeAssist) — required in the envelope. */
	project?: string;
}

/** Best-effort project discovery — the `/v1internal` envelope needs a project id.
 *  LIVE-VALIDATE: exact request/response shape of loadCodeAssist/onboardUser. */
async function discoverProject(accessToken: string): Promise<string | undefined> {
	try {
		const res = await fetch(LOAD_CODE_ASSIST_URL, {
			method: "POST",
			headers: antigravityHeaders(accessToken),
			body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { cloudaicompanionProject?: string; project?: string };
		return body.cloudaicompanionProject ?? body.project ?? undefined;
	} catch {
		return undefined;
	}
}

async function refreshGoogleToken(refresh: string): Promise<AntigravityCreds> {
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refresh,
			client_id: GOOGLE_CLIENT_ID,
			...(GOOGLE_CLIENT_SECRET ? { client_secret: GOOGLE_CLIENT_SECRET } : {}),
		}).toString(),
	});
	if (!res.ok) throw new Error(`Antigravity token refresh failed (${res.status})`);
	const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
	return {
		access: body.access_token,
		refresh: body.refresh_token ?? refresh,
		expires: Date.now() + (body.expires_in ?? 3600) * 1000,
	};
}

/* ─────────── browser OAuth: PKCE + localhost loopback (like Pi's codex) ─────────── */

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function browserResultPage(message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Brigade · Antigravity</title></head><body style="font-family:system-ui,-apple-system,sans-serif;padding:3rem;text-align:center;color:#222"><h2>${message}</h2></body></html>`;
}

interface LoopbackServer {
	redirectUri: string;
	waitForCode(): Promise<{ code: string } | null>;
	cancelWait(): void;
	close(): void;
}

/** Localhost callback server on an ephemeral port; resolves with the code Google
 *  redirects back after the user approves. Mirrors Pi's codex loopback provider. */
async function startLoopbackServer(state: string): Promise<LoopbackServer> {
	let settle: ((v: { code: string } | null) => void) | undefined;
	let settled = false;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		settle = (v) => {
			if (settled) return;
			settled = true;
			resolve(v);
		};
	});
	const server = createServer((req, res) => {
		try {
			const url = new URL(req.url ?? "", "http://127.0.0.1");
			if (url.pathname !== "/oauth2callback") {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.end(browserResultPage("Sign-in couldn't be verified (state mismatch). Close this window and try again."));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				const err = url.searchParams.get("error");
				res.statusCode = 400;
				res.end(browserResultPage(`Sign-in ${err ? `failed (${err})` : "was cancelled"}. You can close this window.`));
				settle?.(null);
				return;
			}
			res.statusCode = 200;
			res.end(browserResultPage("Antigravity sign-in complete — close this window and return to Brigade."));
			settle?.({ code });
		} catch {
			res.statusCode = 500;
			res.end("Internal error");
		}
	});
	return new Promise<LoopbackServer>((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = addr && typeof addr === "object" ? addr.port : 0;
			resolve({
				redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
				waitForCode: () => waitForCodePromise,
				cancelWait: () => settle?.(null),
				close: () => {
					try {
						server.close();
					} catch {
						/* ignore */
					}
				},
			});
		});
	});
}

/** Parse a pasted authorization code or full redirect URL. Throws on state mismatch. */
export function parseAuthCode(input: string, expectedState: string): string | undefined {
	const v = input.trim();
	if (!v) return undefined;
	try {
		const url = new URL(v);
		const s = url.searchParams.get("state");
		if (s && s !== expectedState) throw new Error("__state_mismatch__");
		return url.searchParams.get("code") ?? undefined;
	} catch (e) {
		if (e instanceof Error && e.message === "__state_mismatch__") {
			throw new Error("That code was from a different sign-in attempt — please retry.");
		}
		return v; // not a URL — treat the whole string as the raw code
	}
}

/** Exchange an authorization code for Google tokens (installed-app PKCE). */
async function exchangeAntigravityCode(
	code: string,
	verifier: string,
	redirectUri: string,
): Promise<{ access: string; refresh: string; expires: number }> {
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: GOOGLE_CLIENT_ID,
			...(GOOGLE_CLIENT_SECRET ? { client_secret: GOOGLE_CLIENT_SECRET } : {}),
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}).toString(),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`Google sign-in couldn't be completed (${res.status})${detail ? `: ${detail.slice(0, 150)}` : ""}`);
	}
	const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!body.access_token) throw new Error("Google returned no access token.");
	return {
		access: body.access_token,
		refresh: body.refresh_token ?? "",
		expires: Date.now() + (body.expires_in ?? 3600) * 1000,
	};
}

export const antigravityOAuthProvider: OAuthProviderInterface = {
	id: ANTIGRAVITY_OAUTH_ID,
	name: "Google Antigravity",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		// Antigravity runs its OWN Google OAuth (it does NOT reuse the Gemini CLI's
		// token — that's a separate, now-deprecated product). Browser sign-in needs an
		// OAuth client, which Brigade does not ship, so it's available only when the
		// operator supplies one via env.
		if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
			throw new Error(
				"Antigravity sign-in isn't configured. Set BRIGADE_ANTIGRAVITY_CLIENT_ID and " +
					"BRIGADE_ANTIGRAVITY_CLIENT_SECRET to a Google OAuth client, then sign in. Note: Google's " +
					"Antigravity Terms prohibit third-party use and accounts have been banned — use at your own risk.",
			);
		}
		// Browser path — Google installed-app OAuth (PKCE + localhost loopback), the
		// same shape as Pi's codex/anthropic providers: the user approves in the
		// browser and Google redirects the code back to the loopback (or they paste
		// it). LIVE-VALIDATE: the exact scopes/consent Antigravity expects.
		const { verifier, challenge } = generatePkce();
		const state = base64url(randomBytes(16));
		const server = await startLoopbackServer(state);
		try {
			const authUrl = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
				client_id: GOOGLE_CLIENT_ID,
				redirect_uri: server.redirectUri,
				response_type: "code",
				scope: OAUTH_SCOPES.join(" "),
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
				access_type: "offline",
				prompt: "consent",
			}).toString()}`;
			callbacks.onAuth({
				url: authUrl,
				instructions: "Approve the Google sign-in for the account tied to your Antigravity access.",
			});

			// Race the loopback callback against a manual code / redirect-URL paste, so
			// login still completes if the browser can't reach the local server.
			let code: string | undefined;
			if (callbacks.onManualCodeInput) {
				let manualVal: string | null = null;
				let manualErr: Error | null = null;
				const manualPromise = callbacks
					.onManualCodeInput()
					.then((v) => {
						manualVal = v;
						server.cancelWait();
					})
					.catch((e: unknown) => {
						manualErr = e instanceof Error ? e : new Error(String(e));
						server.cancelWait();
					});
				const result = await server.waitForCode();
				if (manualErr) throw manualErr;
				if (result?.code) code = result.code;
				else if (manualVal) code = parseAuthCode(manualVal, state);
				if (!code) {
					await manualPromise;
					if (manualErr) throw manualErr;
					if (manualVal) code = parseAuthCode(manualVal, state);
				}
			} else {
				const result = await server.waitForCode();
				if (result?.code) code = result.code;
			}
			if (!code) throw new Error("Sign-in didn't complete — no authorization code was received.");

			const tokens = await exchangeAntigravityCode(code, verifier, server.redirectUri);
			const project = await discoverProject(tokens.access);
			return { ...tokens, project };
		} finally {
			server.close();
		}
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const refreshed = await refreshGoogleToken(credentials.refresh);
		// Preserve the discovered project across refreshes.
		const project = (credentials as AntigravityCreds).project ?? (await discoverProject(refreshed.access));
		return { ...refreshed, project };
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<string>[], credentials: OAuthCredentials): Model<string>[] {
		// Stamp the transport AND the discovered GCP project onto Antigravity models.
		// Pi's streamFn `options` don't carry the project, so the model object is the
		// only channel to get it to the transport for the /v1internal envelope.
		const project = (credentials as AntigravityCreds).project;
		return models.map((m) =>
			m.provider === ANTIGRAVITY_PROVIDER
				? ({ ...m, api: ANTIGRAVITY_API, baseUrl: CLOUD_CODE_ASSIST_BASE, ...(project ? { project } : {}) } as Model<string>)
				: m,
		);
	},
};

/* ─────────────────────────── transport (StreamFn) ─────────────────────────── */

function buildUsage(input = 0, output = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

/** Convert Pi's message array → Gemini `contents` (roles: user/model). */
export function toGeminiContents(messages: Array<{ role: string; content: unknown }>): unknown[] {
	const out: unknown[] = [];
	for (const m of messages) {
		const role = m.role === "assistant" ? "model" : "user";
		const text = typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? (m.content as Array<{ type?: string; text?: string }>)
						.filter((p) => p?.type === "text" && typeof p.text === "string")
						.map((p) => p.text)
						.join("")
				: "";
		out.push({ role, parts: [{ text }] });
	}
	return out;
}

/** The Cloud Code Assist StreamFn. LIVE-VALIDATE: envelope + SSE field names. */
export function createAntigravityStreamFn(): StreamFn {
	return ((model: Model<string>, context: unknown, options: Record<string, unknown> | undefined) => {
		const stream = createAssistantMessageEventStream();
		const modelInfo = { api: model.api, provider: model.provider, id: model.id };
		const ts = Date.now();
		const shell = (content: (TextContent | ThinkingContent | ToolCall)[], stopReason: StopReason, errorMessage?: string): AssistantMessage =>
			({
				role: "assistant",
				content,
				api: modelInfo.api,
				provider: modelInfo.provider,
				model: modelInfo.id,
				usage: buildUsage(),
				stopReason,
				...(errorMessage ? { errorMessage } : {}),
				timestamp: ts,
			}) as AssistantMessage;

		const run = async (): Promise<void> => {
			let acc = "";
			let started = false;
			try {
				const ctx = (context ?? {}) as { systemPrompt?: string; messages?: Array<{ role: string; content: unknown }>; tools?: Tool[] };
				const token = typeof options?.apiKey === "string" ? options.apiKey : "";
				// Project is stamped onto the model by the OAuth provider's modifyModels
				// (Pi's streamFn options don't carry it); fall back to options/env.
				const project =
					(model as { project?: string }).project ??
					(options?.project as string | undefined) ??
					process.env.BRIGADE_ANTIGRAVITY_PROJECT ??
					"";
				const body = {
					project,
					model: model.id.replace(/^antigravity\//, ""),
					request: {
						contents: toGeminiContents(ctx.messages ?? []),
						...(ctx.systemPrompt ? { systemInstruction: { parts: [{ text: ctx.systemPrompt }] } } : {}),
					},
					userAgent: "antigravity",
					requestId: randomUUID(),
				};
				const res = await fetch(STREAM_URL, {
					method: "POST",
					headers: { ...antigravityHeaders(token), Accept: "text/event-stream" },
					body: JSON.stringify(body),
					signal: options?.signal as AbortSignal | undefined,
				});
				if (!res.ok || !res.body) {
					const detail = await res.text().catch(() => "");
					throw new Error(`Antigravity /v1internal returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
				}
				stream.push({ type: "start", partial: shell([], "stop") });
				started = true;
				stream.push({ type: "text_start", contentIndex: 0, partial: shell([], "stop") });

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				const handleSseLine = (line: string): void => {
					const t = line.trim();
					if (!t.startsWith("data:")) return;
					const payload = t.slice(5).trim();
					if (!payload || payload === "[DONE]") return;
					try {
						// LIVE-VALIDATE: text lives under response.candidates[].content.parts[].text
						const obj = JSON.parse(payload) as { response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } };
						const parts = obj.response?.candidates?.[0]?.content?.parts ?? [];
						for (const p of parts) {
							if (typeof p.text === "string" && p.text) {
								acc += p.text;
								stream.push({ type: "text_delta", contentIndex: 0, delta: p.text, partial: shell([{ type: "text", text: acc } as TextContent], "stop") });
							}
						}
					} catch {
						/* skip malformed SSE line */
					}
				};
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) handleSseLine(line);
					}
					// Flush a trailing line if the stream closed without a final newline —
					// otherwise the last delta / finish chunk is silently dropped.
					if (buffer.trim()) handleSseLine(buffer);
				} finally {
					await reader.cancel().catch(() => {});
				}

				stream.push({ type: "text_end", contentIndex: 0, content: acc, partial: shell([{ type: "text", text: acc } as TextContent], "stop") });
				const content: (TextContent | ThinkingContent | ToolCall)[] = acc ? [{ type: "text", text: acc } as TextContent] : [];
				stream.push({ type: "done", reason: "stop", message: shell(content, "stop") });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(msg));
				// Guarantee a `start` precedes the terminal `error`, even when the failure
				// happened before the stream started (e.g. the fetch or !res.ok threw).
				if (!started) {
					stream.push({ type: "start", partial: shell([], aborted ? "aborted" : "error") });
					started = true;
				}
				stream.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: shell(acc ? [{ type: "text", text: acc } as TextContent] : [], aborted ? "aborted" : "error", msg),
				});
			} finally {
				stream.end();
			}
		};
		queueMicrotask(() => void run());
		return stream as AssistantMessageEventStream;
	}) as unknown as StreamFn;
}

/* ─────────────────────────── registration ─────────────────────────── */

const REGISTRY_SOURCE_ID = "brigade-antigravity";

/**
 * Idempotently register Antigravity's OAuth provider + `api:"antigravity"`
 * transport. Guards on the LIVE registries (self-heals after Pi's
 * resetApiProviders/resetOAuthProviders on refresh), same rationale as the
 * Ollama-native registration. Safe to call at boot, per turn, and pre-login.
 */
export function ensureAntigravityRegistered(): void {
	if (!getOAuthProvider(ANTIGRAVITY_OAUTH_ID)) {
		registerOAuthProvider(antigravityOAuthProvider);
	}
	if (!getApiProvider(ANTIGRAVITY_API)) {
		const streamFn = createAntigravityStreamFn();
		registerApiProvider({ api: ANTIGRAVITY_API, stream: streamFn as never, streamSimple: streamFn as never }, REGISTRY_SOURCE_ID);
	}
}
