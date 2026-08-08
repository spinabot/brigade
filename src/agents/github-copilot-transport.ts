/**
 * GitHub Copilot transport resolution — WHICH endpoint and WHICH host a given
 * Copilot model must be called on, for THIS account.
 *
 * Both are account-specific and neither is knowable from a static catalog:
 *
 *   • HOST. Individual, business and enterprise seats each get their own API
 *     host, encoded in the bearer token (`…;proxy-ep=proxy.business.github
 *     copilot.com;…`). Pi's bundled catalog hardcodes the INDIVIDUAL host, so an
 *     enterprise seat pointed at it gets `421 Misdirected Request` on every call.
 *
 *   • ENDPOINT. Copilot serves GPT-5+ / o-series / codex models ONLY on
 *     `/responses`; everything else (Claude, Gemini, gpt-4.x) on
 *     `/chat/completions`. Asking on the wrong one is the OTHER `421
 *     Misdirected Request` (or a 400 "not accessible via the /chat/completions
 *     endpoint"). GitHub's `/models` listing carries no endpoint metadata today
 *     (github/copilot-cli#4337), and new families keep appearing on enterprise
 *     tenants ahead of any bundled catalog — `gpt-5.6-*` is the current one.
 *
 * So endpoint selection is resolved DYNAMICALLY, newest evidence first:
 *
 *   1. LEARNED — what the live API actually accepted for this id. Set by the
 *      self-healing stream wrapper below the first time a request is rejected
 *      for endpoint reasons, so the mistake happens at most once per process
 *      and never reaches the user.
 *   2. ADVERTISED — an endpoint list on the account's own `/models` entry, if
 *      GitHub ever ships one (parsed defensively; absent today).
 *   3. FAMILY — the id-family rule, which is what Pi's bundled catalog encodes
 *      and what GitHub's own clients assume.
 *
 * The host is always re-derived from the LIVE token, so a seat that moves
 * between tiers (or a fresh login) routes correctly with no code change.
 */

import { fetchGitHubCopilotModels, getCopilotModelHint, listCopilotModelHints } from "../integrations/provider-discovery.js";

/** Pi's provider id for the Copilot subscription backend. */
export const GITHUB_COPILOT_PROVIDER = "github-copilot";

/** The two API surfaces Copilot exposes, in Pi's `api` vocabulary. */
export type CopilotApi = "openai-responses" | "openai-completions";

/**
 * The editor headers Copilot's API REQUIRES. Business/enterprise tenants reject
 * a request without them with `421 Misdirected Request`. Pi's bundled catalog
 * carries these per model; we re-apply them so a synthesized id can't lose them.
 */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

/** Loose Pi Model shape — we only ever read/replace transport fields. */
type LooseModel = Record<string, unknown> & {
	provider?: string;
	id?: string;
	api?: string;
	baseUrl?: string;
	headers?: unknown;
};

/* ───────────────────────────── endpoint selection ───────────────────────────── */

/**
 * Layer 3 — the id-family rule. Mirrors exactly what Pi's bundled Copilot
 * catalog encodes (every `gpt-5*` entry is `openai-responses`, `gpt-4.1` is
 * `openai-completions`) and extends it to families the catalog doesn't ship yet.
 */
