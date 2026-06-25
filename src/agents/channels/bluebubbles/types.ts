/**
 * BlueBubbles REST plumbing + shared transport types.
 *
 * BlueBubbles authenticates EVERY REST call by the server password in the QUERY
 * STRING (`?password=<urlencoded>`), NOT a header. `buildBlueBubblesApiUrl`
 * assembles `${serverUrl}/api/v1/<path>?password=…` (the `URL` constructor
 * URL-encodes the password automatically). `blueBubblesFetchWithTimeout` is the
 * single network primitive every REST helper goes through — and it takes an
 * INJECTABLE `fetch` so tests can mock the wire with zero network.
 */

/** Default REST timeout (ms). Attachment uploads override to a longer value. */
export const BLUEBUBBLES_DEFAULT_TIMEOUT_MS = 10_000;

/** The injectable fetch seam — production passes `fetch`; tests pass a mock. */
export type FetchLike = typeof fetch;

/**
 * Build a BlueBubbles REST URL. `path` is the API path AFTER `/api/v1/`
 * (e.g. `"message/text"`). The password rides in the query string (the wire's
 * auth) and is URL-encoded by the `URL` builder. `query` adds extra params.
 */
export function buildBlueBubblesApiUrl(params: {
	serverUrl: string;
	path: string;
	password?: string;
	query?: Record<string, string | number | undefined>;
}): string {
	const base = (params.serverUrl ?? "").trim().replace(/\/+$/, "");
	if (!base) throw new Error("BlueBubbles serverUrl is required");
	const cleanPath = params.path.replace(/^\/+/, "");
	const url = new URL(`/api/v1/${cleanPath}`, `${base}/`);
	if (params.password) url.searchParams.set("password", params.password);
	if (params.query) {
		for (const [k, v] of Object.entries(params.query)) {
			if (v === undefined) continue;
			url.searchParams.set(k, String(v));
		}
	}
	return url.toString();
}

/**
 * Fetch with an AbortController timeout. `fetchImpl` defaults to the global
 * `fetch`; inject a mock in tests. Never swallows the abort — a timeout rejects
 * with the AbortController's error so callers can classify it.
 */
export async function blueBubblesFetchWithTimeout(
	url: string,
	init: RequestInit,
	opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<Response> {
	const doFetch = opts.fetchImpl ?? fetch;
	const timeoutMs = opts.timeoutMs ?? BLUEBUBBLES_DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
	try {
		return await doFetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Read a BlueBubbles JSON response, returning the `data` field (the API wraps
 * payloads as `{ status, message, data }`). Throws an operator-facing error on a
 * non-2xx response or a server-reported error. `context` names the call for the
 * error message.
 */
export async function readBlueBubblesJson<T = unknown>(res: Response, context: string): Promise<T> {
	let body: unknown = null;
	const text = await res.text();
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	const record = (body && typeof body === "object" ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
	if (!res.ok) {
		const msg =
			(typeof record.message === "string" && record.message) ||
			(typeof record.error === "string" && record.error) ||
			`HTTP ${res.status}`;
		throw new Error(`BlueBubbles ${context} failed: ${msg}`);
	}
	return record.data as T;
}

/** The BlueBubbles `server/info` payload the probe + capability detection read. */
export interface BlueBubblesServerInfo {
	/** macOS version of the host (`"14.4"`, `"26.0"`, …). */
	os_version?: string;
	/** BlueBubbles server version. */
	server_version?: string;
	/** Whether the Private API is enabled (gates reactions/edit/unsend/effects/groups). */
	private_api?: boolean;
	/** Whether the BlueBubbles helper bundle is connected. */
	helper_connected?: boolean;
	/** Proxy service in use (ngrok / cloudflare / …). */
	proxy_service?: string;
	[key: string]: unknown;
}
