/**
 * `composio` — owner-only universal app-connector tool (Composio, composio.dev).
 *
 * Mirrors the OAuth tool's model: the operator gives ONE Composio API key
 * (sealed into the credential store like `oauth_authorize` seals tokens — never
 * echoed, AES-256-GCM at rest in convex mode), and from then on the crew can
 * connect to any of Composio's 1,000+ apps and act on them. A single meta-tool
 * (apps → connect → search → execute, plus status) keeps the prompt small — we
 * do NOT register one tool per app, and we hardcode NO app list (the catalog is
 * fetched live, so apps Composio adds later are connectable with zero changes).
 *
 *   action="set-key"  key="csk_…"            → verify + seal the operator's Composio key
 *   action="apps"     [query="calendar"]     → discover connectable apps (live catalog)
 *   action="connect"  app="gmail"            → returns an OAuth link to click
 *   action="status"   [connectionId]         → instant connection state / list connections
 *   action="search"   query="send an email"  → find the right tool slug(s)
 *   action="execute"  tool="GMAIL_SEND_EMAIL" arguments={…} → run it
 *
 * The key resolves from ANYWHERE: the sealed credential profile first, then
 * config `tools.composio.apiKey`, then the `COMPOSIO_API_KEY` env. The tool is
 * ALWAYS mounted (like `oauth_authorize`) so the crew is always aware it can
 * connect apps; when no key is set yet, every action points the operator at
 * `set-key`. Owner-gated. Responses are PROJECTED to compact fields + size-
 * capped so a 1,000-app catalog or a big API result never floods the context.
 */

import { Type } from "typebox";

import { readProfiles, upsertApiKeyProfile } from "../../auth/profiles.js";
import { DEFAULT_AGENT_ID } from "../../config/paths.js";
import { loadConfig } from "../../core/config.js";
import { requestHeartbeatNow } from "../heartbeat-wake.js";
import { enqueueSystemEvent } from "../session-inbox.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

const COMPOSIO_PROVIDER = "composio";

/** Minimal typed view over the bits of `@composio/core@0.10.0` we call. */
interface ComposioConnectionRequest {
	id: string;
	redirectUrl?: string | null;
	status?: string;
}
interface ComposioConnectedAccount {
	id: string;
	status?: string;
	toolkit?: { slug?: string } | null;
}
interface ComposioRawTool {
	slug: string;
	name?: string;
	description?: string;
	toolkit?: { slug?: string; name?: string } | null;
}
interface ComposioToolExecuteResponse {
	data: Record<string, unknown>;
	error: string | null;
	successful: boolean;
	logId?: string;
}
interface ComposioToolkitItem {
	slug: string;
	name?: string;
	meta?: { description?: string; toolsCount?: number } | null;
}
interface ComposioAuthConfigItem {
	id: string;
	status?: string;
}
interface ComposioLike {
	toolkits: {
		/** List the live toolkit catalog (NOT hardcoded — new apps appear automatically).
		 *  Paginated: the response carries `nextCursor` when more pages remain. */
		get(
			query?: Record<string, unknown>,
		): Promise<{ items?: ComposioToolkitItem[]; nextCursor?: string | null } | ComposioToolkitItem[]>;
	};
	authConfigs: {
		list(query?: Record<string, unknown>): Promise<{ items?: ComposioAuthConfigItem[] }>;
		create(toolkit: string, options: { type: string; name?: string }): Promise<{ id: string }>;
	};
	tools: {
		execute(
			slug: string,
			body: { userId: string; arguments?: Record<string, unknown>; connectedAccountId?: string; dangerouslySkipVersionCheck?: boolean },
		): Promise<ComposioToolExecuteResponse>;
		getRawComposioTools(query?: Record<string, unknown>): Promise<ComposioRawTool[]>;
	};
	connectedAccounts: {
		get(id: string): Promise<ComposioConnectedAccount>;
		list(query?: Record<string, unknown>): Promise<{ items?: ComposioConnectedAccount[] }>;
		/** Composio-MANAGED OAuth connect — the live path (authorize()/initiate() were
		 *  retired for managed auth); returns a redirect URL for the operator to click. */
		link(userId: string, authConfigId: string, options?: Record<string, unknown>): Promise<ComposioConnectionRequest>;
	};
}

const ComposioParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("set-key"),
			Type.Literal("apps"),
			Type.Literal("connect"),
			Type.Literal("status"),
			Type.Literal("search"),
			Type.Literal("execute"),
		],
		{
			description:
				"set-key: seal the operator's Composio API key. apps: discover which apps are connectable (live catalog; optionally filter with query). connect: start an OAuth link to connect an app. status: check a pending connection (instant) or list connected apps. search: find the right tool slug for a task. execute: run a tool.",
		},
	),
	key: Type.Optional(
		Type.String({ description: 'set-key: the operator\'s Composio PLATFORM API key ("ak_…", from dashboard.composio.dev → PLATFORM → Settings → API Keys; not the "FOR YOU"/"ck_" key). Sealed at rest; never echoed.', maxLength: 256 }),
	),
	app: Type.Optional(
		Type.String({ description: 'Toolkit/app slug for connect or to scope search, e.g. "gmail", "slack", "github".', maxLength: 64 }),
	),
	query: Type.Optional(
		Type.String({
			description:
				"search: a natural-language description of what you want to do, e.g. 'send an email'. apps: an optional substring to filter the app catalog by, e.g. 'calendar'.",
			maxLength: 400,
		}),
	),
	tool: Type.Optional(
		Type.String({ description: "execute: the exact tool slug to run, e.g. GMAIL_SEND_EMAIL (find it via action:search).", maxLength: 128 }),
	),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "execute: the tool's arguments object." })),
	connectionId: Type.Optional(
		Type.String({
			description:
				"A connection id from a prior connect. For status: checks whether it's active yet. For execute: targets that specific connected account (only needed if the same app is connected more than once).",
			maxLength: 128,
		}),
	),
});

interface ComposioResult {
	action: string;
	ok: boolean;
	message: string;
	redirectUrl?: string;
	connectionId?: string;
	data?: unknown;
}

const MAX_DATA_CHARS = 12_000;

/** Compact a payload so a large API result can't flood the model's context. Pure. */
export function capData(value: unknown, maxChars = MAX_DATA_CHARS): unknown {
	let s: string;
	try {
		s = JSON.stringify(value);
	} catch {
		return value;
	}
	if (!s || s.length <= maxChars) return value;
	return {
		truncated: true,
		bytes: s.length,
		note: `Result truncated at ${maxChars} chars — narrow the request (filters/limit) and try again.`,
		preview: s.slice(0, maxChars),
	};
}

/** Project the raw Composio catalog to the few fields the model needs. Pure. */
export function projectTools(raw: unknown): Array<{ slug: string; name?: string; description?: string; toolkit?: string }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((t): t is ComposioRawTool => !!t && typeof (t as ComposioRawTool).slug === "string")
		.map((t) => ({ slug: t.slug, name: t.name, description: t.description, toolkit: t.toolkit?.slug }));
}

/** Project a connected-accounts list to compact rows. Pure. */
export function projectAccounts(res: unknown): Array<{ id: string; toolkit?: string; status?: string }> {
	const items = (res as { items?: ComposioConnectedAccount[] } | null)?.items;
	if (!Array.isArray(items)) return [];
	return items
		.filter((a): a is ComposioConnectedAccount => !!a && typeof a.id === "string")
		.map((a) => ({ id: a.id, toolkit: a.toolkit?.slug, status: a.status }));
}

/** Project the live toolkit catalog to compact rows the model can browse. Pure.
 *  Tolerates both the `{items:[…]}` envelope and a bare array. */