export function githubCopilotApiForModelId(modelId: string): CopilotApi {
	const id = modelId.trim().toLowerCase().replace(/^github-copilot\//, "");
	if (/codex/.test(id)) return "openai-responses";
	if (/^o[1-9](?:$|[-.])/.test(id)) return "openai-responses";
	const gpt = /^gpt-(\d+)/.exec(id);
	if (gpt?.[1] && Number(gpt[1]) >= 5) return "openai-responses";
	return "openai-completions";
}

/**
 * Learned endpoints — id → the api surface the live account actually accepted.
 *
 * Process-scoped by design. The gateway is long-lived, so one correction covers
 * every later turn; a restart re-derives from the advertised/family layers,
 * which are right for every model family known so far. Deliberately NOT written
 * to disk: it would need a mode-aware write path (convex mode keeps `~/.brigade`
 * file-free) to cache something we can re-learn in a single request.
 */
const learnedCopilotApi = new Map<string, CopilotApi>();

/** Record what the live API accepted for `modelId` (self-heal, see below). */
export function rememberGitHubCopilotApi(modelId: string, api: CopilotApi): void {
	learnedCopilotApi.set(modelId.trim().toLowerCase(), api);
}

/** Test seam — drop everything learned this process. */
export function resetLearnedGitHubCopilotApis(): void {
	learnedCopilotApi.clear();
}

/** The other API surface. A rejected endpoint leaves exactly one alternative. */
export function flipCopilotApi(api: string | undefined): CopilotApi {
	return api === "openai-responses" ? "openai-completions" : "openai-responses";
}

/**
 * The endpoint this model must use, resolved dynamically: learned → advertised
 * by the account's own catalog → family rule.
 */
export function resolveGitHubCopilotApi(modelId: string): CopilotApi {
	const key = modelId.trim().toLowerCase();
	const learned = learnedCopilotApi.get(key);
	if (learned) return learned;
	const advertised = getCopilotModelHint(modelId)?.api;
	if (advertised) return advertised;
	return githubCopilotApiForModelId(modelId);
}

/**
 * Make sure the account's live catalog is loaded before routing decisions.
 *
 * The advertised layer is only useful if the hints are actually in memory, and
 * `/models` DOES carry `supported_endpoints` today (verified live: 35 of 53
 * entries, and it is the only thing that gets a family like `mai-code-1-flash`
 * — `/responses`-only, matching no id heuristic — right). So warm it on the turn
 * path too, not just when synthesizing an unknown id.
 *
 * Cost-shaped: awaited only when we have nothing for this model (first turn on a
 * cold cache); otherwise the cached hint is used immediately and the refresh
 * runs detached. `fetchGitHubCopilotModels` is 5-minute cached, timeout-bounded
 * and swallows its own errors, so the worst case is that we fall through to the
 * family rule exactly as before.
 */
export async function warmGitHubCopilotHints(modelId: string, token: string | undefined): Promise<void> {
	if (!token) return;
	if (getCopilotModelHint(modelId)) {
		void fetchGitHubCopilotModels(token).catch(() => {}); // keep it fresh for the next turn
		return;
	}
	await fetchGitHubCopilotModels(token).catch(() => {});
}

/* ─────────────────────────────── host selection ─────────────────────────────── */

/**
 * The API host THIS account must talk to, parsed out of the live Copilot bearer
 * token. Handles both the dotcom shape (`proxy.<tier>.githubcopilot.com` →
 * `api.<tier>.…`) and the GitHub Enterprise shape (`copilot-proxy.<host>` →
 * `copilot-api.<host>`).
 */
export function githubCopilotBaseUrlFromToken(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const proxyHost = /proxy-ep=([^;,\s]+)/.exec(token)?.[1];
	if (!proxyHost) return undefined;
	const apiHost = proxyHost.startsWith("copilot-proxy.")
		? proxyHost.replace(/^copilot-proxy\./, "copilot-api.")
		: proxyHost.replace(/^proxy\./, "api.");
	// Hostname (optional :port) only — never splice an arbitrary token field into a URL.
	if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(apiHost)) return undefined;
	return `https://${apiHost}`;
}

/** True when the baseUrl is one of Pi's bundled Copilot hosts (safe to re-point). */
function isBundledCopilotHost(baseUrl: unknown): boolean {
	return typeof baseUrl === "string" && /\/\/[A-Za-z0-9.-]*githubcopilot\.com(?::\d+)?(?:\/|$)/.test(baseUrl);
}

/* ─────────────────────────────── model correction ────────────────────────────── */

/**
 * Correct a resolved Copilot model's transport before it reaches Pi. Applied at
 * ONE choke point in the agent loop, so the catalogued path and the synthesized
 * path are both covered:
 *
 *   • `api` — the endpoint this id is actually served on (see resolution order).
 *   • `baseUrl` — this seat's host, from the live token. A deliberately
 *     configured non-Copilot baseUrl (a corporate gateway in models.json) is
 *     left alone.
 *   • `headers` — Copilot's required editor headers, always present.
 *
 * Pure: returns the input untouched for any other provider.
 */
