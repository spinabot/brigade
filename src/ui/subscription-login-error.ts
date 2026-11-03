/**
 * The line a failed subscription sign-in (Claude, ChatGPT, GitHub Copilot)
 * shows the operator.
 *
 * pi's OAuth errors can carry a URL, a response body or a token payload, so
 * the raw reason is never rendered. Instead this reads only two safe things
 * from the error — the network/TLS error code (Node's fetch puts it on the
 * `cause` chain; the outer message is always "fetch failed") and an HTTP
 * status — and maps them to a fixed sentence that names the cause. Without
 * this, a TLS-intercepting VPN, a DNS failure, a 429 and a provider outage all
 * read "Check your connection", and a device-code provider just never opens
 * the browser.
 */

const CANCELLED = "Login cancelled. Start again, or pick a different provider.";
const GENERIC = "We couldn't finish signing you in. Check your connection and try again.";

const TLS_CODE =
	/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|ERR_SSL|EPROTO|HOSTNAME_MISMATCH/;
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TIMEOUT_CODES = new Set([
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);
const CONNECTION_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"EPIPE",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENETDOWN",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
]);

/** The first string `code` on the error or its cause chain (depth-capped). */
function networkCode(err: unknown): string | undefined {
	let cur: unknown = err;
	for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
		const code = (cur as { code?: unknown }).code;
		if (typeof code === "string" && code) return code;
		cur = (cur as { cause?: unknown }).cause;
	}
	return undefined;
}

/** True when the error or its cause chain is an AbortSignal.timeout firing. */
function isTimeoutError(err: unknown): boolean {
	let cur: unknown = err;
	for (let depth = 0; depth < 6 && cur && typeof cur === "object"; depth++) {
		if ((cur as { name?: unknown }).name === "TimeoutError") return true;
		cur = (cur as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * The HTTP status in the shapes pi's OAuth providers throw:
 * `"429 Too Many Requests: …"`, `"… status=429; …"`, `"… failed (429): …"`,
 * `"… failed with status 429: …"`.
 */
function httpStatus(message: string): number | undefined {
	const m =
		/^([1-5]\d\d) /.exec(message) ??
		/\bstatus[= ]([1-5]\d\d)\b/.exec(message) ??
		/\(([1-5]\d\d)\)/.exec(message);
	return m?.[1] ? Number(m[1]) : undefined;
}

function certificateHint(): string {
	return process.allowedNodeEnvironmentFlags.has("--use-system-ca")
		? "If one is in use, retry with NODE_OPTIONS=--use-system-ca in front of the brigade command."
		: "If one is in use, point NODE_EXTRA_CA_CERTS at its certificate and retry.";
}

export function describeSubscriptionLoginFailure(err: unknown, providerName: string): string {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";

	if (/^login cancelled$/i.test(message) || message === "cancelled" || message === "back") return CANCELLED;
	if (err instanceof Error && err.name === "AbortError") return CANCELLED;

	const code = networkCode(err);
	if (code && TLS_CODE.test(code)) {
		return (
			`Couldn't verify ${providerName}'s security certificate (${code}). ` +
			`A VPN, proxy or security app may be inspecting HTTPS, or this computer's clock may be wrong. ` +
			certificateHint()
		);
	}
	if (code && DNS_CODES.has(code)) {
		return `Couldn't find ${providerName}'s server (${code}). Check your internet connection, DNS or VPN.`;
	}
	if (isTimeoutError(err) || (code && TIMEOUT_CODES.has(code))) {
		return `${providerName} didn't respond in time (${code && TIMEOUT_CODES.has(code) ? code : "timeout"}). Check your connection and try again.`;
	}
	if (code && CONNECTION_CODES.has(code)) {
		return `The connection to ${providerName} was refused or dropped (${code}). A firewall, proxy or VPN may be blocking it.`;
	}

	if (message === "Invalid GitHub Enterprise URL/domain") {
		return "That GitHub Enterprise address isn't valid. Leave it blank for github.com, or enter a host like company.ghe.com.";
	}
	if (/^Device flow timed out/.test(message)) {
		return "The sign-in code expired before it was approved. Start again and approve it in the browser.";
	}
	const deviceFailure = /^Device flow failed: ([a-z_]+)/.exec(message);
	if (deviceFailure?.[1]) {
		if (deviceFailure[1] === "access_denied") return "The sign-in was declined in the browser.";
		if (deviceFailure[1] === "expired_token") {
			return "The sign-in code expired before it was approved. Start again and approve it in the browser.";
		}
		return `${providerName} ended the sign-in (${deviceFailure[1]}).`;
	}

	const status = httpStatus(message);
	if (status === 429) {
		return `${providerName} is limiting sign-ins from this network right now (HTTP 429). Wait a few minutes, or try another network.`;
	}
	if (status !== undefined && status >= 500) {
		return `${providerName} is having trouble right now (HTTP ${status}). Try again in a few minutes.`;
	}
	if (status !== undefined && status >= 400) return `${providerName} refused the sign-in (HTTP ${status}).`;

	if (/^Invalid .*response/.test(message) || /^Untrusted verification_uri/.test(message)) {
		return `${providerName} sent a response Brigade couldn't read. Try again in a few minutes.`;
	}

	return GENERIC;
}
