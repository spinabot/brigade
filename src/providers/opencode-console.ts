/**
 * OpenCode Console OAuth — device-code login for OpenCode's hosted models.
 *
 * NOT the OpenCode Zen credential. Zen and Go take an API key the operator
 * pastes, and their gateway resolves it by matching a row in the console's key
 * table — a device-flow token is rejected there with `AuthError`. This
 * credential serves inference from a different set of endpoints that Pi ships no
 * catalog for, and every request additionally needs an `x-opencode-org-id`
 * header naming the workspace (403 without it). Hence its own provider id: Pi's
 * `opencode` / `opencode-go` models point at `/zen/v1`.
 *
 * Flow (RFC 8628; no PKCE, scope, redirect_uri or loopback server):
 *   POST {server}/auth/device/code   → device_code + user_code
 *   POST {server}/auth/device/token  → access + refresh   (also the refresh grant)
 *   GET  {server}/api/orgs           → pick the workspace
 *   GET  {server}/api/user           → account identity (best-effort)
 *   GET  {server}/api/config         → base URLs + model catalog
 *
 * These endpoints are undocumented and absent from the public sst/opencode
 * repository, and the console host already moved once (2026-08-17). Reads are
 * therefore defensive: an unrecognised shape degrades to `FALLBACK_MODEL_IDS`
 * rather than failing the login.
 */

import {
	getOAuthProvider,
	pollOAuthDeviceCodeFlow,
	registerOAuthProvider,
} from "@earendil-works/pi-ai/oauth";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "@earendil-works/pi-ai/oauth";

/** Pi provider id, picker id and OAuth provider id — one string, because
 *  `AuthStorage.getApiKey` looks the OAuth provider up BY provider id. */
export const OPENCODE_CONSOLE_PROVIDER = "opencode-console";

/** `login()` always uses this. A credential's `metadata.server` is read back on
 *  refresh, so a grant minted against a different console keeps refreshing there
 *  — but nothing in the UI currently sets one. */
const OPENCODE_CONSOLE_DEFAULT_SERVER = "https://opencode.ai/console";

/** The device endpoint has no client registration and accepts any id, so Brigade
 *  identifies as itself rather than sending OpenCode's own `opencode-cli`. */
const OPENCODE_CONSOLE_CLIENT_ID = "brigade";

/** Mandatory on every inference request. */
export const OPENCODE_CONSOLE_ORG_HEADER = "x-opencode-org-id";

/** Resolved from models.json when no OAuth credential is loaded. */
export const OPENCODE_CONSOLE_ENV_VAR = "OPENCODE_CONSOLE_TOKEN";

// Three surfaces. On a live account: 43 OpenAI-shaped, 13 Anthropic-shaped,
// 6 Google-shaped. All three accept the console token — the first two as a
// Bearer or `x-api-key`, the Google one as `x-goog-api-key`, which is what
// @google/genai (Pi's google transport) sends.
const DEFAULT_OPENAI_API = "https://opencode.ai/inference/openai/v1";
const DEFAULT_ANTHROPIC_API = "https://opencode.ai/inference/anthropic/v1";
const DEFAULT_GOOGLE_API = "https://opencode.ai/inference/google/v1beta";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Subtracted from `expires_in`: Pi refreshes only once `Date.now() >= expires`,
 *  so the margin has to be baked into the stored value. */
const REFRESH_MARGIN_MS = 5 * 60_000;

const REQUEST_TIMEOUT_MS = 30_000;

/** Used when `/api/config` can't be read. Short by design — not a second
 *  catalog to keep in sync. No Gemini id: guessing the Google surface from a
 *  name would fail on the operator's first turn. */
const FALLBACK_MODEL_IDS = [
	"big-pickle",
	"claude-sonnet-5",
	"claude-opus-5",
	"gpt-5.4",
	"kimi-k2.5",
	"glm-5",
] as const;

const FALLBACK_ANTHROPIC_PREFIX = "claude-";