export function applyGitHubCopilotRouting(model: unknown, modelId: string, copilotToken?: string): unknown {
	if (!model || typeof model !== "object") return model;
	const m = model as LooseModel;
	if (m.provider !== GITHUB_COPILOT_PROVIDER) return model;

	const next: LooseModel = { ...m };
	const wantedApi = resolveGitHubCopilotApi(modelId);
	if (next.api !== wantedApi) {
		// `compat` / `thinkingLevelMap` describe the endpoint the model came from
		// (e.g. a Claude chat-completions catalog entry). Carrying them onto the
		// other API sends flags it doesn't understand — drop them and let Pi's
		// per-api defaults apply.
		delete next.compat;
		delete next.thinkingLevelMap;
		next.api = wantedApi;
	}

	const tokenBaseUrl = githubCopilotBaseUrlFromToken(copilotToken);
	if (tokenBaseUrl && (next.baseUrl === undefined || isBundledCopilotHost(next.baseUrl))) {
		next.baseUrl = tokenBaseUrl;
	}

	next.headers =
		next.headers && typeof next.headers === "object"
			? { ...COPILOT_EDITOR_HEADERS, ...(next.headers as Record<string, string>) }
			: { ...COPILOT_EDITOR_HEADERS };

	return next;
}

/* ───────────────────────────── plan + auto model ───────────────────────────── */

/** The synthetic model id that means "let Brigade choose for this seat". */
export const COPILOT_AUTO_MODEL_ID = "auto";

export interface CopilotPlan {
	/** Raw `sku` from the token, e.g. `free_limited_copilot`, `copilot_for_business`. */
	sku?: string;
	/** Human label for onboarding / the picker. */
	label: string;
	/** A Free (or Student-equivalent) seat. */
	isFree: boolean;
	/**
	 * Whether the seat may choose its own model. GitHub removed manual model
	 * selection from Copilot Free in June 2026, and reports it per model as
	 * `model_picker_enabled: false` — on a Free seat that is false for EVERY
	 * entry, which is the signal we read rather than hardcoding plan names.
	 */
	canPickModels: boolean;
}

/**
 * What plan is this seat on? Read from the token's own `sku`, cross-checked
 * against the catalog's picker flags — so a plan GitHub invents next quarter is
 * classified by behaviour ("nothing is pickable") rather than by a name we'd
 * have to keep updating.
 */
export function copilotPlanFromToken(token: string | undefined): CopilotPlan {
	const sku = token ? /(?:^|;)\s*sku=([^;]+)/.exec(token)?.[1] : undefined;
	const isFree = !!sku && /free|student/i.test(sku);
	const hints = listCopilotModelHints();
	// Only trust the catalog when we actually have one; an empty cache must not
	// be read as "nothing is pickable".
	const catalogSaysNoPicking = hints.length > 0 && hints.every((h) => h.pickerEnabled !== true);
	const label = sku ? sku.replace(/_/g, " ").replace(/\bcopilot\b/gi, "Copilot").trim() : "GitHub Copilot";
	return { sku, label, isFree, canPickModels: !(isFree || catalogSaysNoPicking) };
}

/**
 * Resolve `auto` to a concrete model this seat can actually run.
 *
 * Ranked from the account's own catalog, never a hardcoded list:
 *   1. drop anything the API has already refused (learned at runtime)
 *   2. drop policy-disabled and non-tool-calling models — Brigade needs tools
 *   3. drop models whose `restricted_to` excludes this seat's sku (advisory:
 *      the field over-promises, so it only ever narrows, never confirms)
 *   4. prefer the seat's own `is_chat_default`, then vision, then the largest
 *      context window
 *
 * Returns `undefined` when the catalog isn't loaded or nothing survives, and the
 * caller falls back to its configured model. Entitlement mistakes are
 * self-correcting: a plan rejection marks the model unsupported, so the next
 * resolution picks the next candidate.
 */
export function resolveCopilotAutoModel(token: string | undefined): string | undefined {
	const plan = copilotPlanFromToken(token);
	const candidates = listCopilotModelHints().filter((h) => {
		if (isCopilotModelKnownUnsupported(h.id)) return false;
		if (h.policyState === "disabled") return false;
		if (h.toolCalls === false) return false;
		// GitHub's auto-routing pseudo-models only resolve inside a `/models/session`
		// (see the Auto design notes) — they 400 on a direct call, so exclude them.
		if (/-free-auto$|^copilot-search-|^exec-agent-|^trajectory-/.test(h.id)) return false;
		if (plan.sku && h.restrictedTo && h.restrictedTo.length > 0) {
			const skuFamily = plan.isFree ? "free" : plan.sku;
			if (!h.restrictedTo.some((r) => r === skuFamily || plan.sku?.includes(r))) return false;
		}
		return true;
	});
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => {
		if (!!a.isChatDefault !== !!b.isChatDefault) return a.isChatDefault ? -1 : 1;
		if (!!a.vision !== !!b.vision) return a.vision ? -1 : 1;
		return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
	});
	return candidates[0]?.id;
}

