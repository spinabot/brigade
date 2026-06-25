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

import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { readBrigadeCredentials } from "../../core/auth-bridge.js";
import { loadConfig } from "../../core/config.js";
import type {
	MediaUnderstandingConfig,
	MediaUnderstandingKind,
	MediaUnderstandingProviderId,
} from "./types.js";

/** Catalog provider ids this subsystem can use as keys. */
const PROVIDER_ENV: Record<MediaUnderstandingProviderId, string[]> = {
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
};

/**
 * Resolve a provider's key for media understanding. Order:
 *   1. Brigade credential store (`readBrigadeCredentials`) — api_key.key, or
 *      an oauth credential's access token (so subscription login works for
 *      direct REST too).
 *   2. The provider's env var(s) as bootstrap fallback.
 * Returns "" when nothing resolves.
 */
export function resolveMediaProviderKey(
	provider: MediaUnderstandingProviderId,
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
	for (const name of PROVIDER_ENV[provider]) {
		const value = process.env[name];
		if (value) return value;
	}
	return "";
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
 * Build the `MediaUnderstandingConfig` the subsystem consumes, wired to
 * Brigade's real credential store + config. `agentId` selects which agent's
 * auth profiles back the key (defaults to `main`, with the main-agent fallback
 * `readBrigadeCredentials` already applies for org agents).
 */
export function buildMediaUnderstandingConfig(
	agentId: string = DEFAULT_AGENT_ID,
): MediaUnderstandingConfig {
	const configured = readConfiguredDefaults();
	return {
		resolveKey: (provider) => resolveMediaProviderKey(provider, agentId),
		...(configured.defaultModels ? { defaultModels: configured.defaultModels } : {}),
		...(configured.preferredProvider ? { preferredProvider: configured.preferredProvider } : {}),
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
	return {
		google,
		anthropic,
		video: google,
		pdf: anthropic || google,
		image: anthropic || google,
	};
}