// Everything `/api/config` returns is untrusted network data that gets WRITTEN TO
// DISK (models.json) and then flows onward — model ids reach `brigade.json` and
// the wire as `model` params, `baseUrl` becomes the request target, and the org
// id becomes a request header. So bound and shape-check all of it at this
// boundary. Mirrors `sanitizeModelIds` in src/agents/claude-cli/models-live.ts,
// which exists for the same CodeQL rule ("network data written to file system").
const MAX_MODELS = 200;
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 128;
/** Generous for a real endpoint, far below what makes string work costly. */
const MAX_URL_LEN = 2048;
/** Model ids are printable, path-separator-free tokens. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
/**
 * Workspace ids are opaque `org_…` tokens.
 *
 * SECURITY-CRITICAL — do not widen without re-reading this. The org id is written
 * into the models.json `headers` block, and Pi resolves every header value
 * through `resolveConfigValueOrThrow`, which EXECUTES THE VALUE AS A SHELL
 * COMMAND when it begins with `!` and interpolates `${ENV}` otherwise
 * (pi-coding-agent/dist/core/resolve-config-value.js). This provider is the first
 * to put network-derived data in that block, so an id like `!curl … | sh` from a
 * hostile `/api/orgs` would be persisted and then run on the next turn. This
 * character class excludes `!`, `$` and `{`, which closes both forms — as well as
 * the CR/LF that would allow header injection.
 */
const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Reject a workspace id we would otherwise put in a request header. */
function sanitizeOrgId(orgId: string): string {
	if (!ORG_ID_RE.test(orgId)) {
		throw new Error("OpenCode returned a workspace id we don't recognise. Sign in again.");
	}
	return orgId;
}

/**
 * Constrain a network-supplied endpoint before we send a credential to it.
 *
 * `baseUrl` arrives inside the config response and becomes the URL the OAuth
 * access token is sent to — so a spoofed or compromised response could otherwise
 * redirect a live credential to an arbitrary host. Require https and require the
 * host to be the console's own registrable domain; anything else falls back to
 * the known-good default for that API shape.
 */
function sanitizeBaseUrl(candidate: string | undefined, fallback: string, server: string): string {
	// Length FIRST. The host check below passes for any path, so without this an
	// `api` of "https://opencode.ai/" + 200k slashes + "x" reaches the trailing-
	// slash strip and costs ~22s of backtracking — per model, up to MAX_MODELS
	// times. Bounding the input is also what keeps the strip below linear-time.
	if (!candidate || candidate.length > MAX_URL_LEN) return fallback;
	let url: URL;
	let consoleHost: string;
	try {
		url = new URL(candidate);
		consoleHost = new URL(server).hostname;
	} catch {
		return fallback;
	}
	if (url.protocol !== "https:") return fallback;
	// Compare the PARSED hostname, never a substring of the raw string: that is
	// what makes `opencode.ai.evil.test` and `https://opencode.ai@evil.test`
	// fail rather than pass.
	if (url.hostname !== consoleHost && !url.hostname.endsWith(`.${consoleHost}`)) return fallback;
	// Credentials in the authority would travel with every request; drop them.
	if (url.username || url.password) return fallback;
	return trimTrailingSlashes(url.toString());
}

/** Strip trailing "/" without a regex, so this cannot backtrack. */
function trimTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
	return value.slice(0, end);
}

/** Strip control characters and bound the length of a display string. Applied to
 *  every network-supplied label we persist or render — a control character would
 *  corrupt the TUI's model picker, and the values reach auth-profiles.json. */
function sanitizeOptionalText(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
	return cleaned.length > 0 ? cleaned.slice(0, MAX_NAME_LEN) : undefined;
}

/** Model display name, falling back to the id. */
function sanitizeName(name: string | undefined, fallbackId: string): string {
	return sanitizeOptionalText(name) ?? fallbackId;
}

/** Pi `Api` shapes this provider emits. */
export type OpencodeConsoleApi = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface OpencodeConsoleModel {
	id: string;
	name: string;
	api: OpencodeConsoleApi;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	reasoning: boolean;
}

/**
 * What belongs in models.json rather than in the credential. Rides out of
 * `login()` on the credential object and is stripped by the caller — 60+ models
 * of metadata in the profile would be spread into the live Pi credential every
 * turn by `subscriptionProfileToCredential`.
 */
export interface OpencodeConsoleCatalog {
	models: OpencodeConsoleModel[];
	headers: Record<string, string>;
	/** True when this is the pinned fallback rather than the console's own list. */
	degraded: boolean;
}

