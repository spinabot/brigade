/**
 * `composio` — owner-only universal app-connector tool (Composio, composio.dev).
 *
 * The operator sets ONE Composio API key; from then on the crew can connect to
 * any of Composio's 1,000+ apps and act on them. A single meta-tool (search →
 * execute, plus connect/status) keeps the prompt small — we do NOT register one
 * tool per app.
 *
 *   action="connect"  app="gmail"            → returns an OAuth link to click
 *   action="status"   [connectionId]         → instant connection state / list connections
 *   action="search"   query="send an email"  → find the right tool slug(s)
 *   action="execute"  tool="GMAIL_SEND_EMAIL" arguments={…} → run it
 *
 * Owner-gated (ownerOnly) — connecting apps and acting on the operator's
 * accounts is operator-tier. The Composio SDK is lazy-imported so it costs
 * nothing when the key isn't configured (the registry only mounts this tool
 * when `isComposioConfigured` is true). Responses are PROJECTED to compact
 * fields + size-capped so a 1,000-app catalog or a big API result never floods
 * the model's context.
 */

import { Type } from "typebox";

import { loadConfig } from "../../core/config.js";
import { jsonResult } from "./common.js";
import type { AgentToolResult, BrigadeTool } from "./types.js";

/** Minimal typed view over the bits of `@composio/core@0.10.0` we call (the
 *  SDK's own types are large + provider-generic; these mirror the verified
 *  return shapes so our call sites are honest + typechecked). */
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
interface ComposioLike {
	toolkits: { authorize(userId: string, toolkitSlug: string, authConfigId?: string): Promise<ComposioConnectionRequest> };
	tools: {
		execute(slug: string, body: { userId: string; arguments?: Record<string, unknown> }): Promise<ComposioToolExecuteResponse>;
		// Raw catalog (NOT provider-wrapped — `tools.get` returns OpenAI-shaped defs).
		getRawComposioTools(query?: Record<string, unknown>): Promise<ComposioRawTool[]>;
	};
	connectedAccounts: {
		get(id: string): Promise<ComposioConnectedAccount>;
		list(query?: Record<string, unknown>): Promise<{ items?: ComposioConnectedAccount[] }>;
	};
}

