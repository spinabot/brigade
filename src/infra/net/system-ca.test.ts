/**
 * Node ships its own CA list and ignores the operating system's, so on a network
 * that inspects HTTPS (the proxy re-signs traffic with a root the OS trusts) every
 * call out of Brigade failed certificate verification while browsers and other
 * native tools worked. The login failed before the browser opened, and the gateway
 * reported a bare "Connection error.". These tests pin the fix: the OS's roots are
 * added to Node's defaults, with certificate verification still on.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import tls from "node:tls";

import { trustSystemCertificates, type CaApi } from "./system-ca.js";

function fakeApi(stores: { default: string[]; system: string[] }): CaApi & { set: string[][] } {
	const set: string[][] = [];
	return {
		set,
		getCACertificates: (type) => (type === "system" ? stores.system : stores.default),
		setDefaultCACertificates: (certs) => {
			set.push(certs);
		},
	};
}

describe("trustSystemCertificates", () => {
	it("adds the OS's roots after Node's own, without duplicates", () => {
		const api = fakeApi({ default: ["bundled", "shared"], system: ["shared", "corporate-root"] });
		const result = trustSystemCertificates({ tlsApi: api, env: {} });
		assert.deepEqual(api.set, [["bundled", "shared", "corporate-root"]]);
		assert.deepEqual(result, { status: "merged", added: 1 });
	});

	it("leaves Node's list alone when the OS adds nothing new", () => {
		const api = fakeApi({ default: ["bundled"], system: ["bundled"] });
		assert.deepEqual(trustSystemCertificates({ tlsApi: api, env: {} }), { status: "merged", added: 0 });
		assert.deepEqual(api.set, []);
	});

	it("does nothing on a Node without the API, so older runtimes behave as before", () => {
		const result = trustSystemCertificates({ tlsApi: {} as CaApi, env: {} });
		assert.deepEqual(result, { status: "unsupported" });
	});

	it("honours the opt-out without reading the OS store", () => {
		const api = fakeApi({ default: ["bundled"], system: ["corporate-root"] });
		api.getCACertificates = () => {
			throw new Error("must not read the store");
		};
		assert.deepEqual(trustSystemCertificates({ tlsApi: api, env: { BRIGADE_NO_SYSTEM_CA: "1" } }), { status: "disabled" });
		assert.deepEqual(api.set, []);
	});

	it("never stops Brigade from starting when the OS store can't be read", () => {
		const api = fakeApi({ default: ["bundled"], system: [] });
		api.getCACertificates = () => {
			throw new Error("keychain unavailable");
		};
		assert.deepEqual(trustSystemCertificates({ tlsApi: api, env: {} }), { status: "failed" });
	});

	it("never stops Brigade from starting when Node rejects a certificate", () => {
		const api = fakeApi({ default: ["bundled"], system: ["corrupt"] });
		api.setDefaultCACertificates = () => {
			throw new Error("bad PEM");
		};
		assert.deepEqual(trustSystemCertificates({ tlsApi: api, env: {} }), { status: "failed" });
	});
});

describe("on a real TLS connection", () => {
	it("fetch rejects an inspecting proxy's certificate until the OS's root is trusted", async (t) => {
		const real = tls as unknown as Required<CaApi>;
		if (typeof real.setDefaultCACertificates !== "function") return t.skip("this Node has no setDefaultCACertificates");

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-system-ca-"));
		const keyPath = path.join(dir, "key.pem");
		const certPath = path.join(dir, "cert.pem");
		const made = spawnSync("openssl", [
			"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
			"-keyout", keyPath, "-out", certPath,
			"-subj", "/CN=localhost",
			"-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
		]);
		if (made.status !== 0) {
			fs.rmSync(dir, { recursive: true, force: true });
			return t.skip("openssl is not available");
		}
		const corporateRoot = fs.readFileSync(certPath, "utf8");
		const server = https.createServer({ key: fs.readFileSync(keyPath), cert: corporateRoot }, (_req, res) => res.end("ok"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
		const original = real.getCACertificates("default");

		try {
			await assert.rejects(fetch(url), (err: Error) => {
				assert.equal((err.cause as { code?: string }).code, "DEPTH_ZERO_SELF_SIGNED_CERT");
				return true;
			});

			const result = trustSystemCertificates({
				tlsApi: {
					getCACertificates: (type) => (type === "system" ? [corporateRoot] : real.getCACertificates(type)),
					setDefaultCACertificates: real.setDefaultCACertificates,
				},
				env: {},
			});
			assert.deepEqual(result, { status: "merged", added: 1 });

			// A fresh connection, because fetch's pool could otherwise reuse nothing but
			// also must not be what makes this pass.
			const res = await fetch(url, { headers: { connection: "close" } });
			assert.equal(await res.text(), "ok");
		} finally {
			real.setDefaultCACertificates(original);
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
