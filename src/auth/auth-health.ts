/**
 * Auth health — detect subscription credentials that CANNOT auto-refresh and
 * will eventually 401 (the silent "gateway disconnected after a day or two"
 * failure the operator hit).
 *
 * A subscription login is self-healing ONLY when stored as a proper OAuth
 * credential WITH a refresh token: Pi refreshes the rotating access token and
 * `auth-bridge` persists it (see core/auth-bridge.ts). These do NOT self-heal:
 *   - type "token"   — a bare access token (no refresh), e.g. a CLI login that
 *                      lacked a refresh token.
 *   - type "api_key" holding an `sk-ant-oat…` subscription access token (pasted
 *                      or written by an older onboarding path).
 *   - type "oauth"   with no refresh token.
 * `autoHealSubscriptions` recovers these at gateway boot by re-syncing from the
 * vendor CLI login (Claude Code) — no user action. `brigade login` is only the
 * manual fallback when there is no CLI login present to adopt.
 *
 * Reads through the mode-aware `readProfiles` choke point, so it is correct in
 * BOTH filesystem and Convex mode (it never touches a raw file or the store
 * adapter directly).
 */

import { DEFAULT_AGENT_ID } from "../config/paths.js";
import { readClaudeCliLogin } from "../integrations/cli-login.js";
import { PROVIDERS } from "../providers/catalog.js";
import { readProfiles, updateOAuthTokens, upsertOAuthProfile } from "./profiles.js";

export interface UnrefreshableSubscription {
	/** Stored provider id (where the credential lives, e.g. "anthropic"). */
	provider: string;
	/** Friendly provider name (e.g. "Claude Code"). */
	label: string;
	/** Why it can't refresh. */
	reason: string;
}

/** The minimal profile shape the classifier inspects. */
export interface RefreshScanProfile {
	type?: string;
	key?: string;
	access?: string;
	refresh?: string;
	refreshRef?: unknown;
	token?: string;
}

/**
 * Classify whether a stored profile can auto-refresh. Returns the human reason
 * it CAN'T (for warnings), or null when the credential is healthy. Pure — unit
 * testable without any storage.
 */
export function classifySubscriptionRefresh(prof: RefreshScanProfile): string | null {
	if (prof.type === "token" || (!prof.type && typeof prof.token === "string" && prof.token.length > 0)) {
		return "stored as a one-time token with no refresh token";
	}
	if (prof.type === "oauth") {
		const hasRefresh =
			(typeof prof.refresh === "string" && prof.refresh.length > 0) || prof.refreshRef != null;
		return hasRefresh ? null : "OAuth login is missing its refresh token";
	}
	if (prof.type === "api_key") {
		// A subscription ACCESS token (sk-ant-oat…) pasted as a static key expires
		// and can't refresh. A real API key (sk-ant-api…) doesn't expire — fine.
		if (typeof prof.key === "string" && prof.key.startsWith("sk-ant-oat")) {
			return "a subscription token is stored as a static key — it expires and can't refresh";
		}
		return null;
	}
	return null;
}

/**
 * Scan stored auth profiles for subscription credentials that can't auto-refresh.
 * One entry per affected subscription provider; empty = all healthy (or none).
 * Mode-aware (fs + Convex) via `readProfiles`.
 */
export function detectUnrefreshableSubscriptions(
	agentId: string = DEFAULT_AGENT_ID,
): UnrefreshableSubscription[] {
	// The stored provider ids that represent a subscription login (+ a label).
	const subProviders = new Map<string, string>();
	for (const p of PROVIDERS) {
		if (!p.subscription) continue;
		const stored = (p as { providerId?: string }).providerId ?? p.id;
		if (!subProviders.has(stored)) subProviders.set(stored, p.name);
	}

	let profiles: Record<string, RefreshScanProfile & { provider?: string }> = {};
	try {
		const file = readProfiles(agentId) as unknown as {
			profiles?: Record<string, RefreshScanProfile & { provider?: string }>;
		};
		profiles = file.profiles ?? {};
	} catch {
		return [];
	}

	const out: UnrefreshableSubscription[] = [];
	const seen = new Set<string>();
	for (const prof of Object.values(profiles)) {
		const provider = prof?.provider;
		if (!provider || !subProviders.has(provider) || seen.has(provider)) continue;
		const reason = classifySubscriptionRefresh(prof);
		if (reason) {
			seen.add(provider);
			out.push({ provider, label: subProviders.get(provider)!, reason });
		}
	}
	return out;
}

