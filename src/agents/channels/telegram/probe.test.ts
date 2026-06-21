import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { probeTelegram } from "./probe.js";

/** Build a fake fetch returning a canned response. */
function fakeFetch(opts: { ok?: boolean; status?: number; json?: unknown; throwErr?: Error }): typeof fetch {
	return (async () => {
		if (opts.throwErr) throw opts.throwErr;
		return {
			ok: opts.ok ?? true,
			status: opts.status ?? 200,
			json: async () => opts.json,
		} as Response;
	}) as unknown as typeof fetch;
}

describe("probeTelegram", () => {
	it("returns ok + bot identity on a successful getMe", async () => {
		const res = await probeTelegram({
			token: "1:AAA",
			fetchImpl: fakeFetch({
				json: {
					ok: true,
					result: { id: 42, username: "brigadebot", first_name: "Brigade", can_join_groups: true },
				},
			}),
		});
		assert.equal(res.ok, true);
		assert.equal(res.bot?.id, 42);
		assert.equal(res.bot?.username, "brigadebot");
		assert.equal(res.bot?.canJoinGroups, true);
	});

	it("returns ok:false with no token", async () => {
		const res = await probeTelegram({ token: "" });
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /no Telegram bot token/);
	});

	it("surfaces a 401 as a token-rejected error", async () => {
		const res = await probeTelegram({
			token: "bad",
			fetchImpl: fakeFetch({ ok: false, status: 401, json: { ok: false, description: "Unauthorized" } }),
		});
		assert.equal(res.ok, false);
		assert.equal(res.status, 401);
		assert.match(res.error ?? "", /Unauthorized/);
	});

	it("returns ok:false on a network error (never throws)", async () => {
		const res = await probeTelegram({
			token: "1:AAA",
			fetchImpl: fakeFetch({ throwErr: new Error("ECONNREFUSED") }),
		});
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /ECONNREFUSED/);
	});
});