export function projectToolkits(raw: unknown): Array<{ slug: string; name?: string; description?: string; toolsCount?: number }> {
	const items = Array.isArray(raw) ? raw : (raw as { items?: ComposioToolkitItem[] } | null)?.items;
	if (!Array.isArray(items)) return [];
	return items
		.filter((t): t is ComposioToolkitItem => !!t && typeof (t as ComposioToolkitItem).slug === "string")
		.map((t) => ({ slug: t.slug, name: t.name, description: t.meta?.description, toolsCount: t.meta?.toolsCount }));
}

const TOOLKIT_PAGE_LIMIT = 500;
const TOOLKIT_MAX_PAGES = 12; // safety bound (≈6,000 toolkits); flagged if hit, never silent.

/** Page through the WHOLE toolkit catalog by following `nextCursor` — so the count
 *  the crew reports is REAL, not "however many fit in one page". Returns the projected
 *  toolkits + `truncated` (true only if we hit the page-safety bound with more pages
 *  left, so the caller can say so honestly rather than pretend it's the full list). */
async function fetchAllToolkits(
	composio: ComposioLike,
): Promise<{ toolkits: ReturnType<typeof projectToolkits>; truncated: boolean }> {
	const out: ReturnType<typeof projectToolkits> = [];
	let cursor: string | undefined;
	for (let page = 0; page < TOOLKIT_MAX_PAGES; page++) {
		const res = await composio.toolkits.get({
			limit: TOOLKIT_PAGE_LIMIT,
			sortBy: "usage",
			...(cursor ? { cursor } : {}),
		});
		out.push(...projectToolkits(res));
		const next = Array.isArray(res) ? undefined : (res?.nextCursor ?? undefined);
		if (!next) return { toolkits: out, truncated: false };
		cursor = next;
	}
	return { toolkits: out, truncated: true }; // hit the page bound with more remaining
}

/** Whether an error looks like Composio rejecting the API key (vs a network/other
 *  failure) — used to give "re-run set-key" guidance instead of a raw error, and
 *  to refuse sealing a key that's already been rejected.
 *
 *  The SDK BURIES the real 401 under a generic wrapper (e.g.
 *  `ComposioToolkitFetchError: "Failed to fetch toolkits"` with `status:undefined`,
 *  the actual `{status:401, "Invalid API key"}` only on `err.cause`), so we walk
 *  the whole cause chain checking both the status fields and the message. */
export function isAuthError(err: unknown): boolean {
	const authMsg = /unauthor|forbidden|invalid api key|invalid_api_key|api key is invalid|http_unauthorized|\b401\b|\b403\b/;
	let cur: unknown = err;
	for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
		const e = cur as { status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
		const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
		if (status === 401 || status === 403) return true;
		if (typeof e.message === "string" && authMsg.test(e.message.toLowerCase())) return true;
		cur = e.cause;
	}
	return false;
}

/** First numeric HTTP status anywhere on the error's `cause` chain (the SDK buries
 *  it — top-level `status` is often undefined). Used to spot a 400 = "no managed
 *  auth for this app" on auth-config creation. */
export function composioErrorStatus(err: unknown): number | undefined {
	let cur: unknown = err;
	for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
		const e = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
		if (typeof e.status === "number") return e.status;
		if (typeof e.statusCode === "number") return e.statusCode;
		cur = e.cause;
	}
	return undefined;
}

/** Map a Composio connection status to a terminal verdict the watcher acts on.
 *  ACTIVE → done; FAILED/EXPIRED/DELETED/INACTIVE/ERROR → dead; anything else
 *  (INITIALIZING / INITIATED / pending) → keep waiting. Pure. */
export function classifyConnectionStatus(status: string | undefined): "active" | "failed" | "pending" {
	if (typeof status !== "string") return "pending";
	const s = status.toUpperCase();
	if (s === "ACTIVE") return "active";
	if (/^(FAILED|EXPIRED|DELETED|INACTIVE|ERROR|REVOKED)$/.test(s)) return "failed";
	return "pending";
}

const CONNECT_POLL_INTERVAL_MS = 5_000;
const CONNECT_WATCH_MAX_MS = 5 * 60_000;
/** connectionIds currently being watched — guards against double-watching. */
const activeWatchers = new Set<string>();

