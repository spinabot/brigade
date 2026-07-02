/**
 * Cloud-provider model discovery — best-effort live metadata for a model id
 * that isn't in the static catalog.
 *
 * Used by the never-miss resolver (`agents/model-resolution.ts`): on a
 * `ModelRegistry.find` miss for a cloud provider, we hit the provider's
 * models endpoint to (a) confirm the id exists and (b) read accurate
 * capabilities (context window, vision, reasoning) so the synthesized
 * Model isn't all-defaults.
 *
 * Everything here is defensive: short timeouts, every failure path returns
 * `{ exists: false, meta: {} }` so the caller falls back to template/default
 * synthesis rather than erroring. Local Ollama discovery lives separately in
 * `integrations/ollama.ts` (native /api/tags); this module is for cloud +
 * OpenAI-compatible HTTP endpoints.
 */

import { getModels, type KnownProvider } from "@earendil-works/pi-ai";

const TIMEOUT_MS = 5000;

export interface DiscoveredModelMeta {
	contextWindow?: number;
	reasoning?: boolean;
	vision?: boolean;
}

export interface DiscoveryResult {
	/** True when the provider's model list actually contains this id. */
	exists: boolean;
	/** Best-effort capabilities (empty when unknown). */
	meta: DiscoveredModelMeta;
}

const EMPTY: DiscoveryResult = { exists: false, meta: {} };

/** OpenRouter's public model list — no key needed, rich metadata. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

async function fetchJson(url: string, apiKey?: string): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const res = await fetch(url, { signal: controller.signal, headers });
		if (!res.ok) return null;
		return (await res.json()) as unknown;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * OpenRouter: rich catalog at /api/v1/models. Each entry carries
 * `context_length`, `architecture.input_modalities` (vision), and
 * `supported_parameters` (reasoning).
 */
async function discoverOpenRouter(modelId: string): Promise<DiscoveryResult> {
	const body = (await fetchJson(OPENROUTER_MODELS_URL)) as
		| { data?: Array<Record<string, unknown>> }
		| null;
	const list = body?.data;
	if (!Array.isArray(list)) return EMPTY;
	const entry = list.find((m) => m.id === modelId || m.canonical_slug === modelId);
	if (!entry) return EMPTY;
	const contextWindow =
		typeof entry.context_length === "number" && entry.context_length > 0
			? entry.context_length
			: undefined;
	const arch = entry.architecture as { input_modalities?: unknown } | undefined;
	const modalities = Array.isArray(arch?.input_modalities) ? (arch?.input_modalities as unknown[]) : [];
	const vision = modalities.includes("image");
	const supported = Array.isArray(entry.supported_parameters)
		? (entry.supported_parameters as unknown[])
		: [];
	const reasoning = supported.includes("reasoning") || supported.includes("include_reasoning");
	return { exists: true, meta: { contextWindow, vision, reasoning } };
}

/**
 * Generic OpenAI-compatible `/v1/models` (OpenAI, Groq, Cerebras, DeepSeek,
 * Mistral, xAI, custom endpoints). Most return ids only; Groq additionally
 * includes `context_window`. We confirm existence and pull context_window
 * when present — capabilities otherwise stay unknown (caller defaults them).
 */
async function discoverOpenAICompatible(
	baseUrl: string,
	modelId: string,
	apiKey?: string,
): Promise<DiscoveryResult> {
	// baseUrl is the provider's API root (e.g. https://api.groq.com/openai/v1).
	const url = `${baseUrl.replace(/\/$/, "")}/models`;
	const body = (await fetchJson(url, apiKey)) as { data?: Array<Record<string, unknown>> } | null;
	const list = body?.data;
	if (!Array.isArray(list)) return EMPTY;
	const entry = list.find((m) => m.id === modelId);
	if (!entry) return EMPTY;
	const ctx = entry.context_window ?? entry.context_length;
	const contextWindow = typeof ctx === "number" && ctx > 0 ? ctx : undefined;
	return { exists: true, meta: { contextWindow } };
}

/**
 * Resolve best-effort live metadata for `provider/modelId`. `baseUrl` is the
 * provider's API root (taken from a catalogued template model when available);
 * `apiKey` is the provider's key from auth storage (omit for keyless lists).
 * Never throws — returns `{ exists:false, meta:{} }` on any failure.
 */
export async function discoverCloudModelMeta(
	provider: string,
	modelId: string,
	opts: { baseUrl?: string; apiKey?: string } = {},
): Promise<DiscoveryResult> {
	try {
		if (provider === "openrouter") return await discoverOpenRouter(modelId);
		if (opts.baseUrl) return await discoverOpenAICompatible(opts.baseUrl, modelId, opts.apiKey);
		return EMPTY;
	} catch {
		return EMPTY;
	}
}