/** True when the requested id is the synthetic auto entry. */
export function isCopilotAutoModelId(modelId: string): boolean {
	return modelId.trim().toLowerCase() === COPILOT_AUTO_MODEL_ID;
}

/**
 * Build a usable Model for a Copilot id from the ACCOUNT's catalog alone, with
 * no catalogued template to clone.
 *
 * Needed because Pi filters the registry down to the ids the login reported
 * (`availableModelIds`). When a seat's real ids don't intersect Pi's bundled
 * snapshot — routine on enterprise seats, and on any seat once GitHub ships a
 * new family — EVERY Copilot entry is filtered out, the never-miss resolver
 * finds no template to clone, and the turn dies with "isn't available on
 * github-copilot" for a model the picker just listed.
 *
 * Everything here comes from the live catalog or the live token, so it stays
 * correct for models that don't exist yet.
 */
export function buildCopilotModelFromCatalog(modelId: string, token: string | undefined): unknown | undefined {
	const hint = getCopilotModelHint(modelId);
	if (!hint) return undefined;
	return applyGitHubCopilotRouting(
		{
			provider: GITHUB_COPILOT_PROVIDER,
			id: hint.id,
			name: hint.name ?? hint.id,
			api: resolveGitHubCopilotApi(hint.id),
			input: hint.vision ? ["text", "image"] : ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: hint.contextWindow ?? 128_000,
			maxTokens: hint.maxTokens ?? 8192,
		},
		hint.id,
		token,
	);
}

/* ─────────────────────────── credential health ─────────────────────────── */

/**
 * GitHub Copilot has NO durable API key. The only bearer the API accepts is the
 * short-lived token exchanged from a GitHub OAuth grant — `tid=…;exp=…;proxy-ep=…`,
 * good for ~30 minutes. Renewing it requires the GitHub grant, which lives in the
 * `refresh` field of an OAuth credential.
 *
 * So a Copilot bearer stored as `type: "api_key"` is a login with a countdown on
 * it: Pi's refresh path only runs for `type: "oauth"`, so when `exp` passes there
 * is nothing to renew from and every turn 401s. Observed in the wild — the
 * gateway's `add-provider` RPC accepts a key for any provider id, and a Copilot
 * bearer pasted there looks durable but dies within the half hour.
 *
 * This inspection lets the loop say so precisely, instead of surfacing a bare 401
 * half an hour after a login that appeared to work.
 */
export interface CopilotCredentialHealth {
	/** The value is an exchanged Copilot bearer, not a durable key. */
	isBearer: boolean;
	/** Epoch ms from the token's own `exp`, when present. */
	expiresAt?: number;
	/** Already past `exp` (with a small clock-skew allowance). */
	expired: boolean;
	/** Milliseconds left; negative once expired. */
	msRemaining?: number;
	/** Cannot renew itself: a bearer held under a non-OAuth credential type. */
	degraded: boolean;
}

/** Treat a token as spent slightly early — a request in flight at `exp` still fails. */
const COPILOT_EXPIRY_SKEW_MS = 60_000;

export function inspectCopilotCredential(
	token: string | undefined,
	credentialType?: string,
	now: number = Date.now(),
): CopilotCredentialHealth {
	if (!token || !/(?:^|;)\s*tid=/.test(token)) {
		return { isBearer: false, expired: false, degraded: false };
	}
	const exp = /(?:^|;)\s*exp=(\d{1,12})/.exec(token)?.[1];
	const expiresAt = exp ? Number(exp) * 1000 : undefined;
	const msRemaining = expiresAt === undefined ? undefined : expiresAt - now;
	const expired = msRemaining !== undefined && msRemaining <= COPILOT_EXPIRY_SKEW_MS;
	// `oauth` credentials carry the GitHub grant and renew themselves; anything
	// else holding a bearer has no way back once it lapses.
	const degraded = credentialType !== undefined && credentialType !== "oauth";
	return { isBearer: true, expiresAt, expired, msRemaining, degraded };
}

