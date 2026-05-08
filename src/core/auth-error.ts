/**
 * Brigade-native translator for the "No API key found for X" error that
 * surfaces from Pi's auth-resolution path.
 *
 * Pi's own message hardcodes `/login` (a Pi slash command Brigade doesn't
 * have) and dumps raw `node_modules/@mariozechner/pi-coding-agent/docs/`
 * paths into the user's chat. Both are direct violations of Brigade's
 * B2B-grade copy rules — paying customers see the agent gesture at a
 * non-existent command and at internal package paths.
 *
 * The replacement is a SINGLE SHORT LINE with a clear next step. Not a
 * multi-line guidance block — when the user already knows what's wrong
 * (their key isn't set), more text is more friction. Same pattern used by
 * mature production agent platforms.
 *
 * Pure function. No I/O.
 */

/** Pi's "No API key found for X" pattern (see auth-guidance.js). */
const NO_API_KEY_PATTERN = /^No API key found for ["']?([^"'.\s]+)["']?\.?/m;
/** Pi's stale-OAuth pattern (see agent-session.js) — fires at session
 *  startup when the saved credential won't authenticate. */
const OAUTH_EXPIRED_PATTERN = /^Authentication failed for ["']?([^"'.\s]+)["']?\./m;
/** Pi's OAuth token refresh failure pattern — fires mid-session when a
 *  stored OAuth token's refresh exchange fails (separate code path from
 *  the startup auth-failed error above). Both leak `/login` references. */
const OAUTH_REFRESH_PATTERN = /^OAuth token refresh failed for ["']?([^"'.\s:]+)["']?[:.]?/m;

/**
 * Detect Pi's auth-failure error and return a Brigade-native single-line
 * replacement. Returns `null` for any other error — caller falls through
 * to the normal cleanProviderError path.
 *
 * Three known patterns from Pi (each a different code path; each leaks
 * `/login` and may include raw `node_modules/.../docs/...` paths):
 *   - "No API key found for X." (auth-guidance.js — no key in storage / env)
 *   - "Authentication failed for X. Credentials may have expired …
 *      Run '/login X' to re-authenticate." (agent-session.js — startup)
 *   - "OAuth token refresh failed for X: …" (oauth refresh path — mid-session)
 */
export function translateAuthError(raw: string): string | null {
	if (!raw) return null;

	const noKey = raw.match(NO_API_KEY_PATTERN);
	if (noKey) {
		const provider = friendlyProviderName((noKey[1] ?? "").trim());
		return `⚠ Missing API key for ${provider}. Use /provider to add one, /model to switch, or run \`brigade onboard\`.`;
	}

	// OAuth refresh failure (mid-session) — the kernel "tried to use the
	// stored credential, attempted refresh, refresh round-trip failed."
	// Often transient (provider 5xx during refresh) — phrase it as such.
	const refresh = raw.match(OAUTH_REFRESH_PATTERN);
	if (refresh) {
		const provider = friendlyProviderName((refresh[1] ?? "").trim());
		return `⚠ ${provider} login refresh failed. This is often temporary — try again in a moment, or use /provider to re-authenticate.`;
	}

	// Hard auth failure (startup) — credential exists but the server rejected it
	// (expired, revoked, wrong-scope). Distinct from refresh: this needs a
	// new credential, not just a retry.
	const expired = raw.match(OAUTH_EXPIRED_PATTERN);
	if (expired) {
		const provider = friendlyProviderName((expired[1] ?? "").trim());
		return `⚠ ${provider} login was rejected (credential expired or revoked). Use /provider to add a fresh key, /model to switch, or run \`brigade onboard\`.`;
	}

	if (/^No models? (available|selected)/i.test(raw)) {
		return "⚠ No models available yet. Use /provider to add one, or run `brigade onboard` to set up.";
	}

	return null;
}

/**
 * Single-line response when a user types `/login` (a Pi command Brigade
 * doesn't have). Same shape as the auth-error translator above.
 */
export function buildLoginGuidanceMessage(): string {
	return "⚠ Brigade doesn't use /login. Use /provider to add a provider, /model to switch, or run `brigade onboard`.";
}

/**
 * Universal error-prep used by every catch site that may render a Pi error
 * to the user. Pipeline:
 *   1. Try the auth-error translator (handles `No API key`, OAuth expired,
 *      `No models available`).
 *   2. Fall back to `cleanProviderError` to peel JSON wrappers from generic
 *      provider errors (rate limits, content policy, etc).
 *
 * Single helper everywhere = no chance of one catch site forgetting to
 * translate auth errors. Whenever a NEW Pi error pattern needs handling,
 * extend `translateAuthError` once and every catch path benefits.
 */
export function friendlyError(raw: string, cleanProviderError: (s: string) => string): string {
	const translated = translateAuthError(raw);
	if (translated) return translated;
	return cleanProviderError(raw);
}

const FRIENDLY_NAMES: Readonly<Record<string, string>> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	google: "Google Gemini",
	groq: "Groq",
	cerebras: "Cerebras",
	xai: "xAI",
	deepseek: "DeepSeek",
	mistral: "Mistral",
	ollama: "Ollama",
} as const;

function friendlyProviderName(id: string): string {
	if (!id) return "the selected provider";
	const lookup = FRIENDLY_NAMES[id.toLowerCase()];
	return lookup ?? id;
}