/**
 * A live model entry from a cloud catalog, shaped so it can be used DIRECTLY as
 * a (loose) Pi `Model`: the onboarding picker's `describeModel` and the gateway's
 * `modelToSummary` only read provider/id/name/contextWindow/reasoning/input/cost,
 * all populated here. Lets UIs list models newer than Pi's bundled snapshot.
 */
export interface LiveCloudModel {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
	reasoning: boolean;
	input: string[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const MODEL_LIST_TTL_MS = 5 * 60_000;
let openRouterListCache: { at: number; models: LiveCloudModel[] } | null = null;

/**
 * The FULL live OpenRouter catalog (every served model id), so model pickers can
 * show models newer than Pi's bundled snapshot (e.g. the latest Opus/GPT/Gemini).
 * Keyless, cached 5 min, short timeout. Returns the last good cache (or `[]`) on
 * ANY failure so callers degrade to the static catalog rather than erroring —
 * never throws. Pricing → `cost.input` is per-Mtok (OpenRouter quotes per-token).
 */
export async function listOpenRouterModels(): Promise<LiveCloudModel[]> {
	const now = Date.now();
	if (openRouterListCache && now - openRouterListCache.at < MODEL_LIST_TTL_MS) {
		return openRouterListCache.models;
	}
	try {
		const body = (await fetchJson(OPENROUTER_MODELS_URL)) as
			| { data?: Array<Record<string, unknown>> }
			| null;
		const list = body?.data;
		if (!Array.isArray(list)) return openRouterListCache?.models ?? [];
		const out: LiveCloudModel[] = [];
		for (const entry of list) {
			const id = typeof entry.id === "string" ? entry.id : undefined;
			if (!id) continue;
			const contextWindow =
				typeof entry.context_length === "number" && entry.context_length > 0
					? entry.context_length
					: undefined;
			const arch = entry.architecture as { input_modalities?: unknown } | undefined;
			const modalities = Array.isArray(arch?.input_modalities) ? (arch?.input_modalities as unknown[]) : [];
			const input = modalities.includes("image") ? ["text", "image"] : ["text"];
			const supported = Array.isArray(entry.supported_parameters)
				? (entry.supported_parameters as unknown[])
				: [];
			const reasoning = supported.includes("reasoning") || supported.includes("include_reasoning");
			const pricing = entry.pricing as { prompt?: unknown; completion?: unknown } | undefined;
			const inTok = pricing && typeof pricing.prompt === "string" ? Number.parseFloat(pricing.prompt) : Number.NaN;
			const outTok =
				pricing && typeof pricing.completion === "string" ? Number.parseFloat(pricing.completion) : Number.NaN;
			const cost = Number.isFinite(inTok)
				? {
						input: inTok * 1_000_000,
						output: Number.isFinite(outTok) ? outTok * 1_000_000 : 0,
						cacheRead: 0,
						cacheWrite: 0,
					}
				: undefined;
			const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id;
			out.push({
				provider: "openrouter",
				id,
				name,
				...(contextWindow !== undefined ? { contextWindow } : {}),
				reasoning,
				input,
				...(cost ? { cost } : {}),
			});
		}
		openRouterListCache = { at: now, models: out };
		return out;
	} catch {
		return openRouterListCache?.models ?? [];
	}
}

/**
 * List an OpenAI-compatible endpoint's served models via `GET {baseUrl}/models`
 * (Bearer auth). Used for LIVE model discovery on catalog providers flagged
 * `liveModels` — e.g. NVIDIA NIM (https://integrate.api.nvidia.com/v1), whose
 * served set changes over time and isn't in Pi's bundled catalog. Doubles as an
 * online key check (a bad key → the request fails → null). Filters out obvious
 * non-chat models (embedding / reranking). Returns model ids, or `null` on any
 * failure so the caller can surface an actionable error rather than persisting a
 * dead provider. Never throws.
 */
export async function fetchOpenAICompatibleModelIds(
	baseUrl: string,
	apiKey: string,
): Promise<string[] | null> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	const body = (await fetchJson(url, apiKey)) as { data?: Array<{ id?: unknown }> } | null;
	if (!body || !Array.isArray(body.data)) return null;
	const ids = body.data
		.map((m) => (typeof m?.id === "string" ? m.id.trim() : ""))
		// Substring (not word-bounded) — NVIDIA fuses the type into the id, e.g.
		// `nv-embedqa-e5-v5`, `llama-3.2-nv-rerankqa-1b-v2`, where a `\b` after
		// "embed"/"rerank" wouldn't match.
		.filter((id) => id.length > 0 && !/(embed|rerank)/i.test(id));
	return ids.length > 0 ? ids : null;
}

/* ──────────────────── model reachability probe ──────────────────── */

/**
 * Result of probing whether a model actually RESPONDS — not just whether it's
 * listed. `model_unavailable`: the endpoint is up but the model returns nothing
 * (the NVIDIA-lists-dead-models case). `provider_unreachable`: the whole endpoint
 * is down/blocked. `auth`: the key was rejected. `error`: an HTTP error with detail.
 */
export type ModelProbeResult =
	| { ok: true }
	| { ok: false; reason: "model_unavailable" | "provider_unreachable" | "auth" | "error"; detail?: string };

/** Is the OpenAI-compatible endpoint reachable at all? (`/models`, incl. a 401 —
 *  an auth rejection still proves the host is up.) Used to tell a dead MODEL apart
 *  from an unreachable PROVIDER. Never throws. */
async function isEndpointReachable(baseUrl: string, apiKey: string): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 6000);
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			signal: controller.signal,
			headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
		});
		return res.ok || res.status === 401 || res.status === 403;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probe whether `modelId` on an OpenAI-compatible endpoint actually responds.
 * Sends a 1-token completion with a short deadline; on a no-response (timeout /
 * connection reset) it falls back to `isEndpointReachable` so we can distinguish
 * a dead model from an unreachable provider. Catalog membership is NOT proof a
 * model works — NVIDIA NIM advertises models in `/models` that hang with zero
 * bytes. Never throws.
 */
