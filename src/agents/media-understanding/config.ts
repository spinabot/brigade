/**
 * Build a `MediaUnderstandingConfig` from Brigade's existing credential store
 * + main config — so the subsystem resolves keys the SAME way the agent kernel
 * does, and never invents its own auth path.
 *
 * Key resolution reuses `readBrigadeCredentials(agentId)` (the mode-aware
 * choke point over `auth-profiles.json` / the Convex sealed cache that
 * onboarding writes), then falls back to the provider's env var. For Anthropic
 * we accept a literal `api_key` credential; an `oauth` credential (subscription
 * login) is passed through as its access token so direct REST calls still
 * authenticate (Anthropic's `sk-ant-oat…` Bearer path).
 *
 * Per-kind model/provider defaults are read from
 * `cfg.tools.mediaUnderstanding` when present.
 */

import { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { DEFAULT_AGENT_ID, resolveModelsPath } from "../../config/paths.js";
import { loadBrigadeAuthStorage, readBrigadeCredentials } from "../../core/auth-bridge.js";
import { loadConfig } from "../../core/config.js";
import { PROVIDERS } from "../../providers/catalog.js";
import type {
	MediaUnderstandingConfig,
	MediaUnderstandingKind,
	MediaUnderstandingModel,
	MediaUnderstandingProviderId,
} from "./types.js";

/**
 * Extra env-var fallbacks for the two bespoke-adapter providers, consulted
 * AFTER the credential store. Other providers fall back through the shared
 * catalog (`PROVIDERS[*].envVar` + `envVarFallbacks`) in `resolveMediaProviderKey`.
 */
const PROVIDER_ENV: Record<string, string[]> = {
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
};

/**
 * Preference order for the Pi path's provider sweep. Vision-strong, widely-keyed
 * providers first. Providers NOT listed here still work (any keyed catalog
 * provider with an image-capable model is appended), this just orders the common
 * ones. `google`/`anthropic` are intentionally omitted — the bespoke REST
 * adapters serve those first; the Pi path is the catch-all for the rest.
 */
const PI_PROVIDER_PREFERENCE = [
	"openai",
	"openrouter",
	"groq",
	"xai",
	"mistral",
	"cerebras",
	"ollama",
];

/**
 * Resolve a provider's key for media understanding. Order:
 *   1. Brigade credential store (`readBrigadeCredentials`) — api_key.key, or
 *      an oauth credential's access token (so subscription login works).
 *   2. The provider's env var(s) — explicit overrides above, else the catalog's
 *      `envVar` + `envVarFallbacks` for that provider.
 * Returns "" when nothing resolves (keyless local providers also return "").
 */
export function resolveMediaProviderKey(
	provider: string,
	agentId: string = DEFAULT_AGENT_ID,
): string {
	try {
		const creds = readBrigadeCredentials(agentId);
		const cred = creds[provider] as
			| { type?: string; key?: string; access?: string }
			| undefined;
		if (cred) {
			if (cred.type === "api_key" && typeof cred.key === "string" && cred.key.length > 0) {
				return cred.key;
			}
			// Subscription login (oauth): use the access token for the Bearer path.
			if (cred.type === "oauth" && typeof cred.access === "string" && cred.access.length > 0) {
				return cred.access;
			}
		}
	} catch {
		/* fall through to env */
	}
	const envNames = PROVIDER_ENV[provider] ?? envVarsFromCatalog(provider);
	for (const name of envNames) {
		if (!name) continue;
		const value = process.env[name];
		if (value) return value;
	}
	return "";
}

/** Env-var names a catalog provider can be keyed from (primary + fallbacks). */
function envVarsFromCatalog(provider: string): string[] {
	const entry = PROVIDERS.find((p) => p.id === provider || p.providerId === provider);
	if (!entry) return [];
	return [entry.envVar, ...(entry.envVarFallbacks ?? [])].filter((n) => !!n);
}

/** True when a catalog provider runs without an API key (Ollama, LM Studio). */
function providerIsKeyless(provider: string): boolean {
	const entry = PROVIDERS.find((p) => p.id === provider || p.providerId === provider);
	return Boolean(entry?.noAuth);
}

/**
 * Providers (catalog ids) that currently have a usable credential for the Pi
 * path, MOST-PREFERRED first. A keyless local provider (Ollama) qualifies when
 * its server is configured (we treat it as always-eligible — the real call
 * surfaces an unreachable error). `google`/`anthropic` are excluded (the
 * bespoke adapters own them); the Pi path is the catch-all for the rest.
 */
export function listKeyedPiProviders(agentId: string = DEFAULT_AGENT_ID): string[] {
	const eligible = new Set<string>();
	for (const entry of PROVIDERS) {
		const id = entry.providerId ?? entry.id;
		if (id === "google" || id === "anthropic") continue;
		if (providerIsKeyless(entry.id)) {
			eligible.add(id);
			continue;
		}
		if (resolveMediaProviderKey(id, agentId)) eligible.add(id);
	}
	// Order: preference list first (those that are eligible), then any remaining.
	const ordered: string[] = [];
	for (const p of PI_PROVIDER_PREFERENCE) {
		if (eligible.has(p)) {
			ordered.push(p);
			eligible.delete(p);
		}
	}
	return [...ordered, ...eligible];
}

/** Read `cfg.tools.mediaUnderstanding` defaults (model/provider per kind), best-effort. */
function readConfiguredDefaults(): {
	defaultModels?: Partial<Record<MediaUnderstandingKind, string>>;
	preferredProvider?: Partial<Record<MediaUnderstandingKind, MediaUnderstandingProviderId>>;
} {
	try {
		const cfg = loadConfig() as {
			tools?: {
				mediaUnderstanding?: {
					models?: Partial<Record<MediaUnderstandingKind, string>>;
					providers?: Partial<Record<MediaUnderstandingKind, string>>;
				};
			};
		};
		const mu = cfg.tools?.mediaUnderstanding;
		if (!mu) return {};
		const out: ReturnType<typeof readConfiguredDefaults> = {};
		if (mu.models && typeof mu.models === "object") {
			const models: Partial<Record<MediaUnderstandingKind, string>> = {};
			for (const [k, v] of Object.entries(mu.models)) {
				if (typeof v === "string" && v.trim()) models[k as MediaUnderstandingKind] = v.trim();
			}
			if (Object.keys(models).length > 0) out.defaultModels = models;
		}
		if (mu.providers && typeof mu.providers === "object") {
			const providers: Partial<Record<MediaUnderstandingKind, MediaUnderstandingProviderId>> = {};
			for (const [k, v] of Object.entries(mu.providers)) {
				if (v === "google" || v === "anthropic") providers[k as MediaUnderstandingKind] = v;
			}
			if (Object.keys(providers).length > 0) out.preferredProvider = providers;
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Loose Pi `ModelRegistry` shape — we only call `getAvailable` / `find`. Kept
 * structural so a Pi version drift on unrelated methods doesn't break the build.
 */
interface LooseRegistry {
	getAvailable?: () => unknown[];
	find?: (provider: string, modelId: string) => unknown;
}

/** True when a Pi `Model`-ish object declares image input. */
function modelHasImageInput(m: unknown): boolean {
	const input = (m as { input?: unknown } | null | undefined)?.input;
	return Array.isArray(input) && input.includes("image");
}

/**
 * Build a Pi `ModelRegistry` from Brigade's auth + models.json, lazily and
 * defensively. Returns `undefined` on any failure (the Pi path then can't
 * resolve a model and the subsystem reports unavailable / falls back).
 */
function buildRegistry(agentId: string): LooseRegistry | undefined {
	try {
		const Registry = ModelRegistry as unknown as {
			create?: (authStorage: unknown, modelsJsonPath?: string) => unknown;
			new (authStorage: unknown, modelsJsonPath?: string): unknown;
		};
		if (!Registry) return undefined;
		const authStorage = loadBrigadeAuthStorage(agentId);
		const modelsFile = resolveModelsPath(agentId);
		const registry =
			typeof Registry.create === "function"
				? Registry.create(authStorage, modelsFile)
				: new Registry(authStorage, modelsFile);
		return registry as LooseRegistry;
	} catch {
		return undefined;
	}
}

/**
 * Make a `resolveModel` closure for the Pi path. Given a provider id (+ kind),
 * returns an image-capable Pi `Model` for that provider, or `undefined`.
 *
 * Resolution per provider:
 *   1. A configured default model id for this kind that belongs to the provider
 *      (`registry.find(provider, id)`), when image-capable.
 *   2. The first `registry.getAvailable()` model for the provider whose `input`
 *      includes "image".
 * The registry (built once, memoized) covers Pi's built-in catalog + models.json
 * + discovered Ollama models, so an image-capable model resolves for whichever
 * provider the operator actually has.
 */
function makeResolveModel(
	agentId: string,
	configuredModels: Partial<Record<MediaUnderstandingKind, string>> | undefined,
): (provider: string | undefined, kind: MediaUnderstandingKind) => MediaUnderstandingModel | undefined {
	let registry: LooseRegistry | undefined;
	let built = false;
	const getRegistry = (): LooseRegistry | undefined => {
		if (!built) {
			registry = buildRegistry(agentId);
			built = true;
		}
		return registry;
	};
	return (provider, kind) => {
		const reg = getRegistry();
		if (!reg) return undefined;
		const available =
			typeof reg.getAvailable === "function" ? safeGetAvailable(reg) : [];
		// 1. Configured default model id for this kind, scoped to the provider.
		const configuredId = configuredModels?.[kind]?.trim();
		if (configuredId && provider && typeof reg.find === "function") {
			let found: unknown;
			try {
				found = reg.find(provider, configuredId);
			} catch {
				found = undefined;
			}
			// The Pi path can only carry an image block, so a configured model is
			// eligible only when it declares image input — for EVERY kind. (Audio
			// never resolves here: its provider chain excludes `pi`; this is the
			// defensive backstop so a stray audio request can't pick a non-image
			// model and 400 at the provider.)
			if (found && modelHasImageInput(found)) {
				return found as MediaUnderstandingModel;
			}
		}
		// 2. First image-capable model for the provider (or, when no provider is
		//    pinned, the first image-capable model overall).
		for (const m of available) {
			const mp = (m as { provider?: unknown }).provider;
			if (provider && mp !== provider) continue;
			if (modelHasImageInput(m)) return m as MediaUnderstandingModel;
		}
		return undefined;
	};
}

function safeGetAvailable(reg: LooseRegistry): unknown[] {
	try {
		return reg.getAvailable?.() ?? [];
	} catch {
		return [];
	}
}

/**
 * Build the `MediaUnderstandingConfig` the subsystem consumes, wired to
 * Brigade's real credential store + config. `agentId` selects which agent's
 * auth profiles back the key (defaults to `main`, with the main-agent fallback
 * `readBrigadeCredentials` already applies for org agents).
 *
 * Wires the Pi path (`resolveModel` + `listKeyedProviders`) so image/audio
 * understanding works for EVERY configured provider (OpenAI / OpenRouter / Groq
 * / xAI / Mistral / Ollama / …), not just google + anthropic. `piComplete` is
 * left at the subsystem default (the real `completeSimple` wrapper).
 */
export function buildMediaUnderstandingConfig(
	agentId: string = DEFAULT_AGENT_ID,
): MediaUnderstandingConfig {
	const configured = readConfiguredDefaults();
	return {
		resolveKey: (provider) => resolveMediaProviderKey(provider, agentId),
		...(configured.defaultModels ? { defaultModels: configured.defaultModels } : {}),
		...(configured.preferredProvider ? { preferredProvider: configured.preferredProvider } : {}),
		resolveModel: makeResolveModel(agentId, configured.defaultModels),
		listKeyedProviders: () => listKeyedPiProviders(agentId),
	};
}

/**
 * Quick capability probe for doctor/status: which providers have a key, and
 * therefore which kinds can be understood via a provider. Pure read — no calls.
 */
export function probeMediaUnderstanding(agentId: string = DEFAULT_AGENT_ID): {
	google: boolean;
	anthropic: boolean;
	video: boolean;
	pdf: boolean;
	image: boolean;
} {
	const google = Boolean(resolveMediaProviderKey("google", agentId));
	const anthropic = Boolean(resolveMediaProviderKey("anthropic", agentId));
	// Image understanding is ALSO available via the Pi path whenever any non-
	// google/anthropic provider is keyed (or a keyless local provider like
	// Ollama is configured) — the real model-capability check happens at call
	// time. Lightweight probe (no registry build) keeps `doctor` fast.
	const piImage = listKeyedPiProviders(agentId).length > 0;
	return {
		google,
		anthropic,
		video: google,
		pdf: anthropic || google,
		image: anthropic || google || piImage,
	};
}
