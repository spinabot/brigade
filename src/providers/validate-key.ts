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
 *
 * **The one exception: OpenCode.** Its `/models` route answers 200 with NO
 * credential at all, so a listing call would "validate" a garbage key. It is
 * probed with a one-token completion instead, and since the gateway answers 401
 * for an unknown MODEL exactly as it does for a bad KEY, the verdict comes from
 * `error.type` in the body — see `interpretOpenCodeFailure`.
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

interface ValidationProbe {
	url: string;
	init: RequestInit;
	/**
	 * Provider-specific reading of a FAILED response. The body is read ONLY when
	 * this hook exists, so no other provider's response is touched. Return `null`
	 * to fall through to the generic status ladder.
	 */
	interpretFailure?: (status: number, bodyText: string) => ValidationResult | null;
}

/**
 * Build the validation request for a given provider.
 * Returns `null` when we have no validation endpoint for this provider —
 * caller should treat that as "skip online validation" (offline-only check).
 */
function buildRequest(providerId: string, apiKey: string): ValidationProbe | null {
	switch (providerId) {
		case "ollama":
			// Ollama runs locally; `/api/tags` is auth-free and lists installed models.
			return {
				url: "http://127.0.0.1:11434/api/tags",
				init: { method: "GET" },
			};
		case "anthropic": {
			// OAuth / setup-token credentials (sk-ant-oat…) authenticate via a
			// Bearer header + the OAuth beta gate — sending them as `x-api-key`
			// returns a spurious 401. Normal console keys (sk-ant-api…) keep the
			// x-api-key path. Both validate against the same /v1/models endpoint.
			const isOAuth = apiKey.includes("sk-ant-oat");
			return {
				url: "https://api.anthropic.com/v1/models?limit=1",
				init: {
					method: "GET",
					headers: isOAuth
						? {
								Authorization: `Bearer ${apiKey}`,
								"anthropic-version": "2023-06-01",
								"anthropic-beta": "oauth-2025-04-20",
								"user-agent": "claude-cli/2.1.75",
								"x-app": "cli",
							}
						: {
								"x-api-key": apiKey,
								"anthropic-version": "2023-06-01",
							},
				},
			};
		}
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
		case "opencode":
		case "opencode-go": {
			// A listing call can't validate here (see the header note) — a one-token
			// completion is the cheapest request that actually authenticates.
			const isGo = providerId === "opencode-go";
			return {
				url: isGo
					? "https://opencode.ai/zen/go/v1/chat/completions"
					: "https://opencode.ai/zen/v1/chat/completions",
				init: {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({
						model: isGo ? OPENCODE_GO_PROBE_MODEL : OPENCODE_ZEN_PROBE_MODEL,
						messages: [{ role: "user", content: "hi" }],
						max_tokens: 1,
						stream: false,
					}),
				},
				interpretFailure: (status, bodyText) => interpretOpenCodeFailure(providerId, status, bodyText),
			};
		}
		default:
			return null;
	}
}

/* ─────────────────────────── OpenCode ─────────────────────────── */

/**
 * Probe models. Both are `openai-completions` on the `/v1` host we post the
 * OpenAI-shaped body to, and both dodge the per-model gates upstream applies to
 * the Go catalogue (`deepseek-*` is CN-region-locked, `muse-spark-*` is
 * data-policy gated) — either would answer before auth was ever checked.
 * `big-pickle` is free, so a Zen probe never bills; Go has no free tier, and one
 * token of `mimo-v2.5` rounds to nothing. Neither id is assumed to survive: a
 * retired probe model answers `ModelError`, which soft-accepts below.
 */
const OPENCODE_ZEN_PROBE_MODEL = "big-pickle";
const OPENCODE_GO_PROBE_MODEL = "mimo-v2.5";

/**
 * Error types that mean "the key authenticated; this request can't be served".
 * Each supplies the tail of the note shown to the user.
 */
