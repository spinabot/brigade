/**
 * `composio` tool — shape + not-configured behavior (tempdir-isolated so it
 * never reads the operator's real ~/.brigade or hits the network/SDK).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
	__clearComposioWatchersForTests,
	capData,
	classifyConnectionStatus,
	isAuthError,
	isComposioConfigured,
	makeComposioTool,
	projectAccounts,
	projectTools,
	projectToolkits,
	resolveComposioApiKey,
} from "./composio-tool.js";

/** A fake Composio client (no network) — override individual methods per test. */
function fakeComposio(overrides: Record<string, unknown> = {}): never {
	const base = {
		toolkits: { get: async () => ({ items: [] }) },
		authConfigs: {
			list: async () => ({ items: [{ id: "ac_existing", status: "ENABLED" }] }),
			create: async () => ({ id: "ac_created" }),
		},
		tools: { execute: async () => ({ data: {}, error: null, successful: true }), getRawComposioTools: async () => [] },
		connectedAccounts: {
			get: async () => ({ id: "c", status: "ACTIVE" }),
			list: async () => ({ items: [] }),
			link: async () => ({ id: "ca_linked", status: "INITIATED", redirectUrl: "https://connect.composio.dev/link/lk_x" }),
		},
	};
	return { ...base, ...overrides } as never;
}
/** An error shaped like Composio's REAL wrapped-401: a generic top-level message
 *  with `status:undefined`, and the actual 401 buried on `err.cause`. */
