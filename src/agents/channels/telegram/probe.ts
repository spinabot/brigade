/**
 * Telegram status / doctor probe — a lightweight `getMe` reachability check.
 *
 * Telegram is token-based and stateless on disk: unlike WhatsApp (which leaves
 * Baileys creds the status command can stat), there's no local artifact to
 * inspect, so "is this channel actually working?" can only be answered by
 * asking Telegram. This probe does the cheapest possible call — a single
 * `getMe` over plain HTTPS (no grammY, no polling, no runner) — and reports the
 * bot's identity + group/inline capability flags so `brigade channels status`
 * and `brigade doctor` can show real Telegram health.
 *
 * It deliberately does NOT import grammY: a status check must stay fast +
 * dependency-light, and `getMe` is a trivial GET. The bot token is never
 * logged; the URL it's embedded in is built locally and discarded.
 *
 * Returns a structured result the caller renders; never throws — a network
 * failure / invalid token surfaces as `{ ok: false, error }` so the status
 * command degrades gracefully instead of crashing.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/** The bot identity fields surfaced by the probe (from `getMe`). */
export interface TelegramProbeIdentity {
	id?: number;
	username?: string;
	firstName?: string;
	canJoinGroups?: boolean;
	canReadAllGroupMessages?: boolean;
	supportsInlineQueries?: boolean;
}

/** Structured probe result. `ok` true ⇒ token valid + bot reachable. */
export interface TelegramProbeResult {
	ok: boolean;
	/** HTTP status of the `getMe` call, when one came back. */
	status?: number;
	/** Operator-facing error line when `ok` is false. */
	error?: string;
	/** Round-trip time in ms. */
	elapsedMs: number;
	/** Bot identity (populated on success). */
	bot?: TelegramProbeIdentity;
}

export interface TelegramProbeArgs {
	/** The resolved Bot API token. NEVER logged. */
	token: string;
	/** Injectable fetch (defaults to global fetch) — lets tests stub the call. */
	fetchImpl?: typeof fetch;
	/** Probe timeout in ms (default 8s). */
	timeoutMs?: number;
}

/**
 * Run a `getMe` probe. Resolves to a structured result describing whether the
 * token is valid + the bot is reachable, plus its identity. Never rejects.
 */
export async function probeTelegram(args: TelegramProbeArgs): Promise<TelegramProbeResult> {
	const started = Date.now();
	const token = (args.token ?? "").trim();
	if (!token) {
		return { ok: false, error: "no Telegram bot token configured", elapsedMs: 0 };
	}
	const doFetch = args.fetchImpl ?? fetch;
	const timeoutMs = args.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
	try {
		const res = await doFetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, { signal: controller.signal });
		const elapsedMs = Date.now() - started;
		type GetMeBody = { ok?: boolean; result?: Record<string, unknown>; description?: string };
		let body: GetMeBody | null = null;
		try {
			body = (await res.json()) as GetMeBody;
		} catch {
			body = null;
		}
		if (!res.ok || !body?.ok || !body.result) {
			return {
				ok: false,
				status: res.status,
				error:
					body?.description ??
					(res.status === 401
						? "Telegram rejected the bot token (401) — paste a fresh @BotFather token."
						: `Telegram getMe failed (HTTP ${res.status}).`),
				elapsedMs,
			};
		}
		const r = body.result;
		return {
			ok: true,
			status: res.status,
			elapsedMs,
			bot: {
				...(typeof r.id === "number" ? { id: r.id } : {}),
				...(typeof r.username === "string" ? { username: r.username } : {}),
				...(typeof r.first_name === "string" ? { firstName: r.first_name } : {}),
				...(typeof r.can_join_groups === "boolean" ? { canJoinGroups: r.can_join_groups } : {}),
				...(typeof r.can_read_all_group_messages === "boolean"
					? { canReadAllGroupMessages: r.can_read_all_group_messages }
					: {}),
				...(typeof r.supports_inline_queries === "boolean"
					? { supportsInlineQueries: r.supports_inline_queries }
					: {}),
			},
		};
	} catch (err) {
		const elapsedMs = Date.now() - started;
		const aborted = controller.signal.aborted;
		return {
			ok: false,
			error: aborted
				? `Telegram getMe timed out after ${timeoutMs}ms`
				: err instanceof Error
					? err.message
					: String(err),
			elapsedMs,
		};
	} finally {
		clearTimeout(timer);
	}
}
