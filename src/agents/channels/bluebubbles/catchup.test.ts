import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { runBlueBubblesCatchup, BLUEBUBBLES_CATCHUP_MAX_LIMIT } from "./catchup.js";
import { connectBlueBubbles } from "./connection.js";
import type { ResolvedBlueBubblesAccount } from "./account-config.js";

const SERVER = "http://192.168.1.5:1234";
const PASSWORD = ["bb", "catchup", "pw"].join("-");

/** A fake fetch returning a canned message-query `data` array + recording the request body. */
function queryFetch(messages: unknown[], rec: { body: unknown }): typeof fetch {
	return (async (_url: string, init: RequestInit) => {
		if (typeof init.body === "string") {
			try {
				rec.body = JSON.parse(init.body);
			} catch {
				rec.body = init.body;
			}
		}
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ status: 200, data: messages }),
			headers: new Map<string, string>() as unknown as Headers,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("runBlueBubblesCatchup", () => {
	it("queries message/query with a bounded after-window + limit and re-feeds each record", async () => {
		const rec: { body: unknown } = { body: null };
		const f = queryFetch([{ guid: "m1" }, { guid: "m2" }], rec);
		const fed: Array<Record<string, unknown>> = [];
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			feedRecord: (r) => fed.push(r),
			now: () => 1_000_000,
		});
		assert.equal(summary.querySucceeded, true);
		assert.equal(summary.fetched, 2);
		assert.equal(summary.replayed, 2);
		assert.equal(fed.length, 2);
		// The query carried `after` (the window start) + a sort + a limit.
		const body = rec.body as Record<string, unknown>;
		assert.equal(typeof body.after, "number");
		assert.equal(body.after, summary.windowStartMs);
		assert.equal(body.sort, "ASC");
		assert.equal(typeof body.limit, "number");
	});

	it("clamps the per-run limit to the hard ceiling", async () => {
		const rec: { body: unknown } = { body: null };
		const f = queryFetch([], rec);
		await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			config: { limit: 99_999 },
			feedRecord: () => {},
		});
		assert.equal((rec.body as Record<string, unknown>).limit, BLUEBUBBLES_CATCHUP_MAX_LIMIT);
	});

	it("is a no-op when disabled", async () => {
		let called = false;
		const f = (async () => {
			called = true;
			return { ok: true, status: 200, text: async () => "{}", headers: new Map() as unknown as Headers } as unknown as Response;
		}) as unknown as typeof fetch;
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			config: { enabled: false },
			feedRecord: () => {},
		});
		assert.equal(called, false);
		assert.equal(summary.querySucceeded, false);
	});

	it("never throws on a transport failure", async () => {
		const f = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			fetchImpl: f,
			feedRecord: () => {},
		});
		assert.equal(summary.querySucceeded, false);
		assert.equal(summary.replayed, 0);
	});
});

describe("runBlueBubblesCatchup — persisted cursor (Fix 8)", () => {
	/** A fetch that records the `after` it was queried with + returns canned messages. */
	function cursorFetch(messages: unknown[], rec: { after?: number }): typeof fetch {
		return (async (_url: string, init: RequestInit) => {
			if (typeof init.body === "string") {
				try {
					rec.after = (JSON.parse(init.body) as { after?: number }).after;
				} catch {
					/* ignore */
				}
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ status: 200, data: messages }),
				headers: new Map<string, string>() as unknown as Headers,
			} as unknown as Response;
		}) as unknown as typeof fetch;
	}

	function memStore() {
		const map = new Map<string, import("./catchup-cursor.js").BlueBubblesCatchupCursor>();
		return {
			map,
			store: {
				load: (id: string) => map.get(id) ?? null,
				save: (id: string, c: import("./catchup-cursor.js").BlueBubblesCatchupCursor) => void map.set(id, c),
			},
		};
	}

	it("advances the cursor across runs (second run queries after the first's high-water mark)", async () => {
		const { map, store } = memStore();
		const rec1: { after?: number } = {};
		const summary1 = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			accountId: "home",
			cursorStore: store,
			fetchImpl: cursorFetch([{ guid: "m1", dateCreated: 1_000 }], rec1),
			feedRecord: () => {},
			now: () => 5_000,
		});
		assert.equal(summary1.cursorAfter, 5_000, "clean pass advances cursor to now");
		assert.equal(map.get("home")?.lastSeenMs, 5_000);

		// Second run: cursor is now 5_000, so the query's `after` should be 5_000.
		const rec2: { after?: number } = {};
		await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			accountId: "home",
			cursorStore: store,
			fetchImpl: cursorFetch([], rec2),
			feedRecord: () => {},
			now: () => 9_000,
		});
		assert.equal(rec2.after, 5_000, "second run queries strictly after the persisted cursor");
	});

	it("pages a backlog > limit by advancing only to the page boundary", async () => {
		const { map, store } = memStore();
		// limit 2, fetched 2 (truncated) → cursor advances to the latest fetched ts, not now.
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			accountId: "home",
			cursorStore: store,
			config: { limit: 2 },
			fetchImpl: cursorFetch([{ guid: "a", dateCreated: 1_000 }, { guid: "b", dateCreated: 2_000 }], {}),
			feedRecord: () => {},
			now: () => 100_000,
		});
		assert.equal(summary.fetched, 2);
		assert.equal(summary.cursorAfter, 2_000, "truncated fetch advances to the page boundary, not now");
		assert.equal(map.get("home")?.lastSeenMs, 2_000);
	});

	it("gives up on a message after maxFailureRetries and force-advances past it", async () => {
		const { map, store } = memStore();
		const failing = [{ guid: "bad", dateCreated: 1_000 }];
		const runOnce = (now: number) =>
			runBlueBubblesCatchup({
				serverUrl: SERVER,
				password: PASSWORD,
				accountId: "home",
				cursorStore: store,
				config: { maxFailureRetries: 3, limit: 50 },
				fetchImpl: cursorFetch(failing, {}),
				feedRecord: () => {
					throw new Error("normalize wedge");
				},
				now: () => now,
			});

		// Runs 1+2: still retrying — cursor is HELD before the failing ts (1_000 → 999).
		const s1 = await runOnce(10_000);
		assert.equal(s1.failed, 1);
		assert.equal(s1.givenUp, 0);
		assert.equal(s1.cursorAfter, 999, "held just before the failing message");
		assert.equal(map.get("home")?.failureRetries?.bad, 1);
		const s2 = await runOnce(20_000);
		assert.equal(map.get("home")?.failureRetries?.bad, 2);
		assert.equal(s2.cursorAfter, 999);

		// Run 3: crosses the ceiling (count 3) → GIVEN UP, cursor force-advances to now.
		const s3 = await runOnce(30_000);
		assert.equal(s3.givenUp, 1);
		assert.equal(s3.cursorAfter, 30_000, "given-up message no longer holds the cursor");

		// Run 4: the GUID is skipped on sight (already given up), no further failure.
		const s4 = await runOnce(40_000);
		assert.equal(s4.skippedGivenUp, 1);
		assert.equal(s4.failed, 0);
	});

	it("uses the legacy fixed-lookback (no persistence) when no accountId is given", async () => {
		const { map, store } = memStore();
		const summary = await runBlueBubblesCatchup({
			serverUrl: SERVER,
			password: PASSWORD,
			cursorStore: store, // present but unused without an accountId
			fetchImpl: cursorFetch([{ guid: "m1", dateCreated: 1 }], {}),
			feedRecord: () => {},
			now: () => 1_000_000,
		});
		assert.equal(summary.cursorBefore, null);
		assert.equal(map.size, 0, "no cursor persisted without an accountId");
	});
});