/** Operator-facing explanation for a Copilot login that cannot renew itself. */
export function describeCopilotCredentialProblem(health: CopilotCredentialHealth): string | undefined {
	if (!health.isBearer || !health.degraded) return undefined;
	const when =
		health.expiresAt === undefined
			? "shortly"
			: health.expired
				? "already"
				: `in ~${Math.max(1, Math.round((health.msRemaining ?? 0) / 60_000))} min`;
	return (
		`Your GitHub Copilot credential is a short-lived access token stored as a plain API key, ` +
		`so it cannot refresh itself — it expires ${when}. GitHub Copilot has no durable API key; ` +
		`run \`brigade login copilot\` and complete the device-code sign-in to store a credential ` +
		`that renews automatically.`
	);
}

/* ──────────────────────────── self-healing stream ───────────────────────────── */

/**
 * Which API surface did Copilot say was the WRONG one? Verified against the live
 * API, it names the surface in the rejection rather than the model's real home:
 *
 *   "model gpt-4.1 is not supported via Responses API."                 → /responses was wrong
 *   "model gpt-5.6-luna is not accessible via the /chat/completions endpoint"
 *                                                                       → /chat/completions was wrong
 *
 * Reading the surface out of the message is strictly better than flipping
 * blindly: the retry targets what the server implied instead of guessing, and a
 * future third surface can't send us to the wrong place. Returns `undefined`
 * when the error names no surface (e.g. a bare 421 from the edge), which leaves
 * the caller to flip.
 */
export function copilotRejectedApi(err: unknown): CopilotApi | undefined {
	const text = endpointErrorText(err);
	if (!text) return undefined;
	if (/(?:via|on|by)\s+(?:the\s+)?(?:\/)?responses(?:\s+api|\s+endpoint)?\b/i.test(text)) return "openai-responses";
	if (/(?:via|on|by)\s+(?:the\s+)?(?:\/)?chat[\s/_-]?completions(?:\s+api|\s+endpoint)?\b/i.test(text)) {
		return "openai-completions";
	}
	return undefined;
}

/**
 * Does this failure mean "right credential, wrong endpoint"? Copilot says so two
 * ways: a bare `421 Misdirected Request` from the edge, or a 400 naming the
 * surface the model isn't served on (see `copilotRejectedApi` for the wordings
 * observed live — the earlier pattern set only covered the `/chat/completions
 * endpoint` phrasing and missed the far more common "via Responses API" one).
 */
export function isCopilotEndpointMismatch(err: unknown): boolean {
	const text = endpointErrorText(err);
	if (!text) return false;
	if (isCopilotPlanRejection(err)) return false; // entitlement, not routing
	return /misdirected request/i.test(text) || /\b421\b/.test(text) || copilotRejectedApi(err) !== undefined;
}

/**
 * The OTHER 400 — the seat isn't entitled to this model at all:
 *
 *   "The requested model is not supported."
 *
 * Verified on a `free_limited_copilot` seat, where `gpt-5-mini` and
 * `claude-haiku-4.5` both fail this way even though `/models` advertises them as
 * available on every plan. It is NOT an endpoint problem, so re-issuing on the
 * other surface is guaranteed to fail the same way — the heal must sit this one
 * out and let the error surface with a "pick another model" message.
 *
 * Distinguished from the endpoint case by the absence of a named surface: the
 * entitlement rejection never says "via …".
 */
export function isCopilotPlanRejection(err: unknown): boolean {
	const text = endpointErrorText(err);
	if (!text) return false;
	if (copilotRejectedApi(err) !== undefined) return false;
	return /requested model is not supported/i.test(text) || /model is not supported\b/i.test(text);
}

/**
 * Models this seat has been told it cannot use, learned from live rejections.
 * `/models` cannot be trusted for entitlement (a free seat's listing claims
 * `restricted_to: all` for models the API then refuses), so the only reliable
 * source is what the API actually answered. Process-scoped, same rationale as
 * the learned-endpoint map above.
 */
const unsupportedCopilotModels = new Set<string>();

/** Record that this seat cannot run `modelId` (learned from a live rejection). */
export function rememberCopilotModelUnsupported(modelId: string): void {
	if (modelId) unsupportedCopilotModels.add(modelId.trim().toLowerCase());
}

/** Has this seat already been refused `modelId`? */
export function isCopilotModelKnownUnsupported(modelId: string): boolean {
	return unsupportedCopilotModels.has(modelId.trim().toLowerCase());
}

/** Every model this seat has been refused so far — for an actionable error. */
export function listCopilotUnsupportedModels(): string[] {
	return [...unsupportedCopilotModels].sort();
}

/** Test seam — drop everything learned about entitlement this process. */
export function resetCopilotEntitlementMemory(): void {
	unsupportedCopilotModels.clear();
}

