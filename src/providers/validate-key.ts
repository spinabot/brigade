/**
 * Live API key validation against each provider's `/v1/models` endpoint.
 *
 * **Why this matters.** A format-only check (length, prefix, no whitespace)
 * catches typos, but it cannot tell you whether the key is *active* — the user
 * could have pasted a revoked, deleted, or rate-limited key. Until they fire a
 * real chat turn, the bug stays hidden.
 *
 * **Why `/v1/models`.** It's the universally cheapest auth-checking endpoint:
 *   - Returns the catalogue of models the key can access
 *   - No tokens consumed, no billing event
 *   - Returns 200 quickly when auth works, 401/403 instantly when it doesn't
 *   - Same surface across every OpenAI-compatible provider (Groq, OpenRouter,
 *     xAI, Cerebras, DeepSeek, Mistral). Anthropic and Google have their own
 *     conventions, handled below.
 *
 * **Failure modes.**
 *   - 401/403 → key is invalid/revoked/wrong-provider. Hard reject.
 *   - 429    → rate limited (key probably valid). Show warning, accept anyway.
 *   - 5xx    → provider-side outage. Soft accept.
 *   - timeout/network → no internet or DNS. Hard reject (the agent loop won't
 *                       work either if the network is down).
 */

const TIMEOUT_MS = 8000;

interface OkResult {
	ok: true;
	/** Number of models the key can access (when reported). */
	modelCount?: number;
	/** Optional non-fatal hint shown to the user. */
	warning?: string;
}

interface FailResult {
	ok: false;
	reason: string;
}

export type ValidationResult = OkResult | FailResult;

/**
 * Build the validation request for a given provider.
 * Returns `null` when we have no validation endpoint for this provider —
 * caller should treat that as "skip online validation" (offline-only check).
 */
function buildRequest(providerId: string, apiKey: string): { url: string; init: RequestInit } | null {
	switch (providerId) {
		case "ollama":
			// Ollama runs locally; `/api/tags` is auth-free and lists installed models.
			return {
				url: "http://localhost:11434/api/tags",
				init: { method: "GET" },
			};
		case "anthropic":
			return {
				url: "https://api.anthropic.com/v1/models?limit=1",
				init: {
					method: "GET",
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
					},
				},
			};
		case "openai":
			return {
				url: "https://api.openai.com/v1/models",
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		case "google":
			// Google Gemini puts the key in the query string, no auth header.
			return {
				url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`,
				init: { method: "GET" },
			};
		case "openrouter":
			return {
				url: "https://openrouter.ai/api/v1/auth/key", // returns key info; cheaper than /models
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		case "groq":
			return {
				url: "https://api.groq.com/openai/v1/models",
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		case "cerebras":
			return {
				url: "https://api.cerebras.ai/v1/models",
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		case "xai":
			return {
				url: "https://api.x.ai/v1/models",
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		case "deepseek":
			return {
				url: "https://api.deepseek.com/v1/models",
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		case "mistral":
			return {
				url: "https://api.mistral.ai/v1/models",
				init: { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
			};
		default:
			return null;
	}
}

/**
 * Hit the provider's models endpoint with the supplied key and report back.
 * Never throws — always returns a typed result.
 */
export async function validateApiKeyOnline(providerId: string, apiKey: string): Promise<ValidationResult> {
	const request = buildRequest(providerId, apiKey);
	if (!request) {
		// Unknown provider: we can't validate online, but the format check above
		// already passed, so let it through. The first chat turn will surface
		// any auth issues with a real error message.
		return { ok: true, warning: `No validation endpoint configured for "${providerId}" — will be tested on first message.` };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const response = await fetch(request.url, {
			...request.init,
			signal: controller.signal,
		});

		// Try to count models from the body for friendlier success messaging.
		// Best-effort only — don't fail validation if parsing fails.
		let modelCount: number | undefined;
		if (response.ok) {
			try {
				const body = (await response.json()) as { data?: unknown[]; models?: unknown[] };
				if (Array.isArray(body.data)) modelCount = body.data.length;
				else if (Array.isArray(body.models)) modelCount = body.models.length;
			} catch {
				/* parse failure is fine — auth still verified */
			}

			// Ollama-specific: server is reachable but has zero models pulled — surface
			// that as a hard error so the user knows the next step.
			if (providerId === "ollama" && modelCount === 0) {
				return {
					ok: false,
					reason: `Ollama is running but no models are installed yet. Install one (for example: ollama pull llama3.2) and try again.`,
				};
			}

			return modelCount === undefined ? { ok: true } : { ok: true, modelCount };
		}

		// Auth-style failures: hard reject. Use the human-friendly provider name
		// (Anthropic / OpenAI / Google Gemini) rather than the internal id.
		const providerName = providerDisplayName(providerId);
		if (response.status === 401 || response.status === 403) {
			return {
				ok: false,
				reason: `${providerName} didn't accept this key. Double-check that it's correct and active.`,
			};
		}

		// Rate limited — key probably fine, just over quota right now.
		if (response.status === 429) {
			return { ok: true, warning: `${providerName} is busy right now — connecting anyway.` };
		}

		// 5xx — provider outage, not a key problem. Soft accept.
		if (response.status >= 500) {
			return { ok: true, warning: `${providerName} is having a temporary issue — connecting anyway.` };
		}

		// Anything else (404, 400, …) — surface the status and refuse.
		return {
			ok: false,
			reason: `${providerName} couldn't be reached (status ${response.status}). The key may be incorrect.`,
		};
	} catch (err) {
		const providerName = providerDisplayName(providerId);
		if (err instanceof Error && err.name === "AbortError") {
			return {
				ok: false,
				reason: `Couldn't reach ${providerName} within ${TIMEOUT_MS / 1000} seconds. Check your internet connection.`,
			};
		}
		return {
			ok: false,
			reason: `Couldn't reach ${providerName}: ${err instanceof Error ? err.message : String(err)}`,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Map raw provider id to a friendly display name. Avoids surfacing raw ids
 * like "openai" or "anthropic" in user-facing error text — enterprise users
 * expect "OpenAI", "Anthropic", "Google Gemini" instead.
 */
function providerDisplayName(providerId: string): string {
	const map: Record<string, string> = {
		anthropic: "Anthropic",
		openai: "OpenAI",
		google: "Google Gemini",
		openrouter: "OpenRouter",
		groq: "Groq",
		cerebras: "Cerebras",
		xai: "xAI",
		deepseek: "DeepSeek",
		mistral: "Mistral",
		ollama: "Ollama",
	};
	return map[providerId] ?? providerId;
}
