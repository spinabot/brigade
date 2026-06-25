import { strict as assert } from "node:assert";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";

import {
	buildBlueBubblesWebhookRoute,
	createFixedWindowRateLimiter,
	createInFlightLimiter,
	parseBlueBubblesBody,
	verifyBlueBubblesWebhook,
	type BlueBubblesWebhookSink,
} from "./webhook.js";

// Assemble the password from parts so no token-shaped literal lands in the repo.
const PASSWORD = ["bb", "wh", "pass"].join("_");

/** A fake IncomingMessage carrying a pre-buffered body + a url + headers. */
function fakeReq(opts: { url?: string; body?: string; headers?: Record<string, string>; method?: string }): IncomingMessage {
	const req = {
		method: opts.method ?? "POST",
		url: opts.url ?? "/bluebubbles/webhook",
		headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
	} as unknown as IncomingMessage & { body?: Buffer };
	if (opts.body !== undefined) req.body = Buffer.from(opts.body, "utf8");
	return req;
}

/** A fake ServerResponse that records status + body. */
function fakeRes(): ServerResponse & { _status?: number; _body?: string } {
	const res = {
		statusCode: 0,
		setHeader() {},
		end(body?: string) {
			(res as { _body?: string })._body = body;
		},
	} as unknown as ServerResponse & { _status?: number; _body?: string };
	Object.defineProperty(res, "statusCode", {
		get() {
			return (res as { _status?: number })._status ?? 0;
		},
		set(v: number) {
			(res as { _status?: number })._status = v;
		},
	});
	return res;
}

describe("verifyBlueBubblesWebhook", () => {
	it("accepts the matching password", () => {
		assert.equal(verifyBlueBubblesWebhook({ expectedPassword: PASSWORD, suppliedToken: PASSWORD }), true);
	});
	it("rejects a wrong password", () => {
		assert.equal(verifyBlueBubblesWebhook({ expectedPassword: PASSWORD, suppliedToken: "nope" }), false);
	});
	it("rejects a missing token when a password is configured", () => {
		assert.equal(verifyBlueBubblesWebhook({ expectedPassword: PASSWORD, suppliedToken: undefined }), false);
	});
	it("skips the check when no password is configured", () => {
		assert.equal(verifyBlueBubblesWebhook({ expectedPassword: "", suppliedToken: undefined }), true);
	});
});

describe("parseBlueBubblesBody", () => {
	it("parses JSON", () => {
		const parsed = parseBlueBubblesBody(JSON.stringify({ type: "new-message", data: { guid: "M" } }), "application/json");
		assert.ok(parsed);
		assert.equal(parsed?.type, "new-message");
	});
	it("parses a form-encoded payload field", () => {
		const inner = encodeURIComponent(JSON.stringify({ type: "new-message", data: { guid: "X" } }));
		const parsed = parseBlueBubblesBody(`payload=${inner}`, "application/x-www-form-urlencoded");
		assert.ok(parsed);
		assert.equal(parsed?.type, "new-message");
	});
	it("returns null on garbage", () => {
		assert.equal(parseBlueBubblesBody("not json", "application/json"), null);
	});
});

