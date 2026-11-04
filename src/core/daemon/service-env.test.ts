import { strict as assert } from "node:assert";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { renderLaunchdPlist } from "./launchd.js";
import { buildServiceContext } from "./service.js";

describe("the installed gateway service's environment", () => {
	const saved = process.env.NODE_EXTRA_CA_CERTS;
	afterEach(() => {
		if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
		else process.env.NODE_EXTRA_CA_CERTS = saved;
	});

	it("carries NODE_EXTRA_CA_CERTS, so a CA that only lives in a PEM file reaches the daemon", () => {
		process.env.NODE_EXTRA_CA_CERTS = "/path/to/corporate-ca.pem";
		const ctx = buildServiceContext();
		assert.equal(ctx.env.NODE_EXTRA_CA_CERTS, "/path/to/corporate-ca.pem");
		assert.ok(renderLaunchdPlist(ctx).includes("<key>NODE_EXTRA_CA_CERTS</key><string>/path/to/corporate-ca.pem</string>"));
	});

	it("makes a relative path absolute, because the daemon runs from a different directory", () => {
		process.env.NODE_EXTRA_CA_CERTS = "certs/corporate-ca.pem";
		assert.equal(buildServiceContext().env.NODE_EXTRA_CA_CERTS, path.resolve("certs/corporate-ca.pem"));
	});

	it("adds nothing when the variable isn't set", () => {
		delete process.env.NODE_EXTRA_CA_CERTS;
		assert.equal("NODE_EXTRA_CA_CERTS" in buildServiceContext().env, false);
	});

	it("lets an explicit override win", () => {
		process.env.NODE_EXTRA_CA_CERTS = "/path/to/corporate-ca.pem";
		const ctx = buildServiceContext({ env: { NODE_EXTRA_CA_CERTS: "/path/to/other.pem" } });
		assert.equal(ctx.env.NODE_EXTRA_CA_CERTS, "/path/to/other.pem");
	});
});