/**
 * SELF-HEAL: silently upgrade unrefreshable subscription logins to a refreshable
 * OAuth credential by re-reading the vendor CLI's CURRENT login (which carries a
 * refresh token Pi can rotate). Zero user action — this turns the "static token"
 * warning into an automatic fix at gateway boot instead of a manual `brigade
 * login`.
 *
 * Claude: reads the Claude Code CLI login (`~/.claude/.credentials.json`, a
 * plaintext file on Windows/Linux). If it carries a refresh token, the stored
 * `anthropic` profile is rewritten as `type:"oauth"` and Pi keeps it refreshed
 * from then on (auth-bridge persists each rotation). Best-effort + defensive: a
 * missing/refresh-less CLI login leaves the credential untouched (the caller then
 * warns). Returns the provider labels it healed, for a one-line boot log.
 */
export function autoHealSubscriptions(agentId: string = DEFAULT_AGENT_ID): string[] {
	const healed: string[] = [];
	for (const sub of detectUnrefreshableSubscriptions(agentId)) {
		// Claude only for now — its CLI login is an on-disk file we can read on
		// every OS (Codex/Copilot heal paths can slot in the same way later).
		if (sub.provider !== "anthropic") continue;
		const cli = readClaudeCliLogin();
		if (cli?.type === "oauth" && cli.access && cli.refresh) {
			upsertOAuthProfile(agentId, {
				provider: "anthropic",
				access: cli.access,
				refresh: cli.refresh,
				...(cli.expires !== undefined ? { expires: cli.expires } : {}),
				// Mark the credential as borrowed from the vendor CLI so
				// `adoptNewerClaudeCliLogin` keeps it synced with the CLI's own
				// rotations from here on.
				metadata: { importedFrom: "claude-cli" },
			});
			healed.push(sub.label);
		}
	}
	return healed;
}

/**
 * SPLIT-BRAIN GUARD for credentials borrowed from the Claude Code CLI.
 *
 * When Brigade adopts the CLI's login (onboarding "reuse this machine's
 * login" / `autoHealSubscriptions`), BOTH processes end up holding the same
 * OAuth grant — and each refresh ROTATES the refresh token. The vendor CLI
 * refreshes constantly as the operator uses it, so Brigade's stored copy
 * goes stale within hours; when Brigade later refreshes its stale copy the
 * two logins race and one of them dies (the recurring "login dropped" bug,
 * this time across processes rather than restarts).
 *
 * This sync runs at every credential-map build (per turn + boot): if the
 * stored anthropic profile is the SAME grant family as the CLI file and the
 * CLI holds a NEWER access token, adopt the CLI's tokens instead of
 * refreshing our stale ones. Brigade then only performs its own refresh when
 * the CLI has been idle past expiry — the narrowest window we can get
 * without writing the vendor CLI's credential file.
 *
 * Same-family detection: the `importedFrom: "claude-cli"` metadata stamp, or
 * (for profiles imported before the stamp existed) literal access/refresh
 * token equality — in which case the stamp is added so the link survives
 * future rotation divergence. A profile from an independent `brigade login`
 * browser grant carries neither and is never touched.
 *
 * Best-effort + defensive like the rest of this module: any read/parse
 * failure is a no-op. Returns true when newer CLI tokens were adopted.
 */
export function adoptNewerClaudeCliLogin(agentId: string = DEFAULT_AGENT_ID): boolean {
	try {
		const cli = readClaudeCliLogin();
		if (!cli || cli.type !== "oauth" || !cli.access || !cli.refresh) return false;
		const file = readProfiles(agentId) as unknown as {
			profiles?: Record<string, CliAdoptionProfile & { provider?: string; type?: string }>;
		};
		const prof = Object.values(file.profiles ?? {}).find(
			(p) => p?.provider === "anthropic" && p?.type === "oauth",
		);
		if (!prof) return false;

		const decision = decideCliLoginAdoption(prof, cli);
		if (decision === "stamp") {
			// Nothing newer to adopt — but stamp the family link once so a future
			// rotation on either side can't sever it.
			updateOAuthTokens(agentId, "anthropic", { metadata: { importedFrom: "claude-cli" } });
			return false;
		}
		if (decision !== "adopt") return false;

		updateOAuthTokens(agentId, "anthropic", {
			access: cli.access,
			refresh: cli.refresh,
			expires: cli.expires,
			metadata: { importedFrom: "claude-cli" },
		});
		return true;
	} catch {
		return false;
	}
}