export async function probeModelReachable(
	baseUrl: string,
	apiKey: string,
	modelId: string,
	opts?: { timeoutMs?: number },
): Promise<ModelProbeResult> {
	const timeoutMs = opts?.timeoutMs ?? 12_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				stream: false,
			}),
		});
		if (res.ok) return { ok: true };
		if (res.status === 401 || res.status === 403) return { ok: false, reason: "auth" };
		if (res.status === 404) return { ok: false, reason: "model_unavailable", detail: "not found" };
		const detail = (await res.text().catch(() => "")).slice(0, 120).replace(/\s+/g, " ").trim();
		return { ok: false, reason: "error", detail: `HTTP ${res.status}${detail ? ` — ${detail}` : ""}` };
	} catch {
		// No response — separate a dead MODEL from an unreachable PROVIDER.
		const providerUp = await isEndpointReachable(baseUrl, apiKey);
		return providerUp
			? { ok: false, reason: "model_unavailable", detail: "no response" }
			: { ok: false, reason: "provider_unreachable" };
	} finally {
		clearTimeout(timer);
	}
}

/** Turn a failed probe into a single, B2B-clean, actionable line — or `null` when the model is fine. */
export function describeModelProbe(result: ModelProbeResult, providerName: string, modelId: string): string | null {
	if (result.ok) return null;
	switch (result.reason) {
		case "model_unavailable":
			return `${modelId} isn't responding — it may be unavailable on ${providerName}. Try /model to pick another.`;
		case "provider_unreachable":
			return `Can't reach ${providerName} right now — check your connection or the service status.`;
		case "auth":
			return `${providerName} rejected the API key.`;
		default:
			return `${providerName} returned an error${result.detail ? ` (${result.detail})` : ""}.`;
	}
}

/* ──────────────────────── subscription live catalogs ──────────────────────── */

/**
 * Live model catalogs for OAuth subscription providers (GitHub Copilot,
 * Anthropic Claude Pro/Max). Same shape + degrade-to-cache contract as
 * `listOpenRouterModels`, but keyed by providerId because there are several
 * subscription providers (OpenRouter is a singleton). The onboarding picker
 * reads the cache after login via `getCachedSubscriptionModels` and joins the
 * static Pi catalog by id for richer metadata.
 */
const SUBSCRIPTION_MODELS_TTL_MS = 5 * 60_000;
const subscriptionModelsCache = new Map<string, { at: number; models: LiveCloudModel[] }>();

/** Last-fetched live models for a subscription provider, or `undefined` if never fetched. */
export function getCachedSubscriptionModels(providerId: string): LiveCloudModel[] | undefined {
	const e = subscriptionModelsCache.get(providerId);
	return e ? e.models : undefined;
}

/**
 * GitHub Copilot's per-account model catalog. The token embeds the proxy host
 * (`proxy-ep=…`) which `getGitHubCopilotBaseUrl` rewrites to the api host; we GET
 * `${baseUrl}/models` with Copilot's required editor headers (a plain
 * Authorization isn't enough — the endpoint 400s without the editor/integration
 * headers). Keeps only models the account can actually pick (model_picker_enabled,
 * policy not disabled, tool_calls not explicitly off). Never throws — returns the
 * last good cache or `[]` so the caller falls back to Pi's bundled catalog.
 */
