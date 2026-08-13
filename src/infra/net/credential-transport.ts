/**
 * Cleartext-credential gate — "may this URL carry an API key?".
 *
 * Brigade sends provider API keys as `Authorization: Bearer` headers. Over
 * plain `http://` those keys cross the wire in the clear, readable by anyone
 * on the path (café Wi-Fi, a hotel NAT, a compromised switch). But cleartext
 * MUST keep working for local inference: Ollama defaults to
 * `http://localhost:11434`, and LM Studio / llama.cpp sit on
 * `http://127.0.0.1:<port>`. Traffic to those never leaves the machine, so
 * there is no wire to sniff.
 *
 * Hence the rule this module encodes: cleartext is allowed ONLY to a loopback
 * destination; everything else must be `https://`.
 *
 * This is the mirror image of `fetch-guard.ts`. The SSRF guard asks "is this
 * target private, and therefore off-limits?"; this gate asks "is this target
 * MY OWN machine, and therefore safe to talk to in the clear?". The private-
 * network set is shared with the SSRF classifier rather than re-derived here.
 */

import { isIPv4, isIPv6 } from "node:net";

import { classifyHostnameSync } from "./fetch-guard.js";

/**
 * Escape hatch for an operator who genuinely runs inference on ANOTHER box on
 * their LAN (`http://192.168.1.50:11434`) and can't put TLS in front of it.
 * Off by default — see `checkCredentialTransport` for the reasoning — and
 * every call site that honours it reports the fact to the operator.
 */
const ALLOW_LAN_ENV = "BRIGADE_ALLOW_INSECURE_LAN_ENDPOINTS";

/**
 * Does traffic to this hostname stay on the local machine?
 *
 * Takes a hostname — `new URL(...).hostname`, NOT a raw URL. A substring test
 * on a raw URL would happily accept `http://localhost.evil.tld/` and
 * `http://127.0.0.1.evil.tld/`, which are ordinary public names that merely
 * begin with a loopback-looking label; only a parsed hostname compared whole
 * is safe.
 *
 * Loopback means: the exact name `localhost` (RFC 6761 reserves it for the
 * loopback interface), anything in `127.0.0.0/8` (not just `127.0.0.1` —
 * `127.0.0.2` is loopback too), `::1`, its IPv4-mapped spellings, and the
 * unspecified addresses `0.0.0.0` / `::`, which every platform we ship to
 * connects to the local host.
 */
export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.trim().toLowerCase();
	if (!host) return false;
	// `URL.hostname` KEEPS the brackets on an IPv6 literal (`[::1]`, and even
	// `[::ffff:7f00:1]`), so strip them before handing the address to node:net.
	const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (stripped === "localhost") return true;
	if (isIPv4(stripped)) {
		// 127.0.0.0/8 — the whole block. `isIPv4` already guarantees a canonical
		// dotted quad, so the first label is a plain number.
		const first = Number.parseInt(stripped.split(".")[0] ?? "", 10);
		return first === 127 || stripped === "0.0.0.0";
	}
	// Drop a zone identifier (`::1%lo0`) before classifying — the address is
	// what we judge; the zone only ever routes locally.
	const noZone = stripped.split("%", 1)[0] ?? stripped;
	if (isIPv6(noZone)) {
		if (noZone === "::1" || noZone === "::") return true;
		// IPv4-mapped loopback. `new URL()` rewrites `::ffff:127.0.0.1` into its
		// compressed hex form `::ffff:7f00:1`, so accept both spellings.
		const dotted = noZone.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
		if (dotted) return isLoopbackHostname(dotted[1] ?? "");
		const hex = noZone.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
		if (hex) return Number.parseInt(hex[1] ?? "", 16) >>> 8 === 127;
		return false;
	}
	return false;
}

/**
 * Is this hostname a private/LAN address (RFC1918, CGNAT, link-local, ULA,
 * `.local`/`.internal`)?
 *
 * Derived from the SSRF classifier instead of a second, subtly-different copy
 * of the ranges: a host is "private" exactly when the default classifier
 * refuses it but the `allowPrivateNetwork` classifier accepts it. That
 * difference IS the private-network set — and because cloud-metadata hosts are
 * refused in BOTH modes, `169.254.169.254` and friends can never fall into it.
 */
function isPrivateNetworkHostname(hostname: string): boolean {
	if (classifyHostnameSync(hostname) === null) return false;
	return classifyHostnameSync(hostname, { allowPrivateNetwork: true }) === null;
}

/**
 * Verdict from `checkCredentialTransport`. `warning` is set when the URL was
 * only allowed because the operator opted into insecure LAN endpoints — call
 * sites that can talk to the operator should surface it. `reason` is a
 * finished, printable line in the CLI's voice.
 */
export type CredentialTransportCheck = { ok: true; warning?: string } | { ok: false; reason: string };

/**
 * May a provider API key be sent to `rawUrl`?
 *
 * `https://` — always. `http://` — only to loopback (see `isLoopbackHostname`).
 *
 * LAN addresses (10/8, 172.16/12, 192.168/16, `.local`, …) are deliberately NOT
 * loopback and are refused by default. A LAN is a shared broadcast domain with
 * other people's laptops, printers and IoT gear on it; "inside the office
 * network" is not a confidentiality boundary, and a key sent across it is a key
 * anyone on that segment can read. An operator running Ollama on another box can
 * put TLS in front of it, or set `BRIGADE_ALLOW_INSECURE_LAN_ENDPOINTS=1` to
 * accept that risk knowingly — an explicit, reported choice rather than a silent
 * default.
 */
export function checkCredentialTransport(rawUrl: string): CredentialTransportCheck {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return { ok: false, reason: "That doesn't look like a URL. Use https://host/v1 — or http:// for a server on this machine." };
	}
	if (parsed.protocol === "https:") return { ok: true };
	if (parsed.protocol !== "http:") {
		return {
			ok: false,
			reason: `Brigade only talks to http:// or https:// endpoints — ${parsed.protocol}// isn't supported.`,
		};
	}
	if (isLoopbackHostname(parsed.hostname)) return { ok: true };
	if (process.env[ALLOW_LAN_ENV] === "1" && isPrivateNetworkHostname(parsed.hostname)) {
		return {
			ok: true,
			warning: `Sending your API key unencrypted to ${parsed.host} because ${ALLOW_LAN_ENV}=1 is set. Anyone on that network can read it.`,
		};
	}
	return {
		ok: false,
		reason:
			`Refusing to send your API key unencrypted to ${parsed.host} — over http:// anyone on the network can read it. ` +
			`Use https:// for a remote endpoint, or point Brigade at a server on this machine (Ollama runs on http://localhost:11434).`,
	};
}