const ANTHROPIC_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code's public OAuth client id — the same client the vendor CLI and
// its IDE extensions use (it's echoed back in every /api/oauth/profile
// response as `application.uuid`). Needed to refresh a subscription grant.
const CLAUDE_CODE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export type DeadLoginHealResult = "refreshed" | "adopted" | "none";

interface HealRefreshedTokens {
	access: string;
	refresh: string;
	expires: number;
}

/**
 * LAST-RESORT heal for a subscription login whose access token has expired.
 *
 * `adoptNewerClaudeCliLogin` covers borrowed logins it can LINK to the CLI
 * file (metadata stamp or token equality). But a profile that diverged
 * BEFORE the stamp existed — the CLI rotated the shared grant while Brigade
 * held the old copy — matches nothing: its access token is expired, its
 * refresh token was invalidated by the rotation, and Pi's refresh dies with
 * "No API key for provider". This function recovers that state without
 * guessing:
 *
 *   1. Try a REAL refresh with the stored refresh token. If it succeeds the
 *      grant is alive (an independent `brigade login`, or a borrow the
 *      vendor still honours) — persist the rotated tokens and stop. An
 *      independent grant is never clobbered by adoption.
 *   2. Only when the refresh is REJECTED (grant dead) adopt the machine's
 *      Claude Code CLI login — the same choice the operator made when they
 *      picked "reuse this machine's login" — and stamp the family link so
 *      the per-turn sync keeps it fresh from now on.
 *   3. No CLI login to adopt → "none"; the auth error surfaces normally.
 *
 * Network I/O happens ONLY when the stored access token is already expired
 * (a state that otherwise guarantees a failed turn). Concurrent calls for
 * the same agent are coalesced. Best-effort: any failure returns "none".
 */
export async function healDeadSubscriptionLogin(
	agentId: string = DEFAULT_AGENT_ID,
	opts: {
		/** Injectable for tests — performs the OAuth refresh, null on rejection. */
		refreshFn?: (refreshToken: string) => Promise<HealRefreshedTokens | null>;
		/** Injectable for tests — reads the vendor CLI login file. */
		cliRead?: typeof readClaudeCliLogin;
		nowMs?: number;
	} = {},
): Promise<DeadLoginHealResult> {
	const inFlight = healInFlightByAgent.get(agentId);
	if (inFlight) return inFlight;
	const run = healDeadSubscriptionLoginInner(agentId, opts).finally(() => {
		healInFlightByAgent.delete(agentId);
	});
	healInFlightByAgent.set(agentId, run);
	return run;
}

const healInFlightByAgent = new Map<string, Promise<DeadLoginHealResult>>();