/** Minimal resolved account for a connection-level catchup test. */
function account(fetchImpl: typeof fetch): ResolvedBlueBubblesAccount {
	return {
		accountId: "default",
		enabled: true,
		serverUrl: SERVER,
		password: PASSWORD,
		webhookPath: "/bluebubbles/webhook",
		region: "US",
		mediaMaxBytes: 100 * 1024 * 1024,
		probeTimeoutMs: 5000,
		actions: { reactions: true, edit: true, unsend: true, effects: true, groupAdmin: true },
		allowPrivateNetwork: true,
		selfHandle: "",
		inboundDebounceMs: 0,
		historyLimit: 10,
		dmHistoryLimit: 0,
		mediaLocalRoots: [],
		verbose: false,
	};
}

describe("catchup through the connection — dedupe prevents double-delivery", () => {
	it("a message already delivered live is NOT delivered again by catch-up", async () => {
		// The same message guid is delivered live AND comes back in the catch-up
		// query. The connection's dedupe cache must drop the replay.
		const liveMessage = {
			guid: "DUP-1",
			text: "hello",
			chatGuid: "iMessage;-;+15551234567",
			handle: { address: "+15551234567" },
			dateCreated: 1_000_000,
		};

		// Contact lookup + catch-up query share one fetch: route by URL.
		const f = (async (url: string, init: RequestInit) => {
			if (typeof url === "string" && url.includes("/message/query")) {
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({ status: 200, data: [liveMessage] }),
					headers: new Map<string, string>() as unknown as Headers,
				} as unknown as Response;
			}
			// contact directory (empty) or anything else
			void init;
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ status: 200, data: [] }),
				headers: new Map<string, string>() as unknown as Headers,
			} as unknown as Response;
		}) as unknown as typeof fetch;

		const delivered: string[] = [];
		// In-memory cursor store so the test never touches ~/.brigade.
		const mem = new Map<string, import("./catchup-cursor.js").BlueBubblesCatchupCursor>();
		const conn = connectBlueBubbles({
			account: account(f),
			log: () => {},
			privateApi: true,
			fetchImpl: f,
			catchupCursorStore: {
				load: (id) => mem.get(id) ?? null,
				save: (id, c) => void mem.set(id, c),
			},
			onMessage: (m) => delivered.push(m.messageGuid),
		});

		// Live delivery first.
		conn.feedWebhookEvent("new-message", { type: "new-message", data: liveMessage });
		// Let the async enrich+dispatch settle.
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(delivered.length, 1);

		// Now run catch-up — the same guid comes back and must be deduped away.
		const summary = await conn.runCatchup();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(summary.querySucceeded, true);
		assert.equal(summary.fetched, 1);
		// Still exactly one delivery — the replay was dropped at dedupe.
		assert.equal(delivered.length, 1);
		assert.deepEqual(delivered, ["DUP-1"]);
	});
});