/** Test seam — stop watching everything (no-op timers are unref'd anyway). */
export function __clearComposioWatchersForTests(): void {
	activeWatchers.clear();
}

/**
 * After connect hands over the link, poll the connection in the BACKGROUND until
 * it goes ACTIVE (or fails/times out) and then wake the requesting session so the
 * crew confirms hands-free — no operator "I clicked it" needed. This mirrors the
 * oauth_authorize auto-wake, but Composio OWNS the redirect (no local callback to
 * catch), so we poll `connectedAccounts.get` instead. Best-effort: timers are
 * unref'd (never hold the process open) and the manual `status` action still works
 * if the watcher is lost (e.g. a gateway restart mid-wait).
 */
function watchComposioConnection(opts: {
	composio: ComposioLike;
	connectionId: string;
	app: string;
	sessionKey: string;
	agentId: string;
}): void {
	const { composio, connectionId, app, sessionKey, agentId } = opts;
	if (activeWatchers.has(connectionId)) return;
	activeWatchers.add(connectionId);
	const startedAt = Date.now();

	const wake = (event: string): void => {
		activeWatchers.delete(connectionId);
		try {
			enqueueSystemEvent(event, { sessionKey, contextKey: `composio:connect:${connectionId}`, trusted: true });
			requestHeartbeatNow({ reason: "composio-connect", ...(agentId ? { agentId } : {}), sessionKey });
		} catch {
			/* best-effort — the manual `status` action still completes it */
		}
	};

	const schedule = (): void => {
		const timer = setTimeout(() => void tick(), CONNECT_POLL_INTERVAL_MS);
		if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref?: () => void }).unref?.();
	};

	const tick = async (): Promise<void> => {
		if (!activeWatchers.has(connectionId)) return; // cleared (e.g. tests)
		if (Date.now() - startedAt > CONNECT_WATCH_MAX_MS) {
			activeWatchers.delete(connectionId); // give up silently
			return;
		}
		let status: string | undefined;
		try {
			status = (await composio.connectedAccounts.get(connectionId))?.status;
		} catch {
			/* transient — keep polling */
		}
		const verdict = classifyConnectionStatus(status);
		if (verdict === "active") {
			wake(
				`[composio] The ${app} connection (${connectionId}) just went ACTIVE — the operator finished authorizing. ` +
					`Tell the user ${app} is connected and ready to use. The click already happened — do NOT ask them to confirm.`,
			);
			return;
		}
		if (verdict === "failed") {
			wake(
				`[composio] The ${app} connection (${connectionId}) ended as "${status}" — authorization did not complete. ` +
					`Let the user know and offer to send a fresh connect link.`,
			);
			return;
		}
		schedule();
	};

	schedule(); // first poll after one interval — give the operator time to click
}

/** Read the sealed Composio key from the agent's credential store (decrypted on
 *  read by the auth store — AES-256-GCM in convex mode). */
function readSealedKey(agentId: string): string | undefined {
	try {
		const file = readProfiles(agentId) as { profiles?: Record<string, { provider?: string; key?: string }> };
		for (const p of Object.values(file.profiles ?? {})) {
			if (p?.provider === COMPOSIO_PROVIDER && typeof p.key === "string" && p.key.trim()) return p.key.trim();
		}
	} catch {
		/* fall through */
	}
	return undefined;
}

/** The Composio API key, from ANYWHERE: sealed credential profile → config → env. */
export function resolveComposioApiKey(agentId?: string): string | undefined {
	if (agentId) {
		const sealed = readSealedKey(agentId);
		if (sealed) return sealed;
	}
	try {
		const cfg = loadConfig() as { tools?: { composio?: { apiKey?: unknown } } };
		const fromCfg = cfg.tools?.composio?.apiKey;
		if (typeof fromCfg === "string" && fromCfg.trim()) return fromCfg.trim();
	} catch {
		/* fall through to env */
	}
	return process.env.COMPOSIO_API_KEY?.trim() || undefined;
}