function authErr(): Error {
	return Object.assign(new Error("Failed to fetch toolkits"), {
		name: "ComposioToolkitFetchError",
		status: undefined,
		cause: Object.assign(new Error('401 {"error":{"message":"Invalid API key: ak_xxx","status":401}}'), { status: 401 }),
	});
}

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
		__clearComposioWatchersForTests();
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

	it("connect returns ok:false (and never loads the SDK) when no key is set, pointing at set-key", async () => {
		const t = makeComposioTool({ agentId: "composio-nokey-agent" });
		const r = await t.execute("call-1", { action: "connect", app: "gmail" } as never);
		const payload = r.details as { ok: boolean; message: string };
		assert.equal(payload.ok, false);
		assert.match(String(payload.message), /set-key|no composio api key/i);
	});

	it("set-key verifies + seals the key (never echoed) and resolveComposioApiKey reads it back", async () => {
		const agentId = "composio-itest-agent"; // isolated id so it can't leak into other tests
		// Inject a client whose toolkits.get succeeds → key verifies.
		const t = makeComposioTool({ agentId, clientFactory: async () => fakeComposio() });
		assert.equal(isComposioConfigured(agentId), false);
		const r = await t.execute("call-2", { action: "set-key", key: "csk_secret_ABC123" } as never);
		const payload = r.details as { ok: boolean; message: string };
		assert.equal(payload.ok, true);
		assert.match(payload.message, /verified with Composio/i);
		assert.doesNotMatch(payload.message, /csk_secret_ABC123/); // key must never be echoed
		assert.equal(resolveComposioApiKey(agentId), "csk_secret_ABC123"); // sealed + readable
		assert.equal(isComposioConfigured(agentId), true);
	});

	it("set-key REFUSES to seal a key Composio rejects (auth error)", async () => {
		const agentId = "composio-badkey-agent";
		const t = makeComposioTool({
			agentId,
			clientFactory: async () => fakeComposio({ toolkits: { get: async () => { throw authErr(); } } }),
		});
		const r = await t.execute("c", { action: "set-key", key: "csk_bad" } as never);
		const payload = r.details as { ok: boolean; message: string };
		assert.equal(payload.ok, false);
		assert.match(payload.message, /rejected|invalid/i);
		assert.equal(isComposioConfigured(agentId), false); // nothing sealed
	});

	it("set-key SEALS anyway on a non-auth (network) error, flagged as unverified", async () => {
		const agentId = "composio-offline-agent";
		const t = makeComposioTool({
			agentId,
			clientFactory: async () => fakeComposio({ toolkits: { get: async () => { throw new Error("ENOTFOUND backend.composio.dev"); } } }),
		});
		const r = await t.execute("c", { action: "set-key", key: "csk_net" } as never);
		const payload = r.details as { ok: boolean; message: string };
		assert.equal(payload.ok, true);
		assert.match(payload.message, /couldn't reach Composio|unverified|verify it/i);
		assert.equal(resolveComposioApiKey(agentId), "csk_net"); // still sealed — don't lose a good key
	});

	it("connect uses the managed auth-config → link flow and returns a redirect URL", async () => {
		const agentId = "composio-connect-agent";
		const t = makeComposioTool({ agentId, clientFactory: async () => fakeComposio() });
		await t.execute("k", { action: "set-key", key: "csk_ok" } as never);
		const r = await t.execute("c", { action: "connect", app: "Gmail" } as never); // mixed-case slug tolerated
		const payload = r.details as { ok: boolean; redirectUrl?: string; connectionId?: string; message: string };
		assert.equal(payload.ok, true);
		assert.equal(payload.redirectUrl, "https://connect.composio.dev/link/lk_x");
		assert.equal(payload.connectionId, "ca_linked");
	});

	it("connect surfaces an actionable message for BYO apps (no managed auth → create 400s)", async () => {
		const agentId = "composio-byo-agent";
		const byo = fakeComposio({
			authConfigs: {
				list: async () => ({ items: [] }), // none exist
				create: async () => {
					throw Object.assign(new Error("Bad Request"), { cause: Object.assign(new Error("400"), { status: 400 }) });
				},
			},
		});
		const t = makeComposioTool({ agentId, clientFactory: async () => byo });
		await t.execute("k", { action: "set-key", key: "csk_ok" } as never);
		const r = await t.execute("c", { action: "connect", app: "twitter" } as never);
		const payload = r.details as { ok: boolean; message: string };
		assert.equal(payload.ok, false);
		assert.match(payload.message, /managed sign-in|own OAuth|dashboard/i);
	});

	it("apps pages through the WHOLE catalog (follows nextCursor) and reports the REAL total", async () => {
		const agentId = "composio-paging-agent";
		// Page 1 (no cursor) → 2 apps + nextCursor; page 2 (cursor) → 1 app + no cursor.
		const client = fakeComposio({
			toolkits: {
				get: async (q?: { cursor?: string }) =>
					q?.cursor
						? { items: [{ slug: "appc", name: "App C", meta: {} }], nextCursor: null }
						: {
								items: [
									{ slug: "appa", name: "App A", meta: {} },
									{ slug: "appb", name: "App B", meta: {} },
								],
								nextCursor: "cur1",
							},
			},
		});
		const t = makeComposioTool({ agentId, clientFactory: async () => client });
		await t.execute("k", { action: "set-key", key: "csk_ok" } as never);
		const r = await t.execute("a", { action: "apps" } as never);
		const payload = r.details as { ok: boolean; data: { apps: Array<{ slug: string }>; total: number } };
		assert.equal(payload.ok, true);
		assert.equal(payload.data.total, 3); // 2 (page 1) + 1 (page 2) — not a single page
		assert.deepEqual(
			payload.data.apps.map((a) => a.slug).sort(),
			["appa", "appb", "appc"],
		);
	});

	it("apps discovers the live catalog (no hardcoded list) and filters by query", async () => {
		const agentId = "composio-apps-agent";
		const catalog = {
			items: [
				{ slug: "gmail", name: "Gmail", meta: { description: "email", toolsCount: 12 } },
				{ slug: "googlecalendar", name: "Google Calendar", meta: { description: "calendar", toolsCount: 8 } },
				{ slug: "brandnewapp", name: "Brand New App", meta: { description: "just added by composio" } },
			],
		};
		const t = makeComposioTool({ agentId, clientFactory: async () => fakeComposio({ toolkits: { get: async () => catalog } }) });
		await t.execute("k", { action: "set-key", key: "csk_ok" } as never); // verifies + seals via same fake
		const r = await t.execute("a", { action: "apps", query: "calendar" } as never);
		const payload = r.details as { ok: boolean; data: { apps: Array<{ slug: string }> } };
		assert.equal(payload.ok, true);
		assert.deepEqual(payload.data.apps.map((a) => a.slug), ["googlecalendar"]);
		// And a brand-new app Composio just added is discoverable too (no code change).
		const r2 = await t.execute("a2", { action: "apps", query: "brand new" } as never);
		const p2 = r2.details as { data: { apps: Array<{ slug: string }> } };
		assert.deepEqual(p2.data.apps.map((a) => a.slug), ["brandnewapp"]);
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

	it("projectToolkits maps {items} or bare array to {slug,name,description,toolsCount} and drops malformed", () => {
		const items = [
			{ slug: "gmail", name: "Gmail", meta: { description: "email", toolsCount: 12 } },
			{ name: "no slug → dropped" },
		];
		const expected = [{ slug: "gmail", name: "Gmail", description: "email", toolsCount: 12 }];
		assert.deepEqual(projectToolkits({ items }), expected);
		assert.deepEqual(projectToolkits(items), expected); // tolerates a bare array too
		assert.deepEqual(projectToolkits(null), []);
	});

	it("isAuthError detects 401/403 + invalid-key messages, ignores network errors", () => {
		assert.equal(isAuthError(Object.assign(new Error("nope"), { status: 401 })), true);
		assert.equal(isAuthError(Object.assign(new Error("nope"), { status: 403 })), true);
		assert.equal(isAuthError(new Error("Invalid API key")), true);
		assert.equal(isAuthError(new Error("ENOTFOUND backend.composio.dev")), false);
		assert.equal(isAuthError(Object.assign(new Error("rate limited"), { status: 429 })), false);
	});

	it("classifyConnectionStatus maps ACTIVE→active, terminal failures→failed, rest→pending", () => {
		assert.equal(classifyConnectionStatus("ACTIVE"), "active");
		assert.equal(classifyConnectionStatus("active"), "active"); // case-insensitive
		for (const dead of ["FAILED", "EXPIRED", "DELETED", "INACTIVE", "ERROR", "REVOKED"]) {
			assert.equal(classifyConnectionStatus(dead), "failed", dead);
		}
		for (const pending of ["INITIALIZING", "INITIATED", undefined, "", "weird"]) {
			assert.equal(classifyConnectionStatus(pending as string | undefined), "pending", String(pending));
		}
	});

	it("isAuthError walks Composio's wrapped error chain (real shape: 401 buried on .cause)", () => {
		// Reproduces the live 2026-06-14 failure: SDK surfaces a generic
		// "Failed to fetch toolkits" with status:undefined, real 401 on err.cause.
		const wrapped = Object.assign(new Error("Failed to fetch toolkits"), {
			name: "ComposioToolkitFetchError",
			status: undefined,
			cause: Object.assign(new Error('401 {"error":{"message":"Invalid API key"}}'), { status: 401 }),
		});
		assert.equal(isAuthError(wrapped), true);
		// A genuine connection failure (no 401 anywhere) stays non-auth.
		const netErr = Object.assign(new Error("fetch failed"), { cause: new Error("ENOTFOUND backend.composio.dev") });
		assert.equal(isAuthError(netErr), false);
	});
});