function endpointErrorText(err: unknown): string {
	if (!err) return "";
	if (typeof err === "string") return err;
	if (typeof err !== "object") return String(err);
	const e = err as { message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
	const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
	const message = typeof e.message === "string" ? e.message : "";
	const causeText = e.cause && e.cause !== err ? endpointErrorText(e.cause) : "";
	return `${status ?? ""} ${message} ${causeText}`.trim();
}

type StreamFn = (...args: unknown[]) => unknown;

interface EventStreamLike {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	result(): Promise<unknown>;
}

function isEventStreamLike(value: unknown): value is EventStreamLike {
	if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
	const v = value as { [Symbol.asyncIterator]?: unknown; result?: unknown };
	return typeof v[Symbol.asyncIterator] === "function" && typeof v.result === "function";
}

/**
 * Compose over Pi's streamFn so a Copilot endpoint rejection heals itself.
 *
 * When a Copilot request comes back "wrong endpoint" BEFORE any event has been
 * emitted, re-issue it once against the other API surface and remember the
 * answer for every later turn. That makes the model catalog fully
 * self-describing in practice: a family GitHub ships tomorrow routes itself,
 * with no catalog update and nothing for the operator to do.
 *
 * Strictly bounded — Copilot models only, one re-issue per stream, and only
 * while zero events have been consumed (so no partial output is ever replayed).
 * Anything else rethrows untouched. Preserves Pi's EventStream shape (iterator
 * + `result()`); returning a bare async generator would silently break the turn.
 */
export function wrapStreamFnWithCopilotEndpointHeal(
	streamFn: StreamFn,
	onHeal?: (info: { modelId: string; from: string; to: CopilotApi }) => void,
): StreamFn {
	return async (...args: unknown[]): Promise<unknown> => {
		const model = args[0] as LooseModel | undefined;
		if (!model || typeof model !== "object" || model.provider !== GITHUB_COPILOT_PROVIDER) {
			return streamFn(...args);
		}
		const modelId = typeof model.id === "string" ? model.id : "";
		let healed = false;
		let eventsSeen = 0;

		/** Re-issue the call on the other endpoint, or rethrow the original error. */
		const reissue = async (err: unknown): Promise<EventStreamLike> => {
			// Entitlement rejections are terminal for this model — the other surface
			// refuses it identically. Learn it so the next turn fails instantly with
			// an actionable message instead of probing again.
			if (modelId && isCopilotPlanRejection(err)) {
				rememberCopilotModelUnsupported(modelId);
				throw err;
			}
			if (healed || eventsSeen > 0 || !modelId || !isCopilotEndpointMismatch(err)) throw err;
			healed = true;
			// Prefer the surface the server NAMED as wrong (retry the other one); fall
			// back to flipping whatever we sent when the error names none (bare 421).
			const rejected = copilotRejectedApi(err);
			const to = rejected ? flipCopilotApi(rejected) : flipCopilotApi(typeof model.api === "string" ? model.api : undefined);
			if (to === model.api) throw err; // nothing left to try — don't repeat the same call
			const flipped: LooseModel = { ...model, api: to };
			delete flipped.compat;
			delete flipped.thinkingLevelMap;
			const next = await streamFn(flipped, ...args.slice(1));
			if (!isEventStreamLike(next)) throw err;
			// Only learn once the retry actually produced a stream — a flip that
			// fails too must not poison later turns.
			rememberGitHubCopilotApi(modelId, to);
			onHeal?.({ modelId, from: String(model.api ?? "?"), to });
			return next;
		};

		let active: EventStreamLike;
		try {
			const initial = await streamFn(...args);
			if (!isEventStreamLike(initial)) return initial;
			active = initial;
		} catch (err) {
			active = await reissue(err);
		}

		return {
			[Symbol.asyncIterator]: () => {
				let iterator = active[Symbol.asyncIterator]();
				return {
					async next(): Promise<IteratorResult<unknown>> {
						for (;;) {
							try {
								const step = await iterator.next();
								if (!step.done) eventsSeen++;
								return step;
							} catch (err) {
								active = await reissue(err); // rethrows when not healable
								iterator = active[Symbol.asyncIterator]();
							}
						}
					},
				};
			},
			result: async () => {
				try {
					return await active.result();
				} catch (err) {
					active = await reissue(err);
					return await active.result();
				}
			},
		} satisfies EventStreamLike;
	};
}