const ComposioParams = Type.Object({
	action: Type.Union(
		[Type.Literal("connect"), Type.Literal("status"), Type.Literal("search"), Type.Literal("execute")],
		{
			description:
				"connect: start an OAuth link to connect an app. status: check a pending connection (instant) or list connected apps. search: find the right tool slug for a task. execute: run a tool.",
		},
	),
	app: Type.Optional(
		Type.String({ description: 'Toolkit/app slug for connect or to scope search, e.g. "gmail", "slack", "github".', maxLength: 64 }),
	),
	query: Type.Optional(
		Type.String({ description: "search: a natural-language description of what you want to do, e.g. 'send an email'.", maxLength: 400 }),
	),
	tool: Type.Optional(
		Type.String({ description: "execute: the exact tool slug to run, e.g. GMAIL_SEND_EMAIL (find it via action:search).", maxLength: 128 }),
	),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "execute: the tool's arguments object." })),
	connectionId: Type.Optional(
		Type.String({ description: "status: a connection id returned by a prior connect, to check whether it's active yet.", maxLength: 128 }),
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

/** Compact a tool-execution / catalog payload so a large API result can't flood
 *  the model's context. Returns the value unchanged when small. Pure. */
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

/** Project the raw Composio catalog to the few fields the model needs to pick a
 *  tool — drops the full JSON-Schema `inputParameters` (kilobytes per tool). Pure. */
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

/** The Composio API key — config `tools.composio.apiKey` wins, else env. */
export function resolveComposioApiKey(): string | undefined {
	try {
		const cfg = loadConfig() as { tools?: { composio?: { apiKey?: unknown } } };
		const fromCfg = cfg.tools?.composio?.apiKey;
		if (typeof fromCfg === "string" && fromCfg.trim()) return fromCfg.trim();
	} catch {
		/* fall through to env */
	}
	const env = process.env.COMPOSIO_API_KEY?.trim();
	return env || undefined;
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

/** Whether the Composio integration is configured (gates tool registration). */
export function isComposioConfigured(): boolean {
	return Boolean(resolveComposioApiKey());
}

async function makeClient(apiKey: string): Promise<ComposioLike> {
	// Lazy import — the SDK (and its openai/pusher deps) only load when used.
	const mod = (await import("@composio/core")) as { Composio: new (cfg: { apiKey: string }) => unknown };
	return new mod.Composio({ apiKey }) as unknown as ComposioLike;
}

export function makeComposioTool(): BrigadeTool<typeof ComposioParams, ComposioResult> {
	return {
		name: "composio",
		label: "Composio",
		displaySummary: "using a connected app via Composio",
		ownerOnly: true,
		description: [
			"Connect to and act on 1,000+ external apps (Gmail, Slack, GitHub, Notion, …) via Composio, using the operator's configured Composio key.",
			'action="connect" with app="<slug>" → returns an OAuth link; give it to the operator to click, then check action="status" with the returned connectionId (instant — does NOT block).',
			'action="search" with query="<what you want to do>" (optionally app="<slug>") → returns candidate tool slugs. action="execute" with tool="<SLUG>" and arguments={…} → runs it.',
			"Prefer search→execute over guessing slugs. Owner-only; call only on the operator's request.",
		].join(" "),
		parameters: ComposioParams,
		execute: async (_toolCallId, args): Promise<AgentToolResult<ComposioResult>> => {
			const apiKey = resolveComposioApiKey();
			if (!apiKey) {
				return jsonResult({
					action: args.action,
					ok: false,
					message: "Composio isn't configured. Set tools.composio.apiKey (or COMPOSIO_API_KEY) with your Composio API key first.",
				} satisfies ComposioResult) as AgentToolResult<ComposioResult>;
			}
			const userId = resolveComposioUserId();
			const fail = (message: string): AgentToolResult<ComposioResult> =>
				jsonResult({ action: args.action, ok: false, message } satisfies ComposioResult) as AgentToolResult<ComposioResult>;
			try {
				const composio = await makeClient(apiKey);
				switch (args.action) {
					case "connect": {
						const app = (args.app ?? "").trim();
						if (!app) return fail("connect needs an app slug, e.g. app:'gmail'.");
						// authorize() auto-creates a Composio-MANAGED auth config when none
						// exists — so a brand-new key can connect any app with zero setup.
						const req = await composio.toolkits.authorize(userId, app);
						return jsonResult({
							action: "connect",
							ok: true,
							redirectUrl: req.redirectUrl ?? undefined,
							connectionId: req.id,
							message: req.redirectUrl
								? `Send the operator this link to connect ${app}: ${req.redirectUrl} — after they click it, run composio({action:"status", connectionId:"${req.id}"}) to confirm it went active.`
								: `Started connecting ${app} (connection ${req.id}); no redirect needed — check status.`,
						} satisfies ComposioResult) as AgentToolResult<ComposioResult>;
					}
					case "status": {
						const cid = (args.connectionId ?? "").trim();
						if (cid) {
							// Instant state read — never block the turn waiting on a human click.
							const acc = await composio.connectedAccounts.get(cid);
							const active = acc.status === "ACTIVE";
							return jsonResult({
								action: "status",
								ok: true,
								connectionId: cid,
								data: { status: acc.status, toolkit: acc.toolkit?.slug, active },
								message: active
									? `Connection ${cid} is ACTIVE — the app is connected.`
									: `Connection ${cid} is "${acc.status ?? "pending"}" — the operator hasn't finished authorizing yet; have them click the link, then check again.`,
							} satisfies ComposioResult) as AgentToolResult<ComposioResult>;
						}
						const res = await composio.connectedAccounts.list({ userIds: [userId] });
						const accounts = projectAccounts(res);
						return jsonResult({
							action: "status",
							ok: true,
							data: { accounts },
							message: `${accounts.length} connected account(s).`,
						} satisfies ComposioResult) as AgentToolResult<ComposioResult>;
					}
					case "search": {
						const query = (args.query ?? "").trim();
						if (!query) return fail("search needs a query, e.g. query:'send an email'.");
						const app = args.app?.trim();
						const filters: Record<string, unknown> = app
							? { toolkits: [app], search: query, limit: 10 }
							: { search: query, limit: 10 };
						const tools = projectTools(await composio.tools.getRawComposioTools(filters));
						return jsonResult({
							action: "search",
							ok: true,
							data: { tools },
							message:
								tools.length > 0
									? `Found ${tools.length} tool(s) for "${query}". Pick a slug and call action:"execute".`
									: `No tools found for "${query}"${app ? ` in ${app}` : ""}. Try a different phrasing or app.`,
						} satisfies ComposioResult) as AgentToolResult<ComposioResult>;
					}
					case "execute": {
						const slug = (args.tool ?? "").trim();
						if (!slug) return fail("execute needs a tool slug (find it via action:search).");
						const res = await composio.tools.execute(slug, { userId, arguments: args.arguments ?? {} });
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
				return fail(`Composio ${args.action} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}
