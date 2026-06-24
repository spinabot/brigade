import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import {
	listSlackDirectoryGroups,
	listSlackDirectoryPeers,
	type SlackDirectoryWebClientLike,
} from "./directory-live.js";

/** A config with a bot token and (optionally) a user token. */
function cfg(over: { botToken?: string; userToken?: string } = {}): BrigadeConfig {
	return {
		channels: {
			slack: {
				enabled: true,
				botToken: over.botToken ?? "xoxb-BOT",
				...(over.userToken ? { userToken: over.userToken } : {}),
			},
		},
	} as unknown as BrigadeConfig;
}

/** A fake WebClient slice that records the token it was built with + serves canned pages. */
function makeFakeWeb(opts: {
	members?: Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean; profile?: { display_name?: string; real_name?: string } }>;
	channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
	usersPages?: Array<{ members: unknown[]; next?: string }>;
}): SlackDirectoryWebClientLike {
	const usersPages = opts.usersPages;
	let usersCallIdx = 0;
	return {
		users: {
			async list() {
				if (usersPages) {
					const page = usersPages[usersCallIdx] ?? { members: [], next: undefined };
					usersCallIdx += 1;
					return {
						ok: true,
						members: page.members as never,
						response_metadata: page.next ? { next_cursor: page.next } : {},
					};
				}
				return { ok: true, members: (opts.members ?? []) as never };
			},
		},
		conversations: {
			async list() {
				return { ok: true, channels: opts.channels ?? [] };
			},
		},
	};
}

describe("listSlackDirectoryPeers", () => {
	it("lists users with id/name/handle (display name preferred, deleted skipped)", async () => {
		const web = makeFakeWeb({
			members: [
				{ id: "U1", name: "alex", profile: { display_name: "Alex Q" } },
				{ id: "U2", name: "sam", real_name: "Sam Smith" }, // no display_name → real_name
				{ id: "U3", name: "ghost", deleted: true }, // skipped
			],
		});
		const rows = await listSlackDirectoryPeers({ cfg: cfg(), env: {}, webFactory: () => web });
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], { id: "U1", name: "Alex Q", handle: "@alex" });
		assert.deepEqual(rows[1], { id: "U2", name: "Sam Smith", handle: "@sam" });
	});

	it("filters by a case-insensitive query over name/handle", async () => {
		const web = makeFakeWeb({
			members: [
				{ id: "U1", name: "alex", profile: { display_name: "Alex Q" } },
				{ id: "U2", name: "sam", profile: { display_name: "Sam Smith" } },
			],
		});
		const rows = await listSlackDirectoryPeers({ cfg: cfg(), env: {}, query: "SAM", webFactory: () => web });
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.id, "U2");
	});

	it("paginates via next_cursor until exhausted", async () => {
		const web = makeFakeWeb({
			usersPages: [
				{ members: [{ id: "U1", name: "a", profile: { display_name: "A" } }], next: "cur2" },
				{ members: [{ id: "U2", name: "b", profile: { display_name: "B" } }], next: undefined },
			],
		});
		const rows = await listSlackDirectoryPeers({ cfg: cfg(), env: {}, webFactory: () => web });
		assert.deepEqual(rows.map((r) => r.id), ["U1", "U2"]);
	});

	it("respects the limit", async () => {
		const web = makeFakeWeb({
			members: [
				{ id: "U1", name: "a", profile: { display_name: "A" } },
				{ id: "U2", name: "b", profile: { display_name: "B" } },
				{ id: "U3", name: "c", profile: { display_name: "C" } },
			],
		});
		const rows = await listSlackDirectoryPeers({ cfg: cfg(), env: {}, limit: 2, webFactory: () => web });
		assert.equal(rows.length, 2);
	});

	it("prefers the USER token over the bot token when set", async () => {
		let builtWith = "";
		const web = makeFakeWeb({ members: [] });
		await listSlackDirectoryPeers({
			cfg: cfg({ userToken: "xoxp-USER", botToken: "xoxb-BOT" }),
			env: {},
			webFactory: (token) => {
				builtWith = token;
				return web;
			},
		});
		assert.equal(builtWith, "xoxp-USER");
	});

	it("falls back to the bot token when no user token is set", async () => {
		let builtWith = "";
		const web = makeFakeWeb({ members: [] });
		await listSlackDirectoryPeers({
			cfg: cfg({ botToken: "xoxb-ONLYBOT" }),
			env: {},
			webFactory: (token) => {
				builtWith = token;
				return web;
			},
		});
		assert.equal(builtWith, "xoxb-ONLYBOT");
	});

	it("returns [] when no token resolves (never builds a client)", async () => {
		let built = false;
		const rows = await listSlackDirectoryPeers({
			cfg: { channels: { slack: { enabled: true } } } as unknown as BrigadeConfig,
			env: {},
			webFactory: () => {
				built = true;
				return makeFakeWeb({});
			},
		});
		assert.deepEqual(rows, []);
		assert.equal(built, false);
	});
});

describe("listSlackDirectoryGroups", () => {
	it("lists public + private channels with #handle (archived skipped)", async () => {
		const web = makeFakeWeb({
			channels: [
				{ id: "C1", name: "general" },
				{ id: "C2", name: "random", is_archived: true }, // skipped
				{ id: "G1", name: "private-ops" },
			],
		});
		const rows = await listSlackDirectoryGroups({ cfg: cfg(), env: {}, webFactory: () => web });
		assert.equal(rows.length, 2);
		assert.deepEqual(rows[0], { id: "C1", name: "general", handle: "#general" });
		assert.deepEqual(rows[1], { id: "G1", name: "private-ops", handle: "#private-ops" });
	});

	it("filters channels by query", async () => {
		const web = makeFakeWeb({
			channels: [
				{ id: "C1", name: "general" },
				{ id: "C2", name: "engineering" },
			],
		});
		const rows = await listSlackDirectoryGroups({ cfg: cfg(), env: {}, query: "eng", webFactory: () => web });
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.id, "C2");
	});

	it("prefers the user token over the bot token", async () => {
		let builtWith = "";
		const web = makeFakeWeb({ channels: [] });
		await listSlackDirectoryGroups({
			cfg: cfg({ userToken: "xoxp-USER", botToken: "xoxb-BOT" }),
			env: {},
			webFactory: (token) => {
				builtWith = token;
				return web;
			},
		});
		assert.equal(builtWith, "xoxp-USER");
	});
});
