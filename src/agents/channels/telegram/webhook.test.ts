import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
	buildTelegramWebhookRoute,
	hasValidTelegramWebhookSecret,
	safeEqualSecret,
	TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "./webhook.js";

/** Minimal fake request that streams a body + carries headers. */
function fakeReq(opts: { method?: string; headers?: Record<string, string>; body?: string }): EventEmitter & {
	method?: string;
	headers: Record<string, string | string[] | undefined>;
} {
	const req = new EventEmitter() as EventEmitter & {
		method?: string;
		headers: Record<string, string | string[] | undefined>;
	};
	req.method = opts.method ?? "POST";
	req.headers = opts.headers ?? {};
	// Emit the body on next tick so handlers can subscribe first.
	queueMicrotask(() => {
		if (opts.body !== undefined) req.emit("data", Buffer.from(opts.body, "utf8"));
		req.emit("end");
	});
	return req;
}

/** Minimal fake response that records status + body. */
function fakeRes(): { statusCode: number; body: string; headers: Record<string, string>; setHeader: (k: string, v: string) => void; end: (b?: string) => void } {
	const res = {
		statusCode: 0,
		body: "",
		headers: {} as Record<string, string>,
		setHeader(k: string, v: string) {
			res.headers[k] = v;
		},
		end(b?: string) {
			res.body = b ?? "";
		},
	};
	return res;
}

describe("safeEqualSecret", () => {
	it("true for equal, false for different / different-length", () => {
		assert.equal(safeEqualSecret("abc", "abc"), true);
		assert.equal(safeEqualSecret("abc", "abd"), false);
		assert.equal(safeEqualSecret("abc", "abcd"), false);
	});
});

describe("hasValidTelegramWebhookSecret", () => {
	it("passes when no secret is configured", () => {
		assert.equal(hasValidTelegramWebhookSecret(undefined, ""), true);
		assert.equal(hasValidTelegramWebhookSecret("anything", ""), true);
	});

	it("requires a matching header when a secret is configured", () => {
		assert.equal(hasValidTelegramWebhookSecret("s3cr3t", "s3cr3t"), true);
		assert.equal(hasValidTelegramWebhookSecret("wrong", "s3cr3t"), false);
		assert.equal(hasValidTelegramWebhookSecret(undefined, "s3cr3t"), false);
	});
});

describe("buildTelegramWebhookRoute", () => {
	const baseRoute = () => {
		const fed: unknown[] = [];
		const route = buildTelegramWebhookRoute({
			path: "/telegram/webhook",
			secretToken: "s3cr3t",
			resolveSink: () => ({ feedWebhookUpdate: (u) => fed.push(u) }),
		});
		return { route, fed };
	};

	it("declares the route shape (POST, auth none, exact)", () => {
		const { route } = baseRoute();
		assert.equal(route.method, "POST");
		assert.equal(route.path, "/telegram/webhook");
		assert.equal(route.auth, "none");
		assert.equal(route.match, "exact");
		assert.equal(route.skipSessionGuard, true);
	});

	it("rejects a request with a bad secret token (401) before parsing", async () => {
		const { route, fed } = baseRoute();
		const req = fakeReq({ headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "wrong" }, body: '{"update_id":1}' });
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 401);
		assert.equal(fed.length, 0, "a forged update must not reach the sink");
	});

	it("rejects a non-POST (405)", async () => {
		const { route } = baseRoute();
		const req = fakeReq({ method: "GET", headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "s3cr3t" } });
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 405);
	});

	it("feeds a valid update to the sink and replies 200 {ok:true}", async () => {
		const { route, fed } = baseRoute();
		const req = fakeReq({
			headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "s3cr3t" },
			body: JSON.stringify({ update_id: 7, message: { text: "hi" } }),
		});
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 200);
		assert.deepEqual(JSON.parse(res.body), { ok: true });
		assert.equal(fed.length, 1);
		assert.deepEqual(fed[0], { update_id: 7, message: { text: "hi" } });
	});

	it("returns 400 for invalid JSON (after secret passes)", async () => {
		const { route, fed } = baseRoute();
		const req = fakeReq({ headers: { [TELEGRAM_WEBHOOK_SECRET_HEADER]: "s3cr3t" }, body: "not json{" });
		const res = fakeRes();
		await route.handler(req as never, res as never);
		assert.equal(res.statusCode, 400);
		assert.equal(fed.length, 0);
	});
});
