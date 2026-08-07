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

import { getCopilotModelHint } from "../integrations/provider-discovery.js";

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

/* ──────────────────────────── self-healing stream ───────────────────────────── */

/**
 * Does this failure mean "right credential, wrong endpoint"? Copilot says so two
 * ways: a bare `421 Misdirected Request` from the edge, or a 400 naming the
 * endpoint the model isn't served on.
 */
export function isCopilotEndpointMismatch(err: unknown): boolean {
	const text = endpointErrorText(err);
	if (!text) return false;
	return (
		/misdirected request/i.test(text) ||
		/\b421\b/.test(text) ||
		/not accessible via the \/\S+ endpoint/i.test(text) ||
		/not supported (?:on|by) (?:the )?\/\S+ endpoint/i.test(text)
	);
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
			if (healed || eventsSeen > 0 || !modelId || !isCopilotEndpointMismatch(err)) throw err;
			healed = true;
			const to = flipCopilotApi(typeof model.api === "string" ? model.api : undefined);
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
