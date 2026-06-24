import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { BrigadeConfig } from "../../../config/io.js";
import {
	listSlackAccountIds,
	resolveSlackAccount,
	resolveSlackAppToken,
	resolveSlackBotToken,
	resolveSlackSigningSecret,
	slackChannelEnabled,
	slackEventsConfig,
	slackThreadIdleTtlMs,
} from "./account-config.js";

const cfg = (slack: Record<string, unknown>): BrigadeConfig => ({ channels: { slack } }) as unknown as BrigadeConfig;
const noEnv: NodeJS.ProcessEnv = {};

describe("slack account-config — enable + account ids", () => {
	it("disabled / missing → no accounts", () => {
		assert.equal(slackChannelEnabled(cfg({})), false);
		assert.deepEqual(listSlackAccountIds(cfg({})), []);
		assert.deepEqual(listSlackAccountIds(cfg({ enabled: false })), []);
	});

	it("legacy single-account → ['default']", () => {
		assert.equal(slackChannelEnabled(cfg({ enabled: true })), true);
		assert.deepEqual(listSlackAccountIds(cfg({ enabled: true, botToken: "xoxb-A" })), ["default"]);
	});

	it("multi-workspace → the configured ids (deduped)", () => {
		assert.deepEqual(
			listSlackAccountIds(cfg({ enabled: true, accounts: [{ id: "acme" }, { id: "labs" }, { id: "acme" }] })),
			["acme", "labs"],
		);
	});

	it("an empty accounts[] degrades to ['default']", () => {
		assert.deepEqual(listSlackAccountIds(cfg({ enabled: true, accounts: [] })), ["default"]);
	});
});

describe("slack account-config — token resolution", () => {
	it("resolves top-level literal tokens", () => {
		const c = cfg({ enabled: true, botToken: "xoxb-A", appToken: "xapp-A", signingSecret: "sig-A" });
		assert.equal(resolveSlackBotToken(c, "default", noEnv), "xoxb-A");
		assert.equal(resolveSlackAppToken(c, "default", noEnv), "xapp-A");
		assert.equal(resolveSlackSigningSecret(c, "default", noEnv), "sig-A");
	});

	it("per-account token overrides the top-level token", () => {
		const c = cfg({ enabled: true, botToken: "xoxb-top", accounts: [{ id: "acme", botToken: "xoxb-acme" }] });
		assert.equal(resolveSlackBotToken(c, "acme", noEnv), "xoxb-acme");
	});

	it("${VAR} refs resolve against env", () => {
		const c = cfg({ enabled: true, botToken: "${SLACK_BOT_TOKEN}", appToken: "${MY_APP}" });
		const env = { SLACK_BOT_TOKEN: "xoxb-env", MY_APP: "xapp-env" } as NodeJS.ProcessEnv;
		assert.equal(resolveSlackBotToken(c, "default", env), "xoxb-env");
		assert.equal(resolveSlackAppToken(c, "default", env), "xapp-env");
	});

	it("env var is the last-resort fallback (Slack is greenfield → no sealed token)", () => {
		const c = cfg({ enabled: true });
		const env = {
			SLACK_BOT_TOKEN: "xoxb-fallback",
			SLACK_APP_TOKEN: "xapp-fallback",
			SLACK_SIGNING_SECRET: "sig-fb",
		} as NodeJS.ProcessEnv;
		assert.equal(resolveSlackBotToken(c, "default", env), "xoxb-fallback");
		assert.equal(resolveSlackAppToken(c, "default", env), "xapp-fallback");
		assert.equal(resolveSlackSigningSecret(c, "default", env), "sig-fb");
	});

	it("resolveSlackAccount bundles the secrets + enabled flag", () => {
		const c = cfg({ enabled: true, botToken: "xoxb-A", appToken: "xapp-A" });
		const acct = resolveSlackAccount(c, "default", noEnv);
		assert.equal(acct.accountId, "default");
		assert.equal(acct.enabled, true);
		assert.equal(acct.botToken, "xoxb-A");
		assert.equal(acct.appToken, "xapp-A");
		assert.equal(acct.signingSecret, "");
	});

	it("a per-account enabled:false disables that account", () => {
		const c = cfg({ enabled: true, accounts: [{ id: "acme", enabled: false, botToken: "xoxb-A" }] });
		assert.equal(resolveSlackAccount(c, "acme", noEnv).enabled, false);
	});
});

describe("slack account-config — transport mode", () => {
	it("defaults to socket mode with the /slack/events path", () => {
		const m = slackEventsConfig(cfg({ enabled: true }));
		assert.equal(m.mode, "socket");
		assert.equal(m.path, "/slack/events");
	});

	it("events mode + custom path (leading slash normalized)", () => {
		const m = slackEventsConfig(cfg({ enabled: true, mode: "events", events: { url: "https://b.example.com", path: "hook" } }));
		assert.equal(m.mode, "events");
		assert.equal(m.url, "https://b.example.com");
		assert.equal(m.path, "/hook");
	});

	it("'http' is treated as events mode", () => {
		assert.equal(slackEventsConfig(cfg({ enabled: true, mode: "http" })).mode, "events");
	});
});

describe("slack account-config — thread idle ttl", () => {
	it("parses duration strings + raw numbers, else null", () => {
		assert.equal(slackThreadIdleTtlMs(cfg({ enabled: true, threadIdleTtlMs: "6h" })), 6 * 3_600_000);
		assert.equal(slackThreadIdleTtlMs(cfg({ enabled: true, threadIdleTtlMs: 5000 })), 5000);
		assert.equal(slackThreadIdleTtlMs(cfg({ enabled: true })), null);
	});
});