describe("buildBlueBubblesWebhookRoute", () => {
	it("declares the expected route shape", () => {
		const route = buildBlueBubblesWebhookRoute({ path: "/bluebubbles/webhook", password: PASSWORD, resolveSink: () => null });
		assert.equal(route.method, "POST");
		assert.equal(route.path, "/bluebubbles/webhook");
		assert.equal(route.auth, "none");
		assert.equal(route.match, "exact");
		assert.equal(route.skipSessionGuard, true);
	});

	it("verifies the password from the URL query and feeds the sink", async () => {
		const fed: Array<{ eventType: string | undefined; payload: unknown }> = [];
		const sink: BlueBubblesWebhookSink = { feedWebhookEvent: (eventType, payload) => fed.push({ eventType, payload }) };
		const route = buildBlueBubblesWebhookRoute({ path: "/bluebubbles/webhook", password: PASSWORD, resolveSink: () => sink });
		const req = fakeReq({
			url: `/bluebubbles/webhook?password=${encodeURIComponent(PASSWORD)}`,
			body: JSON.stringify({ type: "new-message", data: { guid: "M" } }),
		});
		const res = fakeRes();
		await route.handler(req, res);
		assert.equal(res.statusCode, 200);
		assert.equal(fed.length, 1);
		assert.equal(fed[0]!.eventType, "new-message");
	});

	it("rejects (401) a request with the wrong password and does NOT feed the sink", async () => {
		const fed: unknown[] = [];
		const sink: BlueBubblesWebhookSink = { feedWebhookEvent: (_e, p) => fed.push(p) };
		const route = buildBlueBubblesWebhookRoute({ path: "/bluebubbles/webhook", password: PASSWORD, resolveSink: () => sink });
		const req = fakeReq({
			url: `/bluebubbles/webhook?password=wrong`,
			body: JSON.stringify({ type: "new-message", data: { guid: "M" } }),
		});
		const res = fakeRes();
		await route.handler(req, res);
		assert.equal(res.statusCode, 401);
		assert.equal(fed.length, 0);
	});

	it("accepts the password from an x-password header too", async () => {
		const fed: unknown[] = [];
		const sink: BlueBubblesWebhookSink = { feedWebhookEvent: (_e, p) => fed.push(p) };
		const route = buildBlueBubblesWebhookRoute({ path: "/bluebubbles/webhook", password: PASSWORD, resolveSink: () => sink });
		const req = fakeReq({
			url: `/bluebubbles/webhook`,
			headers: { "x-password": PASSWORD },
			body: JSON.stringify({ type: "new-message", data: { guid: "M" } }),
		});
		const res = fakeRes();
		await route.handler(req, res);
		assert.equal(res.statusCode, 200);
		assert.equal(fed.length, 1);
	});

	it("405s a non-POST", async () => {
		const route = buildBlueBubblesWebhookRoute({ path: "/bluebubbles/webhook", password: PASSWORD, resolveSink: () => null });
		const res = fakeRes();
		await route.handler(fakeReq({ method: "GET" }), res);
		assert.equal(res.statusCode, 405);
	});

	it("throttles (429) authenticated requests over the rate limit + stops feeding the sink", async () => {
		const fed: unknown[] = [];
		const sink: BlueBubblesWebhookSink = { feedWebhookEvent: (_e, p) => fed.push(p) };
		let clock = 1_000;
		const route = buildBlueBubblesWebhookRoute({
			path: "/bluebubbles/webhook",
			password: PASSWORD,
			resolveSink: () => sink,
			rateLimitMax: 2,
			rateLimitWindowMs: 1_000,
			now: () => clock,
		});
		const fire = async () => {
			const res = fakeRes();
			await route.handler(
				fakeReq({
					url: `/bluebubbles/webhook?password=${encodeURIComponent(PASSWORD)}`,
					body: JSON.stringify({ type: "new-message", data: { guid: "M" } }),
				}),
				res,
			);
			return res.statusCode;
		};
		// Same window (clock fixed) — first 2 pass, 3rd is throttled.
		assert.equal(await fire(), 200);
		assert.equal(await fire(), 200);
		assert.equal(await fire(), 429);
		assert.equal(fed.length, 2, "the throttled request never reached the sink");
		// New window — the counter resets and the next request passes again.
		clock += 1_000;
		assert.equal(await fire(), 200);
	});

	it("sheds load (429) when the in-flight cap is reached", async () => {
		// A streaming (non-pre-buffered) body whose `end` we control, so the handler
		// stays in-flight while holding its slot.
		const releasers: Array<() => void> = [];
		function streamingReq(): IncomingMessage {
			const listeners: Record<string, (chunk?: Buffer) => void> = {};
			const req = {
				method: "POST",
				url: `/bluebubbles/webhook?password=${encodeURIComponent(PASSWORD)}`,
				headers: { "content-type": "application/json" },
				on(event: string, cb: (chunk?: Buffer) => void) {
					listeners[event] = cb;
					return req;
				},
			} as unknown as IncomingMessage;
			// Defer the body's completion until we release it.
			releasers.push(() => {
				listeners.data?.(Buffer.from(JSON.stringify({ type: "new-message", data: { guid: "M" } }), "utf8"));
				listeners.end?.();
			});
			return req;
		}
		const sink: BlueBubblesWebhookSink = { feedWebhookEvent: () => {} };
		const route = buildBlueBubblesWebhookRoute({
			path: "/bluebubbles/webhook",
			password: PASSWORD,
			resolveSink: () => sink,
			maxInFlight: 1,
			rateLimitMax: 100,
		});
		const res1 = fakeRes();
		const res2 = fakeRes();
		// First request starts and parks on the unfinished body (holds the 1 slot).
		const p1 = route.handler(streamingReq(), res1);
		await new Promise((r) => setImmediate(r));
		// Second request arrives while the first is still in-flight → 429.
		await route.handler(streamingReq(), res2);
		assert.equal(res2.statusCode, 429);
		// Release the first request's body so it completes 200.
		releasers[0]!();
		await p1;
		assert.equal(res1.statusCode, 200);
	});
});

describe("createFixedWindowRateLimiter", () => {
	it("allows up to `max` per window then throttles, resetting next window", () => {
		let now = 0;
		const rl = createFixedWindowRateLimiter(3, 1_000);
		assert.equal(rl.hit(now), true);
		assert.equal(rl.hit(now), true);
		assert.equal(rl.hit(now), true);
		assert.equal(rl.hit(now), false, "4th in the same window is throttled");
		now += 1_000;
		assert.equal(rl.hit(now), true, "new window resets the count");
	});
});

describe("createInFlightLimiter", () => {
	it("caps concurrent holders and frees a slot on release", () => {
		const lim = createInFlightLimiter(2);
		const a = lim.tryAcquire();
		const b = lim.tryAcquire();
		assert.ok(a && b);
		assert.equal(lim.tryAcquire(), null, "third over the cap is refused");
		a!();
		assert.ok(lim.tryAcquire(), "a freed slot is reusable");
	});

	it("a double release does not over-decrement the count", () => {
		const lim = createInFlightLimiter(1);
		const rel = lim.tryAcquire();
		assert.ok(rel);
		rel!();
		rel!(); // no-op
		assert.equal(lim.inFlight(), 0);
	});
});
