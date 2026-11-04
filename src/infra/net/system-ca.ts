/**
 * Trust the operating system's root certificates as well as Node's bundled ones.
 *
 * Node verifies TLS against its own CA list and ignores the OS store, so on a
 * network that inspects HTTPS (the proxy re-signs traffic with a root the machine
 * trusts) browsers and native tools work while every call out of Brigade fails
 * verification. `NODE_EXTRA_CA_CERTS` can't fix that for the gateway, because Node
 * reads it only at process start and a daemon doesn't inherit the shell's exports.
 *
 * Doing this in-process covers the CLI, the TUI and the gateway however each was
 * started. Verification stays on: the OS's roots are added to what Node trusts,
 * nothing is turned off.
 */

import tls from "node:tls";

/** The parts of `node:tls` this needs; both are absent on older Node releases. */
export interface CaApi {
	getCACertificates?: (type: "default" | "system") => string[];
	setDefaultCACertificates?: (certs: string[]) => void;
}

export type SystemCaResult =
	| { status: "merged"; added: number }
	| { status: "unsupported" | "disabled" | "failed" };

/**
 * Add the OS's roots to Node's default CA list. Call before anything opens a TLS
 * connection. Never throws: a store that can't be read must not stop Brigade
 * starting, and it then behaves exactly as it did without this.
 */
export function trustSystemCertificates(
	options: { tlsApi?: CaApi; env?: NodeJS.ProcessEnv } = {},
): SystemCaResult {
	const api = options.tlsApi ?? (tls as unknown as CaApi);
	const env = options.env ?? process.env;
	if (env.BRIGADE_NO_SYSTEM_CA === "1") return { status: "disabled" };
	if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") {
		return { status: "unsupported" };
	}
	try {
		// "default" already holds NODE_EXTRA_CA_CERTS, so that keeps working too.
		const current = api.getCACertificates("default");
		const known = new Set(current);
		const added = [...new Set(api.getCACertificates("system"))].filter((cert) => !known.has(cert));
		if (added.length > 0) api.setDefaultCACertificates([...current, ...added]);
		return { status: "merged", added: added.length };
	} catch {
		return { status: "failed" };
	}
}
