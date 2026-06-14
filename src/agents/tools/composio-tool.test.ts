/**
 * `composio` tool — shape + not-configured behavior (tempdir-isolated so it
 * never reads the operator's real ~/.brigade or hits the network/SDK).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { capData, isComposioConfigured, makeComposioTool, projectAccounts, projectTools } from "./composio-tool.js";

describe("composio tool", () => {
	let stateDir: string;
	let prevState: string | undefined;
	let prevKey: string | undefined;

	before(() => {
		stateDir = mkdtempSync(join(tmpdir(), "brigade-composio-"));
		prevState = process.env.BRIGADE_STATE_DIR;
		prevKey = process.env.COMPOSIO_API_KEY;
		process.env.BRIGADE_STATE_DIR = stateDir;
		delete process.env.COMPOSIO_API_KEY;
	});
	after(() => {
		if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
		else process.env.BRIGADE_STATE_DIR = prevState;
		if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY;
		else process.env.COMPOSIO_API_KEY = prevKey;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("is owner-only and named 'composio'", () => {
		const t = makeComposioTool();
		assert.equal(t.name, "composio");
		assert.equal(t.ownerOnly, true);
		assert.ok(t.parameters, "parameters schema present");
		assert.equal(typeof t.execute, "function");
	});

	it("isComposioConfigured is false with no key (env unset, empty state)", () => {
		assert.equal(isComposioConfigured(), false);
	});

	it("execute returns ok:false (and never loads the SDK) when not configured", async () => {
		const t = makeComposioTool();
		const r = await t.execute("call-1", { action: "connect", app: "gmail" } as never);
		const payload = r.details as { ok: boolean; message: string };
		assert.equal(payload.ok, false);
		assert.match(String(payload.message), /configured/i);
	});
});

describe("composio projections (pure — no network)", () => {
	it("projectTools keeps slug/name/description/toolkit and drops the heavy schema", () => {
		const raw = [
			{
				slug: "GMAIL_SEND_EMAIL",
				name: "Send Email",
				description: "send an email",
				toolkit: { slug: "gmail" },
				inputParameters: { type: "object", properties: { huge: 1 } },
			},
			{ name: "no slug → dropped" },
		];
		assert.deepEqual(projectTools(raw), [
			{ slug: "GMAIL_SEND_EMAIL", name: "Send Email", description: "send an email", toolkit: "gmail" },
		]);
		assert.deepEqual(projectTools(null), []);
	});

	it("projectAccounts maps items to {id,toolkit,status} and drops malformed", () => {
		const res = { items: [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } }, { status: "no id" }] };
		assert.deepEqual(projectAccounts(res), [{ id: "ca_1", toolkit: "gmail", status: "ACTIVE" }]);
		assert.deepEqual(projectAccounts({}), []);
		assert.deepEqual(projectAccounts(null), []);
	});

	it("capData passes small values through and truncates large ones", () => {
		assert.deepEqual(capData({ a: 1 }), { a: 1 });
		const capped = capData({ blob: "x".repeat(20_000) }, 1000) as { truncated?: boolean; preview?: string };
		assert.equal(capped.truncated, true);
		assert.ok((capped.preview?.length ?? 0) <= 1000);
	});
});