/** Stable per-operator Composio user id (single-operator default; multi-tenant later). */
function resolveComposioUserId(): string {
	try {
		const cfg = loadConfig() as { tools?: { composio?: { userId?: unknown } } };
		const u = cfg.tools?.composio?.userId;
		if (typeof u === "string" && u.trim()) return u.trim();
	} catch {
		/* default */
	}
	return "brigade-owner";
}

/** Whether a Composio key is configured anywhere (sealed/config/env). */
export function isComposioConfigured(agentId?: string): boolean {
	return Boolean(resolveComposioApiKey(agentId));
}

async function makeClient(apiKey: string): Promise<ComposioLike> {
	// Lazy import — the SDK (and its openai/pusher deps) only load when used.
	const mod = (await import("@composio/core")) as { Composio: new (cfg: { apiKey: string }) => unknown };
	return new mod.Composio({ apiKey }) as unknown as ComposioLike;
}

export function makeComposioTool(opts?: {
	agentId?: string;
	/** Per-turn session key — lets connect auto-confirm hands-free (wakes this
	 *  session when the connection goes ACTIVE), mirroring oauth_authorize. */
	sessionKey?: string;
	/** Inject the SDK client factory (tests pass a fake; defaults to the lazy real SDK). */
	clientFactory?: (apiKey: string) => Promise<ComposioLike>;
}): BrigadeTool<typeof ComposioParams, ComposioResult> {
	const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;
	const sessionKey = opts?.sessionKey?.trim() || undefined;
	const clientFactory = opts?.clientFactory ?? makeClient;
	return {
		name: "composio",
		label: "Composio",
		displaySummary: "using a connected app via Composio",
		ownerOnly: true,
		description: [
			"Connect to and act on 1,000+ external apps (Gmail, Slack, GitHub, Notion, … and any app Composio adds later) via Composio.",
			'FIRST the operator must provide a Composio API key: action="set-key" with key="<their key>" — it is sealed (encrypted at rest), never echoed, and verified with Composio when set. IMPORTANT when telling the operator where to get the key: dashboard.composio.dev → switch the top-left toggle to PLATFORM (NOT "FOR YOU") → Settings → API Keys; a PLATFORM key starts with "ak_". A "FOR YOU" key (starts with "ck_") is for desktop AI clients and will be rejected. If a connect/search/execute reports "not configured" or "key rejected", ask the operator for a current PLATFORM key and set-key it.',
			'To discover what is connectable: action="apps" (optionally query="<substring>") → live catalog of app slugs (nothing hardcoded). Then action="connect" with app="<slug>" → returns an OAuth link; give it to the operator to click, then action="status" with the returned connectionId (instant — does NOT block).',
			'action="search" with query="<what you want to do>" (optionally app="<slug>") → returns candidate tool slugs. action="execute" with tool="<SLUG>" and arguments={…} → runs it.',
			"Prefer apps→connect and search→execute over guessing slugs. Owner-only; call only on the operator's request.",
		].join(" "),
		parameters: ComposioParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<ComposioResult>> => {
			const ok = (message: string, extra?: Partial<ComposioResult>): AgentToolResult<ComposioResult> =>
				jsonResult({ action: args.action, ok: true, message, ...extra } satisfies ComposioResult) as AgentToolResult<ComposioResult>;
			const fail = (message: string): AgentToolResult<ComposioResult> =>
				jsonResult({ action: args.action, ok: false, message } satisfies ComposioResult) as AgentToolResult<ComposioResult>;

			// set-key runs even when nothing is configured yet — it's how you configure it.
			if (args.action === "set-key") {
				const key = (args.key ?? "").trim();
				if (!key) return fail("set-key needs the operator's Composio API key (from dashboard.composio.dev/settings).");
				// Live-verify the key BEFORE sealing so a typo'd/rejected key is caught now,
				// not on first use. A clear auth rejection → refuse to seal it. A network/SDK
				// hiccup → seal anyway (don't lose a good key) and flag it as unverified.
				let verifyNote = " The key was verified with Composio.";
				try {
					const probe = await clientFactory(key);
					await probe.toolkits.get({ limit: 1 });
				} catch (err) {
					if (isAuthError(err)) {
						return fail(
							'That key was rejected by Composio — it looks invalid. Make sure it is a PLATFORM key ("ak_…", from dashboard.composio.dev → PLATFORM → Settings → API Keys), NOT a "FOR YOU" key ("ck_…"). Re-run set-key with a valid key. Nothing was saved.',
						);
					}
					verifyNote = " (Saved, but couldn't reach Composio to verify it right now — try action:\"connect\" to confirm it works.)";
				}
				try {
					upsertApiKeyProfile(agentId, { provider: COMPOSIO_PROVIDER, key });
				} catch (err) {
					return fail(`Couldn't save the Composio key: ${err instanceof Error ? err.message : String(err)}`);
				}
				return ok(
					`Composio API key saved and sealed (encrypted at rest in convex mode; 0600 on disk; never echoed).${verifyNote} Discover connectable apps with action:"apps", then action:"connect".`,
				);
			}

			const apiKey = resolveComposioApiKey(agentId);
			if (!apiKey) {
				return fail(
					'No Composio API key is set. Ask the operator for their Composio PLATFORM API key (dashboard.composio.dev → PLATFORM → Settings → API Keys; starts with "ak_", NOT the "FOR YOU"/"ck_" key), then run composio({action:"set-key", key:"<their key>"}). After that you can connect apps.',
				);
			}
			const userId = resolveComposioUserId();
			try {
				const composio = await clientFactory(apiKey);
				switch (args.action) {
					case "apps": {
						// Page through the WHOLE live catalog (don't assume one page is all of
						// it) so the count is REAL. Nothing hardcoded → apps Composio adds later
						// appear automatically. Filter client-side (toolkits.get has no free-text
						// search param) and cap only the SHOWN rows, while reporting the true total.
						const { toolkits: allApps, truncated } = await fetchAllToolkits(composio);
						let apps = allApps;
						const q = (args.query ?? "").trim().toLowerCase();
						if (q) {
							apps = apps.filter(
								(a) =>
									a.slug.toLowerCase().includes(q) ||
									(a.name ?? "").toLowerCase().includes(q) ||
									(a.description ?? "").toLowerCase().includes(q),
							);
						}
						const SHOWN = 30;
						const capped = apps.slice(0, SHOWN);
						const total = `${apps.length}${truncated ? "+" : ""}`;
						return ok(
							capped.length > 0
								? `${total} connectable app(s)${q ? ` matching "${q}"` : " in Composio's catalog"}${
										apps.length > capped.length ? ` — showing the first ${capped.length}` : ""
									}. Pick a slug and call action:"connect", or action:"search" to find a specific tool in any app.`
								: `No connectable apps${q ? ` matching "${q}"` : ""} found — try a broader term, or call action:"connect" with the app's slug directly (any Composio app connects, even if not listed here).`,
							{ data: { apps: capped, total: apps.length, shown: capped.length, ...(truncated ? { truncated: true } : {}) } },
						);
					}
					case "connect": {
						const app = (args.app ?? "").trim().toLowerCase();
						if (!app) return fail("connect needs an app slug, e.g. app:'gmail'.");
						// Composio retired authorize()/initiate() for managed OAuth — the live
						// path is: find (or create) a Composio-MANAGED auth config for the app,
						// then connectedAccounts.link() to get the operator's redirect URL.
						// Apps with NO Composio-hosted OAuth (e.g. Twitter/X) 400 on create →
						// surface an actionable next step instead of a raw error.
						let authConfigId: string | undefined = (await composio.authConfigs.list({ toolkit: app }))?.items?.find(
							(c) => typeof c?.id === "string",
						)?.id;
						if (!authConfigId) {
							try {
								const created = await composio.authConfigs.create(app, {
									type: "use_composio_managed_auth",
									name: `${app} (Brigade)`,
								});
								authConfigId = created.id;
							} catch (err) {
								if (composioErrorStatus(err) === 400) {
									return fail(
										`Composio doesn't host a managed sign-in for "${app}", so it can't be connected automatically. The operator needs to add their own OAuth credentials for ${app} in the Composio dashboard (Toolkits → search ${app} → Add to project), then run connect again.`,
									);
								}
								throw err;
							}
						}
						const req = await composio.connectedAccounts.link(userId, authConfigId);
						// Auto-confirm hands-free: watch the connection in the background and
						// wake this session when it goes ACTIVE, so the operator never has to
						// say "I clicked it" (mirrors oauth_authorize). Needs a sessionKey.
						const watching = Boolean(sessionKey) && Boolean(req.id);
						if (sessionKey && req.id) {
							watchComposioConnection({ composio, connectionId: req.id, app, sessionKey, agentId });
						}
						return ok(
							req.redirectUrl
								? `Send the operator this link to connect ${app}: ${req.redirectUrl}${
										watching
											? " — once they click it and authorize, I'll confirm automatically (no need to tell me)."
											: ` — after they click it, run composio({action:"status", connectionId:"${req.id}"}) to confirm it went active.`
									}`
								: `Started connecting ${app} (connection ${req.id}); no redirect needed — check status.`,
							{ redirectUrl: req.redirectUrl ?? undefined, connectionId: req.id },
						);
					}
					case "status": {
						const cid = (args.connectionId ?? "").trim();
						if (cid) {
							const acc = await composio.connectedAccounts.get(cid);
							const active = acc.status === "ACTIVE";
							return ok(
								active
									? `Connection ${cid} is ACTIVE — the app is connected.`
									: `Connection ${cid} is "${acc.status ?? "pending"}" — the operator hasn't finished authorizing yet; have them click the link, then check again.`,
								{ connectionId: cid, data: { status: acc.status, toolkit: acc.toolkit?.slug, active } },
							);
						}
						const accounts = projectAccounts(await composio.connectedAccounts.list({ userIds: [userId] }));
						return ok(`${accounts.length} connected account(s).`, { data: { accounts } });
					}
					case "search": {
						const query = (args.query ?? "").trim();
						if (!query) return fail("search needs a query, e.g. query:'send an email'.");
						const app = args.app?.trim();
						const filters: Record<string, unknown> = app
							? { toolkits: [app], search: query, limit: 10 }
							: { search: query, limit: 10 };
						const tools = projectTools(await composio.tools.getRawComposioTools(filters));
						return ok(
							tools.length > 0
								? `Found ${tools.length} tool(s) for "${query}". Pick a slug and call action:"execute".`
								: `No tools found for "${query}"${app ? ` in ${app}` : ""}. Try a different phrasing or app.`,
							{ data: { tools } },
						);
					}
					case "execute": {
						const slug = (args.tool ?? "").trim();
						if (!slug) return fail("execute needs a tool slug (find it via action:search).");
						const cid = (args.connectionId ?? "").trim();
						const res = await composio.tools.execute(slug, {
							userId,
							arguments: args.arguments ?? {},
							// Composio's execute requires EITHER a pinned toolkit version or this
							// flag; we skip pinning so a toolkit version bump never silently
							// breaks execution. (Matches the reference connector's behavior.)
							dangerouslySkipVersionCheck: true,
							// Target a specific connected account only when one is given (needed
							// when the same app is connected more than once).
							...(cid ? { connectedAccountId: cid } : {}),
						});
						return jsonResult({
							action: "execute",
							ok: res.successful,
							data: capData(res.data),
							message: res.successful ? `Executed ${slug}.` : `Tool ${slug} failed: ${res.error ?? "unknown error"}.`,
						} satisfies ComposioResult) as AgentToolResult<ComposioResult>;
					}
					default:
						return fail(`Unknown action "${String(args.action)}".`);
				}
			} catch (err) {
				if (isAuthError(err)) {
					return fail(
						`Composio rejected the request — the API key looks invalid or expired. Ask the operator for a current Composio API key and re-run composio({action:"set-key", key:"…"}).`,
					);
				}
				return fail(`Composio ${args.action} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}