export async function fetchGitHubCopilotModels(copilotToken: string): Promise<LiveCloudModel[]> {
	const now = Date.now();
	const cached = subscriptionModelsCache.get("github-copilot");
	if (cached && now - cached.at < SUBSCRIPTION_MODELS_TTL_MS) {
		return cached.models;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const { getGitHubCopilotBaseUrl } = await import("@earendil-works/pi-ai/oauth");
		const baseUrl = getGitHubCopilotBaseUrl(copilotToken);
		const res = await fetch(`${baseUrl}/models`, {
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${copilotToken}`,
				"User-Agent": "GitHubCopilotChat/0.35.0",
				"Editor-Version": "vscode/1.107.0",
				"Editor-Plugin-Version": "copilot-chat/0.35.0",
				"Copilot-Integration-Id": "vscode-chat",
				"X-GitHub-Api-Version": "2026-06-01",
			},
		});
		if (!res.ok) return cached?.models ?? [];
		const body = (await res.json()) as { data?: unknown } | null;
		const list = body?.data;
		if (!Array.isArray(list)) return cached?.models ?? [];
		const out: LiveCloudModel[] = [];
		for (const raw of list) {
			const item = raw as Record<string, unknown>;
			const id = typeof item.id === "string" ? item.id : undefined;
			if (!id) continue;
			// Selectability gate (mirrors Pi's own `isSelectableCopilotModel`): only
			// surface models the account is allowed to pick. Every access is guarded —
			// the response is untyped.
			const policy = item.policy as { state?: unknown } | undefined;
			const capabilities = item.capabilities as
				| { supports?: { tool_calls?: unknown; vision?: unknown }; limits?: { max_context_window_tokens?: unknown } }
				| undefined;
			const supports = capabilities?.supports;
			if (item.model_picker_enabled !== true) continue;
			if (policy?.state === "disabled") continue;
			if (supports?.tool_calls === false) continue;
			const maxCtx = capabilities?.limits?.max_context_window_tokens;
			const contextWindow = typeof maxCtx === "number" && maxCtx > 0 ? maxCtx : undefined;
			const name = typeof item.name === "string" && item.name.length > 0 ? item.name : id;
			const input = supports?.vision ? ["text", "image"] : ["text"];
			out.push({
				provider: "github-copilot",
				id,
				name,
				...(contextWindow !== undefined ? { contextWindow } : {}),
				// Copilot's list doesn't flag reasoning here — leave false; the static
				// catalog join in onboarding fills the richer fields when Pi knows it.
				reasoning: false,
				input,
			});
		}
		subscriptionModelsCache.set("github-copilot", { at: now, models: out });
		return out;
	} catch {
		return cached?.models ?? [];
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Models a Claude Pro/Max SUBSCRIPTION can use. There is NO live per-account
 * models endpoint for a subscription OAuth token: Anthropic scopes that token to
 * inference only, so `GET /v1/models` returns 401/403 (verified). Instead we
 * surface Pi's bundled Anthropic catalog — it IS the current Claude model family
 * and updates as Pi ships new models — so the picker is always populated and
 * current with ZERO network round-trip (no guaranteed-fail request, no timeout)
 * on every sign-in. (GitHub Copilot DOES expose a live per-account list, so that
 * path stays a real fetch; Anthropic subscriptions simply don't have one.)
 */
export function fetchAnthropicSubscriptionModels(): LiveCloudModel[] {
	const now = Date.now();
	const cached = subscriptionModelsCache.get("anthropic");
	if (cached && now - cached.at < SUBSCRIPTION_MODELS_TTL_MS) {
		return cached.models;
	}
	let out: LiveCloudModel[] = [];
	try {
		const catalog = getModels("anthropic" as KnownProvider) as Array<{
			id: string;
			name?: string;
			reasoning?: boolean;
			input?: string[];
			contextWindow?: number;
		}>;
		out = catalog.map((m) => ({
			provider: "anthropic",
			id: m.id,
			name: m.name ?? m.id,
			contextWindow: m.contextWindow,
			reasoning: m.reasoning ?? false,
			input: m.input ?? ["text"],
		}));
	} catch {
		out = [];
	}
	subscriptionModelsCache.set("anthropic", { at: now, models: out });
	return out;
}

/**
 * Warm the live cache for a subscription provider right after OAuth login so the
 * model picker has the account's CURRENT models ready. Best-effort: any failure is
 * swallowed (login must never block on this). `codex` has no live list endpoint —
 * it falls through to Pi's bundled catalog, so this is a no-op for it.
 */
export async function prefetchSubscriptionModels(providerId: string, oauthAccessToken: string): Promise<void> {
	try {
		if (providerId === "github-copilot") {
			await fetchGitHubCopilotModels(oauthAccessToken);
			return;
		}
		if (providerId === "anthropic") {
			// No network — populates the cache from Pi's current Anthropic catalog.
			fetchAnthropicSubscriptionModels();
			return;
		}
		// Other subscription providers (codex) have no live endpoint — no-op.
	} catch {
		// Best-effort warm-up — never blocks login; picker falls back to the catalog.
	}
}