const OPENCODE_ACCOUNT_FAILURES: Readonly<Record<string, string>> = {
	CreditsError: "the account is out of credits — top up at https://opencode.ai/auth.",
	MonthlyLimitError: "the account has hit its monthly limit.",
	UserLimitError: "the account has hit its per-user limit.",
	FreeUsageLimitError: "the free-tier allowance is used up for now.",
	GoUsageLimitError: "the Go plan's allowance is used up for now.",
	BlackUsageLimitError: "the plan's allowance is used up for now.",
	RateLimitError: "it's rate-limiting this key right now — connecting anyway.",
	RegionError: "it doesn't serve requests from this region.",
	DataPolicyError: "the account's data policy blocks the model we test with.",
};

/** `{"type":"error","error":{"type":"AuthError","message":"…"}}` → the inner pair. */
function readOpenCodeError(bodyText: string): { type: string; message: string } | null {
	if (!bodyText) return null;
	try {
		const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown } };
		const inner = parsed?.error;
		if (!inner || typeof inner.type !== "string" || inner.type.length === 0) return null;
		return { type: inner.type, message: typeof inner.message === "string" ? inner.message : "" };
	} catch {
		return null;
	}
}

/**
 * `AuthError` is the ONLY type that means the key is bad; everything else
 * soft-accepts, because refusing a valid key over our own retired probe model is
 * the worst outcome available here. Returns `null` for an unreadable body so the
 * generic status ladder still applies.
 *
 * No "subscribe to Go" hint: upstream falls through to pay-as-you-go when a
 * workspace has no Go plan, so an unsubscribed key either works or reports
 * CreditsError — telling the operator to subscribe would be the wrong next step,
 * and flatly wrong on GoUsageLimitError (which means they DO have a plan).
 */
function interpretOpenCodeFailure(
	providerId: string,
	status: number,
	bodyText: string,
): ValidationResult | null {
	const providerName = providerDisplayName(providerId);
	const err = readOpenCodeError(bodyText);
	if (!err) {
		// No envelope. Every real gateway refusal carries one, so a bare 4xx on this
		// route means OUR probe is malformed or misrouted — a moved endpoint, a
		// rejected `max_tokens`, an edge-proxy error page. Blaming the key for that
		// is the failure this whole function exists to avoid. 401 still falls
		// through: it's the one status that genuinely implicates the credential.
		if (status === 400 || status === 404 || status === 405) {
			return {
				ok: true,
				warning: `Couldn't fully verify the key — ${providerName} rejected the test request (HTTP ${status}). Connecting anyway.`,
			};
		}
		return null;
	}
	const rejected = `${providerName} didn't accept this key. Double-check that it's correct and active.`;

	if (err.type === "AuthError") return { ok: false, reason: rejected };

	// `typeof` rather than truthiness: the map is a plain object, so a response
	// naming `constructor` / `toString` would otherwise resolve up the prototype
	// chain and interpolate a function into the warning.
	const tail = OPENCODE_ACCOUNT_FAILURES[err.type];
	if (typeof tail === "string") {
		return { ok: true, warning: `${providerName} accepted the key, but ${tail}` };
	}

	if (err.type === "ModelError") {
		return {
			ok: true,
			warning: `Couldn't fully verify the key — ${providerName} no longer serves the model we test with. Connecting anyway.`,
		};
	}

	// A type we don't know yet: sniff the message so a renamed AuthError still gets
	// caught, otherwise soft-accept and name the type.
	if (/invalid api key|unauthori[sz]ed|authenticat/i.test(err.message)) {
		return { ok: false, reason: rejected };
	}
	return {
		ok: true,
		warning: `Couldn't fully verify the key — ${providerName} answered "${err.type}". Connecting anyway.`,
	};
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

		// Providers whose status codes don't carry the meaning get first say.
		if (request.interpretFailure) {
			let bodyText = "";
			try {
				bodyText = await response.text();
			} catch {
				/* unreadable body — fall through to the generic ladder */
			}
			const verdict = request.interpretFailure(response.status, bodyText);
			if (verdict) return verdict;
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
			reason: `${providerName} couldn't be reached. The key may be incorrect.`,
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
		opencode: "OpenCode Zen",
		"opencode-go": "OpenCode Go",
		ollama: "Ollama",
	};
	return map[providerId] ?? providerId;
}