interface OpencodeConsoleMetadata {
	server: string;
	orgId: string;
	orgName?: string;
	email?: string;
	accountId?: string;
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

function requestSignal(outer: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Parse a JSON body WITHOUT checking the status — `authorization_pending` and
 * `slow_down` arrive as HTTP 400s, so a status check would turn every normal
 * poll tick into a hard failure.
 */
async function readJsonBody(res: Response): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = await res.json();
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function str(source: Record<string, unknown> | null | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(source: Record<string, unknown> | null | undefined, key: string): number | undefined {
	const value = source?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rec(
	source: Record<string, unknown> | null | undefined,
	key: string,
): Record<string, unknown> | undefined {
	const value = source?.[key];
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function apiForNpm(npm: string | undefined): OpencodeConsoleApi {
	if (npm === "@ai-sdk/anthropic") return "anthropic-messages";
	if (npm === "@ai-sdk/google") return "google-generative-ai";
	return "openai-completions";
}

function defaultBaseUrlFor(api: OpencodeConsoleApi, providerApi: string): string {
	if (api === "anthropic-messages") return DEFAULT_ANTHROPIC_API;
	if (api === "google-generative-ai") return DEFAULT_GOOGLE_API;
	return providerApi;
}

export function computeOpencodeConsoleExpiry(expiresInSeconds: number | undefined, now: number): number {
	// Missing/garbage means "refresh on first use", not "never expires" — a
	// credential Pi believes is fresh forever can never heal.
	if (expiresInSeconds === undefined || expiresInSeconds <= 0) return now;
	return Math.max(now, now + expiresInSeconds * 1000 - REFRESH_MARGIN_MS);
}

function serverFor(creds: OAuthCredentials | undefined): string {
	const metadata = rec(creds as Record<string, unknown> | undefined, "metadata");
	return str(metadata, "server") ?? OPENCODE_CONSOLE_DEFAULT_SERVER;
}

/**
 * Resolve the consent URL the operator is sent to. The console returns
 * `/console/device`, not an absolute URL, and the path already carries the
 * `/console` segment — so this resolves against the ORIGIN.
 *
 * The result is handed to `xdg-open` / `open` / `rundll32`, i.e. to the OS
 * handler for whatever scheme it names. The value comes off the network, so
 * constrain it to https on the console's own domain rather than letting a
 * `file://` or custom-scheme URL reach that sink.
 */
export function resolveVerificationUri(server: string, relativeOrAbsolute: string): string {
	let url: URL;
	let consoleHost: string;
	try {
		url = new URL(relativeOrAbsolute, `${server}/`);
		consoleHost = new URL(server).hostname;
	} catch {
		throw new Error("OpenCode returned a sign-in link we couldn't read. Try again.");
	}
	if (
		url.protocol !== "https:" ||
		(url.hostname !== consoleHost && !url.hostname.endsWith(`.${consoleHost}`))
	) {
		throw new Error("OpenCode returned a sign-in link pointing somewhere unexpected.");
	}
	return url.toString();
}

function describeDeviceError(error: string | undefined, description: string | undefined): string {
	switch (error) {
		case "expired_token":
			return "The sign-in code expired before it was approved. Start again.";
		case "access_denied":
			return "Sign-in was declined in the browser.";
		default:
			// Sanitised like every other network string in this file: this message is
			// thrown out of refreshToken into Pi's refresh path, where whatever logs
			// or renders it is not ours to audit.
			return (
				sanitizeOptionalText(description) ??
				sanitizeOptionalText(error) ??
				"OpenCode rejected the sign-in request."
			);
	}
}

/* ───────────────────────────── catalog parsing ──────────────────────────── */

/**
 * Normalise `/api/config` into a models.json-ready catalog. `whitelist` is the
 * org's entitlement — offering a model the workspace can't call just moves the
 * failure to the operator's first turn. Returns null when the payload doesn't
 * look like a console config, so the caller can fall back.
 */
export function parseConsoleCatalog(
	payload: Record<string, unknown> | null,
	orgId: string,
	server: string = OPENCODE_CONSOLE_DEFAULT_SERVER,
): OpencodeConsoleCatalog | null {
	const safeOrgId = sanitizeOrgId(orgId);
	const provider = rec(rec(rec(payload, "config"), "provider"), "opencode");
	if (!provider) return null;

	const providerApi = sanitizeBaseUrl(str(provider, "api"), DEFAULT_OPENAI_API, server);
	const rawModels = rec(provider, "models");
	if (!rawModels) return null;

	const whitelistValue = provider.whitelist;
	const whitelist = Array.isArray(whitelistValue)
		? new Set(whitelistValue.filter((id): id is string => typeof id === "string"))
		: undefined;

	const models: OpencodeConsoleModel[] = [];
	for (const [id, value] of Object.entries(rawModels)) {
		if (models.length >= MAX_MODELS) break;
		if (id.length > MAX_ID_LEN || !MODEL_ID_RE.test(id)) continue;
		if (whitelist && !whitelist.has(id)) continue;
		const model = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
		if (!model) continue;
		const status = str(model, "status");
		if (status !== undefined && status !== "active") continue;

		const perModel = rec(model, "provider");
		const api = apiForNpm(str(perModel, "npm"));
		const cost = rec(model, "cost");
		const limit = rec(model, "limit");
		models.push({
			id,
			name: sanitizeName(str(model, "name"), id),
			api,
			baseUrl: sanitizeBaseUrl(str(perModel, "api"), defaultBaseUrlFor(api, providerApi), server),
			contextWindow: num(limit, "context") ?? 128_000,
			maxTokens: num(limit, "output") ?? 8_192,
			cost: {
				input: num(cost, "input") ?? 0,
				output: num(cost, "output") ?? 0,
				cacheRead: num(cost, "cache_read") ?? 0,
				cacheWrite: num(cost, "cache_write") ?? 0,
			},
			reasoning: model.reasoning === true,
		});
	}

	if (models.length === 0) return null;
	return { models, headers: { [OPENCODE_CONSOLE_ORG_HEADER]: safeOrgId }, degraded: false };
}

export function fallbackCatalog(orgId: string): OpencodeConsoleCatalog {
	const safeOrgId = sanitizeOrgId(orgId);
	return {
		models: FALLBACK_MODEL_IDS.map((id) => {
			const api: OpencodeConsoleApi = id.startsWith(FALLBACK_ANTHROPIC_PREFIX)
				? "anthropic-messages"
				: "openai-completions";
			return {
				id,
				name: id,
				api,
				baseUrl: defaultBaseUrlFor(api, DEFAULT_OPENAI_API),
				contextWindow: 128_000,
				maxTokens: 8_192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
			};
		}),
		headers: { [OPENCODE_CONSOLE_ORG_HEADER]: safeOrgId },
		degraded: true,
	};
}

/** Split the transient catalog off a credential returned by `login()`. */
export function takeOpencodeConsoleCatalog(creds: OAuthCredentials): {
	credentials: OAuthCredentials;
	catalog: OpencodeConsoleCatalog | undefined;
} {
	const { catalog, ...rest } = creds as OAuthCredentials & { catalog?: unknown };
	const isCatalog =
		!!catalog &&
		typeof catalog === "object" &&
		Array.isArray((catalog as OpencodeConsoleCatalog).models);
	return {
		credentials: rest as OAuthCredentials,
		catalog: isCatalog ? (catalog as OpencodeConsoleCatalog) : undefined,
	};
}

/**
 * The models.json entry for a discovered catalog. `apiKey` is an env TEMPLATE,
 * not a secret: Pi resolves credentials api_key → oauth → env → models.json, so
 * the live OAuth token always wins and this only applies when no credential is
 * loaded (an operator who exported the env var keeps working).
 */
export function buildModelsJsonEntry(catalog: OpencodeConsoleCatalog): {
	id: string;
	baseUrl: string;
	api: "openai-completions";
	apiKey: string;
	headers: Record<string, string>;
	models: OpencodeConsoleModel[];
} {
	return {
		id: OPENCODE_CONSOLE_PROVIDER,
		baseUrl: DEFAULT_OPENAI_API,
		api: "openai-completions",
		apiKey: `\${${OPENCODE_CONSOLE_ENV_VAR}}`,
		headers: catalog.headers,
		models: catalog.models,
	};
}

/* ─────────────────────────────── the flow ───────────────────────────────── */

async function requestDeviceCode(
	server: string,
	signal: AbortSignal | undefined,
): Promise<{ deviceCode: string; userCode: string; verificationUri: string; interval?: number; expiresIn?: number }> {
	const res = await fetch(`${server}/auth/device/code`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: OPENCODE_CONSOLE_CLIENT_ID }),
		signal: requestSignal(signal),
	});
	const body = await readJsonBody(res);
	const deviceCode = str(body, "device_code");
	const userCode = str(body, "user_code");
	const relative = str(body, "verification_uri_complete") ?? str(body, "verification_uri");
	if (!deviceCode || !userCode || !relative) {
		throw new Error("OpenCode didn't return a sign-in code. Try again in a moment.");
	}
	return {
		deviceCode,
		userCode,
		verificationUri: resolveVerificationUri(server, relative),
		interval: num(body, "interval"),
		expiresIn: num(body, "expires_in"),
	};
}

interface DeviceToken {
	access: string;
	refresh: string;
	expiresIn: number | undefined;
}

async function exchangeDeviceCode(
	server: string,
	deviceCode: string,
	interval: number | undefined,
	expiresIn: number | undefined,
	signal: AbortSignal | undefined,
): Promise<DeviceToken> {
	return pollOAuthDeviceCodeFlow<DeviceToken>({
		intervalSeconds: interval,
		expiresInSeconds: expiresIn,
		signal,
		poll: async () => {
			const res = await fetch(`${server}/auth/device/token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					grant_type: DEVICE_CODE_GRANT,
					device_code: deviceCode,
					client_id: OPENCODE_CONSOLE_CLIENT_ID,
				}),
				signal: requestSignal(signal),
			});
			const body = await readJsonBody(res);
			const access = str(body, "access_token");
			if (access) {
				return {
					status: "complete",
					value: {
						access,
						refresh: str(body, "refresh_token") ?? "",
						expiresIn: num(body, "expires_in"),
					},
				};
			}
			const error = str(body, "error");
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			return { status: "failed", message: describeDeviceError(error, str(body, "error_description")) };
		},
	});
}

async function consoleGet(
	url: string,
	access: string,
	orgId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const headers: Record<string, string> = { authorization: `Bearer ${access}` };
	// The console API's header is `x-org-id`; the INFERENCE endpoints use
	// `x-opencode-org-id`. Not interchangeable.
	if (orgId) headers["x-org-id"] = orgId;
	const res = await fetch(url, { headers, signal: requestSignal(signal) });
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return res.json();
}

async function selectOrg(
	server: string,
	access: string,
	cb: OAuthLoginCallbacks,
): Promise<{ id: string; name?: string }> {
	const payload = await consoleGet(`${server}/api/orgs`, access, undefined, cb.signal);
	const orgs = (Array.isArray(payload) ? payload : [])
		.map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null))
		.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry.id === "string");

	if (orgs.length === 0) {
		throw new Error("This OpenCode account has no workspace yet. Create one, then sign in again.");
	}
	if (orgs.length === 1) {
		const only = orgs[0]!;
		return { id: sanitizeOrgId(only.id as string), name: sanitizeOptionalText(str(only, "name")) };
	}

	const picked = await cb.onSelect({
		message: "Which OpenCode workspace?",
		options: orgs.map((org) => ({
			id: org.id as string,
			// Both branches sanitised: the id is the label when a workspace has no
			// name, and it is rendered before `sanitizeOrgId` runs on the choice.
			label: sanitizeOptionalText(str(org, "name")) ?? sanitizeOptionalText(org.id as string) ?? "workspace",
		})),
	});
	if (!picked) throw new Error("cancelled");
	const chosen = orgs.find((org) => org.id === picked) ?? orgs[0]!;
	return { id: sanitizeOrgId(chosen.id as string), name: sanitizeOptionalText(str(chosen, "name")) };
}

/* ──────────────────────────── provider object ───────────────────────────── */

export const opencodeConsoleOAuthProvider: OAuthProviderInterface = {
	id: OPENCODE_CONSOLE_PROVIDER,
	name: "OpenCode",

	async login(cb: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const server = OPENCODE_CONSOLE_DEFAULT_SERVER;

		const device = await requestDeviceCode(server, cb.signal);
		cb.onDeviceCode({
			userCode: device.userCode,
			verificationUri: device.verificationUri,
			intervalSeconds: device.interval,
			expiresInSeconds: device.expiresIn,
		});

		const token = await exchangeDeviceCode(
			server,
			device.deviceCode,
			device.interval,
			device.expiresIn,
			cb.signal,
		);

		const org = await selectOrg(server, token.access, cb);

		// Identity is context for `brigade auth` output; never fatal.
		let email: string | undefined;
		let accountId: string | undefined;
		try {
			const user = await consoleGet(`${server}/api/user`, token.access, undefined, cb.signal);
			const record = user && typeof user === "object" ? (user as Record<string, unknown>) : null;
			email = sanitizeOptionalText(str(record, "email"));
			accountId = sanitizeOptionalText(str(record, "id"));
		} catch {
			/* best-effort */
		}

		// A failed catalog fetch is not a failed login — we hold a valid credential.
		let catalog: OpencodeConsoleCatalog;
		try {
			const config = await consoleGet(`${server}/api/config`, token.access, org.id, cb.signal);
			catalog =
				parseConsoleCatalog(
					config && typeof config === "object" ? (config as Record<string, unknown>) : null,
					org.id,
					server,
				) ?? fallbackCatalog(org.id);
		} catch {
			catalog = fallbackCatalog(org.id);
		}
		if (catalog.degraded) {
			cb.onProgress?.("Couldn't read your OpenCode model list — using a shorter built-in list for now.");
		}

		const metadata: OpencodeConsoleMetadata = {
			server,
			orgId: org.id,
			...(org.name ? { orgName: org.name } : {}),
			...(email ? { email } : {}),
			...(accountId ? { accountId } : {}),
		};

		return {
			access: token.access,
			refresh: token.refresh,
			expires: computeOpencodeConsoleExpiry(token.expiresIn, Date.now()),
			metadata,
			catalog, // transient; the caller strips it before persisting
		} as OAuthCredentials;
	},

	async refreshToken(creds: OAuthCredentials): Promise<OAuthCredentials> {
		const server = serverFor(creds);
		if (!creds.refresh) {
			throw new Error("This OpenCode login has no refresh token. Sign in again.");
		}
		const res = await fetch(`${server}/auth/device/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: creds.refresh,
				client_id: OPENCODE_CONSOLE_CLIENT_ID,
			}),
			signal: requestSignal(undefined),
		});
		const body = await readJsonBody(res);
		const access = str(body, "access_token");
		if (!access) {
			throw new Error(
				describeDeviceError(str(body, "error"), str(body, "error_description")) ||
					"OpenCode refused to refresh this login.",
			);
		}
		// Spread `creds` first to carry `metadata` forward: Pi REPLACES the stored
		// credential with whatever this returns, so dropping it would lose the org
		// id and every later request would 403. OpenCode rotates the refresh token.
		return {
			...creds,
			access,
			refresh: str(body, "refresh_token") ?? creds.refresh,
			expires: computeOpencodeConsoleExpiry(num(body, "expires_in"), Date.now()),
		};
	},

	getApiKey(creds: OAuthCredentials): string {
		return creds.access;
	},
};

/**
 * Register into the OAuth registry of the pi-ai copy THIS module imports.
 *
 * That is the registry `onboarding.ts` reads through its own
 * `getOAuthProvider(sub.oauthProviderId)` gate — without this the wizard reports
 * "sign-in isn't supported yet". It is NOT what makes requests authenticate; see
 * `registerOpencodeConsoleOnRegistry`.
 *
 * Guards on the live registry, not a flag: `resetOAuthProviders()` fires from
 * `ModelRegistry.refresh()` and drops custom providers.
 */
export function ensureOpencodeConsoleOAuthRegistered(): boolean {
	if (getOAuthProvider(OPENCODE_CONSOLE_PROVIDER)) return false;
	registerOAuthProvider(opencodeConsoleOAuthProvider);
	return true;
}

/** Minimal shape needed from a Pi `ModelRegistry`, to avoid importing it here. */
export interface OAuthCapableRegistry {
	registerProvider(
		providerName: string,
		config: { oauth?: Omit<OAuthProviderInterface, "id"> },
	): void;
}

/**
 * Register through the model registry — the registration that actually makes
 * requests authenticate.
 *
 * npm installs `pi-coding-agent` with its own nested `@earendil-works/pi-ai`, so
 * `AuthStorage` holds a SECOND, independent OAuth registry that cannot see
 * anything registered above. It calls `getOAuthProvider`, gets `undefined`, and
 * the request goes out with no credential — no exception. Nothing noticed before
 * this provider because every other registered id (`anthropic`, `openai-codex`,
 * `github-copilot`) is a built-in present in both copies.
 *
 * `registerProvider` crosses the boundary by calling its own
 * `registerOAuthProvider` (it forces `id: providerName`, hence the omitted id),
 * and re-applies after every `refresh()` — so this one needs no re-assert.
 */
export function registerOpencodeConsoleOnRegistry(registry: OAuthCapableRegistry): void {
	const { id: _id, ...withoutId } = opencodeConsoleOAuthProvider;
	registry.registerProvider(OPENCODE_CONSOLE_PROVIDER, { oauth: withoutId });
}
