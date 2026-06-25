import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	bluebubblesChannelEnabled,
	listBlueBubblesAccountIds,
	resolveBlueBubblesAccount,
	resolveBlueBubblesPassword,
	resolveBlueBubblesServerUrl,
	resolveBlueBubblesWebhookPath,
	resolveBlueBubblesActions,
	normalizeBlueBubblesServerUrl,
} from "./account-config.js";
import type { BrigadeConfig } from "../../../config/io.js";

function cfg(channels: unknown): BrigadeConfig {
	return { channels } as unknown as BrigadeConfig;
}

// Assemble env-injected password from parts (no token-shaped literal).
const ENV_PW = ["env", "bb", "pw"].join("-");

describe("account-config — enable + accounts", () => {
	it("is disabled when not enabled", () => {
		assert.equal(bluebubblesChannelEnabled(cfg({ bluebubbles: { enabled: false } })), false);
		assert.deepEqual(listBlueBubblesAccountIds(cfg({ bluebubbles: { enabled: false } })), []);
	});
	it("lists [default] for a legacy single-account config", () => {
		assert.deepEqual(listBlueBubblesAccountIds(cfg({ bluebubbles: { enabled: true } })), ["default"]);
	});
	it("lists named accounts when present", () => {
		const ids = listBlueBubblesAccountIds(
			cfg({ bluebubbles: { enabled: true, accounts: [{ id: "home" }, { id: "work" }] } }),
		);
		assert.deepEqual(ids, ["home", "work"]);
	});
});

describe("account-config — serverUrl + password resolution", () => {
	it("normalises the server URL (scheme default + trailing slash strip)", () => {
		assert.equal(normalizeBlueBubblesServerUrl("192.168.1.5:1234/"), "http://192.168.1.5:1234");
		assert.equal(normalizeBlueBubblesServerUrl("https://bb.example.com/"), "https://bb.example.com");
	});

	it("resolves a ${VAR} server URL ref against env", () => {
		const env = { BB_URL: "http://10.0.0.2:1234" } as unknown as NodeJS.ProcessEnv;
		const url = resolveBlueBubblesServerUrl(cfg({ bluebubbles: { enabled: true, serverUrl: "${BB_URL}" } }), "default", env);
		assert.equal(url, "http://10.0.0.2:1234");
	});

	it("resolves a literal password from config", () => {
		const pw = resolveBlueBubblesPassword(cfg({ bluebubbles: { enabled: true, password: ENV_PW } }), "default", {} as NodeJS.ProcessEnv);
		assert.equal(pw, ENV_PW);
	});

	it("falls back to the BLUEBUBBLES_PASSWORD env var", () => {
		const env = { BLUEBUBBLES_PASSWORD: ENV_PW } as unknown as NodeJS.ProcessEnv;
		const pw = resolveBlueBubblesPassword(cfg({ bluebubbles: { enabled: true } }), "default", env);
		assert.equal(pw, ENV_PW);
	});

	it("prefers a per-account password over the top-level one", () => {
		const env = {} as NodeJS.ProcessEnv;
		const c = cfg({
			bluebubbles: { enabled: true, password: "top", accounts: [{ id: "home", password: "home-pw" }] },
		});
		assert.equal(resolveBlueBubblesPassword(c, "home", env), "home-pw");
		assert.equal(resolveBlueBubblesPassword(c, "default", env), "top");
	});
});

describe("account-config — webhook path", () => {
	it("uses the base path for the default account", () => {
		assert.equal(resolveBlueBubblesWebhookPath(cfg({ bluebubbles: { enabled: true } }), "default"), "/bluebubbles/webhook");
	});
	it("honours a custom base webhookPath", () => {
		assert.equal(
			resolveBlueBubblesWebhookPath(cfg({ bluebubbles: { enabled: true, webhookPath: "/bb/in" } }), "default"),
			"/bb/in",
		);
	});
	it("derives a distinct slug path for a named account", () => {
		const c = cfg({ bluebubbles: { enabled: true, accounts: [{ id: "home" }, { id: "work" }] } });
		assert.equal(resolveBlueBubblesWebhookPath(c, "home"), "/bluebubbles/webhook/home");
		assert.equal(resolveBlueBubblesWebhookPath(c, "work"), "/bluebubbles/webhook/work");
	});
});

describe("account-config — actions + resolved account", () => {
	it("defaults all action flags ON", () => {
		const actions = resolveBlueBubblesActions(cfg({ bluebubbles: { enabled: true } }), "default");
		assert.deepEqual(actions, { reactions: true, edit: true, unsend: true, effects: true, groupAdmin: true });
	});
	it("honours a per-channel action toggle", () => {
		const actions = resolveBlueBubblesActions(cfg({ bluebubbles: { enabled: true, actions: { reactions: false } } }), "default");
		assert.equal(actions.reactions, false);
		assert.equal(actions.edit, true);
	});
	it("resolves a full account view", () => {
		const env = { BLUEBUBBLES_PASSWORD: ENV_PW } as unknown as NodeJS.ProcessEnv;
		const account = resolveBlueBubblesAccount(
			cfg({ bluebubbles: { enabled: true, serverUrl: "http://10.0.0.9:1234" } }),
			"default",
			env,
		);
		assert.equal(account.enabled, true);
		assert.equal(account.serverUrl, "http://10.0.0.9:1234");
		assert.equal(account.password, ENV_PW);
		assert.equal(account.webhookPath, "/bluebubbles/webhook");
		assert.ok(account.mediaMaxBytes > 0);
	});
});
