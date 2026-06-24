import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createSlackUserDirectory, isSlackUserId, type SlackUserInfoUser } from "./user-directory.js";

/** Flush the fire-and-forget prime: a macrotask drains all pending microtasks first. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake `users.info` that counts calls and serves a fixed id→user table. */
function fakeWeb(table: Record<string, SlackUserInfoUser | { __error: true } | { __notOk: true }>) {
	let calls = 0;
	return {
		calls: () => calls,
		web: {
			users: {
				info: async ({ user }: { user: string }) => {
					calls += 1;
					const u = table[user];
					if (!u) return { ok: false as const, error: "user_not_found" };
					if ((u as { __error?: boolean }).__error) throw new Error("network down");
					if ((u as { __notOk?: boolean }).__notOk) return { ok: false as const, error: "account_inactive" };
					return { ok: true as const, user: u as SlackUserInfoUser };
				},
			},
		},
	};
}

describe("isSlackUserId", () => {
	it("accepts U…/W… ids and rejects bots / channels / empty", () => {
		assert.equal(isSlackUserId("U07ABC"), true);
		assert.equal(isSlackUserId("W012XY"), true);
		assert.equal(isSlackUserId("B07BOT"), false);
		assert.equal(isSlackUserId("C07CHAN"), false);
		assert.equal(isSlackUserId("D07DM"), false);
		assert.equal(isSlackUserId(""), false);
	});
});

describe("createSlackUserDirectory", () => {
	it("resolves a name after prime settles — display_name wins", async () => {
		const f = fakeWeb({ U1: { profile: { display_name: "Alex", real_name: "Alexander" }, real_name: "Alexander", name: "alex" } });
		const dir = createSlackUserDirectory({ web: f.web });
		assert.equal(dir.resolveNameSync("U1"), undefined); // not primed yet → caller falls back to id
		dir.prime("U1");
		await tick();
		assert.equal(dir.resolveNameSync("U1"), "Alex");
	});

	it("falls back real_name → name when no display_name", async () => {
		const f = fakeWeb({ U2: { profile: { real_name: "Bo Bee" } }, U3: { name: "carol" } });
		const dir = createSlackUserDirectory({ web: f.web });
		dir.prime("U2");
		dir.prime("U3");
		await tick();
		assert.equal(dir.resolveNameSync("U2"), "Bo Bee");
		assert.equal(dir.resolveNameSync("U3"), "carol");
	});

	it("caches — a second prime within TTL does not re-call", async () => {
		const f = fakeWeb({ U1: { profile: { display_name: "Alex" } } });
		const dir = createSlackUserDirectory({ web: f.web });
		dir.prime("U1");
		await tick();
		dir.prime("U1");
		await tick();
		assert.equal(f.calls(), 1);
		assert.equal(dir.resolveNameSync("U1"), "Alex");
	});

	it("de-dupes a concurrent in-flight burst for one id into a single call", async () => {
		const f = fakeWeb({ U1: { profile: { display_name: "Alex" } } });
		const dir = createSlackUserDirectory({ web: f.web });
		dir.prime("U1");
		dir.prime("U1");
		dir.prime("U1");
		await tick();
		assert.equal(f.calls(), 1);
	});

	it("never calls for bot / channel / empty ids", async () => {
		const f = fakeWeb({});
		const dir = createSlackUserDirectory({ web: f.web });
		dir.prime("B07BOT");
		dir.prime("C07CHAN");
		dir.prime(undefined);
		await tick();
		assert.equal(f.calls(), 0);
	});

	it("negative-caches a users.info throw (no name, never rejects)", async () => {
		const f = fakeWeb({ U9: { __error: true } });
		const dir = createSlackUserDirectory({ web: f.web });
		dir.prime("U9");
		await tick();
		assert.equal(dir.resolveNameSync("U9"), undefined);
	});

	it("negative-caches an ok:false lookup, then retries after the negative TTL", async () => {
		let clock = 1_000;
		const f = fakeWeb({}); // unknown user → ok:false every time
		const dir = createSlackUserDirectory({ web: f.web, negativeTtlMs: 100, nowImpl: () => clock });
		dir.prime("U5");
		await tick();
		assert.equal(f.calls(), 1);
		dir.prime("U5"); // still inside the negative window → suppressed
		await tick();
		assert.equal(f.calls(), 1);
		clock += 200; // past the negative TTL
		dir.prime("U5");
		await tick();
		assert.equal(f.calls(), 2);
	});

	it("is a no-op with no web", async () => {
		const dir = createSlackUserDirectory({ web: null });
		dir.prime("U1");
		await tick();
		assert.equal(dir.resolveNameSync("U1"), undefined);
	});

	it("is a no-op when the injected web has no users slice", async () => {
		const dir = createSlackUserDirectory({ web: {} });
		dir.prime("U1");
		await tick();
		assert.equal(dir.resolveNameSync("U1"), undefined);
	});
});