async function healDeadSubscriptionLoginInner(
	agentId: string,
	opts: {
		refreshFn?: (refreshToken: string) => Promise<HealRefreshedTokens | null>;
		cliRead?: typeof readClaudeCliLogin;
		nowMs?: number;
	},
): Promise<DeadLoginHealResult> {
	try {
		const now = opts.nowMs ?? Date.now();
		const file = readProfiles(agentId) as unknown as {
			profiles?: Record<string, CliAdoptionProfile & { provider?: string; type?: string }>;
		};
		const prof = Object.values(file.profiles ?? {}).find(
			(p) => p?.provider === "anthropic" && p?.type === "oauth",
		);
		if (!prof) return "none";
		if (typeof prof.refresh !== "string" || prof.refresh.length === 0) return "none";
		// Only act on a PROVABLY expired (or about-to-expire) access token. A token
		// still comfortably valid needs no help; a missing/zero expiry is left to
		// Pi's normal refresh (acting on it would race Pi's own refresh). The 60s
		// skew refreshes just BEFORE the boundary rather than just after.
		const expires = typeof prof.expires === "number" && Number.isFinite(prof.expires) ? prof.expires : 0;
		if (expires === 0 || expires > now + 60_000) return "none";

		const cli = (opts.cliRead ?? readClaudeCliLogin)();
		const cliOauth = cli && cli.type === "oauth" && cli.access && cli.refresh ? cli : null;
		// A linkable CLI login is the sync path's job — don't duplicate it here.
		if (cliOauth && decideCliLoginAdoption(prof, cliOauth) !== "none") return "none";

		// 1) The stored grant may still be alive — a real refresh settles it.
		const refreshed = await (opts.refreshFn ?? refreshAnthropicOAuthToken)(prof.refresh);
		if (refreshed) {
			updateOAuthTokens(agentId, "anthropic", {
				access: refreshed.access,
				refresh: refreshed.refresh,
				expires: refreshed.expires,
			});
			return "refreshed";
		}

		// 2) Grant is dead. Adopt the machine's CLI login if it's usable.
		const cliExpires =
			cliOauth && typeof cliOauth.expires === "number" && Number.isFinite(cliOauth.expires)
				? cliOauth.expires
				: 0;
		if (cliOauth && cliExpires > expires) {
			updateOAuthTokens(agentId, "anthropic", {
				access: cliOauth.access,
				refresh: cliOauth.refresh,
				expires: cliOauth.expires,
				metadata: { importedFrom: "claude-cli" },
			});
			return "adopted";
		}
		return "none";
	} catch {
		return "none";
	}
}

/** Real OAuth refresh against the vendor token endpoint. Null on rejection
 *  (dead grant) OR network failure — the caller treats both as "not alive
 *  here"; a network blip then simply falls through to the adopt/none path. */
async function refreshAnthropicOAuthToken(refreshToken: string): Promise<HealRefreshedTokens | null> {
	try {
		const res = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
				refresh_token: refreshToken,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!data.access_token || !data.refresh_token) return null;
		const ttlMs = (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000;
		// 5-minute early-expiry margin, mirroring the SDK's login flow.
		return {
			access: data.access_token,
			refresh: data.refresh_token,
			expires: Date.now() + ttlMs - 5 * 60_000,
		};
	} catch {
		return null;
	}
}

/** The stored-profile fields the adoption decision inspects. */
export interface CliAdoptionProfile {
	access?: string;
	refresh?: string;
	expires?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Pure decision core for `adoptNewerClaudeCliLogin` (unit-testable without
 * storage or the CLI file):
 *   - "adopt" — same grant family and the CLI holds newer tokens.
 *   - "stamp" — same family, nothing newer, but the profile predates the
 *     `importedFrom` stamp; write the stamp so the link survives divergence.
 *   - "none"  — different grant (independent `brigade login`) or already
 *     up to date and stamped.
 */
export function decideCliLoginAdoption(
	prof: CliAdoptionProfile,
	cli: { access: string; refresh: string; expires?: number },
): "adopt" | "stamp" | "none" {
	const stamped = prof.metadata?.importedFrom === "claude-cli";
	const sameFamily =
		stamped ||
		(typeof prof.access === "string" && prof.access.length > 0 && prof.access === cli.access) ||
		(typeof prof.refresh === "string" && prof.refresh.length > 0 && prof.refresh === cli.refresh);
	if (!sameFamily) return "none";

	const cliExpires = typeof cli.expires === "number" && Number.isFinite(cli.expires) ? cli.expires : 0;
	const profExpires =
		typeof prof.expires === "number" && Number.isFinite(prof.expires) ? prof.expires : 0;
	if (cliExpires <= profExpires) return stamped ? "none" : "stamp";
	return "adopt";
}

/** One-line-per-provider operator warning, or "" when healthy. */
export function formatUnrefreshableWarning(list: readonly UnrefreshableSubscription[]): string {
	if (list.length === 0) return "";
	const lines = list.map((c) => `  • ${c.label}: ${c.reason}`);
	return [
		"Subscription login(s) that can't auto-refresh and will eventually fail:",
		...lines,
		"Fix: run `brigade login` to sign in again (stores a refreshable credential).",
	].join("\n");
}
