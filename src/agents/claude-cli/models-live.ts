// Realtime model discovery for the claude-cli backend.
//
// The hardcoded `CLAUDE_CLI_MODELS` catalog goes stale the moment Anthropic
// ships a new model (it was missing Fable 5 / Sonnet 5). This module fetches
// the account's CURRENT model list from Anthropic's `/v1/models` endpoint using
// the subscription's own OAuth access token (the same token the `claude` binary
// holds), so the onboarding picker + `/model` list always reflect what the
// subscription can actually run. Best-effort + cached: on any failure it falls
// back to the static catalog, so discovery is a pure upgrade — never a
// regression.

import fs from "node:fs";
import path from "node:path";

import { resolveOsCacheDir } from "../../config/paths.js";
import { readClaudeCliLogin } from "../../integrations/cli-login.js";
import { CLAUDE_CLI_MODELS } from "./catalog.js";
import { readEffectiveClaudeCredential } from "./claude-config.js";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;

interface ModelsCache {
	atMs: number;
	ids: string[];
}
let cache: ModelsCache | undefined;

/** Last-resort seed. Frozen at release, so it is the WORST source — used only
 *  when we have never once discovered the live list on this machine. */
function staticModelIds(): string[] {
	return CLAUDE_CLI_MODELS.map((m) => m.id);
}

// A discovered list, persisted across restarts. The in-memory cache alone meant
// every gateway restart fell back to the frozen catalog until the next
// successful fetch — so a model Anthropic shipped after this release would
// disappear from the picker on any restart that raced a stale token. Lives in
// the OS cache dir: reapable by design, and writable in convex mode where
// `~/.brigade` must stay file-free.
function discoveredCachePath(): string {
	return path.join(resolveOsCacheDir(), "claude-cli-models.json");
}

function readDiscoveredModelIds(): string[] | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(discoveredCachePath(), "utf8")) as { ids?: unknown };
		const ids = Array.isArray(raw.ids) ? raw.ids.filter((i): i is string => typeof i === "string") : [];
		return ids.length > 0 ? ids : undefined;
	} catch {
		return undefined;
	}
}

function writeDiscoveredModelIds(ids: string[]): void {
	try {
		const target = discoveredCachePath();
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({ atMs: Date.now(), ids }), "utf8");
	} catch {
		/* a cache we cannot persist is still usable in memory — never throw */
	}
}

/** Best list available WITHOUT a network call: last discovered, else the seed. */
function fallbackModelIds(): string[] {
	return readDiscoveredModelIds() ?? staticModelIds();
}

/**
 * Read a usable Claude access token for the models call. Prefers Brigade's
 * managed grant, then the operator's own `~/.claude` login. Returns undefined
 * when neither is present (→ caller uses the static list).
 */
function readAccessToken(): string | undefined {
	// The EFFECTIVE credential, not the file: on macOS the binary rotates into
	// the keychain and leaves `.credentials.json` stale, which 401s this call
	// and silently froze the picker to the release-time catalog.
	const managed = readEffectiveClaudeCredential();
	if (managed?.accessToken) return managed.accessToken;
	const own = readClaudeCliLogin();
	if (own?.type === "oauth" && own.access) return own.access;
	if (own?.type === "token" && own.token) return own.token;
	return undefined;
}

/**
 * Fetch the account's live model ids, newest-first as the API returns them.
 * Cached for `CACHE_TTL_MS`. Any failure (no token, expired token, network,
 * non-200) falls back to the static catalog ids — so a caller always gets a
 * usable, non-empty list. `force` bypasses the cache.
 */
export async function fetchClaudeCliModelIds(opts: { force?: boolean; nowMs?: number } = {}): Promise<string[]> {
	const now = opts.nowMs ?? Date.now();
	if (!opts.force && cache && now - cache.atMs < CACHE_TTL_MS) return cache.ids;

	const token = readAccessToken();
	if (!token) return fallbackModelIds();

	try {
		const res = await fetch(MODELS_URL, {
			headers: {
				authorization: `Bearer ${token}`,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "oauth-2025-04-20",
				"user-agent": "claude-cli/latest",
				"x-app": "cli",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return fallbackModelIds();
		const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const ids = (body.data ?? [])
			.map((m) => (typeof m.id === "string" ? m.id : ""))
			.filter((id): id is string => id.startsWith("claude-"));
		if (ids.length === 0) return fallbackModelIds();
		// Merge: live ids first (current), then any static id the API omitted, so a
		// catalogued default never vanishes from the picker.
		const seen = new Set(ids);
		for (const s of staticModelIds()) if (!seen.has(s)) ids.push(s);
		cache = { atMs: now, ids };
		writeDiscoveredModelIds(ids);
		return ids;
	} catch {
		return fallbackModelIds();
	}
}

/** Test-only cache reset. */
export function __resetClaudeCliModelsCache(): void {
	cache = undefined;
}
